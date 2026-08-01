import test from 'node:test';
import assert from 'node:assert/strict';
import {
  money,
  buildBrokerOrderFacts,
  buildBrokerRancherEmail,
  buildBrokerBuyerReceipt,
  buildBrokerOperatorCard,
  type BrokerOrderFacts,
} from './brokerNotify';

// All names below are SYNTHETIC — the repo is public, no real buyer or rancher
// data may appear in fixtures.
function facts(over: Partial<BrokerOrderFacts> = {}): BrokerOrderFacts {
  return {
    ranchName: 'Cedar Draw Beef',
    operatorName: 'Sam Rivers',
    rancherEmail: 'sam@example.com',
    rancherPhone: '(406) 555-0142',
    buyerName: 'Jordan Blake',
    buyerEmail: 'jordan@example.com',
    buyerPhone: '(512) 555-0199',
    fulfillmentPref: 'pickup',
    buyerState: 'TX',
    buyerZip: '78704',
    cutLabel: 'Half Cow',
    priceCents: 180000,
    depositCents: 40000,
    balanceCents: 140000,
    balanceNote: 'Cash or check at pickup.',
    orderRef: 'BHC-abc123',
    ...over,
  };
}

test('money: formats cents as dollars with two decimals and thousands separators', () => {
  assert.equal(money(180000), '$1,800.00');
  assert.equal(money(40000), '$400.00');
  assert.equal(money(0), '$0.00');
  assert.equal(money(NaN as any), '$0.00');
});

// ---------------------------------------------------------------------------
// buildBrokerOrderFacts
// ---------------------------------------------------------------------------

test('buildBrokerOrderFacts: pulls contact truth from the referral, falling back to the consumer', () => {
  const f = buildBrokerOrderFacts({
    rancher: { 'Ranch Name': 'Cedar Draw Beef', Email: 'sam@example.com', Phone: '406-555-0142' },
    referral: { 'Buyer Name': 'Jordan Blake', 'Buyer Email': 'jordan@example.com' },
    consumer: { Phone: '512-555-0199', State: 'TX', Zip: '78704' },
    cutLabel: 'Half Cow',
    priceCents: 180000,
    depositCents: 40000,
    orderRef: 'BHC-abc123',
  });
  assert.equal(f.buyerName, 'Jordan Blake');
  assert.equal(f.buyerPhone, '512-555-0199'); // fell back to the consumer row
  assert.equal(f.buyerZip, '78704');
  assert.equal(f.balanceCents, 140000);
});

test('buildBrokerOrderFacts: never renders a NEGATIVE balance on malformed money', () => {
  // A deposit larger than the price must not print "-$200.00 to collect" on a
  // rancher's fulfillment sheet.
  const f = buildBrokerOrderFacts({
    rancher: {},
    referral: {},
    cutLabel: 'Half Cow',
    priceCents: 100000,
    depositCents: 120000,
    orderRef: 'x',
  });
  assert.equal(f.balanceCents, 0);
});

// ---------------------------------------------------------------------------
// RANCHER EMAIL — must be self-sufficient and must state the split plainly
// ---------------------------------------------------------------------------

test('RANCHER email: contains every fulfillment fact he needs without logging in', () => {
  const built = buildBrokerRancherEmail(facts());
  for (const needed of [
    'Jordan Blake',        // buyer name
    'jordan@example.com',  // buyer email
    '(512) 555-0199',      // buyer phone
    'pickup',              // fulfillment preference
    'TX 78704',            // where they are
    'Half Cow',            // the cut
    '$1,800.00',           // FULL share price
    '$400.00',             // deposit BHC collected
    '$1,400.00',           // exact balance he collects
    'Cash or check at pickup.', // his own balance-collection note
  ]) {
    assert.ok(built.html.includes(needed), `rancher email missing: ${needed}`);
    assert.ok(built.text.includes(needed), `rancher text missing: ${needed}`);
  }
});

