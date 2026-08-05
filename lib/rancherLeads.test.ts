// lib/rancherLeads.test.ts
//
// "My Leads" — rancher-entered lead CRM (2026-07-29). Pins:
//   1. The stage model: exactly FOUR UI stages, mapped to existing Referral
//      statuses, and NEVER 'Awaiting Payment' (that status is overloaded —
//      pre-payment writers must stamp Deposit Requested At; this feature
//      must not become a writer of it).
//   2. validateLeadInput — name bounds, one-contact-method rule, strict email,
//      shared #413 phone normalization (no truncation corruption).
//   3. isRancherAddedReferral — the provenance predicate every guard keys on.
//   4. decideLeadStagePatch — ownership / provenance / deposit-lock /
//      idempotency / amount gates, all pure.
//   5. Field builders — exact Airtable field names for the Consumer +
//      Referral writes (no 'Status', no routing fields, no 'Awaiting
//      Payment', Buyer Stage Updated At always rides Buyer Stage).

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  REFERRAL_SOURCE_RANCHER_ADDED,
  CONSUMER_LEAD_SOURCE_CRM,
  REFERRAL_SOURCE_FIELD,
  CONSUMER_LEAD_SOURCE_FIELD,
  LEAD_STAGE_TO_STATUS,
  LEAD_STATUS_TO_STAGE,
  isLeadStage,
  isRancherAddedReferral,
  validateLeadInput,
  decideLeadStagePatch,
  decideOrderPromote,
  buildLeadConsumerFields,
  buildLeadReferralFields,
  CRM_LOSS_REASON,
} from './rancherLeads';
import { isCapacityCountedReferral, countHeldReferrals } from './capacityCount';

// ── constants + stage model ────────────────────────────────────────────────

describe('rancherLeads constants + stage model', () => {
  it('pins the provenance marker values', () => {
    assert.strictEqual(REFERRAL_SOURCE_RANCHER_ADDED, 'rancher-added');
    assert.strictEqual(CONSUMER_LEAD_SOURCE_CRM, 'rancher-crm');
    assert.strictEqual(REFERRAL_SOURCE_FIELD, 'Referral Source');
    assert.strictEqual(CONSUMER_LEAD_SOURCE_FIELD, 'Lead Source');
  });

  it('maps exactly four UI stages to existing Referral statuses', () => {
    assert.deepStrictEqual(LEAD_STAGE_TO_STATUS, {
      new: 'Rancher Contacted',
      talking: 'Negotiation',
      won: 'Closed Won',
      lost: 'Closed Lost',
    });
  });

  it('NEVER maps any stage to the overloaded Awaiting Payment status', () => {
    for (const status of Object.values(LEAD_STAGE_TO_STATUS)) {
      assert.notStrictEqual(status, 'Awaiting Payment');
    }
  });

  it('status → stage inverse covers the four statuses', () => {
    assert.strictEqual(LEAD_STATUS_TO_STAGE['Rancher Contacted'], 'new');
    assert.strictEqual(LEAD_STATUS_TO_STAGE['Negotiation'], 'talking');
    assert.strictEqual(LEAD_STATUS_TO_STAGE['Closed Won'], 'won');
    assert.strictEqual(LEAD_STATUS_TO_STAGE['Closed Lost'], 'lost');
  });

  it('isLeadStage accepts only the four stages', () => {
    for (const s of ['new', 'talking', 'won', 'lost']) assert.ok(isLeadStage(s));
    for (const s of ['', 'Won', 'awaiting', 'Awaiting Payment', 'closed', null, undefined]) {
      assert.strictEqual(isLeadStage(s as any), false);
    }
  });

  it('CRM loss reason is an existing Loss Reason choice with a terminal recovery action', () => {
    // 'Other' maps to recovery action 'none' in lib/lossRecovery — the
    // loss-recovery rail never emails a rancher-entered buyer off this value.
    assert.strictEqual(CRM_LOSS_REASON, 'Other');
  });
});

// ── isRancherAddedReferral ────────────────────────────────────────────────

