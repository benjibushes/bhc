import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isReferralOnHold } from './referralHold';

const NOW = Date.parse('2026-07-28T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

test('isReferralOnHold: future Hold Until parks the row', () => {
  const future = new Date(NOW + 7 * DAY_MS).toISOString();
  assert.equal(isReferralOnHold(future, NOW), true);
});

test('isReferralOnHold: expired Hold Until releases the row', () => {
  const past = new Date(NOW - 1 * DAY_MS).toISOString();
  assert.equal(isReferralOnHold(past, NOW), false);
});

test('isReferralOnHold: blank / missing field is not held', () => {
  assert.equal(isReferralOnHold('', NOW), false);
  assert.equal(isReferralOnHold(null, NOW), false);
  assert.equal(isReferralOnHold(undefined, NOW), false);
});

test('isReferralOnHold: unparseable value fails OPEN (not held)', () => {
  // A corrupt value must never hide a live deal from the chasers forever.
  assert.equal(isReferralOnHold('not-a-date', NOW), false);
  assert.equal(isReferralOnHold('////', NOW), false);
});

test('isReferralOnHold: hold expiring exactly now is released (strict >)', () => {
  assert.equal(isReferralOnHold(new Date(NOW).toISOString(), NOW), false);
});

test('isReferralOnHold: one minute in the future still holds', () => {
  assert.equal(isReferralOnHold(new Date(NOW + 60_000).toISOString(), NOW), true);
});

test('isReferralOnHold: defaults nowMs to Date.now()', () => {
  const farFuture = new Date(Date.now() + 365 * DAY_MS).toISOString();
  const farPast = new Date(Date.now() - 365 * DAY_MS).toISOString();
  assert.equal(isReferralOnHold(farFuture), true);
  assert.equal(isReferralOnHold(farPast), false);
});
