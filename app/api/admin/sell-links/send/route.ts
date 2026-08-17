// app/api/admin/sell-links/send — DELIVER a minted operator link.
//
// The sell console's "send it" button. Ben closes a buyer off-platform (phone,
// text, DM, farmers market), taps a cut or a product, and the platform puts
// the link in front of that buyer instead of handing delivery back to him.
//
// WHY A SEPARATE ROUTE, not a `deliver:true` option on the mint route
// (../route.ts) — three reasons, in order of weight:
//
//   1. THREE RAILS, TWO MINTERS. The share rails mint at
//      POST /api/admin/sell-links; the PRODUCT rail mints at
//      POST /api/checkout/product. A deliver flag on the share minter could
//      only ever serve two of the three, and folding a Stripe product mint
//      into it would drag stock holds and checkout sessions into a link
//      endpoint. One send endpoint downstream of both serves all three.
//   2. FAILURE DOMAINS MUST NOT MERGE. Minting is cheap, local and mostly
//      idempotent. Sending is an external side effect with its own retry
//      policy, its own idempotency window, and its own per-channel failure
//      taxonomy. Fused, a delivery failure would either have to fail the mint
//      response — destroying the link Ben needs to read out on the call — or
//      hide inside it. Split, the mint always returns the link and the send
//      always returns the truth about the send.
//   3. RE-SEND IS A REAL OPERATION. "It went to the wrong address / they never
//      got it" must not re-run a Consumer upsert, re-run the broker money
//      gate, or take a second stock hold. Sending the SAME minted link again
//      is one call to this route.
//
// GET  → capability probe: `{ smsEnabled }`. The console reads this on mount so
//        the SMS control is disabled and annotated BEFORE Ben taps it —
//        ENABLE_SMS defaults OFF platform-wide (lib/smsFlag), so on today's
//        deploy that control is honestly dark rather than a silent no-op.
// POST → deliver, and report the TRUE per-channel outcome.
//
// SECURITY. Admin-gated exactly like its siblings — this endpoint can put mail
// in front of an arbitrary address, so `requireAdmin` is load-bearing, not
// ceremonial. The second half of that gate is lib/operatorSend.resolveSendTarget:
// the URL is not free-form. It must be on this site's host AND be one of
// /r/d/<token> · /r/b/<token> (token must cryptographically verify) or
// /shop/<recordId>. A raw Stripe checkout URL cannot pass — repo hard rule #3,
// they expire in ~24h — which is why the product rail mails the durable
// product page and not the session URL the console shows Ben for copy-paste.
//
// RECIPIENT BINDING is the third half of that gate, and the sharpest one. A
// share-rail token is a CREDENTIAL, not a brochure: /r/d and /r/b exchange it
// for a referral-scoped grant over that buyer's deal. So the address being
// mailed must equal the `Email` on the Consumers row the token names, or the
// request is refused (409) — a verified link and a mismatched address is an
// account-access handoff, not a typo. There is deliberately no confirm-and-
// proceed flag; the safe operation is a re-mint, which is one tap.
//
// Plus a coarse per-IP ceiling (100/hour, fail-closed): this template bypasses
// the per-recipient frequency cap and the idempotency claim is per-recipient,
// so without it a leaked admin password is an uncapped mail cannon on the
// verified sending domain.

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';
import { getRecordById, getAllRecords, updateRecord, escapeAirtableValue, TABLES } from '@/lib/airtable';
import { claimOnce, releaseClaim, claimExists } from '@/lib/rancherCapacity';
import { rateLimitStrict, getTrustedClientIp } from '@/lib/rateLimit';
// The Consumers contact stamp, imported rather than re-declared — one literal,
// one place. dateTime 'Last Contacted', NOT the 'Last Contacted At' date field
// beside it (see the landmine note in lib/dialOutcome.ts).
import { F_LAST_CONTACTED } from '@/lib/dialOutcome';
import { sendOperatorSellLink } from '@/lib/email';
import { sendSMSToConsumer } from '@/lib/twilio';
import { smsEnabled } from '@/lib/smsFlag';
import { pickCanonicalConsumer } from '@/lib/requalifyCampaign';
import { isSellableRow, hasStock } from '@/lib/marketplaceProducts';
import {
  resolveSendTarget,
  buildSendCopy,
  deliverOperatorSend,
  checkRecipientBinding,
  isSingleEmailAddress,
  type SendRail,
} from '@/lib/operatorSend';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

export async function GET(request: Request) {
  const unauthorized = await requireAdmin(request);
  if (unauthorized) return unauthorized;
  return NextResponse.json({ smsEnabled: smsEnabled() });
}

