// lib/reserveRecovery.ts
//
// UPGRADE A — abandoned-reserve recovery (highest-ROI cohort). Pure eligibility
// selector + message builders for the demand-router cron.
//
// THE COHORT: a buyer who created a reserve referral (via /api/checkout/reserve
// or a /r/d/<token> 1-tap link) but NEVER paid the deposit. They picked a cut,
// picked a rancher, hit the checkout — and bounced. That is the single hottest,
// most-recoverable lead on the platform: intent is proven, only the last tap is
// missing.
//
// RESEARCH (Attentive / Bloomreach / Omnisend 2025-26):
//   • Email+SMS combined ≈ +127% conversion vs email-only.
//   • SMS works best as a RECOVERY channel fired AFTER an email goes
//     unengaged (~4-8h later), NOT a simultaneous blast.
//   • Every follow-up must ADD something new (73% reject pure repeats) — so the
//     recovery SMS uses a DIFFERENT angle (deadline/scarcity) than the email
//     (your-share-is-held).
//
// So recovery is a two-step arc, both idempotent:
//   STEP 1 — recovery EMAIL: referral pre-deposit, Deposit Paid At empty, created
//            > RESERVE_RECOVERY_HOURS ago, not yet recovered, not refunded/closed.
//            Stamps `Reserve Recovery Sent At`.
//   STEP 2 — recovery SMS (opted-in only, TCPA): the email already went out
//            (`Reserve Recovery Sent At` set) AND it's been > RESERVE_RECOVERY_
//            SMS_HOURS since, still unpaid, SMS not yet sent. Stamps
//            `Reserve Recovery SMS Sent At`. This is the recovery escalation.
//
// PURE: every function here is dependency-free decision/format logic over plain
// Airtable-shaped rows so it unit-tests with zero network (mirrors lib/depositSla
// + lib/demandRouter). The cron (app/api/cron/demand-router) does the Airtable
// read, the stamp-before-side-effect, and the send.

import { isRefundedOrDisputed, type SlaPaymentLike } from './depositSla';

// ── Tunable timings (cron overrides via env) ─────────────────────────────────
export const DEFAULT_RESERVE_RECOVERY_HOURS = 3; // wait after reserve before email
export const DEFAULT_RESERVE_RECOVERY_SMS_HOURS = 6; // wait after email before SMS
const HOUR = 3_600_000;

// Statuses that mean the deposit intent is dead or already moved past "reserve
// abandoned" — NEVER recover these. Awaiting Payment / Slot Locked = the buyer
// is effectively in/at payment (a deposit-paid or off-platform flow); Closed
// Won/Lost = terminal; Refunded/Cancelled/Expired = resolved. Pending /
// Pending Deposit / blank = the live abandoned-reserve state we DO recover.
export const RECOVERY_EXCLUDED_STATUSES: ReadonlySet<string> = new Set([
  'Awaiting Payment',
  'Slot Locked',
  'Closed Won',
  'Closed Lost',
  'Refunded',
  'Cancelled',
  'Canceled',
  'Expired',
]);

// A reserve referral is identified by a deposit Match Type (the reserve + 1-tap
// paths both stamp 'Direct (Rancher Page) — Deposit'). We only recover genuine
// deposit-intent referrals, never a generic lead/match the buyer happens to have.
export function isDepositIntent(ref: { 'Match Type'?: unknown }): boolean {
  return String(ref['Match Type'] || '').includes('Deposit');
}

export interface RecoveryReferralLike {
  id?: string;
  Status?: unknown;
  'Match Type'?: unknown;
  'Deposit Paid At'?: unknown;
  'Reserve Recovery Sent At'?: unknown;
  'Reserve Recovery SMS Sent At'?: unknown;
  // Refund/dispute signals (same model as depositSla): Referral-side + linked
  // Payments row attached by the cron as __payment.
  'Refunded At'?: unknown;
  'Dispute Status'?: unknown;
  __payment?: SlaPaymentLike | null;
  // Airtable record-creation metadata (lib/airtable getAllRecords exposes this
  // as `_createdTime`, ISO 8601). Referrals has NO user "Created" field, so this
  // metadata is the canonical "when was the reserve made" signal.
  _createdTime?: unknown;
}

