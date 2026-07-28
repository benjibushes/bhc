import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { adminSnapshot, _resetAdminSnapshotForTests } from './adminSnapshot';

beforeEach(() => _resetAdminSnapshotForTests());

test('second call within TTL is served from the snapshot (one fetch)', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return [{ id: 'rec1' }];
  };
  const a = await adminSnapshot('t1', fetcher);
  const b = await adminSnapshot('t1', fetcher);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
});

test('concurrent callers coalesce onto one in-flight fetch', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 20));
    return [{ id: 'rec1' }];
  };
  const [a, b, c] = await Promise.all([
    adminSnapshot('t2', fetcher),
    adminSnapshot('t2', fetcher),
    adminSnapshot('t2', fetcher),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
});

test('empty results are returned but never cached (degraded read must not pin zeros)', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return calls === 1 ? [] : [{ id: 'rec1' }];
  };
  const first = await adminSnapshot('t3', fetcher);
  const second = await adminSnapshot('t3', fetcher);
  assert.deepEqual(first, []);
  assert.deepEqual(second, [{ id: 'rec1' }]);
  assert.equal(calls, 2);
});

test('expired TTL refetches', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return [{ id: `rec${calls}` }];
  };
  await adminSnapshot('t4', fetcher, 0); // ttl 0 = always stale
  await new Promise((r) => setTimeout(r, 5));
  await adminSnapshot('t4', fetcher, 0);
  assert.equal(calls, 2);
});

test('fetcher failure propagates and is not cached', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    if (calls === 1) throw new Error('boom');
    return [{ id: 'rec1' }];
  };
  await assert.rejects(() => adminSnapshot('t5', fetcher));
  const ok = await adminSnapshot('t5', fetcher);
  assert.deepEqual(ok, [{ id: 'rec1' }]);
});

test('different keys are independent', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return [{ id: 'x' }];
  };
  await adminSnapshot('t6a', fetcher);
  await adminSnapshot('t6b', fetcher);
  assert.equal(calls, 2);
});
