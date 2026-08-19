import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Source pins for the PUBLIC rancher landing page — the paid-ads surface.
//
// Why grep-based: app/ranchers/[slug]/page.tsx is an async React Server
// Component that reaches Airtable at module scope; it cannot be imported under
// `tsx --test`. The decision logic it renders is unit-tested as pure data in
// lib/rancherAdSurface.test.ts — these pins exist purely to prove the page is
// WIRED to those helpers, so reverting the page (not the lib) still fails.
//
// WHAT THESE PROTECT (2026-08-18 live ad-readiness audit): every defect below
// was a claim that rendered unconditionally on a page we are about to put paid
// traffic behind.
//   1. og:image was always the logo → every FB/IG/LI preview was a b/w logo.
//   2. "✓ Verified partner" rendered for ranches that were never verified.
//   3. "Ships to <states>" rendered for ranches that do not ship.
//   4. "N shares left this round" was invented from a hardcoded default of 5.
//   6. "Reviews" pointed at a write-a-review sign-in wall.
//
// NOTE the path: this file deliberately lives OUTSIDE the [slug] directory.
// The npm test glob is 'app/**/*.test.ts' and a literal `[slug]` segment is
// read as a glob character class, so a test inside it is silently never
// collected (the 2026-08-02 missing-tests landmine).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(HERE, '[slug]', 'page.tsx'), 'utf8');
// The page carries a long audit trail in comments that quotes the very strings
// these pins count. Strip comments when the assertion is about what RENDERS.
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ── 1. og:image ──────────────────────────────────────────────────────────────

test('PIN: og:image comes from the shared picker, not a logo-wins expression', () => {
  assert.match(src, /from '@\/lib\/rancherAdSurface'/);
  const meta = src.slice(src.indexOf('export async function generateMetadata'));
  assert.match(meta, /pickOgImage\(rancher, name\)/, 'generateMetadata must delegate the og:image choice');
  assert.match(meta, /images: \[og\]/, 'and render exactly what the picker returned');
});

test('PIN: no hardcoded 800x600 og dimensions survive anywhere on the page', () => {
  // The real assets are 802x659 / 1000x1000 / 1500x541 — the old literal
  // mis-cropped every single preview.
  assert.doesNotMatch(src, /width:\s*800,\s*height:\s*600/);
});

test('PIN: the logo is no longer the unconditional og:image', () => {
  const meta = src.slice(src.indexOf('export async function generateMetadata'), src.indexOf('function formatProcessingDate'));
  assert.doesNotMatch(meta, /images:\s*logo\s*\n?\s*\?/, 'logo must not be the ternary head of the og image');
});

// ── 2. the verified pill ─────────────────────────────────────────────────────

test('PIN: the hero trust pill is derived, never hardcoded per-branch', () => {
  assert.match(src, /heroTrustPill\(/, 'the hero must ask the helper which pill it earned');
  const heroStart = src.indexOf('Verification + state pill row');
  assert.ok(heroStart > -1, 'the hero pill row must still exist');
  const heroRow = src.slice(heroStart, heroStart + 3000);
  assert.match(heroRow, /trustPill === 'verified'/, 'the Verified pill must sit behind the derived verdict');
  assert.doesNotMatch(
    heroRow,
    /:\s*\(\s*\n?\s*<Pill[\s\S]{0,400}?Verified partner/,
    'Verified partner must never be the else-branch fallthrough again',
  );
});

test('PIN: "Verified partner" is RENDERED exactly once (comments excluded)', () => {
  const hits = code.match(/Verified partner/g) || [];
  assert.equal(hits.length, 1, 'one gated render only — no second unconditional copy');
});

test('PIN: the represented-ranch pill survives and keeps the ruled wording', () => {
  assert.match(src, /Represented ranch/);
  // Terminology ruling in force (2026-08-18): a broker self-serve ranch is
  // "represented", never "verified"/"vetted".
  assert.doesNotMatch(src, /Verified ranch|Vetted (partner|ranch)/);
});

// ── 3. the fulfillment reach line ────────────────────────────────────────────

test('PIN: the quick-fact reach line is derived from Fulfillment Types', () => {
  assert.match(src, /reachLine\(/);
  assert.match(src, /reach\.label/, 'the strip must render the derived label');
  assert.match(src, /reach\.states/);
});

test('PIN: "Ships to" is never hardcoded into the quick-fact strip any more', () => {
  const stripStart = src.indexOf('QUICK FACTS STRIP');
  assert.ok(stripStart > -1);
  const strip = src.slice(stripStart, stripStart + 3000);
  assert.doesNotMatch(strip, />Ships to</, 'the ships claim must come from reachLine, not JSX text');
  assert.doesNotMatch(strip, /statesServed !== state/, 'the raw states gate moved into reachLine');
});

// ── 4. the scarcity badge ────────────────────────────────────────────────────

test('PIN: the scarcity badge requires an explicitly configured cap', () => {
  assert.match(src, /hasExplicitMaxActiveReferrals/);
  const scarcity = src.slice(src.indexOf('const sharesLeft'), src.indexOf('const sharesLeft') + 1200);
  assert.match(
    scarcity,
    /if \(!hasExplicitMaxActiveReferrals\(r\)\) return null;/,
    'a blank Max Active Referalls must yield NO badge — never the default-of-5 number',
  );
  // The routing/capacity math itself is untouched: the cap still comes from
  // the same reader every router uses.
  assert.match(scarcity, /getMaxActiveReferrals\(r\)/);
});

test('PIN: every scarcity render stays behind the sharesLeft verdict', () => {
  // The badge is rendered THREE times (hero chip, pricing block, reserve CTA).
  // Every one must gate on the same nullable verdict, or the blank-cap fix
  // only covers some of them and the invented number still reaches buyers.
  const copies = code.match(/left this (processing )?round/g) || [];
  const gates = code.match(/sharesLeft !== null && \(/g) || [];
  assert.equal(copies.length, 3, 'all three scarcity renders must still exist');
  assert.equal(gates.length, copies.length, 'one sharesLeft gate per scarcity render');
});

// ── 6. the Reviews link ──────────────────────────────────────────────────────

test('PIN: the Reviews link is filtered through the write-a-review guard', () => {
  assert.match(src, /readableReviewsUrl\(/);
  assert.doesNotMatch(
    src,
    /googleReviewsUrl = safeExternalUrl\(/,
    'safeExternalUrl alone let g.page/r/<cid>/review through as a "Reviews" link',
  );
});
