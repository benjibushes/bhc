import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectLooksLiveButBlocked, looksLiveDedupeKey } from './connectLooksLive';

// A faithful snapshot of the 12 ranchers holding a Stripe Connect account,
// read live from Airtable + Stripe on 2026-07-24. This test is the regression
// fence: exactly three of them look live and receive nothing.
const LIVE_SNAPSHOT = [
  { id: 'r1',  'Ranch Name': 'Champion Valley Farm', 'State': 'CO', 'Stripe Connect Status': 'active',     'Active Status': 'Active', 'Page Live': true,  'Pricing Model': 'tier_v2', 'Stripe Connect Account Id': 'acct_1' },
  { id: 'r2',  'Ranch Name': 'Gift Farms LLC',       'State': 'OK', 'Stripe Connect Status': 'onboarding', 'Active Status': 'Active', 'Page Live': true,  'Pricing Model': 'legacy',  'Stripe Connect Account Id': 'acct_2' },
  { id: 'r3',  'Ranch Name': '5 Bar Beef',           'State': 'CA', 'Stripe Connect Status': 'onboarding', 'Active Status': 'Active', 'Page Live': true,  'Pricing Model': 'tier_v2', 'Stripe Connect Account Id': 'acct_3' },
  { id: 'r4',  'Ranch Name': 'Ashcraft Beef',        'State': 'MO', 'Stripe Connect Status': 'onboarding', 'Active Status': 'Paused', 'Page Live': true,  'Pricing Model': 'legacy',  'Stripe Connect Account Id': 'acct_4' },
  { id: 'r5',  'Ranch Name': '2M Cattle Co.',        'State': 'TN', 'Stripe Connect Status': 'onboarding', 'Active Status': 'Active', 'Page Live': true,  'Pricing Model': 'tier_v2', 'Stripe Connect Account Id': 'acct_5' },
  { id: 'r6',  'Ranch Name': 'Lazy Bar 3 BEEF',      'State': 'TX', 'Stripe Connect Status': 'active',     'Active Status': 'Active', 'Page Live': true,  'Pricing Model': 'tier_v2', 'Stripe Connect Account Id': 'acct_6' },
  { id: 'r7',  'Ranch Name': 'Foodstead',            'State': 'OK', 'Stripe Connect Status': 'active',     'Active Status': 'Active', 'Page Live': true,  'Pricing Model': 'tier_v2', 'Stripe Connect Account Id': 'acct_7' },
  { id: 'r8',  'Ranch Name': 'Rep Provisions',       'State': 'OK', 'Stripe Connect Status': 'onboarding', 'Active Status': '',       'Page Live': false, 'Pricing Model': 'tier_v2', 'Stripe Connect Account Id': 'acct_8' },
  { id: 'r9',  'Ranch Name': 'Rocky Ridge Livestock','State': 'ME', 'Stripe Connect Status': 'onboarding', 'Active Status': 'Active', 'Page Live': true,  'Pricing Model': 'tier_v2', 'Stripe Connect Account Id': 'acct_9' },
  { id: 'r10', 'Ranch Name': 'Renick Valley Meats',  'State': 'MO', 'Stripe Connect Status': 'active',     'Active Status': 'Active', 'Page Live': true,  'Pricing Model': 'tier_v2', 'Stripe Connect Account Id': 'acct_10' },
  { id: 'r11', 'Ranch Name': 'DD Ranch',             'State': 'TX', 'Stripe Connect Status': 'active',     'Active Status': 'Active', 'Page Live': true,  'Pricing Model': 'tier_v2', 'Stripe Connect Account Id': 'acct_11' },
  { id: 'r12', 'Ranch Name': 'Silverline Cattle Co', 'State': 'MO', 'Stripe Connect Status': 'active',     'Active Status': 'Active', 'Page Live': true,  'Pricing Model': 'tier_v2', 'Stripe Connect Account Id': 'acct_12' },
];

