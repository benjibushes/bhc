// P6′ marketing scoreboard helper tests (MARKETING-REVAMP-2026-08 §5).
//
// Pins the fail-soft contract: the scoreboard reads other systems' exhaust
// (Cron Runs notes, Email Sends rows, Referral stamps) and NONE of it is a
// contract — every parser must degrade to null/skip on garbage, never throw.
// Also pins the note grammars against the exact strings the source crons
// write today (reclassify-buyers route.ts breakdown; ranch-stand-digest's
// three note shapes) so a reworded note breaks a test here, not prod.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseReclassifyNote,
  laneSizesFromSegments,
  parseDigestNote,
  latestCronRunByName,
  countSendsByStream,
  countDepositFunnel,
  computeFunnelRates,
  countClosedWonSince,
  gateProgress,
  fieldStr,
} from './marketingScoreboard';

const DAY_MS = 24 * 60 * 60 * 1000;

// ── parseReclassifyNote ─────────────────────────────────────────────────────

test('parseReclassifyNote parses the real cron note shape', () => {
  const note =
    'total=2744 changed=12 updated=12 errors=0 | STATE_WAITLIST=1741 MATCH_NOW=51 ' +
    'TERMINAL=22 NUDGE_TO_ENGAGE=400 NO_BUDGET_FOUNDER_PITCH=530';
  const parsed = parseReclassifyNote(note);
  assert.ok(parsed);
  assert.equal(parsed.total, 2744);
  assert.equal(parsed.segments['STATE_WAITLIST'], 1741);
  assert.equal(parsed.segments['MATCH_NOW'], 51);
  assert.equal(Object.keys(parsed.segments).length, 5);
});

test('parseReclassifyNote fails soft on garbage, empty, and non-string notes', () => {
  assert.equal(parseReclassifyNote(''), null);
  assert.equal(parseReclassifyNote(undefined), null);
  assert.equal(parseReclassifyNote(null), null);
  assert.equal(parseReclassifyNote(42 as any), null);
  assert.equal(parseReclassifyNote('MAINTENANCE_MODE=true'), null); // no pipe
  assert.equal(parseReclassifyNote('total=5 changed=0 | '), null); // pipe, no tokens
  assert.equal(parseReclassifyNote('completely reworded note'), null);
});

test('parseReclassifyNote tolerates a missing total token', () => {
  const parsed = parseReclassifyNote('changed=1 | MATCH_NOW=3');
  assert.ok(parsed);
  assert.equal(parsed.total, null);
  assert.equal(parsed.segments['MATCH_NOW'], 3);
});

test('parseReclassifyNote never reads pre-pipe tokens as segments', () => {
  // `changed=12` etc. are lowercase and sit before the pipe; only the
  // breakdown side may contribute segment tokens.
  const parsed = parseReclassifyNote('total=10 changed=2 | TERMINAL=10');
  assert.ok(parsed);
  assert.deepEqual(parsed.segments, { TERMINAL: 10 });
});

// ── laneSizesFromSegments ───────────────────────────────────────────────────

test('laneSizesFromSegments projects segments onto the 3 lanes', () => {
  const sizes = laneSizesFromSegments({
    MATCH_NOW: 51, // share-ready
    WARM_LEAD: 10, // share-ready
    NUDGE_TO_ENGAGE: 400, // share-ready
    INCOMPLETE_PROFILE: 39, // share-ready
    TERMINAL: 22, // customer
    STATE_WAITLIST: 1741, // national
    NO_BUDGET_FOUNDER_PITCH: 530, // national
    COMMUNITY_NURTURE: 3, // national
  });
  assert.deepEqual(sizes, { shareReady: 500, customer: 22, national: 2274 });
});

test('laneSizesFromSegments fails safe: unknown segments land national, junk counts skipped', () => {
  const sizes = laneSizesFromSegments({
    SOME_FUTURE_SEGMENT: 7, // unknown → national (laneForSegment parity)
    MATCH_NOW: NaN as any, // junk → skipped
    TERMINAL: -5, // negative → skipped
  });
  assert.deepEqual(sizes, { shareReady: 0, customer: 0, national: 7 });
});

// ── parseDigestNote ─────────────────────────────────────────────────────────

