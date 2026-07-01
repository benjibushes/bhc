import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSupportReport, SUPPORT_CATEGORIES } from './supportIntake';

test('valid report normalizes email + category + message', () => {
  const r = validateSupportReport({
    email: '  Buyer@Example.COM ',
    category: 'refund-request',
    message: '  My beef arrived thawed and I want a refund please.  ',
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.normalized.email, 'buyer@example.com');
    assert.equal(r.normalized.category, 'refund-request');
    assert.equal(r.normalized.message, 'My beef arrived thawed and I want a refund please.');
    assert.equal(r.normalized.referralId, undefined);
  }
});

test('all declared categories are accepted', () => {
  for (const cat of SUPPORT_CATEGORIES) {
    const r = validateSupportReport({
      email: 'a@b.com',
      category: cat,
      message: 'This is a long enough message.',
    });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.normalized.category, cat);
  }
});

test('unknown category falls back to other', () => {
  const r = validateSupportReport({
    email: 'a@b.com',
    category: 'alien-invasion',
    message: 'This is a long enough message.',
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.normalized.category, 'other');
});

test('missing category falls back to other', () => {
  const r = validateSupportReport({
    email: 'a@b.com',
    message: 'This is a long enough message.',
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.normalized.category, 'other');
});

test('non-object body rejected', () => {
  assert.equal(validateSupportReport(null).ok, false);
  assert.equal(validateSupportReport('hi').ok, false);
  assert.equal(validateSupportReport(undefined).ok, false);
  assert.equal(validateSupportReport([1, 2]).ok, false);
});

test('missing email rejected', () => {
  const r = validateSupportReport({ message: 'This is a long enough message.' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /email/i);
});

test('malformed email rejected', () => {
  for (const bad of ['not-an-email', 'a@b', 'a b@c.com', '@c.com', 'a@.com', '']) {
    const r = validateSupportReport({ email: bad, message: 'This is a long enough message.' });
    assert.equal(r.ok, false, `expected reject for email: ${JSON.stringify(bad)}`);
  }
});

test('overlong email rejected', () => {
  const r = validateSupportReport({
    email: `${'a'.repeat(250)}@example.com`,
    message: 'This is a long enough message.',
  });
  assert.equal(r.ok, false);
});

test('message under 10 chars (after trim) rejected', () => {
  const r = validateSupportReport({ email: 'a@b.com', message: '   short    ' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /message/i);
});

test('missing / non-string message rejected', () => {
  assert.equal(validateSupportReport({ email: 'a@b.com' }).ok, false);
  assert.equal(validateSupportReport({ email: 'a@b.com', message: 42 }).ok, false);
});

test('message over 2000 chars rejected', () => {
  const r = validateSupportReport({ email: 'a@b.com', message: 'x'.repeat(2001) });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /message/i);
});

test('message at exactly 2000 chars accepted', () => {
  const r = validateSupportReport({ email: 'a@b.com', message: 'x'.repeat(2000) });
  assert.equal(r.ok, true);
});

test('message at exactly 10 chars accepted', () => {
  const r = validateSupportReport({ email: 'a@b.com', message: '1234567890' });
  assert.equal(r.ok, true);
});

test('valid referralId rec-id shape kept', () => {
  const r = validateSupportReport({
    email: 'a@b.com',
    message: 'This is a long enough message.',
    referralId: 'recAbCdEf12345678',
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.normalized.referralId, 'recAbCdEf12345678');
});

test('malformed referralId silently dropped, not rejected', () => {
  for (const bad of ['not-a-rec-id', 'rec123', 'rec<script>alert(1)</script>', 42, {}, '']) {
    const r = validateSupportReport({
      email: 'a@b.com',
      message: 'This is a long enough message.',
      referralId: bad,
    });
    assert.equal(r.ok, true, `expected ok with dropped referralId for: ${JSON.stringify(bad)}`);
    if (r.ok) assert.equal(r.normalized.referralId, undefined);
  }
});

test('referralId trimmed before shape check', () => {
  const r = validateSupportReport({
    email: 'a@b.com',
    message: 'This is a long enough message.',
    referralId: '  recAbCdEf12345678  ',
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.normalized.referralId, 'recAbCdEf12345678');
});
