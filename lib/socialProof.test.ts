// lib/socialProof.test.ts
// Runner: JWT_SECRET=test-secret-ci npx tsx --test lib/socialProof.test.ts
//
// Pure-function coverage for the social-proof aggregates. The honesty rules
// under test: GMV rounds DOWN ("$30k+" from $30,800 — understate, never
// overstate), zero/invalid data yields empty labels (render-nothing, never a
// zero-claim), and the /wins hygiene filter (rancher link + Sale Amount > 0)
// is applied identically.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatGmvLabel,
  buildLatestWinLabel,
  summarizeClosedWonRefs,
  summarizeClosedWonRefsInWindow,
} from './socialProof';

// ── formatGmvLabel ──────────────────────────────────────────────────────────

test('formatGmvLabel: floors to $Nk+ — understates, never overstates', () => {
  assert.equal(formatGmvLabel(30_800), '$30k+');
  assert.equal(formatGmvLabel(30_999), '$30k+');
  assert.equal(formatGmvLabel(31_000), '$31k+');
  assert.equal(formatGmvLabel(1_999), '$1k+');
});

test('formatGmvLabel: under $1k shows exact dollars with no "+"', () => {
  assert.equal(formatGmvLabel(750), '$750');
});

test('formatGmvLabel: zero/negative/NaN yield empty (render nothing, no zero-claim)', () => {
  assert.equal(formatGmvLabel(0), '');
  assert.equal(formatGmvLabel(-5), '');
  assert.equal(formatGmvLabel(NaN), '');
});

// ── buildLatestWinLabel ─────────────────────────────────────────────────────

test('buildLatestWinLabel: full label — lowercase type + month, uppercase state', () => {
  assert.equal(
    buildLatestWinLabel('Half', 'tx', '2026-07-10T00:00:00.000Z'),
    'half cow — TX, jul 2026',
  );
});

test('buildLatestWinLabel: share tiers read as "<tier> cow"; other types pass through lowercased', () => {
  assert.equal(buildLatestWinLabel('Quarter', 'MO', ''), 'quarter cow — MO');
  assert.equal(buildLatestWinLabel('Beef', 'MO', ''), 'beef — MO');
});

test('buildLatestWinLabel: missing state/date segments drop — never placeholders', () => {
  assert.equal(buildLatestWinLabel('Half', '', 'not-a-date'), 'half cow');
  assert.equal(buildLatestWinLabel('Half', '', '2026-07-10'), 'half cow — jul 2026');
});

// ── summarizeClosedWonRefs ──────────────────────────────────────────────────

const ref = (over: Record<string, any> = {}) => ({
  Rancher: ['recRANCHERAAAAAAA1'],
  'Sale Amount': 1000,
  'Order Type': 'Half',
  'Buyer State': 'TX',
  'Closed At': '2026-07-01T00:00:00.000Z',
  ...over,
});

test('summarize: counts, sums GMV, credits the primary linked rancher', () => {
  const s = summarizeClosedWonRefs([
    ref(),
    ref({ 'Sale Amount': 750, Rancher: ['recRANCHERBBBBBBB2'] }),
    ref({ 'Sale Amount': 2050 }),
  ]);
  assert.equal(s.deals, 3);
  assert.equal(s.gmv, 3800);
  assert.equal(s.gmvLabel, '$3k+');
  assert.equal(s.dealsByRancher['recRANCHERAAAAAAA1'], 2);
  assert.equal(s.dealsByRancher['recRANCHERBBBBBBB2'], 1);
});

test('summarize: Hide From Wins rows never count — matches the /wins wall exactly', () => {
  // 2026-08-13 sweep: /shop claimed "26 deals · $41k+" vs /wins' 24 · $38,631
  // because 2 superseded duplicate rows (flagged Hide From Wins on 2026-08-10)
  // were excluded from the wall but still counted here. Flagged rows must
  // drop from counts, GMV, per-rancher credit, AND the latest-win label.
  const s = summarizeClosedWonRefs([
    // Mid-month timestamp: buildLatestWinLabel formats in the runner's local
    // timezone, so a midnight-UTC 1st-of-month would render as the prior
    // month on US machines (same convention as the latest-win test below).
    ref({ 'Sale Amount': 2000, 'Closed At': '2026-07-10T12:00:00.000Z' }),
    ref({ 'Sale Amount': 2000, 'Hide From Wins': true }),
    ref({
      'Sale Amount': 500,
      'Hide From Wins': true,
      'Closed At': '2026-08-10T12:00:00.000Z', // newest — must NOT become latest win
      'Order Type': 'Whole',
      'Buyer State': 'MT',
    }),
  ]);
  assert.equal(s.deals, 1);
  assert.equal(s.gmv, 2000);
  assert.equal(s.dealsByRancher['recRANCHERAAAAAAA1'], 1);
  assert.equal(s.latestWinLabel, 'half cow — TX, jul 2026');
});

