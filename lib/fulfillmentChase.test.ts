// lib/fulfillmentChase.test.ts
//
// E3/B15 (2026-07-01): pure selector tests for the fulfillment-chase cron.
// Run: JWT_SECRET=test-secret-ci npx tsx --test lib/fulfillmentChase.test.ts
//
// The selector decides which deposit-paid, rancher-accepted referrals whose
// Processing Date has passed with no fulfillment confirmation get chased,
// and at which escalation tier:
//   T+2d past due → tier 1 (gentle rancher nudge)
//   T+5d          → tier 2 (second nudge + loud operator signal)
//   T+8d          → tier 3 (operator signal only — human takes over)
// Guards: 48h cooldown between sends, 3 lifetime chases, one send per tier
// (Fulfillment Chase Count doubles as "highest tier already sent").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectFulfillmentChase } from './fulfillmentChase';

// Frozen "now" for every test.
const NOW = '2026-07-01T12:00:00.000Z';

// A referral that is deposit-paid + accepted + unconfirmed, processing date
// 2.5 days in the past → tier 1 by default. Override per test.
function ref(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    id: 'recBase',
    'Deposit Paid At': '2026-06-01T10:00:00.000Z',
    'Rancher Accepted At': '2026-06-02T10:00:00.000Z',
    'Processing Date': '2026-06-29', // UTC midnight → 2.5d before NOW → tier 1
    ...overrides,
  };
}

function select(refs: Record<string, any>[], fallbackDays?: number) {
  return selectFulfillmentChase(refs, { nowISO: NOW, fallbackDays });
}

// ── Baseline eligibility ─────────────────────────────────────────────────────

test('empty input → empty output', () => {
  assert.deepEqual(select([]), []);
});

test('processing date 2+ days past, unconfirmed → tier 1', () => {
  const out = select([ref()]);
  assert.equal(out.length, 1);
  assert.equal(out[0].referralId, 'recBase');
  assert.equal(out[0].tier, 1);
});

test('processing date only 1 day past → not chased yet', () => {
  const out = select([ref({ 'Processing Date': '2026-06-30' })]); // 1.5d → floor 1
  assert.equal(out.length, 0);
});

test('processing date in the future → not chased', () => {
  assert.equal(select([ref({ 'Processing Date': '2026-07-10' })]).length, 0);
});

// ── Tier thresholds ──────────────────────────────────────────────────────────

test('5 days past due → tier 2', () => {
  const out = select([ref({ 'Processing Date': '2026-06-26' })]); // 5.5d → 5
  assert.equal(out.length, 1);
  assert.equal(out[0].tier, 2);
});

test('7 days past due → still tier 2', () => {
  const out = select([ref({ 'Processing Date': '2026-06-24' })]); // 7.5d → 7
  assert.equal(out.length, 1);
  assert.equal(out[0].tier, 2);
});

test('8 days past due → tier 3', () => {
  const out = select([ref({ 'Processing Date': '2026-06-23' })]); // 8.5d → 8
  assert.equal(out.length, 1);
  assert.equal(out[0].tier, 3);
});

// ── Exclusions: already confirmed / dead deals ───────────────────────────────

test('Fulfillment Confirmed At set (legacy binary confirm) → excluded', () => {
  assert.equal(
    select([ref({ 'Fulfillment Confirmed At': '2026-06-29T10:00:00.000Z' })]).length,
    0,
  );
});

test('Fulfillment Status = fulfilled (tracker) → excluded', () => {
  assert.equal(select([ref({ 'Fulfillment Status': 'fulfilled' })]).length, 0);
});

test('Fulfillment Status mid-lifecycle (ready) is still chased', () => {
  // "ready" is not "fulfilled" — the buyer still has no confirmation the beef
  // landed. The nudge copy is exactly the "one tap confirms" ask.
  assert.equal(select([ref({ 'Fulfillment Status': 'ready' })]).length, 1);
});

test('Status = Closed Lost → excluded', () => {
  assert.equal(select([ref({ Status: 'Closed Lost' })]).length, 0);
});

test('Status = Refunded → excluded (belt-and-braces)', () => {
  assert.equal(select([ref({ Status: 'Refunded' })]).length, 0);
});

test('no Deposit Paid At → excluded', () => {
  assert.equal(select([ref({ 'Deposit Paid At': '' })]).length, 0);
});

