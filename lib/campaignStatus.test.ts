// lib/campaignStatus.test.ts
//
// Campaigns.Status has no 'Scheduled' choice, but both schedulers wrote it.
// selectGuard dropped the key, the row was born BLANK, and send-scheduled
// matched only 'scheduled' | 'sending' — so every campaign scheduled from
// /admin/broadcast or Telegram silently NEVER SENT.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAMPAIGN_STATUS_QUEUED,
  CAMPAIGN_SENDABLE_STATUSES,
  isCampaignSendable,
} from './campaignStatus';
// The committed snapshot of the REAL base — this is what makes the pin real
// rather than two constants agreeing with each other.
import { AIRTABLE_SELECT_FIELDS } from './schema/airtableSchema.generated';

const choices = AIRTABLE_SELECT_FIELDS['Campaigns']?.['Status']?.choices ?? [];

test('the status the schedulers write is an ACTUAL choice on the field', () => {
  assert.ok(choices.length > 0, 'snapshot must know this field');
  assert.ok(
    choices.includes(CAMPAIGN_STATUS_QUEUED),
    `${CAMPAIGN_STATUS_QUEUED} is not a real choice (${choices.join(' / ')}) — ` +
      'selectGuard will drop it and the campaign will never send',
  );
});

test("'Scheduled' is confirmed NOT a choice — this is the bug, pinned", () => {
  assert.equal(
    choices.includes('Scheduled'),
    false,
    'if Scheduled ever becomes a real option, revisit the sender and this file',
  );
});

test('the sender picks up exactly what the scheduler writes', () => {
  assert.ok(
    isCampaignSendable(CAMPAIGN_STATUS_QUEUED),
    'the write and the read must not drift apart again — that drift was the outage',
  );
});

test('a blank status is never sendable (that is what a dropped write leaves behind)', () => {
  for (const blank of ['', '   ', null, undefined]) {
    assert.equal(isCampaignSendable(blank), false);
  }
});

test('a mid-send campaign resumes, and terminal ones stay put', () => {
  assert.equal(isCampaignSendable('Sending'), true, 'must resume after a maxDuration kill');
  for (const terminal of ['Sent', 'Aborted', 'Failed', 'Partial', 'Aborting']) {
    assert.equal(isCampaignSendable(terminal), false, `${terminal} must not re-send`);
  }
});

test('matching is case-insensitive, since the field is Title Case and the code lowercases', () => {
  assert.equal(isCampaignSendable('PENDING'), true);
  assert.equal(isCampaignSendable('pending'), true);
});
