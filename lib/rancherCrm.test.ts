import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buyerKey,
  groupReferralsByBuyer,
  deriveActivityEvents,
  countUnread,
  matchesSearch,
  type CrmReferral,
} from './rancherCrm';

// ──────────────────────────────────────────────────────────────────────────
// WAVE 3a — pure-helper locks for the rancher CRM / activity-feed / search.
// These encode the read-only-view invariants the dashboard depends on. They
// must stay in lockstep with lib/rancherCrm.ts.
// ──────────────────────────────────────────────────────────────────────────

// ─── buyerKey identity ──────────────────────────────────────────────────────

test('buyerKey: email wins, case-insensitive', () => {
  assert.equal(buyerKey({ id: '1', status: 'x', buyer_email: 'A@B.com' }), 'e:a@b.com');
});

test('buyerKey: falls back to phone digits, then name', () => {
  assert.equal(buyerKey({ id: '1', status: 'x', buyer_phone: '(406) 555-1234' }), 'p:4065551234');
  assert.equal(buyerKey({ id: '1', status: 'x', buyer_name: 'Jane Doe' }), 'n:jane doe');
});

test('buyerKey: blank identity → empty string (skipped from CRM)', () => {
  assert.equal(buyerKey({ id: '1', status: 'x' }), '');
});

// ─── groupReferralsByBuyer ──────────────────────────────────────────────────

test('groups two deals from the same email into one customer', () => {
  const refs: CrmReferral[] = [
    { id: 'r1', status: 'Closed Won', buyer_name: 'Jane', buyer_email: 'jane@x.com', sale_amount: 1000, closed_at: '2026-01-01' },
    { id: 'r2', status: 'Closed Won', buyer_name: 'Jane', buyer_email: 'JANE@x.com', sale_amount: 1500, closed_at: '2026-03-01' },
  ];
  const customers = groupReferralsByBuyer(refs);
  assert.equal(customers.length, 1);
  const c = customers[0];
  assert.equal(c.totalDeals, 2);
  assert.equal(c.closedWonDeals, 2);
  assert.equal(c.lifetimeValue, 2500);
  assert.equal(c.isRepeat, true);
  // newest deal first → r2 is latest
  assert.equal(c.latestReferralId, 'r2');
  assert.deepEqual(c.referralIds, ['r2', 'r1']);
});

test('lifetime value only counts Closed Won (open leads excluded)', () => {
  const refs: CrmReferral[] = [
    { id: 'r1', status: 'Closed Won', buyer_email: 'a@x.com', sale_amount: 800, closed_at: '2026-01-01' },
    { id: 'r2', status: 'Intro Sent', buyer_email: 'a@x.com', sale_amount: 999, intro_sent_at: '2026-02-01' },
  ];
  const c = groupReferralsByBuyer(refs)[0];
  assert.equal(c.totalDeals, 2);
  assert.equal(c.closedWonDeals, 1);
  assert.equal(c.lifetimeValue, 800);
  assert.equal(c.isRepeat, false); // only 1 closed-won
});

test('repeat flag requires 2+ closed-won, not just 2 deals', () => {
  const refs: CrmReferral[] = [
    { id: 'r1', status: 'Closed Won', buyer_email: 'a@x.com', sale_amount: 500, closed_at: '2026-01-01' },
    { id: 'r2', status: 'Closed Lost', buyer_email: 'a@x.com', closed_at: '2026-02-01' },
  ];
  assert.equal(groupReferralsByBuyer(refs)[0].isRepeat, false);
});

test('buyer-less referrals are skipped (not phantom customers)', () => {
  const refs: CrmReferral[] = [{ id: 'r1', status: 'Intro Sent' }];
  assert.equal(groupReferralsByBuyer(refs).length, 0);
});

test('customers sort by lifetime value desc', () => {
  const refs: CrmReferral[] = [
    { id: 'r1', status: 'Closed Won', buyer_email: 'small@x.com', sale_amount: 100, closed_at: '2026-01-01' },
    { id: 'r2', status: 'Closed Won', buyer_email: 'big@x.com', sale_amount: 5000, closed_at: '2026-01-01' },
  ];
  const customers = groupReferralsByBuyer(refs);
  assert.equal(customers[0].email, 'big@x.com');
});

// ─── deriveActivityEvents ───────────────────────────────────────────────────

test('derives one event per non-blank timestamp, newest first', () => {
  const refs: CrmReferral[] = [
    {
      id: 'r1',
      status: 'Closed Won',
      buyer_name: 'Jane',
      intro_sent_at: '2026-01-01T00:00:00Z',
      deposit_paid_at: '2026-01-05T00:00:00Z',
      closed_at: '2026-01-10T00:00:00Z',
    },
  ];
  const events = deriveActivityEvents(refs);
  assert.equal(events.length, 3);
  // reverse chron → closed (Jan 10) first
  assert.equal(events[0].type, 'deal_closed');
  assert.equal(events[2].type, 'new_lead');
  assert.equal(events[0].buyerName, 'Jane');
});

test('blank / unparseable timestamps produce no event', () => {
  const refs: CrmReferral[] = [
    { id: 'r1', status: 'x', buyer_name: 'Jane', intro_sent_at: '', deposit_paid_at: 'not-a-date' },
  ];
  assert.equal(deriveActivityEvents(refs).length, 0);
});

test('event id is deterministic across refetches', () => {
  const ref: CrmReferral = { id: 'r1', status: 'x', buyer_name: 'Jane', deposit_paid_at: '2026-01-05T00:00:00Z' };
  const a = deriveActivityEvents([ref])[0].id;
  const b = deriveActivityEvents([{ ...ref }])[0].id;
  assert.equal(a, b);
  assert.equal(a, 'r1:deposit_paid');
});

test('countUnread excludes ids in the read set', () => {
  const refs: CrmReferral[] = [
    { id: 'r1', status: 'x', buyer_name: 'J', intro_sent_at: '2026-01-01T00:00:00Z', deposit_paid_at: '2026-01-02T00:00:00Z' },
  ];
  const events = deriveActivityEvents(refs);
  assert.equal(countUnread(events, new Set()), 2);
  assert.equal(countUnread(events, new Set(['r1:deposit_paid'])), 1);
  assert.equal(countUnread(events, new Set(['r1:deposit_paid', 'r1:new_lead'])), 0);
});

// ─── matchesSearch ──────────────────────────────────────────────────────────

test('matches name / email / state case-insensitively', () => {
  const f = { name: 'Jane Doe', email: 'jane@x.com', state: 'MT' };
  assert.equal(matchesSearch(f, 'jane'), true);
  assert.equal(matchesSearch(f, 'X.COM'), true);
  assert.equal(matchesSearch(f, 'mt'), true);
  assert.equal(matchesSearch(f, 'zzz'), false);
});

test('matches phone digits-only (punctuation ignored)', () => {
  const f = { name: 'Jane', phone: '(406) 555-1234' };
  assert.equal(matchesSearch(f, '4065551234'), true);
  assert.equal(matchesSearch(f, '555'), true);
  assert.equal(matchesSearch(f, '12'), false); // <3 digits → no phone match
});

test('blank query never matches', () => {
  assert.equal(matchesSearch({ name: 'Jane' }, '  '), false);
});
