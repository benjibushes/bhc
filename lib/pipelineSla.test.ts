import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pipelineSlaMode,
  slaForStatus,
  stageAgeDays,
  daysSinceEscalated,
  pipelineSlaVerdict,
  selectPipelineSlaEscalations,
  pipelineSlaSkipBreakdown,
  pausedAtMs,
  pausedReviewVerdict,
  selectPausedReviews,
  pausedReviewSkipBreakdown,
  STAGE_SLA_MATRIX,
  PIPELINE_SLA_MAX_PER_RUN,
  RE_ESCALATE_COOLDOWN_DAYS,
  PAUSED_REVIEW_DAYS,
  PAUSED_REVIEW_BUCKET,
  type PipelineSlaRefRow,
  type PausedRancherRow,
} from './pipelineSla';

const NOW = Date.parse('2026-08-12T15:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (d: number) => new Date(NOW - d * DAY).toISOString();

let seq = 0;
function ref(over: Partial<PipelineSlaRefRow> & Record<string, unknown> = {}): PipelineSlaRefRow {
  seq += 1;
  return {
    id: `rec${String(seq).padStart(4, '0')}`,
    Status: 'Negotiation',
    _createdTime: daysAgo(60),
    'Intro Sent At': daysAgo(30),
    ...over,
  };
}

// ── kill switch — tri-state, FAIL-TO-OFF ────────────────────────────────────

test('pipelineSlaMode: only exact "true" is live, only "dry-run" is shadow', () => {
  assert.equal(pipelineSlaMode('true'), 'live');
  assert.equal(pipelineSlaMode('dry-run'), 'dry-run');
  for (const raw of [undefined, '', 'false', 'TRUE', 'True', '1', 'yes', 'on', ' true', 'live']) {
    assert.equal(pipelineSlaMode(raw as any), 'off', `raw=${JSON.stringify(raw)}`);
  }
});

// ── the matrix itself ───────────────────────────────────────────────────────

test('matrix: one row per clocked stage, positive clocks, unique statuses+buckets', () => {
  const statuses = STAGE_SLA_MATRIX.map((s) => s.status);
  const buckets = STAGE_SLA_MATRIX.map((s) => s.bucket);
  assert.equal(new Set(statuses).size, statuses.length);
  assert.equal(new Set(buckets).size, buckets.length);
  for (const s of STAGE_SLA_MATRIX) {
    assert.ok(s.maxAgeDays > 0, s.status);
    assert.ok(s.basis.length > 0, s.status);
  }
});

test('matrix pins the agreed clocks: Negotiation 7d, Slot Locked 5d LOUD, Rancher Contacted 14d, In Progress 21d', () => {
  assert.deepEqual(
    Object.fromEntries(STAGE_SLA_MATRIX.map((s) => [s.status, [s.maxAgeDays, s.escalation]])),
    {
      'Rancher Contacted': [14, 'dial-list'],
      Negotiation: [7, 'dial-list'],
      'Slot Locked': [5, 'loud'],
      'In Progress': [21, 'dial-list'],
    },
  );
});

test('matrix EXCLUDES every stage another cron already clocks (no duplicate clocks)', () => {
  // Pending Approval → stuck-referral-reaper + stale-expiry tier 2;
  // Pending → reaper normalization; Intro Sent → first-touch-sla;
  // Awaiting Payment → deposit-watchdog/-request-nudge/-accept-sla + dunning;
  // terminal/parked states have no clock by definition.
  for (const covered of [
    'Pending Approval',
    'Pending',
    'Intro Sent',
    'Awaiting Payment',
    'Closed Won',
    'Closed Lost',
    'Dormant',
    'Waitlisted',
    'Rejected',
    'Refunded',
  ]) {
    assert.equal(slaForStatus(covered), null, covered);
  }
});

// ── stage age basis ─────────────────────────────────────────────────────────

test('Slot Locked clocks on Rancher Accepted At even when other stamps are fresher', () => {
  const r = ref({
    Status: 'Slot Locked',
    'Rancher Accepted At': daysAgo(24),
    'Last Rancher Activity At': daysAgo(1), // fresher — must NOT win
  });
  assert.equal(stageAgeDays(r, NOW), 24);
});

test('Slot Locked WITHOUT an accept stamp (drifted) falls back to the newest stamp', () => {
  const r = ref({ Status: 'Slot Locked', 'Intro Sent At': daysAgo(10), 'Last Chased At': daysAgo(3) });
  assert.equal(stageAgeDays(r, NOW), 3);
});

test('fallback basis takes the NEWEST of the known stamps (a chase resets the clock)', () => {
  const r = ref({
    Status: 'Negotiation',
    _createdTime: daysAgo(120),
    'Intro Sent At': daysAgo(40),
    'Last Buyer Activity At': daysAgo(9),
    'Last Chased At': daysAgo(2),
  });
  assert.equal(stageAgeDays(r, NOW), 2);
});

test('no parseable stamp at all → null age, and the verdict never escalates blind', () => {
  const r = ref({ Status: 'Negotiation', _createdTime: undefined, 'Intro Sent At': 'garbage' });
  assert.equal(stageAgeDays(r, NOW), null);
  assert.deepEqual(pipelineSlaVerdict(r, NOW), { skip: 'no-parseable-age' });
});

// ── THE incident: a PAID deposit at Slot Locked for 24 days ────────────────

test('the Slot-Locked-24-days case escalates LOUD', () => {
  const r = ref({
    Status: 'Slot Locked',
    'Rancher Accepted At': daysAgo(24),
    'Deposit Paid At': daysAgo(24), // money IS collected — the incident class
  });
  const v = pipelineSlaVerdict(r, NOW);
  assert.ok('escalation' in v);
  if ('escalation' in v) {
    assert.equal(v.escalation.sla.escalation, 'loud');
    assert.equal(v.escalation.sla.bucket, 'slot-locked');
    assert.equal(v.escalation.ageDays, 24);
  }
});

test('an already-escalated row inside the 14d cooldown is NOT re-escalated', () => {
  const base = {
    Status: 'Slot Locked',
    'Rancher Accepted At': daysAgo(24),
  };
  const fresh = ref({ ...base, 'Stuck Escalated At': daysAgo(3) });
  assert.deepEqual(pipelineSlaVerdict(fresh, NOW), { skip: 'already-escalated' });
  // …but once the cooldown lapses and the stage is STILL wrong, it fires again.
  const lapsed = ref({ ...base, 'Stuck Escalated At': daysAgo(RE_ESCALATE_COOLDOWN_DAYS + 1) });
  assert.ok('escalation' in pipelineSlaVerdict(lapsed, NOW));
});

// ── per-stage boundaries ────────────────────────────────────────────────────

test('boundaries: inside the window skips, at/after the window escalates', () => {
  const cases: Array<[string, number, Record<string, unknown>]> = [
    ['Negotiation', 7, {}],
    ['Rancher Contacted', 14, {}],
    ['In Progress', 21, {}],
    ['Slot Locked', 5, { 'Rancher Accepted At': undefined }],
  ];
  for (const [status, max, extra] of cases) {
    const inside = ref({ Status: status, 'Intro Sent At': daysAgo(max - 1), _createdTime: daysAgo(max - 1), ...extra });
    assert.deepEqual(pipelineSlaVerdict(inside, NOW), { skip: 'inside-sla' }, `${status} inside`);
    const at = ref({ Status: status, 'Intro Sent At': daysAgo(max), _createdTime: daysAgo(max), ...extra });
    assert.ok('escalation' in pipelineSlaVerdict(at, NOW), `${status} at window`);
  }
});

// ── carve-outs ──────────────────────────────────────────────────────────────

test('rancher-added CRM leads, operator holds, and synthetic buyers never escalate', () => {
  assert.deepEqual(
    pipelineSlaVerdict(ref({ 'Referral Source': 'rancher-added', 'Intro Sent At': daysAgo(90) }), NOW),
    { skip: 'rancher-added' },
  );
  assert.deepEqual(
    pipelineSlaVerdict(ref({ 'Hold Until': daysAgo(-10), 'Intro Sent At': daysAgo(90) }), NOW),
    { skip: 'on-hold' },
  );
  const synthetic = pipelineSlaVerdict(
    ref({ 'Buyer Email': 'probe-audit-77@buyhalfcow.com', 'Intro Sent At': daysAgo(90) }),
    NOW,
  );
  assert.deepEqual(synthetic, { skip: 'synthetic' });
});

test('a status outside the matrix skips as status-not-clocked', () => {
  assert.deepEqual(pipelineSlaVerdict(ref({ Status: 'Awaiting Payment' }), NOW), {
    skip: 'status-not-clocked',
  });
});

// ── selection: cap + ordering ───────────────────────────────────────────────

test('selection is oldest-in-stage first and respects the cap', () => {
  const rows = [
    ref({ Status: 'Negotiation', 'Intro Sent At': daysAgo(10) }),
    ref({ Status: 'Negotiation', 'Intro Sent At': daysAgo(130), _createdTime: daysAgo(140) }), // April rot
    ref({ Status: 'Slot Locked', 'Rancher Accepted At': daysAgo(24) }),
  ];
  const all = selectPipelineSlaEscalations(rows, NOW);
  assert.deepEqual(all.map((e) => e.ageDays), [130, 24, 10]);
  const capped = selectPipelineSlaEscalations(rows, NOW, 2);
  assert.deepEqual(capped.map((e) => e.ageDays), [130, 24]);
  assert.ok(PIPELINE_SLA_MAX_PER_RUN === 25);
});

test('skip breakdown counts every pool row exactly once', () => {
  const rows = [
    ref({ Status: 'Negotiation', 'Intro Sent At': daysAgo(10) }),
    ref({ Status: 'Negotiation', 'Intro Sent At': daysAgo(2) }),
    ref({ Status: 'Slot Locked', 'Rancher Accepted At': daysAgo(24), 'Stuck Escalated At': daysAgo(1) }),
  ];
  const b = pipelineSlaSkipBreakdown(rows, NOW);
  assert.deepEqual(b, { 'due:negotiation': 1, 'inside-sla': 1, 'already-escalated': 1 });
});

// ── paused-review: pause-age evidence ───────────────────────────────────────

let rseq = 0;
function rancher(over: Partial<PausedRancherRow> & Record<string, unknown> = {}): PausedRancherRow {
  rseq += 1;
  return {
    id: `ran${String(rseq).padStart(4, '0')}`,
    'Active Status': 'Paused',
    ...over,
  };
}

test('pausedAtMs: newest [PAUSED yyyy-mm-dd] marker in Verification Notes wins', () => {
  const r = rancher({
    'Verification Notes': `[PAUSED 2026-07-01 — capacity]\n[PAUSED 2026-05-01]\nolder stuff`,
  });
  assert.equal(pausedAtMs(r), Date.parse('2026-07-01'));
});

test('pausedAtMs: pilot stamp and migration deadline count; deadline only when paused_overdue', () => {
  assert.equal(
    pausedAtMs(rancher({ 'Pilot Upsell Notified At': daysAgo(45) })),
    Date.parse(daysAgo(45)),
  );
  assert.equal(
    pausedAtMs(rancher({ 'Migration Status': 'paused_overdue', 'Migration Deadline': daysAgo(50) })),
    Date.parse(daysAgo(50)),
  );
  // Deadline present but the pause is NOT the migration cron's → no evidence.
  assert.equal(
    pausedAtMs(rancher({ 'Migration Status': 'completed', 'Migration Deadline': daysAgo(50) })),
    null,
  );
});

// ── paused-review: verdicts ─────────────────────────────────────────────────

test('paused >30d escalates; a fresh pause does not; non-paused/Removed never do', () => {
  const old = rancher({ 'Verification Notes': `[PAUSED ${daysAgo(40).slice(0, 10)}]` });
  const v = pausedReviewVerdict(old, NOW);
  assert.ok('due' in v);
  if ('due' in v) assert.equal(v.due.pausedDays! >= PAUSED_REVIEW_DAYS, true);

  const fresh = rancher({ 'Verification Notes': `[PAUSED ${daysAgo(10).slice(0, 10)}]` });
  assert.deepEqual(pausedReviewVerdict(fresh, NOW), { skip: 'pause-too-fresh' });

  assert.deepEqual(pausedReviewVerdict(rancher({ 'Active Status': 'Active' }), NOW), {
    skip: 'not-paused',
  });
  assert.deepEqual(
    pausedReviewVerdict(rancher({ 'Verification Status': 'Removed' }), NOW),
    { skip: 'removed' },
  );
});

test('an UNDATABLE pause is review-due (the forever-pause case), once per 30d', () => {
  const undatable = rancher({}); // self-serve pause: no marker, no stamps
  const v = pausedReviewVerdict(undatable, NOW);
  assert.ok('due' in v);
  if ('due' in v) assert.equal(v.due.pausedDays, null);
  // …but a recent escalation stamp (ANY bucket — shared field) holds it off.
  assert.deepEqual(
    pausedReviewVerdict(rancher({ 'Stuck Escalated At': daysAgo(10) }), NOW),
    { skip: 'recently-escalated' },
  );
  // Re-escalates once the 30d cadence lapses.
  assert.ok(
    'due' in pausedReviewVerdict(rancher({ 'Stuck Escalated At': daysAgo(PAUSED_REVIEW_DAYS + 1) }), NOW),
  );
});

test('selectPausedReviews: longest-paused first, undatable last, cap respected', () => {
  const rows = [
    rancher({}), // undatable
    rancher({ 'Verification Notes': `[PAUSED ${daysAgo(90).slice(0, 10)}]` }),
    rancher({ 'Pilot Upsell Notified At': daysAgo(45) }),
  ];
  const all = selectPausedReviews(rows, NOW, 25);
  assert.deepEqual(all.map((p) => p.pausedDays), [90, 45, null]);
  assert.equal(selectPausedReviews(rows, NOW, 1).length, 1);
  assert.equal(selectPausedReviews(rows, NOW, 0).length, 0);
});

test('paused breakdown only reports the paused cohort', () => {
  const b = pausedReviewSkipBreakdown(
    [
      rancher({ 'Active Status': 'Active' }),
      rancher({}),
      rancher({ 'Stuck Escalated At': daysAgo(2) }),
    ],
    NOW,
  );
  assert.deepEqual(b, { 'paused:due': 1, 'paused:recently-escalated': 1 });
});

test('bucket constant matches what the queue carve-out keys on', () => {
  assert.equal(PAUSED_REVIEW_BUCKET, 'paused-review');
});

test('daysSinceEscalated: unparseable reads as never-stamped (fail toward one escalation)', () => {
  assert.equal(daysSinceEscalated({ 'Stuck Escalated At': 'not-a-date' }, NOW), null);
  assert.equal(daysSinceEscalated({}, NOW), null);
  assert.equal(daysSinceEscalated({ 'Stuck Escalated At': daysAgo(3) }, NOW), 3);
});
