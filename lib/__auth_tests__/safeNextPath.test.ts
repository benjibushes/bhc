import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeNextPath } from '@/lib/safeNextPath';

// Open-redirect validator for the ?next= param that rides the whole
// magic-link login flow (deposit page → login page → login route → emailed
// link → /member/verify page → post-auth redirect). `next` is fully
// buyer-controlled at every hop, so anything that isn't a same-origin
// relative path must clamp to /member — never redirect off-origin.

test('accepts a plain relative path', () => {
  assert.equal(safeNextPath('/member'), '/member');
  assert.equal(safeNextPath('/checkout/rec123/deposit'), '/checkout/rec123/deposit');
});

test('accepts path + query string', () => {
  assert.equal(
    safeNextPath('/checkout/rec123/deposit?cut=half'),
    '/checkout/rec123/deposit?cut=half',
  );
});

test('rejects absolute URLs', () => {
  assert.equal(safeNextPath('https://evil.com/phish'), '/member');
  assert.equal(safeNextPath('http://evil.com'), '/member');
});

test('rejects protocol-relative URLs (//evil.com)', () => {
  assert.equal(safeNextPath('//evil.com/phish'), '/member');
});

test('rejects embedded :// (parser-normalization bypasses)', () => {
  assert.equal(safeNextPath('/redirect?url=https://evil.com'), '/member');
});

test('rejects paths over 200 chars', () => {
  assert.equal(safeNextPath('/' + 'a'.repeat(200)), '/member');
});

test('rejects non-path junk, falls back to /member', () => {
  assert.equal(safeNextPath(null), '/member');
  assert.equal(safeNextPath(''), '/member');
  assert.equal(safeNextPath('checkout/rec123'), '/member');
});
