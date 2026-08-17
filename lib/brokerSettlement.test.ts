// BROKER RAIL settlement + link-token tests.
//
// readBrokerMoney is the pure money read from a settled PaymentIntent.
// settleBrokerDeposit itself is I/O (Airtable + Resend + Telegram) and is
// covered by the guardrails around it: markDepositSucceeded is the idempotency
// anchor and every notification sits strictly behind it.
//
// deliverBrokerRancherSheet — the ONE notification the represented rancher ever
// receives — takes its collaborators by injection, so its delivery contract is
// tested behaviourally below without Resend/Airtable/Telegram.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Imported from lib/brokerRail (hermetic) rather than lib/brokerSettlement,
// which pulls lib/email → lib/secrets. brokerSettlement re-exports the same
// function.
import { readBrokerMoney } from './brokerRail';
import { deliverBrokerRancherSheet, raiseBrokerSheetAlert } from './brokerSettlement';
import {
  classifyBrokerRancherDelivery,
  buildBrokerOperatorCard,
  buildBrokerOrderFacts,
  resolveBrokerRancherEmail,
  type BrokerOrderFacts,
} from './brokerNotify';
import {
  mintBrokerReserveToken,
  verifyBrokerReserveToken,
  mintCampaignReserveToken,
  verifyCampaignReserveToken,
  brokerDepositPathFor,
} from './campaignReserve';

// ---------------------------------------------------------------------------
// readBrokerMoney — pi.amount is authoritative for what was CHARGED
// ---------------------------------------------------------------------------

test('readBrokerMoney: reads the deposit + price and derives the balance', () => {
  const m = readBrokerMoney({
    amount: 40000,
    metadata: { depositCents: '40000', priceCents: '180000' },
  });
  assert.equal(m.depositCents, 40000);
  assert.equal(m.priceCents, 180000);
  assert.equal(m.balanceCents, 140000);
});

test('readBrokerMoney: CLAMPS a metadata deposit larger than the real charge', () => {
  // Never record more collected than Stripe actually took.
  const m = readBrokerMoney({
    amount: 40000,
    metadata: { depositCents: '999999', priceCents: '180000' },
  });
  assert.equal(m.depositCents, 40000);
});

test('readBrokerMoney: falls back to the charged amount when depositCents is absent', () => {
  const m = readBrokerMoney({ amount: 40000, metadata: { priceCents: '180000' } });
  assert.equal(m.depositCents, 40000);
  assert.equal(m.balanceCents, 140000);
});

test('readBrokerMoney: a missing/implausible price collapses the balance to zero, never negative', () => {
  // Better to tell a rancher "$0 to collect" (visibly wrong, he calls us) than
  // to print a negative balance or invent a price nobody set.
  assert.equal(readBrokerMoney({ amount: 40000, metadata: {} }).balanceCents, 0);
  assert.equal(
    readBrokerMoney({ amount: 40000, metadata: { priceCents: '100' } }).balanceCents,
    0,
  );
});

test('readBrokerMoney: accepts a Checkout Session shape (amount_total)', () => {
  // The checkout.session.completed branch normalizes into the PI shape, but the
  // reader tolerates amount_total directly as well.
  const m = readBrokerMoney({
    amount_total: 40000,
    metadata: { depositCents: '40000', priceCents: '180000' },
  });
  assert.equal(m.depositCents, 40000);
  assert.equal(m.balanceCents, 140000);
});

test('readBrokerMoney: the money identity holds — deposit + balance == price', () => {
  const m = readBrokerMoney({
    amount: 62500,
    metadata: { depositCents: '62500', priceCents: '295000' },
  });
  assert.equal(m.depositCents + m.balanceCents, m.priceCents);
});

// ---------------------------------------------------------------------------
// LINK TOKENS — the two rails must never cross
// ---------------------------------------------------------------------------

