// K1 (conversion audit 2026-07-28) — redirect-param building for the
// reserve/order → /access fallback teleports. The URL must always carry an
// ?error= key that app/access/page.tsx's NOTICES map understands, so the buyer
// never lands on a pristine quiz with zero explanation of why their typed
// input vanished.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessFallbackUrl } from './accessFallbackUrl';

test('out_of_area with no slug → bare quiz + error param', () => {
  assert.equal(accessFallbackUrl('out_of_area'), '/access?error=out_of_area');
});

test('reserve_fallback re-pins the rancher AND carries the error param', () => {
  assert.equal(
    accessFallbackUrl('reserve_fallback', 'gift-farms'),
    '/access?rancher=gift-farms&error=reserve_fallback',
  );
});

test('reserve_fallback with no slug still carries the error param', () => {
  assert.equal(accessFallbackUrl('reserve_fallback'), '/access?error=reserve_fallback');
});

test('slug is URL-encoded (never breaks the query string)', () => {
  const url = accessFallbackUrl('reserve_fallback', 'a b&c');
  assert.equal(url, '/access?rancher=a+b%26c&error=reserve_fallback');
});

test('empty-string slug is treated as absent', () => {
  assert.equal(accessFallbackUrl('out_of_area', ''), '/access?error=out_of_area');
});
