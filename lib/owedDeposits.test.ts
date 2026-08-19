// lib/owedDeposits.test.ts — the "Owed to me" tile's selection rule.
//
// LIVE NUMBERS THIS WAS BUILT AGAINST (2026-08-18): /admin/today returned
// owedCents 285000 / owedCount 5. All five were abandoned Payments rows:
//   • rec2S0j8PWVNchjkz, rec54iJjmQu1ZeydS, recahYtt7UJsv32oF — $650 each,
//     THREE retries on ONE referral (recbnzdZB4MixIyh5) whose deposit
//     settled 2026-07-19 (succeeded payment rec5uCKVu2CfFxytM);
//   • recp13gT1d6vyKfjz — $400 on a referral that settled 2026-08-11;
//   • recqOWkYcJumE8SY7 — $500, referral Dormant, never paid. THE ONLY REAL ONE.
// True owed: $500. The tile was 5.7x high on the screen the arming runbook
// treats as ground truth.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectOwedAbandonedPayments } from './owedDeposits';

const ids = (rows: Array<Record<string, any>>) => rows.map((r) => String(r.id)).sort();

test('a since-PAID referral is not owed — the Deposit Paid At stamp', () => {
  const referrals = [{ id: 'refPaid', Status: 'Awaiting Payment', 'Deposit Paid At': '2026-07-19T03:34:27.595Z' }];
  const payments = [{ id: 'payA', Status: 'abandoned', 'Amount Cents': 65000, 'Referral Id Text': 'refPaid' }];
  assert.deepEqual(selectOwedAbandonedPayments(payments, referrals), []);
});

test('a since-PAID referral is not owed — a succeeded Payments row on the same referral', () => {
  // The referral row itself may lag (no Deposit Paid At yet); the succeeded
  // payment is the harder evidence and must count on its own.
  const referrals = [{ id: 'refSettled', Status: 'Awaiting Payment' }];
  const payments = [
    { id: 'payAbandoned', Status: 'abandoned', 'Amount Cents': 65000, 'Referral Id Text': 'refSettled' },
    { id: 'paySucceeded', Status: 'succeeded', 'Amount Cents': 65000, 'Referral Id Text': 'refSettled' },
  ];
  assert.deepEqual(selectOwedAbandonedPayments(payments, referrals), []);
});

test('a REFUNDED payment also proves the money landed — not owed', () => {
  const payments = [
    { id: 'payAbandoned', Status: 'abandoned', 'Amount Cents': 65000, 'Referral Id Text': 'refRefunded' },
    { id: 'payRefunded', Status: 'refunded', 'Amount Cents': 65000, 'Referral Id Text': 'refRefunded', 'Refunded At': '2026-08-01T00:00:00Z' },
  ];
  assert.deepEqual(selectOwedAbandonedPayments(payments, []), []);
});

test('retries on ONE referral collapse to ONE owed row (the newest ask)', () => {
  const payments = [
    { id: 'try1', Status: 'abandoned', 'Amount Cents': 65000, 'Referral Id Text': 'refOpen', 'Created At': '2026-07-14T23:27:28.239Z' },
    { id: 'try2', Status: 'abandoned', 'Amount Cents': 65000, 'Referral Id Text': 'refOpen', 'Created At': '2026-07-14T23:35:28.235Z' },
    { id: 'try3', Status: 'abandoned', 'Amount Cents': 70000, 'Referral Id Text': 'refOpen', 'Created At': '2026-07-14T23:41:27.589Z' },
  ];
  const rows = selectOwedAbandonedPayments(payments, []);
  assert.equal(rows.length, 1, 'three retries are ONE ask, not three');
  assert.equal(String(rows[0].id), 'try3', 'the newest attempt is the live ask');
  assert.equal(rows[0]['Amount Cents'], 70000);
});

test('Abandoned At beats Created At when both are present', () => {
  const payments = [
    { id: 'older', Status: 'abandoned', 'Amount Cents': 100, 'Referral Id Text': 'r', 'Created At': '2026-08-01T00:00:00Z', 'Abandoned At': '2026-08-09T00:00:00Z' },
    { id: 'newer', Status: 'abandoned', 'Amount Cents': 200, 'Referral Id Text': 'r', 'Created At': '2026-08-02T00:00:00Z', 'Abandoned At': '2026-08-10T00:00:00Z' },
  ];
  assert.deepEqual(ids(selectOwedAbandonedPayments(payments, [])), ['newer']);
});

test('rows with NO referral id are never merged with each other', () => {
  // Two orphan rows cannot be proven to be the same ask; each stands alone.
  const payments = [
    { id: 'orphan1', Status: 'abandoned', 'Amount Cents': 1000 },
    { id: 'orphan2', Status: 'abandoned', 'Amount Cents': 2000, 'Referral Id Text': '' },
  ];
  assert.deepEqual(ids(selectOwedAbandonedPayments(payments, [])), ['orphan1', 'orphan2']);
});

