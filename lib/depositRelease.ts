// lib/depositRelease.ts
//
// HOLE 2 of the no-dead-end-deals sweep (2026-07-30): an unpaid deposit
// request goes silent FOREVER.
//
// THE LEAK: lib/depositRequestNudge.ts caps the buyer-facing chase at 2
// lifetime email nudges (correct — nobody wants a 40-email dunning rail) and
// the SMS rescue leg is one-shot and still DARK. After that the rail stops.
// Nothing releases the buyer. Live at discovery: 6 buyers, deposit requested
// ~27 days ago, `Deposit Link Opened At` EMPTY on ALL SIX (they never opened a
// single one of the three emails), both nudges spent 22 days ago. 'Awaiting
// Payment' is in HELD_REFERRAL_STATUSES, so each one also pins a rancher
// capacity slot AND blocks the buyer from ever being matched to anyone else.
// Six dead deals, six frozen buyers, six phantom slots, indefinitely.
//
// THE RELEASE: past the nudge cap and 14 more days of silence, flip the
// referral terminal ('Dormant' — the SAME terminal the stale-hold expiry uses,
// deliberately NOT 'Closed Lost'; see LOSS-REASON SCOPING below), stamp a
// structured Loss Reason, and let the shared expiry legs restore the buyer to
// READY + resync the capacity counter.
//
// ── MONEY SAFETY — the whole reason this module is separate and pure ────────
// This rail touches rows in the ONE status that means "money was asked for."
// A wrong flip here is not a lost lead, it is a customer who paid and whose
// deal we marked dead. Every one of these refuses, and every one has a test:
//   - 'Deposit Paid At' set                       → the buyer PAID.
//   - any settlement/fee stamp (MONEY_STAMP_FIELDS: BHC Fee Cents, Fee
//     Captured At, Payment Confirmed At, Final Paid At, Commission Paid At)
//     → money moved on this referral, even if Deposit Paid At is somehow blank.
//   - a Payments row for the referral in ANY status outside
//     HARMLESS_PAYMENT_STATUSES → refuse. Not just 'succeeded': 'pending' is a
//     checkout IN FLIGHT and 'requires_webhook_replay' is money that arrived
//     and whose webhook we lost. Both are money.
//   - the Payments probe missing or failed → refuse ('payment-state-unknown').
//     FAIL CLOSED: an Airtable blip must never look like "no payments."
// NOT a refusal: 'Deposit Amount'. That is the AMOUNT ASKED FOR, stamped at
// request time on every single row this rail exists to release (all 6 live
// rows carry 600). Treating it as payment proof would make this module a
// permanent no-op — the exact bug it is fixing.
//
// ── LOSS-REASON SCOPING ─────────────────────────────────────────────────────
// The row gets 'Loss Reason' = "Couldn't reach buyer" (pinned vocabulary,
// lib/lossReasons) because that is literally what happened and a human reading
// the record later deserves a structured answer, not archaeology in Notes.
// But it is stamped on a 'Dormant' row, NOT 'Closed Lost', and that is load-
// bearing: the platform's contract (lib/lossScorecard.ts, docs/WRITE-MAP.md)
// is "a Closed Lost row carrying a Loss Reason IS a rancher-initiated loss."
// Three consumers depend on it, and all three are scoped to Closed Lost:
//   - weekly-scorecard  ({Status}="Closed Lost")   → auto-releases stay out of
//     the rancher-loss table, which would otherwise blame ranchers for silence
//     that was the BUYER's.
//   - loss-recovery     ({Status}="Closed Lost")   → "Couldn't reach buyer"
//     maps to 'reengage'; re-emailing a buyer who just ignored 3 emails is
//     precisely wrong, and it would also trip that cron's mass-edit guard.
//   - matching/suggest  (Closed Lost + excluding reason) → the pairing stays
//     eligible, so the buyer is not bricked out of their state's supply.
// Dormant + Loss Reason gets the human-readable truth with none of that.
//
// Pure + dependency-free (lib/staleHolds conventions): the cron owns every
// read and every write, this module only answers "may we release this row,
// and if not, why not."

import { DEPOSIT_NUDGE_LIFETIME_CAP } from './depositRequestNudge';
import { isReferralOnHold } from './referralHold';
import { type LossReason } from './lossReasons';

/**
 * Extra silence required AFTER the last nudge before the release fires. The
 * chase rail's own cadence is nudge 1 at ~24h and nudge 2 at ~72h, so 14 more
 * days means a buyer has had roughly three weeks and three (or four, with the
 * SMS leg) touches before anything terminal happens to their deal.
 */
export const DEPOSIT_RELEASE_SILENCE_DAYS = 14;

/** Terminal status for a released row — the same one the stale expiry uses. */
export const DEPOSIT_RELEASE_STATUS = 'Dormant';

