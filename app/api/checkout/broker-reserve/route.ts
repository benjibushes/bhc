// POST /api/checkout/broker-reserve — SELF-SERVE deposit start for a broker
// (represented) ranch that Ben opted in via the `Broker Self Serve` checkbox.
//
// The tokenless sibling of GET /r/b/<token>: same referral find-or-create
// (lib/brokerReferral), same referral-SCOPED deposit-grant cookie, same
// destination (/checkout/<refId>/broker). The only difference is WHO names the
// buyer: /r/b trusts a signed operator-minted token; here the buyer submits
// their own email on the ranch's public page, so every gate re-runs server-side
// and fails closed. See docs/BUSINESS-MODEL.md → "Money model 3" and
// lib/brokerRail.ts before touching anything money-shaped.
//
// SECURITY MODEL — mirrors app/api/checkout/reserve/route.ts:404-471 EXACTLY.
// A submitted email is UNVERIFIED, so it may never credential an existing
// buyer. checkOriginGuard passes on a scripted request (no Origin header), so
// without this rule a `curl -d '{"email":"victim@…"}'` would be handed a
// deposit grant scoped to the victim's consumerId + referral. The rule:
//   • freshly-CREATED consumer (nothing to leak)      → mint grant + redirect;
//   • already-authenticated member session            → mint grant + redirect;
//   • ADOPTED pre-existing consumer with NO session   → NO grant, NO writes to
//     that consumer; email a magic link (proves ownership via the member
//     session it mints) and return { requiresEmailVerification }.
// The deposit grant is thus issued only to someone who created the record or
// proved they own it — never to an anonymous caller by unverified email.
//
// findOrCreateBrokerReferral owns every money-path record write (repo rule:
// money truth is persisted by it) and its find-or-create semantics make a
// double-tap reuse the open referral instead of duplicating. The one write
// this handler makes to a referral is the CLEANUP void (→ Lost) when a
// verification email fails to send — mirroring app/api/checkout/reserve:447-460
// so a failed send never strands a phantom Pending hold.
//
// Body: { slug, cut: 'quarter'|'half'|'whole', email, name?, phone? }
// 200 → { redirect: '/checkout/<refId>/broker?cut=<cut>' } (client navigates;
//        the page mints the actual Stripe session at pay-click — NEVER a raw
//        Stripe URL, repo rule #3), OR
// 200 → { requiresEmailVerification: true, message } (adopted existing email,
//        no session — a magic link was emailed; no cookie set).

import { NextResponse } from 'next/server';
import {
  TABLES,
  createRecord,
  updateRecord,
  getAllRecords,
  getRancherOrProspectBySlug,
  escapeAirtableValue,
} from '@/lib/airtable';
import { findOrCreateBrokerReferral, type BrokerReferralResult } from '@/lib/brokerReferral';
import { assertBrokerSelfServeReservable } from '@/lib/brokerSelfServe';
import { CUT_LABELS, type Cut } from '@/lib/brokerRail';
import { normalizeReservePhone } from '@/lib/reserveDeposit';
import { attributionConsumerFields } from '@/lib/adAttribution';
import { mintDepositGrantToken, brokerDepositPathFor } from '@/lib/campaignReserve';
import { setDepositGrantCookie, resolveBuyerSession } from '@/lib/buyerAuth';
import { generateMemberLoginToken } from '@/lib/secrets';
import { sendMagicLink } from '@/lib/email';
import { checkOriginGuard } from '@/lib/csrfGuard';
import { rateLimit, getRequestIp } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

// Format check + disposable-domain block — mirrors app/api/checkout/reserve
// (:53) / /api/consumers:42-47 so a record-creating endpoint can't be farmed
// on throwaway addresses.
function isValidEmail(email: string): boolean {
  if (!/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email)) return false;
  const domain = email.split('@')[1]?.toLowerCase() || '';
  const throwaway = [
    'mailinator.com', 'guerrillamail.com', 'tempmail.com', 'throwaway.email',
    'yopmail.com', 'sharklasers.com', 'grr.la', 'guerrillamailblock.com',
    '10minutemail.com', 'trashmail.com',
  ];
  return !throwaway.includes(domain);
}

