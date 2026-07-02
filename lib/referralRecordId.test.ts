// lib/referralRecordId.test.ts
// Runner: JWT_SECRET=test-secret-ci npx tsx --test lib/referralRecordId.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  firstLinkId,
  stampRancherRecordIds,
  referralRecordIdRepair,
} from './referralRecordId';

test('firstLinkId returns the first id or empty', () => {
  assert.equal(firstLinkId(['recABC']), 'recABC');
  assert.equal(firstLinkId(['recABC', 'recDEF']), 'recABC');
  assert.equal(firstLinkId([]), '');
  assert.equal(firstLinkId(undefined), '');
  assert.equal(firstLinkId('recABC'), ''); // must be an array
});

test('stampRancherRecordIds stamps from Rancher + Suggested Rancher links', () => {
  const out = stampRancherRecordIds({
    Status: 'Intro Sent',
    Rancher: ['recRANCH01'],
    'Suggested Rancher': ['recSUGG01'],
  } as Record<string, any>);
  assert.equal(out['Rancher Record Id'], 'recRANCH01');
  assert.equal(out['Suggested Rancher Record Id'], 'recSUGG01');
  assert.equal(out['Status'], 'Intro Sent'); // preserves existing fields
});

test('stampRancherRecordIds no-ops fields with no link (waitlist referral)', () => {
  const out = stampRancherRecordIds({ Status: 'Pending Approval', Buyer: ['recBUYER'] });
  assert.equal('Rancher Record Id' in out, false);
  assert.equal('Suggested Rancher Record Id' in out, false);
});

test('stampRancherRecordIds does not mutate the input', () => {
  const input = { Rancher: ['recX'] } as Record<string, any>;
  const out = stampRancherRecordIds(input);
  assert.equal('Rancher Record Id' in input, false);
  assert.equal(out['Rancher Record Id'], 'recX');
});

test('referralRecordIdRepair: correct row → null (no write)', () => {
  assert.equal(
    referralRecordIdRepair({
      Rancher: ['recR'],
      'Rancher Record Id': 'recR',
      'Suggested Rancher': [],
      'Suggested Rancher Record Id': '',
    }),
    null,
  );
});

test('referralRecordIdRepair: missing stamp → patch to the link id', () => {
  assert.deepEqual(
    referralRecordIdRepair({ Rancher: ['recR'], 'Suggested Rancher': ['recS'] }),
    { 'Rancher Record Id': 'recR', 'Suggested Rancher Record Id': 'recS' },
  );
});

test('referralRecordIdRepair: stale stamp (reassigned) heals to the new link', () => {
  assert.deepEqual(
    referralRecordIdRepair({ Rancher: ['recNEW'], 'Rancher Record Id': 'recOLD' }),
    { 'Rancher Record Id': 'recNEW' },
  );
});

test('referralRecordIdRepair: cleared link clears the stamp (never surface an unlinked row)', () => {
  assert.deepEqual(
    referralRecordIdRepair({ Rancher: [], 'Rancher Record Id': 'recOLD' }),
    { 'Rancher Record Id': '' },
  );
});
