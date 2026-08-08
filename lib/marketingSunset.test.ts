// lib/marketingSunset.test.ts
//
// P5′ SUNSET POLICY (MARKETING-REVAMP-2026-08 §5, Track 1) — pins:
//
//   ASK      marketing-lane consumer, NOT suppressed, last ENGAGEMENT
//            (clicks + site/quiz activity — NEVER opens, MPP) > 180d old,
//            AND we actually sent them mail inside that window
//            → ONE re-permission email, Notes-marker stamped.
//   SUPPRESS 30d after the ask with still no engagement → Unsubscribed.
//   NO-CONTACT SUPPRESS  created > 365d ago + zero engagement stamps EVER +
//            no purchases → suppressed WITHOUT any email (panel decision).
//   Lane 3 ('customer') is never touched — purchase = engagement.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decideSunset,
  selectSunsetActions,
  latestSunsetMarkerMs,
  SUNSET_ASK_MARKER,
  SUNSET_KEEP_MARKER,
  SUNSET_SUPPRESSED_MARKER,
  SUNSET_LOOKBACK_DAYS,
  SUNSET_ASK_GRACE_DAYS,
  NEVER_ENGAGED_MIN_AGE_DAYS,
  SUNSET_ASK_CAP_PER_RUN,
  SUNSET_SUPPRESS_CAP_PER_RUN,
  NEVER_ENGAGED_SUPPRESS_CAP_PER_RUN,
} from './marketingSunset';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-08T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * DAY).toISOString();
const dayStr = (d: number) => daysAgo(d).slice(0, 10);

// A 200d-old consumer in a marketing lane who clicked once 200d ago and got
// a nurture send 30d ago — the canonical ASK target.
function consumer(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    id: 'recSUN0001',
    Email: 'jane@example.com',
    _createdTime: daysAgo(400),
    ['Routing Segment']: 'STATE_WAITLIST',
    ['Last Email Clicked At']: daysAgo(200),
    ['Nurture Touched At']: daysAgo(30),
    Notes: '',
    ...overrides,
  };
}

// ── policy constants ────────────────────────────────────────────────────────

test('policy pins: 180d lookback, 30d grace, 365d never-engaged, caps 25/25/50', () => {
  assert.equal(SUNSET_LOOKBACK_DAYS, 180);
  assert.equal(SUNSET_ASK_GRACE_DAYS, 30);
  assert.equal(NEVER_ENGAGED_MIN_AGE_DAYS, 365);
  assert.equal(SUNSET_ASK_CAP_PER_RUN, 25);
  assert.equal(SUNSET_SUPPRESS_CAP_PER_RUN, 25);
  assert.equal(NEVER_ENGAGED_SUPPRESS_CAP_PER_RUN, 50);
});

// ── ASK branch ──────────────────────────────────────────────────────────────

test('ask: 180d+ unengaged, mailed inside the window, marketing lane → ask', () => {
  assert.deepEqual(decideSunset(consumer(), NOW), { action: 'ask' });
});

test('ask: recent ENGAGEMENT (click / quiz / warmup / funnel) blocks the ask', () => {
  for (const f of ['Last Email Clicked At', 'Warmup Engaged At', 'Qualified At', 'Funnel Completed At']) {
    const d = decideSunset(consumer({ [f]: daysAgo(90) }), NOW);
    assert.equal(d.action, 'skip', `${f} at 90d should block`);
  }
});

test('ask: opens NEVER count as engagement (MPP) — an opener still gets the ask', () => {
  const d = decideSunset(
    consumer({ ['Last Email Opened At']: daysAgo(5), ['Email Opens']: 42 }),
    NOW,
  );
  assert.deepEqual(d, { action: 'ask' });
});

test('ask: no sends inside the 180d window → nothing to re-permission, skip', () => {
  const d = decideSunset(
    consumer({ ['Nurture Touched At']: daysAgo(200), ['Last Email Delivered At']: '' }),
    NOW,
  );
  assert.equal(d.action, 'skip');
});

test('ask: record CREATED inside the window counts as engagement (fresh signup is an action)', () => {
  const d = decideSunset(consumer({ _createdTime: daysAgo(100) }), NOW);
  assert.equal(d.action, 'skip');
});

test('ask: suppression trio / customer lane / terminal deal always skip', () => {
  assert.equal(decideSunset(consumer({ Unsubscribed: true }), NOW).action, 'skip');
  assert.equal(decideSunset(consumer({ Bounced: true }), NOW).action, 'skip');
  assert.equal(decideSunset(consumer({ Complained: true }), NOW).action, 'skip');
  // Lane 3 — purchase = engagement, longer leash, never sunset.
  assert.equal(decideSunset(consumer({ ['Routing Segment']: 'TERMINAL' }), NOW).action, 'skip');
  // Stale stored segment but a live deal → belt catches it.
  assert.equal(decideSunset(consumer({ ['Buyer Stage']: 'MATCHED' }), NOW).action, 'skip');
  assert.equal(decideSunset(consumer({ ['Referral Status']: 'Closed Won' }), NOW).action, 'skip');
});

test('ask: synthetic/test addresses and blank emails are never asked', () => {
  assert.equal(decideSunset(consumer({ Email: '' }), NOW).action, 'skip');
  assert.equal(decideSunset(consumer({ Email: 'probe-audit-1@example.com' }), NOW).action, 'skip');
});

test('ask: an already-asked consumer is never asked twice', () => {
  const d = decideSunset(
    consumer({ Notes: `${SUNSET_ASK_MARKER} ${dayStr(10)}] re-permission email sent (marketing-sunset)` }),
    NOW,
  );
  assert.equal(d.action, 'skip');
});

