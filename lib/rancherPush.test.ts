// lib/rancherPush.test.ts
// Runner: JWT_SECRET=test-secret-ci npx tsx --test lib/rancherPush.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSubscriptions, addSubscription, removeSubscription, type StoredPushSubscription } from './rancherPush';

const mk = (endpoint: string): StoredPushSubscription => ({
  endpoint,
  keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) },
});

test('parseSubscriptions: valid JSON array round-trips', () => {
  const subs = [mk('https://push.example/1'), mk('https://push.example/2')];
  assert.deepEqual(parseSubscriptions(JSON.stringify(subs)), subs);
});

test('parseSubscriptions: garbage in → empty out (never throws)', () => {
  assert.deepEqual(parseSubscriptions(undefined), []);
  assert.deepEqual(parseSubscriptions(''), []);
  assert.deepEqual(parseSubscriptions('not json'), []);
  assert.deepEqual(parseSubscriptions('{"a":1}'), []);
  assert.deepEqual(parseSubscriptions(JSON.stringify([{ endpoint: 'http://insecure' }])), []);
  assert.deepEqual(parseSubscriptions(JSON.stringify([{ endpoint: 'https://x', keys: {} }])), []);
});

test('addSubscription: dedupes by endpoint (re-subscribe replaces, not stacks)', () => {
  const a = mk('https://push.example/1');
  const next = addSubscription([a], { ...a, keys: { p256dh: 'new'.padEnd(20, 'x'), auth: 'new-auth' } });
  assert.equal(next.length, 1);
  assert.equal(next[0].keys.auth, 'new-auth');
});

test('addSubscription: caps at 5 devices, oldest evicted', () => {
  let subs: StoredPushSubscription[] = [];
  for (let i = 1; i <= 6; i++) subs = addSubscription(subs, mk(`https://push.example/${i}`));
  assert.equal(subs.length, 5);
  assert.equal(subs[0].endpoint, 'https://push.example/2'); // /1 evicted
  assert.equal(subs[4].endpoint, 'https://push.example/6');
});

test('removeSubscription: removes only the matching endpoint', () => {
  const subs = [mk('https://push.example/1'), mk('https://push.example/2')];
  const next = removeSubscription(subs, 'https://push.example/1');
  assert.deepEqual(next.map((s) => s.endpoint), ['https://push.example/2']);
  assert.deepEqual(removeSubscription(subs, 'https://push.example/none'), subs);
});