test('parseDigestNote parses the outside-window shape', () => {
  const parsed = parseDigestNote(
    'skipped — outside send window (UTC day=17; digest sends days 1-4, tiered)',
  );
  assert.ok(parsed);
  assert.equal(parsed.outsideWindow, true);
  assert.equal(parsed.dryRun, false);
  assert.equal(parsed.sent, null);
});

test('parseDigestNote parses the DRY-RUN shape (no sent count)', () => {
  const note =
    "DRY-RUN (RANCH_STAND_DIGEST_ENABLED!=='true') — would send tier=1 " +
    'tier-sizes=[9,9,9,8] eligible=35 selected=9 skipped-sunset=2 ' +
    'skipped-neverengaged=4 suppressed-flags=1 recently-sent=0 ' +
    'thin-month=false new-arrivals=3 shelf=4';
  const parsed = parseDigestNote(note);
  assert.ok(parsed);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.outsideWindow, false);
  assert.equal(parsed.tier, 1);
  assert.deepEqual(parsed.tierSizes, [9, 9, 9, 8]);
  assert.equal(parsed.eligible, 35);
  assert.equal(parsed.selected, 9);
  assert.equal(parsed.sent, null); // dry-run never sends
  assert.equal(parsed.thinMonth, false);
  assert.equal(parsed.skippedSunset, 2);
  assert.equal(parsed.skippedNeverEngaged, 4);
});

test('parseDigestNote parses the live shape and never confuses send-suppressed with sent', () => {
  const note =
    'tier=2 tier-sizes=[10,10,10,9] eligible=39 selected=10 skipped-sunset=0 ' +
    'skipped-neverengaged=1 suppressed-flags=0 recently-sent=3 ' +
    'thin-month=true new-arrivals=1 shelf=2 sent=8 send-suppressed=2 ' +
    'claim-skipped=0 errs=0';
  const parsed = parseDigestNote(note);
  assert.ok(parsed);
  assert.equal(parsed.dryRun, false);
  assert.equal(parsed.tier, 2);
  assert.equal(parsed.sent, 8); // NOT 2 (send-suppressed) and NOT 3 (recently-sent)
  assert.equal(parsed.thinMonth, true);
});

test('parseDigestNote fails soft on garbage and empties', () => {
  assert.equal(parseDigestNote(''), null);
  assert.equal(parseDigestNote(undefined), null);
  assert.equal(parseDigestNote('MAINTENANCE_MODE=true'), null);
  assert.equal(parseDigestNote('a fully reworded note with no tokens'), null);
});

// ── latestCronRunByName ─────────────────────────────────────────────────────

test('latestCronRunByName picks the newest parseable row for the right cron', () => {
  const rows = [
    { Name: 'reclassify-buyers', 'Started At': '2026-08-06T04:00:00Z', Notes: 'old' },
    { Name: 'reclassify-buyers', 'Started At': '2026-08-08T04:00:00Z', Notes: 'new' },
    { Name: 'ranch-stand-digest', 'Started At': '2026-08-09T14:52:00Z', Notes: 'other cron' },
    { Name: 'reclassify-buyers', 'Started At': 'not-a-date', Notes: 'corrupt' },
  ];
  const run = latestCronRunByName(rows, 'reclassify-buyers');
  assert.ok(run);
  assert.equal(run['Notes'], 'new');
});

test('latestCronRunByName returns null on empty/no-match/unparseable-only', () => {
  assert.equal(latestCronRunByName([], 'reclassify-buyers'), null);
  assert.equal(
    latestCronRunByName([{ Name: 'other', 'Started At': '2026-08-08T00:00:00Z' }], 'reclassify-buyers'),
    null,
  );
  assert.equal(
    latestCronRunByName([{ Name: 'reclassify-buyers', 'Started At': 'garbage' }], 'reclassify-buyers'),
    null,
  );
});

// ── countSendsByStream ──────────────────────────────────────────────────────

