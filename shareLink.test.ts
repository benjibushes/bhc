import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildShareLink } from '@/app/checkout/[refId]/success/page';

// Pure refer-a-friend deep-link builder used on the deposit success page.
// The link is what a buyer sends to the neighbor they want to split a cow
// with. It deep-links to the rancher's public page where the neighbor can
// reserve their own share. No ?ref attribution is appended — the rancher page
// consumes no buyer-referral ref param, so promising tracking we don't do
// would be dishonest (and the old ?ref always broke the link anyway because
// the slug was never available post-payment).

test('points at the rancher page (no fake ref param)', () => {
  assert.equal(
    buildShareLink('foodstead', 'rec123', 'https://buyhalfcow.com'),
    'https://buyhalfcow.com/ranchers/foodstead',
  );
});

test('falls back to /access when slug is unknown (never a dead link)', () => {
  assert.equal(
    buildShareLink(undefined, 'rec123', 'https://buyhalfcow.com'),
    'https://buyhalfcow.com/access',
  );
  assert.equal(
    buildShareLink('', 'rec123', 'https://buyhalfcow.com'),
    'https://buyhalfcow.com/access',
  );
});

test('ignores the referral id entirely (it is no longer attributed)', () => {
  assert.equal(
    buildShareLink('foodstead', '', 'https://buyhalfcow.com'),
    'https://buyhalfcow.com/ranchers/foodstead',
  );
});

test('produces a relative link when origin is unknown (SSR)', () => {
  assert.equal(
    buildShareLink('foodstead', 'rec123'),
    '/ranchers/foodstead',
  );
});

test('strips a trailing slash from origin to avoid a double slash', () => {
  assert.equal(
    buildShareLink('foodstead', 'rec123', 'https://buyhalfcow.com/'),
    'https://buyhalfcow.com/ranchers/foodstead',
  );
});

test('url-encodes a slug with unsafe characters', () => {
  assert.equal(
    buildShareLink('cattle & co', 'rec123', 'https://buyhalfcow.com'),
    'https://buyhalfcow.com/ranchers/cattle%20%26%20co',
  );
});
