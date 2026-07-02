// Classifier for the Referral `Status` carried on the deposit endpoints'
// 409 `referral_closed` payload (app/api/checkout/deposit/route.ts GET+POST).
//
// The deposit page previously rendered EVERY referral_closed 409 as
// "you're already reserved ✓" — including Closed Lost and Refunded, where the
// beef is NOT coming. A buyer on a dead reservation would sit waiting for a
// delivery that never happens. This maps the status to which UI the page must
// render:
//
//   'inactive' — Closed Lost / Refunded / Lost: the reservation is dead.
//                Render the honest "no longer active" state with live forward
//                paths (find another rancher, retake the quiz, support).
//   'reserved' — Slot Locked / Closed Won / Awaiting Payment / paid: the happy
//                state stays (spot locked, receipt emailed).
//
// Unknown/missing status defaults to 'reserved' — the 409 gate only fires on
// paid signals otherwise, so the positive state is the safe prior (matches
// pre-fix behavior for every non-lost status).

export type ClosedReferralUiState = 'inactive' | 'reserved';

const INACTIVE_STATUSES = new Set(['closed lost', 'lost', 'refunded']);

export function closedReferralUiState(status: unknown): ClosedReferralUiState {
  const s = String(status ?? '').trim().toLowerCase();
  return INACTIVE_STATUSES.has(s) ? 'inactive' : 'reserved';
}
