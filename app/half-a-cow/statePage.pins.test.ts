import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Source pins for /half-a-cow/[state]. The page is an async App Router server
// component that reads Airtable at module scope's edge and cannot be imported
// under `tsx --test`; the pricing decision it renders is unit-tested as pure
// data in lib/stateSeo.test.ts (zero / one / many ranchers all pinned there).
//
// WHAT THESE PROTECT (2026-08-18): the page published half beef at
// $3,300–$3,850 in every state — a NETWORK ASSUMPTION run through the pricing
// ladder — while the only live Arizona supply sells a half at $2,025–$2,363.
// Every AZ visitor was anchored ~60% above the real offer, and the page also
// promised the matched ranch is "pictured" when that ranch has no photos.
//
// NOTE the path: this file deliberately lives OUTSIDE the [state] directory.
// The npm test glob is 'app/**/*.test.ts' and a literal `[state]` segment
// reads as a glob character class, so a test inside it is silently never
// collected (the 2026-08-02 missing-tests landmine).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(HERE, '[state]', 'page.tsx'), 'utf8');

const body = src.slice(src.indexOf('export default async function HalfACowStatePage'));
const metadata = src.slice(
  src.indexOf('export async function generateMetadata'),
  src.indexOf('// ── Live counts'),
);

// ── the published range comes from live supply ─────────────────────────────

test('PIN: the page resolves its ranges off live supply, not the network band', () => {
  assert.match(body, /resolveShareRanges\(rancherPriceRows\)/);
  assert.match(body, /const r = shareRanges\.ranges;/);
  // The body must NOT reach for the network band directly any more — that is
  // resolveShareRanges' fallback to make, per tier.
  assert.doesNotMatch(body, /typicalShareRanges\(\)/);
});

test('PIN: the live-supply prices ride the SAME query the live count comes from', () => {
  // One read, one visibility rule (stateDiscoveryRanchersFormula). A second
  // query would be free to drift from what the page calls "live".
  const fetchFn = src.slice(src.indexOf('async function fetchStateCounts'), src.indexOf('// ── Page'));
  assert.match(fetchFn, /stateDiscoveryRanchersFormula\(s\.code, s\.name\)/);
  for (const field of ['Quarter Price', 'Quarter Price Max', 'Half Price', 'Half Price Max', 'Whole Price', 'Whole Price Max']) {
    assert.ok(fetchFn.includes(`'${field}'`), `must project ${field}`);
  }
  assert.match(fetchFn, /rancherPriceRows = records\.map\(/);
});

test('PIN: a failed supply read stays NULL (unknown), never an empty market', () => {
  const fetchFn = src.slice(src.indexOf('async function fetchStateCounts'), src.indexOf('// ── Page'));
  assert.match(fetchFn, /let rancherPriceRows: SupplyRancherRow\[\] \| null = null;/);
});

test('PIN: the FAQ + FAQPage JSON-LD quote the same resolved ranges as the table', () => {
  assert.match(body, /stateFaqs\(name, shareRanges\)/);
});

test('PIN: network-band rows are labelled when the rest of the table is live supply', () => {
  assert.match(body, /shareRanges\.fromSupply\.whole/);
  assert.match(body, /shareRanges\.fromSupply\.half/);
  assert.match(body, /shareRanges\.fromSupply\.quarter/);
  assert.match(body, /\(network typical\)/);
  assert.match(body, /shareRanges\.hasSupplyPricing/);
});

// ── copy truth ─────────────────────────────────────────────────────────────

test('PIN: the page never promises the matched ranch is "pictured"', () => {
  assert.doesNotMatch(src, /pictured/);
  assert.match(src, /named, and yours to talk to/);
});

test('PIN: the SERP description carries NO price figure at all', () => {
  // generateMetadata is PURE by contract (no Airtable — the prerender-timeout
  // build killer), so it CANNOT know what the ranches in this state charge.
  // Labelling the band "across our ranch network" was not enough: the snippet
  // Google shows is the first thing a buyer reads, the page body underneath it
  // is priced off LIVE supply, and on 11 of the 50 states the two disagreed —
  // Texas advertised $3,300–$3,850 in the snippet and rendered $3,240–$4,300 in
  // the table, anchoring the buyer low and landing them high.
  //
  // The fix is not a better caveat, it is no number: a description that is true
  // without one. Any price band belongs on the page, where live supply is
  // readable. Do not reintroduce fmtRange or a hardcoded $ figure here.
  // Assert on the CODE, not the prose: the comment above the description
  // quotes the two contradicting bands on purpose, and that history is worth
  // keeping readable.
  const metadataCode = metadata.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(metadataCode, /\$\d/, 'no dollar figure may appear in the description');
  assert.doesNotMatch(metadataCode, /fmtRange/, 'no derived price range in generateMetadata');
  assert.doesNotMatch(metadataCode, /typicalShareRanges/, 'the network band must not be reached for');
  assert.doesNotMatch(metadataCode, /shares run/);
  // The stripper must not be doing the work for us — the description itself
  // has to still be in what we asserted against.
  assert.match(metadataCode, /const description =/);
});

test('PIN: generateMetadata stays Airtable-free (the prerender build killer)', () => {
  for (const forbidden of ['fetchStateCounts', 'base(', 'await withTimeout', 'resolveShareRanges']) {
    assert.ok(!metadata.includes(forbidden), `generateMetadata must not call ${forbidden}`);
  }
});
