// Shared L2 Redis cache — pure logic + fail-open contract.
//
// Runs with NO Upstash env (the whole test suite does), so these tests prove
// the two properties the scale change hinges on:
//   1. Serialization round-trips exactly (data can't corrupt across the wire).
//   2. Every op FAILS OPEN — a throwing/unavailable Redis degrades to a
//      MISS / no-op and NEVER throws, so a Redis blip can't break an Airtable
//      read. We inject a fake client (no live Redis needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  serialize,
  deserialize,
  cacheGet,
  cacheSet,
  cacheDel,
  type RedisLike,
} from './sharedCache';

// ── serialize / deserialize (pure) ───────────────────────────────────────

test('serialize → deserialize round-trips arrays of records exactly', () => {
  const rows = [
    { id: 'rec1', Name: 'Demo Creek', 'Slots Left': 3, active: true },
    { id: 'rec2', Name: 'Silverline', tags: ['east', 'shipping'] },
  ];
  const back = deserialize<typeof rows>(serialize(rows));
  assert.deepEqual(back, rows);
});

test('deserialize accepts an already-parsed object (Upstash auto-parse path)', () => {
  const obj = { stallThresholdDays: 7, funnelOfferOperatorCall: false };
  // Simulate @upstash/redis having already JSON-parsed the value on read.
  assert.deepEqual(deserialize(obj), obj);
});

test('deserialize returns undefined for null/undefined (genuine miss)', () => {
  assert.equal(deserialize(null), undefined);
  assert.equal(deserialize(undefined), undefined);
});

test('deserialize returns undefined for a malformed JSON string (never throws)', () => {
  assert.equal(deserialize('{not valid json'), undefined);
});

// ── fake Redis clients for the fail-open tests ───────────────────────────

function throwingClient(): RedisLike {
  return {
    get: async () => {
      throw new Error('ECONNREFUSED upstash');
    },
    set: async () => {
      throw new Error('ECONNREFUSED upstash');
    },
    del: async () => {
      throw new Error('ECONNREFUSED upstash');
    },
  };
}

// A minimal in-memory Redis stand-in so we can prove the happy path too.
function memoryClient(): RedisLike & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k) => (store.has(k) ? store.get(k)! : null),
    set: async (k, v) => {
      store.set(k, v);
      return 'OK';
    },
    del: async (k) => {
      store.delete(k);
      return 1;
    },
  };
}

// ── fail-open: a throwing client degrades to miss / no-op, NEVER throws ───

test('cacheGet FAILS OPEN: throwing client → undefined (miss), no throw', async () => {
  const val = await cacheGet('airtable:cache:Ranchers', throwingClient());
  assert.equal(val, undefined);
});

test('cacheSet FAILS SAFE: throwing client → resolves, no throw', async () => {
  await assert.doesNotReject(() =>
    cacheSet('airtable:cache:Ranchers', [{ id: 'rec1' }], 10_000, throwingClient()),
  );
});

test('cacheDel FAILS SAFE: throwing client → resolves, no throw', async () => {
  await assert.doesNotReject(() =>
    cacheDel('airtable:cache:Ranchers', throwingClient()),
  );
});

// ── env-unset no-op: with no client and no env, ops are pure no-ops ───────
// (The suite runs with NO Upstash env, so getRedis() returns null here.)

test('cacheGet with no client and no env → undefined (pure in-process fallthrough)', async () => {
  const val = await cacheGet('airtable:cache:Ranchers');
  assert.equal(val, undefined);
});

test('cacheSet / cacheDel with no client and no env → no-op, no throw', async () => {
  await assert.doesNotReject(() => cacheSet('k', { a: 1 }, 10_000));
  await assert.doesNotReject(() => cacheDel('k'));
});

// ── happy path round-trip through the L2 ops (injected memory client) ─────

test('cacheSet then cacheGet returns the stored value (L2 hit)', async () => {
  const client = memoryClient();
  const rows = [{ id: 'rec1', Name: 'Demo Creek' }];
  await cacheSet('airtable:cache:Ranchers', rows, 10_000, client);
  const back = await cacheGet<typeof rows>('airtable:cache:Ranchers', client);
  assert.deepEqual(back, rows);
});

test('cacheDel removes the key so a subsequent cacheGet is a miss', async () => {
  const client = memoryClient();
  await cacheSet('adminconfig:cache', { stallThresholdDays: 7 }, 60_000, client);
  await cacheDel('adminconfig:cache', client);
  const back = await cacheGet('adminconfig:cache', client);
  assert.equal(back, undefined);
});

test('cacheSet floors sub-second TTL to a >=1s EX (never EX 0)', async () => {
  // Capture the ex Upstash receives — EX 0 is rejected by Redis, so a 500ms
  // TTL must floor UP to 1s, and a 10s TTL must pass through as 10.
  const seen: number[] = [];
  const spy: RedisLike = {
    get: async () => null,
    set: async (_k, _v, opts) => {
      seen.push(opts?.ex ?? -1);
      return 'OK';
    },
    del: async () => 1,
  };
  await cacheSet('k', { a: 1 }, 500, spy); // sub-second
  await cacheSet('k', { a: 1 }, 10_000, spy); // 10s
  assert.deepEqual(seen, [1, 10]);
});
