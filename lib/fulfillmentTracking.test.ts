import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canTransition,
  statusRank,
  isFulfillmentStatus,
  isFulfillmentMethod,
  validateFulfillmentUpdate,
  FULFILLMENT_FIELDS,
  type FulfillmentUpdateInput,
} from './fulfillmentTracking';

const ME = 'recMe';
const OTHER = 'recOther';

function input(over: Partial<FulfillmentUpdateInput> = {}): FulfillmentUpdateInput {
  return {
    referralLinkedRancherIds: [ME],
    sessionRancherId: ME,
    currentStatus: 'scheduled',
    patch: {},
    nowIso: '2026-06-30T12:00:00.000Z',
    ...over,
  };
}

test('statusRank orders the lifecycle', () => {
  assert.equal(statusRank('scheduled'), 0);
  assert.equal(statusRank('processing'), 1);
  assert.equal(statusRank('ready'), 2);
  assert.equal(statusRank('fulfilled'), 3);
});

test('isFulfillmentStatus / isFulfillmentMethod guards', () => {
  assert.equal(isFulfillmentStatus('ready'), true);
  assert.equal(isFulfillmentStatus('nope'), false);
  assert.equal(isFulfillmentMethod('ship'), true);
  assert.equal(isFulfillmentMethod('pickup'), true);
  assert.equal(isFulfillmentMethod('teleport'), false);
});

test('canTransition: forward + same allowed', () => {
  assert.equal(canTransition('scheduled', 'scheduled'), true);
  assert.equal(canTransition('scheduled', 'fulfilled'), true);
  assert.equal(canTransition('processing', 'ready'), true);
});

test('canTransition: one step back allowed, big jump back blocked', () => {
  assert.equal(canTransition('ready', 'processing'), true);
  assert.equal(canTransition('fulfilled', 'scheduled'), false);
  assert.equal(canTransition('fulfilled', 'processing'), false);
});

test('ownership: not-linked rancher is 403', () => {
  const res = validateFulfillmentUpdate(input({ sessionRancherId: OTHER, patch: { status: 'ready' } }));
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.status, 403);
});

test('happy path: status forward writes status + updatedAt', () => {
  const res = validateFulfillmentUpdate(input({ patch: { status: 'processing' } }));
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.status, 'processing');
  assert.equal(res.fields[FULFILLMENT_FIELDS.status], 'processing');
  assert.equal(res.fields[FULFILLMENT_FIELDS.updatedAt], '2026-06-30T12:00:00.000Z');
});

test('invalid status string → 400', () => {
  const res = validateFulfillmentUpdate(input({ patch: { status: 'shipped-ish' } }));
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.status, 400);
});

test('illegal backward jump → 409', () => {
  const res = validateFulfillmentUpdate(input({ currentStatus: 'fulfilled', patch: { status: 'scheduled' } }));
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.status, 409);
});

test('ship method with carrier + tracking persists', () => {
  const res = validateFulfillmentUpdate(input({
    patch: { method: 'ship', carrier: 'UPS', trackingNumber: '1Z999' },
  }));
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.fields[FULFILLMENT_FIELDS.method], 'ship');
  assert.equal(res.fields[FULFILLMENT_FIELDS.carrier], 'UPS');
  assert.equal(res.fields[FULFILLMENT_FIELDS.trackingNumber], '1Z999');
});

test('pickup with a tracking number is rejected', () => {
  const res = validateFulfillmentUpdate(input({
    patch: { method: 'pickup', trackingNumber: '1Z999' },
  }));
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.status, 400);
});

test('invalid method → 400', () => {
  const res = validateFulfillmentUpdate(input({ patch: { method: 'drone' } }));
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.status, 400);
});

test('empty cut-sheet note clears the field (null)', () => {
  const res = validateFulfillmentUpdate(input({ patch: { cutSheetNote: '   ' } }));
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.fields[FULFILLMENT_FIELDS.cutSheetNote], null);
});

test('cut-sheet note is trimmed + capped at 1000', () => {
  const long = 'x'.repeat(2000);
  const res = validateFulfillmentUpdate(input({ patch: { cutSheetNote: long } }));
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal((res.fields[FULFILLMENT_FIELDS.cutSheetNote] as string).length, 1000);
});

test('bad processing date → 400', () => {
  const res = validateFulfillmentUpdate(input({ patch: { processingDate: 'someday' } }));
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.status, 400);
});

test('valid processing date persists', () => {
  const res = validateFulfillmentUpdate(input({ patch: { processingDate: '2026-07-15' } }));
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.fields[FULFILLMENT_FIELDS.processingDate], '2026-07-15');
});

test('empty patch → 400 (nothing to write)', () => {
  const res = validateFulfillmentUpdate(input({ patch: {} }));
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.status, 400);
});