test('no Rancher Accepted At → excluded', () => {
  assert.equal(select([ref({ 'Rancher Accepted At': '' })]).length, 0);
});

// ── Fallback due date (no Processing Date) ──────────────────────────────────

test('no Processing Date → falls back to accept date + fallbackDays', () => {
  // Accepted 2026-05-25 + 30d fallback → due 2026-06-24 → 7.5d past → tier 2.
  const out = select(
    [ref({ 'Processing Date': '', 'Rancher Accepted At': '2026-05-25T00:00:00.000Z' })],
    30,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].tier, 2);
});

test('no Processing Date + recent accept → fallback due date in future, not chased', () => {
  const out = select(
    [ref({ 'Processing Date': '', 'Rancher Accepted At': '2026-06-15T00:00:00.000Z' })],
    30,
  );
  assert.equal(out.length, 0);
});

test('garbage Processing Date → treated as missing (fallback applies)', () => {
  const out = select(
    [ref({ 'Processing Date': 'not-a-date', 'Rancher Accepted At': '2026-05-25T00:00:00.000Z' })],
    30,
  );
  assert.equal(out.length, 1);
});

test('garbage accept date + no Processing Date → excluded (no due date derivable)', () => {
  const out = select(
    [ref({ 'Processing Date': '', 'Rancher Accepted At': 'yesterday-ish' })],
    30,
  );
  assert.equal(out.length, 0);
});

// ── Cooldown (no re-send within 48h) ─────────────────────────────────────────

test('chased 23h ago → cooldown blocks even when a higher tier is due', () => {
  const out = select([
    ref({
      'Processing Date': '2026-06-26', // tier 2 window
      'Fulfillment Chase Count': 1,
      'Fulfillment Chase Last Sent At': '2026-06-30T13:00:00.000Z', // 23h ago
    }),
  ]);
  assert.equal(out.length, 0);
});

test('chased 49h ago + higher tier due → eligible again', () => {
  const out = select([
    ref({
      'Processing Date': '2026-06-26', // tier 2 window
      'Fulfillment Chase Count': 1,
      'Fulfillment Chase Last Sent At': '2026-06-29T11:00:00.000Z', // 49h ago
    }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].tier, 2);
});

// ── One send per tier + lifetime cap ─────────────────────────────────────────

test('count 1 while still in tier-1 window → no duplicate tier-1 send', () => {
  const out = select([
    ref({
      'Fulfillment Chase Count': 1, // tier 1 already sent
      'Fulfillment Chase Last Sent At': '2026-06-28T00:00:00.000Z', // cooldown long clear
    }),
  ]);
  assert.equal(out.length, 0);
});

test('count 2 while in tier-2 window → no duplicate tier-2 send', () => {
  const out = select([
    ref({
      'Processing Date': '2026-06-26',
      'Fulfillment Chase Count': 2,
      'Fulfillment Chase Last Sent At': '2026-06-25T00:00:00.000Z',
    }),
  ]);
  assert.equal(out.length, 0);
});

test('count 2 + tier-3 window → tier 3 fires', () => {
  const out = select([
    ref({
      'Processing Date': '2026-06-23',
      'Fulfillment Chase Count': 2,
      'Fulfillment Chase Last Sent At': '2026-06-25T00:00:00.000Z',
    }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].tier, 3);
});

test('count 3 → lifetime cap, never chased again', () => {
  const out = select([
    ref({
      'Processing Date': '2026-06-01', // ancient — deep tier 3
      'Fulfillment Chase Count': 3,
      'Fulfillment Chase Last Sent At': '2026-06-10T00:00:00.000Z',
    }),
  ]);
  assert.equal(out.length, 0);
});

test('never chased but discovered deep in tier-3 window → single tier-3 entry (no catch-up spam)', () => {
  const out = select([ref({ 'Processing Date': '2026-06-01' })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].tier, 3);
});

// ── Ordering ─────────────────────────────────────────────────────────────────

test('most overdue first (so a per-run cap hits the worst cases)', () => {
  const out = select([
    ref({ id: 'recMild', 'Processing Date': '2026-06-29' }), // 2d
    ref({ id: 'recWorst', 'Processing Date': '2026-06-01' }), // 30d
    ref({ id: 'recMid', 'Processing Date': '2026-06-26' }), // 5d
  ]);
  assert.deepEqual(
    out.map((c) => c.referralId),
    ['recWorst', 'recMid', 'recMild'],
  );
});
