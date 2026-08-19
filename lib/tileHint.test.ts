// lib/tileHint.test.ts
//
// A 14-second Airtable timeout rendered as "enable Resend open/click tracking
// to populate" on every /admin load. The read was broken; the settings were
// fine. Whoever debugged that would have gone to Resend and found nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hintFor, READ_FAILED_HINT } from './tileHint';

const CONFIG_HINT = 'enable Resend open/click tracking to populate';

test('a failed read never borrows the configuration hint', () => {
  const hint = hintFor({ unavailable: true, hint: CONFIG_HINT });
  assert.equal(hint, READ_FAILED_HINT);
  assert.notEqual(hint, CONFIG_HINT, 'this exact substitution is the bug');
});

test('the failure copy says it is not a settings problem, in words', () => {
  // The operator acts on this string. If it only says "unavailable" they will
  // still go check the integration first.
  assert.match(READ_FAILED_HINT, /NOT a settings problem/);
  assert.match(READ_FAILED_HINT, /logs/i, 'it must point somewhere actionable');
});

test('a genuinely unconfigured tile still gets its real setup hint', () => {
  assert.equal(hintFor({ hint: CONFIG_HINT }), CONFIG_HINT);
  assert.equal(hintFor({ unavailable: false, hint: CONFIG_HINT }), CONFIG_HINT);
});

test('the two states are never equal — they must reach the operator as different words', () => {
  assert.notEqual(hintFor({ unavailable: true, hint: CONFIG_HINT }), hintFor({ hint: CONFIG_HINT }));
});
