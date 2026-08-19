// lib/campaignDedupeWindow.test.ts
//
// send-scheduled dedupes a bulk campaign against Email Sends rows tagged with
// that campaign. The query used to be unbounded — every row ever — so a
// permanent guarantee depended on a delivery log never expiring. Bounding it
// is what let the Email Sends window come down from 90d to 30d.
//
// The failure this guards is a DOUBLE BLAST to a real audience, so "cannot
// tell" must resolve to refuse.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { campaignDedupeWindow, DEDUPE_LOOKBEHIND_MS } from './campaignDedupeWindow';

const NOW = new Date('2026-08-19T12:00:00.000Z').getTime();
const RETENTION = 30;
const daysAgo = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

test('a campaign that started inside the window gets a usable dedupe bound', () => {
  const r = campaignDedupeWindow(daysAgo(3), NOW, RETENTION);
  assert.equal(r.ok, true);
  const since = new Date((r as any).sinceISO).getTime();
  assert.equal(since, NOW - 3 * 24 * 60 * 60 * 1000 - DEDUPE_LOOKBEHIND_MS);
});

test('the bound reaches slightly BEFORE the start, so a send at the boundary still counts', () => {
  const r = campaignDedupeWindow(daysAgo(1), NOW, RETENTION);
  const since = new Date((r as any).sinceISO).getTime();
  const start = NOW - 24 * 60 * 60 * 1000;
  assert.ok(since < start, 'a row written moments before the start must not be missed');
});

// ── the refusals ───────────────────────────────────────────────────────────

test('a campaign older than retention is REFUSED — its dedupe set is unknowable', () => {
  const r = campaignDedupeWindow(daysAgo(31), NOW, RETENTION);
  assert.equal(r.ok, false);
  assert.equal((r as any).reason, 'older-than-retention');
});

test('a missing or unparseable start is REFUSED, never treated as "send everything"', () => {
  for (const bad of ['', '   ', 'not-a-date', null, undefined, {}]) {
    const r = campaignDedupeWindow(bad, NOW, RETENTION);
    assert.equal(r.ok, false, `${JSON.stringify(bad)} must refuse`);
    assert.equal((r as any).reason, 'unknown-start');
  }
});

test('refusing is the SAFE direction — the alternative is emailing an audience twice', () => {
  // Documents the asymmetry the cron depends on: a stalled campaign can be
  // cloned and resumed by a human; a double blast cannot be recalled.
  const r = campaignDedupeWindow(daysAgo(90), NOW, RETENTION);
  assert.equal(r.ok, false);
});

// ── boundaries ─────────────────────────────────────────────────────────────

test('exactly at the retention edge is still trusted; a moment past it is not', () => {
  const edge = new Date(NOW - RETENTION * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(campaignDedupeWindow(edge, NOW, RETENTION).ok, true);
  const pastEdge = new Date(NOW - RETENTION * 24 * 60 * 60 * 1000 - 1).toISOString();
  assert.equal(campaignDedupeWindow(pastEdge, NOW, RETENTION).ok, false);
});

test('a FUTURE start is fine — a scheduled campaign has nothing to dedupe against yet', () => {
  const r = campaignDedupeWindow(new Date(NOW + 86_400_000).toISOString(), NOW, RETENTION);
  assert.equal(r.ok, true, 'only the past can fall out of the log');
});

test('a shorter retention refuses campaigns a longer one would allow', () => {
  const start = daysAgo(20);
  assert.equal(campaignDedupeWindow(start, NOW, 30).ok, true);
  assert.equal(campaignDedupeWindow(start, NOW, 14).ok, false, 'the window and the guard move together');
});