test('broker token: round-trips consumerId + rancherId + cut', () => {
  const token = mintBrokerReserveToken({
    consumerId: 'recCONSUMER00001',
    rancherId: 'recBROKER0000001',
    cut: 'half',
  });
  const v = verifyBrokerReserveToken(token);
  assert.equal(v.ok, true);
  if (!v.ok) return;
  assert.equal(v.payload.consumerId, 'recCONSUMER00001');
  assert.equal(v.payload.rancherId, 'recBROKER0000001');
  assert.equal(v.payload.cut, 'half');
});

test('RAIL CROSSOVER: a CONNECT campaign token is REJECTED by the broker verifier', () => {
  const connectToken = mintCampaignReserveToken({
    consumerId: 'recCONSUMER00001',
    rancherSlug: 'cedar-draw-beef',
    cut: 'half',
  });
  const v = verifyBrokerReserveToken(connectToken);
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, 'wrong-purpose');
});

test('RAIL CROSSOVER: a BROKER token is REJECTED by the connect campaign verifier', () => {
  // Without this, a broker link could redeem on /r/d and charge the buyer under
  // Connect economics (deposit + fee on top) for a rancher with no Connect
  // account — the exact confused-deputy bug the split purposes prevent.
  const brokerToken = mintBrokerReserveToken({
    consumerId: 'recCONSUMER00001',
    rancherId: 'recBROKER0000001',
    cut: 'half',
  });
  const v = verifyCampaignReserveToken(brokerToken);
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, 'wrong-purpose');
});

test('broker token: refuses to mint without a rancherId (a slug is not accepted)', () => {
  assert.throws(
    () => mintBrokerReserveToken({ consumerId: 'recX', rancherId: '', cut: 'half' }),
    /rancherId required/,
  );
});

test('broker token: refuses to mint an invalid cut', () => {
  assert.throws(
    () => mintBrokerReserveToken({ consumerId: 'recX', rancherId: 'recY', cut: 'eighth' as any }),
    /quarter\|half\|whole/,
  );
});

test('broker token verify: garbage, empty, and oversized inputs fail closed (never throw)', () => {
  assert.equal(verifyBrokerReserveToken('').ok, false);
  assert.equal(verifyBrokerReserveToken(null).ok, false);
  assert.equal(verifyBrokerReserveToken('not.a.jwt').ok, false);
  assert.equal(verifyBrokerReserveToken('x'.repeat(5000)).ok, false);
});

test('brokerDepositPathFor: lands on the BROKER checkout page, not the Connect one', () => {
  const path = brokerDepositPathFor('recREF0000000001', 'half');
  assert.equal(path, '/checkout/recREF0000000001/broker?cut=half');
  assert.ok(!path.includes('/deposit'));
});


// ═══════════════════════════════════════════════════════════════════════════
// THE FULFILLMENT SHEET — the only signal a represented rancher ever gets.
//
// He is off-platform: no dashboard, no login, no Stripe. If this email does not
// land and nobody is told, the buyer has paid, BHC has kept the fee, and the
// ranch does not know a customer is coming. Every test below exists because
// that failure used to be a console.error nobody would ever read.
//
// All names/addresses are SYNTHETIC — the repo is public.
// ═══════════════════════════════════════════════════════════════════════════

function sheetFacts(over: Partial<BrokerOrderFacts> = {}): BrokerOrderFacts {
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
    fulfillmentSteps: [],
    additionalCosts: '',
    orderRef: 'BHC-abc123',
    ...over,
  };
}

const SHEET_ARGS = {
  referralId: 'recREF0000000001',
  rancherId: 'recRANCHER000001',
  nowIso: '2026-08-17T12:00:00.000Z',
  priorNotes: 'existing note',
};

/** Records the send + stamp calls made by the delivery half. */
function sendHarness(sendImpl: (f: BrokerOrderFacts) => Promise<any>) {
  const sends: BrokerOrderFacts[] = [];
  const stamps: Array<{ referralId: string; fields: Record<string, unknown> }> = [];
  return {
    sends,
    stamps,
    deps: {
      send: async (f: BrokerOrderFacts) => {
        sends.push(f);
        return sendImpl(f);
      },
      stamp: async (referralId: string, fields: Record<string, unknown>) => {
        stamps.push({ referralId, fields });
        return {};
      },
    },
  };
}

