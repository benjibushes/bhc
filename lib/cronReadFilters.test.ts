// Tests for the cron read-path filterByFormula builders (scale-ladder #3).
//
// Two things are pinned per builder:
//   1. The exact formula STRING sent to Airtable (field names must be real +
//      long-standing — a typo'd field errors the whole query).
//   2. The SUPERSET guarantee: for representative rows, every row the cron's
//      JS predicate KEEPS must also satisfy the formula. If the formula is a
//      strict subset of the JS filter, the cron would silently drop rows —
//      these assertions are the guard against exactly that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  statusOrFormula,
  heldReferralsFormula,
  activeDealReferralsFormula,
  sequenceRancherMapReferralsFormula,
  dailyDigestReferralsFormula,
  unsubscribedConsumersFormula,
  mailableConsumersFormula,
  readyStuckBuyersFormula,
  HELD_REFERRAL_STATUS_LIST,
} from './cronReadFilters';
import { HELD_REFERRAL_STATUSES, isActiveDealReferral } from './capacityCount';
import { LOCKED_STATUSES } from './referralLock';

// A tiny formula evaluator for the {Status}="x" OR/AND shapes these builders
// emit — enough to prove "row satisfies formula" without a live Airtable.
// Parses the status literals out of the string and models the boolean.
function statusSetOf(formula: string): Set<string> {
  const set = new Set<string>();
  const re = /\{Status\} = "([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(formula)) !== null) set.add(m[1]);
  return set;
}

// ── statusOrFormula primitive ───────────────────────────────────────────
test('statusOrFormula builds an OR of {Status} equalities', () => {
  assert.equal(
    statusOrFormula(['Intro Sent', 'Rancher Contacted']),
    'OR({Status} = "Intro Sent", {Status} = "Rancher Contacted")',
  );
});

test('statusOrFormula returns null for an empty list', () => {
  assert.equal(statusOrFormula([]), null);
  assert.equal(statusOrFormula(['', '  '].filter((s) => s.length === 0)), null);
});

// ── heldReferralsFormula (capacity-drift-check, batch-approve) ───────────
test('heldReferralsFormula lists exactly the HELD_REFERRAL_STATUSES', () => {
  const set = statusSetOf(heldReferralsFormula());
  assert.deepEqual(set, HELD_REFERRAL_STATUSES);
  // Exact string (sorted for stability).
  assert.equal(
    heldReferralsFormula(),
    'OR({Status} = "Awaiting Payment", {Status} = "Intro Sent", {Status} = "Negotiation", {Status} = "Rancher Contacted", {Status} = "Slot Locked")',
  );
});

test('heldReferralsFormula is a SUPERSET of the held-count JS predicate', () => {
  // JS predicate in both crons: HELD_REFERRAL_STATUSES.has(ref['Status']).
  const formulaSet = statusSetOf(heldReferralsFormula());
  for (const status of HELD_REFERRAL_STATUSES) {
    assert.equal(formulaSet.has(status), true, `held status ${status} must pass the formula`);
  }
});

// ── activeDealReferralsFormula (stuck-buyer-recovery) ────────────────────
test('activeDealReferralsFormula is a SUPERSET of isActiveDealReferral', () => {
  const formulaSet = statusSetOf(activeDealReferralsFormula());
  // Representative rows spanning every branch of isActiveDealReferral.
  const rows: Array<Record<string, any>> = [
    ...HELD_REFERRAL_STATUS_LIST.map((s) => ({ Status: s })),
    { Status: 'Pending Approval', Rancher: ['recR'] }, // active (linked)
    { Status: 'Pending Approval', 'Suggested Rancher': ['recS'] }, // active (linked)
  ];
  for (const row of rows) {
    if (isActiveDealReferral(row)) {
      assert.equal(
        formulaSet.has(String(row.Status)),
        true,
        `active-deal row (${row.Status}) must pass the formula`,
      );
    }
  }
  // And the formula must include Pending Approval so linked-Pending rows ship.
  assert.equal(formulaSet.has('Pending Approval'), true);
});

test('activeDealReferralsFormula covers the LOCKED_STATUSES too (email-sequences lock check)', () => {
  // email-sequences line ~337 keeps rows whose Status ∈ LOCKED_STATUSES for
  // the buyer. Every locked status is a held status, so this formula (used as
  // the shared active-deal read) is a superset of the lock predicate as well.
  const formulaSet = statusSetOf(activeDealReferralsFormula());
  for (const status of LOCKED_STATUSES) {
    assert.equal(formulaSet.has(status), true, `locked status ${status} must pass the formula`);
  }
});

// ── sequenceRancherMapReferralsFormula (email-sequences line ~251) ───────
test('sequenceRancherMapReferralsFormula covers both the closed-won and active-rancher map statuses', () => {
  const formulaSet = statusSetOf(sequenceRancherMapReferralsFormula());
  // closed-won map keeps 'Closed Won'; active map keeps these four.
  for (const s of ['Closed Won', 'Intro Sent', 'Rancher Contacted', 'Negotiation', 'Pending Approval']) {
    assert.equal(formulaSet.has(s), true, `${s} must pass the formula`);
  }
});

// ── dailyDigestReferralsFormula ─────────────────────────────────────────
test('dailyDigestReferralsFormula covers every status the digest stats read', () => {
  const formulaSet = statusSetOf(dailyDigestReferralsFormula());
  // pending, recentIntros, monthWins, stalled → these four statuses.
  for (const s of ['Pending Approval', 'Intro Sent', 'Rancher Contacted', 'Closed Won']) {
    assert.equal(formulaSet.has(s), true, `${s} must pass the formula`);
  }
});

// ── consumer formulas: exact strings (field-name safety) ────────────────
test('unsubscribedConsumersFormula references only {Unsubscribed}', () => {
  assert.equal(unsubscribedConsumersFormula(), '{Unsubscribed} = TRUE()');
});

test('mailableConsumersFormula drops exactly the three suppression flags (isMailable superset)', () => {
  assert.equal(
    mailableConsumersFormula(),
    'AND(NOT({Unsubscribed} = TRUE()), NOT({Bounced} = TRUE()), NOT({Complained} = TRUE()))',
  );
});

test('readyStuckBuyersFormula references only {Buyer Stage}', () => {
  assert.equal(readyStuckBuyersFormula(), '{Buyer Stage} = "READY"');
});