export async function POST(request: Request) {
  const unauthorized = await requireAdmin(request);
  if (unauthorized) return unauthorized;

  // COARSE SEND CEILING. 'operator_sell_link' is on the transactional
  // whitelist (the 3/week per-recipient cap does not apply) and the
  // idempotency claim is keyed per RECIPIENT, so varying the address defeats
  // it — without a ceiling here, a leaked ADMIN_PASSWORD is an uncapped mail
  // cannon firing from the verified sending domain. Ben's real ceiling is his
  // own hands (a few dozen calls a day), so 100/hour is invisible to him and
  // ends an abuse run fast. rateLimitStrict, NOT rateLimit: the base helper
  // fails OPEN on a Redis outage, which would reinstate the exact hole.
  const ip = getTrustedClientIp(request);
  const rl = await rateLimitStrict(`operator-send:${ip}`, { requests: 100 });
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'too many sends in the last hour — this ceiling exists to stop a runaway; try again shortly' },
      { status: 429 },
    );
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // ── The link decides almost everything ──────────────────────────────────
  const resolved = resolveSendTarget(String(body?.url || ''), SITE_URL);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: 400 });
  }
  const target = resolved.target;

  const buyerEmail = String(body?.buyerEmail || '').trim().toLowerCase();
  const buyerName = String(body?.buyerName || '').trim();
  const wantEmail = body?.email !== false; // default on — it is the reliable channel
  const wantSms = body?.sms === true;

  // Cheap refusals BEFORE any network read — a malformed request must never
  // cost an Airtable call, and the ordering keeps "bad request" cleanly
  // separable from "the product is dark" below.
  if (!wantEmail && !wantSms) {
    return NextResponse.json({ error: 'pick at least one channel' }, { status: 400 });
  }
  // ONE address. `includes('@')` let "ok@x.com, unsubscribed@y.com" through,
  // and lib/email.ts's suppression check is an exact-string lookup on the whole
  // `to` field — so a comma-joined pair mailed straight past the suppression
  // list. See lib/operatorSend.isSingleEmailAddress.
  if (wantEmail && !isSingleEmailAddress(buyerEmail)) {
    return NextResponse.json(
      { error: 'buyerEmail must be exactly one valid email address' },
      { status: 400 },
    );
  }

  // PRODUCT RAIL LIVENESS. /shop/<id> renders only for a row that passes
  // isSellableRow (active, nationwide, priced, in stock) and 404s otherwise —
  // so verify before mailing rather than sending a buyer to a dead page. The
  // share rails need no equivalent check: their gate already ran at mint and
  // re-runs at tap, and a token that verifies is by construction one this
  // platform issued.
  if (target.rail === 'product') {
    const product: any = await getRecordById(TABLES.RANCHER_PRODUCTS, target.productId).catch(() => null);
    if (!product) {
      return NextResponse.json({ error: 'that product no longer exists' }, { status: 409 });
    }
    // SOLD OUT is its own answer, not a 404. app/shop/[id] deliberately RENDERS
    // a sold-out page (photo, story, "sold out"), so the old copy was simply
    // wrong about what would happen. Still refused: Ben has just told someone
    // on the phone he is sending them a box, and a link they cannot buy wastes
    // the close — he needs to hear it now, while he can offer something else.
    if (!hasStock(product)) {
      return NextResponse.json(
        { error: 'that product is sold out — the page will show it as unavailable. offer another one.' },
        { status: 409 },
      );
    }
    if (!isSellableRow(product)) {
      return NextResponse.json(
        { error: 'that product is not live on the shop right now — the page would 404' },
        { status: 409 },
      );
    }
  }

  // ── Who is this ─────────────────────────────────────────────────────────
  // Share rails: the consumerId came out of the VERIFIED token — exact, and
  // immune to the duplicate-email rows documented in docs/WRITE-MAP.md. It is
  // kept even if the record read below fails: the token is authoritative about
  // WHO, and a transient Airtable blip must not silently drop the stamp.
  // Product rail: no token, so fall back to a canonical by-email lookup, which
  // deliberately yields nothing when several rows share the address (never
  // guess an identity onto a money touch). A null consumer costs the SMS
  // consent read and (on the product rail) the stamp; the email still sends.
  let consumer: Record<string, any> | null = null;
  let consumerId = target.consumerId;
  if (consumerId) {
    consumer = (await getRecordById(TABLES.CONSUMERS, consumerId).catch(() => null)) as any;
  } else if (buyerEmail) {
    const rows = await getAllRecords(
      TABLES.CONSUMERS,
      `LOWER({Email}) = "${escapeAirtableValue(buyerEmail)}"`,
    ).catch(() => [] as any[]);
    const picked = pickCanonicalConsumer(rows);
    consumer = picked.consumer;
    consumerId = picked.consumer?.id || '';
  }
  // ── RECIPIENT BINDING — the link belongs to ONE buyer ───────────────────
  // On the share rails the token IS a deposit grant: /r/d and /r/b hand
  // whoever opens it a referral-scoped session over that buyer's deal (message
  // history, cut preferences, the deposit itself). So the address we are about
  // to mail must be the address on the record the token names. Refused, not
  // confirmed-around — see checkRecipientBinding for why there is no override.
  // The product rail has no token and grants nothing, so nothing to bind.
  if (target.consumerId && wantEmail) {
    // Distinguish "cannot verify right now" from "verified, and it is someone
    // else" — they need different moves from the operator.
    if (!consumer) {
      return NextResponse.json(
        { error: 'could not check who that link belongs to just now — try the send again in a moment' },
        { status: 503 },
      );
    }
    const bound = checkRecipientBinding({
      recordEmail: consumer['Email'],
      buyerEmail,
    });
    if (!bound.ok) {
      return NextResponse.json({ error: bound.error }, { status: 409 });
    }
  }

  // Carry the resolved identity onto the target so the Email Sends row links
  // the right buyer and the stamp lands, on every rail.
  const sendTarget = { ...target, consumerId };

  // ── Copy ────────────────────────────────────────────────────────────────
  // The money numbers are DISPLAY-ONLY and pass through from the mint response
  // the console is already holding (which the server itself produced, gated).
  // Nothing here charges anything — the amounts are re-derived at tap time by
  // the /r/d, /r/b and /shop checkout paths, which are the only authorities on
  // what a buyer pays. Coerced to finite numbers so a malformed body can never
  // print "$NaN" at someone who just agreed to spend $2,000.
  const num = (v: any) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const firstName = buyerName || String(consumer?.['Full Name'] || '');
  const copy = buildSendCopy({
    rail: target.rail as SendRail,
    url: target.url,
    firstName,
    itemLabel: String(body?.itemLabel || '').trim() || 'your order',
    sellerName: String(body?.sellerName || '').trim(),
    amount: num(body?.amount),
    total: num(body?.total),
    totalMax: num(body?.totalMax),
    // DEPOSIT-STYLE products must never read as a full-price shipped purchase
    // (app/api/admin/products states the rule). Both consoles already branch
    // on these for their manual copy; now the server does too.
    depositStyle: body?.depositStyle === true,
    priceRange: String(body?.priceRange || '').trim(),
  });

  // ── Deliver ─────────────────────────────────────────────────────────────
  const result = await deliverOperatorSend(
    {
      target: sendTarget,
      copy,
      email: buyerEmail,
      wantEmail,
      wantSms,
      // Destination comes off the consented record only — no operator override
      // (lib/operatorSend.resolveSmsGate explains why that had to go).
      sms: { enabled: smsEnabled(), consumer },
    },
    {
      sendEmail: ({ to, copy: c, consumerId: cid }) =>
        sendOperatorSellLink({
          email: to,
          subject: c.subject,
          html: c.html,
          text: c.text,
          recipientConsumerId: cid || undefined,
        }),
      // The REAL consent gate. lib/operatorSend re-reads the same conditions
      // only to name the refusal; this is what actually decides, so a future
      // change there can never leak an SMS past TCPA.
      sendSms: ({ to, body: smsBody, consumer: c }) =>
        sendSMSToConsumer({ consumer: c, body: smsBody, phone: to, reason: 'operator-sell-link' }),
      claim: (key, ttl) => claimOnce(key, ttl),
      // Released on every non-delivery, so a failed send never leaves behind a
      // claim that the next tap reads as "already sent".
      release: (key) => releaseClaim(key),
      wasDelivered: (key) => claimExists(key),
      stamp: async ({ consumerId: cid, at }) => {
        await updateRecord(TABLES.CONSUMERS, cid, { [F_LAST_CONTACTED]: at });
      },
    },
  );

  // 200 even when both channels failed. The body carries the truth and the
  // link, and the console needs BOTH to keep selling — an HTTP error would
  // collapse "the buyer did not get it" and "the request was malformed" into
  // one red box on a live phone call.
  return NextResponse.json({
    ok: result.reached,
    loud: result.loud,
    rail: target.rail,
    url: target.url,
    stamped: result.stamped,
    channels: { email: result.email, sms: result.sms },
  });
}