describe('isRancherAddedReferral', () => {
  it('true for a rancher-added row (plain string field)', () => {
    assert.ok(isRancherAddedReferral({ 'Referral Source': 'rancher-added' }));
  });
  it('true for the Airtable {name} object read shape', () => {
    assert.ok(isRancherAddedReferral({ 'Referral Source': { name: 'rancher-added' } }));
  });
  it('false for routed rows (blank / other / missing / null row)', () => {
    assert.strictEqual(isRancherAddedReferral({ 'Referral Source': '' }), false);
    assert.strictEqual(isRancherAddedReferral({ 'Referral Source': 'ads' }), false);
    assert.strictEqual(isRancherAddedReferral({}), false);
    assert.strictEqual(isRancherAddedReferral(null), false);
    assert.strictEqual(isRancherAddedReferral(undefined), false);
  });
});

// ── validateLeadInput ─────────────────────────────────────────────────────

describe('validateLeadInput', () => {
  it('accepts name + email', () => {
    const r = validateLeadInput({ name: 'Jane Doe', email: 'JANE@Example.com' });
    assert.ok(r.ok);
    if (r.ok) {
      assert.strictEqual(r.lead.name, 'Jane Doe');
      assert.strictEqual(r.lead.email, 'jane@example.com'); // lowercased
      assert.strictEqual(r.lead.phone, '');
    }
  });

  it('accepts name + phone (phone-only lead)', () => {
    const r = validateLeadInput({ name: 'Bo', phone: '406-555-1234' });
    assert.ok(r.ok);
    if (r.ok) assert.strictEqual(r.lead.email, '');
  });

  it('rejects when NEITHER email nor phone is given', () => {
    const r = validateLeadInput({ name: 'Jane Doe' });
    assert.strictEqual(r.ok, false);
    if (!r.ok) assert.match(r.error, /email or phone/i);
  });

  it('rejects names outside 2-80 chars (trimmed)', () => {
    assert.strictEqual(validateLeadInput({ name: ' J ', email: 'a@b.co' }).ok, false);
    assert.strictEqual(validateLeadInput({ name: 'x'.repeat(81), email: 'a@b.co' }).ok, false);
    assert.ok(validateLeadInput({ name: 'x'.repeat(80), email: 'a@b.co' }).ok);
  });

  it('rejects malformed emails with the strict regex', () => {
    for (const bad of ['jane', 'jane@', '@x.com', 'jane@x', 'a b@x.com', 'jane@x .com']) {
      const r = validateLeadInput({ name: 'Jane Doe', email: bad });
      assert.strictEqual(r.ok, false, `should reject ${bad}`);
    }
  });

  it('normalizes the US country code instead of truncating (the #413 corruption)', () => {
    const r = validateLeadInput({ name: 'Jane Doe', phone: '1 (406) 555-1234' });
    assert.ok(r.ok);
    // Stored value must carry the REAL number 4065551234, never 1406555123.
    if (r.ok) assert.match(r.lead.phone.replace(/\D/g, ''), /^4065551234$/);
  });

  it('rejects a too-short phone when it is the only contact method', () => {
    const r = validateLeadInput({ name: 'Jane Doe', phone: '555-1234' });
    assert.strictEqual(r.ok, false);
  });

  it('caps note at 500 chars', () => {
    const r = validateLeadInput({ name: 'Jane Doe', email: 'a@b.co', note: 'n'.repeat(600) });
    assert.strictEqual(r.ok, false);
    const ok = validateLeadInput({ name: 'Jane Doe', email: 'a@b.co', note: 'n'.repeat(500) });
    assert.ok(ok.ok);
  });
});

// ── decideLeadStagePatch ──────────────────────────────────────────────────

const baseRef = (over: Record<string, any> = {}) => ({
  'Status': 'Rancher Contacted',
  'Referral Source': 'rancher-added',
  'Rancher': ['recRANCHER1'],
  ...over,
});

