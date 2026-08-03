import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSellLinkRail, brokerMintGate, sellLinkUrlFor } from './route';
import { verifyBrokerReserveToken, verifyCampaignReserveToken } from '@/lib/campaignReserve';

// ──────────────────────────────────────────────────────────────────────────
// POST /api/admin/sell-links — the operator mint endpoint, TWO RAILS.
//
// The handler itself is Airtable + admin-session bound, so the decisions that
// carry money are exported as pure functions and pinned here:
//   resolveSellLinkRail — which rail (and the refusal to guess between them)
//   brokerMintGate      — the broker money gate + the operator-facing message
//   sellLinkUrlFor      — which redemption path the buyer gets
//
// THE INVARIANT UNDER TEST: `rancherSlug` and `rancherId` are DIFFERENT money
// models (Connect = buyer pays BHC's fee on top, rancher keeps 100% of price;
// broker = the deposit goes 100% to BHC and IS the commission, ranch collects
// price − deposit). Nothing here may ever resolve an ambiguous request into
// one of them.
//
// Synthetic ranch names and record ids throughout — the repo is PUBLIC.
// ──────────────────────────────────────────────────────────────────────────

const BROKER_ID = 'recBROKERRANCH01';

function body(over: Record<string, any> = {}) {
  return { cut: 'half', buyerEmail: 'buyer@example.test', ...over };
}

/** A valid represented ranch: broker-flagged, no Connect footprint, priced,
 *  with an explicit deposit strictly below the price. */
function brokerRancher(over: Record<string, any> = {}) {
  return {
    id: BROKER_ID,
    'Ranch Name': 'Cedar Draw Beef',
    'Broker Rail': true,
    'Half Price': 1800,
    'Half Deposit': 400,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// resolveSellLinkRail — never guess the money model
// ---------------------------------------------------------------------------

test('rancherId alone selects the BROKER rail', () => {
  const out = resolveSellLinkRail(body({ rancherId: BROKER_ID }));
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.request.rail, 'broker');
  assert.equal(out.request.rancherId, BROKER_ID);
  assert.equal(out.request.rancherSlug, '');
});

test('rancherSlug alone selects the CONNECT rail (unchanged)', () => {
  const out = resolveSellLinkRail(body({ rancherSlug: 'Cedar-Draw' }));
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.request.rail, 'connect');
  assert.equal(out.request.rancherSlug, 'cedar-draw'); // normalized
  assert.equal(out.request.rancherId, '');
});

test('rancherId AND rancherSlug together is REFUSED, never resolved', () => {
  const out = resolveSellLinkRail(body({ rancherId: BROKER_ID, rancherSlug: 'cedar-draw' }));
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.status, 400);
  assert.match(out.error, /never both/i);
  assert.match(out.error, /different rails/i);
});

test('neither rancherId nor rancherSlug is refused', () => {
  const out = resolveSellLinkRail(body());
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.status, 400);
  assert.match(out.error, /rancherSlug .*or rancherId/i);
});

test('a bad cut or a bad email is refused before any rail is chosen', () => {
  for (const bad of [
    body({ rancherId: BROKER_ID, cut: 'eighth' }),
    body({ rancherId: BROKER_ID, cut: '' }),
    body({ rancherId: BROKER_ID, buyerEmail: 'not-an-email' }),
    body({ rancherSlug: 'cedar-draw', buyerEmail: '' }),
  ]) {
    const out = resolveSellLinkRail(bad);
    assert.equal(out.ok, false);
    if (out.ok) continue;
    assert.equal(out.status, 400);
  }
});

test('buyer fields are normalized the same way on both rails', () => {
  const out = resolveSellLinkRail(
    body({ rancherId: BROKER_ID, buyerEmail: '  Buyer@Example.Test ', buyerName: '  A Buyer ', buyerState: 'az' }),
  );
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.request.buyerEmail, 'buyer@example.test');
  assert.equal(out.request.buyerName, 'A Buyer');
  assert.equal(out.request.buyerState, 'AZ');
});

// ---------------------------------------------------------------------------
// brokerMintGate — the money gate, and the message the operator reads
// ---------------------------------------------------------------------------

test('broker mint happy path quotes price + the explicit deposit', () => {
  const gate = brokerMintGate(brokerRancher(), 'half');
  assert.equal(gate.ok, true);
  if (!gate.ok) return;
  assert.equal(gate.tierPrice, 1800);
  assert.equal(gate.deposit, 400);
});

