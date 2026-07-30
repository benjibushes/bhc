// lib/fulfillmentChase.test.ts
//
// E3/B15 (2026-07-01): pure selector tests for the fulfillment-chase cron.
// Run: JWT_SECRET=test-secret-ci npx tsx --test lib/fulfillmentChase.test.ts
//
// The selector decides which deposit-paid, rancher-accepted referrals get
// chased, and with which ask:
//   'confirm'  — due date (Handoff > Processing > accept+14d) passed with no
//                fulfillment confirmation. Tiers: T+2d gentle nudge, T+5d
//                second nudge + loud operator signal, T+8d operator only.
//   'invoice'  — accepted ≥7d, final invoice never sent, money unconfirmed
//                (Wave 2, max 2 touches via the shared Count ladder).
//   'schedule' — accepted ≥3d with NO Handoff/Processing Date (Wave 2, fires
//                once ever, Count 0 only).
// Guards: 48h cooldown between sends (all kinds), 3 lifetime chases, one send
// per confirm tier (Fulfillment Chase Count doubles as "highest tier already
// sent"), at most ONE candidate per referral per run (confirm > invoice >
// schedule).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectFulfillmentChase, DEFAULT_FALLBACK_DAYS } from './fulfillmentChase';

// Frozen "now" for every test.
const NOW = '2026-07-01T12:00:00.000Z';

