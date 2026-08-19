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
import {
  selectFulfillmentChase,
  selectExhaustedChases,
  exhaustionClaimTtlSec,
  DEFAULT_FALLBACK_DAYS,
  MAX_LIFETIME_CHASES,
  EXHAUSTION_GRACE_DAYS,
  FULFILLMENT_ESCALATED_AT_FIELD,
  FULFILLMENT_RE_ESCALATE_COOLDOWN_DAYS,
  isFulfillmentTerminal,
  FULFILLMENT_TRACKING_EPOCH_MS,
  FULFILLMENT_TRACKING_EPOCH_ISO,
  CHASE_FIELDS,
  MAX_ESCALATIONS_PER_RUN,
  MAX_EXHAUSTION_SCAN_PER_RUN,
} from './fulfillmentChase';

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

// ═══════════════════════════════════════════════════════════════════════════
// F12 (2026-08-18): BROKER-rail fulfillment chase — 'broker-pickup' kind.
//
// The route's old formula required {Rancher Accepted At}, which is empty
// FOREVER on a broker row (lib/depositSla.ts:14 — a represented ranch has no
// dashboard, no login, no Accept button). After the one 72h deposit-accept
// escalation, nobody ever verified a broker buyer got their beef.
//
// Cohort: broker marker (Match Type 'Broker — Deposit', stamped at referral
// CREATION — lib/brokerReferral) + Deposit Paid At + fulfillment-sheet
// DELIVERED. The delivery stamp is 'Intro Sent At': deliverBrokerRancherSheet
// (lib/brokerSettlement.ts:410) writes it ONLY on a real delivery, with the
// SAME nowIso that stamps 'Deposit Paid At' — so delivered ⇒
// Intro Sent At ≥ Deposit Paid At. A matching-created broker row carries a
// PRE-deposit Intro Sent At from routing; if the sheet send then failed, the
// stamp stays OLDER than Deposit Paid At and the row is excluded (the
// undelivered-sheet operator alert owns that case — never ask a buyer about a
// pickup the ranch was never told to arrange).
//
// Cadence mirrors the Connect confirm lane exactly: due = Handoff Date >
// Processing Date > delivery + fallbackDays; tiers T+2/5/8; shared stamps,
// 48h cooldown, 3 lifetime, tier > Count ladder. The CHASE is aimed at the
// BUYER ("did pickup happen?") — the ranch is off-platform, so the buyer is
// the only party who can confirm.
// ═══════════════════════════════════════════════════════════════════════════

import { buildBrokerPickupEmail } from './fulfillmentChase';

// Delivered-sheet broker row: Intro Sent At === Deposit Paid At (the settle
// path uses one nowIso for both), due = delivery + 14d, 2d past → tier 1.
function brokerRef(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    id: 'recBroker',
    'Match Type': 'Broker — Deposit',
    'Status': 'Awaiting Payment',
    'Deposit Paid At': '2026-06-15T10:00:00.000Z',
    'Intro Sent At': '2026-06-15T10:00:00.000Z',
    ...overrides,
  };
}

// ── Broker cohort gate ───────────────────────────────────────────────────────

test('broker: delivered sheet + deposit paid, 2d past the 14d window → broker-pickup tier 1', () => {
  const out = select([brokerRef()]);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'broker-pickup');
  assert.equal(out[0].tier, 1);
  assert.equal(out[0].referralId, 'recBroker');
});

