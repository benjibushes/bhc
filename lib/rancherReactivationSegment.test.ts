// lib/rancherReactivationSegment — agreement-signed carve-out pins
// (doors wave 2026-08-18).
//
// WHAT THESE PROTECT: "signed → Ben sends personally" used to be a FROZEN
// 3-record-id list inside EXCLUDE_RANCHER_IDS. Any ranch that signed AFTER
// the list was written would get auto-blasted a cold "come back" email
// mid-close the moment the (currently paused) rail unpauses — the machine
// telling a closing rancher it doesn't know the deal exists. The carve-out is
// now a FIELD predicate: any rancher with a signed agreement (the
// `Agreement Signed` checkbox or a non-blank `Agreement Signed At` stamp —
// both field names verified against lib/goLiveGates, lib/rancherEligibility,
// lib/rancherLookup, and the sign-agreement/activate writers) is excluded
// from every bucket. The explicit id list stays as the belt for rows whose
// stamp never got written.
//
// Mutation pin: reverting the segmenter to frozen-list-only makes the
// "signed-after-the-list" tests here fail — that is the point.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segmentRanchers, EXCLUDE_RANCHER_IDS } from './rancherReactivationSegment';

const NOW = new Date('2026-08-18T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

/** A Tier-A-shaped legacy rancher (warm: got partway through onboarding). */
function tierARancher(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'recSIGNEDAFTER001',
    'Ranch Name': 'Signed After The List Ranch',
    'Operator Name': 'Casey Tester',
    Email: 'signed-after@example.com',
    State: 'MT',
    'Pricing Model': 'legacy',
    'Onboarding Status': 'Docs Sent',
    ...over,
  };
}

function allBucketIds(seg: ReturnType<typeof segmentRanchers>): string[] {
  return [
    ...seg.tierAToSend.map((r) => r.id),
    ...seg.tierBToSend.map((r) => r.id),
    ...seg.reminders.map((r) => r.id),
    ...seg.toMarkDormant.map((r) => r.id),
  ];
}

test('control: an unsigned Tier A rancher is eligible for a first send', () => {
  const seg = segmentRanchers([tierARancher()], NOW);
  assert.equal(seg.tierAToSend.length, 1);
  assert.equal(seg.tierAToSend[0].id, 'recSIGNEDAFTER001');
  assert.equal(seg.counts.agreementSigned, 0);
});

test('PIN: a rancher who signed AFTER the frozen list was written is skipped (Agreement Signed At)', () => {
  const r = tierARancher({ 'Agreement Signed At': daysAgo(2) });
  // Premise of the whole test: this id is NOT on the hardcoded list — only
  // the field predicate can save them from the blast.
  assert.equal(EXCLUDE_RANCHER_IDS.has(String(r.id)), false);
  const seg = segmentRanchers([r], NOW);
  assert.deepEqual(allBucketIds(seg), []);
  assert.equal(seg.counts.agreementSigned, 1);
});

test('PIN: the Agreement Signed checkbox alone (no At stamp — offline signature) also skips', () => {
  const r = tierARancher({ 'Agreement Signed': true });
  assert.equal(EXCLUDE_RANCHER_IDS.has(String(r.id)), false);
  const seg = segmentRanchers([r], NOW);
  assert.deepEqual(allBucketIds(seg), []);
  assert.equal(seg.counts.agreementSigned, 1);
});

test('PIN: a signed Tier-B-shaped row (blank onboarding, pure field drift) is skipped too', () => {
  const r = tierARancher({ 'Onboarding Status': '', 'Agreement Signed': true });
  const seg = segmentRanchers([r], NOW);
  assert.deepEqual(allBucketIds(seg), []);
  assert.equal(seg.counts.agreementSigned, 1);
});

test('PIN: a signed rancher is never handed a +5d reminder', () => {
  const r = tierARancher({
    'Agreement Signed At': daysAgo(3),
    'Campaign Touch Count': 1,
    'Last Campaign Email Sent At': daysAgo(6),
  });
  const seg = segmentRanchers([r], NOW);
  assert.deepEqual(seg.reminders, []);
  assert.deepEqual(allBucketIds(seg), []);
});

test('PIN: a signed rancher is never marked dormant by the machine', () => {
  const r = tierARancher({
    'Agreement Signed At': daysAgo(12),
    'Campaign Touch Count': 2,
    'Last Campaign Email Sent At': daysAgo(11),
  });
  const seg = segmentRanchers([r], NOW);
  assert.deepEqual(seg.toMarkDormant, []);
  assert.deepEqual(allBucketIds(seg), []);
});

test('belt: a listed rec-id with NO stamp on the row is still excluded (id list survives)', () => {
  // Cheyenne Ridge is one of the three agreement-signed ids the frozen list
  // carried. If its Airtable row ever loses (or never got) the stamp, the id
  // list is the belt that still keeps Ben's personal close protected.
  const r = tierARancher({ id: 'rec9SDcDugHTLsGLQ' });
  assert.equal(EXCLUDE_RANCHER_IDS.has('rec9SDcDugHTLsGLQ'), true);
  const seg = segmentRanchers([r], NOW);
  assert.deepEqual(allBucketIds(seg), []);
  assert.equal(seg.counts.excludedById, 1);
});
