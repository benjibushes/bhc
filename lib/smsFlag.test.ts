// F3 (go-to-market debug 2026-07-01) — ENABLE_SMS split-brain guard.
//
// lib/smsEvents.ts required ENABLE_SMS === '1' while demand-router +
// orphan-checkout-reaper required === 'true' — no single env value lit the
// whole SMS channel. smsEnabled() is the single source of truth: '1' or
// 'true' (case-insensitive, trimmed) → on; everything else → off.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smsEnabled } from './smsFlag';

test("smsEnabled: '1' lights the channel", () => {
  assert.equal(smsEnabled({ ENABLE_SMS: '1' }), true);
});

test("smsEnabled: 'true' lights the channel", () => {
  assert.equal(smsEnabled({ ENABLE_SMS: 'true' }), true);
});

test("smsEnabled: 'TRUE' (case-insensitive) lights the channel", () => {
  assert.equal(smsEnabled({ ENABLE_SMS: 'TRUE' }), true);
});

test("smsEnabled: 'True' and padded ' true ' light the channel", () => {
  assert.equal(smsEnabled({ ENABLE_SMS: 'True' }), true);
  assert.equal(smsEnabled({ ENABLE_SMS: ' true ' }), true);
});

test('smsEnabled: empty string is off', () => {
  assert.equal(smsEnabled({ ENABLE_SMS: '' }), false);
});

test('smsEnabled: undefined / unset is off', () => {
  assert.equal(smsEnabled({ ENABLE_SMS: undefined }), false);
  assert.equal(smsEnabled({}), false);
});

test("smsEnabled: '0' is off", () => {
  assert.equal(smsEnabled({ ENABLE_SMS: '0' }), false);
});

test("smsEnabled: 'false' is off", () => {
  assert.equal(smsEnabled({ ENABLE_SMS: 'false' }), false);
});

test('smsEnabled: garbage values are off', () => {
  assert.equal(smsEnabled({ ENABLE_SMS: 'yes' }), false);
  assert.equal(smsEnabled({ ENABLE_SMS: 'on' }), false);
  assert.equal(smsEnabled({ ENABLE_SMS: 'enable' }), false);
  assert.equal(smsEnabled({ ENABLE_SMS: '2' }), false);
  assert.equal(smsEnabled({ ENABLE_SMS: 'truthy' }), false);
});

test('smsEnabled: defaults to reading process.env', () => {
  const prev = process.env.ENABLE_SMS;
  try {
    process.env.ENABLE_SMS = '1';
    assert.equal(smsEnabled(), true);
    process.env.ENABLE_SMS = 'true';
    assert.equal(smsEnabled(), true);
    delete process.env.ENABLE_SMS;
    assert.equal(smsEnabled(), false);
  } finally {
    if (prev === undefined) delete process.env.ENABLE_SMS;
    else process.env.ENABLE_SMS = prev;
  }
});
