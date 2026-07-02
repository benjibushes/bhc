// PRE-FLIP GUARD (finding 1, 2026-07-01): the campaign engine's hot/warm
// tiers must NEVER select a buyer who is MID-DEAL (deposit pending, slot
// locked) — emailing them toward a DIFFERENT rancher mid-payment is the
// double-route class BLOCKER-4 fixed in matching/suggest. Two layers:
//
//   1. FIELDS MIRROR — classifyTier returns null for hot/warm buyers whose
//      Consumer fields say they're in a deal (Referral Status ∈ active set /
//      Buyer Stage MATCHED). Stranded-qualified already had this guard; hot
//      and warm did not.
//   2. REFERRAL TRUTH — buildCampaignPlan accepts the raw active-deal
//      referral rows (opts.activeDealReferrals) and excludes any buyer that
//      isActiveDealReferral (lib/capacityCount — the ONE canonical predicate)
//      matches, keyed by Buyer link id OR Buyer Email. This catches buyers
//      whose Consumer mirror fields are stale.
//
// Excluded buyers tally under plan.suppressed['active-deal'] so the dry-run
// report shows exactly how many mid-deal buyers were protected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyTier,
  buildCampaignPlan,
  activeDealBuyerKeys,
  DAY_MS,
  type CampaignBuyer,
} from './demandRouter';