test('RANCHER email: states plainly that the deposit was BHC commission and that he nets price - deposit', () => {
  const built = buildBrokerRancherEmail(facts());
  const body = built.html.toLowerCase();
  assert.ok(body.includes("buyhalfcow's commission"), 'must name the deposit as commission');
  assert.ok(body.includes('we keep it'), 'must say we keep it');
  assert.ok(body.includes('do not invoice you'), 'must promise no invoice');
  // His net is stated as an explicit number, not left to be inferred.
  assert.ok(built.html.includes('your net on this share is <strong>$1,400.00</strong>'));
  assert.ok(built.text.includes('your net on this share is $1,400.00'));
});

test('RANCHER email: subject leads with the money he collects', () => {
  const built = buildBrokerRancherEmail(facts());
  assert.ok(built.subject.includes('$1,400.00'));
  assert.ok(built.subject.includes('Half Cow'));
});

test('RANCHER email: degrades honestly when buyer contact fields are blank', () => {
  const built = buildBrokerRancherEmail(
    facts({ buyerName: '', buyerPhone: '', fulfillmentPref: '', buyerState: '', buyerZip: '' }),
  );
  assert.ok(built.html.includes('(not given)'));
  // Never invents a location line it has no data for.
  assert.ok(!built.html.includes('Located'));
});

// ---------------------------------------------------------------------------
// BUYER RECEIPT — the buyer's truth, and what it must NOT say
// ---------------------------------------------------------------------------

test('BUYER receipt: shows ranch, cut, paid today, balance, and that the RANCH is paid direct', () => {
  const built = buildBrokerBuyerReceipt(facts());
  for (const needed of [
    'Cedar Draw Beef',
    'Half Cow',
    '$400.00',              // paid today
    '$1,400.00',            // balance owed
    'Cash or check at pickup.',
    'sam@example.com',      // rancher contact
    '(406) 555-0142',
  ]) {
    assert.ok(built.html.includes(needed), `buyer receipt missing: ${needed}`);
  }
  assert.ok(built.html.includes('<strong>directly to Cedar Draw Beef</strong>'));
  assert.ok(built.html.includes('not to BuyHalfCow'));
  assert.ok(built.text.includes('directly to Cedar Draw Beef, not to BuyHalfCow'));
});

test('BUYER receipt: NEVER reveals that BHC keeps the deposit', () => {
  const built = buildBrokerBuyerReceipt(facts());
  const all = `${built.html} ${built.text} ${built.subject}`.toLowerCase();
  for (const forbidden of ['commission', 'we keep', 'our fee', 'service fee', 'brokerage']) {
    assert.ok(!all.includes(forbidden), `buyer receipt must not mention "${forbidden}"`);
  }
});

test('BUYER receipt: the buyer total equals the full share price — unchanged vs buying direct', () => {
  const f = facts();
  const built = buildBrokerBuyerReceipt(f);
  assert.equal(f.depositCents + f.balanceCents, f.priceCents);
  assert.ok(built.html.includes('$1,800.00'), 'the full price must be shown');
});

test('BUYER receipt: survives a ranch with no contact details on file', () => {
  const built = buildBrokerBuyerReceipt(facts({ rancherEmail: '', rancherPhone: '' }));
  assert.ok(built.html.includes('Contact details will come with their first message.'));
});

test('emails escape HTML in user-supplied values (a quote in a ranch name cannot break markup)', () => {
  const built = buildBrokerRancherEmail(facts({ ranchName: '<script>x</script> & "Co"' }));
  assert.ok(!built.html.includes('<script>'));
  assert.ok(built.html.includes('&lt;script&gt;'));
});

// ---------------------------------------------------------------------------
// OPERATOR CARD
// ---------------------------------------------------------------------------

test('operator card: states BHC take and the rancher-direct balance separately', () => {
  const card = buildBrokerOperatorCard(facts());
  assert.ok(card.includes('BROKER SALE'));
  assert.ok(card.includes('$400.00'));
  assert.ok(card.includes('$1,400.00'));
  assert.ok(card.includes('No Connect, no payout, no invoice.'));
});
