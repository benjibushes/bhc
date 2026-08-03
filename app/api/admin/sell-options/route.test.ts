import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSellRanchers, buildBrokerSellRancher } from './route';

// ──────────────────────────────────────────────────────────────────────────
// GET /api/admin/sell-options — the sell console's menu, TWO SHARE RAILS.
//
// These pin the two properties the console's correctness rests on:
//   1. the split is total — a represented ranch can never appear in the
//      Connect list, and a Connect rancher can never appear in the broker one.
//   2. every broker number the operator reads comes from the rail's own quote
//      (deposit = what BHC keeps, price − deposit = what the ranch collects),
//      and an unpriced / deposit-less cut renders NOT SELLABLE with a reason
//      rather than a button that 400s at mint time.
//
// Synthetic ranch names and record ids throughout — the repo is PUBLIC.
// ──────────────────────────────────────────────────────────────────────────

function brokerRancher(over: Record<string, any> = {}) {
  return {
    id: 'recBROKERRANCH01',
    'Ranch Name': 'Cedar Draw Beef',
    State: 'AZ',
    'Broker Rail': true,
    'Quarter Price': 950,
    'Quarter Deposit': 250,
    'Half Price': 1800,
    'Half Deposit': 400,
    ...over,
  };
}

/** A fully operational Connect rancher — passes isRancherOnConnect AND
 *  isRancherOperationalForBuyers. */
function connectRancher(over: Record<string, any> = {}) {
  return {
    id: 'recCONNECT000001',
    Slug: 'willow-bench',
    'Ranch Name': 'Willow Bench Cattle',
    State: 'TX',
    'Pricing Model': 'tier_v2',
    'Stripe Connect Status': 'active',
    'Active Status': 'Active',
    'Agreement Signed': true,
    'Half Price': 1800,
    ...over,
  };
}

const cutOf = (r: ReturnType<typeof buildBrokerSellRancher>, cut: string) =>
  r.cuts.find((c) => c.cut === cut)!;

// ---------------------------------------------------------------------------
// splitSellRanchers — the two rails never mix
// ---------------------------------------------------------------------------

test('a represented ranch lands in the broker list and NEVER the Connect one', () => {
  const { connect, broker } = splitSellRanchers([brokerRancher(), connectRancher()]);
  assert.deepEqual(broker.map((r: any) => r.id), ['recBROKERRANCH01']);
  assert.deepEqual(connect.map((r: any) => r.id), ['recCONNECT000001']);
});

test('a broker-flagged row is excluded from Connect even if it looks operational', () => {
  // The eligibility predicates already refuse a broker rancher by design; this
  // pins the explicit belt so a future eligibility change cannot leak one onto
  // the Connect rail's UI.
  const contradictory = connectRancher({ id: 'recBOTH000000001', 'Broker Rail': true });
  const { connect, broker } = splitSellRanchers([contradictory]);
  assert.equal(connect.length, 0);
  assert.deepEqual(broker.map((r: any) => r.id), ['recBOTH000000001']);
});

test('a broker row with no record id is dropped (it cannot be minted)', () => {
  const { broker } = splitSellRanchers([{ 'Ranch Name': 'No Id Ranch', 'Broker Rail': true }]);
  assert.equal(broker.length, 0);
});

test('a non-operational Connect rancher is in neither list', () => {
  const paused = connectRancher({ 'Active Status': 'Paused' });
  const { connect, broker } = splitSellRanchers([paused]);
  assert.equal(connect.length, 0);
  assert.equal(broker.length, 0);
});

test('splitSellRanchers is total and safe on junk input', () => {
  assert.deepEqual(splitSellRanchers(null as any), { connect: [], broker: [] });
  assert.deepEqual(splitSellRanchers([] as any), { connect: [], broker: [] });
});

// ---------------------------------------------------------------------------
// buildBrokerSellRancher — the operator's money truth
// ---------------------------------------------------------------------------

test('a sellable cut states what BHC keeps and what the ranch collects', () => {
  const row = buildBrokerSellRancher(brokerRancher(), 'AZ');
  const half = cutOf(row, 'half');
  assert.equal(half.sellable, true);
  assert.equal(half.price, 1800);
  assert.equal(half.deposit, 400);
  // The deposit IS the commission on this rail.
  assert.equal(half.bhcKeeps, 400);
  assert.equal(half.ranchCollects, 1400); // price − deposit
  assert.equal(half.bhcKeeps + half.ranchCollects, half.price);
  assert.equal(half.reason, '');
});

test('a cut with NO price is not sellable and says why — no invented numbers', () => {
  const row = buildBrokerSellRancher(brokerRancher({ 'Half Price': undefined }), 'AZ');
  const half = cutOf(row, 'half');
  assert.equal(half.sellable, false);
  assert.match(half.reason, /price/i);
  assert.equal(half.price, 0);
  assert.equal(half.deposit, 0);
  assert.equal(half.bhcKeeps, 0);
  assert.equal(half.ranchCollects, 0);
});

test('a cut with a price but NO deposit is not sellable (deposit is never derived)', () => {
  const row = buildBrokerSellRancher(brokerRancher({ 'Half Deposit': undefined }), 'AZ');
  const half = cutOf(row, 'half');
  assert.equal(half.sellable, false);
  assert.match(half.reason, /deposit/i);
  assert.equal(half.deposit, 0);
  // The other priced cut is unaffected — gating is PER CUT.
  assert.equal(cutOf(row, 'quarter').sellable, true);
});

test('all three cuts are always returned, unsold ones included', () => {
  const row = buildBrokerSellRancher(brokerRancher(), 'AZ');
  assert.deepEqual(row.cuts.map((c) => c.cut), ['quarter', 'half', 'whole']);
  // Whole was never priced on this fixture — visible, disabled, explained.
  const whole = cutOf(row, 'whole');
  assert.equal(whole.sellable, false);
  assert.ok(whole.reason.length > 0);
});

test('a ranch with nothing sellable still renders (that is the thing to go fix)', () => {
  const row = buildBrokerSellRancher(
    { id: 'recBROKERRANCH02', 'Ranch Name': 'Dry Fork Beef', State: 'AZ', 'Broker Rail': true },
    'AZ',
  );
  assert.equal(row.id, 'recBROKERRANCH02');
  assert.equal(row.name, 'Dry Fork Beef');
  assert.equal(row.cuts.every((c) => !c.sellable), true);
  assert.equal(row.cuts.every((c) => c.reason.length > 0), true);
});

test('inState is home-state only — a represented ranch has no routing coverage', () => {
  const withRoutingStates = brokerRancher({ 'Routing States': 'NV, UT' });
  assert.equal(buildBrokerSellRancher(withRoutingStates, 'AZ').inState, true);
  // NV appears only in Routing States, which does not apply to this rail.
  assert.equal(buildBrokerSellRancher(withRoutingStates, 'NV').inState, false);
  assert.equal(buildBrokerSellRancher(withRoutingStates, '').inState, false);
});

test('the record id is carried through — it is what selects the broker rail at mint', () => {
  assert.equal(buildBrokerSellRancher(brokerRancher(), 'AZ').id, 'recBROKERRANCH01');
});

test('a nameless ranch falls back to a neutral label, never a blank row', () => {
  const row = buildBrokerSellRancher({ id: 'recX', 'Broker Rail': true }, '');
  assert.equal(row.name, 'Represented ranch');
});
