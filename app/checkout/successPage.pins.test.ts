import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Source pins for the post-deposit success page (grep-based — it is a
// 'use client' App Router page and can't be imported under tsx --test; the copy
// it renders is unit-tested as pure data in lib/depositSuccessCopy.test.ts).
//
// WHAT THESE PROTECT (broker-rail truthfulness, 2026-08-17): this page is the
// success_url of BOTH deposit rails. Its Connect story — we notified the
// rancher, you settle in your message thread, the rancher gets paid out by
// Stripe — is false end to end for a broker buyer, whose ranch has no login,
// no thread and no Connect account. Every Connect-only claim on the page must
// now sit behind the rail flag the deposit GET hands back.

const HERE = path.dirname(fileURLToPath(import.meta.url));
// NOTE the path: this pins file deliberately lives OUTSIDE the [refId]
// directory. The npm test glob is 'app/**/*.test.ts', and a literal `[refId]`
// path segment is read as a glob character class — a test file inside it is
// silently never collected (the 2026-08-02 missing-tests landmine).
const src = readFileSync(path.join(HERE, '[refId]', 'success', 'page.tsx'), 'utf8');

test('PIN: the next-steps list is rendered from the shared rail-aware copy', () => {
  assert.match(src, /depositNextSteps,/);
  assert.match(src, /from '@\/lib\/depositSuccessCopy';/);
  assert.match(src, /depositNextSteps\(\{/);
});

test('PIN: no Connect-only next-steps copy is hardcoded in the page any more', () => {
  assert.doesNotMatch(src, /gets paid out by Stripe/);
  assert.doesNotMatch(src, /settle pickup or delivery details in your message thread/);
  assert.doesNotMatch(src, /know your deposit landed/);
});

test('PIN: the page reads the rail + delivery verdict off the paid 409', () => {
  assert.match(src, /j\.rail === 'broker'/);
  assert.match(src, /setRancherNotified/);
});

test('PIN: the webhook-lag broker 409 keeps polling instead of going terminal', () => {
  assert.match(src, /j\.error === 'not_connect_rail'/);
  const branch = src.slice(src.indexOf("j.error === 'not_connect_rail'"));
  assert.match(
    branch.slice(0, 900),
    /setTimeout\(poll, 2500\)/,
    'a just-paid broker referral must keep polling for the settle stamp',
  );
});

test('PIN: the BHC Promise block is rail-aware — broker never cites slot acceptance', () => {
  const promiseIdx = src.indexOf('BHC Promise still applies');
  assert.ok(promiseIdx > -1, 'the promise block must still exist');
  const promise = src.slice(promiseIdx, promiseIdx + 2200);
  assert.match(promise, /isBroker/, 'the promise copy must branch on the rail');
  const brokerArm = promise.slice(promise.indexOf('isBroker'), promise.indexOf('accepts your slot'));
  assert.doesNotMatch(brokerArm, /accepts your slot/);
  assert.match(promise, /confirms your animal/, 'broker refundability is tied to the ranch confirming');
});

test('PIN: broker buyers are never pointed at a dashboard thread as the way to reach us', () => {
  const promiseIdx = src.indexOf('BHC Promise still applies');
  const promise = src.slice(promiseIdx, promiseIdx + 2200);
  // Connect keeps "reply to your message thread"; broker must not.
  const brokerArm = promise.slice(promise.indexOf('isBroker'), promise.indexOf('message thread'));
  assert.doesNotMatch(brokerArm, /message thread/);
});

test('PIN: the thread CTA drops the "open thread" framing on the broker rail', () => {
  assert.match(src, /isBroker \? 'Message ' : 'Open thread with '/);
});