/** Records the alert + stamp calls made by the alert half. */
function alertHarness(alertImpl: (i: any) => Promise<any> = async () => ({ sent: true })) {
  const alerts: any[] = [];
  const stamps: Array<{ referralId: string; fields: Record<string, unknown> }> = [];
  return {
    alerts,
    stamps,
    deps: {
      alert: async (input: any) => {
        alerts.push(input);
        return alertImpl(input);
      },
      stamp: async (referralId: string, fields: Record<string, unknown>) => {
        stamps.push({ referralId, fields });
        return {};
      },
    },
  };
}

const FAILED_DELIVERY = { delivered: false, outcome: 'send-failed' as const, reason: 'invalid api key' };

// ── 1. THE SEND FAILS ──────────────────────────────────────────────────────

test('sheet FAILED: raises a loud operator alert carrying the balance and the buyer contact', async () => {
  const h = alertHarness();
  await raiseBrokerSheetAlert({ facts: sheetFacts(), ...SHEET_ARGS, delivery: FAILED_DELIVERY }, h.deps);

  assert.equal(h.alerts.length, 1, 'exactly one alert — silence is the bug being fixed');
  const a = h.alerts[0];
  assert.equal(a.urgency, 'loud', 'a paying buyer nobody told the ranch about is a money-class failure');
  assert.equal(a.kind, 'system-error');
  assert.match(a.summary, /DID NOT REACH/);
  assert.match(a.summary, /Cedar Draw Beef/, 'ranch name');
  assert.match(a.summary, /recREF0000000001/, 'referral id');
  // Everything Ben needs to hand-fix in under a minute, without opening Airtable.
  assert.match(a.detail, /\$1,400\.00/, 'the balance the ranch must collect');
  assert.match(a.detail, /Half Cow/, 'the cut');
  assert.match(a.detail, /jordan@example\.com/, 'buyer email');
  assert.match(a.detail, /\(512\) 555-0199/, 'buyer phone');
  assert.match(a.detail, /Jordan Blake/, 'buyer name');
  assert.match(a.detail, /invalid api key/, 'the actual reason');
  assert.equal(a.dedupeKey, 'broker-rancher-undelivered-recREF0000000001');
  assert.deepEqual(a.refs, [
    { type: 'referral', id: 'recREF0000000001' },
    { type: 'rancher', id: 'recRANCHER000001' },
  ]);
});

test('sheet FAILED: does NOT stamp the sent-marker, and persists the failure on the referral', async () => {
  const h = sendHarness(async () => ({ success: false, reason: 'provider rejected' }));
  await deliverBrokerRancherSheet({ facts: sheetFacts(), ...SHEET_ARGS }, h.deps);

  assert.equal(h.stamps.length, 1);
  const fields = h.stamps[0].fields;
  assert.equal(h.stamps[0].referralId, 'recREF0000000001');
  assert.ok(!('Intro Sent At' in fields), 'the record must never claim he was told when he was not');
  // Rule 2 — money/comms truth is persisted, not just logged.
  assert.match(String(fields.Notes), /NOT DELIVERED \(send-failed: provider rejected\)/);
  assert.match(String(fields.Notes), /^existing note/, 'prior notes are preserved');
});

test('sheet FAILED: still resolves with a verdict — settlement is never rolled back', async () => {
  const h = sendHarness(async () => ({ success: false, reason: 'boom' }));
  const d = await deliverBrokerRancherSheet({ facts: sheetFacts(), ...SHEET_ARGS }, h.deps);
  // The money is already captured. A notification problem must produce a
  // verdict, never a throw that could 5xx the webhook into a Stripe redelivery.
  assert.deepEqual(d, { delivered: false, outcome: 'send-failed', reason: 'boom' });
});

// ── 2. NO EMAIL ON FILE — a DATA GAP, not a transient failure ──────────────