// ---------------------------------------------------------------------------
// Pure input validation — exported for the unit test (repo convention: route
// tests pin exported pure pieces, node:test has no module mocking here).
// ---------------------------------------------------------------------------

export interface BrokerReserveInput {
  slug: string;
  cut: Cut;
  email: string;
  name: string;
  /** E.164-normalized, or '' when the buyer supplied none (optional field). */
  phone: string;
}

export type BrokerReserveInputResult =
  | { ok: true; input: BrokerReserveInput }
  | { ok: false; status: number; error: string };

export function validateBrokerReserveInput(body: any): BrokerReserveInputResult {
  const slug = String(body?.slug || '').trim();
  const cut = String(body?.cut || '').trim().toLowerCase() as Cut;
  const email = String(body?.email || '').trim().toLowerCase();
  const name = String(body?.name || '').trim();
  const phoneRaw = String(body?.phone || '').trim();

  if (!slug) return { ok: false, status: 400, error: 'Rancher slug required' };
  if (!CUT_LABELS[cut]) {
    return { ok: false, status: 400, error: 'cut must be quarter|half|whole' };
  }
  if (!isValidEmail(email)) return { ok: false, status: 400, error: 'Valid email required' };

  // Phone is OPTIONAL on this rail (the ranch coordinates pickup by phone OR
  // email) — but a supplied-yet-garbled number is a typo the buyer should fix
  // now, not a value to silently drop (the ranch would lose its way to call).
  let phone = '';
  if (phoneRaw) {
    phone = normalizeReservePhone(phoneRaw);
    if (!phone) {
      return { ok: false, status: 400, error: 'That phone number doesn\'t look right — check it and try again.' };
    }
  }

  return { ok: true, input: { slug, cut, email, name, phone } };
}