test('broker: marker tolerates the Airtable {name} singleSelect object shape', () => {
  const out = select([brokerRef({ 'Match Type': { name: 'Broker — Deposit' } })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'broker-pickup');
});

test('broker: sheet never delivered (no Intro Sent At) → excluded', () => {
  // Undelivered sheet = the ranch was never told the order exists; the
  // raiseBrokerSheetAlert operator rail owns it. Never ask the buyer about a
  // pickup nobody arranged.
  const out = select([brokerRef({ 'Intro Sent At': undefined })]);
  assert.equal(out.length, 0);
});

test('broker: stale PRE-deposit intro stamp (matched row, sheet send failed) → excluded', () => {
  // Matching stamps Intro Sent At at routing time; a delivered sheet
  // re-stamps it to the settlement nowIso. Older-than-deposit ⇒ not delivered.
  const out = select([brokerRef({ 'Intro Sent At': '2026-06-01T10:00:00.000Z' })]);
  assert.equal(out.length, 0);
});

test('broker: no Deposit Paid At → excluded (deposit chase owns pre-money rows)', () => {
  const out = select([brokerRef({ 'Deposit Paid At': undefined })]);
  assert.equal(out.length, 0);
});

test('broker: fulfillment already confirmed → excluded (both confirm shapes)', () => {
  assert.equal(select([brokerRef({ 'Fulfillment Confirmed At': '2026-06-20T10:00:00.000Z' })]).length, 0);
  assert.equal(select([brokerRef({ 'Fulfillment Status': 'Fulfilled' })]).length, 0);
});

test('broker: closed rows are never chased', () => {
  assert.equal(select([brokerRef({ Status: 'Closed Won' })]).length, 0);
  assert.equal(select([brokerRef({ Status: 'Closed Lost' })]).length, 0);
  assert.equal(select([brokerRef({ Status: 'Refunded' })]).length, 0);
});

test('broker: rancher-added CRM leads excluded (#511 — never email their own customer)', () => {
  const out = select([brokerRef({ 'Referral Source': 'rancher-added' })]);
  assert.equal(out.length, 0);
});

// ── Broker cadence mirrors the Connect confirm lane ──────────────────────────

test('broker: 6d past due → tier 2; 9d past → tier 3', () => {
  const t2 = select([brokerRef({ 'Deposit Paid At': '2026-06-11T10:00:00.000Z', 'Intro Sent At': '2026-06-11T10:00:00.000Z' })]);
  assert.equal(t2[0]?.tier, 2);
  const t3 = select([brokerRef({ 'Deposit Paid At': '2026-06-08T10:00:00.000Z', 'Intro Sent At': '2026-06-08T10:00:00.000Z' })]);
  assert.equal(t3[0]?.tier, 3);
});

test('broker: inside the 14d window → not chased yet', () => {
  const out = select([brokerRef({ 'Deposit Paid At': '2026-06-25T10:00:00.000Z', 'Intro Sent At': '2026-06-25T10:00:00.000Z' })]);
  assert.equal(out.length, 0);
});

test('broker: a Handoff Date wins over the fallback window (due-source mirror)', () => {
  const out = select([
    brokerRef({
      'Deposit Paid At': '2026-06-25T10:00:00.000Z',
      'Intro Sent At': '2026-06-25T10:00:00.000Z',
      'Handoff Date': '2026-06-28', // 3.5d past NOW → tier 1
    }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].tier, 1);
});

test('broker: tier > Count ladder — no duplicate tier-1, escalation fires', () => {
  // Count 1, still in the tier-1 window → quiet.
  const quiet = select([brokerRef({ 'Fulfillment Chase Count': 1 })]);
  assert.equal(quiet.length, 0);
  // Count 1, tier-2 window → tier 2 fires.
  const esc = select([
    brokerRef({
      'Deposit Paid At': '2026-06-11T10:00:00.000Z',
      'Intro Sent At': '2026-06-11T10:00:00.000Z',
      'Fulfillment Chase Count': 1,
    }),
  ]);
  assert.equal(esc.length, 1);
  assert.equal(esc[0].tier, 2);
});

test('broker: 48h cooldown blocks re-sends; lifetime cap of 3 holds', () => {
  const cooled = select([brokerRef({ 'Fulfillment Chase Last Sent At': '2026-06-30T14:00:00.000Z' })]);
  assert.equal(cooled.length, 0);
  const capped = select([
    brokerRef({
      'Deposit Paid At': '2026-06-01T10:00:00.000Z',
      'Intro Sent At': '2026-06-01T10:00:00.000Z',
      'Fulfillment Chase Count': 3,
    }),
  ]);
  assert.equal(capped.length, 0);
});

// ── Rail isolation — the leak guards ─────────────────────────────────────────

test('broker: a broker row NEVER yields a Connect kind, even with Connect-shaped fields', () => {
  // A broker row that somehow carries Rancher Accepted At + no final invoice
  // would, in the Connect lane, produce confirm/invoice asks — emails telling
  // an off-platform ranch to tap buttons that do not exist (the exact class
  // deposit-accept-sla fixed 2026-08-17). It must take the broker branch only.
  const out = select([
    brokerRef({
      'Rancher Accepted At': '2026-06-10T10:00:00.000Z',
      'Deposit Paid At': '2026-06-15T10:00:00.000Z',
      'Intro Sent At': '2026-06-15T10:00:00.000Z',
    }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'broker-pickup');
});

test('broker: an undelivered broker row with Connect-shaped fields stays fully silent', () => {
  const out = select([
    brokerRef({
      'Rancher Accepted At': '2026-06-10T10:00:00.000Z',
      'Intro Sent At': undefined,
    }),
  ]);
  assert.equal(out.length, 0);
});

test('connect: a non-broker row with no Rancher Accepted At stays excluded (formula widening safety)', () => {
  // The route formula no longer requires {Rancher Accepted At}; the JS gate
  // is now the only thing keeping pre-accept Connect rows out of this cron
  // (deposit-accept-sla owns them).
  const out = select([ref({ 'Rancher Accepted At': undefined })]);
  assert.equal(out.length, 0);
});

test('ordering: confirm still outranks broker-pickup; broker-pickup outranks invoice', () => {
  const out = select([
    invRef({ id: 'recInv' }),
    brokerRef({ id: 'recBrokerOrd' }),
    ref({ id: 'recConfirm' }),
  ]);
  assert.deepEqual(
    out.map((c) => c.kind),
    ['confirm', 'broker-pickup', 'invoice'],
  );
});

// ── Buyer copy (pure builder the route sends) ────────────────────────────────

test('broker pickup email: asks about pickup, balance-at-pickup framing, no commission words', () => {
  for (const tier of [1, 2] as const) {
    const { subject, html } = buildBrokerPickupEmail({
      buyerFirstName: 'Sam',
      ranchName: 'Champion Valley',
      cutLabel: 'Half beef',
      tier,
    });
    assert.ok(/pickup|picked up/i.test(html), 'asks whether pickup happened');
    assert.ok(html.includes('Champion Valley'));
    assert.ok(/balance/i.test(html), 'balance-at-pickup world stated');
    for (const s of [subject, html]) {
      assert.ok(!/commission|fee|invoice/i.test(s), 'no commission words in buyer copy');
      assert.ok(!s.includes('$'), 'no amounts — copy never states prices');
    }
    assert.ok(/reply/i.test(html), 'gives the buyer a one-step way to answer');
  }
});

test('broker pickup email: tier 2 reads as a second touch, not a repeat of tier 1', () => {
  const t1 = buildBrokerPickupEmail({ buyerFirstName: 'Sam', ranchName: 'Champion Valley', tier: 1 });
  const t2 = buildBrokerPickupEmail({ buyerFirstName: 'Sam', ranchName: 'Champion Valley', tier: 2 });
  assert.notEqual(t1.html, t2.html);
  assert.notEqual(t1.subject, t2.subject);
});

test('broker pickup email: HTML-escapes Airtable free text', () => {
  const { html } = buildBrokerPickupEmail({
    buyerFirstName: '<script>alert(1)</script>',
    ranchName: 'A & B "Ranch"',
    tier: 1,
  });
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&amp;'));
});

// ── Route wiring pins (source contract — same convention as
//    lib/brokerDownstreamGates.test.ts: route handlers can't be imported
//    under tsx --test) ────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const readSrc = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('PIN fulfillment-chase route: formula no longer requires Rancher Accepted At', () => {
  const src = readSrc('../app/api/cron/fulfillment-chase/route.ts');
  assert.ok(!src.includes(`{Rancher Accepted At} != ''`), 'broker rows (no acceptance, ever) must reach the selector');
  assert.ok(src.includes(`{Deposit Paid At} != ''`), 'still money-gated at the formula');
});

test('PIN fulfillment-chase route: broker-pickup goes to the BUYER, never the rancher nudge', () => {
  const src = readSrc('../app/api/cron/fulfillment-chase/route.ts');
  assert.match(src, /kind === 'broker-pickup'/);
  assert.match(src, /buildBrokerPickupEmail\(/);
  // The Connect rancher-nudge condition must exclude the broker kind — the
  // old `kind !== 'confirm' || tier === 1 || tier === 2` shape would have
  // emailed an off-platform ranch a dashboard CTA.
  assert.match(src, /kind !== 'broker-pickup' && \(kind !== 'confirm' \|\| tier === 1 \|\| tier === 2\)/);
});

// ── P0-3 (2026-08-18): the ladder now EXHAUSTS instead of going silent ───────
//
// THE BUG THESE PIN: MAX_LIFETIME_CHASES was a cliff. Once `Fulfillment Chase
// Count` hit 3 the selector skipped the row for the rest of time — no terminal
// stamp, no escalation, no surface inheriting it — while the buyer's
// non-refundable money sat with delivery unproven. selectExhaustedChases is
// what picks those rows up, and it keeps picking them up on a cooldown.

const DAY_ISO = (d: number) => new Date(Date.parse(NOW) - d * 24 * 60 * 60 * 1000).toISOString();

/** A referral whose ladder is spent: 3 chases, last one 5 days ago. */
function spent(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    id: 'recSpent',
    'Deposit Paid At': DAY_ISO(40),
    'Rancher Accepted At': DAY_ISO(39),
    'Fulfillment Chase Count': MAX_LIFETIME_CHASES,
    'Fulfillment Chase Last Sent At': DAY_ISO(5),
    Status: 'Slot Locked',
    ...overrides,
  };
}

function exhausted(refs: Record<string, any>[], opts: Record<string, any> = {}) {
  return selectExhaustedChases(refs, { nowISO: NOW, ...opts });
}

test('exhaustion: empty input → empty output', () => {
  assert.deepEqual(exhausted([]), []);
});

test('exhaustion: the OLD cliff row is now selected, with its silence measured', () => {
  // Proof of the cliff itself: the chase selector will never look at it again.
  assert.deepEqual(selectFulfillmentChase([spent()], { nowISO: NOW }), []);
  const out = exhausted([spent()]);
  assert.equal(out.length, 1);
  assert.equal(out[0].referralId, 'recSpent');
  assert.equal(out[0].rail, 'connect');
  assert.equal(out[0].daysSinceLastChase, 5);
  assert.equal(out[0].previouslyEscalatedAt, null);
});

test('exhaustion: a ladder with rungs left is NOT exhausted', () => {
  assert.deepEqual(exhausted([spent({ 'Fulfillment Chase Count': MAX_LIFETIME_CHASES - 1 })]), []);
});

test('exhaustion: confirmed / closed / refunded rows are never escalated', () => {
  assert.deepEqual(exhausted([spent({ 'Fulfillment Confirmed At': DAY_ISO(1) })]), []);
  assert.deepEqual(exhausted([spent({ 'Fulfillment Status': 'fulfilled' })]), []);
  assert.deepEqual(exhausted([spent({ Status: 'Closed Won' })]), []);
  assert.deepEqual(exhausted([spent({ Status: 'Closed Lost' })]), []);
  assert.deepEqual(exhausted([spent({ Status: 'Refunded' })]), []);
});

test('exhaustion: a row with no deposit is not an obligation to escalate', () => {
  assert.deepEqual(exhausted([spent({ 'Deposit Paid At': '' })]), []);
});

test('exhaustion: waits out the grace window so it cannot double up on tier 3', () => {
  // The third chase went out today — the tier-3 operator signal just landed.
  assert.deepEqual(exhausted([spent({ 'Fulfillment Chase Last Sent At': DAY_ISO(0) })]), []);
  assert.deepEqual(
    exhausted([spent({ 'Fulfillment Chase Last Sent At': DAY_ISO(EXHAUSTION_GRACE_DAYS - 1) })]),
    [],
  );
  assert.equal(
    exhausted([spent({ 'Fulfillment Chase Last Sent At': DAY_ISO(EXHAUSTION_GRACE_DAYS) })]).length,
    1,
  );
});

test('exhaustion: re-escalates on the SECOND window and not before', () => {
  const justEscalated = spent({
    [FULFILLMENT_ESCALATED_AT_FIELD]: DAY_ISO(FULFILLMENT_RE_ESCALATE_COOLDOWN_DAYS - 1),
  });
  assert.deepEqual(exhausted([justEscalated]), []);

  const windowClosed = spent({
    id: 'recAgain',
    [FULFILLMENT_ESCALATED_AT_FIELD]: DAY_ISO(FULFILLMENT_RE_ESCALATE_COOLDOWN_DAYS),
    'Fulfillment Chase Last Sent At': DAY_ISO(30),
  });
  const out = exhausted([windowClosed]);
  assert.equal(out.length, 1);
  assert.equal(out[0].referralId, 'recAgain');
  assert.ok(out[0].previouslyEscalatedAt);
});

test('exhaustion: the cooldown is configurable', () => {
  const row = spent({ [FULFILLMENT_ESCALATED_AT_FIELD]: DAY_ISO(10) });
  assert.deepEqual(exhausted([row], { reEscalateCooldownDays: 14 }), []);
  assert.equal(exhausted([row], { reEscalateCooldownDays: 7 }).length, 1);
});

test('exhaustion: broker rows carry their own rail so the copy can differ', () => {
  const out = exhausted([spent({ 'Match Type': 'Broker — Deposit', 'Rancher Accepted At': '' })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].rail, 'broker');
});

test('exhaustion: longest silence first, id tiebreak (stable across runs)', () => {
  const out = exhausted([
    spent({ id: 'recB', 'Fulfillment Chase Last Sent At': DAY_ISO(9) }),
    spent({ id: 'recA', 'Fulfillment Chase Last Sent At': DAY_ISO(9) }),
    spent({ id: 'recOldest', 'Fulfillment Chase Last Sent At': DAY_ISO(40) }),
  ]);
  assert.deepEqual(
    out.map((r) => r.referralId),
    ['recOldest', 'recA', 'recB'],
  );
});

test('exhaustion: the claim TTL equals the cooldown (Redis is the stamp until Ben adds the field)', () => {
  assert.equal(
    exhaustionClaimTtlSec(),
    FULFILLMENT_RE_ESCALATE_COOLDOWN_DAYS * 24 * 60 * 60,
  );
  assert.equal(exhaustionClaimTtlSec(3), 3 * 24 * 60 * 60);
});


// ═══════════════════════════════════════════════════════════════════════════
// THE SHARED TERMINAL RULE (review fix B1)
//
// One predicate behind selectFulfillmentChase, selectBrokerPickup,
// selectExhaustedChases and lib/obligations::selectObligations. Before it the
// three lists disagreed about exactly one value — 'Closed Won' — so a Connect
// row got chased three times, hit the cap, and then vanished from both
// terminal surfaces.
// ═══════════════════════════════════════════════════════════════════════════

const EPOCH = FULFILLMENT_TRACKING_EPOCH_MS;
const afterEpoch = (d: number) => new Date(EPOCH + d * 86400000).toISOString();
const beforeEpoch = (d: number) => new Date(EPOCH - d * 86400000).toISOString();

test('terminal: the epoch is pinned to #514, the un-gated tracker', () => {
  // Load-bearing constant — moving it changes which historical deals the
  // operator band claims are outstanding. #514 (commit 6a67aea, 2026-07-29) is
  // the first point at which EVERY rancher had a route that could stamp
  // 'Fulfillment Confirmed At'; before it, "unconfirmed" proves nothing.
  assert.equal(FULFILLMENT_TRACKING_EPOCH_ISO, '2026-07-29T00:00:00.000Z');
  assert.ok(Number.isFinite(FULFILLMENT_TRACKING_EPOCH_MS));
});

test('terminal: hard-dead statuses are terminal on both rails', () => {
  for (const status of ['Closed Lost', 'Refunded', 'Cancelled', 'Canceled', 'Expired']) {
    for (const rail of ['connect', 'broker'] as const) {
      assert.equal(isFulfillmentTerminal({ Status: status }, { rail }), true, `${status}/${rail}`);
    }
  }
});

test('terminal: live statuses are never terminal', () => {
  for (const status of ['Awaiting Payment', 'Slot Locked', 'Negotiation', '']) {
    assert.equal(isFulfillmentTerminal({ Status: status }, { rail: 'connect' }), false, status);
  }
});

test('terminal: CONNECT Closed Won is NOT terminal after the epoch', () => {
  // The whole B1 defect in one assertion. Closed Won here means the buyer paid
  // the balance; lib/fulfillmentConfirm stamps delivery on a separate event.
  assert.equal(
    isFulfillmentTerminal(
      { Status: 'Closed Won', 'Deposit Paid At': afterEpoch(3), 'Closed At': afterEpoch(9) },
      { rail: 'connect' },
    ),
    false,
  );
});

test('terminal: CONNECT Closed Won IS terminal before the epoch', () => {
  assert.equal(
    isFulfillmentTerminal(
      { Status: 'Closed Won', 'Deposit Paid At': beforeEpoch(20), 'Closed At': beforeEpoch(10) },
      { rail: 'connect' },
    ),
    true,
  );
});

test("terminal: 'Closed At' outranks 'Deposit Paid At' for the epoch test", () => {
  // Deposit before, close after → the machine could have recorded delivery.
  assert.equal(
    isFulfillmentTerminal(
      { Status: 'Closed Won', 'Deposit Paid At': beforeEpoch(40), 'Closed At': afterEpoch(1) },
      { rail: 'connect' },
    ),
    false,
  );
  // Deposit after, close missing → falls back to the deposit, still visible.
  assert.equal(
    isFulfillmentTerminal(
      { Status: 'Closed Won', 'Deposit Paid At': afterEpoch(1) },
      { rail: 'connect' },
    ),
    false,
  );
});

test('terminal: BROKER Closed Won is terminal on either side of the epoch', () => {
  // Rail-aware, and correct after PR #650: on broker the confirm and the close
  // are ONE operation, so Closed Won there really does mean delivered.
  for (const when of [afterEpoch(3), beforeEpoch(3)]) {
    assert.equal(
      isFulfillmentTerminal({ Status: 'Closed Won', 'Deposit Paid At': when }, { rail: 'broker' }),
      true,
    );
  }
});

test('terminal: the rail is inferred from the referral row when not given', () => {
  const base = { Status: 'Closed Won', 'Deposit Paid At': afterEpoch(3) };
  assert.equal(isFulfillmentTerminal({ ...base, 'Match Type': 'Broker — Deposit' }), true);
  assert.equal(isFulfillmentTerminal(base), false);
});

test('B1: an exhausted CONNECT Closed Won now reaches the escalation', () => {
  // It used to be dropped here — after the ladder had already spent all three
  // chases on it. That was the permanent silence.
  const nowISO = afterEpoch(60);
  const ref = {
    id: 'recCW',
    'Deposit Paid At': afterEpoch(1),
    'Rancher Accepted At': afterEpoch(2),
    Status: 'Closed Won',
    [CHASE_FIELDS.count]: MAX_LIFETIME_CHASES,
    [CHASE_FIELDS.lastSentAt]: afterEpoch(40),
  };
  assert.deepEqual(
    selectExhaustedChases([ref], { nowISO }).map((r) => r.referralId),
    ['recCW'],
  );
  // Broker's Closed Won still does not — same call, different rail.
  assert.deepEqual(
    selectExhaustedChases([{ ...ref, 'Match Type': 'Broker — Deposit' }], { nowISO }),
    [],
  );
});

test('B1: a pre-epoch Closed Won stops being CHASED too (no orphan)', () => {
  // The other half of the invariant: if the band cannot show a row, no lane may
  // keep chasing it. Otherwise we have just moved the chaseable-but-invisible
  // bug rather than fixed it.
  const ref = {
    id: 'recOld',
    'Deposit Paid At': beforeEpoch(40),
    'Rancher Accepted At': beforeEpoch(39),
    Status: 'Closed Won',
  };
  assert.deepEqual(selectFulfillmentChase([ref], { nowISO: beforeEpoch(1) }), []);
});

test('exhaustion: the scan window is wider than the per-run budget', () => {
  // The starvation fix in one assertion. If a run may only LOOK at as many
  // rows as it may FIRE, then rows whose Redis claim is still held (every
  // already-escalated row, because `Fulfillment Escalated At` is not in the
  // live schema yet so the selector cannot drop them) consume the whole budget
  // and the tail of the list never escalates at all.
  assert.ok(
    MAX_EXHAUSTION_SCAN_PER_RUN > MAX_ESCALATIONS_PER_RUN,
    'scan window must exceed the escalation budget or the tail starves',
  );
  // And wide enough that a full budget's worth of held claims cannot block it.
  assert.ok(MAX_EXHAUSTION_SCAN_PER_RUN >= MAX_ESCALATIONS_PER_RUN * 5);
});
