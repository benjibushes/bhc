// Sanity pins for the demo fixtures — the numbers a rancher video leans on
// must add up, and the pipeline must span statuses. Pure data, no I/O.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TABLES } from '@/lib/airtable';
import {
  demoTableRecords,
  demoRecordById,
  demoRecordsByIds,
  demoRancherForSlug,
  DEMO_RANCHER_ID,
  DEMO_RANCHER_SLUG,
} from './demoStore';

test('flagship demo rancher exists and is fully demo-ready', () => {
  const ranchers = demoTableRecords(TABLES.RANCHERS);
  // Pinned by ID, not by count: the fixture set also carries a FRESH
  // applicant (recDEMOrancher02x) so the setup wizard's nothing-to-live road
  // can be walked in demo mode. The flagship must stay first (public page /
  // dashboard demos read [0]) and stay fully onboarded.
  assert.equal(ranchers[0].id, DEMO_RANCHER_ID);
  const r = ranchers.find((x: any) => x.id === DEMO_RANCHER_ID);
  assert.ok(r, 'flagship demo rancher missing');
  assert.equal(r.id, DEMO_RANCHER_ID);
  assert.equal(r.id.length, 17); // rec + 14 chars
  assert.equal(r['Slug'], DEMO_RANCHER_SLUG);
  assert.equal(r['Ranch Name'], 'Demo Creek Cattle Co');
  assert.equal(r['State'], 'MT');
  assert.equal(r['Pricing Model'], 'tier_v2');
  assert.equal(r['Stripe Connect Status'], 'active');
  assert.equal(r['Page Live'], true);
  assert.equal(r['Verification Status'], 'Verified');
  // Full pricing present so the public page renders all three cuts.
  assert.ok(r['Quarter Price'] && r['Half Price'] && r['Whole Price']);
});

test('demoRancherForSlug resolves the demo rancher (exact + fallback)', () => {
  assert.equal(demoRancherForSlug(DEMO_RANCHER_SLUG)?.id, DEMO_RANCHER_ID);
  // Any slug resolves in demo mode so a mistyped URL on camera still lands.
  assert.equal(demoRancherForSlug('anything-else')?.id, DEMO_RANCHER_ID);
});

test('referrals span all pipeline statuses', () => {
  const refs = demoTableRecords(TABLES.REFERRALS);
  assert.ok(refs.length >= 14, `expected >=14 referrals, got ${refs.length}`);
  const statuses = new Set(refs.map((r) => r['Status']));
  for (const s of [
    'Intro Sent',
    'Rancher Contacted',
    'Negotiation',
    'Awaiting Payment',
    'Slot Locked',
    'Closed Won',
    'Closed Lost',
  ]) {
    assert.ok(statuses.has(s), `missing referral status: ${s}`);
  }
  // Every referral links the demo rancher on BOTH the link array and denorm.
  for (const r of refs) {
    assert.deepEqual(r['Rancher'], [DEMO_RANCHER_ID]);
    assert.equal(r['Rancher Record Id'], DEMO_RANCHER_ID);
  }
});

test('closed-won economics add up to ~$18k with 6% commission', () => {
  const refs = demoTableRecords(TABLES.REFERRALS);
  const won = refs.filter((r) => r['Status'] === 'Closed Won');
  assert.equal(won.length, 6);
  const revenue = won.reduce((s, r) => s + (r['Sale Amount'] || 0), 0);
  assert.equal(revenue, 18050);
  const commission = won.reduce((s, r) => s + (r['Commission Due'] || 0), 0);
  // 6% of 18,050 = 1,083 (each row's Commission Due is 6% of its Sale Amount).
  assert.equal(commission, 1083);
  // Every closed-won has a Closed At + Sale Amount so earnings render.
  for (const r of won) {
    assert.ok(r['Closed At'], `won ${r.id} missing Closed At`);
    assert.ok(r['Sale Amount'] > 0, `won ${r.id} missing Sale Amount`);
  }
});

test('consumers + payments + threads back the referrals', () => {
  const consumers = demoTableRecords(TABLES.CONSUMERS);
  const refs = demoTableRecords(TABLES.REFERRALS);
  assert.equal(consumers.length, refs.length); // one buyer per referral
  const payments = demoTableRecords(TABLES.PAYMENTS);
  const paidRefs = refs.filter((r) => r['Deposit Paid At']);
  assert.equal(payments.length, paidRefs.length);
  const threads = demoTableRecords('Threads');
  assert.ok(threads.length >= 2);
  const messages = demoTableRecords('Thread Messages');
  // At least one buyer-sent message so the inbox shows an unread.
  assert.ok(messages.some((m) => m['Sender Type'] === 'buyer'));
});

test('demoRecordById + demoRecordsByIds resolve within a table', () => {
  assert.equal(demoRecordById(TABLES.RANCHERS, DEMO_RANCHER_ID)?.id, DEMO_RANCHER_ID);
  assert.equal(demoRecordById(TABLES.RANCHERS, 'nope'), null);
  const msgs = demoRecordsByIds('Thread Messages', ['recDEMOmsg00000001', 'recDEMOmsg00000004']);
  assert.equal(msgs.length, 2);
  assert.equal(demoRecordsByIds('Thread Messages', []).length, 0);
});

test('demoTableRecords returns a fresh array (mutation-safe)', () => {
  const a = demoTableRecords(TABLES.REFERRALS);
  const n = a.length;
  a.push({ id: 'x' } as any);
  assert.equal(demoTableRecords(TABLES.REFERRALS).length, n);
});
