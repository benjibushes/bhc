// Pure per-state sub-cap math for multi-state routing. ZERO runtime deps
// (mirrors lib/capacityCount) so it's unit-testable and the ONE place the
// equal-floor split is defined.
//
// CONTEXT: a multi-state rancher shares ONE global capacity counter, and the
// matcher (app/api/matching/suggest) fair-shares it across their routing
// states as floor(maxReferrals / numStates) unless a State Capacity Override
// pins explicit per-state slots.
//
// PRE-FLIP GUARD (finding 2, 2026-07-01): the old inline math clamped at 0 —
// a low-capacity rancher approved for many states (max 5 across 6 states)
// silently got 0 slots in EVERY state and rejected every cold lead, zeroing
// states they were explicitly approved to serve. An approved state always
// gets at least 1 slot. This can never over-route: the GLOBAL capacity cap
// (currentReferrals >= maxReferrals) is checked BEFORE the sub-cap and stays
// authoritative — the floor only stops the fair-share split from starving a
// state to zero.

/**
 * Equal-floor per-state sub-cap.
 *
 *   numStates <= 1  → no split; the sub-cap is the full (clamped) cap —
 *                     single-state ranchers keep legacy behavior exactly.
 *   numStates  > 1  → max(1, floor(max / numStates)) — an approved state
 *                     always gets at least one slot (the finding-2 fix).
 *
 * Garbage in (NaN / negative) clamps sane: max → 0, numStates → 0.
 * Explicit operator overrides (State Capacity Override JSON) are respected
 * by the caller BEFORE this math runs — including explicit zeros.
 */
export function equalStateSubCap(maxReferrals: number, numStates: number): number {
  const max = Math.max(0, Math.floor(Number(maxReferrals) || 0));
  const n = Math.floor(Number(numStates) || 0);
  if (n <= 1) return max;
  return Math.max(1, Math.floor(max / n));
}