test('finds exactly the three ranchers who look live and receive nothing', () => {
  const found = selectLooksLiveButBlocked(LIVE_SNAPSHOT);
  assert.deepEqual(
    found.map((f) => f.name).sort(),
    ['2M Cattle Co.', '5 Bar Beef', 'Rocky Ridge Livestock'],
  );
});

test('reports the state and the single missing step per rancher', () => {
  const fiveBar = selectLooksLiveButBlocked(LIVE_SNAPSHOT).find((f) => f.name === '5 Bar Beef')!;
  assert.equal(fiveBar.state, 'CA');
  assert.equal(fiveBar.connectStatus, 'onboarding');
  assert.equal(fiveBar.hasAccount, true);
  assert.match(fiveBar.missingStep, /never finished/i);
});

test('legacy ranchers are NEVER flagged — Connect does not gate them', () => {
  // Gift Farms is off Connect by design and takes money via invoices.
  const found = selectLooksLiveButBlocked(LIVE_SNAPSHOT);
  assert.equal(found.some((f) => f.name === 'Gift Farms LLC'), false);
  assert.equal(found.some((f) => f.name === 'Ashcraft Beef'), false);
});

test('a paused rancher is not flagged — ops already took them out of routing', () => {
  const rows = [{ ...LIVE_SNAPSHOT[2], 'Active Status': 'Paused' }];
  assert.deepEqual(selectLooksLiveButBlocked(rows), []);
});

test('a rancher whose page is not live is not flagged — they are not claiming to be live', () => {
  const rows = [{ ...LIVE_SNAPSHOT[2], 'Page Live': false }];
  assert.deepEqual(selectLooksLiveButBlocked(rows), []);
});

test('an active-Connect rancher is never flagged, whatever the casing', () => {
  for (const s of ['active', 'Active', 'ACTIVE']) {
    const rows = [{ ...LIVE_SNAPSHOT[2], 'Stripe Connect Status': s }];
    assert.deepEqual(selectLooksLiveButBlocked(rows), [], s);
  }
});

test('removed/closed accounts are excluded', () => {
  const rows = [{ ...LIVE_SNAPSHOT[2], 'Verification Status': 'Removed' }];
  assert.deepEqual(selectLooksLiveButBlocked(rows), []);
});

test('a tier_v2 rancher who never started Connect at all is flagged, with the right step', () => {
  const rows = [{ ...LIVE_SNAPSHOT[2], 'Stripe Connect Account Id': '', 'Stripe Connect Status': '' }];
  const found = selectLooksLiveButBlocked(rows);
  assert.equal(found.length, 1);
  assert.equal(found[0].hasAccount, false);
  assert.equal(found[0].connectStatus, '(none)');
  assert.match(found[0].missingStep, /never started/i);
});

test('a restricted rancher gets the restricted wording', () => {
  const rows = [{ ...LIVE_SNAPSHOT[2], 'Stripe Connect Status': 'restricted' }];
  assert.match(selectLooksLiveButBlocked(rows)[0].missingStep, /RESTRICTED/);
});

test('Airtable {name} single-select objects are handled', () => {
  const rows = [{
    ...LIVE_SNAPSHOT[2],
    'Active Status': { name: 'Active' },
    'Pricing Model': { name: 'tier_v2' },
    'Stripe Connect Status': { name: 'onboarding' },
    'State': { name: 'CA' },
  }];
  const found = selectLooksLiveButBlocked(rows);
  assert.equal(found.length, 1);
  assert.equal(found[0].state, 'CA');
});

test('malformed input never throws', () => {
  for (const bad of [undefined, null, {}, 'nope', 42, [null], [undefined], ['x'], [{}]]) {
    assert.doesNotThrow(() => selectLooksLiveButBlocked(bad as any), JSON.stringify(bad));
  }
  assert.deepEqual(selectLooksLiveButBlocked([{}]), []);
});

test('dedupe key is per-rancher and status-independent', () => {
  assert.equal(looksLiveDedupeKey('rec123'), 'connect-looks-live:rec123');
  assert.notEqual(looksLiveDedupeKey('recA'), looksLiveDedupeKey('recB'));
});
