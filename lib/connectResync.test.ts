import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeConnectResync,
  reconcileWritePolicy,
  shouldEscalateUnpause,
  unpauseCallbackData,
  UNPAUSE_CALLBACK_PREFIX,
} from './connectResync';

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

test('active flip on paused_overdue rancher advances migration to completed', () => {
  // migration-deadline auto-paused this rancher; finishing Connect means the
  // upgrade is done — the tracker must advance (Active Status unpause stays
  // a manual ops step, alerted by the callers).
  const d = computeConnectResync({ ...base, liveStatus: 'active', migrationStatus: 'paused_overdue' });
  assert.equal(d.changed, true);
  assert.equal(d.writeFields['Migration Status'], 'completed');
  assert.equal(d.migrationCompleted, true);
});

test('paused_overdue + active flip on legacy rancher still leaves Migration Status alone', () => {
  const d = computeConnectResync({
    ...base,
    liveStatus: 'active',
    pricingModel: 'legacy',
    migrationStatus: 'paused_overdue',
  });
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

// ── paused_overdue dead-end (audit 2026-07-21) ─────────────────────────────

test('active flip on paused_overdue completes migration + flags wasPausedOverdue', () => {
  const d = computeConnectResync({ ...base, liveStatus: 'active', migrationStatus: 'paused_overdue' });
  assert.equal(d.changed, true);
  assert.equal(d.writeFields['Migration Status'], 'completed');
  assert.equal(d.migrationCompleted, true);
  assert.equal(d.wasPausedOverdue, true);
});

test('wasPausedOverdue fires even on the no-op branch (already-synced active cache)', () => {
  const d = computeConnectResync({
    ...base,
    liveStatus: 'active',
    previousStatus: 'active',
    migrationStatus: 'paused_overdue',
  });
  assert.equal(d.changed, false);
  assert.equal(d.wasPausedOverdue, true);
});

test('wasPausedOverdue is false when Connect is not active', () => {
  const d = computeConnectResync({ ...base, liveStatus: 'restricted', migrationStatus: 'paused_overdue' });
  assert.equal(d.wasPausedOverdue, false);
  assert.equal(d.writeFields['Migration Status'], undefined);
});

test('normal upgrading flip has wasPausedOverdue false', () => {
  const d = computeConnectResync({ ...base, liveStatus: 'active' });
  assert.equal(d.wasPausedOverdue, false);
});

// ── Nightly reconcile write policy (2026-07-25) ────────────────────────────
// The whole point: the scheduled run heals Connect and only REPORTS subs.

test('scheduled run (no ?apply=1) writes Connect but NOT subscriptions', () => {
  const p = reconcileWritePolicy(false);
  assert.equal(p.connect, true);
  assert.equal(p.subscriptions, false);
});

test('?apply=1 writes both classes — the manual escape hatch for subs', () => {
  const p = reconcileWritePolicy(true);
  assert.equal(p.connect, true);
  assert.equal(p.subscriptions, true);
});

test('Connect never falls back to dry-run — it applies on every run', () => {
  for (const manual of [true, false]) {
    assert.equal(reconcileWritePolicy(manual).connect, true);
  }
});

// ── Unpause escalation gate ────────────────────────────────────────────────

test('escalates when Connect went active on a still-Paused rancher', () => {
  assert.equal(shouldEscalateUnpause({ wasPausedOverdue: true, activeStatus: 'Paused' }), true);
});

test('does NOT escalate once the rancher is back to Active (already unpaused)', () => {
  assert.equal(shouldEscalateUnpause({ wasPausedOverdue: true, activeStatus: 'Active' }), false);
});

test('does NOT escalate for At Capacity — that rancher is routable, just full', () => {
  assert.equal(shouldEscalateUnpause({ wasPausedOverdue: true, activeStatus: 'At Capacity' }), false);
});

test('does NOT escalate when the resync did not flag paused_overdue', () => {
  assert.equal(shouldEscalateUnpause({ wasPausedOverdue: false, activeStatus: 'Paused' }), false);
});

test('escalation gate tolerates case/whitespace drift in the single-select', () => {
  assert.equal(shouldEscalateUnpause({ wasPausedOverdue: true, activeStatus: ' paused ' }), true);
});

test('empty Active Status does not escalate (never-activated row, not a dead-end)', () => {
  assert.equal(shouldEscalateUnpause({ wasPausedOverdue: true, activeStatus: '' }), false);
});

test('escalation fires on the no-op branch too — cache already active, row still Paused', () => {
  // The dead-end this exists for: a webhook DID land (cache says active) but
  // nothing ever unpaused the row. changed=false must not swallow the alert.
  const d = computeConnectResync({
    ...base,
    liveStatus: 'active',
    previousStatus: 'active',
    migrationStatus: 'paused_overdue',
  });
  assert.equal(d.changed, false);
  assert.equal(shouldEscalateUnpause({ wasPausedOverdue: d.wasPausedOverdue, activeStatus: 'Paused' }), true);
});

// ── One-tap callback wiring ────────────────────────────────────────────────

test('unpause callbackData round-trips the rancher id under the shared prefix', () => {
  const cb = unpauseCallbackData('recABC123');
  assert.equal(cb, 'cxunpause_recABC123');
  assert.ok(cb.startsWith(UNPAUSE_CALLBACK_PREFIX));
  assert.equal(cb.slice(UNPAUSE_CALLBACK_PREFIX.length), 'recABC123');
});

test('unpause callbackData fits Telegram 64-byte callback_data limit', () => {
  // Airtable record ids are rec + 14 chars; prefix must leave room.
  assert.ok(Buffer.byteLength(unpauseCallbackData('recQWERTYUIOPASD')) <= 64);
});
