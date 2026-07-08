// lib/nurtureDrip.ts
//
// WAITLIST NURTURE DRIP (backlog #111, built 2026-07-08). The gap it closes:
// a buyer who qualifies but has no rancher yet got ONE waitlist email at
// approval and then silence until routing — for TX/CA today that silence is
// weeks. Four timed touches keep the list warm, teach the product, and point
// the impatient at the $13 shop door, without ever promising a rancher date.
//
// Touch schedule (days since Qualified At — the approval-day waitlist email
// is touch 0 and lives in batch-approve, so the drip starts at day 2):
//   1 · d2  — education: what a share actually costs / how the process works
//   2 · d6  — shop bridge: real beef from the same ranches, shipped this week
//   3 · d12 — check-in: still want in? anything changed? (reply-friendly)
//   4 · d21 — the long-haul note: map + refer-a-ranch (demand speeds supply)
//
// HARD RULES (why this can't spam):
//   - Only WAITING/READY buyers with a Qualified At and an email.
//   - Any active deal referral (isActiveDealReferral) = OUT immediately —
//     routed buyers hear from their rancher, not the drip.
//   - Monotonic: touches send in order, at most one per run per buyer, never
//     re-send (Nurture Touch stamp + claim-before-send in the cron).
//   - Stops forever after touch 4 — the re-warm cohort cron owns anything
//     older; suppression/unsubscribe enforced at send by guardedSend.
//
// Pure module — the cron passes plain data in; everything here is testable
// without Airtable or the email stack.

export interface NurtureTouch {
  /** 1-based touch number, stored in Consumers['Nurture Touch']. */
  touch: number;
  /** Days after Qualified At when this touch becomes due. */
  day: number;
}

export const NURTURE_TOUCHES: NurtureTouch[] = [
  { touch: 1, day: 2 },
  { touch: 2, day: 6 },
  { touch: 3, day: 12 },
  { touch: 4, day: 21 },
];

const DAY_MS = 24 * 60 * 60 * 1000;

export interface NurtureCandidate {
  buyerStage: string;      // Consumers['Buyer Stage']
  qualifiedAt: string;     // Consumers['Qualified At'] (ISO; '' = never)
  email: string;           // Consumers['Email']
  nurtureTouch: number;    // Consumers['Nurture Touch'] (0/NaN = none sent)
  hasActiveDeal: boolean;  // any isActiveDealReferral row for this buyer
}

/**
 * The next touch due for this buyer right now, or null.
 * Never skips ahead: if a buyer is at touch 1 and day 12 has passed, the
 * next send is touch 2 (order preserved; the cron catches up one per day).
 */
export function dueNurtureTouch(c: NurtureCandidate, nowMs: number): NurtureTouch | null {
  if (!c.email || !c.email.includes('@')) return null;
  const stage = String(c.buyerStage || '');
  if (stage !== 'WAITING' && stage !== 'READY') return null;
  if (c.hasActiveDeal) return null;
  const qualified = Date.parse(c.qualifiedAt || '');
  if (!Number.isFinite(qualified)) return null;

  const sent = Number.isFinite(c.nurtureTouch) && c.nurtureTouch > 0 ? Math.floor(c.nurtureTouch) : 0;
  const next = NURTURE_TOUCHES.find((t) => t.touch === sent + 1);
  if (!next) return null; // all four sent — drip is done forever

  const daysSince = (nowMs - qualified) / DAY_MS;
  return daysSince >= next.day ? next : null;
}
