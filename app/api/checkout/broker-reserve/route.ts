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
// SECURITY MODEL — identical to /r/b: NO member session is ever minted from an
// unverified email (the reserve route's account-takeover rule). The response
// carries only the referral-scoped deposit grant, so the worst a submitted
// email can do is pay THIS one deposit; it can never reach /member or any other
// referral. findOrCreateBrokerReferral owns the money-path writes (repo rule:
// money truth is persisted by it, nothing here writes referral records) and its
// find-or-create semantics make a double-tap reuse the open referral instead of
// duplicating.
//
// Body: { slug, cut: 'quarter'|'half'|'whole', email, name?, phone? }
// 200 → { redirect: '/checkout/<refId>/broker?cut=<cut>' } — the client
// navigates there; the page mints the actual Stripe session at pay-click.
// NEVER a raw Stripe URL (repo rule #3).

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
import { mintDepositGrantToken, brokerDepositPathFor } from '@/lib/campaignReserve';
import { setDepositGrantCookie } from '@/lib/buyerAuth';
import { checkOriginGuard } from '@/lib/csrfGuard';
import { rateLimit, getRequestIp } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

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

// ---------------------------------------------------------------------------
// Core flow — deps injected so the unit test can fake the Airtable +
// brokerReferral layers (assert find-or-create runs ONCE, no duplicate
// consumer create on a re-tap, grant cookie set, redirect path shape).
// ---------------------------------------------------------------------------

export interface BrokerReserveDeps {
  fetchRancherBySlug(slug: string): Promise<any>;
  getConsumerByEmail(email: string): Promise<any | null>;
  createConsumer(fields: Record<string, any>): Promise<any>;
  /** Non-fatal blank-only backfill on an existing consumer. */
  patchConsumer(consumerId: string, patch: Record<string, any>): Promise<void>;
  findOrCreateBrokerReferral(args: {
    consumerId: string;
    rancherId: string;
    cut: Cut;
  }): Promise<BrokerReferralResult>;
  mintDepositGrantToken(claims: { consumerId: string; referralId: string }): string;
}

const defaultDeps: BrokerReserveDeps = {
  fetchRancherBySlug: (slug) => getRancherOrProspectBySlug(slug),
  getConsumerByEmail: async (email) => {
    const rows: any[] = await getAllRecords(
      TABLES.CONSUMERS,
      `LOWER({Email}) = "${escapeAirtableValue(email)}"`,
    );
    return rows[0] || null;
  },
  createConsumer: (fields) => createRecord(TABLES.CONSUMERS, fields),
  patchConsumer: async (consumerId, patch) => {
    await updateRecord(TABLES.CONSUMERS, consumerId, patch);
  },
  findOrCreateBrokerReferral,
  mintDepositGrantToken,
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

  // Find-or-create the Consumer — mirrors the operator sell-links mint (the
  // token path's consumer upsert), fed the buyer's SUBMITTED email/name with
  // the ranch's own State (the buyer is reserving from a local ranch page).
  let consumerId = '';
  try {
    const existing = await deps.getConsumerByEmail(email);
    if (existing) {
      consumerId = existing.id;
      // Blank-only backfill (never overwrite a real value) so the ranch always
      // has a number to call — same rule as the reserve route. NON-FATAL: a
      // patch failure must never block the money path.
      if (phone && !String(existing['Phone'] || '').trim()) {
        try {
          await deps.patchConsumer(consumerId, { Phone: phone });
        } catch (e: any) {
          console.warn('[checkout/broker-reserve] consumer backfill skipped:', e?.message);
        }
      }
    } else {
      const fields: Record<string, any> = {
        'Full Name': name || email.split('@')[0],
        Email: email,
        State: String(rancher['State'] || '').trim(),
        Segment: 'Beef Buyer',
        'Lead Source': 'broker-self-serve',
      };
      if (phone) fields['Phone'] = phone;
      const created: any = await deps.createConsumer(fields);
      consumerId = created?.id || '';
    }
  } catch (e: any) {
    console.error('[checkout/broker-reserve] consumer upsert failed:', e?.message);
    return NextResponse.json({ error: BUYER_SAFE_RETRY }, { status: 500 });
  }
  if (!consumerId) {
    return NextResponse.json({ error: BUYER_SAFE_RETRY }, { status: 500 });
  }

  // The SAME find-or-create the /r/b tap runs (app/r/b/[token]/route.ts:67).
  // It re-checks the rail + money gates and REUSES an open broker referral for
  // this buyer↔ranch (Match Type 'Broker — Deposit'), so a re-tap never
  // duplicates. It owns every money-path record write.
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
  // money projection and mints the Stripe session at pay-click. The client
  // navigates; no Stripe URL exists yet, let alone rides this response.
  const path = brokerDepositPathFor(resolved.referralId, cut);
  const res = NextResponse.json({ redirect: path });
  try {
    setDepositGrantCookie(
      res,
      deps.mintDepositGrantToken({ consumerId, referralId: resolved.referralId }),
    );
  } catch {
    // Grant minting failed — still hand back the path (mirrors /r/b): a
    // logged-in buyer's member cookie may carry them; otherwise the checkout
    // page shows its auth-required state rather than this POST 500ing.
    return NextResponse.json({ redirect: path });
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