test('summarize: /wins hygiene filter — no rancher link or non-positive sale never counts', () => {
  const s = summarizeClosedWonRefs([
    ref({ Rancher: undefined, 'Suggested Rancher': undefined }),
    ref({ 'Sale Amount': 0 }),
    ref({ 'Sale Amount': -50 }),
  ]);
  assert.equal(s.deals, 0);
  assert.equal(s.gmvLabel, '');
  assert.equal(s.latestWinLabel, null);
});

test('summarize: Suggested Rancher link counts when Rancher is empty (same fallback as /wins)', () => {
  const s = summarizeClosedWonRefs([
    ref({ Rancher: undefined, 'Suggested Rancher': ['recRANCHERCCCCCCC3'] }),
  ]);
  assert.equal(s.deals, 1);
  assert.equal(s.dealsByRancher['recRANCHERCCCCCCC3'], 1);
});

test('summarize: latest win is the newest Closed At', () => {
  const s = summarizeClosedWonRefs([
    ref({ 'Closed At': '2026-05-01', 'Order Type': 'Quarter', 'Buyer State': 'MO' }),
    ref({ 'Closed At': '2026-07-10', 'Order Type': 'Half', 'Buyer State': 'TX' }),
    ref({ 'Closed At': '2026-06-15', 'Order Type': 'Whole', 'Buyer State': 'NE' }),
  ]);
  assert.equal(s.latestWinLabel, 'half cow — TX, jul 2026');
});

test('summarize: empty input → zeroed stats (components gate on deals > 0)', () => {
  const s = summarizeClosedWonRefs([]);
  assert.equal(s.deals, 0);
  assert.equal(s.gmv, 0);
  assert.equal(s.latestWinLabel, null);
  assert.deepEqual(s.dealsByRancher, {});
});

// ── summarizeClosedWonRefsInWindow (network pulse, 2026-07-15) ──────────────

const NOW = Date.parse('2026-07-15T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

test('window: only rows with Closed At inside the trailing 7 days count', () => {
  const s = summarizeClosedWonRefsInWindow(
    [
      ref({ 'Closed At': new Date(NOW - 2 * DAY).toISOString(), 'Sale Amount': 1950 }),
      ref({ 'Closed At': new Date(NOW - 6 * DAY).toISOString(), 'Sale Amount': 1050 }),
      ref({ 'Closed At': new Date(NOW - 8 * DAY).toISOString(), 'Sale Amount': 3700 }), // out
      ref({ 'Closed At': new Date(NOW - 40 * DAY).toISOString(), 'Sale Amount': 900 }), // out
    ],
    NOW,
  );
  assert.equal(s.deals, 2);
  assert.equal(s.gmv, 3000);
  assert.equal(s.gmvLabel, '$3k+');
});

test('window: exact-boundary close (cutoff instant) still counts — 7 full days', () => {
  const s = summarizeClosedWonRefsInWindow(
    [ref({ 'Closed At': new Date(NOW - 7 * DAY).toISOString() })],
    NOW,
  );
  assert.equal(s.deals, 1);
});

test('window: missing/unparseable Closed At is excluded — cannot prove recency', () => {
  const s = summarizeClosedWonRefsInWindow(
    [ref({ 'Closed At': '' }), ref({ 'Closed At': 'not-a-date' })],
    NOW,
  );
  assert.equal(s.deals, 0);
  assert.equal(s.gmvLabel, '');
});

test('window: slightly-future Closed At counts (date-only stamps parse to midnight UTC)', () => {
  const s = summarizeClosedWonRefsInWindow(
    [ref({ 'Closed At': new Date(NOW + 6 * 60 * 60 * 1000).toISOString() })],
    NOW,
  );
  assert.equal(s.deals, 1);
});

test('window: zero-deal week → deals 0 with empty label (caller falls back to all-time)', () => {
  const s = summarizeClosedWonRefsInWindow(
    [ref({ 'Closed At': new Date(NOW - 30 * DAY).toISOString() })],
    NOW,
  );
  assert.equal(s.deals, 0);
  assert.equal(s.gmvLabel, '');
});

test('window: same hygiene filter as all-time — no rancher link / no sale never counts', () => {
  const s = summarizeClosedWonRefsInWindow(
    [
      ref({
        'Closed At': new Date(NOW - DAY).toISOString(),
        Rancher: undefined,
        'Suggested Rancher': undefined,
      }),
      ref({ 'Closed At': new Date(NOW - DAY).toISOString(), 'Sale Amount': 0 }),
    ],
    NOW,
  );
  assert.equal(s.deals, 0);
});

test('window: custom window length is honored (30-day window picks up older closes)', () => {
  const rows = [ref({ 'Closed At': new Date(NOW - 20 * DAY).toISOString() })];
  assert.equal(summarizeClosedWonRefsInWindow(rows, NOW, 7).deals, 0);
  assert.equal(summarizeClosedWonRefsInWindow(rows, NOW, 30).deals, 1);
});