describe('decideLeadStagePatch', () => {
  it('403s a routed (non-rancher-added) referral', () => {
    const d = decideLeadStagePatch({
      referral: baseRef({ 'Referral Source': '' }),
      rancherId: 'recRANCHER1',
      stage: 'talking',
    });
    assert.strictEqual(d.kind, 'error');
    if (d.kind === 'error') assert.strictEqual(d.httpStatus, 403);
  });

  it('403s a rancher who is not on the Rancher link (Suggested is NOT enough)', () => {
    const d = decideLeadStagePatch({
      referral: baseRef({ 'Rancher': ['recSOMEONE'], 'Suggested Rancher': ['recRANCHER1'] }),
      rancherId: 'recRANCHER1',
      stage: 'talking',
    });
    assert.strictEqual(d.kind, 'error');
    if (d.kind === 'error') assert.strictEqual(d.httpStatus, 403);
  });

  it('400s an unknown stage', () => {
    const d = decideLeadStagePatch({
      referral: baseRef(),
      rancherId: 'recRANCHER1',
      stage: 'Awaiting Payment' as any,
    });
    assert.strictEqual(d.kind, 'error');
    if (d.kind === 'error') assert.strictEqual(d.httpStatus, 400);
  });

  it('409s ANY stage change once the deposit has settled (rail owns the deal)', () => {
    for (const stage of ['new', 'talking', 'won', 'lost'] as const) {
      const d = decideLeadStagePatch({
        referral: baseRef({ 'Status': 'Awaiting Payment', 'Deposit Paid At': '2026-07-01T00:00:00Z' }),
        rancherId: 'recRANCHER1',
        stage,
      });
      assert.strictEqual(d.kind, 'error', `stage ${stage} must be blocked`);
      if (d.kind === 'error') assert.strictEqual(d.httpStatus, 409);
    }
  });

  it('noops a same-terminal re-fire (idempotent, no side effects)', () => {
    const d = decideLeadStagePatch({
      referral: baseRef({ 'Status': 'Closed Won' }),
      rancherId: 'recRANCHER1',
      stage: 'won',
      saleAmount: 2500,
    });
    assert.strictEqual(d.kind, 'noop');
  });

  it('409s reopening or flipping an already-terminal lead', () => {
    for (const [status, stage] of [
      ['Closed Won', 'lost'],
      ['Closed Lost', 'won'],
      ['Closed Won', 'talking'],
      ['Closed Lost', 'new'],
    ] as const) {
      const d = decideLeadStagePatch({
        referral: baseRef({ 'Status': status }),
        rancherId: 'recRANCHER1',
        stage,
        saleAmount: 100,
      });
      assert.strictEqual(d.kind, 'error', `${status} → ${stage} must 409`);
      if (d.kind === 'error') assert.strictEqual(d.httpStatus, 409);
    }
  });

  // DORMANT REVIVAL (2026-08-05): Dormant is a MACHINE pause (auto-expiry
  // cron), never an outcome — it must not behave like a terminal status.
  // Regression pin for the Foodstead ticket: 53 dormant leads were 409-ing
  // every action with "already closed — contact hello@", so purchases that
  // happened during the quiet spell could never be recorded.
  it('reactivates a Dormant lead to new/talking (plain status write)', () => {
    for (const [stage, status] of [
      ['new', 'Rancher Contacted'],
      ['talking', 'Negotiation'],
    ] as const) {
      const d = decideLeadStagePatch({
        referral: baseRef({ 'Status': 'Dormant' }),
        rancherId: 'recRANCHER1',
        stage,
      });
      assert.strictEqual(d.kind, 'update', `Dormant → ${stage} must be an update`);
      if (d.kind === 'update') assert.strictEqual(d.status, status);
    }
  });

  it('closes a Dormant lead won (with amount) or lost — the offline-purchase case', () => {
    const won = decideLeadStagePatch({
      referral: baseRef({ 'Status': 'Dormant' }),
      rancherId: 'recRANCHER1',
      stage: 'won',
      saleAmount: 2999,
    });
    assert.strictEqual(won.kind, 'close');
    if (won.kind === 'close') assert.strictEqual(won.outcome, 'won');
    const lost = decideLeadStagePatch({
      referral: baseRef({ 'Status': 'Dormant' }),
      rancherId: 'recRANCHER1',
      stage: 'lost',
    });
    assert.strictEqual(lost.kind, 'close');
    if (lost.kind === 'close') assert.strictEqual(lost.outcome, 'lost');
  });

  it('still requires a positive sale amount to close a Dormant lead won', () => {
    const d = decideLeadStagePatch({
      referral: baseRef({ 'Status': 'Dormant' }),
      rancherId: 'recRANCHER1',
      stage: 'won',
      saleAmount: 0,
    });
    assert.strictEqual(d.kind, 'error');
    if (d.kind === 'error') assert.strictEqual(d.httpStatus, 400);
  });

  it('requires a positive sale amount for won', () => {
    for (const bad of [undefined, 0, -5, NaN]) {
      const d = decideLeadStagePatch({
        referral: baseRef({ 'Status': 'Negotiation' }),
        rancherId: 'recRANCHER1',
        stage: 'won',
        saleAmount: bad as any,
      });
      assert.strictEqual(d.kind, 'error');
      if (d.kind === 'error') assert.strictEqual(d.httpStatus, 400);
    }
  });

  it('allows won/lost from a deposit-REQUESTED (unpaid) lead — off-platform close', () => {
    const ref = baseRef({
      'Status': 'Awaiting Payment',
      'Deposit Requested At': '2026-07-01T00:00:00Z',
    });
    const won = decideLeadStagePatch({ referral: ref, rancherId: 'recRANCHER1', stage: 'won', saleAmount: 2500 });
    assert.strictEqual(won.kind, 'close');
    const lost = decideLeadStagePatch({ referral: ref, rancherId: 'recRANCHER1', stage: 'lost' });
    assert.strictEqual(lost.kind, 'close');
  });

  it('blocks regressing a deposit-requested lead back to new/talking', () => {
    const ref = baseRef({
      'Status': 'Awaiting Payment',
      'Deposit Requested At': '2026-07-01T00:00:00Z',
    });
    for (const stage of ['new', 'talking'] as const) {
      const d = decideLeadStagePatch({ referral: ref, rancherId: 'recRANCHER1', stage });
      assert.strictEqual(d.kind, 'error');
      if (d.kind === 'error') assert.strictEqual(d.httpStatus, 409);
    }
  });

  it('open transitions resolve to plain status writes; closes resolve to close decisions', () => {
    const talking = decideLeadStagePatch({
      referral: baseRef(),
      rancherId: 'recRANCHER1',
      stage: 'talking',
    });
    assert.deepStrictEqual(talking, { kind: 'update', status: 'Negotiation' });

    const won = decideLeadStagePatch({
      referral: baseRef({ 'Status': 'Negotiation' }),
      rancherId: 'recRANCHER1',
      stage: 'won',
      saleAmount: 3100.5,
    });
    assert.deepStrictEqual(won, { kind: 'close', outcome: 'won', saleAmount: 3100.5 });

    const lost = decideLeadStagePatch({
      referral: baseRef(),
      rancherId: 'recRANCHER1',
      stage: 'lost',
    });
    assert.deepStrictEqual(lost, { kind: 'close', outcome: 'lost' });
  });

  it('noops a same-open-stage re-fire', () => {
    const d = decideLeadStagePatch({
      referral: baseRef({ 'Status': 'Negotiation' }),
      rancherId: 'recRANCHER1',
      stage: 'talking',
    });
    assert.strictEqual(d.kind, 'noop');
  });
});

