import { applyTransition } from '../transition.ts';

const writes = [];
const events = [];
const fakeDeps = {
  getReferral: async () => ({ id: 'rec1', fields: { Status: 'Awaiting Payment' } }),
  updateReferral: async (id, fields) => { writes.push({ id, fields }); },
  audit: async (row) => { writes.push({ audit: row }); },
  dispatch: async (ev) => { events.push(ev); },
  nowIso: () => '2026-06-19T18:00:00.000Z',
};

const res = await applyTransition('rec1', 'x', { to: 'SLOT_LOCKED', actor: 'rancher:rec9', reason: 'accepted deposit' }, fakeDeps);

const main = writes.find((w) => w.fields);
const checks = [
  [res.ok, true, 'transition ok'],
  [main.fields.Status, 'Slot Locked', 'writes legacy Status'],
  [main.fields['Rancher Accepted At'], '2026-06-19T18:00:00.000Z', 'stamps milestone ts'],
  [events.length, 1, 'emits one event'],
  [events[0].to, 'SLOT_LOCKED', 'event carries target state'],
];
let pass = 0;
for (const [got, exp, d] of checks) {
  const ok = got === exp;
  console.log((ok ? '✓' : '✗ FAIL') + ` ${JSON.stringify(got)} (exp ${JSON.stringify(exp)}) ${d}`);
  if (ok) pass++;
}
// idempotency: target legacy-equals current AND same state -> no write, no event
writes.length = 0; events.length = 0;
const noop = await applyTransition('rec1', 'x', { to: 'DEPOSIT_PENDING', actor: 'system' }, fakeDeps);
const idem = noop.ok === true && noop.noop === true && writes.length === 0 && events.length === 0;
console.log((idem ? '✓' : '✗ FAIL') + ` idempotent no-op when already in target state`);
if (idem) pass++;

// same-state WITH extraFields must STILL write the fields (no event) — the
// CRITICAL fix: a re-affirm carrying Sale Amount/Notes must not be dropped.
writes.length = 0; events.length = 0;
const reaffirm = await applyTransition('rec1', 'x', { to: 'DEPOSIT_PENDING', actor: 'system', extraFields: { 'Sale Amount': 999 } }, fakeDeps);
const wrote = writes.find((w) => w.fields);
const reaffirmOk = reaffirm.ok === true && !!wrote && wrote.fields['Sale Amount'] === 999 && events.length === 0;
console.log((reaffirmOk ? '✓' : '✗ FAIL') + ` same-state re-affirm writes extraFields without re-emitting`);
if (reaffirmOk) pass++;

console.log(`\n${pass}/${checks.length + 2} passed`);
if (pass !== checks.length + 2) process.exit(1);