/**
 * Structured reason, from the pinned vocabulary (lib/lossReasons). NOT
 * invented here — `LOSS_REASON_CHOICES` is verified codepoint-for-codepoint
 * against prod schema fldV4hf0ptyhMaaAA, and Airtable writes are typecast:true
 * so a one-byte drift would silently mint a junk select option. The `satisfies`
 * pin below fails the BUILD if this string ever leaves the vocabulary.
 */
export const DEPOSIT_RELEASE_LOSS_REASON = "Couldn't reach buyer" satisfies LossReason;

/** Referral fields that prove money moved. ANY of them present ⇒ never touch. */
export const MONEY_STAMP_FIELDS = [
  'BHC Fee Cents',
  'Fee Captured At',
  'Payment Confirmed At',
  'Final Paid At',
  'Commission Paid At',
] as const;

/**
 * Payments statuses that are safe to ignore. Everything else — including
 * 'pending' (checkout in flight) and 'requires_webhook_replay' (money in,
 * webhook lost) — blocks the release. Denylist-of-safe, not allowlist-of-bad:
 * a new payment status added tomorrow blocks by default instead of silently
 * becoming releasable.
 */
export const HARMLESS_PAYMENT_STATUSES = new Set(['failed', 'abandoned']);

/**
 * The referral's payment truth, resolved by the cron (this module does no
 * I/O). `ok: false` is the fail-closed signal for a read that threw.
 */
export interface DepositPaymentsProbe {
  ok: boolean;
  hasLivePayment: boolean;
}

export interface DepositReleaseRow {
  id?: string;
  Status?: unknown;
  'Deposit Requested At'?: unknown;
  'Deposit Paid At'?: unknown;
  'Deposit Nudge Count'?: unknown;
  'Deposit Nudge Last Sent At'?: unknown;
  'Deposit Link Opened At'?: unknown;
  'Referral Source'?: unknown;
  'Hold Until'?: unknown;
  'Buyer Name'?: unknown;
  Rancher?: unknown;
  Buyer?: unknown;
  /** Attached by the cron from the Payments table before the final gate. */
  __payments?: DepositPaymentsProbe;
  [key: string]: unknown;
}

export type DepositReleaseRefusal =
  | 'wrong-status'
  | 'no-deposit-request'
  | 'deposit-paid'
  | 'money-stamped'
  | 'rancher-added'
  | 'on-hold'
  | 'nudges-remaining'
  | 'no-nudge-stamp'
  | 'inside-silence-window'
  | 'payment-state-unknown'
  | 'live-payment';

const DAY_MS = 24 * 60 * 60 * 1000;

function statusName(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim();
  if (raw && typeof raw === 'object' && typeof (raw as any).name === 'string') {
    return String((raw as any).name).trim();
  }
  return '';
}

function parseMs(raw: unknown): number | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

function isPresent(raw: unknown): boolean {
  if (raw === null || raw === undefined) return false;
  // A literal 0 in 'BHC Fee Cents' is a WRITTEN value, not a blank — the field
  // is only ever written at settlement. Treat it as present (fail closed).
  if (typeof raw === 'number') return true;
  if (Array.isArray(raw)) return raw.length > 0;
  return String(raw).trim() !== '';
}

/** Turn a Payments read into the probe. Non-array (a failed read) ⇒ ok:false. */
export function probeFromPayments(rows: unknown): DepositPaymentsProbe {
  if (!Array.isArray(rows)) return { ok: false, hasLivePayment: false };
  const hasLivePayment = rows.some(
    (p: any) => !HARMLESS_PAYMENT_STATUSES.has(String(p?.['Status'] ?? '').trim().toLowerCase()),
  );
  return { ok: true, hasLivePayment };
}

/** The probe to use when the Payments read threw — refuses everything. */
export const PAYMENTS_PROBE_FAILED: DepositPaymentsProbe = { ok: false, hasLivePayment: false };

/**
 * Everything except the Payments lookup. Split out so the cron can narrow to a
 * capped handful of candidates BEFORE spending one Airtable round-trip each on
 * the payment probe (the reserve rail's pattern). Returns the refusal code, or
 * null when the row clears every non-payment gate.
 */
