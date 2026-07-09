import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strandedMatchedBuyerIds } from './strandedBuyers';

const consumer = (id: string, stage: string) => ({ id, 'Buyer Stage': stage });
const ref = (buyer: string, status: string, rancher = true) => ({
  Status: status,
  Buyer: [buyer],
  ...(rancher ? { Rancher: ['recRANCH000000001'] } : {}),
});

test('stranded: MATCHED with a Closed Lost referral → reset', () => {
  const ids = strandedMatchedBuyerIds(
    [consumer('recA', 'MATCHED')],
    [ref('recA', 'Closed Lost')],
  );
  assert.deepEqual(ids, ['recA']);
});

test('stranded: MATCHED with a live deal → NOT reset', () => {
  for (const live of ['Intro Sent', 'Rancher Contacted', 'Negotiation', 'Awaiting Payment', 'Slot Locked']) {
    assert.deepEqual(
      strandedMatchedBuyerIds([consumer('recA', 'MATCHED')], [ref('recA', live)]),
      [],
      `${live} is a live deal — must not reset`,
    );
  }
});

test('stranded: MATCHED with a Dormant referral → reset (terminal)', () => {
  assert.deepEqual(
    strandedMatchedBuyerIds([consumer('recA', 'MATCHED')], [ref('recA', 'Dormant')]),
    ['recA'],
  );
});

test('stranded: MATCHED with NO referral at all → reset', () => {
  assert.deepEqual(strandedMatchedBuyerIds([consumer('recA', 'MATCHED')], []), ['recA']);
});

test('stranded: orphan Pending Approval (no rancher link) does NOT count as live → reset', () => {
  // isActiveDealReferral treats Pending Approval WITHOUT a rancher as inactive
  assert.deepEqual(
    strandedMatchedBuyerIds([consumer('recA', 'MATCHED')], [ref('recA', 'Pending Approval', false)]),
    ['recA'],
  );
});

test('stranded: Pending Approval WITH a rancher link is live → not reset', () => {
  assert.deepEqual(
    strandedMatchedBuyerIds([consumer('recA', 'MATCHED')], [ref('recA', 'Pending Approval', true)]),
    [],
  );
});

test('stranded: only MATCHED stage is touched (READY/WAITING/CLOSED ignored)', () => {
  const cs = [
    consumer('recREADY', 'READY'),
    consumer('recWAIT', 'WAITING'),
    consumer('recWON', 'CLOSED'),
    consumer('recM', 'MATCHED'),
  ];
  assert.deepEqual(strandedMatchedBuyerIds(cs, []), ['recM']);
});

test('stranded: a buyer with one dead + one live referral is NOT reset', () => {
  const ids = strandedMatchedBuyerIds(
    [consumer('recA', 'MATCHED')],
    [ref('recA', 'Closed Lost'), ref('recA', 'Intro Sent')],
  );
  assert.deepEqual(ids, []);
});

test('stranded: singleSelect stage object shape is read', () => {
  assert.deepEqual(
    strandedMatchedBuyerIds([{ id: 'recA', 'Buyer Stage': { name: 'MATCHED' } }], []),
    ['recA'],
  );
});
