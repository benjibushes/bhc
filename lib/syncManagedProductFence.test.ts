import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideSyncManagedRow } from './syncManagedProductFence';

// Hand-entered (non-sync) rows keep the full self-serve control set — the
// rancher owns them end to end.
test('hand-entered row: no sync badge, full control', () => {
  const d = decideSyncManagedRow({ syncManaged: false, marketplaceApproved: false });
  assert.equal(d.managed, false);
  assert.equal(d.badge, null);
  assert.equal(d.canShow, true);
  assert.equal(d.canEdit, true);
  assert.equal(d.canDelete, true);
});

test('missing flags default to hand-entered (full control)', () => {
  const d = decideSyncManagedRow({});
  assert.equal(d.managed, false);
  assert.equal(d.badge, null);
  assert.equal(d.canShow, true);
  assert.equal(d.canEdit, true);
  assert.equal(d.canDelete, true);
});

// Synced but NOT yet approved: the curation gate is closed. It shows a
// distinct "pending review" badge and the publish/show toggle is fenced —
// only BHC checking 'Marketplace Approved' can list it.
test('synced + unapproved: pending-review badge, everything fenced', () => {
  const d = decideSyncManagedRow({ syncManaged: true, marketplaceApproved: false });
  assert.equal(d.managed, true);
  assert.equal(d.badge, 'pending-review');
  assert.equal(d.canShow, false);
  assert.equal(d.canEdit, false);
  assert.equal(d.canDelete, false);
});

// Synced AND approved: still cron-owned (Active/name/price/stock recomputed
// every 6h), so edit/duplicate/delete/show stay fenced — but it's no longer
// "pending", so its real live/hidden badge (not the pending one) should show.
test('synced + approved: managed badge, still fenced', () => {
  const d = decideSyncManagedRow({ syncManaged: true, marketplaceApproved: true });
  assert.equal(d.managed, true);
  assert.equal(d.badge, 'managed');
  assert.equal(d.canShow, false);
  assert.equal(d.canEdit, false);
  assert.equal(d.canDelete, false);
});

// Only an explicit `true` counts as managed — a stray truthy value must not
// silently fence a hand-entered row out of the rancher's control.
test('non-boolean syncManaged is treated as not-managed', () => {
  const d = decideSyncManagedRow({ syncManaged: 1 as any, marketplaceApproved: 1 as any });
  assert.equal(d.managed, false);
  assert.equal(d.badge, null);
  assert.equal(d.canEdit, true);
});
