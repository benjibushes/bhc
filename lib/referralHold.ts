// lib/referralHold.ts
//
// Referrals `Hold Until` (fldbwlPiIIweXamRP, dateTime) — the operator
// "⏸️ Hold" re-surface pointer written by the Telegram hold button
// (app/api/webhooks/telegram/route.ts). A row whose Hold Until is in the
// future is PARKED: agers/chasers (referral-chasup, close-detector) must
// skip it until the hold expires.
//
// History: the hold button used to write now+7d into `Approved At`
// (singleLineText!) as a future timestamp — every ager that uses Approved At
// as an age origin then computed a negative age (row invisible for 7 days,
// intended) while silently corrupting approval analytics AND the
// reply-attach recency sort (lib/airtable.ts findReferralByBuyerEmail).
// The dedicated field kills the overload.

/**
 * True when the referral is currently parked by a future `Hold Until`.
 *
 * Fail-OPEN semantics: blank, missing, or unparseable values are NOT held —
 * a corrupt value must never hide a live deal from the chasers forever.
 * Strict `>`: a hold expiring exactly now is released.
 */
export function isReferralOnHold(holdUntil: unknown, nowMs: number = Date.now()): boolean {
  if (holdUntil == null || holdUntil === '') return false;
  const t = new Date(String(holdUntil)).getTime();
  if (!Number.isFinite(t)) return false;
  return t > nowMs;
}