test('sheet NO EMAIL: raises its own distinctly-worded alert, and never attempts a send', async () => {
  const s = sendHarness(async () => ({ success: true }));
  const d = await deliverBrokerRancherSheet(
    { facts: sheetFacts({ rancherEmail: '' }), ...SHEET_ARGS },
    s.deps,
  );
  assert.equal(d.delivered, false);
  assert.equal(d.outcome, 'no-email');
  assert.equal(s.sends.length, 0, 'nothing to send to');

  const h = alertHarness();
  await raiseBrokerSheetAlert(
    { facts: sheetFacts({ rancherEmail: '' }), ...SHEET_ARGS, delivery: d },
    h.deps,
  );
  assert.equal(h.alerts.length, 1);
  const a = h.alerts[0];
  assert.match(a.summary, /NO EMAIL on file/);
  assert.match(a.detail, /DATA GAP, not a transient failure/, 'must not read as a retryable blip');
  assert.match(a.detail, /no retry can fix it/);
  assert.match(a.detail, /add an Email to the rancher record/, 'names the actual fix');
  // Still carries everything needed to rescue THIS order by phone.
  assert.match(a.detail, /\$1,400\.00/);
  assert.match(a.detail, /\(512\) 555-0199/);
  // A distinct key: a data gap and a failed send are different jobs, and one
  // must never dedupe the other away.
  assert.equal(a.dedupeKey, 'broker-rancher-no-email-recREF0000000001');
  assert.notEqual(a.dedupeKey, 'broker-rancher-undelivered-recREF0000000001');
});

