// app/api/callback-request/route.ts
//
// THE INBOUND CALLBACK ENDPOINT — a hot buyer raises their own hand.
//
// GET  → the config the client affordance needs (is the rail on, is there a
//        line to show, does this buyer already have a request open).
// POST → record the ask, ping the operator.
//
// ── AUTH ───────────────────────────────────────────────────────────────────
// Exactly the deposit flow's model, reused rather than reinvented:
//
//   • with a `refId`  → lib/buyerAuth.resolveDepositAuth(req, refId), which
//     accepts the full member session OR the referral-scoped
//     `bhc-deposit-grant` cookie pinned to THAT referral (campaign 1-tap
//     buyers have only the grant, and they are the hottest traffic on the
//     deposit page — locking them out would gut the rail).
//   • without a refId → lib/buyerAuth.resolveBuyerSession (member session
//     only). The scoped grant is deliberately NOT consulted here: an
//     unscoped write authorized by a forwardable link is exactly the
//     confused-deputy the grant's containment boundary exists to prevent.
//
// A `consumerId` in the body is NEVER trusted on its own — it is only accepted
// when it equals the id the credential already resolved to, and mismatches 403.
// The write surface added here is the two callback fields plus, at most, a
// FIRST-TIME phone. Nothing else on the Consumer row is writable through it.

import { NextResponse } from 'next/server';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { resolveBuyerSession, resolveDepositAuth, type BuyerSession } from '@/lib/buyerAuth';
import { checkOriginGuard } from '@/lib/csrfGuard';
import { rateLimit, getRequestIp } from '@/lib/rateLimit';
import { normalizeToE164 } from '@/lib/phoneE164';
import { hasOpenCallbackRequest } from '@/lib/callbackQueue';
import { isCallbackRailEnabled, resolveCallbackPhone } from '@/lib/callbackRail';
import { sendTelegramCallbackRequest } from '@/lib/telegram';
import { sendCallbackRequestAck } from '@/lib/email';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// Airtable field names. Verified against the live Consumers schema
// (tblAbjQDnLrOtjpoE) 2026-07-30 — see docs/WRITE-MAP.md.
const F_REQUESTED_AT = 'Callback Requested At';
const F_NOTE = 'Callback Note';
const F_HANDLED_AT = 'Callback Handled At';

/** A buyer's note is a sentence, not an essay. Long enough for a real question. */
const NOTE_MAX = 500;

/** The rail is dark by default; answer as though the route does not exist. */
const disabled = () => NextResponse.json({ error: 'not_found' }, { status: 404 });

const unauthorized = () => NextResponse.json({ error: 'unauthorized' }, { status: 401 });

/**
 * Resolve the caller and, when a referral is named, that referral's context.
 * Returns null when no credential authorizes the write.
 */
async function resolveCaller(
  req: Request,
  refId: string,
): Promise<BuyerSession | null> {
  return refId ? resolveDepositAuth(req, refId) : resolveBuyerSession(req);
}

// ───────────────────────────────────────────────────────────────────────────
// GET — what should the affordance render?
//
// Authed with the same credential as POST, so an anonymous visitor cannot even
// learn whether the rail is live. Returns 404 when the flag is off (identical
// to POST, so the client has one "render nothing" branch) and 401 when the
// caller has no credential. `phone` is null whenever CALLBACK_PHONE is unset —
// there is no placeholder and no fallback number.
// ───────────────────────────────────────────────────────────────────────────
export async function GET(req: Request) {
  if (!isCallbackRailEnabled()) return disabled();

  const refId = String(new URL(req.url).searchParams.get('refId') || '').trim();
  const session = await resolveCaller(req, refId);
  if (!session?.consumerId) return unauthorized();

  const phone = resolveCallbackPhone();

  // Best-effort personalization. A read failure must not hide the affordance:
  // the worst case is that a buyer with an open request is offered the form
  // again, and POST's own guard catches that without stacking a duplicate.
  let alreadyOpen = false;
  let hasPhoneOnFile = false;
  try {
    const consumer: any = await getRecordById(TABLES.CONSUMERS, session.consumerId);
    if (consumer) {
      alreadyOpen = hasOpenCallbackRequest({
        callbackRequestedAt: consumer[F_REQUESTED_AT],
        callbackHandledAt: consumer[F_HANDLED_AT],
      });
      hasPhoneOnFile = String(consumer['Phone'] || '').trim().length > 0;
    }
  } catch {
    /* non-fatal — fall through with defaults */
  }

  return NextResponse.json({
    enabled: true,
    // null ⇒ render NO call/text links. Never a placeholder.
    phone: phone ? { display: phone.display, tel: phone.telHref, sms: phone.smsHref } : null,
    alreadyOpen,
    hasPhoneOnFile,
  });
}

