// lib/buyerEscalation.test.ts
//
// Regression coverage for the buyer sales arm's escalation logic. The tiering
// decides who gets escalated to a call vs worked by the machine, and the
// tier-aware email must never tell a paying customer to "reserve" again.
// Runner: JWT_SECRET=test-secret-ci npx tsx --test lib/buyerEscalation.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readinessTier, tierEmoji, readyToBuyEmail } from './buyerEscalation';

// ── readinessTier: signal precedence ────────────────────────────────────────

test('deposit paid → closing (already a customer, highest)', () => {
  assert.equal(readinessTier({ depositPaidAt: '2026-07-01T00:00:00Z' }), 'closing');
});

test('closing wins even when every other signal is set', () => {
  assert.equal(
    readinessTier({
      depositPaidAt: '2026-07-01T00:00:00Z',
      depositLinkOpenedAt: '2026-07-02T00:00:00Z',
      qualifiedAt: '2026-06-01T00:00:00Z',
    }),
    'closing',
  );
});

test('deposit link opened (unpaid) → hot', () => {
  assert.equal(readinessTier({ depositLinkOpenedAt: '2026-07-02T00:00:00Z' }), 'hot');
});

test('qualified OR response-ack (no deposit) → hot', () => {
  assert.equal(readinessTier({ qualifiedAt: '2026-06-01T00:00:00Z' }), 'hot');
  assert.equal(readinessTier({ responseAckAt: '2026-06-01T00:00:00Z' }), 'hot');
});

test('no signals → warm (never mis-escalates a blank buyer)', () => {
  assert.equal(readinessTier({}), 'warm');
});

test('blank / whitespace stamps do not count as present', () => {
  assert.equal(readinessTier({ depositPaidAt: '   ', qualifiedAt: '' }), 'warm');
});

test('tierEmoji is total (never throws on any tier)', () => {
  assert.equal(tierEmoji('closing'), '💰');
  assert.equal(tierEmoji('hot'), '🔥');
  assert.equal(tierEmoji('warm'), '🌡️');
});

// ── readyToBuyEmail: the send that goes to a ready buyer ─────────────────────

const CTX = { firstName: 'Sarah', rancherName: 'Renick Valley', depositUrl: 'https://www.buyhalfcow.com/deposit-x', calLink: 'https://cal.com/ben' };

test('closing tier NEVER tells a paid customer to reserve/lock/pay again', () => {
  const m = readyToBuyEmail(CTX, 'closing');
  assert.doesNotMatch(m.text, /reserve|lock it in|pay deposit|here.?s your spot/i);
  assert.match(m.text, /all set|pickup|coordinate/i);
});

test('closing tier does NOT leak a deposit URL even when one is in context', () => {
  const m = readyToBuyEmail(CTX, 'closing');
  assert.ok(!m.text.includes(CTX.depositUrl), 'paid customer must not get a fresh deposit link');
});

test('hot tier with a deposit URL sends the deposit link (fastest path)', () => {
  const m = readyToBuyEmail(CTX, 'hot');
  assert.ok(m.text.includes(CTX.depositUrl));
});

test('no deposit URL falls back to the cal link, never a dead deposit link', () => {
  const m = readyToBuyEmail({ firstName: 'Bob', rancherName: 'X', calLink: 'https://cal.com/ben' }, 'hot');
  assert.ok(m.text.includes('https://cal.com/ben'));
});

test('default tier is warm (matches readinessTier of a blank buyer)', () => {
  // no tier arg → warm behavior, i.e. call/reserve path, never the closing copy
  const m = readyToBuyEmail({ firstName: 'Jo', rancherName: 'Y', calLink: 'https://cal.com/ben' });
  assert.doesNotMatch(m.text, /all set|pickup/i);
});

test('every tier signs off as Ben and carries a subject', () => {
  for (const tier of ['closing', 'hot', 'warm'] as const) {
    const m = readyToBuyEmail(CTX, tier);
    assert.match(m.text, /—\s*Ben\s*$/);
    assert.ok(m.subject.length > 0);
  }
});

test('full name is reduced to first name in the greeting', () => {
  const m = readyToBuyEmail({ firstName: 'Sarah Jane Connor', rancherName: 'Z', calLink: 'https://cal.com/ben' }, 'hot');
  assert.match(m.text, /\bsarah\b/i);
  assert.doesNotMatch(m.text, /connor/i);
});

test('missing firstName does not produce "undefined" in the copy', () => {
  const m = readyToBuyEmail({ rancherName: 'Z', calLink: 'https://cal.com/ben' }, 'hot');
  assert.doesNotMatch(m.text, /undefined/);
});
