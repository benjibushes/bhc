// lib/productAskBanner — ask-banner visibility pins (#623 follow-up,
// doors wave 2026-08-18).
//
// WHAT THESE PROTECT: the edit-wall fix (#623) shows a rancher EVERY missing
// legacy answer up front — but only in edit mode (`editingId ? openAsks : []`).
// Two flows fell through that ternary:
//   1. DUPLICATE: startDuplicate seeds the form from an existing product but
//      sets editingId=null (it POSTs a new row) — a copy of a pre-#524 legacy
//      listing carried the same blanks with NO banner, and the rancher
//      rediscovered them one prose 400 at a time.
//   2. 400-with-missing: save() threw away `data.missing` from the API's 400
//      payload and showed only `data.error` — any rejection explained itself
//      one field per round-trip instead of the full set on one screen.
// askBannerAsks is the ONE decision both the banner and the red field marks
// derive from: visible in edit mode, in a seeded-from-existing (duplicate)
// form, or after a 400 that named missing answers — and its CONTENT is always
// the live openAsks recompute, so an answer clears its line the moment it is
// typed. A truly blank add form (none of the three) stays banner-free — the
// `*` markers cover it and a warning over an empty form is noise.
//
// Mutation pin: reverting ProductsTab to `editingId ? openAsks : []` (or
// making this helper ignore seeded/rejected) fails the duplicate and
// 400-with-missing tests below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askBannerAsks } from './productAskBanner';

const BOTH = ['shipsInDays', 'shippingChoice'] as const;

test('edit mode shows the open asks (the original #623 behavior, unchanged)', () => {
  assert.deepEqual(
    askBannerAsks({ editing: true, seededFromExisting: false, rejectedMissing: [], openAsks: [...BOTH] }),
    [...BOTH],
  );
});

test('PIN: a duplicate of a legacy row shows the banner (seeded form, editingId null)', () => {
  assert.deepEqual(
    askBannerAsks({ editing: false, seededFromExisting: true, rejectedMissing: [], openAsks: [...BOTH] }),
    [...BOTH],
  );
});

test('PIN: a 400 that named missing answers surfaces the full set on one screen', () => {
  assert.deepEqual(
    askBannerAsks({ editing: false, seededFromExisting: false, rejectedMissing: [...BOTH], openAsks: [...BOTH] }),
    [...BOTH],
  );
});

test('a truly blank add form stays banner-free (the * markers cover it)', () => {
  assert.deepEqual(
    askBannerAsks({ editing: false, seededFromExisting: false, rejectedMissing: [], openAsks: [...BOTH] }),
    [],
  );
});

test('answers clear live: content is the openAsks recompute, not a stale snapshot', () => {
  // Rancher fixed ships-in days after the rejection — its line goes away
  // immediately, without another save round-trip.
  assert.deepEqual(
    askBannerAsks({
      editing: false,
      seededFromExisting: true,
      rejectedMissing: [...BOTH],
      openAsks: ['shippingChoice'],
    }),
    ['shippingChoice'],
  );
  // Everything answered → banner gone, even though the latch is still set.
  assert.deepEqual(
    askBannerAsks({ editing: false, seededFromExisting: true, rejectedMissing: [...BOTH], openAsks: [] }),
    [],
  );
});
