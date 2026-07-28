import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeConnectResync,
  reconcileWritePolicy,
  shouldEscalateUnpause,
  unpauseCallbackData,
  UNPAUSE_CALLBACK_PREFIX,
  shouldAutoResumePausedOverdue,
  buildPausedOverdueResumeFields,
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

// ── AUTO-REVERSE THE MACHINE'S OWN PAUSE (pause-asymmetry sweep 2026-07-25) ─
//
// The scope fence is the product here, not the happy path. Four code paths
// write Active Status='Paused'; exactly ONE of them is safe to reverse
// automatically, and these tests pin the boundary of that one.

const resumable = {
  connectIsActive: true,
  pricingModel: 'tier_v2',
  migrationStatus: 'paused_overdue',
  activeStatus: 'Paused',
};

test('auto-resumes ONLY the migration-deadline pause whose reason expired', () => {
  assert.equal(shouldAutoResumePausedOverdue(resumable), true);
});

test('SCOPE FENCE: a pause with no machine provenance is NEVER auto-reversed', () => {
  // 'paused_overdue' is written by exactly ONE line in the codebase
  // (cron/migration-deadline), in the same write as Active Status='Paused'.
  // Absent that marker there is no proof the machine caused the pause, so
  // every one of these must decline and fall through to the founder's button.
  for (const migrationStatus of [
    '',                 // pilot-goal pause, admin pause, rancher self-pause
    'completed',        // already migrated — marker consumed, or never paused for it
    'invited',
    'call_scheduled',
    'upgrading',
    'not_invited',
    'detached',         // not a real Migration Status; still must not qualify
  ]) {
    assert.equal(
      shouldAutoResumePausedOverdue({ ...resumable, migrationStatus }),
      false,
      `migrationStatus=${migrationStatus || '(empty)'} must not auto-resume`,
    );
  }
});

test('SCOPE FENCE: compliance + non-Paused states are never touched', () => {
  for (const activeStatus of ['Non-Compliant', 'Active', 'At Capacity', '', 'Removed']) {
    assert.equal(
      shouldAutoResumePausedOverdue({ ...resumable, activeStatus }),
      false,
      `activeStatus=${activeStatus || '(empty)'} must not auto-resume`,
    );
  }
});

test('SCOPE FENCE: the reason must be GONE — Connect live is not enough on its own', () => {
  // Connect dead → the rancher could not take money; resuming would route
  // buyers at a rancher who cannot be paid.
  assert.equal(shouldAutoResumePausedOverdue({ ...resumable, connectIsActive: false }), false);
  // Connect live but still legacy → they have NOT done the thing they were
  // paused for. The migration is the stated reason; it is not complete.
  for (const pricingModel of ['legacy', '', 'tier_v1', 'byoc']) {
    assert.equal(
      shouldAutoResumePausedOverdue({ ...resumable, pricingModel }),
      false,
      `pricingModel=${pricingModel || '(empty)'} must not auto-resume`,
    );
  }
});

test('predicate is case/whitespace tolerant on Airtable single-select values', () => {
  assert.equal(
    shouldAutoResumePausedOverdue({
      connectIsActive: true,
      pricingModel: ' Tier_V2 ',
      migrationStatus: ' PAUSED_OVERDUE ',
      activeStatus: ' paused ',
    }),
    true,
  );
});

test('SINGLE USE: the resume write consumes the provenance marker', () => {
  // This is what makes auto-reversal safe under repo rule #5. After the write,
  // Migration Status is 'completed', so the predicate can never fire again for
  // this rancher — a pause a HUMAN sets later can never be overridden.
  const fields = buildPausedOverdueResumeFields({ heldReferrals: 0, maxReferrals: 10 });
  assert.equal(fields['Migration Status'], 'completed');
  assert.equal(
    shouldAutoResumePausedOverdue({ ...resumable, migrationStatus: fields['Migration Status'] }),
    false,
  );
});

test('resume is CAPACITY-AWARE — never a bare Active over a full rancher', () => {
  // Mirrors /api/admin/ranchers/[id]/resume exactly: at/over cap → At Capacity,
  // so the matcher cannot over-fill them the moment the pause lifts.
  assert.equal(buildPausedOverdueResumeFields({ heldReferrals: 0, maxReferrals: 10 })['Active Status'], 'Active');
  assert.equal(buildPausedOverdueResumeFields({ heldReferrals: 9, maxReferrals: 10 })['Active Status'], 'Active');
  assert.equal(buildPausedOverdueResumeFields({ heldReferrals: 10, maxReferrals: 10 })['Active Status'], 'At Capacity');
  assert.equal(buildPausedOverdueResumeFields({ heldReferrals: 12, maxReferrals: 10 })['Active Status'], 'At Capacity');
});

test('resume tolerates missing/garbage capacity numbers without stranding', () => {
  // A cap that reads as 0/NaN must not mean "always At Capacity" — that would
  // silently re-strand the rancher we just resumed.
  assert.equal(
    buildPausedOverdueResumeFields({ heldReferrals: NaN as any, maxReferrals: NaN as any })['Active Status'],
    'Active',
  );
  assert.equal(
    buildPausedOverdueResumeFields({ heldReferrals: 0, maxReferrals: 0 })['Active Status'],
    'Active',
  );
});

test('auto-resume and the one-tap button are mutually exclusive on the same row', () => {
  // Every emitter branches on this: escalate (send the button) only when
  // auto-resume declines. A rancher must never get both.
  const decision = computeConnectResync({
    ...base,
    liveStatus: 'active',
    previousStatus: 'active',
    migrationStatus: 'paused_overdue',
  });
  const escalates = shouldEscalateUnpause({
    wasPausedOverdue: decision.wasPausedOverdue,
    activeStatus: 'Paused',
  });
  const autoResumes = shouldAutoResumePausedOverdue({ ...resumable, connectIsActive: decision.isNowActive });
  assert.equal(escalates, true);   // the row IS a dead-end
  assert.equal(autoResumes, true); // and the machine can prove it owns the pause
  // The legacy rancher on the same dead-end still needs the human button.
  assert.equal(
    shouldAutoResumePausedOverdue({ ...resumable, pricingModel: 'legacy' }),
    false,
  );
});
