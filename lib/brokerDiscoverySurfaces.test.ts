// WAVE A (2026-08-17) — SELF-SERVE BROKER SUPPLY IS VISIBLE ON EVERY
// DISCOVERY SURFACE.
//
// PR #628 made a self-serve represented ranch ROUTABLE; this file pins the
// companion: the DISCOVERY surfaces — /access/[state], /half-a-cow/[state],
// /map, and the getActiveRancherPages set (sitemap, /ranchers,
// /api/public/ranchers, /start, /wholesale) — admit it too, through ONE
// shared carve-out fragment (lib/brokerRail) instead of five hand-copied
// strings, so the next rail change edits one place.
//
// THE INVARIANT (both directions, every surface):
//   • broker + `Broker Self Serve`          → VISIBLE;
//   • broker WITHOUT the box (token-only)   → INVISIBLE. Unchecked, the field
//     is OMITTED from Airtable payloads and reads blank; {Broker Self Serve}=1
//     is false for blank, so the formulas fail closed natively;
//   • non-broker ranchers                   → byte-unchanged.
//
// Exact-string convention as lib/rancherSlugFormula.test.ts /
// lib/airtableReadPath.test.ts: field names must be real and long-standing —
// a typo'd field errors the WHOLE query, which on these reads = a state page
// claiming zero supply, an empty map, a deploy with zero rancher pages.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  BROKER_RAIL_EXCLUSION_FORMULA,
  BROKER_SELF_SERVE_CARVE_OUT_FORMULA,
  BROKER_SELF_SERVE_PAGE_LIVE_FORMULA,
} from './brokerRail';
import {
  activeRancherPagesFormula,
  stateDiscoveryRanchersFormula,
  mapPinsFormula,
  rancherOrProspectBySlugFormula,
} from './airtable';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

// ─────────────────────────────────────────────────────────────────────────────
// The shared fragments — the ONE edit point
// ─────────────────────────────────────────────────────────────────────────────

test('carve-out fragment: exact string — the first arm IS the old blanket exclusion', () => {
  assert.equal(
    BROKER_SELF_SERVE_CARVE_OUT_FORMULA,
    'OR(NOT({Broker Rail} = 1), {Broker Self Serve} = 1)',
  );
  // Composed from, not parallel to, the blanket fragment — one doctrine home.
  assert.ok(BROKER_SELF_SERVE_CARVE_OUT_FORMULA.includes(BROKER_RAIL_EXCLUSION_FORMULA));
});

