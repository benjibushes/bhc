import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Source pins for the deposit-accept-SLA cron (grep-based — App Router route
// files can't be imported under tsx --test; same pattern as the other route
// pins). The eligibility LOGIC is unit-tested in lib/depositSla.test.ts; these
// pin the wiring that logic depends on.
//
// WHAT THESE PROTECT (broker-rail truthfulness, 2026-08-17): the Airtable
// formula selects on {Rancher Accepted At} = '' with no rail filter, and
// NOTHING on the broker rail ever writes that field. The selector now refuses
// broker rows, but it can only do so if the cron hands it the rail signal —
// hence the __rancher enrichment. The 72h operator escalation stays for broker
// on purpose, with copy that names the real question.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(HERE, 'route.ts'), 'utf8');

test('PIN: candidates are enriched with the linked rancher BEFORE selection', () => {
  const enrichIdx = src.indexOf('ref.__rancher =');
  const selectIdx = src.indexOf('selectSlaEligible(candidates');
  assert.ok(enrichIdx > -1, 'the cron must attach __rancher so the selector can read the rail');
  assert.ok(selectIdx > -1);
  assert.ok(enrichIdx < selectIdx, 'enrichment must run before selectSlaEligible');
});

test('PIN: the re-ping loop reuses the enriched rancher (no second fetch)', () => {
  assert.match(src, /const rancher: any = ref\.__rancher;/);
  const pingLoopIdx = src.indexOf('for (const ref of toPing)');
  const afterPing = src.slice(pingLoopIdx, src.indexOf('// ── 72h+'));
  assert.doesNotMatch(
    afterPing,
    /getRecordById\(TABLES\.RANCHERS/,
    'the rancher was already fetched during enrichment',
  );
});

test('PIN: the escalation branches on the broker rail', () => {
  assert.match(src, /isBrokerRailReferral/);
  const escIdx = src.indexOf('// ── 72h+');
  assert.ok(src.indexOf('isBrokerRailReferral(ref)', escIdx) > escIdx, 'branch inside the escalation pass');
});

test('PIN: the BROKER escalation never says "Accept Slot" or claims 3 email pings', () => {
  const escIdx = src.indexOf('// ── 72h+');
  const esc = src.slice(escIdx);
  // The broker branch's own copy is isolated between the ternary arms; pin the
  // strings themselves rather than the structure.
  const brokerCopy = esc.slice(esc.indexOf('isBrokerRailReferral(ref)'));
  const brokerSummaryIdx = brokerCopy.indexOf('confirm the ranch made contact');
  assert.ok(brokerSummaryIdx > -1, 'broker escalation must ask the broker question');
  const brokerDetail = brokerCopy.slice(brokerSummaryIdx, brokerCopy.indexOf('sendOperatorSignal'));
  assert.doesNotMatch(brokerDetail, /Accept Slot/, 'a represented ranch has no dashboard button');
  assert.doesNotMatch(brokerDetail, /3 email pings/, 'the broker rail was never emailed by this cron');
});

test('PIN: the CONNECT escalation copy is unchanged', () => {
  assert.match(src, /still hasn't tapped Accept Slot\. The rancher has had 3 email pings/);
});

test('PIN: both rails share ONE escalation claim key — no re-alert on old rows', () => {
  const escIdx = src.indexOf('// ── 72h+');
  const esc = src.slice(escIdx);
  const claims = esc.match(/deposit-sla-escalation:\$\{refId\}/g) || [];
  assert.equal(claims.length, 2, 'claimOnce key + sendOperatorSignal dedupeKey, no third variant');
});

test('PIN: the buyer delay notice stays inside the Connect-only re-ping loop', () => {
  const buyerIdx = src.indexOf('sendBuyerDepositDelayNotice(');
  const escIdx = src.indexOf('// ── 72h+');
  assert.ok(buyerIdx > -1 && escIdx > -1);
  assert.ok(buyerIdx < escIdx, 'broker rows are filtered out before this send is reachable');
});