test('a cut with NO price is refused (never sold at a guessed price)', () => {
  const gate = brokerMintGate(brokerRancher({ 'Half Price': undefined }), 'half');
  assert.equal(gate.ok, false);
  if (gate.ok) return;
  assert.equal(gate.status, 409);
  assert.match(gate.error, /Cedar Draw Beef/); // names the ranch to go fix
  assert.match(gate.error, /price/i);
});

test('a cut with NO deposit is refused — the deposit is NEVER derived here', () => {
  // On this rail the deposit IS the commission, so deriving one would invent
  // BHC's fee and silently change what the ranch nets.
  const gate = brokerMintGate(brokerRancher({ 'Half Deposit': undefined }), 'half');
  assert.equal(gate.ok, false);
  if (gate.ok) return;
  assert.equal(gate.status, 409);
  assert.match(gate.error, /deposit/i);
});

test('a NON-broker rancher id is refused (wrong rail, not a data hiccup)', () => {
  const gate = brokerMintGate(
    { id: 'recCONNECT000001', 'Ranch Name': 'Willow Bench Cattle', 'Half Price': 1800, 'Half Deposit': 400 },
    'half',
  );
  assert.equal(gate.ok, false);
  if (gate.ok) return;
  assert.equal(gate.status, 409);
  assert.match(gate.error, /represented-seller rail/i);
});

test('a broker-flagged ranch that also has Connect is refused (double-billing guard)', () => {
  const gate = brokerMintGate(brokerRancher({ 'Stripe Connect Account Id': 'acct_test' }), 'half');
  assert.equal(gate.ok, false);
  if (gate.ok) return;
  assert.equal(gate.status, 409);
  assert.match(gate.error, /Stripe Connect/i);
});

test('a deposit that is not strictly below the price is refused', () => {
  const gate = brokerMintGate(brokerRancher({ 'Half Deposit': 1800 }), 'half');
  assert.equal(gate.ok, false);
  if (gate.ok) return;
  assert.equal(gate.status, 409);
});

test('an unknown ranch name still produces a readable refusal', () => {
  const gate = brokerMintGate({ 'Broker Rail': true }, 'half');
  assert.equal(gate.ok, false);
  if (gate.ok) return;
  assert.match(gate.error, /^This ranch: /);
});

// ---------------------------------------------------------------------------
// sellLinkUrlFor — the rails' links can never cross
// ---------------------------------------------------------------------------

test('the broker rail mints an /r/b/ link naming the RECORD ID', () => {
  const url = sellLinkUrlFor({ rail: 'broker', consumerId: 'recBUYER00000001', rancherId: BROKER_ID, cut: 'half' });
  const marker = '/r/b/';
  assert.ok(url.includes(marker), `expected an /r/b/ link, got ${url}`);
  const token = url.slice(url.indexOf(marker) + marker.length);
  const verified = verifyBrokerReserveToken(token);
  assert.equal(verified.ok, true);
  if (!verified.ok) return;
  assert.equal(verified.payload.rancherId, BROKER_ID);
  assert.equal(verified.payload.consumerId, 'recBUYER00000001');
  assert.equal(verified.payload.cut, 'half');
});

test('the Connect rail still mints an /r/d/ link naming the SLUG', () => {
  const url = sellLinkUrlFor({ rail: 'connect', consumerId: 'recBUYER00000001', rancherSlug: 'cedar-draw', cut: 'half' });
  assert.ok(url.includes('/r/d/'), `expected an /r/d/ link, got ${url}`);
  assert.ok(!url.includes('/r/b/'));
});

test('a broker token cannot redeem on the Connect path, or vice versa', () => {
  const brokerToken = sellLinkUrlFor({
    rail: 'broker',
    consumerId: 'recBUYER00000001',
    rancherId: BROKER_ID,
    cut: 'half',
  }).split('/r/b/')[1];
  const connectToken = sellLinkUrlFor({
    rail: 'connect',
    consumerId: 'recBUYER00000001',
    rancherSlug: 'cedar-draw',
    cut: 'half',
  }).split('/r/d/')[1];

  assert.equal(verifyCampaignReserveToken(brokerToken).ok, false);
  assert.equal(verifyBrokerReserveToken(connectToken).ok, false);
});