// ── field builders ────────────────────────────────────────────────────────

describe('buildLeadConsumerFields', () => {
  it('writes the exact Consumer fields — marker, MATCHED stage + paired stamp', () => {
    const f = buildLeadConsumerFields(
      { name: 'Jane Doe', email: 'jane@example.com', phone: '(406) 555-1234', note: '' },
      { rancherState: 'TX' },
      '2026-07-29T00:00:00.000Z',
    );
    assert.strictEqual(f['Full Name'], 'Jane Doe');
    assert.strictEqual(f['Email'], 'jane@example.com');
    assert.strictEqual(f['Phone'], '(406) 555-1234');
    assert.strictEqual(f['State'], 'TX');
    assert.strictEqual(f['Lead Source'], 'rancher-crm');
    assert.strictEqual(f['Buyer Stage'], 'MATCHED');
    // Buyer Stage Updated At MUST ride every Buyer Stage write (email-sequences
    // silently skips rows without it — WRITE-MAP Consumers rule).
    assert.strictEqual(f['Buyer Stage Updated At'], '2026-07-29T00:00:00.000Z');
    assert.strictEqual(f['Source'], 'rancher-crm');
    // NEVER: Status (blank = cron-invisible by design), Qualified At, Segment,
    // Intent Score — this buyer opted into the RANCHER, not into BHC.
    for (const forbidden of ['Status', 'Qualified At', 'Segment', 'Intent Score', 'Approved At']) {
      assert.ok(!(forbidden in f), `${forbidden} must not be written`);
    }
  });

  it('omits blank email/phone instead of writing empty strings over dedupe keys', () => {
    const f = buildLeadConsumerFields(
      { name: 'Bo', email: '', phone: '(406) 555-1234', note: '' },
      { rancherState: '' },
      '2026-07-29T00:00:00.000Z',
    );
    assert.ok(!('Email' in f));
    assert.ok(!('State' in f) || f['State'] === '');
  });
});

