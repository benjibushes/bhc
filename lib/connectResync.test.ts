import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeConnectResync } from './connectResync';

const NOW = '2026-06-30T00:00:00.000Z';

const base = {
  previousStatus: 'onboarding',
  alreadyConnectedAt: false,
  pricingModel: 'tier_v2',
  migrationStatus: 'upgrading',
  nowISO: NOW,
};

test('no-op when live status matches the cache', () => {
  const d = computeConnectResync({ ...base, liveStatus: 'onboarding', previousStatus: 'onboarding' });
  assert.equal(d.changed, false);
  assert.deepEqual(d.writeFields, {});
  assert.equal(d.migrationCompleted, false);
});

test('onboarding → active stamps status + Connected At + completes migration', () => {
  const d = computeConnectResync({ ...base, liveStatus: 'active' });
  assert.equal(d.changed, true);
  assert.equal(d.isNowActive, true);
  assert.equal(d.writeFields['Stripe Connect Status'], 'active');
  assert.equal(d.writeFields['Stripe Connect Connected At'], NOW);
  assert.equal(d.writeFields['Migration Status'], 'completed');
  assert.equal(d.migrationCompleted, true);
});

test('active flip does NOT re-stamp Connected At when already stamped', () => {
  const d = computeConnectResync({ ...base, liveStatus: 'active', alreadyConnectedAt: true });
  assert.equal(d.writeFields['Stripe Connect Connected At'], undefined);
  assert.equal(d.writeFields['Stripe Connect Status'], 'active');
});

test('active flip on legacy rancher does not touch Migration Status', () => {
  const d = computeConnectResync({ ...base, liveStatus: 'active', pricingModel: 'legacy' });
  assert.equal(d.writeFields['Migration Status'], undefined);
  assert.equal(d.migrationCompleted, false);
});

test('active flip on already-completed migration does not rewrite it', () => {
  const d = computeConnectResync({ ...base, liveStatus: 'active', migrationStatus: 'completed' });
  assert.equal(d.writeFields['Migration Status'], undefined);
  assert.equal(d.migrationCompleted, false);
});

test('non-active status change writes only the status field', () => {
  const d = computeConnectResync({
    ...base,
    previousStatus: 'onboarding',
    liveStatus: 'restricted',
  });
  assert.equal(d.changed, true);
  assert.equal(d.isNowActive, false);
  assert.deepEqual(d.writeFields, { 'Stripe Connect Status': 'restricted' });
  assert.equal(d.migrationCompleted, false);
});

test('not_connected → onboarding is a plain status change', () => {
  const d = computeConnectResync({
    ...base,
    previousStatus: 'not_connected',
    liveStatus: 'onboarding',
  });
  assert.equal(d.changed, true);
  assert.deepEqual(d.writeFields, { 'Stripe Connect Status': 'onboarding' });
});
