// Tests for the slug-rename history helper (dashboard-audit rank 10).
// Invariants: newest-first, re-claim removes, dedupe, cap at 10.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendPreviousSlug } from './slugHistory';

test('appendPreviousSlug: first rename records the old slug', () => {
  assert.equal(appendPreviousSlug('', 'silverline-mo', 'silverline-cattle-co-mo'), 'silverline-mo');
});

test('appendPreviousSlug: subsequent renames prepend (newest first)', () => {
  assert.equal(
    appendPreviousSlug('oldest-slug', 'middle-slug', 'new-slug'),
    'middle-slug, oldest-slug',
  );
});

test('appendPreviousSlug: re-claiming an old slug stops redirecting it', () => {
  // Rancher renames a → b (history: a), then back b → a. 'a' is now the LIVE
  // slug and must leave the history; 'b' enters it.
  assert.equal(appendPreviousSlug('a', 'b', 'a'), 'b');
});

test('appendPreviousSlug: dedupes a slug already in the history', () => {
  assert.equal(appendPreviousSlug('b, a', 'a', 'c'), 'a, b');
});

test('appendPreviousSlug: caps at 10, dropping the oldest', () => {
  const existing = Array.from({ length: 10 }, (_, i) => `slug-${i}`).join(', ');
  const out = appendPreviousSlug(existing, 'fresh-old', 'fresh-new');
  const parts = out.split(', ');
  assert.equal(parts.length, 10);
  assert.equal(parts[0], 'fresh-old');
  assert.ok(!parts.includes('slug-9')); // oldest dropped
  assert.ok(parts.includes('slug-8'));
});

test('appendPreviousSlug: no-ops on blank/equal old slug + tolerates messy input', () => {
  assert.equal(appendPreviousSlug('kept', '', 'new'), 'kept');
  assert.equal(appendPreviousSlug('kept', 'new', 'new'), 'kept');
  // Messy separators + case + blanks normalize away.
  assert.equal(appendPreviousSlug('  A,b ,, c ', 'D', 'b'), 'd, a, c');
});
