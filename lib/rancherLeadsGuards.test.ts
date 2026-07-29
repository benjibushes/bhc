// lib/rancherLeadsGuards.test.ts
//
// MY LEADS — the guard net (2026-07-29). A rancher-entered lead is a normal
// Referrals row ('Referral Source' = 'rancher-added') + Consumers row
// ('Lead Source' = 'rancher-crm'). These tests pin, per rail, that the rows
// are INVISIBLE to automation that only makes sense for BHC-routed leads —
// and that the buyer never receives BHC marketing they didn't consent to.
//
// One file so the whole net is auditable in one read. Rails covered:
//   c. first-touch SLA (pure selector can never pick a rancher-added shape)
//   e. nurture-drip / waiting-activation / ready-chase (marketing pools)
//   e. loss-recovery + replenishment (post-close buyer outreach)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { needsFirstTouchNudge, needsFirstTouchEscalation } from './firstTouchSla';
import { dueNurtureTouch } from './nurtureDrip';
import { isWaitingNudgeEligible, isReadyChaseEligible } from './waitingActivation';
import { isReplenishEligible } from './replenishment';
import { selectLossRecovery } from './lossRecovery';

const NOW = Date.parse('2026-07-29T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

// ── (c) first-touch SLA — rancher-added shape can never be selected ────────

test('first-touch SLA: a rancher-added lead shape (Rancher Contacted, no intro stamp) never nudges or escalates', () => {
  const crmShape = {
    id: 'recCRM',
    status: 'Rancher Contacted', // rancher-added rows are created here
    introSentAt: undefined, // never introduced by BHC
  } as any;
  assert.equal(needsFirstTouchNudge(crmShape, NOW), false);
  assert.equal(needsFirstTouchEscalation(crmShape, NOW), false);
});

// ── (e) nurture drip — rancher-crm consumers are never due a touch ─────────

test('nurture drip: a rancher-crm consumer (MATCHED, no BHC funnel stamps) is never due', () => {
  const t = dueNurtureTouch(
    {
      buyerStage: 'MATCHED',
      qualifiedAt: '',
      funnelCompletedAt: '',
      email: 'lead@example.com',
      nurtureTouch: 0,
      hasActiveDeal: true,
      leadSource: 'rancher-crm',
    },
    NOW,
  );
  assert.equal(t, null);
});

test('nurture drip: leadSource=rancher-crm excludes even a WAITING/qualified-looking row (belt over stage gate)', () => {
  // If an operator ever hand-edits a CRM buyer to WAITING + stamps Qualified
  // At, the provenance marker alone must still keep the drip away.
  const t = dueNurtureTouch(
    {
      buyerStage: 'WAITING',
      qualifiedAt: daysAgo(10),
      funnelCompletedAt: '',
      email: 'lead@example.com',
      nurtureTouch: 0,
      hasActiveDeal: false,
      leadSource: 'rancher-crm',
    },
    NOW,
  );
  assert.equal(t, null);
});

test('nurture drip: an organic buyer with no leadSource still selects (no regression)', () => {
  const t = dueNurtureTouch(
    {
      buyerStage: 'WAITING',
      qualifiedAt: daysAgo(10),
      funnelCompletedAt: '',
      email: 'organic@example.com',
      nurtureTouch: 0,
      hasActiveDeal: false,
    },
    NOW,
  );
  assert.ok(t && t.touch >= 1);
});

// ── (e) waiting-activation + ready-chase ───────────────────────────────────

test('waiting-activation: Lead Source=rancher-crm is never nudge-eligible, even at WAITING', () => {
  const c = {
    id: 'recC',
    'Buyer Stage': 'WAITING',
    Email: 'lead@example.com',
    'Lead Source': 'rancher-crm',
  };
  assert.equal(
    isWaitingNudgeEligible(c as any, { nowISO: new Date(NOW).toISOString(), cooldownDays: 7 }),
    false,
  );
});

test('waiting-activation: organic WAITING buyer stays eligible (no regression)', () => {
  const c = { id: 'recC', 'Buyer Stage': 'WAITING', Email: 'organic@example.com' };
  assert.equal(
    isWaitingNudgeEligible(c as any, { nowISO: new Date(NOW).toISOString(), cooldownDays: 7 }),
    true,
  );
});

test('ready-chase: Lead Source=rancher-crm is never chase-eligible, even READY + funnel-stamped', () => {
  const c = {
    id: 'recC',
    'Buyer Stage': 'READY',
    Email: 'lead@example.com',
    'Qualified At': daysAgo(60),
    'Nurture Touch': 4,
    'Lead Source': { name: 'rancher-crm' }, // Airtable object read shape
  };
  assert.equal(
    isReadyChaseEligible(c as any, { nowISO: new Date(NOW).toISOString(), cooldownDays: 7 }),
    false,
  );
});

// ── (e) replenishment — no reorder marketing to CRM buyers ─────────────────

test('replenishment: a Closed Won rancher-added lead in the perfect window is NOT eligible', () => {
  const ref = {
    id: 'recRef',
    Status: 'Closed Won',
    'Sale Amount': 2400,
    'Closed At': daysAgo(185), // half-cow window
    'Order Type': 'Half',
    'Referral Source': 'rancher-added',
  };
  assert.equal(isReplenishEligible(ref as any, { nowISO: new Date(NOW).toISOString() }), false);
});

test('replenishment: same row without the marker stays eligible (no regression)', () => {
  const ref = {
    id: 'recRef',
    Status: 'Closed Won',
    'Sale Amount': 2400,
    'Closed At': daysAgo(185),
    'Order Type': 'Half',
  };
  assert.equal(isReplenishEligible(ref as any, { nowISO: new Date(NOW).toISOString() }), true);
});

// ── (e) loss-recovery — never re-route the rancher's own customer ──────────

test('loss-recovery: a rancher-added Closed Lost row is skipped BEFORE any action mapping', () => {
  const buyer = { Email: 'lead@example.com', 'Full Name': 'Jane Doe' };
  const sel = selectLossRecovery({
    candidates: [
      {
        id: 'recCRM',
        Status: 'Closed Lost',
        'Referral Source': 'rancher-added',
        // Even with a recoverable reason, provenance wins:
        'Loss Reason': "Couldn't reach buyer",
        'Closed At': daysAgo(2),
        Buyer: ['recB1'],
      },
    ],
    activeReferrals: [],
    consumersById: new Map([['recB1', buyer]]),
    nowMs: NOW,
  });
  assert.equal(sel.planned.length, 0);
  assert.equal(sel.skips['rancher-added-crm'], 1);
});

test("loss-recovery: the CRM loss reason 'Other' maps to action none anyway (double belt)", () => {
  const sel = selectLossRecovery({
    candidates: [
      {
        id: 'recCRM2',
        Status: 'Closed Lost',
        'Loss Reason': 'Other',
        'Closed At': daysAgo(2),
        Buyer: ['recB1'],
      },
    ],
    activeReferrals: [],
    consumersById: new Map([['recB1', { Email: 'x@y.co' }]]),
    nowMs: NOW,
  });
  assert.equal(sel.planned.length, 0);
});