// Broker-accurate magic-link email body. Rail-safe copy: a deposit toward the
// share, the balance paid to the ranch — never a word about what BHC keeps,
// never Connect fee-on-top framing. Not a raw Stripe URL (repo rule #3): the
// link points at our own /api/auth/member/verify, which proves ownership and
// lands the buyer on the broker checkout authed.
function brokerReserveMagicLinkHtml(args: { ranchName: string; magicLink: string }): string {
  const ranch = args.ranchName || 'the ranch';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:24px;">
<div style="max-width:520px;margin:0 auto;background:#fff;padding:32px;border:1px solid #A7A29A;">
<h1 style="font-family:Georgia,serif;font-size:22px;margin:0 0 12px;">Finish reserving your share</h1>
<p style="margin:0 0 16px;">You started reserving a beef share with ${esc(ranch)}. For your security, confirm it's you and pick up right where you left off.</p>
<p style="margin:0 0 24px;">Your deposit goes toward your share. You'll arrange pickup or delivery with the ranch and pay the balance directly to them.</p>
<p style="margin:0 0 24px;"><a href="${args.magicLink}" style="display:inline-block;background:#0E0E0E;color:#F4F1EC;text-decoration:none;padding:14px 28px;font-weight:600;">Finish reserving &rarr;</a></p>
<p style="margin:0;font-size:13px;color:#6B4F3F;">If you didn't request this, you can safely ignore this email — nothing was charged.</p>
</div></body></html>`;
}

// Minimal HTML-attribute escaper for the one interpolated field (ranch name).
function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Core flow — deps injected so the unit test can fake the auth + Airtable +
// brokerReferral + email layers (assert WHO gets the grant, single
// find-or-create, no duplicate consumer on a re-tap, redirect path shape).
// ---------------------------------------------------------------------------

export interface BrokerReserveDeps {
  /** The logged-in member session, if any (reads the bhc-member-auth cookie). */
  getExistingSession(): Promise<{ consumerId: string } | null>;
  fetchRancherBySlug(slug: string): Promise<any>;
  getConsumerByEmail(email: string): Promise<any | null>;
  createConsumer(fields: Record<string, any>): Promise<any>;
  findOrCreateBrokerReferral(args: {
    consumerId: string;
    rancherId: string;
    cut: Cut;
  }): Promise<BrokerReferralResult>;
  mintDepositGrantToken(claims: { consumerId: string; referralId: string }): string;
  /** Email the ownership-proving magic link; returns whether it actually sent. */
  sendVerificationLink(args: {
    consumerId: string;
    email: string;
    ranchName: string;
    depositPath: string;
  }): Promise<boolean>;
  /**
   * Void an orphaned broker hold (referral → Lost) when the verification email
   * fails to send — the one referral write this handler owns (see the header
   * note; mirrors app/api/checkout/reserve:447-460). Best-effort by contract:
   * the caller swallows failures so a void blip never masks the real 502.
   */
  voidReferral(referralId: string, note: string): Promise<void>;
}

const defaultDeps: BrokerReserveDeps = {
  // resolveBuyerSession reads the request's cookie store via next/headers
  // (its Request arg is unused), so it resolves correctly inside the POST
  // request scope with no wiring.
  getExistingSession: () => resolveBuyerSession(undefined as unknown as Request),
  fetchRancherBySlug: (slug) => getRancherOrProspectBySlug(slug),
  getConsumerByEmail: async (email) => {
    const rows: any[] = await getAllRecords(
      TABLES.CONSUMERS,
      `LOWER({Email}) = "${escapeAirtableValue(email)}"`,
    );
    return rows[0] || null;
  },
  createConsumer: (fields) => createRecord(TABLES.CONSUMERS, fields),
  findOrCreateBrokerReferral,
  mintDepositGrantToken,
  sendVerificationLink: async ({ consumerId, email, ranchName, depositPath }) => {
    const token = generateMemberLoginToken(consumerId, email);
    // Durable member-verify link (14d token), NOT a Stripe URL. `next` is a
    // same-origin relative path (safeNextPath-validated at the verify route).
    const magicLink = `${SITE_URL}/api/auth/member/verify?token=${token}&next=${encodeURIComponent(depositPath)}`;
    const result = await sendMagicLink({
      to: email,
      subject: ranchName ? `Finish reserving your share with ${ranchName}` : 'Finish reserving your share',
      html: brokerReserveMagicLinkHtml({ ranchName, magicLink }),
    });
    return result?.success === true;
  },
  // 'Dormant', NOT 'Lost' (2026-08-18 schema-guard sweep) — see the long note
  // at app/api/checkout/reserve/route.ts. 'Lost' is not a Referrals.Status
  // option; typecast would MINT it and every selector would go blind to the
  // row. 'Dormant' is the existing system-void terminal: no capacity slot, out
  // of loss reporting, and reusable when the buyer retries.
  voidReferral: async (referralId, note) => {
    await updateRecord(TABLES.REFERRALS, referralId, { Status: 'Dormant', Notes: note });
  },
};

const BUYER_SAFE_RETRY = 'Could not start your reservation — try again.';

export async function handleBrokerReserve(
  body: any,
  deps: BrokerReserveDeps = defaultDeps,
): Promise<NextResponse> {
  const validated = validateBrokerReserveInput(body);
  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: validated.status });
  }
  const { slug, cut, email, name, phone } = validated.input;

  // ── AD ATTRIBUTION (2026-08-17) ───────────────────────────────────────────
  // BrokerReserve.tsx posts the `bhc_source_v2` first-touch snapshot; this maps
  // it to the Consumers columns via the ONE shared mapper (lib/adAttribution).
  // Best-effort by contract: a missing, empty, or malformed payload yields {}
  // and can never fail a reserve. Applied ONLY to a freshly-CREATED consumer
  // below — an ADOPTED consumer is never written to here at all (the
  // account-takeover rule), which also means their first-touch attribution
  // can't be re-stamped by a later ad click.
  const attributionFields = attributionConsumerFields(body?.attribution);

  // Existing member session — a logged-in buyer is AUTHENTICATED and may be
  // credentialed directly; an anonymous caller may NOT adopt a pre-existing
  // consumer by unverified email (the account-takeover guard below).
  let existingSession: { consumerId: string } | null = null;
  try {
    existingSession = await deps.getExistingSession();
  } catch {
    existingSession = null;
  }

  // Look up + gate the rancher BEFORE creating anything (reserve-route order).
  // The slug fetch is the SAME visibility read the public page uses, so only a
  // ranch whose page actually renders can be reserved against.
  let rancher: any;
  try {
    rancher = await deps.fetchRancherBySlug(slug);
  } catch {
    return NextResponse.json({ error: 'Rancher lookup failed' }, { status: 500 });
  }
  if (!rancher) return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });

  // FAIL CLOSED: broker rail + self-serve opt-in + the exact money gates the
  // /r/b redemption runs (lib/brokerRail assertBrokerEligible). Buyer-safe
  // messages; specific codes for the client.
  const gate = assertBrokerSelfServeReservable(rancher, cut);
  if (!gate.ok) {
    return NextResponse.json({ error: gate.code, message: gate.error }, { status: gate.status });
  }

  // Resolve the buyer. A logged-in session is used directly (authenticated).
  // Otherwise look up by email: a MATCH is adopted but NOT yet credentialed
  // (see the grant decision), and a NEW email creates a fresh consumer.
  let consumerId = existingSession?.consumerId || '';
  let adoptedExisting = false;
  if (!consumerId) {
    try {
      const existing = await deps.getConsumerByEmail(email);
      if (existing) {
        // ADOPTED — never written to here (an unverified caller must not touch
        // a consumer they haven't proven they own; no phone backfill).
        adoptedExisting = true;
        consumerId = existing.id;
      } else {
        const fields: Record<string, any> = {
          'Full Name': name || email.split('@')[0],
          Email: email,
          State: String(rancher['State'] || '').trim(),
          Segment: 'Beef Buyer',
          'Lead Source': 'broker-self-serve',
          // CREATE-ONLY (see attributionFields above) — the click that brought
          // this brand-new buyer here. Feeds reconstructFbc at settlement.
          ...attributionFields,
        };
        if (phone) fields['Phone'] = phone;
        const created: any = await deps.createConsumer(fields);
        consumerId = created?.id || '';
      }
    } catch (e: any) {
      console.error('[checkout/broker-reserve] consumer upsert failed:', e?.message);
      return NextResponse.json({ error: BUYER_SAFE_RETRY }, { status: 500 });
    }
  }
  if (!consumerId) {
    return NextResponse.json({ error: BUYER_SAFE_RETRY }, { status: 500 });
  }

  // The SAME find-or-create the /r/b tap runs (app/r/b/[token]/route.ts:67).
  // It re-checks the rail + money gates and REUSES an open broker referral for
  // this buyer↔ranch (Match Type 'Broker — Deposit'), so a re-tap never
  // duplicates. It owns every money-path record write. Runs in BOTH the
  // grant path and the magic-link path (the link's `next` needs the referral).
  let resolved: BrokerReferralResult;
  try {
    resolved = await deps.findOrCreateBrokerReferral({ consumerId, rancherId: rancher.id, cut });
  } catch {
    resolved = { ok: false, reason: 'io-error' };
  }
  if (!resolved.ok) {
    if (resolved.reason === 'rancher-not-found') {
      return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });
    }
    if (resolved.reason === 'not-broker-rail' || resolved.reason === 'ineligible') {
      // Rail flipped / pricing pulled between the page render and this POST.
      return NextResponse.json(
        {
          error: 'self_serve_unavailable',
          message: 'This ranch is not taking online reservations right now.',
        },
        { status: 409 },
      );
    }
    // consumer-not-found (we JUST resolved it — an I/O blip) or io-error: the
    // buyer can safely retry; findOrCreateBrokerReferral left no half-created
    // state (it creates the referral last, and a created referral returns ok).
    return NextResponse.json({ error: BUYER_SAFE_RETRY }, { status: 502 });
  }

  // Same landing path the /r/b route 302s to — the checkout page loads its own
  // money projection and mints the Stripe session at pay-click.
  const path = brokerDepositPathFor(resolved.referralId, cut);

  // ── ACCOUNT-TAKEOVER GUARD (mirrors app/api/checkout/reserve:404-471) ──────
  // An anonymous caller who ADOPTED a pre-existing consumer by unverified email
  // is NOT credentialed. Email a magic link that proves ownership (the member
  // session it mints authorizes the broker checkout); the grant is issued only
  // after they click it, never from this POST.
  // `!existingSession?.consumerId` (not just `!existingSession`): an authed
  // session is only credential-worthy when it actually names a consumer. A
  // member-session that decoded to an EMPTY consumerId (resolveBuyerSession
  // still returns the object) would otherwise slip past this guard and let an
  // adopted-by-unverified-email consumer be credentialed directly. Defense in
  // depth — no legit issuer emits an empty-consumerId session.
  if (adoptedExisting && !existingSession?.consumerId) {
    let emailSent = false;
    try {
      emailSent = await deps.sendVerificationLink({
        consumerId,
        email,
        ranchName: String(rancher['Ranch Name'] || rancher['Operator Name'] || ''),
        depositPath: path,
      });
    } catch (e: any) {
      console.error('[checkout/broker-reserve] magic-link email failed:', e?.message);
      emailSent = false;
    }
    // Never tell the buyer "check your inbox" when the email did NOT send.
    // No grant is issued either way — a failed send just asks them to retry.
    if (!emailSent) {
      // Void the phantom hold findOrCreateBrokerReferral just created/reused
      // (referral → Lost), mirroring app/api/checkout/reserve:447-460. Leaving
      // it Pending would strand a lead the rancher sees + a buyer waiting on an
      // email that never comes. Best-effort — a failed void just logs and must
      // not mask the buyer-facing 502.
      try {
        await deps.voidReferral(
          resolved.referralId,
          'Voided automatically — the broker sign-in email failed to send; buyer was asked to retry.',
        );
      } catch (voidErr: any) {
        console.warn('[checkout/broker-reserve] orphan referral void skipped:', voidErr?.message);
      }
      return NextResponse.json(
        {
          error:
            "We couldn't email your secure sign-in link just now. Please try again in a moment — or log in from the member page to finish reserving.",
        },
        { status: 502 },
      );
    }
    return NextResponse.json({
      requiresEmailVerification: true,
      message: 'We emailed you a secure link to finish reserving your share — check your inbox.',
    });
  }

  // Freshly-created consumer, or an already-authenticated session → safe to
  // credential with the referral-SCOPED deposit grant (only — never a member
  // session from this POST, exactly like /r/b).
  const res = NextResponse.json({ redirect: path });
  try {
    setDepositGrantCookie(
      res,
      deps.mintDepositGrantToken({ consumerId, referralId: resolved.referralId }),
    );
  } catch {
    // Grant minting failed. A logged-in buyer's member session still
    // authorizes the checkout, so send them on. A freshly-created buyer has
    // NO session and now NO grant — redirecting would dead-end on the shared
    // checkout page's auth-required copy ("Open this page from the link we
    // sent you"), which is FALSE on the self-serve rail (nothing is emailed
    // here). Give them an honest inline retry instead, never a sent-link claim.
    if (existingSession) return NextResponse.json({ redirect: path });
    return NextResponse.json(
      { error: 'Could not start your reservation — please try again.' },
      { status: 500 },
    );
  }
  return res;
}

export async function POST(req: Request) {
  // CSRF defense in depth — same Origin allowlist the reserve route runs.
  const originCheck = checkOriginGuard(req);
  if (!originCheck.ok && originCheck.response) return originCheck.response;

  // Rate limit — this endpoint creates Consumer + Referral records and mints a
  // deposit grant. Same budgets as /api/checkout/reserve (rateLimit fails OPEN,
  // so a real buyer is never wrongly bounced by a Redis blip).
  const ip = getRequestIp(req);
  const rlMin = await rateLimit(`broker-reserve:${ip}`, { requests: 5, window: '1m' });
  if (!rlMin.ok) {
    return NextResponse.json(
      { error: 'Too many attempts — wait a minute and try again.' },
      { status: 429 },
    );
  }
  const rlHour = await rateLimit(`broker-reserve-hr:${ip}`, { requests: 30, window: '1h' });
  if (!rlHour.ok) {
    return NextResponse.json(
      { error: 'Too many attempts from this network. Email ben@buyhalfcow.com if this is wrong.' },
      { status: 429 },
    );
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  return handleBrokerReserve(body);
}
