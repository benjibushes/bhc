import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSignalDelivery } from './signalDelivery';

test('loud + telegram ok → telegram only, no fallback', () => {
  assert.deepEqual(
    planSignalDelivery({ urgency: 'loud', telegramOk: true, hasSmsTarget: true, hasEmailTarget: true }),
    { telegram: true, sms: false, email: false },
  );
});

test('loud + telegram fail → sms AND email when both configured', () => {
  assert.deepEqual(
    planSignalDelivery({ urgency: 'loud', telegramOk: false, hasSmsTarget: true, hasEmailTarget: true }),
    { telegram: true, sms: true, email: true },
  );
});

test('loud + telegram fail → only email when no sms target', () => {
  assert.deepEqual(
    planSignalDelivery({ urgency: 'loud', telegramOk: false, hasSmsTarget: false, hasEmailTarget: true }),
    { telegram: true, sms: false, email: true },
  );
});

test('loud + telegram fail → only sms when no email target', () => {
  assert.deepEqual(
    planSignalDelivery({ urgency: 'loud', telegramOk: false, hasSmsTarget: true, hasEmailTarget: false }),
    { telegram: true, sms: true, email: false },
  );
});

test('loud + telegram fail + no targets → telegram attempt only (nothing else to fire)', () => {
  assert.deepEqual(
    planSignalDelivery({ urgency: 'loud', telegramOk: false, hasSmsTarget: false, hasEmailTarget: false }),
    { telegram: true, sms: false, email: false },
  );
});

test('normal + telegram fail → NO fallback (current behavior preserved)', () => {
  assert.deepEqual(
    planSignalDelivery({ urgency: 'normal', telegramOk: false, hasSmsTarget: true, hasEmailTarget: true }),
    { telegram: true, sms: false, email: false },
  );
});

test('digest + telegram fail → NO fallback', () => {
  assert.deepEqual(
    planSignalDelivery({ urgency: 'digest', telegramOk: false, hasSmsTarget: true, hasEmailTarget: true }),
    { telegram: true, sms: false, email: false },
  );
});

test('normal + telegram ok → telegram only', () => {
  assert.deepEqual(
    planSignalDelivery({ urgency: 'normal', telegramOk: true, hasSmsTarget: true, hasEmailTarget: true }),
    { telegram: true, sms: false, email: false },
  );
});

test('dedupe-suppressed → NOTHING fires, even loud with telegram down + targets set', () => {
  assert.deepEqual(
    planSignalDelivery({ urgency: 'loud', telegramOk: false, hasSmsTarget: true, hasEmailTarget: true, deduped: true }),
    { telegram: false, sms: false, email: false },
  );
});

test('dedupe-suppressed → nothing, telegram-ok case too', () => {
  assert.deepEqual(
    planSignalDelivery({ urgency: 'normal', telegramOk: true, hasSmsTarget: false, hasEmailTarget: false, deduped: true }),
    { telegram: false, sms: false, email: false },
  );
});
