import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buyerKey,
  groupReferralsByBuyer,
  mergeOrderBuyersIntoCustomers,
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

// ─── mergeOrderBuyersIntoCustomers — SHOP-CUSTOMER DEALS (2026-08-03) ───────
// Shop-order buyers (Rancher Orders) fold into the SAME customers list so a
// buyer who purchased through the ranch's own site shows up — and an
// order-only row carries what the "Track as deal" promote needs. All fixture
// people are fake.

test('order-only buyer becomes a customer row with order annotations and NO referral linkage', () => {
  const merged = mergeOrderBuyersIntoCustomers(
    [],
    [
      {
        id: 'recOrd1',
        buyerName: 'Test Buyer',
        buyerEmail: 'Test.Buyer@Example.com',
        orderedAt: '2026-08-01T12:00:00Z',
        ref: 'Quarter Beef — Test Buyer',
        status: 'New',
      },
    ],
  );
  assert.equal(merged.length, 1);
  const c = merged[0];
  assert.equal(c.key, 'e:test.buyer@example.com');
  assert.equal(c.email, 'test.buyer@example.com');
  assert.equal(c.name, 'Test Buyer');
  assert.equal(c.orderCount, 1);
  assert.equal(c.latestOrderId, 'recOrd1');
  assert.equal(c.latestOrderRef, 'Quarter Beef — Test Buyer');
  // The promote gate reads these: no referral yet.
  assert.deepEqual(c.referralIds, []);
  assert.equal(c.latestReferralId, '');
  // Money aggregates stay referral-only (no double count after a promoted close).
  assert.equal(c.lifetimeValue, 0);
});

test('same email (case-insensitive) merges INTO the existing referral customer — annotated, never duplicated', () => {
  const referralCustomers = groupReferralsByBuyer([
    { id: 'r1', status: 'Closed Won', buyer_name: 'Test Buyer', buyer_email: 'test.buyer@example.com', sale_amount: 2000, closed_at: '2026-06-01' },
  ]);
  const merged = mergeOrderBuyersIntoCustomers(referralCustomers, [
    { id: 'recOrd1', buyerName: 'Test Buyer', buyerEmail: 'TEST.BUYER@EXAMPLE.COM', orderedAt: '2026-08-01T12:00:00Z', ref: 'Ribeye Box', status: 'Shipped' },
  ]);
  assert.equal(merged.length, 1);
  const c = merged[0];
  assert.equal(c.orderCount, 1);
  assert.equal(c.latestOrderId, 'recOrd1');
  // Referral linkage untouched — the row still jumps to the deal.
  assert.deepEqual(c.referralIds, ['r1']);
  assert.equal(c.latestReferralId, 'r1');
  assert.equal(c.lifetimeValue, 2000);
});

test('refunded orders are skipped; identity-less orders are skipped; email-less orders key by name', () => {
  const merged = mergeOrderBuyersIntoCustomers(
    [],
    [
      { id: 'recOrdRefund', buyerName: 'Test Buyer', buyerEmail: 'test.buyer@example.com', status: 'Refunded' },
      { id: 'recOrdNoId', buyerName: '', buyerEmail: '', status: 'New' },
      { id: 'recOrdNameOnly', buyerName: 'Fake Person', buyerEmail: '', orderedAt: '2026-07-01T00:00:00Z', status: 'New' },
    ],
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].key, 'n:fake person');
  // No email → the promote button can't render (server requires one anyway).
  assert.equal(merged[0].email, '');
});

test('multiple orders from one buyer: counted once per order, latestOrder* is the NEWEST', () => {
  const merged = mergeOrderBuyersIntoCustomers(
    [],
    [
      { id: 'recOrdOld', buyerEmail: 'repeat@example.com', orderedAt: '2026-06-01T00:00:00Z', ref: 'Old Box', status: 'Shipped' },
      { id: 'recOrdNew', buyerEmail: 'repeat@example.com', orderedAt: '2026-08-01T00:00:00Z', ref: 'New Box', status: 'New' },
    ],
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].orderCount, 2);
  assert.equal(merged[0].latestOrderId, 'recOrdNew');
  assert.equal(merged[0].latestOrderRef, 'New Box');
});

test('input customer objects are not mutated (pure merge)', () => {
  const original = groupReferralsByBuyer([
    { id: 'r1', status: 'Intro Sent', buyer_email: 'test.buyer@example.com', created_at: '2026-07-01' },
  ]);
  mergeOrderBuyersIntoCustomers(original, [
    { id: 'recOrd1', buyerEmail: 'test.buyer@example.com', orderedAt: '2026-08-01T00:00:00Z', status: 'New' },
  ]);
  assert.equal(original[0].orderCount, undefined);
  assert.equal(original[0].latestOrderId, undefined);
});

test('sorting: lifetime $ still wins; among $0 rows, order recency backs up deal recency', () => {
  const referralCustomers = groupReferralsByBuyer([
    { id: 'r1', status: 'Closed Won', buyer_email: 'big.spender@example.com', sale_amount: 3000, closed_at: '2026-01-01' },
    { id: 'r2', status: 'Intro Sent', buyer_email: 'old.lead@example.com', created_at: '2026-02-01' },
  ]);
  const merged = mergeOrderBuyersIntoCustomers(referralCustomers, [
    { id: 'recOrdFresh', buyerEmail: 'fresh.shopper@example.com', orderedAt: '2026-08-01T00:00:00Z', status: 'New' },
  ]);
  assert.equal(merged[0].key, 'e:big.spender@example.com'); // lifetime $ first
  assert.equal(merged[1].key, 'e:fresh.shopper@example.com'); // newest $0 row
  assert.equal(merged[2].key, 'e:old.lead@example.com');
});
