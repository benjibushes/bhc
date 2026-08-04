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
    fulfillmentSteps: [
      'The ranch calls you within two business days.',
      'You choose your cuts with the butcher.',
      'You pick up your beef when it is ready.',
    ],
    additionalCosts:
      'Cutting and wrapping is billed by the butcher, about $400 to $500 on a half, paid when you pick up.',
    orderRef: 'BHC-abc123',
    ...over,
  };
}

/** The common shape: an all-in ranch that set neither optional field. */
function plainFacts(over: Partial<BrokerOrderFacts> = {}): BrokerOrderFacts {
  return facts({ fulfillmentSteps: [], additionalCosts: '', ...over });
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

test('buildBrokerOrderFacts: carries the fulfillment fields off the RANCHER record', () => {
  const f = buildBrokerOrderFacts({
    rancher: {
      'Ranch Name': 'Cedar Draw Beef',
      'Broker Fulfillment Steps': 'The ranch calls you.\n\nYou choose your cuts.\n',
      'Broker Additional Costs': '  Cutting and wrapping is billed by the butcher.  ',
    },
    referral: {},
    cutLabel: 'Half Cow',
    priceCents: 180000,
    depositCents: 40000,
    orderRef: 'BHC-abc123',
  });
  assert.deepEqual(f.fulfillmentSteps, ['The ranch calls you.', 'You choose your cuts.']);
  assert.equal(f.additionalCosts, 'Cutting and wrapping is billed by the butcher.');
});

test('buildBrokerOrderFacts: an all-in ranch gets [] and "" — never placeholder copy', () => {
  const f = buildBrokerOrderFacts({
    rancher: { 'Ranch Name': 'Cedar Draw Beef' },
    referral: {},
    cutLabel: 'Half Cow',
    priceCents: 180000,
    depositCents: 40000,
    orderRef: 'BHC-abc123',
  });
  assert.deepEqual(f.fulfillmentSteps, []);
  assert.equal(f.additionalCosts, '');
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

test('RANCHER email: echoes the buyer script so both sides work from the same words', () => {
  const built = buildBrokerRancherEmail(facts());
  for (const needed of [
    'The ranch calls you within two business days.',
    'You pick up your beef when it is ready.',
    'about $400 to $500 on a half',
  ]) {
    assert.ok(built.html.includes(needed), `rancher email missing: ${needed}`);
    assert.ok(built.text.includes(needed), `rancher text missing: ${needed}`);
  }
  assert.ok(built.html.includes('What your buyer was told'));
  assert.ok(built.text.includes('WHAT YOUR BUYER WAS TOLD'));
});

test('RANCHER email: the buyer script does NOT weaken the money paragraph', () => {
  // The deposit-is-our-commission truth is load-bearing. Adding disclosure
  // sections must never displace or soften it.
  const built = buildBrokerRancherEmail(facts());
  const body = built.html.toLowerCase();
  assert.ok(body.includes("buyhalfcow's commission"));
  assert.ok(body.includes('we keep it'));
  assert.ok(body.includes('do not invoice you'));
  assert.ok(built.html.includes('your net on this share is <strong>$1,400.00</strong>'));
  assert.ok(built.text.includes('YOU COLLECT FROM THE BUYER: $1,400.00'));
});

test('RANCHER email: an all-in ranch renders NO buyer-script section at all', () => {
  const built = buildBrokerRancherEmail(plainFacts());
  assert.ok(!built.html.includes('What your buyer was told'));
  assert.ok(!built.text.includes('WHAT YOUR BUYER WAS TOLD'));
  assert.ok(!built.html.includes('<ol'), 'no empty ordered list may be emitted');
  // Everything that shipped before still ships.
  assert.ok(built.html.includes('$1,400.00'));
  assert.ok(built.html.includes('Cash or check at pickup.'));
});

test('RANCHER email: steps only, or cost only, each render alone', () => {
  const stepsOnly = buildBrokerRancherEmail(plainFacts({ fulfillmentSteps: ['Call the ranch.'] }));
  assert.ok(stepsOnly.html.includes('What your buyer was told'));
  assert.ok(stepsOnly.html.includes('Call the ranch.'));
  assert.ok(!stepsOnly.html.includes('pay a third party'));

  const costOnly = buildBrokerRancherEmail(plainFacts({ additionalCosts: 'Hauling is billed by the driver.' }));
  assert.ok(costOnly.html.includes('What your buyer was told'));
  assert.ok(costOnly.html.includes('Hauling is billed by the driver.'));
  assert.ok(!costOnly.html.includes('<ol'), 'no empty ordered list when there are no steps');
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

test('BUYER receipt: restates the third-party cost beside the balance — no surprise bill', () => {
  // The whole point: the receipt must repeat what they saw before paying.
  const built = buildBrokerBuyerReceipt(facts());
  assert.ok(built.html.includes('Paid separately, not to the ranch'));
  assert.ok(built.html.includes('about $400 to $500 on a half'));
  assert.ok(built.text.includes('THE COST PAID SEPARATELY'));
  assert.ok(built.text.includes('about $400 to $500 on a half'));
  // It is named as separate from BOTH numbers they already know.
  assert.ok(built.html.includes('separate from your $400.00 deposit'));
  assert.ok(built.html.includes('$1,400.00 balance you pay Cedar Draw Beef'));
});

test('BUYER receipt: lists what happens next', () => {
  const built = buildBrokerBuyerReceipt(facts());
  assert.ok(built.html.includes('What happens next'));
  assert.ok(built.html.includes('<li style="margin:6px 0;">You choose your cuts with the butcher.</li>'));
  assert.ok(built.text.includes('WHAT HAPPENS NEXT'));
  assert.ok(built.text.includes('1. The ranch calls you within two business days.'));
});

test('BUYER receipt: an all-in ranch renders EXACTLY the pre-existing receipt', () => {
  const built = buildBrokerBuyerReceipt(plainFacts());
  for (const forbidden of [
    'What happens next',
    'Paid separately',
    'The cost paid separately',
    'WHAT HAPPENS NEXT',
    'THE COST PAID SEPARATELY',
    '<ol',
  ]) {
    assert.ok(!built.html.includes(forbidden), `blank fields must not render: ${forbidden}`);
    assert.ok(!built.text.includes(forbidden), `blank fields must not render in text: ${forbidden}`);
  }
  // The money lines that always existed are untouched.
  assert.ok(built.html.includes('Balance due to the ranch'));
  assert.ok(built.html.includes('$1,400.00'));
  assert.ok(built.html.includes('$400.00'));
  assert.ok(built.html.includes('$1,800.00'));
});

test('BUYER receipt: steps only, or cost only, each render alone', () => {
  const stepsOnly = buildBrokerBuyerReceipt(plainFacts({ fulfillmentSteps: ['Pick up at the ranch.'] }));
  assert.ok(stepsOnly.html.includes('What happens next'));
  assert.ok(!stepsOnly.html.includes('Paid separately'));

  const costOnly = buildBrokerBuyerReceipt(plainFacts({ additionalCosts: 'Hauling is billed by the driver.' }));
  assert.ok(costOnly.html.includes('Paid separately, not to the ranch'));
  assert.ok(costOnly.html.includes('Hauling is billed by the driver.'));
  assert.ok(!costOnly.html.includes('What happens next'));
  assert.ok(!costOnly.html.includes('<ol'));
});

test('BUYER receipt: a multiline third-party cost keeps its line breaks and stays escaped', () => {
  const built = buildBrokerBuyerReceipt(
    facts({ additionalCosts: 'Cutting & wrapping: about $450.\n<b>Paid at pickup.</b>' }),
  );
  assert.ok(built.html.includes('Cutting &amp; wrapping: about $450.<br>&lt;b&gt;Paid at pickup.&lt;/b&gt;'));
  assert.ok(!built.html.includes('<b>Paid at pickup.</b>'));
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


// ═══════════════════════════════════════════════════════════════════════════
// RAIL-MATRIX (2026-08-04) — boundary D: the broker refund story.
// Mechanically, a broker refund comes out of BuyHalfCow's OWN Stripe balance
// (the deposit never touched the ranch), and there is no dashboard Accept /
// slot-locked email on this rail. The receipt must promise exactly that —
// refundable until the RANCH CONFIRMS the animal, refunded BY BUYHALFCOW —
// and must never echo the Connect rail's "until your rancher accepts your
// slot" machinery.
// ═══════════════════════════════════════════════════════════════════════════

test('BUYER receipt: carries the broker refund truth — until the ranch confirms, refunded by BuyHalfCow', () => {
  const built = buildBrokerBuyerReceipt(facts());
  for (const body of [built.html, built.text]) {
    assert.ok(
      body.includes('fully refundable until Cedar Draw Beef confirms your animal'),
      'refund window must be tied to the RANCH confirming the animal',
    );
    assert.ok(
      body.includes('BuyHalfCow refunds it in full'),
      'the refund must come from BuyHalfCow — the ranch never held this money',
    );
  }
});

test('BUYER receipt: never promises the Connect refund machinery (accept / slot-locked)', () => {
  const built = buildBrokerBuyerReceipt(facts());
  const all = `${built.html} ${built.text}`.toLowerCase();
  for (const connectOnly of ['accepts your slot', 'slot locked', 'slot-locked']) {
    assert.ok(!all.includes(connectOnly), `broker receipt must not mention "${connectOnly}"`);
  }
});

test('refund line keeps the split silent — the forbidden-words pin still holds with it present', () => {
  // Belt on the belt: the new refund sentence must not have introduced any
  // of the words the split-silence test forbids.
  const built = buildBrokerBuyerReceipt(facts());
  const all = `${built.html} ${built.text}`.toLowerCase();
  assert.ok(all.includes('refundable'));
  for (const forbidden of ['commission', 'we keep', 'our fee', 'service fee', 'brokerage']) {
    assert.ok(!all.includes(forbidden), `refund copy leaked "${forbidden}"`);
  }
});
