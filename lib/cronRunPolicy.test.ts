import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldWriteCronRunRow } from './cronRunPolicy';

const base = {
  skipLogRequested: true,
  status: 'success',
  recordsTouched: 0,
  heartbeatRowPending: false,
  dailyHeartbeatClaimed: false as boolean | null,
};

test('handler did not request skip → always write', () => {
  assert.equal(shouldWriteCronRunRow({ ...base, skipLogRequested: false }), true);
});

test('pure no-op + daily heartbeat already claimed today by another run → SKIP', () => {
  assert.equal(shouldWriteCronRunRow({ ...base, dailyHeartbeatClaimed: false }), false);
});

test('pure no-op + this run won the daily claim → write (the one heartbeat row)', () => {
  assert.equal(shouldWriteCronRunRow({ ...base, dailyHeartbeatClaimed: true }), true);
});

test('claim not attempted / Redis unknown (null) → fail open, write', () => {
  assert.equal(shouldWriteCronRunRow({ ...base, dailyHeartbeatClaimed: null }), true);
});

test('error status always writes even when skip requested', () => {
  assert.equal(shouldWriteCronRunRow({ ...base, status: 'error' }), true);
});

test('partial status always writes even when skip requested', () => {
  assert.equal(shouldWriteCronRunRow({ ...base, status: 'partial' }), true);
});

test('paused status always writes (operator must SEE the pause worked)', () => {
  assert.equal(shouldWriteCronRunRow({ ...base, status: 'paused' }), true);
});

test('real work (recordsTouched > 0) always writes even when skip requested', () => {
  assert.equal(shouldWriteCronRunRow({ ...base, recordsTouched: 3 }), true);
});

test('pending started-heartbeat row must be completed → write', () => {
  assert.equal(shouldWriteCronRunRow({ ...base, heartbeatRowPending: true }), true);
});