const NOW = Date.parse('2026-06-27T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * DAY_MS).toISOString();

// A hot WEST buyer that would ALWAYS be selected absent the guard.
const hotBuyer = (id: string, over: Record<string, unknown> = {}): CampaignBuyer => ({
  id,
  fields: {
    Email: `${id}@x.com`,
    State: 'CA',
    'Ready to Buy': true,
    'Intent Score': 90,
    Created: daysAgo(20),
    ...over,
  },
});

const PLAN_OPTS = { now: NOW, capacity: { west: 10, eastCentral: 10 } };

// ─── layer 1: fields mirror — classifyTier ─────────────────────────────────

test('classifyTier: HOT signals with an active referral are NOT selected (mid-deal)', () => {
  // Ready to Buy + a live deposit request → the rancher + operator own them.
  assert.equal(
    classifyTier({ 'Ready to Buy': true, 'Referral Status': 'Awaiting Payment' }),
    null,
  );
  assert.equal(
    classifyTier({ 'Warmup Engaged At': daysAgo(5), 'Referral Status': 'Slot Locked' }),
    null,
  );
  assert.equal(
    classifyTier({ 'Ready to Buy': true, 'Buyer Stage': 'MATCHED' }),
    null,
  );
});

test('classifyTier: WARM signals with an active referral are NOT selected (mid-deal)', () => {
  assert.equal(
    classifyTier({ 'Intent Score': 60, 'Referral Status': 'Negotiation' }),
    null,
  );
  assert.equal(
    classifyTier({ 'Intent Classification': 'High', 'Referral Status': 'Intro Sent' }),
    null,
  );
});

test('classifyTier: terminal referral statuses still classify (deal is over)', () => {
  // Closed Lost buyers are legitimately re-marketable.
  assert.equal(classifyTier({ 'Ready to Buy': true, 'Referral Status': 'Closed Lost' }), 'hot');
  assert.equal(classifyTier({ 'Intent Score': 60, 'Referral Status': 'Waitlisted' }), 'warm');
});

// ─── layer 1 in the planner: fields-mirror exclusion + tally ───────────────

test('buildCampaignPlan: mid-deal buyer (fields mirror) is excluded + tallied active-deal', () => {
  const buyers: CampaignBuyer[] = [
    hotBuyer('recCLEAN'),
    hotBuyer('recMIDDEAL', { 'Referral Status': 'Awaiting Payment' }),
  ];
  const plan = buildCampaignPlan(buyers, PLAN_OPTS);
  assert.deepEqual(plan.sends.map((s) => s.buyerId), ['recCLEAN']);
  assert.equal(plan.suppressed['active-deal'], 1);
});

// ─── layer 2: referral truth — activeDealBuyerKeys + opts.activeDealReferrals ──

test('activeDealBuyerKeys: held statuses + linked Pending Approval yield keys; terminal/orphan do not', () => {
  const keys = activeDealBuyerKeys([
    { Status: 'Slot Locked', Buyer: ['recA'], 'Buyer Email': 'A@X.com' },
    { Status: 'Awaiting Payment', Buyer: ['recB'] },
    { Status: 'Pending Approval', Rancher: ['recRANCH'], Buyer: ['recC'] },
    // Orphan Pending Approval (failed-match residue) — NOT active.
    { Status: 'Pending Approval', Buyer: ['recORPHAN'] },
    // Terminal — NOT active.
    { Status: 'Closed Won', Buyer: ['recWON'], 'Buyer Email': 'won@x.com' },
    { Status: 'Closed Lost', Buyer: ['recLOST'] },
    // Garbage rows must not throw.
    null as any,
    {},
  ]);
  assert.deepEqual([...keys.ids].sort(), ['recA', 'recB', 'recC']);
  assert.ok(keys.emails.has('a@x.com'), 'emails are lowercased');
  assert.ok(!keys.emails.has('won@x.com'));
});

test('buildCampaignPlan: referral-truth exclusion — clean fields but a live deal row → excluded', () => {
  // The Consumer mirror fields are CLEAN (stale) — only the Referrals table
  // knows this buyer is mid-deal. The planner must still exclude them.
  const buyers: CampaignBuyer[] = [hotBuyer('recSTALE'), hotBuyer('recFREE')];
  const plan = buildCampaignPlan(buyers, {
    ...PLAN_OPTS,
    activeDealReferrals: [{ Status: 'Awaiting Payment', Buyer: ['recSTALE'] }],
  });
  assert.deepEqual(plan.sends.map((s) => s.buyerId), ['recFREE']);
  assert.equal(plan.suppressed['active-deal'], 1);
});

test('buildCampaignPlan: referral-truth exclusion also matches by Buyer Email', () => {
  const buyers: CampaignBuyer[] = [hotBuyer('recEMAILKEY')];
  const plan = buildCampaignPlan(buyers, {
    ...PLAN_OPTS,
    activeDealReferrals: [
      // No Buyer link (legacy row) — email is the only key. Case-insensitive.
      { Status: 'Slot Locked', 'Buyer Email': 'RECEMAILKEY@X.COM' },
    ],
  });
  assert.equal(plan.sends.length, 0);
  assert.equal(plan.suppressed['active-deal'], 1);
});

test('buildCampaignPlan: terminal referral rows do NOT exclude (re-marketable)', () => {
  const buyers: CampaignBuyer[] = [hotBuyer('recDONE')];
  const plan = buildCampaignPlan(buyers, {
    ...PLAN_OPTS,
    activeDealReferrals: [{ Status: 'Closed Lost', Buyer: ['recDONE'] }],
  });
  assert.deepEqual(plan.sends.map((s) => s.buyerId), ['recDONE']);
  assert.equal(plan.suppressed['active-deal'], 0);
});

test('buildCampaignPlan: mid-deal buyer gets NO continuation either (rancher owns them)', () => {
  // Even a buyer mid-arc (Msg1 Sent, due Msg2) goes hands-off once a deal opens.
  const buyers: CampaignBuyer[] = [
    hotBuyer('recARC', {
      'Campaign Stage': 'Msg1 Sent',
      'Campaign Last Sent At': daysAgo(4),
      'Referral Status': 'Slot Locked',
    }),
  ];
  const plan = buildCampaignPlan(buyers, PLAN_OPTS);
  assert.equal(plan.sends.length, 0);
  assert.equal(plan.suppressed['active-deal'], 1);
});