// ── SUPPRESS branch (30d after the ask) ─────────────────────────────────────

test('suppress: 30d+ after the ask with zero engagement since → suppress', () => {
  const d = decideSunset(
    consumer({ Notes: `${SUNSET_ASK_MARKER} ${dayStr(31)}] re-permission email sent (marketing-sunset)` }),
    NOW,
  );
  assert.deepEqual(d, { action: 'suppress', reason: 'no-reply-30d' });
});

test('suppress: engagement AFTER the ask rescues the consumer', () => {
  // They clicked the keep-me link (or anything else) after the ask date.
  const asked = `${SUNSET_ASK_MARKER} ${dayStr(40)}] re-permission email sent (marketing-sunset)`;
  assert.equal(
    decideSunset(consumer({ Notes: asked, ['Last Email Clicked At']: daysAgo(35) }), NOW).action,
    'skip',
  );
  assert.equal(
    decideSunset(
      consumer({ Notes: `${asked}\n${SUNSET_KEEP_MARKER} ${dayStr(35)}] buyer clicked keep-me` }),
      NOW,
    ).action,
    'skip',
  );
});

test('suppress: inside the 30d grace window → wait', () => {
  const d = decideSunset(
    consumer({ Notes: `${SUNSET_ASK_MARKER} ${dayStr(10)}] re-permission email sent (marketing-sunset)` }),
    NOW,
  );
  assert.equal(d.action, 'skip');
});

test('already sunset-suppressed → permanent skip', () => {
  const d = decideSunset(
    consumer({ Notes: `${SUNSET_SUPPRESSED_MARKER} ${dayStr(5)}] suppressed (marketing-sunset)` }),
    NOW,
  );
  assert.equal(d.action, 'skip');
});

// ── NEVER-ENGAGED branch (12mo+, no contact) ────────────────────────────────

function neverEngaged(overrides: Record<string, unknown> = {}): Record<string, any> {
  return consumer({
    ['Last Email Clicked At']: '',
    ['Nurture Touched At']: daysAgo(30),
    _createdTime: daysAgo(400),
    ...overrides,
  });
}

test('never-engaged: created 365d+ ago, zero engagement ever → suppress WITHOUT contact', () => {
  assert.deepEqual(decideSunset(neverEngaged(), NOW), {
    action: 'suppress',
    reason: 'never-engaged-12mo',
  });
});

test('never-engaged: takes precedence over the ask (no email to a 12mo corpse)', () => {
  // Same row DOES have sends inside the window — still no ask, straight suppress.
  const d = decideSunset(neverEngaged({ ['Nurture Touched At']: daysAgo(30) }), NOW);
  assert.deepEqual(d, { action: 'suppress', reason: 'never-engaged-12mo' });
});

test('never-engaged: ANY lifetime engagement signal exempts them', () => {
  assert.equal(decideSunset(neverEngaged({ ['Email Clicks']: 1 }), NOW).action, 'ask');
  assert.equal(decideSunset(neverEngaged({ ['Ready to Buy']: true }), NOW).action, 'ask');
  assert.equal(decideSunset(neverEngaged({ ['Qualified At']: daysAgo(390) }), NOW).action, 'ask');
});

test('never-engaged: younger than 365d falls through to the ask/skip logic', () => {
  const d = decideSunset(neverEngaged({ _createdTime: daysAgo(200), ['Nurture Touched At']: daysAgo(30) }), NOW);
  assert.deepEqual(d, { action: 'ask' });
});

// ── selector: caps + determinism ────────────────────────────────────────────

test('selectSunsetActions: buckets, caps, oldest-first determinism', () => {
  const rows: any[] = [];
  for (let i = 0; i < 30; i++) {
    rows.push(consumer({ id: `ask${String(i).padStart(2, '0')}`, ['Last Email Clicked At']: daysAgo(181 + i) }));
  }
  for (let i = 0; i < 30; i++) {
    rows.push(
      consumer({
        id: `sup${String(i).padStart(2, '0')}`,
        Notes: `${SUNSET_ASK_MARKER} ${dayStr(31 + i)}] re-permission email sent (marketing-sunset)`,
      }),
    );
  }
  for (let i = 0; i < 60; i++) {
    rows.push(neverEngaged({ id: `nev${String(i).padStart(2, '0')}`, _createdTime: daysAgo(366 + i) }));
  }
  const picked = selectSunsetActions(rows, NOW);
  assert.equal(picked.asks.length, SUNSET_ASK_CAP_PER_RUN);
  assert.equal(picked.suppressAsked.length, SUNSET_SUPPRESS_CAP_PER_RUN);
  assert.equal(picked.suppressNeverEngaged.length, NEVER_ENGAGED_SUPPRESS_CAP_PER_RUN);
  // Oldest engagement first — the longest-dead lead the first asked.
  assert.equal(picked.asks[0].id, 'ask29');
  // Oldest created first for the never-engaged sweep.
  assert.equal(picked.suppressNeverEngaged[0].id, 'nev59');
});

test('latestSunsetMarkerMs parses the newest marker date, null when absent', () => {
  const notes = `${SUNSET_ASK_MARKER} 2026-06-01] sent\n${SUNSET_ASK_MARKER} 2026-07-01] sent`;
  assert.equal(latestSunsetMarkerMs(notes, SUNSET_ASK_MARKER), Date.parse('2026-07-01'));
  assert.equal(latestSunsetMarkerMs('no markers here', SUNSET_ASK_MARKER), null);
  assert.equal(latestSunsetMarkerMs(undefined, SUNSET_ASK_MARKER), null);
});