// A referral that is deposit-paid + accepted + unconfirmed, processing date
// 2.5 days in the past → confirm tier 1 by default. 'Final Invoice Sent At'
// is set in the base so the Wave-2 invoice kind stays quiet in the
// confirm-focused tests (the Processing Date keeps the schedule kind quiet).
// Override per test.
function ref(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    id: 'recBase',
    'Deposit Paid At': '2026-06-01T10:00:00.000Z',
    'Rancher Accepted At': '2026-06-02T10:00:00.000Z',
    'Processing Date': '2026-06-29', // UTC midnight → 2.5d before NOW → tier 1
    'Final Invoice Sent At': '2026-06-10T10:00:00.000Z',
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

test('processing date 2+ days past, unconfirmed → confirm tier 1', () => {
  const out = select([ref()]);
  assert.equal(out.length, 1);
  assert.equal(out[0].referralId, 'recBase');
  assert.equal(out[0].kind, 'confirm');
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

// ── Wave 2: Handoff Date is the preferred due-date source ────────────────────

test('Handoff Date beats Processing Date as the due date', () => {
  // Processing 8.5d past (tier 3 on its own) but handoff only 1.5d past →
  // nothing due yet.
  const out = select([ref({ 'Processing Date': '2026-06-23', 'Handoff Date': '2026-06-30' })]);
  assert.equal(out.length, 0);
});

test('Handoff Date past due chases even when Processing Date is future', () => {
  const out = select([ref({ 'Processing Date': '2026-07-20', 'Handoff Date': '2026-06-26' })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'confirm');
  assert.equal(out[0].tier, 2); // 5.5d past handoff
});

test('garbage Handoff Date → treated as missing (Processing Date applies)', () => {
  const out = select([ref({ 'Handoff Date': 'sometime soon' })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].tier, 1);
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

// ── Fallback due date (no dates at all) ─────────────────────────────────────

test('default fallback is 14 days (Wave 2 — was 30)', () => {
  assert.equal(DEFAULT_FALLBACK_DAYS, 14);
});

test('no dates → falls back to accept date + fallbackDays for the confirm kind', () => {
  // Accepted 2026-05-25 + 30d fallback → due 2026-06-24 → 7.5d past → tier 2.
  // (Schedule kind is also technically eligible — no dates, count 0 — but the
  // overdue confirm ask outranks it: one candidate per referral.)
  const out = select(
    [ref({ 'Processing Date': '', 'Rancher Accepted At': '2026-05-25T00:00:00.000Z' })],
    30,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'confirm');
  assert.equal(out[0].tier, 2);
});

test('no dates + recent accept → confirm not due; schedule kind fires instead', () => {
  // Accepted 06-15 (16d before NOW) + 30d fallback → confirm due in the
  // future. Wave 2: the deal no longer sits silent — the "pick a date" ask
  // fires (accepted ≥3d, no dates, never chased).
  const out = select(
    [ref({ 'Processing Date': '', 'Rancher Accepted At': '2026-06-15T00:00:00.000Z' })],
    30,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'schedule');
});

test('garbage Processing Date → treated as missing (fallback applies)', () => {
  const out = select(
    [ref({ 'Processing Date': 'not-a-date', 'Rancher Accepted At': '2026-05-25T00:00:00.000Z' })],
    30,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'confirm');
});

test('garbage accept date + no Processing Date → excluded (no clock derivable)', () => {
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

test('count 3 → lifetime cap, never chased again (any kind)', () => {
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

// ── Wave 2: 'schedule' kind (pick a date) ────────────────────────────────────

// Base for schedule tests: no dates, no invoice concerns (invoice sent in the
// base fixture), accepted 3.1d before NOW.
function schedRef(overrides: Record<string, any> = {}): Record<string, any> {
  return ref({
    'Processing Date': '',
    'Rancher Accepted At': '2026-06-28T09:00:00.000Z', // 3.1d before NOW
    ...overrides,
  });
}

test('schedule: accepted ≥3d with no dates → "pick a date" candidate', () => {
  const out = select([schedRef()]);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'schedule');
});

test('schedule: accepted only 2d → not yet', () => {
  assert.equal(select([schedRef({ 'Rancher Accepted At': '2026-06-29T13:00:00.000Z' })]).length, 0);
});

test('schedule: fires once ever (Count 0 only)', () => {
  const out = select([
    schedRef({
      'Fulfillment Chase Count': 1,
      'Fulfillment Chase Last Sent At': '2026-06-20T00:00:00.000Z', // cooldown clear
    }),
  ]);
  assert.equal(out.length, 0);
});

test('schedule: a Processing Date suppresses it', () => {
  assert.equal(select([schedRef({ 'Processing Date': '2026-07-20' })]).length, 0);
});

test('schedule: a Handoff Date suppresses it', () => {
  assert.equal(select([schedRef({ 'Handoff Date': '2026-07-20' })]).length, 0);
});

test('schedule: rancher-added CRM leads excluded (#511)', () => {
  assert.equal(select([schedRef({ 'Referral Source': 'rancher-added' })]).length, 0);
});

test('schedule: rancher-added exclusion tolerates the {name} object shape', () => {
  assert.equal(select([schedRef({ 'Referral Source': { name: 'rancher-added' } })]).length, 0);
});

test('schedule: already-confirmed deal is not asked to pick a date', () => {
  assert.equal(
    select([schedRef({ 'Fulfillment Confirmed At': '2026-06-30T00:00:00.000Z' })]).length,
    0,
  );
});

// ── Wave 2: 'invoice' kind (send the final invoice) ──────────────────────────

// Base for invoice tests: accepted 8d before NOW, no invoice, dated (so the
// schedule kind stays quiet and the confirm kind is not yet due).
function invRef(overrides: Record<string, any> = {}): Record<string, any> {
  return ref({
    'Final Invoice Sent At': '',
    'Processing Date': '2026-07-15', // future — confirm not due
    'Rancher Accepted At': '2026-06-23T09:00:00.000Z', // 8.1d before NOW
    ...overrides,
  });
}

test('invoice: accepted ≥7d with no final invoice → candidate', () => {
  const out = select([invRef()]);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'invoice');
});

test('invoice: accepted only 6d → not yet', () => {
  assert.equal(select([invRef({ 'Rancher Accepted At': '2026-06-25T13:00:00.000Z' })]).length, 0);
});

test('invoice: Final Invoice Sent At suppresses it', () => {
  assert.equal(select([invRef({ 'Final Invoice Sent At': '2026-06-25T00:00:00.000Z' })]).length, 0);
});

test('invoice: Final Paid At suppresses it (money already landed)', () => {
  assert.equal(select([invRef({ 'Final Paid At': '2026-06-25T00:00:00.000Z' })]).length, 0);
});

test('invoice: Payment Confirmed At suppresses it (off-platform close)', () => {
  assert.equal(select([invRef({ 'Payment Confirmed At': '2026-06-25T00:00:00.000Z' })]).length, 0);
});

test('invoice: Closed Won rows are left to the collect-balance UI', () => {
  assert.equal(select([invRef({ Status: 'Closed Won' })]).length, 0);
});

test('invoice: rancher-added CRM leads excluded (#511)', () => {
  assert.equal(select([invRef({ 'Referral Source': 'rancher-added' })]).length, 0);
});

test('invoice: capped at 2 touches (Count ladder)', () => {
  const cooled = { 'Fulfillment Chase Last Sent At': '2026-06-20T00:00:00.000Z' };
  const at1 = select([invRef({ 'Fulfillment Chase Count': 1, ...cooled })]);
  assert.equal(at1.length, 1);
  assert.equal(at1[0].kind, 'invoice');
  const at2 = select([invRef({ 'Fulfillment Chase Count': 2, ...cooled })]);
  assert.equal(at2.length, 0);
});

test('invoice outranks schedule when both are eligible', () => {
  // No dates AND no invoice at accepted 8d: one candidate, the money ask.
  const out = select([invRef({ 'Processing Date': '' })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'invoice');
});

test('confirm outranks invoice when both are eligible', () => {
  // Overdue processing date AND no invoice: the confirm ask wins.
  const out = select([invRef({ 'Processing Date': '2026-06-26' })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'confirm');
});

test('rancher-added leads STILL get confirm chases (only the new kinds exclude them)', () => {
  const out = select([ref({ 'Referral Source': 'rancher-added' })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'confirm');
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

test('kind priority: confirm before invoice before schedule', () => {
  const out = select([
    schedRef({ id: 'recSched' }),
    invRef({ id: 'recInv' }),
    ref({ id: 'recConfirm' }),
  ]);
  assert.deepEqual(
    out.map((c) => c.kind),
    ['confirm', 'invoice', 'schedule'],
  );
});