export function staticReleaseRefusal(
  r: DepositReleaseRow,
  nowMs: number,
  opts?: { silenceDays?: number },
): DepositReleaseRefusal | null {
  // Shape: a rancher-sent request that is still unpaid and still awaiting.
  if (statusName(r?.Status) !== 'Awaiting Payment') return 'wrong-status';
  const requestedMs = parseMs(r?.['Deposit Requested At']);
  if (requestedMs === null) return 'no-deposit-request';

  // ── money gates ──
  if (isPresent(r?.['Deposit Paid At'])) return 'deposit-paid';
  for (const f of MONEY_STAMP_FIELDS) {
    if (isPresent(r?.[f])) return 'money-stamped';
  }

  // My Leads (#511): a rancher's own customer. The rancher owns that deal end
  // to end — we never auto-close their pipeline. Same carve-out as
  // lib/staleHolds; tolerates the Airtable {name} read shape.
  const src = r?.['Referral Source'];
  const srcStr =
    src && typeof src === 'object' && 'name' in (src as any)
      ? String((src as any).name || '')
      : String(src ?? '');
  if (srcStr.trim() === 'rancher-added') return 'rancher-added';

  // Operator park — the ⏸️ Hold button's explicit "come back to this".
  if (isReferralOnHold(r?.['Hold Until'], nowMs)) return 'on-hold';

  // The chase must be EXHAUSTED. While a nudge is still owed, the rail is
  // still working the deal and this module must stay out of its way.
  const rawCount = Number(r?.['Deposit Nudge Count']);
  const count = Number.isFinite(rawCount) && rawCount > 0 ? rawCount : 0;
  if (count < DEPOSIT_NUDGE_LIFETIME_CAP) return 'nudges-remaining';

  // Anchor on the LAST nudge, not the request: the release must be measured
  // from our final touch. count>=cap with no parseable stamp is data drift →
  // refuse rather than guess (fail closed).
  const lastMs = parseMs(r?.['Deposit Nudge Last Sent At']);
  if (lastMs === null) return 'no-nudge-stamp';
  const silenceDays = opts?.silenceDays ?? DEPOSIT_RELEASE_SILENCE_DAYS;
  if (nowMs - lastMs < silenceDays * DAY_MS) return 'inside-silence-window';

  return null;
}

/**
 * The full gate, including the payment probe the cron attaches as
 * `__payments`. A missing probe is treated exactly like a failed read.
 */
export function depositReleaseRefusal(
  r: DepositReleaseRow,
  nowMs: number,
  opts?: { silenceDays?: number },
): DepositReleaseRefusal | null {
  const staticRefusal = staticReleaseRefusal(r, nowMs, opts);
  if (staticRefusal) return staticRefusal;
  const probe = r?.__payments;
  if (!probe || probe.ok !== true) return 'payment-state-unknown';
  if (probe.hasLivePayment) return 'live-payment';
  return null;
}

/** Pure per-row predicate — the final answer the cron writes on. */
export function isDepositReleaseEligible(
  r: DepositReleaseRow,
  nowMs: number,
  opts?: { silenceDays?: number },
): boolean {
  return depositReleaseRefusal(r, nowMs, opts) === null;
}

/**
 * Candidates for the payment probe: every non-payment gate cleared, oldest
 * request first (they rotted first), capped so one run can never blow the
 * cron budget or surprise the operator with a hundred flips.
 */
export function selectDepositReleaseCandidates<T extends DepositReleaseRow>(
  rows: T[],
  opts: { nowMs: number; cap?: number; silenceDays?: number },
): T[] {
  const cap = Math.floor(opts.cap ?? 25);
  if (!Array.isArray(rows) || rows.length === 0 || cap <= 0) return [];
  return rows
    .filter((r) => staticReleaseRefusal(r, opts.nowMs, opts) === null)
    .sort(
      (a, b) =>
        (parseMs(a['Deposit Requested At']) ?? 0) - (parseMs(b['Deposit Requested At']) ?? 0),
    )
    .slice(0, cap);
}

/**
 * Whole days since a stamp, for operator lines. Returns null (never NaN) when
 * the value is blank or unparseable.
 */
export function daysSince(raw: unknown, nowMs: number): number | null {
  const ms = parseMs(raw);
  if (ms === null) return null;
  return Math.floor((nowMs - ms) / DAY_MS);
}

/** Per-row refusal tally for the Cron Runs note — "0 released" must be diagnosable. */
export function refusalBreakdown(
  rows: DepositReleaseRow[],
  nowMs: number,
  opts?: { silenceDays?: number },
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const why = depositReleaseRefusal(r, nowMs, opts);
    if (!why) continue;
    out[why] = (out[why] || 0) + 1;
  }
  return out;
}

/**
 * The Notes audit stamp. A human opening this record in six months must be
 * able to reconstruct the decision without reading any code: how long the ask
 * sat, how many times we chased, whether they ever opened it, and the explicit
 * fact that no money was on the row.
 */
export function releaseNoteStamp(
  r: DepositReleaseRow,
  opts: { today: string; nowMs: number },
): string {
  const requestedMs = parseMs(r?.['Deposit Requested At']);
  const lastMs = parseMs(r?.['Deposit Nudge Last Sent At']);
  const ageDays = requestedMs === null ? '?' : String(Math.floor((opts.nowMs - requestedMs) / DAY_MS));
  const silentDays = lastMs === null ? '?' : String(Math.floor((opts.nowMs - lastMs) / DAY_MS));
  const rawCount = Number(r?.['Deposit Nudge Count']);
  const count = Number.isFinite(rawCount) && rawCount > 0 ? rawCount : 0;
  const opened = isPresent(r?.['Deposit Link Opened At']) ? 'link opened' : 'link NEVER opened';
  return (
    `[auto-released ${opts.today}: deposit requested ${ageDays}d ago, never paid — ` +
    `${count} nudge${count === 1 ? '' : 's'} sent, silent ${silentDays}d, ${opened} — ` +
    `no payment on file; buyer released back to matching]`
  );
}