// ───────────────────────────────────────────────────────────────────────────
// POST — record the ask.
// ───────────────────────────────────────────────────────────────────────────
export async function POST(req: Request) {
  if (!isCallbackRailEnabled()) return disabled();

  const originCheck = checkOriginGuard(req);
  if (!originCheck.ok && originCheck.response) return originCheck.response;

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const refId = String(body?.refId || '').trim();
  const session = await resolveCaller(req, refId);
  if (!session?.consumerId) return unauthorized();

  // A client-supplied consumerId is accepted only as an assertion to CHECK,
  // never as the identity itself.
  const claimed = String(body?.consumerId || '').trim();
  if (claimed && claimed !== session.consumerId) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const consumerId = session.consumerId;

  // Coarse abuse ceiling on top of the per-consumer open-request guard below.
  // Fails OPEN when Upstash isn't configured (lib/rateLimit) — the duplicate
  // guard is the real protection; this only stops a script.
  const ip = getRequestIp(req);
  const limited = await rateLimit(`callback-request:${ip || consumerId}`, {
    requests: 10,
    window: '15m',
  });
  if (!limited.ok) {
    return NextResponse.json(
      { error: 'rate_limited', message: "we've got your request — hang tight." },
      { status: 429 },
    );
  }

  const consumer: any = await getRecordById(TABLES.CONSUMERS, consumerId).catch(() => null);
  if (!consumer) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const existingRequestedAt = consumer[F_REQUESTED_AT];
  const existingHandledAt = consumer[F_HANDLED_AT];

  // ONE OPEN REQUEST AT A TIME. A buyer tapping twice (or a double-fire from a
  // flaky mobile connection) must not overwrite the original request time —
  // that would reset their place in a queue sorted oldest-first and quietly
  // punish the person who has waited longest. Friendly 200, not an error: from
  // the buyer's side nothing went wrong, and the true answer is reassuring.
  if (hasOpenCallbackRequest({
    callbackRequestedAt: existingRequestedAt,
    callbackHandledAt: existingHandledAt,
  })) {
    return NextResponse.json({
      ok: true,
      alreadyOpen: true,
      message: "we've got you — ben will call.",
    });
  }

  const note = String(body?.note || '').trim().slice(0, NOTE_MAX);

  const fields: Record<string, unknown> = {
    [F_REQUESTED_AT]: new Date().toISOString(),
    // Always written, even when blank, so a NEW request never inherits the
    // note from a previous, already-handled one.
    [F_NOTE]: note,
  };

  // FIRST-TIME phone only. A buyer who reaches the rail through a campaign
  // 1-tap link may have no phone on file, and a callback request without a
  // number to call is a dead letter — so we accept one here. We never
  // overwrite an existing number: the stored one has been through the signup
  // door's own validation, and silently replacing it from a free-text field is
  // how a reachable buyer becomes unreachable (the Vale Creek failure mode,
  // see lib/phoneFormat.ts).
  const hadPhone = String(consumer['Phone'] || '').trim().length > 0;
  let phoneAdded = false;
  if (!hadPhone && body?.phone) {
    const e164 = normalizeToE164(String(body.phone));
    if (e164) {
      fields['Phone'] = e164;
      phoneAdded = true;
    }
  }

  try {
    await updateRecord(TABLES.CONSUMERS, consumerId, fields);
  } catch (e: any) {
    console.error('[callback-request] failed to stamp request:', e?.message || e);
    return NextResponse.json(
      { error: 'write_failed', message: "that didn't save — try once more?" },
      { status: 500 },
    );
  }

  // ── deal context for the alert ───────────────────────────────────────────
  // Display only, and strictly best-effort: it must never be able to fail the
  // request the buyer just made. Ownership is re-checked even though the grant
  // path already pins refId↔consumer, because a MEMBER session can name any
  // refId — an unchecked read would leak another buyer's deal into the alert.
  let dealLine = '';
  let rancherName = '';
  if (refId) {
    try {
      const referral: any = await getRecordById(TABLES.REFERRALS, refId);
      const buyerLinks = Array.isArray(referral?.['Buyer']) ? referral['Buyer'] : [];
      const emailMatch =
        !!session.email &&
        String(referral?.['Buyer Email'] || '').trim().toLowerCase() ===
          session.email.trim().toLowerCase();
      if (referral && (buyerLinks.includes(consumerId) || emailMatch)) {
        const cut = String(referral['Order Type'] || '').trim();
        const amount = Number(referral['Total Sale Amount'] || referral['Sale Amount'] || 0);
        dealLine = [cut, amount > 0 ? `$${amount.toLocaleString()}` : '']
          .filter(Boolean)
          .join(' · ');
        rancherName =
          String(referral['Rancher Name'] || referral['Suggested Rancher Name'] || '').trim();
      }
    } catch {
      /* context is a nicety; the ask is the point */
    }
  }

  const fullName = String(consumer['Full Name'] || '').trim();
  const phoneForAlert = phoneAdded
    ? String(fields['Phone'])
    : String(consumer['Phone'] || '').trim();

  try {
    await sendTelegramCallbackRequest({
      consumerId,
      firstName: fullName.split(/\s+/)[0] || 'A buyer',
      state: String(consumer['State'] || '').trim(),
      phone: phoneForAlert,
      email: String(consumer['Email'] || session.email || '').trim(),
      dealLine,
      rancherName,
      note,
      // Any prior handled request makes this a repeat ask — worth knowing
      // before you dial.
      repeatAsk: String(existingHandledAt || '').trim().length > 0,
    });
  } catch (e: any) {
    // The record is already stamped, so the desk will surface this buyer at the
    // top of the queue regardless. A dead Telegram must not 500 the buyer.
    console.error('[callback-request] telegram ping failed:', e?.message || e);
  }

  // ── Buyer ack (Wave 2, GTM plan 2.1) — the buyer's own receipt. Until now
  // this route pinged the operator and left the buyer with nothing in their
  // inbox. Best-effort: an ack failure must never fail the request. One ack
  // per request cycle by construction — the open-request guard above returns
  // early on a second POST while a request is open.
  const ackEmail = String(consumer['Email'] || session.email || '').trim();
  if (ackEmail) {
    try {
      await sendCallbackRequestAck({
        email: ackEmail,
        firstName: fullName.split(/\s+/)[0] || '',
        phone: phoneForAlert || undefined,
      });
    } catch (e: any) {
      console.error('[callback-request] buyer ack failed (non-fatal):', e?.message || e);
    }
  }

  return NextResponse.json({
    ok: true,
    alreadyOpen: false,
    message: "got it — ben will call you.",
  });
}
