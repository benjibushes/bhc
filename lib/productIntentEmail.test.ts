import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireBuyerEmail, INTENT_EMAIL_MAX } from './productIntentEmail';

// ──────────────────────────────────────────────────────────────────────────
// Money-path lock (friction cuts 2026-08-02): the product intent mint MUST
// refuse to create a chargeable PaymentIntent without a deliverable buyer
// email. Before this gate, `email: ''` passed the route's shape check and a
// paid order could settle with no receipt/tracking address.
// ──────────────────────────────────────────────────────────────────────────

test('missing email is refused (the receipt-less-order hole)', () => {
  for (const raw of [undefined, null, '', '   ']) {
    const r = requireBuyerEmail(raw);
    assert.equal(r.ok, false);
  }
});

test('non-string bodies are refused, never coerced', () => {
  for (const raw of [42, {}, ['a@b.co'], true]) {
    const r = requireBuyerEmail(raw);
    assert.equal(r.ok, false);
  }
});

test('malformed shapes are refused with the check-it message', () => {
  for (const raw of ['plainstring', 'no-at-sign.com', 'a@b', 'a @b.co', '@b.co', 'a@']) {
    const r = requireBuyerEmail(raw);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /doesn't look right/);
  }
});

test('oversized email is refused (route previously capped at 200)', () => {
  const long = `${'a'.repeat(INTENT_EMAIL_MAX)}@example.com`;
  const r = requireBuyerEmail(long);
  assert.equal(r.ok, false);
});

test('valid email passes, trimmed + lowercased for metadata.buyerEmail', () => {
  const r = requireBuyerEmail('  Buyer@Example.COM ');
  assert.deepEqual(r, { ok: true, email: 'buyer@example.com' });
});

test('plus-addressing and subdomains pass (real buyers use them)', () => {
  for (const raw of ['a+tag@example.com', 'a.b@mail.example.co.uk']) {
    const r = requireBuyerEmail(raw);
    assert.equal(r.ok, true);
  }
});
