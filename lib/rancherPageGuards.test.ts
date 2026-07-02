// lib/rancherPageGuards.test.ts
// Runner: JWT_SECRET=test-secret-ci npx tsx --test lib/rancherPageGuards.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  safeExternalUrl,
  heroPillText,
  formatCustomProductPrice,
  HERO_PILL_MAX_LEN,
} from './rancherPageGuards';

// ── safeExternalUrl ──────────────────────────────────────────────────────────

test('safeExternalUrl passes real http(s) URLs', () => {
  assert.equal(safeExternalUrl('https://instagram.com/renickvalley'), 'https://instagram.com/renickvalley');
  assert.equal(safeExternalUrl('http://facebook.com/foo'), 'http://facebook.com/foo');
});

test('safeExternalUrl rejects handles / statuses / bare words (the dead-link cases)', () => {
  assert.equal(safeExternalUrl('ZK Ranches'), '');       // handle typed as URL
  assert.equal(safeExternalUrl('coming soon'), '');
  assert.equal(safeExternalUrl('@renickvalley'), '');
  assert.equal(safeExternalUrl(''), '');
  assert.equal(safeExternalUrl('   '), '');
  assert.equal(safeExternalUrl(null), '');
  assert.equal(safeExternalUrl(undefined), '');
  assert.equal(safeExternalUrl(42), '');
});

test('safeExternalUrl rejects non-http schemes and hostless values', () => {
  assert.equal(safeExternalUrl('javascript:alert(1)'), '');
  assert.equal(safeExternalUrl('mailto:a@b.com'), '');
  assert.equal(safeExternalUrl('ftp://x.com'), '');
  assert.equal(safeExternalUrl('localhost'), '');        // no dot in host
});

// ── heroPillText ─────────────────────────────────────────────────────────────

test('heroPillText passes short single-line phrases', () => {
  assert.equal(heroPillText('Angus grass-fed'), 'Angus grass-fed');
  assert.equal(heroPillText('  Wagyu  '), 'Wagyu');
});

test('heroPillText rejects long or multi-line pastes (the hero-blowout case)', () => {
  assert.equal(heroPillText('x'.repeat(HERO_PILL_MAX_LEN + 1)), '');
  assert.equal(heroPillText('✔️ Grass-fed\n✔️ No hormones\n✔️ Pasture-raised'), '');
  assert.equal(heroPillText(''), '');
  assert.equal(heroPillText(null), '');
});

test('heroPillText keeps a value exactly at the limit', () => {
  const atLimit = 'x'.repeat(HERO_PILL_MAX_LEN);
  assert.equal(heroPillText(atLimit), atLimit);
});

// ── formatCustomProductPrice ─────────────────────────────────────────────────

test('formatCustomProductPrice shows a plain total when nothing signals per-lb', () => {
  assert.equal(formatCustomProductPrice(650, 'Whole hog', 'ready for the freezer'), '$650');
  assert.equal(formatCustomProductPrice(12.5, 'Bacon box', ''), '$12.50');
});

test('formatCustomProductPrice relabels per-lb when the rancher text says so', () => {
  assert.equal(formatCustomProductPrice(7.25, 'Ground beef', '$7.25/lb hanging weight'), '$7.25/lb');
  assert.equal(formatCustomProductPrice(7, 'Pork', 'per lb'), '$7/lb');
  assert.equal(formatCustomProductPrice(12.5, 'Ribeye per pound', ''), '$12.50/lb');
});

test('formatCustomProductPrice hides a non-positive / garbage price', () => {
  assert.equal(formatCustomProductPrice(0), '');
  assert.equal(formatCustomProductPrice(NaN), '');
  assert.equal(formatCustomProductPrice(-5, 'x', 'y'), '');
});
