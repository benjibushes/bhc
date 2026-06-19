import { DEAL_STATES, statusToState, stateToStatus, timestampFieldFor } from '../states.ts';

const checks = [
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
