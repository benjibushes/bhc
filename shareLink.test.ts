import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildShareLink } from '@/app/checkout/[refId]/success/page';

// Pure refer-a-friend deep-link builder used on the deposit success page.
// The link is what a buyer sends to the neighbor they want to split a cow
// with, attributed back to the buyer via ?ref.

test('points at the rancher page with the buyer ref attribution', () => {
  assert.equal(
    buildShareLink('foodstead', 'rec123', 'https://buyhalfcow.com'),
    'https://buyhalfcow.com/ranchers/foodstead?ref=rec123',
  );
});

test('falls back to /access when slug is unknown (never a dead link)', () => {
  assert.equal(
    buildShareLink(undefined, 'rec123', 'https://buyhalfcow.com'),
    'https://buyhalfcow.com/access?ref=rec123',
  );
  assert.equal(
    buildShareLink('', 'rec123', 'https://buyhalfcow.com'),
    'https://buyhalfcow.com/access?ref=rec123',
  );
});

test('omits the ref param when there is no referral id', () => {
  assert.equal(
    buildShareLink('foodstead', '', 'https://buyhalfcow.com'),
    'https://buyhalfcow.com/ranchers/foodstead',
  );
});

test('produces a relative link when origin is unknown (SSR)', () => {
  assert.equal(
    buildShareLink('foodstead', 'rec123'),
    '/ranchers/foodstead?ref=rec123',
  );
});

test('strips a trailing slash from origin to avoid a double slash', () => {
  assert.equal(
    buildShareLink('foodstead', 'rec123', 'https://buyhalfcow.com/'),
    'https://buyhalfcow.com/ranchers/foodstead?ref=rec123',
  );
});

test('url-encodes a slug with unsafe characters', () => {
  assert.equal(
    buildShareLink('cattle & co', 'rec123', 'https://buyhalfcow.com'),
    'https://buyhalfcow.com/ranchers/cattle%20%26%20co?ref=rec123',
  );
});
