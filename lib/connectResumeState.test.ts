import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueRequirementsFromEntries, connectHandoff } from './connectResumeState';

// The exact shape stripe@20.4.1 documents for V2 requirements.entries[].
const entry = (description: string, status: string, awaiting: string = 'user') => ({
  awaiting_action_from: awaiting,
  description,
  errors: [],
  impact: {},
  minimum_deadline: { status },
});

// ── dueRequirementsFromEntries ─────────────────────────────────────────────

test('reads the real due list off V2 requirements.entries', () => {
  const due = dueRequirementsFromEntries([
    entry('identity.business_details.url', 'past_due'),
    entry('identity.business_details.product_description', 'past_due'),
    entry('identity.attestations.terms_of_service.account', 'currently_due'),
  ]);
  assert.deepEqual(due, [
    'identity.business_details.url',
    'identity.business_details.product_description',
    'identity.attestations.terms_of_service.account',
  ]);
});

test('eventually_due is NOT counted as blocking', () => {
  const due = dueRequirementsFromEntries([
    entry('identity.id_numbers', 'eventually_due'),
    entry('identity.business_details.url', 'past_due'),
  ]);
  assert.deepEqual(due, ['identity.business_details.url']);
});

test('entries Stripe itself is working on are not the rancher’s problem', () => {
  const due = dueRequirementsFromEntries([
    entry('identity.verification', 'currently_due', 'stripe'),
    entry('identity.business_details.url', 'currently_due', 'user'),
  ]);
  assert.deepEqual(due, ['identity.business_details.url']);
});

test('duplicate descriptions collapse', () => {
  const due = dueRequirementsFromEntries([
    entry('identity.business_details.url', 'past_due'),
    entry('identity.business_details.url', 'currently_due'),
  ]);
  assert.deepEqual(due, ['identity.business_details.url']);
});

test('garbage / missing entries never throw and yield []', () => {
  for (const bad of [undefined, null, {}, 'nope', 42, [null], [{}], [{ description: 5 }]]) {
    assert.deepEqual(dueRequirementsFromEntries(bad as any), [], JSON.stringify(bad));
  }
});

test('regression: the OLD summary.currently_due read is gone — a summary-only payload yields nothing here', () => {
  // Proves the count no longer comes from a key V2 does not define.
  assert.deepEqual(dueRequirementsFromEntries({ currently_due: ['a', 'b'] } as any), []);
});

// ── connectHandoff ─────────────────────────────────────────────────────────

test('no account → never_started, nothing to resume', () => {
  const h = connectHandoff({ hasAccount: false, status: null });
  assert.equal(h.state, 'never_started');
  assert.equal(h.canResume, false);
  assert.equal(h.currentlyDueCount, 0);
  assert.ok(h.nextAction.length > 0);
});

test('active → active, no resume, no due items', () => {
  const h = connectHandoff({ hasAccount: true, status: 'active', currentlyDue: [] });
  assert.equal(h.state, 'active');
  assert.equal(h.canResume, false);
  assert.equal(h.currentlyDueCount, 0);
});

test('the real stalled-rancher case → incomplete, resumable, honest count', () => {
  // 5 Bar Beef / 2M Cattle / Rocky Ridge: stuck on Stripe screen one.
  const h = connectHandoff({
    hasAccount: true,
    status: 'restricted',
    canResumeOnboarding: true,
    currentlyDue: [
      'identity.business_details.product_description',
      'identity.business_details.url',
      'identity.attestations.terms_of_service.account',
    ],
  });
  assert.equal(h.state, 'incomplete');
  assert.equal(h.canResume, true);
  assert.equal(h.currentlyDueCount, 3);
  assert.match(h.nextAction, /3 things/);
});

test('mid-onboarding with nothing listed → still incomplete + resumable', () => {
  const h = connectHandoff({ hasAccount: true, status: 'onboarding', currentlyDue: [] });
  assert.equal(h.state, 'incomplete');
  assert.equal(h.canResume, true);
  assert.equal(h.currentlyDueCount, 0);
  assert.doesNotMatch(h.nextAction, /0 things/);
});

test('singular grammar when exactly one thing is due', () => {
  const h = connectHandoff({
    hasAccount: true,
    status: 'restricted',
    canResumeOnboarding: true,
    currentlyDue: ['identity.business_details.url'],
  });
  assert.match(h.nextAction, /1 thing\b/);
});

test('a Stripe-side hold → restricted, NOT resumable (an onboarding link cannot fix it)', () => {
  const h = connectHandoff({
    hasAccount: true,
    status: 'restricted',
    canResumeOnboarding: false,
    currentlyDue: [],
  });
  assert.equal(h.state, 'restricted');
  assert.equal(h.canResume, false);
  assert.match(h.nextAction, /Stripe dashboard|hold/i);
});

test('unknown status on an existing account degrades to resumable incomplete, never to active', () => {
  const h = connectHandoff({ hasAccount: true, status: null });
  assert.equal(h.state, 'incomplete');
  assert.equal(h.canResume, true);
  assert.notEqual(h.state, 'active');
});