function toMs(v: unknown): number {
  if (!v) return 0;
  const t = new Date(String(v)).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** The reserve-creation time in ms (Airtable `_createdTime` metadata). */
export function reserveCreatedMs(ref: RecoveryReferralLike): number {
  return toMs(ref._createdTime);
}

export interface RecoveryOptions {
  /** Hours after reserve before the recovery EMAIL. Default 3. */
  recoveryHours?: number;
  /** Hours after the recovery email before the recovery SMS. Default 6. */
  smsHours?: number;
  /** Injectable clock. Default Date.now(). */
  now?: number;
}

/**
 * Shared pre-checks for BOTH recovery steps: a live, deposit-intent, unpaid,
 * not-refunded reserve referral. Returns false the moment any disqualifier hits.
 */
function isLiveAbandonedReserve(ref: RecoveryReferralLike): boolean {
  // Must be a deposit-intent referral.
  if (!isDepositIntent(ref)) return false;
  // Deposit already paid → not abandoned (this is the whole point).
  if (ref['Deposit Paid At']) return false;
  // Terminal / past-reserve status → never recover.
  const status = String(ref.Status || '');
  if (RECOVERY_EXCLUDED_STATUSES.has(status)) return false;
  // Refunded/disputed (Referral OR linked Payments row) → resolved, never recover.
  if (isRefundedOrDisputed(ref)) return false;
  return true;
}

/**
 * STEP 1 — is this referral eligible for a recovery EMAIL right now?
 *
 * Eligible when ALL hold:
 *   1. Live abandoned reserve (deposit-intent, unpaid, not terminal/refunded).
 *   2. Recovery email not already sent (`Reserve Recovery Sent At` empty).
 *   3. The reserve was created > recoveryHours ago (give the buyer a beat to
 *      finish on their own before we nudge).
 */
export function isRecoveryEmailEligible(ref: RecoveryReferralLike, opts: RecoveryOptions = {}): boolean {
  const recoveryHours = opts.recoveryHours ?? DEFAULT_RESERVE_RECOVERY_HOURS;
  const now = opts.now ?? Date.now();

  if (!isLiveAbandonedReserve(ref)) return false;
  if (ref['Reserve Recovery Sent At']) return false; // already recovered (email)

  const created = reserveCreatedMs(ref);
  if (!created) return false; // no creation time → can't age it → skip (safe)
  if (now - created < recoveryHours * HOUR) return false; // too fresh
  return true;
}

/**
 * STEP 2 — is this referral eligible for a recovery SMS right now?
 *
 * Eligible when ALL hold:
 *   1. Live abandoned reserve (same base gate).
 *   2. The recovery EMAIL already went out (`Reserve Recovery Sent At` set) —
 *      SMS is a RECOVERY-OF-RECOVERY channel, fired only after the email failed
 *      to convert (research: SMS recovers an unengaged email, not a blast).
 *   3. It's been > smsHours since that email.
 *   4. The recovery SMS hasn't already been sent (`Reserve Recovery SMS Sent At`
 *      empty).
 *
 * NOTE: opt-in (TCPA) + ENABLE_SMS are enforced by the cron / sendSMSToConsumer,
 * NOT here — this selector stays a pure timing/eligibility gate. The cron only
 * calls this for opted-in buyers and the SMS sender double-checks opt-in.
 */
export function isRecoverySmsEligible(ref: RecoveryReferralLike, opts: RecoveryOptions = {}): boolean {
  const smsHours = opts.smsHours ?? DEFAULT_RESERVE_RECOVERY_SMS_HOURS;
  const now = opts.now ?? Date.now();

  if (!isLiveAbandonedReserve(ref)) return false;
  if (ref['Reserve Recovery SMS Sent At']) return false; // SMS already sent

  const emailedAt = toMs(ref['Reserve Recovery Sent At']);
  if (!emailedAt) return false; // email must precede the SMS recovery
  if (now - emailedAt < smsHours * HOUR) return false; // not long enough since email
  return true;
}

export type RecoveryStep = 'email' | 'sms' | null;

/**
 * The single next recovery action for a referral (email takes precedence over
 * SMS — you always get the email first). null = nothing to do. Pure.
 */
export function nextRecoveryStep(ref: RecoveryReferralLike, opts: RecoveryOptions = {}): RecoveryStep {
  if (isRecoveryEmailEligible(ref, opts)) return 'email';
  if (isRecoverySmsEligible(ref, opts)) return 'sms';
  return null;
}

/** Filter a list of referrals to those needing a recovery email. Pure. */
export function selectRecoveryEmail<T extends RecoveryReferralLike>(refs: T[], opts: RecoveryOptions = {}): T[] {
  return (refs || []).filter((r) => isRecoveryEmailEligible(r, opts));
}

/** Filter a list of referrals to those needing a recovery SMS. Pure. */
export function selectRecoverySms<T extends RecoveryReferralLike>(refs: T[], opts: RecoveryOptions = {}): T[] {
  return (refs || []).filter((r) => isRecoverySmsEligible(r, opts));
}

/** Whole hours since the reserve was created (for alert/report copy). */
export function hoursSinceReserve(ref: RecoveryReferralLike, now: number = Date.now()): number {
  const created = reserveCreatedMs(ref);
  if (!created) return 0;
  return Math.floor((now - created) / HOUR);
}

// ─────────────────────────────────────────────────────────────────────
// RECOVERY MESSAGE COPY  (on-brand: lowercase, honest, "— Ben")
// Tokens: {first} {cut} {rancher} {link} {socialProof}
//
// The EMAIL says "your {cut} share is still held — finish reserving →".
// The SMS uses a DISTINCT angle (the hold is about to release) so it ADDS
// something rather than repeating the email (research: 73% reject repeats).
// ─────────────────────────────────────────────────────────────────────

export interface RecoveryRenderCtx {
  firstName: string;
  cut: string; // human label e.g. "quarter", "half", "whole" (already lower)
  rancher: string; // rancher display name
  link: string; // 1-tap /r/d/<token> deposit link (or rancher-page fallback)
  socialProof?: string; // optional pre-formatted line (omit when '')
}

export interface RecoveryEmail {
  subject: string;
  text: string;
  html: string;
}

function esc(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function fillRecoveryTokens(s: string, ctx: RecoveryRenderCtx): string {
  const proof = ctx.socialProof || '';
  return s
    .replace(/\{first\}/g, ctx.firstName)
    .replace(/\{cut\}/g, ctx.cut)
    .replace(/\{rancher\}/g, ctx.rancher)
    .replace(/\{link\}/g, ctx.link)
    .replace(/\{socialProof\}\n\n?/g, proof ? `${proof}\n\n` : '')
    .replace(/\{socialProof\}/g, proof);
}

const RECOVERY_EMAIL_SUBJECT = 'your {cut} share is still held, {first}';

const RECOVERY_EMAIL_BODY = `hey {first},

you started reserving a {cut} share from {rancher} — but didn't finish, so the
deposit never went through. good news: we held your spot.

{socialProof}it's still here if you want it. one tap finishes the reservation:
{link}

if you've changed your mind, no worries — just ignore this and the hold releases.

— Ben`;

// SMS — DIFFERENT angle (the hold is releasing soon → urgency), not a repeat of
// the email. Always carries STOP (TCPA). Short.
const RECOVERY_SMS_BODY = `BuyHalfCow: {first}, your {cut} share from {rancher} is still held but the hold releases soon. finish reserving: {link}
reply STOP to opt out`;

/** Render the recovery email (subject + text + minimal HTML). Pure. */
export function renderRecoveryEmail(ctx: RecoveryRenderCtx): RecoveryEmail {
  const subject = fillRecoveryTokens(RECOVERY_EMAIL_SUBJECT, ctx);
  const text = fillRecoveryTokens(RECOVERY_EMAIL_BODY, ctx);
  const html = textToHtml(text, ctx.link);
  return { subject, text, html };
}

/** Render the recovery SMS body (opt-in only). Pure. */
export function renderRecoverySms(ctx: RecoveryRenderCtx): string {
  return fillRecoveryTokens(RECOVERY_SMS_BODY, ctx);
}

// Minimal on-brand HTML wrapper (mirrors lib/demandRouter.textToHtml). The bare
// link line becomes a styled anchor.
function textToHtml(text: string, link: string): string {
  const safe = esc(text)
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (t === esc(link)) {
        return `<p style="margin:18px 0;"><a href="${esc(link)}" style="color:#0E0E0E;font-weight:600;text-decoration:underline;">${esc(link)}</a></p>`;
      }
      if (t === '') return '';
      return `<p style="margin:14px 0;color:#2A2A2A;font-size:15px;line-height:1.6;">${line}</p>`;
    })
    .filter(Boolean)
    .join('\n');
  return `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;color:#0E0E0E;">${safe}</div>`;
}

// Email Sends Campaign tag + template names for the frequency-guard whitelist
// (the campaign engine owns cadence, not the 3/week cap), mirroring
// lib/demandRouter's CAMPAIGN_TEMPLATE_NAMES.
export const RECOVERY_CAMPAIGN_NAME = 'demand-router-reserve-recovery';
export const RECOVERY_EMAIL_TEMPLATE = 'reserveRecoveryEmail';

// Airtable field names the cron stamps (idempotency). NEW fields on Referrals —
// see the cron header / handoff notes; Ben must create them in Airtable.
export const RESERVE_RECOVERY_EMAIL_FIELD = 'Reserve Recovery Sent At';
export const RESERVE_RECOVERY_SMS_FIELD = 'Reserve Recovery SMS Sent At';