describe('buildLeadReferralFields', () => {
  const built = buildLeadReferralFields(
    { name: 'Jane Doe', email: 'jane@example.com', phone: '(406) 555-1234', note: 'met at market' },
    {
      rancherId: 'recRANCHER1',
      rancherState: 'TX',
      ranchName: 'Sackett Ranch',
      consumerId: 'recBUYER1',
    },
    '2026-07-29T00:00:00.000Z',
  );

  it('creates at Rancher Contacted with the provenance marker + links', () => {
    assert.strictEqual(built['Status'], 'Rancher Contacted');
    assert.strictEqual(built['Referral Source'], 'rancher-added');
    assert.deepStrictEqual(built['Rancher'], ['recRANCHER1']);
    assert.deepStrictEqual(built['Buyer'], ['recBUYER1']);
    assert.strictEqual(built['Buyer Name'], 'Jane Doe');
    assert.strictEqual(built['Buyer Email'], 'jane@example.com');
    assert.strictEqual(built['Buyer Phone'], '(406) 555-1234');
    assert.strictEqual(built['Buyer State'], 'TX');
    assert.match(String(built['Notes']), /met at market/);
    // Rancher literally just engaged — freshness stamps keep chase crons calm.
    assert.strictEqual(built['Last Rancher Activity At'], '2026-07-29T00:00:00.000Z');
    assert.strictEqual(built['Rancher Engaged Flag'], true);
  });

  it('never writes routing/approval machinery', () => {
    for (const forbidden of [
      'Approval Status', 'Match Type', 'Intro Sent At', 'Approved At',
      'Intent Score', 'Deposit Requested At',
    ]) {
      assert.ok(!(forbidden in built), `${forbidden} must not be written`);
    }
  });

  it('omits the Buyer link when no consumer row exists', () => {
    const noBuyer = buildLeadReferralFields(
      { name: 'Bo', email: '', phone: '(406) 555-1234', note: '' },
      { rancherId: 'recR', rancherState: 'TX', ranchName: 'R', consumerId: '' },
      '2026-07-29T00:00:00.000Z',
    );
    assert.ok(!('Buyer' in noBuyer));
    assert.ok(!('Buyer Email' in noBuyer));
  });
});

// ── decideOrderPromote — "Track as deal" (2026-08-03) ──────────────────────
// Promoting a shop-order customer (Rancher Orders row) into a rancher-added
// lead. All fixture people are fake.