test('countSendsByStream splits via resolveEmailStream with the transactional fail-safe', () => {
  const counts = countSendsByStream([
    { 'Template Name': 'ranch_stand_digest' }, // marketing
    { 'Template Name': 'sendNurtureCheckIn' }, // marketing
    { 'Template Name': 'campaign_tx_wave1' }, // marketing (prefix rule)
    { 'Template Name': 'sendMagicLink' }, // transactional
    { 'Template Name': 'someUnknownTemplate' }, // unknown → transactional
    { 'Template Name': '' }, // blank → transactional
    {}, // missing → transactional
  ]);
  assert.deepEqual(counts, { marketing: 3, transactional: 4, total: 7 });
});

// ── countDepositFunnel + computeFunnelRates ─────────────────────────────────

test('countDepositFunnel counts only parseable stamps inside the window', () => {
  const now = Date.parse('2026-08-08T00:00:00Z');
  const since = now - 30 * DAY_MS;
  const counts = countDepositFunnel(
    [
      {
        'Deposit Invite Sent At': '2026-08-01T10:00:00Z',
        'Deposit Requested At': '2026-08-02T10:00:00Z',
        'Deposit Paid At': '2026-08-03T10:00:00Z',
      },
      { 'Deposit Invite Sent At': '2026-07-20T00:00:00Z' }, // invite only, in window
      { 'Deposit Invite Sent At': '2026-05-01T00:00:00Z' }, // outside window
      { 'Deposit Invite Sent At': 'not a date', 'Deposit Paid At': '' }, // unparseable/blank
      {}, // no stamps at all
    ],
    since,
  );
  assert.deepEqual(counts, { inviteSent: 2, requested: 1, paid: 1 });
});

test('computeFunnelRates rounds whole percents and nulls zero denominators', () => {
  assert.deepEqual(computeFunnelRates({ inviteSent: 8, requested: 4, paid: 3 }), {
    inviteToRequestPct: 50,
    requestToPaidPct: 75,
    inviteToPaidPct: 38, // 3/8 = 37.5 → 38
  });
  assert.deepEqual(computeFunnelRates({ inviteSent: 0, requested: 0, paid: 0 }), {
    inviteToRequestPct: null,
    requestToPaidPct: null,
    inviteToPaidPct: null,
  });
  // Window-edge case: paid can exceed requested; ratios are honest, unclamped.
  assert.equal(computeFunnelRates({ inviteSent: 2, requested: 1, paid: 2 }).requestToPaidPct, 200);
});

// ── countClosedWonSince ─────────────────────────────────────────────────────

test('countClosedWonSince counts recent Closed Won and surfaces undated ones', () => {
  const now = Date.parse('2026-08-08T00:00:00Z');
  const since = now - 7 * DAY_MS;
  const counts = countClosedWonSince(
    [
      { Status: 'Closed Won', 'Closed At': '2026-08-05' }, // in window
      { Status: { name: 'Closed Won' }, 'Closed At': '2026-08-07' }, // single-select object
      { Status: 'Closed Won', 'Closed At': '2026-06-01' }, // old
      { Status: 'Closed Won', 'Closed At': '' }, // undated — surfaced, not hidden
      { Status: 'Closed Won' }, // undated
      { Status: 'Awaiting Payment', 'Closed At': '2026-08-07' }, // wrong status
    ],
    since,
  );
  assert.deepEqual(counts, { closedInWindow: 2, missingClosedAt: 2 });
});

test('fieldStr unwraps single-select objects and stringifies scalars', () => {
  assert.equal(fieldStr({ name: 'Closed Won' }), 'Closed Won');
  assert.equal(fieldStr('plain'), 'plain');
  assert.equal(fieldStr(null), '');
  assert.equal(fieldStr(undefined), '');
});

// ── gateProgress ────────────────────────────────────────────────────────────

test('gateProgress reports evaluating below target and reached at/over it', () => {
  const below = gateProgress("P3′ digest", 'digest deliveries', 43, 200);
  assert.equal(below.reached, false);
  assert.equal(below.label, '43/200');

  assert.equal(gateProgress('P5′', 'sprint entries', 20, 20).reached, true);
  assert.equal(gateProgress('P5′', 'sprint entries', 31, 20).reached, true);
});

test('gateProgress floors junk currents to 0', () => {
  assert.equal(gateProgress('x', 'y', NaN, 10).label, '0/10');
  assert.equal(gateProgress('x', 'y', -4, 10).label, '0/10');
  assert.equal(gateProgress('x', 'y', 7.9, 10).label, '7/10');
});
