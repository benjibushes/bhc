// app/rancher/ProductsTab — wiring pins for the ask-banner gaps (#623
// follow-up, doors wave 2026-08-18).
//
// The DECISION is pure and tested in lib/productAskBanner.test.ts. These
// source pins hold the component to actually USING it — without them the lib
// tests could stay green while ProductsTab quietly reverts to the
// `editingId ? openAsks : []` ternary that hid the banner from the duplicate
// flow, or goes back to discarding `data.missing` from a 400.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(HERE, 'ProductsTab.tsx'), 'utf8');

test('PIN: the banner derives from askBannerAsks, not the edit-only ternary', () => {
  assert.match(src, /from '@\/lib\/productAskBanner'/);
  assert.match(src, /const asking = askBannerAsks\(/);
  assert.doesNotMatch(
    src,
    /const asking = editingId \? openAsks : \[\]/,
    'the edit-only ternary is the exact bug: duplicates of legacy rows got no banner',
  );
});

test('PIN: startDuplicate raises the seeded flag; startAdd/startEdit lower it', () => {
  const dup = src.slice(src.indexOf('function startDuplicate'), src.indexOf('// ── Connect gate'));
  assert.match(dup, /setSeededFromExisting\(true\)/);
  const add = src.slice(src.indexOf('function startAdd'), src.indexOf('function startEdit'));
  assert.match(add, /setSeededFromExisting\(false\)/);
  const edit = src.slice(src.indexOf('function startEdit'), src.indexOf('async function uploadPhoto'));
  assert.match(edit, /setSeededFromExisting\(false\)/);
});

test('PIN: save() feeds a 400\'s `missing` into the banner state instead of dropping it', () => {
  const save = src.slice(src.indexOf('async function save()'), src.indexOf('async function saveStock'));
  assert.match(save, /Array\.isArray\(data\.missing\)/);
  assert.match(save, /setRejectedMissing\(data\.missing\)/);
});

test('PIN: every fresh form session clears the rejection latch', () => {
  for (const fn of ['function startAdd', 'function startEdit', 'function startDuplicate']) {
    const start = src.indexOf(fn);
    const body = src.slice(start, src.indexOf('setShowForm(true)', start));
    assert.match(body, /setRejectedMissing\(\[\]\)/, `${fn} must clear rejectedMissing`);
  }
});