describe('decideOrderPromote', () => {
  const RANCHER = 'recRanchOwner001';
  const baseOrder = {
    id: 'recOrderAAA',
    'Rancher Record ID': RANCHER,
    'Buyer Email': 'Test.Buyer@Example.com',
    'Buyer Name': 'Test Buyer',
    'Order Ref': 'Quarter Beef — Test Buyer',
    'Status': 'New',
  };

  it('missing order → 404', () => {
    const d = decideOrderPromote({ order: null, rancherId: RANCHER, existingReferrals: [] });
    assert.strictEqual(d.kind, 'error');
    if (d.kind === 'error') assert.strictEqual(d.httpStatus, 404);
  });

  it("OWNERSHIP GATE: another rancher's order → 403 (a rancher can only promote THEIR customer)", () => {
    const d = decideOrderPromote({
      order: baseOrder,
      rancherId: 'recSomeOtherRanch',
      existingReferrals: [],
    });
    assert.strictEqual(d.kind, 'error');
    if (d.kind === 'error') assert.strictEqual(d.httpStatus, 403);
  });

  it('blank session rancher id → 403 (never fail open on identity)', () => {
    const d = decideOrderPromote({ order: baseOrder, rancherId: '', existingReferrals: [] });
    assert.strictEqual(d.kind, 'error');
    if (d.kind === 'error') assert.strictEqual(d.httpStatus, 403);
  });

  it('refunded order → 400 (a refunded buyer is not a deal to chase)', () => {
    const d = decideOrderPromote({
      order: { ...baseOrder, Status: 'Refunded' },
      rancherId: RANCHER,
      existingReferrals: [],
    });
    assert.strictEqual(d.kind, 'error');
    if (d.kind === 'error') assert.strictEqual(d.httpStatus, 400);
  });

  it('order with no buyer email → 400 with a pointer at the manual form', () => {
    const d = decideOrderPromote({
      order: { ...baseOrder, 'Buyer Email': '' },
      rancherId: RANCHER,
      existingReferrals: [],
    });
    assert.strictEqual(d.kind, 'error');
    if (d.kind === 'error') {
      assert.strictEqual(d.httpStatus, 400);
      assert.match(d.message, /My Leads form/);
    }
  });

  it('DEDUPE: an existing referral for the same email + this rancher (ANY source, even closed) → duplicate, never a second row', () => {
    const d = decideOrderPromote({
      order: baseOrder,
      rancherId: RANCHER,
      existingReferrals: [
        {
          id: 'recRefRouted',
          // Case-insensitive email match (belt over the formula's LOWER).
          'Buyer Email': 'TEST.BUYER@EXAMPLE.COM',
          Status: 'Closed Won', // terminal — still a duplicate
          'Referral Source': '', // routed, not rancher-added — still a duplicate
          Rancher: [RANCHER],
        },
      ],
    });
    assert.strictEqual(d.kind, 'duplicate');
    if (d.kind === 'duplicate') assert.strictEqual(d.referralId, 'recRefRouted');
  });

  it('DEDUPE: matches on the Suggested Rancher link too, and hands back the NEWEST referral id', () => {
    const d = decideOrderPromote({
      order: baseOrder,
      rancherId: RANCHER,
      existingReferrals: [
        {
          id: 'recRefOld',
          'Buyer Email': 'test.buyer@example.com',
          Status: 'Closed Lost',
          Rancher: [RANCHER],
          'Created At': '2026-01-01T00:00:00Z',
        },
        {
          id: 'recRefNew',
          'Buyer Email': 'test.buyer@example.com',
          Status: 'Rancher Contacted',
          'Suggested Rancher': [RANCHER],
          'Created At': '2026-07-01T00:00:00Z',
        },
      ],
    });
    assert.strictEqual(d.kind, 'duplicate');
    if (d.kind === 'duplicate') assert.strictEqual(d.referralId, 'recRefNew');
  });

  it("CROSS-RANCHER FENCE: buyer mid-deal with ANOTHER rancher → 409 error (no double-dealing), but that rancher's CLOSED deal doesn't block", () => {
    const otherActive = decideOrderPromote({
      order: baseOrder,
      rancherId: RANCHER,
      existingReferrals: [
        {
          id: 'recRefElsewhere',
          'Buyer Email': 'test.buyer@example.com',
          Status: 'Negotiation',
          Rancher: ['recSomeOtherRanch'],
        },
      ],
    });
    assert.strictEqual(otherActive.kind, 'error');
    if (otherActive.kind === 'error') assert.strictEqual(otherActive.httpStatus, 409);

    const otherClosed = decideOrderPromote({
      order: baseOrder,
      rancherId: RANCHER,
      existingReferrals: [
        {
          id: 'recRefElsewhereClosed',
          'Buyer Email': 'test.buyer@example.com',
          Status: 'Closed Lost',
          Rancher: ['recSomeOtherRanch'],
        },
      ],
    });
    assert.strictEqual(otherClosed.kind, 'create');
  });

  it('CREATE: prefills name/email from the ORDER row, lowercases the email, and carries the "from shop order" note', () => {
    const d = decideOrderPromote({ order: baseOrder, rancherId: RANCHER, existingReferrals: [] });
    assert.strictEqual(d.kind, 'create');
    if (d.kind !== 'create') return;
    assert.strictEqual(d.lead.name, 'Test Buyer');
    assert.strictEqual(d.lead.email, 'test.buyer@example.com');
    assert.strictEqual(d.lead.phone, '');
    assert.strictEqual(d.lead.note, 'from shop order Quarter Beef — Test Buyer');
  });

  it('CREATE: blank Buyer Name falls back to the email local part, then a generic label', () => {
    const fromLocal = decideOrderPromote({
      order: { ...baseOrder, 'Buyer Name': '', 'Buyer Email': 'ranch.fan@example.com' },
      rancherId: RANCHER,
      existingReferrals: [],
    });
    assert.strictEqual(fromLocal.kind, 'create');
    if (fromLocal.kind === 'create') assert.strictEqual(fromLocal.lead.name, 'ranch.fan');

    const generic = decideOrderPromote({
      order: { ...baseOrder, 'Buyer Name': '', 'Buyer Email': 'a@example.com' },
      rancherId: RANCHER,
      existingReferrals: [],
    });
    assert.strictEqual(generic.kind, 'create');
    if (generic.kind === 'create') assert.strictEqual(generic.lead.name, 'Shop buyer');
  });

  it('COUNTER PIN: the promoted referral is rancher-added and NEVER capacity-counted — no Current Active Referrals increment, ever', () => {
    const d = decideOrderPromote({ order: baseOrder, rancherId: RANCHER, existingReferrals: [] });
    assert.strictEqual(d.kind, 'create');
    if (d.kind !== 'create') return;
    const fields = buildLeadReferralFields(
      d.lead,
      { rancherId: RANCHER, rancherState: 'TX', ranchName: 'Test Ranch', consumerId: 'recConsumer1' },
      '2026-08-03T00:00:00.000Z',
    );
    // The rail's provenance + entry status.
    assert.strictEqual(fields[REFERRAL_SOURCE_FIELD], REFERRAL_SOURCE_RANCHER_ADDED);
    assert.strictEqual(fields['Status'], 'Rancher Contacted');
    assert.match(String(fields['Notes']), /from shop order Quarter Beef — Test Buyer/);
    // 'Rancher Contacted' IS a held status — the rancher-added source is what
    // keeps it out of every capacity counter. Pin both sides.
    assert.strictEqual(isCapacityCountedReferral(fields), false);
    assert.strictEqual(countHeldReferrals(RANCHER, [fields]), 0);
    const routedTwin = { ...fields, [REFERRAL_SOURCE_FIELD]: '' };
    assert.strictEqual(countHeldReferrals(RANCHER, [routedTwin]), 1, 'pin is meaningful: a routed twin WOULD count');
  });
});
