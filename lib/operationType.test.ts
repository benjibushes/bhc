// lib/operationType.test.ts — operation-type labels (P4, MARKETING-REVAMP
// 2026-08 principle 4). The classification rules the buyer-facing label rides
// on: "ships frozen, nationwide" vs "local share — serves [state]", and the
// hard invariant that an unknown/ambiguous input renders NOTHING (null),
// never a wrong label.
// Runner: npx tsx --test lib/operationType.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  operationTypeFor,
  operationTypeForStand,
  operationTypeEmailLine,
} from './operationType';

// ── product classification ──────────────────────────────────────────────────

test('frozen shipped product → ships-nationwide with the frozen label', () => {
  assert.deepEqual(
    operationTypeFor({ type: 'product', shelfStable: false }),
    { kind: 'ships-nationwide', label: 'ships frozen, nationwide' },
  );
});

test('shelf-stable product → ships-nationwide, never claims frozen', () => {
  assert.deepEqual(
    operationTypeFor({ type: 'product', shelfStable: true }),
    { kind: 'ships-nationwide', label: 'ships nationwide' },
  );
});

test('unknown shelf-stability (email settle paths) → generic label, never a frozen claim', () => {
  // PI metadata carries no Shelf Stable flag — the receipt/shipped emails
  // classify with shelfStable undefined and must get the frozen-agnostic label.
  assert.deepEqual(
    operationTypeFor({ type: 'product' }),
    { kind: 'ships-nationwide', label: 'ships nationwide' },
  );
});

test('deposit-style product still ships — deposit mechanics never flip it to local-share', () => {
  // The $95–355 ground box: charged as a deposit like a share, but it passes
  // isSellableRow (Ships Nationwide !== false) and ships frozen once confirmed.
  assert.deepEqual(
    operationTypeFor({ type: 'product', depositStyle: true, shelfStable: false }),
    { kind: 'ships-nationwide', label: 'ships frozen, nationwide' },
  );
});

test('local-pickup product (Ships Nationwide === false) → null (pickup copy owns that surface)', () => {
  assert.equal(operationTypeFor({ type: 'product', localOnly: true }), null);
  // localOnly wins over everything else on the row.
  assert.equal(
    operationTypeFor({ type: 'product', localOnly: true, shelfStable: false, depositStyle: true }),
    null,
  );
});

test('merch never claims frozen — via Category or browse-group key', () => {
  assert.deepEqual(
    operationTypeFor({ type: 'product', category: 'Merch', shelfStable: false }),
    { kind: 'ships-nationwide', label: 'ships nationwide' },
  );
  assert.deepEqual(
    operationTypeFor({ type: 'product', group: 'merch', shelfStable: false }),
    { kind: 'ships-nationwide', label: 'ships nationwide' },
  );
  // Non-merch category/group values don't disturb the frozen label.
  assert.deepEqual(
    operationTypeFor({ type: 'product', category: 'Ground Box', group: 'ground', shelfStable: false }),
    { kind: 'ships-nationwide', label: 'ships frozen, nationwide' },
  );
});

// ── share-ranch classification ──────────────────────────────────────────────

test('share ranch with a home state → local share — serves [state name]', () => {
  assert.deepEqual(
    operationTypeFor({ type: 'share-ranch', state: 'MT' }),
    { kind: 'local-share', label: 'local share — serves Montana' },
  );
  // Full state names normalize too ('Montana' and 'MT' both count — the
  // classic silent-mismatch trap).
  assert.deepEqual(
    operationTypeFor({ type: 'share-ranch', state: 'montana' }),
    { kind: 'local-share', label: 'local share — serves Montana' },
  );
});

test('share ranch without a recognizable state → null, never a wrong label', () => {
  assert.equal(operationTypeFor({ type: 'share-ranch', state: '' }), null);
  assert.equal(operationTypeFor({ type: 'share-ranch', state: 'Bogusland' }), null);
  assert.equal(operationTypeFor({ type: 'share-ranch' }), null);
  assert.equal(operationTypeFor({ type: 'share-ranch', state: null }), null);
});

// ── garbage in → nothing out ────────────────────────────────────────────────

test('unknown/ambiguous input → null (renders nothing)', () => {
  assert.equal(operationTypeFor(null), null);
  assert.equal(operationTypeFor(undefined), null);
  assert.equal(operationTypeFor({} as any), null);
  assert.equal(operationTypeFor({ type: 'mystery' } as any), null);
  assert.equal(operationTypeFor('product' as any), null);
});

// ── stand-level classification (the /shop ranch stall header) ───────────────

test('stand where every item ships frozen → the frozen label', () => {
  assert.deepEqual(
    operationTypeForStand([
      { localOnly: false, shelfStable: false },
      { localOnly: false, shelfStable: false, depositStyle: true },
    ]),
    { kind: 'ships-nationwide', label: 'ships frozen, nationwide' },
  );
});

test('stand mixing frozen + shelf-stable → generic ships-nationwide label', () => {
  assert.deepEqual(
    operationTypeForStand([
      { localOnly: false, shelfStable: false },
      { localOnly: false, shelfStable: true },
    ]),
    { kind: 'ships-nationwide', label: 'ships nationwide' },
  );
});

test('stand containing a pickup item → null (the stand is NOT all-ships)', () => {
  assert.equal(
    operationTypeForStand([
      { localOnly: false, shelfStable: false },
      { localOnly: true },
    ]),
    null,
  );
});

test('empty stand → null', () => {
  assert.equal(operationTypeForStand([]), null);
  assert.equal(operationTypeForStand(undefined as any), null);
});

test('stand items carry browse-group keys (StandProduct shape) — merch stays unfrozen', () => {
  assert.deepEqual(
    operationTypeForStand([
      { localOnly: false, shelfStable: false, group: 'ground' },
      { localOnly: false, shelfStable: false, group: 'merch' },
    ]),
    { kind: 'ships-nationwide', label: 'ships nationwide' },
  );
});

// ── digest-ready email line ─────────────────────────────────────────────────

test('operationTypeEmailLine renders one small line, or nothing for null', () => {
  assert.equal(operationTypeEmailLine(null), '');
  const line = operationTypeEmailLine(operationTypeFor({ type: 'share-ranch', state: 'TX' }));
  assert.ok(line.includes('local share — serves Texas'));
  assert.ok(line.startsWith('<p '));
  const ship = operationTypeEmailLine(operationTypeFor({ type: 'product', shelfStable: false }));
  assert.ok(ship.includes('ships frozen, nationwide'));
});