test('sheet NO EMAIL: does not crash, does not stamp the marker, returns a verdict', async () => {
  const h = sendHarness(async () => ({ success: true }));
  const d = await deliverBrokerRancherSheet(
    { facts: sheetFacts({ rancherEmail: '' }), ...SHEET_ARGS },
    h.deps,
  );
  assert.equal(d.delivered, false);
  assert.ok(!('Intro Sent At' in h.stamps[0].fields));
  assert.match(String(h.stamps[0].fields.Notes), /NOT DELIVERED \(no-email/);
});

// ── 2b. TEAM EMAILS — "no email" must be TRUE before we ever say it ────────
// A ranch that only ever filled in Team Emails is REACHABLE. Reading `Email`
// alone skipped the send entirely and then alerted "no Email on file … nothing
// was ever sent" — a false claim of the exact class this diff exists to kill.

test('TEAM EMAILS: a blank Email with a populated Team Emails is a REACHABLE ranch, not a data gap', async () => {
  const facts = buildBrokerOrderFacts({
    rancher: { 'Ranch Name': 'Cedar Draw Beef', Email: '', 'Team Emails': 'crew@example.com, second@example.com' },
    referral: { 'Buyer Name': 'Jordan Blake', 'Buyer Email': 'jordan@example.com' },
    cutLabel: 'Half Cow',
    priceCents: 180000,
    depositCents: 40000,
    orderRef: 'BHC-abc123',
  });
  assert.equal(facts.rancherEmail, 'crew@example.com', 'falls back to the FIRST team address');

  const s = sendHarness(async () => ({ success: true }));
  const d = await deliverBrokerRancherSheet({ facts, ...SHEET_ARGS }, s.deps);

  assert.equal(s.sends.length, 1, 'the sheet IS attempted at the team address');
  assert.equal(s.sends[0].rancherEmail, 'crew@example.com');
  assert.equal(d.delivered, true);
  assert.equal(d.outcome, 'sent');
  // And therefore no alert at all — the old behaviour raised a FALSE
  // "no Email on file, add one" against a record that already had one.
  const h = alertHarness();
  const r = await raiseBrokerSheetAlert({ facts, ...SHEET_ARGS, delivery: d }, h.deps);
  assert.equal(h.alerts.length, 0);
  assert.deepEqual(r, { raised: false, sent: false });
});

test('TEAM EMAILS: the broker resolver does not drift from the canonical rancherNotify one', async () => {
  // Duplicated rather than imported (brokerNotify must stay I/O-free), so pin
  // the two against each other across the shapes that matter.
  const { resolveRancherEmail } = await import('./rancherNotify');
  const cases: Array<Record<string, any> | null> = [
    { Email: 'primary@example.com', 'Team Emails': 'crew@example.com' },
    { Email: '', 'Team Emails': 'crew@example.com, second@example.com' },
    { Email: '   ', 'Team Emails': 'a@example.com\nb@example.com' },
    { Email: '', 'Team Emails': '  spaced@example.com  ' },
    { Email: '', 'Team Emails': '' },
    { Email: '', 'Team Emails': 'x@example.com;y@example.com' },
    {},
    null,
  ];
  for (const c of cases) {
    assert.equal(resolveBrokerRancherEmail(c), resolveRancherEmail(c), `drift on ${JSON.stringify(c)}`);
  }
});

// ── 3. THE HAPPY PATH — exactly one send, marker stamped, NO alert ─────────

test('sheet SENT: one send, marker stamped, card says emailed, and NO alert fires', async () => {
  const s = sendHarness(async () => ({ success: true, id: 'resend-id-1' }));
  const d = await deliverBrokerRancherSheet({ facts: sheetFacts(), ...SHEET_ARGS }, s.deps);

  assert.deepEqual(d, { delivered: true, outcome: 'sent', reason: '' });
  assert.equal(s.sends.length, 1, 'exactly one notification');
  assert.equal(s.stamps[0].fields['Intro Sent At'], '2026-08-17T12:00:00.000Z');
  assert.match(String(s.stamps[0].fields.Notes), /DELIVERED/);
  assert.ok(!String(s.stamps[0].fields.Notes).includes('NOT DELIVERED'));

  const h = alertHarness();
  const r = await raiseBrokerSheetAlert({ facts: sheetFacts(), ...SHEET_ARGS, delivery: d }, h.deps);
  assert.equal(h.alerts.length, 0, 'a delivered sheet must never page the operator');
  assert.equal(h.stamps.length, 0, 'and must not write a second time');
  assert.equal(r.raised, false);

  const card = buildBrokerOperatorCard(sheetFacts(), d);
  assert.match(card, /Fulfillment sheet emailed to the ranch\./);
  assert.ok(!card.includes('COULD NOT NOTIFY RANCHER'));
});

// ── 4. SUPPRESSED IS NOT SENT — the guardedSend contract ──────────────────

test('sheet SUPPRESSED: guardedSend suppression is treated as NOT delivered', async () => {
  // guardedSend returns { success: false, suppressed: true } for an
  // unsubscribed/bounced/complained address AND for a frequency-cap hit. The
  // old code branched on truthiness and the marker went down regardless.
  const s = sendHarness(async () => ({
    success: false,
    suppressed: true,
    reason: 'unsubscribed-bounced-or-complained',
  }));
  const d = await deliverBrokerRancherSheet({ facts: sheetFacts(), ...SHEET_ARGS }, s.deps);

  assert.equal(d.delivered, false);
  assert.equal(d.outcome, 'suppressed');
  assert.ok(!('Intro Sent At' in s.stamps[0].fields));

  const h = alertHarness();
  await raiseBrokerSheetAlert({ facts: sheetFacts(), ...SHEET_ARGS, delivery: d }, h.deps);
  assert.equal(h.alerts.length, 1, 'a bounced rancher address is exactly the invisible failure');
  assert.match(h.alerts[0].detail, /SUPPRESSED/);
  assert.match(h.alerts[0].detail, /unsubscribed-bounced-or-complained/);
});

// ── 5. THE ALERT'S OWN DELIVERY IS PERSISTED ──────────────────────────────
// sendOperatorSignal stamps its dedupe key BEFORE any wire, so a lost alert is
// lost for the whole window and nothing re-raises. Rule 2: persist it.

test('alert outcome: a DELIVERED alert stamps operator-alert=sent on the referral', async () => {
  const h = alertHarness(async () => ({ sent: true }));
  const r = await raiseBrokerSheetAlert({ facts: sheetFacts(), ...SHEET_ARGS, delivery: FAILED_DELIVERY }, h.deps);
  assert.equal(r.sent, true);
  assert.equal(h.stamps.length, 1);
  assert.match(String(h.stamps[0].fields.Notes), /operator-alert=sent/);
  // The delivery truth is rebuilt into the same line, so this stamp self-heals
  // a delivery stamp that failed rather than depending on it.
  assert.match(String(h.stamps[0].fields.Notes), /NOT DELIVERED \(send-failed: invalid api key\)/);
  assert.match(String(h.stamps[0].fields.Notes), /^existing note/);
});

test('alert outcome: a LOST alert (telegram + both fallbacks dead) stamps operator-alert=failed', async () => {
  const h = alertHarness(async () => ({ sent: false, reason: 'telegram-returned-null' }));
  const r = await raiseBrokerSheetAlert({ facts: sheetFacts(), ...SHEET_ARGS, delivery: FAILED_DELIVERY }, h.deps);
  assert.equal(r.sent, false);
  assert.match(String(h.stamps[0].fields.Notes), /operator-alert=failed \(telegram-returned-null\)/);
});

test('alert outcome: a deduped-away alert is NOT recorded as sent', async () => {
  // sendOperatorSignal returns { sent: false, reason: 'deduped' } when the key
  // is already held — the alert did not reach Ben and must not claim it did.
  const h = alertHarness(async () => ({ sent: false, reason: 'deduped' }));
  await raiseBrokerSheetAlert({ facts: sheetFacts(), ...SHEET_ARGS, delivery: FAILED_DELIVERY }, h.deps);
  assert.match(String(h.stamps[0].fields.Notes), /operator-alert=failed \(deduped\)/);
});

test('alert outcome: an undefined return is not mistaken for a confirmed send', async () => {
  const h = alertHarness(async () => undefined);
  const r = await raiseBrokerSheetAlert({ facts: sheetFacts(), ...SHEET_ARGS, delivery: FAILED_DELIVERY }, h.deps);
  assert.equal(r.sent, false, 'only sent === true counts — same fail-closed rule as the send itself');
  assert.match(String(h.stamps[0].fields.Notes), /operator-alert=failed/);
});

// ── 6. HOSTILE SHAPES — neither unit ever throws ──────────────────────────

test('sheet THREW: a network fault is caught, classified, and never escapes', async () => {
  const s = sendHarness(async () => {
    throw new Error('fetch failed: ECONNRESET');
  });
  const d = await deliverBrokerRancherSheet({ facts: sheetFacts(), ...SHEET_ARGS }, s.deps);
  assert.equal(d.delivered, false);
  assert.equal(d.outcome, 'threw');
  assert.ok(!('Intro Sent At' in s.stamps[0].fields));

  const h = alertHarness();
  await raiseBrokerSheetAlert({ facts: sheetFacts(), ...SHEET_ARGS, delivery: d }, h.deps);
  assert.match(h.alerts[0].detail, /ECONNRESET/);
});

test('sheet: a throwing send AND a throwing stamp can never surface into the caller', async () => {
  const d = await deliverBrokerRancherSheet(
    { facts: sheetFacts(), ...SHEET_ARGS },
    {
      send: async () => {
        throw new Error('resend down');
      },
      stamp: async () => {
        throw new Error('airtable 503');
      },
    },
  );
  assert.equal(d.delivered, false, 'a verdict is still returned');
  assert.equal(d.outcome, 'threw');
});

test('alert: a throwing alert AND a throwing stamp can never surface into the caller', async () => {
  const r = await raiseBrokerSheetAlert(
    { facts: sheetFacts(), ...SHEET_ARGS, delivery: FAILED_DELIVERY },
    {
      alert: async () => {
        throw new Error('telegram 500');
      },
      stamp: async () => {
        throw new Error('airtable 503');
      },
    },
  );
  assert.deepEqual({ raised: r.raised, sent: r.sent }, { raised: true, sent: false });
});

test('alert: a stamp failure does NOT suppress the alert (they are independent)', async () => {
  const alerts: any[] = [];
  await raiseBrokerSheetAlert(
    { facts: sheetFacts(), ...SHEET_ARGS, delivery: FAILED_DELIVERY },
    {
      alert: async (input: any) => {
        alerts.push(input);
        return { sent: true };
      },
      stamp: async () => {
        throw new Error('airtable 503');
      },
    },
  );
  assert.equal(alerts.length, 1, 'the alert is the last line of defence — it must survive a dead Airtable');
});

// ── 7. THE OPERATOR CARD MUST NOT LIE ─────────────────────────────────────

test('operator card: an undelivered sheet reads COULD NOT NOTIFY RANCHER, not "emailed"', async () => {
  const card = buildBrokerOperatorCard(sheetFacts(), {
    delivered: false,
    outcome: 'suppressed',
    reason: 'unsubscribed-bounced-or-complained',
  });
  assert.match(card, /COULD NOT NOTIFY RANCHER — ACTION NEEDED/);
  assert.match(card, /The ranch does not know about this order/);
  assert.ok(!card.includes('Fulfillment sheet emailed to the ranch.'), 'the old unconditional claim is gone');
  // The money lines are unchanged — this is still the sale card.
  assert.match(card, /BHC commission \(deposit, kept in full\): \$400\.00/);
  assert.match(card, /No Connect, no payout, no invoice\./);
});

test('operator card: with no delivery known it claims nothing (softened copy)', () => {
  const card = buildBrokerOperatorCard(sheetFacts());
  assert.match(card, /delivery unconfirmed/);
  assert.ok(!card.includes('Rancher emailed the fulfillment sheet'), 'the overstated copy is gone');
});

// ── 8. ESCAPING IS APPLIED ONCE PER WIRE ──────────────────────────────────

test('alert text is RAW — operatorSignal escapes per wire, so no double-escape', async () => {
  // escHtml() runs over detail for the email fallback and smsBody() uses it
  // raw. Pre-escaping here rendered "Smith &amp;amp; Sons" in the email
  // fallback — degrading the exact channel Ben is on when Telegram is down.
  const h = alertHarness();
  await raiseBrokerSheetAlert(
    { facts: sheetFacts({ ranchName: 'Smith & Sons', buyerName: 'A <b>Buyer' }), ...SHEET_ARGS, delivery: FAILED_DELIVERY },
    h.deps,
  );
  const a = h.alerts[0];
  assert.match(a.summary, /Smith & Sons/, 'raw ampersand, not &amp;');
  assert.ok(!a.summary.includes('&amp;'));
  assert.match(a.detail, /A <b>Buyer/, 'raw angle brackets');
  assert.ok(!a.detail.includes('&lt;'));
});

// ── 9. THE PURE VERDICT — guardedSend's contract, read literally ──────────

test('classifyBrokerRancherDelivery: ONLY success === true is a delivery', () => {
  assert.equal(classifyBrokerRancherDelivery({ hasEmail: true, result: { success: true } }).delivered, true);
  // Everything else fails CLOSED.
  assert.equal(classifyBrokerRancherDelivery({ hasEmail: true, result: { success: false } }).delivered, false);
  assert.equal(classifyBrokerRancherDelivery({ hasEmail: true, result: null }).delivered, false);
  assert.equal(classifyBrokerRancherDelivery({ hasEmail: true, result: undefined }).delivered, false);
  assert.equal(classifyBrokerRancherDelivery({ hasEmail: true, result: {} }).delivered, false);
  // A truthy-but-not-true success (the old `!res?.success` style bug) is NOT a send.
  assert.equal(
    classifyBrokerRancherDelivery({ hasEmail: true, result: { success: 1 as any } }).delivered,
    false,
  );
  assert.equal(classifyBrokerRancherDelivery({ hasEmail: false }).outcome, 'no-email');
});

test('classifyBrokerRancherDelivery: a throw outranks whatever the result said', () => {
  const d = classifyBrokerRancherDelivery({
    hasEmail: true,
    result: { success: true },
    error: new Error('ECONNRESET'),
  });
  assert.equal(d.delivered, false);
  assert.equal(d.outcome, 'threw');
});

// ── 10. WIRING PINS — settleBrokerDeposit must keep using all of the above ─
// Source-shape pins (same technique as lib/fulfillmentPushRunner.test.ts): the
// settle function is I/O and cannot be unit-run, so pin the wiring that a
// future refactor could silently revert.

const settleSrc = readFileSync(fileURLToPath(new URL('./brokerSettlement.ts', import.meta.url)), 'utf8');

/** Top-level argument list of the FIRST call to `name` in `src`. */
function callArgs(src: string, name: string): string[] {
  const at = src.indexOf(`${name}(`);
  if (at < 0) return [];
  let i = at + name.length + 1;
  let depth = 0;
  let cur = '';
  const out: string[] = [];
  for (; i < src.length; i++) {
    const c = src[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      if (depth === 0) break;
      depth--;
    }
    if (c === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

test('settleBrokerDeposit: routes the rancher email through the alerting delivery unit', () => {
  assert.match(settleSrc, /await deliverBrokerRancherSheet\(/, 'must not hand-roll the send again');
  assert.match(settleSrc, /await raiseBrokerSheetAlert\(/, 'the alert half must stay wired in');
  assert.match(
    settleSrc,
    /buildBrokerOperatorCard\(facts, delivery\)/,
    'the operator card must be told the real outcome',
  );
});

test('settleBrokerDeposit: the PRODUCTION call sites pass NO deps — the seam is tests-only', () => {
  // The seam exists so a money-path contract can be tested for real. But a
  // refactor that slipped a stub `send` into the production call would stop
  // emailing every represented ranch with all tests still green.
  assert.deepEqual(callArgs(settleSrc, 'await deliverBrokerRancherSheet').length, 1, 'deliver: no deps arg');
  assert.deepEqual(callArgs(settleSrc, 'await raiseBrokerSheetAlert').length, 1, 'alert: no deps arg');
});

test('settleBrokerDeposit: the operator alert must NEVER precede the buyer receipt', () => {
  // sendOperatorSignal awaits Telegram, which sleeps up to 30s on a 429 before
  // trying SMS + email. Ahead of the receipt that risks blowing the webhook's
  // maxDuration; Stripe redelivers, markDepositSucceeded returns false at the
  // anchor, and the receipt is never retried — the buyer pays and gets nothing.
  const receiptAt = settleSrc.indexOf('sendBrokerBuyerReceipt(facts)');
  const alertAt = settleSrc.indexOf('await raiseBrokerSheetAlert(');
  assert.ok(receiptAt > 0 && alertAt > 0, 'both call sites must exist');
  assert.ok(alertAt > receiptAt, 'the alert must come AFTER the buyer receipt');
});

test('settleBrokerDeposit: notification failure can never fail the settlement', () => {
  // The deposit is captured before any of this runs. Throwing here would 5xx
  // the webhook and make Stripe redeliver a payment that already settled past
  // the idempotency anchor — the emails still would not send.
  assert.match(settleSrc, /\[broker settle\] rancher notify unit threw/, 'the deliver call site stays try-caught');
  assert.match(settleSrc, /\[broker settle\] rancher alert unit threw/, 'the alert call site stays try-caught');
  assert.match(settleSrc, /settleBrokerDeposit\(pi: any\): Promise<void>/, 'return contract unchanged');
});

test('settleBrokerDeposit: the sent-marker is gated on a real delivery', () => {
  assert.match(
    settleSrc,
    /if \(delivery\.delivered\) fields\['Intro Sent At'\] = nowIso;/,
    "'Intro Sent At' must never be stamped unconditionally again",
  );
});