test('page-live fragment: broker AND self-serve — a stray tick on a non-broker publishes nothing', () => {
  assert.equal(
    BROKER_SELF_SERVE_PAGE_LIVE_FORMULA,
    'AND({Broker Rail} = 1, {Broker Self Serve} = 1)',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// getActiveRancherPages — sitemap, /ranchers, /api/public/ranchers, /start,
// /wholesale, generateStaticParams, all in one read
// ─────────────────────────────────────────────────────────────────────────────

test('activeRancherPagesFormula: exact string — carve-out in, blanket exclusion gone', () => {
  assert.equal(
    activeRancherPagesFormula(),
    'AND(OR({Page Live} = 1, AND({Broker Rail} = 1, {Broker Self Serve} = 1)), ' +
      'NOT({Public Map Hidden} = 1), {Verification Status} != "Removed", ' +
      'OR(NOT({Broker Rail} = 1), {Broker Self Serve} = 1))',
  );
});

test('activeRancherPagesFormula: both directions — self-serve admitted, token-only fails both arms', () => {
  const f = activeRancherPagesFormula();
  // INCLUDED: a self-serve broker ranch passes the carve-out AND is page-live
  // by definition of the opt-in (its {Page Live} is unset — never ran the wizard).
  assert.ok(f.includes(BROKER_SELF_SERVE_CARVE_OUT_FORMULA));
  assert.ok(f.includes(`OR({Page Live} = 1, ${BROKER_SELF_SERVE_PAGE_LIVE_FORMULA})`));
  // EXCLUDED: the ONLY broker-rail mention is the arm inside the carve-out —
  // no standalone blanket exclusion survives to veto the self-serve ranch,
  // and a token-only ranch fails both OR arms.
  assert.equal(count(f, 'NOT({Broker Rail} = 1)'), 1);
  // Connect ranchers unchanged: the hard gates still bite unconditionally.
  assert.ok(f.includes('NOT({Public Map Hidden} = 1)'));
  assert.ok(f.includes('{Verification Status} != "Removed"'));
});

test('WIRING getActiveRancherPages: reads through the shared builder', () => {
  assert.ok(src('lib/airtable.ts').includes('filterByFormula: activeRancherPagesFormula()'));
});

// ─────────────────────────────────────────────────────────────────────────────
// /access/[state] + /half-a-cow/[state] — ONE builder so the two pages (and
// lib/stateSupply's JS mirror) can never disagree about who is public supply
// ─────────────────────────────────────────────────────────────────────────────

test('stateDiscoveryRanchersFormula: exact string for AZ — the launch state', () => {
  assert.equal(
    stateDiscoveryRanchersFormula('AZ', 'Arizona'),
    'AND(OR({Page Live} = 1, AND({Broker Rail} = 1, {Broker Self Serve} = 1)), ' +
      'NOT({Public Map Hidden} = 1), {Verification Status} != "Removed", ' +
      'OR(NOT({Broker Rail} = 1), {Broker Self Serve} = 1), ' +
      'OR(UPPER({State}) = "AZ", UPPER({State}) = "ARIZONA"))',
  );
});

test('stateDiscoveryRanchersFormula: both directions + unnormalized-{State} match preserved', () => {
  const f = stateDiscoveryRanchersFormula('az', 'Arizona');
  assert.ok(f.includes(BROKER_SELF_SERVE_CARVE_OUT_FORMULA), 'self-serve broker ranch admitted');
  assert.equal(count(f, 'NOT({Broker Rail} = 1)'), 1, 'token-only excluded — no surviving blanket');
  // {State} is unnormalized in places (code vs full name) — both stay matched,
  // case-insensitively, whatever case the caller passes.
  assert.ok(f.includes('OR(UPPER({State}) = "AZ", UPPER({State}) = "ARIZONA")'));
});

test('stateDiscoveryRanchersFormula: escapes injection like every sibling builder', () => {
  assert.ok(
    stateDiscoveryRanchersFormula('x"\\y', 'a"b').includes('UPPER({State}) = "X\\"\\\\Y"'),
  );
});

test('WIRING /access/[state]: uses the shared builder, no hand-rolled broker exclusion', () => {
  const page = src('app/access/[state]/page.tsx');
  assert.ok(page.includes('stateDiscoveryRanchersFormula('));
  assert.ok(!page.includes('NOT({Broker Rail}'), '/access/az must show the AZ broker ranch');
});

test('WIRING /half-a-cow/[state]: uses the SAME builder, no hand-rolled broker exclusion', () => {
  const page = src('app/half-a-cow/[state]/page.tsx');
  assert.ok(page.includes('stateDiscoveryRanchersFormula('));
  assert.ok(
    !page.includes('NOT({Broker Rail}'),
    '/half-a-cow/arizona must count the AZ broker ranch, not render "we\'re recruiting"',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// /map — the loosest public surface (no Page Live gate at all)
// ─────────────────────────────────────────────────────────────────────────────

test('mapPinsFormula: exact string — carve-out in, every hard gate intact', () => {
  assert.equal(
    mapPinsFormula(),
    'AND({Verification Status} != "Removed", NOT({Public Map Hidden} = 1), ' +
      'OR(NOT({Broker Rail} = 1), {Broker Self Serve} = 1), ' +
      '{Active Status} != "Paused", {Active Status} != "Non-Compliant", ' +
      '{Latitude} != BLANK(), {Longitude} != BLANK())',
  );
});

test('mapPinsFormula: both directions — and the blank-Active-Status trap stays documented-true', () => {
  const f = mapPinsFormula();
  assert.ok(f.includes(BROKER_SELF_SERVE_CARVE_OUT_FORMULA), 'self-serve broker pin plots');
  // A broker ranch's Active Status is blank, which PASSES both != checks —
  // the carve-out is the only thing keeping token-only ranches off the map.
  assert.equal(count(f, 'NOT({Broker Rail} = 1)'), 1, 'token-only stays unplottable');
  assert.ok(f.includes('{Active Status} != "Paused"'));
  assert.ok(f.includes('{Latitude} != BLANK()'));
});

test('WIRING /map: uses the shared builder, no hand-rolled broker exclusion', () => {
  const page = src('app/map/page.tsx');
  assert.ok(page.includes('mapPinsFormula('));
  assert.ok(!page.includes('NOT({Broker Rail}'));
});

// ─────────────────────────────────────────────────────────────────────────────
// The #617 slug resolver composes the SAME fragments — one edit point, proven
// ─────────────────────────────────────────────────────────────────────────────

test('rancherOrProspectBySlugFormula: built from the shared fragments (mutating one mutates all)', () => {
  const f = rancherOrProspectBySlugFormula('gila-river-cattle');
  assert.ok(f.includes(BROKER_SELF_SERVE_CARVE_OUT_FORMULA));
  assert.ok(f.includes(BROKER_SELF_SERVE_PAGE_LIVE_FORMULA));
});
