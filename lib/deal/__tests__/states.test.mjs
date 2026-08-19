import { DEAL_STATES, statusToState, stateToStatus, timestampFieldFor } from '../states.ts';
import { canTransition } from '../transitions.ts';

// Data-layer audit P2 (2026-08-18) — 'Refunded' is a REAL Referral Status.
// lib/refundLifecycle::refundReferralClearFields writes it on every full
// refund and ~15 surfaces read it as its own terminal (final-invoice block,
// dunning skip, the stuck-referral reaper, the rancher dashboard's closed
// bucket, earnings export). This module used to map REFUNDED -> 'Closed Lost'
// and had no reverse entry at all, so (a) a machine-routed refund would have
// erased the distinction between "the buyer walked" and "we gave the money
// back", and (b) statusToState('Refunded') returned null, which makes
// applyTransition treat a refunded row as STATELESS and skip the illegal-move
// guard entirely — any move out of a refunded deal was silently allowed.

const checks = [
  [stateToStatus('REFUNDED'), 'Refunded', 'REFUNDED is its own status, not Closed Lost'],
  [statusToState('Refunded'), 'REFUNDED', 'a refunded row is not stateless to the machine'],
  [canTransition('REFUNDED', 'CLOSED_WON'), false, 'a refunded deal is terminal — no silent revive'],
  [canTransition('SLOT_LOCKED', 'REFUNDED'), true, 'refund stays a universal exit'],
  [statusToState('Intro Sent'), 'INTRO_SENT', 'maps Intro Sent'],
  [statusToState('Closed Won'), 'CLOSED_WON', 'maps Closed Won'],
  [statusToState('Slot Locked'), 'SLOT_LOCKED', 'maps Slot Locked'],
  [statusToState('Awaiting Payment'), 'DEPOSIT_PENDING', 'maps Awaiting Payment'],
  [stateToStatus('CLOSED_LOST'), 'Closed Lost', 'reverse maps Closed Lost'],
  [stateToStatus('IN_CONVERSATION'), 'Rancher Contacted', 'IN_CONVERSATION -> Rancher Contacted'],
  [timestampFieldFor('SLOT_LOCKED'), 'Rancher Accepted At', 'slot-lock stamps Rancher Accepted At'],
  [DEAL_STATES.includes('DELIVERED'), true, 'enum includes fulfillment states'],
];
let pass = 0;
for (const [got, exp, d] of checks) {
  const ok = got === exp;
  console.log((ok ? '✓' : '✗ FAIL') + ` ${JSON.stringify(got)} (exp ${JSON.stringify(exp)}) ${d}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${checks.length} passed`);
if (pass !== checks.length) process.exit(1);
