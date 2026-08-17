// Unit pins for lib/heroImage — the responsive-source builder behind the
// /ranchers/[slug] hero cover (the LCP element on the paid-traffic landing
// page).
//
// The load-bearing property is the NEGATIVE one: an unknown host must come
// back byte-identical with no srcset. The cover URL is arbitrary and
// rancher-supplied, and a resize param a host doesn't honor can 404 the hero —
// trading a heavy photo for no photo at all.
//
// Synthetic ranch names / paths throughout — the repo is PUBLIC.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heroImageSources, HERO_COVER_SIZES } from './heroImage';

/** Every candidate in a srcset, as [url, widthDescriptor] pairs. */
function candidates(srcSet: string | undefined): Array<[string, string]> {
  assert.ok(srcSet, 'expected a srcset');
  return srcSet!.split(', ').map((entry) => {
    const parts = entry.split(' ');
    return [parts.slice(0, -1).join(' '), parts[parts.length - 1]];
  });
}

// ── Squarespace: ?format=<n>w ─────────────────────────────────────────────

test('squarespace: emits the canonical format=<n>w ladder + a bounded default src', () => {
  const url = 'https://images.squarespace-cdn.com/content/v1/abc123/pasture-at-dawn.jpg';
  const { src, srcSet } = heroImageSources(url);

  // Default src is bounded — never the unbounded original.
  assert.equal(src, `${url}?format=1500w`);

  const got = candidates(srcSet);
  assert.deepEqual(
    got.map(([, w]) => w),
    ['500w', '750w', '1000w', '1500w', '2500w'],
  );
  // The `w` descriptor must equal the width the param actually requests —
  // that equality is what the browser's candidate selection runs on.
  for (const [candidate, descriptor] of got) {
    const width = descriptor.replace('w', '');
    assert.equal(new URL(candidate).searchParams.get('format'), `${width}w`);
  }
  // Off-ladder values are SNAPPED UP by Squarespace (measured: 640w returns
  // the 750w bytes), so emitting one would advertise a width the CDN never
  // delivers — a descriptor that lies to the browser.
  assert.ok(!srcSet!.includes('640w'), 'no off-ladder Squarespace width');
});

test('squarespace: an existing format= param is OVERWRITTEN, not duplicated', () => {
  const { src, srcSet } = heroImageSources(
    'https://images.squarespace-cdn.com/content/v1/abc123/herd.jpg?format=2500w',
  );
  assert.equal(new URL(src).searchParams.getAll('format').length, 1);
  assert.equal(new URL(src).searchParams.get('format'), '1500w');
  for (const [candidate] of candidates(srcSet)) {
    assert.equal(new URL(candidate).searchParams.getAll('format').length, 1);
  }
});

test('squarespace: unrelated query params survive the rewrite', () => {
  const { src } = heroImageSources(
    'https://images.squarespace-cdn.com/content/v1/abc123/herd.jpg?content-type=image%2Fjpeg',
  );
  const u = new URL(src);
  assert.equal(u.searchParams.get('content-type'), 'image/jpeg');
  assert.equal(u.searchParams.get('format'), '1500w');
});

test('squarespace: sibling CDN hostnames in the family are covered', () => {
  const { srcSet } = heroImageSources(
    'https://images-static.squarespace-cdn.com/content/v1/abc123/barn.jpg',
  );
  assert.ok(srcSet && srcSet.includes('format=750w'));
});

// ── Shopify: ?width=<n> ───────────────────────────────────────────────────

test('shopify: emits the width=<n> ladder + a bounded default src', () => {
  const url = 'https://cdn.shopify.com/s/files/1/0000/0000/files/grazing.jpg';
  const { src, srcSet } = heroImageSources(url);
  assert.equal(src, `${url}?width=1500`);

  const got = candidates(srcSet);
  assert.deepEqual(
    got.map(([, w]) => w),
    ['640w', '1000w', '1500w', '2500w'],
  );
  for (const [candidate, descriptor] of got) {
    assert.equal(new URL(candidate).searchParams.get('width'), descriptor.replace('w', ''));
  }
});

test("shopify: the cache-busting ?v= param survives (it's part of the asset identity)", () => {
  const { src, srcSet } = heroImageSources(
    'https://cdn.shopify.com/s/files/1/0000/0000/files/grazing.jpg?v=1739935780',
  );
  assert.equal(new URL(src).searchParams.get('v'), '1739935780');
  assert.equal(new URL(src).searchParams.get('width'), '1500');
  for (const [candidate] of candidates(srcSet)) {
    assert.equal(new URL(candidate).searchParams.get('v'), '1739935780');
  }
});

test('shopify: matched EXACTLY — a merchant custom domain is not assumed to proxy width=', () => {
  const url = 'https://shop.example-ranch.com/cdn/shop/files/grazing.jpg';
  const out = heroImageSources(url);
  assert.equal(out.src, url);
  assert.equal(out.srcSet, undefined);
});

// ── Unknown hosts: PASSTHROUGH (the load-bearing case) ────────────────────

test('vercel blob passes through untouched with NO srcset', () => {
  const url = 'https://abc123.public.blob.vercel-storage.com/ranchers/rec000/cover.jpg';
  const out = heroImageSources(url);
  assert.equal(out.src, url);
  assert.equal(out.srcSet, undefined);
  assert.ok(!('srcSet' in out) || out.srcSet === undefined);
});

test('arbitrary third-party hosts pass through untouched — never invent a param', () => {
  for (const url of [
    'https://static.wixstatic.com/media/abc_123~mv2.jpg',
    'https://d111111abcdef8.cloudfront.net/ranch/hero.png',
    'https://www.example-ranch.com/photos/cattle.jpeg',
    'https://res.cloudinary.com/demo/image/upload/steer.jpg',
  ]) {
    const out = heroImageSources(url);
    assert.equal(out.src, url, `${url} must be returned byte-identical`);
    assert.equal(out.srcSet, undefined, `${url} must get no srcset`);
  }
});

test('a squarespace-lookalike host does not trigger the rewrite', () => {
  // Suffix matching must be on a dot boundary — "notsquarespace-cdn.com" is a
  // different registrable domain and must NOT be rewritten.
  const url = 'https://notsquarespace-cdn.com/content/v1/abc/x.jpg';
  const out = heroImageSources(url);
  assert.equal(out.src, url);
  assert.equal(out.srcSet, undefined);
});

// ── Degenerate input ──────────────────────────────────────────────────────

test('empty / null / undefined input yields an empty src and no srcset', () => {
  for (const input of ['', '   ', null, undefined]) {
    const out = heroImageSources(input);
    assert.equal(out.src, '');
    assert.equal(out.srcSet, undefined);
  }
});

test('unparseable or non-http(s) URLs pass through — the img onError handles them', () => {
  for (const url of ['not a url', '/local/relative.jpg', 'data:image/gif;base64,R0lGOD']) {
    const out = heroImageSources(url);
    assert.equal(out.src, url);
    assert.equal(out.srcSet, undefined);
  }
});

test('surrounding whitespace is trimmed off a rewritable URL', () => {
  const { src } = heroImageSources(
    '  https://images.squarespace-cdn.com/content/v1/abc123/x.jpg  ',
  );
  assert.equal(src, 'https://images.squarespace-cdn.com/content/v1/abc123/x.jpg?format=1500w');
});

// ── sizes ─────────────────────────────────────────────────────────────────

test('HERO_COVER_SIZES is full-bleed — the hero spans the viewport at every breakpoint', () => {
  assert.equal(HERO_COVER_SIZES, '100vw');
});
