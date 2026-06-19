import { canTransition } from '../transitions.ts';

const checks = [
  [canTransition('INTRO_SENT', 'IN_CONVERSATION'), true, 'intro -> conversation ok'],
  [canTransition('DEPOSIT_PAID', 'SLOT_LOCKED'), true, 'paid -> locked ok'],
  [canTransition('CLOSED_WON', 'INTRO_SENT'), false, 'no resurrection from won'],
  [canTransition('SLOT_LOCKED', 'DEPOSIT_PENDING'), false, 'no backward to pending'],
  [canTransition('INTRO_SENT', 'CLOSED_LOST'), true, 'any active -> lost ok'],
  [canTransition('INTRO_SENT', 'CLOSED_WON'), true, 'off-platform fast-close allowed'],
];
let pass = 0;
for (const [got, exp, d] of checks) {
  const ok = got === exp;
  console.log((ok ? '✓' : '✗ FAIL') + ` ${got} (exp ${exp}) ${d}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${checks.length} passed`);
if (pass !== checks.length) process.exit(1);