test('already-counted referrals (the Awaiting-Payment side of the tile) are dropped — no double count', () => {
  const payments = [{ id: 'pay', Status: 'abandoned', 'Amount Cents': 50000, 'Referral Id Text': 'refAwaiting' }];
  const referrals = [{ id: 'refAwaiting', Status: 'Awaiting Payment' }];
  assert.deepEqual(selectOwedAbandonedPayments(payments, referrals, new Set(['refAwaiting'])), []);
});

test('non-abandoned rows never enter the tile', () => {
  const payments = [
    { id: 'pending', Status: 'pending', 'Amount Cents': 9999, 'Referral Id Text': 'a' },
    { id: 'succeeded', Status: 'succeeded', 'Amount Cents': 9999, 'Referral Id Text': 'b' },
  ];
  assert.deepEqual(selectOwedAbandonedPayments(payments, []), []);
});

test('Status reads through an Airtable single-select cell, not just a string', () => {
  const payments = [
    { id: 'sel', Status: { name: 'abandoned' }, 'Amount Cents': 50000, 'Referral Id Text': 'refSel' },
    { id: 'selOk', Status: { name: 'succeeded' }, 'Amount Cents': 50000, 'Referral Id Text': 'refOther' },
    { id: 'selDrop', Status: { name: 'abandoned' }, 'Amount Cents': 50000, 'Referral Id Text': 'refOther' },
  ];
  assert.deepEqual(ids(selectOwedAbandonedPayments(payments, [])), ['sel']);
});

test('THE LIVE CASE — the five rows the audit found resolve to exactly one, $500', () => {
  const referrals = [
    { id: 'recbnzdZB4MixIyh5', Status: 'Awaiting Payment', 'Deposit Paid At': '2026-07-19T03:34:27.595Z' },
    { id: 'rec76CDnbM9p5pVfh', Status: 'Awaiting Payment', 'Deposit Paid At': '2026-08-11T00:01:48.881Z' },
    { id: 'recMhAJqSedunVtrb', Status: 'Dormant' },
  ];
  const payments = [
    { id: 'rec2S0j8PWVNchjkz', Status: 'abandoned', 'Amount Cents': 65000, 'Referral Id Text': 'recbnzdZB4MixIyh5', 'Created At': '2026-07-14T23:41:27.589Z' },
    { id: 'rec54iJjmQu1ZeydS', Status: 'abandoned', 'Amount Cents': 65000, 'Referral Id Text': 'recbnzdZB4MixIyh5', 'Created At': '2026-07-14T23:35:28.235Z' },
    { id: 'recahYtt7UJsv32oF', Status: 'abandoned', 'Amount Cents': 65000, 'Referral Id Text': 'recbnzdZB4MixIyh5', 'Created At': '2026-07-14T23:27:28.239Z' },
    { id: 'recp13gT1d6vyKfjz', Status: 'abandoned', 'Amount Cents': 40000, 'Referral Id Text': 'rec76CDnbM9p5pVfh', 'Created At': '2026-08-10T23:20:16.669Z' },
    { id: 'recqOWkYcJumE8SY7', Status: 'abandoned', 'Amount Cents': 50000, 'Referral Id Text': 'recMhAJqSedunVtrb', 'Created At': '2026-07-02T09:32:12.817Z' },
    { id: 'rec5uCKVu2CfFxytM', Status: 'succeeded', 'Amount Cents': 65000, 'Referral Id Text': 'recbnzdZB4MixIyh5' },
    { id: 'rec5twpf7WZ3rTux0', Status: 'succeeded', 'Amount Cents': 40000, 'Referral Id Text': 'rec76CDnbM9p5pVfh' },
  ];
  const rows = selectOwedAbandonedPayments(payments, referrals);
  assert.deepEqual(ids(rows), ['recqOWkYcJumE8SY7']);
  assert.equal(
    rows.reduce((s, r) => s + Number(r['Amount Cents'] || 0), 0),
    50000,
    'owed is $500, not the $2,850 the cockpit showed',
  );
});

// ── the route wires the shared selector (no second copy of the rule) ────────
test('WIRING /api/admin/today: the money band selects through this module', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const src = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', 'api', 'admin', 'today', 'route.ts'),
    'utf8',
  );
  assert.match(src, /selectOwedAbandonedPayments/, 'the cockpit must not hand-roll the abandoned filter');
  assert.doesNotMatch(
    src.replace(/^\s*\/\/.*$/gm, ''),
    /str\(p\['Status'\]\) === 'abandoned'/,
    'the old inline filter (no settled check, no dedupe) is gone',
  );
});
