import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toFollowUpYmd,
  isFollowUpSuppressed,
  isTerminalFollowUpStage,
  followUpDaysOverdue,
  selectDueFollowUps,
  validateFollowUpDate,
  snoozeFollowUpDate,
  operatorToday,
  followUpContextLine,
  FOLLOW_UP_MAX_DAYS_AHEAD,
  type FollowUpConsumerLike,
} from './followUpQueue';

// This repo is PUBLIC. Synthetic buyers only — no real names, emails, phones,
// or record ids (docs/WRITE-MAP.md rule zero + the privacy note in CLAUDE.md).
const TODAY = '2026-07-31';

function row(over: Partial<FollowUpConsumerLike> = {}): FollowUpConsumerLike {
  return {
    id: 'rec0000000000000',
    'Full Name': 'Test Buyer',
    Phone: '+15555550100',
    State: 'TX',
    'Buyer Stage': 'WAITING',
    ...over,
  };
}

// ── toFollowUpYmd ──────────────────────────────────────────────────────────
// The field is DATE-ONLY. Everything downstream compares calendar days as
// strings, so this normalizer is the only place a value becomes comparable.

test('toFollowUpYmd passes through a plain Airtable date value', () => {
  assert.equal(toFollowUpYmd('2026-08-02'), '2026-08-02');
});

test('toFollowUpYmd takes the DATE off a full ISO datetime, never re-zones it', () => {
  // A dateTime written by hand into a date field, or a Date coerced upstream.
  // 23:30Z on the 2nd is still the 2nd — shifting it to local time here is how
  // a follow-up silently moves a day.
  assert.equal(toFollowUpYmd('2026-08-02T23:30:00.000Z'), '2026-08-02');
  assert.equal(toFollowUpYmd('2026-08-02T00:15:00.000Z'), '2026-08-02');
});

test('toFollowUpYmd rejects blank, junk, and impossible calendar dates', () => {
  assert.equal(toFollowUpYmd(''), null);
  assert.equal(toFollowUpYmd('   '), null);
  assert.equal(toFollowUpYmd(null), null);
  assert.equal(toFollowUpYmd(undefined), null);
  assert.equal(toFollowUpYmd('next tuesday'), null);
  assert.equal(toFollowUpYmd('08/02/2026'), null);
  assert.equal(toFollowUpYmd('2026-13-01'), null); // month 13
  assert.equal(toFollowUpYmd('2026-02-30'), null); // Feb 30 does not exist
  assert.equal(toFollowUpYmd('2026-00-10'), null);
});

test('toFollowUpYmd accepts a real leap day and rejects a fake one', () => {
  assert.equal(toFollowUpYmd('2028-02-29'), '2028-02-29'); // leap year
  assert.equal(toFollowUpYmd('2026-02-29'), null); // not a leap year
});

// ── suppression + terminal stage ───────────────────────────────────────────

test('isFollowUpSuppressed catches the standard Consumers trio', () => {
  assert.equal(isFollowUpSuppressed(row()), false);
  assert.equal(isFollowUpSuppressed(row({ Unsubscribed: true })), true);
  assert.equal(isFollowUpSuppressed(row({ Bounced: true })), true);
  assert.equal(isFollowUpSuppressed(row({ Complained: true })), true);
});

test('isFollowUpSuppressed treats an unchecked Airtable checkbox as contactable', () => {
  // Airtable omits false checkboxes entirely; undefined must not read as true.
  assert.equal(isFollowUpSuppressed(row({ Unsubscribed: undefined })), false);
  assert.equal(isFollowUpSuppressed(row({ Unsubscribed: false })), false);
});

test('isTerminalFollowUpStage is CLOSED only', () => {
  assert.equal(isTerminalFollowUpStage('CLOSED'), true);
  assert.equal(isTerminalFollowUpStage('closed'), true);
  assert.equal(isTerminalFollowUpStage(' CLOSED '), true);
  for (const s of ['NEW', 'WAITING', 'READY', 'MATCHED', 'NURTURE', 'PRODUCT_BUYER', '']) {
    assert.equal(isTerminalFollowUpStage(s), false, `${s} must stay workable`);
  }
});

// ── followUpDaysOverdue ────────────────────────────────────────────────────

test('followUpDaysOverdue counts whole calendar days, zero when due today', () => {
  assert.equal(followUpDaysOverdue('2026-07-31', TODAY), 0);
  assert.equal(followUpDaysOverdue('2026-07-30', TODAY), 1);
  assert.equal(followUpDaysOverdue('2026-07-17', TODAY), 14);
});

test('followUpDaysOverdue is negative for a future promise', () => {
  assert.equal(followUpDaysOverdue('2026-08-02', TODAY), -2);
});

test('followUpDaysOverdue crosses months and years without drifting', () => {
  assert.equal(followUpDaysOverdue('2026-06-30', TODAY), 31);
  assert.equal(followUpDaysOverdue('2025-07-31', TODAY), 365);
});

test('followUpDaysOverdue is DST-proof — a spring-forward span is whole days', () => {
  // 2026-03-08 is the US DST jump. Epoch-diff math on local midnights returns
  // 22.96 days here and floors to 22; calendar math must say 23.
  assert.equal(followUpDaysOverdue('2026-03-01', '2026-03-24'), 23);
});

// ── selectDueFollowUps — the boundaries ────────────────────────────────────

test('a follow-up promised for EXACTLY today is due', () => {
  const out = selectDueFollowUps([row({ 'Next Follow Up At': TODAY })], TODAY);
  assert.equal(out.length, 1);
  assert.equal(out[0].daysOverdue, 0);
  assert.equal(out[0].dueAt, TODAY);
});

test('a follow-up promised for tomorrow is NOT due yet', () => {
  assert.equal(selectDueFollowUps([row({ 'Next Follow Up At': '2026-08-01' })], TODAY).length, 0);
});

test('a blank / missing / junk follow-up date is never due', () => {
  assert.equal(selectDueFollowUps([row()], TODAY).length, 0);
  assert.equal(selectDueFollowUps([row({ 'Next Follow Up At': '' })], TODAY).length, 0);
  assert.equal(selectDueFollowUps([row({ 'Next Follow Up At': null })], TODAY).length, 0);
  assert.equal(selectDueFollowUps([row({ 'Next Follow Up At': 'soon' })], TODAY).length, 0);
});

test('a follow-up overdue by weeks is due and reports the real age', () => {
  const out = selectDueFollowUps([row({ 'Next Follow Up At': '2026-07-10' })], TODAY);
  assert.equal(out.length, 1);
  assert.equal(out[0].daysOverdue, 21);
});

test('suppressed buyers are dropped even when badly overdue', () => {
  const due = { 'Next Follow Up At': '2026-06-01' };
  assert.equal(selectDueFollowUps([row({ ...due, Unsubscribed: true })], TODAY).length, 0);
  assert.equal(selectDueFollowUps([row({ ...due, Bounced: true })], TODAY).length, 0);
  assert.equal(selectDueFollowUps([row({ ...due, Complained: true })], TODAY).length, 0);
});

test('a CLOSED buyer is dropped — the deal is over, the promise expired with it', () => {
  const out = selectDueFollowUps(
    [row({ 'Next Follow Up At': '2026-07-01', 'Buyer Stage': 'CLOSED' })],
    TODAY,
  );
  assert.equal(out.length, 0);
});

test('every non-terminal stage still surfaces', () => {
  const rows = ['NEW', 'WAITING', 'READY', 'MATCHED', 'NURTURE', 'PRODUCT_BUYER'].map((s, i) =>
    row({ id: `rec00000000000${i}`, 'Buyer Stage': s, 'Next Follow Up At': TODAY }),
  );
  assert.equal(selectDueFollowUps(rows, TODAY).length, 6);
});

test('most-overdue sorts first; today lands last', () => {
  const rows = [
    row({ id: 'recB', 'Next Follow Up At': TODAY }),
    row({ id: 'recA', 'Next Follow Up At': '2026-06-15' }),
    row({ id: 'recC', 'Next Follow Up At': '2026-07-29' }),
  ];
  assert.deepEqual(
    selectDueFollowUps(rows, TODAY).map((r) => r.id),
    ['recA', 'recC', 'recB'],
  );
});

test('ties break on record id so two renders never swap rows', () => {
  const rows = [
    row({ id: 'recZ', 'Next Follow Up At': '2026-07-20' }),
    row({ id: 'recA', 'Next Follow Up At': '2026-07-20' }),
  ];
  assert.deepEqual(
    selectDueFollowUps(rows, TODAY).map((r) => r.id),
    ['recA', 'recZ'],
  );
});

test('the row carries the context Ben needs to make the call', () => {
  const [r] = selectDueFollowUps(
    [
      row({
        'Next Follow Up At': '2026-07-29',
        'Full Name': 'Sample Buyer',
        Phone: '+15555550142',
        State: 'CO',
        'Admin Notes': 'Wants a quarter in the fall. Call back after payday.',
      }),
    ],
    TODAY,
  );
  assert.equal(r.name, 'Sample Buyer');
  assert.equal(r.phone, '+15555550142');
  assert.equal(r.state, 'CO');
  assert.equal(r.notes, 'Wants a quarter in the fall. Call back after payday.');
  assert.equal(r.daysOverdue, 2);
});

test('a nameless buyer still shows up rather than rendering blank', () => {
  const [r] = selectDueFollowUps([row({ 'Full Name': '', 'Next Follow Up At': TODAY })], TODAY);
  assert.equal(r.name, '(no name)');
});

test('selectDueFollowUps tolerates empty / non-array input', () => {
  assert.deepEqual(selectDueFollowUps([], TODAY), []);
  assert.deepEqual(selectDueFollowUps(null as any, TODAY), []);
  assert.deepEqual(selectDueFollowUps(undefined as any, TODAY), []);
});

test('selectDueFollowUps accepts a Date for `today` as well as a string', () => {
  const out = selectDueFollowUps(
    [row({ 'Next Follow Up At': '2026-07-31' })],
    new Date('2026-07-31T18:00:00.000Z'),
  );
  assert.equal(out.length, 1);
});

test('an unusable `today` selects NOTHING rather than everything', () => {
  // Failing toward a silent empty digest beats blasting every promise ever made.
  assert.deepEqual(selectDueFollowUps([row({ 'Next Follow Up At': '2026-01-01' })], 'junk'), []);
});

// ── operatorToday ──────────────────────────────────────────────────────────

test('operatorToday returns BEN\'s calendar day, not UTC\'s', () => {
  // 01:30Z on Aug 1 is still 7:30pm on Jul 31 in Denver. A UTC-derived "today"
  // would surface Aug 1's promises all evening, every evening.
  assert.equal(operatorToday(new Date('2026-08-01T01:30:00.000Z')), '2026-07-31');
  // Mid-morning, the two agree — which is why the cron's schedule hides this.
  assert.equal(operatorToday(new Date('2026-07-31T14:07:00.000Z')), '2026-07-31');
});

test('operatorToday handles the winter offset too', () => {
  // MST (UTC-7): 06:00Z Jan 2 is 11pm Jan 1 in Denver.
  assert.equal(operatorToday(new Date('2026-01-02T06:00:00.000Z')), '2026-01-01');
  assert.equal(operatorToday(new Date('2026-01-02T08:00:00.000Z')), '2026-01-02');
});

test('operatorToday output is directly usable by the selector', () => {
  const today = operatorToday(new Date('2026-07-31T20:00:00.000Z'));
  assert.equal(toFollowUpYmd(today), today);
  assert.equal(selectDueFollowUps([row({ 'Next Follow Up At': today })], today).length, 1);
});

test('operatorToday accepts an explicit timezone and rejects bad clocks', () => {
  assert.equal(operatorToday(new Date('2026-08-01T01:30:00.000Z'), 'UTC'), '2026-08-01');
  assert.equal(operatorToday(new Date('nope')), '');
});

// ── followUpContextLine ────────────────────────────────────────────────────

test('followUpContextLine takes the first non-empty line of the notes', () => {
  assert.equal(
    followUpContextLine('Wants a quarter in the fall.\nCalled 7/12, no answer.'),
    'Wants a quarter in the fall.',
  );
  assert.equal(followUpContextLine('\n\n  Second line is the headline.  \nmore'), 'Second line is the headline.');
});

test('followUpContextLine collapses whitespace and handles blanks', () => {
  assert.equal(followUpContextLine('a   b\t\tc'), 'a b c');
  assert.equal(followUpContextLine(''), '');
  assert.equal(followUpContextLine('   \n  \n '), '');
  assert.equal(followUpContextLine(null), '');
  assert.equal(followUpContextLine(undefined), '');
});

test('followUpContextLine truncates long notes on a word boundary', () => {
  const long = 'Wants a half but is waiting on a freezer to be delivered before committing to anything';
  const out = followUpContextLine(long, 40);
  assert.ok(out.length <= 41, `got ${out.length}: ${out}`);
  assert.ok(out.endsWith('…'));
  assert.ok(!out.includes('  '));
  assert.ok(long.startsWith(out.slice(0, -1)));
});

test('followUpContextLine does not collapse a single long token to nothing', () => {
  const out = followUpContextLine('x'.repeat(50), 20);
  assert.equal(out, `${'x'.repeat(20)}…`);
});

test('followUpContextLine leaves a short line untouched', () => {
  assert.equal(followUpContextLine('Call after payday', 80), 'Call after payday');
});

// ── validateFollowUpDate — the write path ──────────────────────────────────

test('validateFollowUpDate accepts today and the near future', () => {
  assert.deepEqual(validateFollowUpDate(TODAY, TODAY), { ok: true, value: TODAY });
  assert.deepEqual(validateFollowUpDate('2026-08-14', TODAY), { ok: true, value: '2026-08-14' });
});

test('validateFollowUpDate rejects the past — you cannot promise backwards', () => {
  const r = validateFollowUpDate('2026-07-30', TODAY);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.error : '', /past/i);
});

test('validateFollowUpDate rejects garbage and blanks', () => {
  for (const bad of ['', '   ', 'tomorrow', '07/30/2026', '2026-02-30', null, undefined, 42]) {
    assert.equal(validateFollowUpDate(bad as any, TODAY).ok, false, `${String(bad)} must fail`);
  }
});

test('validateFollowUpDate caps the horizon at about a year', () => {
  const okEdge = '2027-07-31'; // exactly 365 days out
  assert.equal(validateFollowUpDate(okEdge, TODAY).ok, true);
  const tooFar = validateFollowUpDate('2031-01-01', TODAY);
  assert.equal(tooFar.ok, false);
  assert.match(tooFar.ok === false ? tooFar.error : '', /year|far/i);
  assert.equal(FOLLOW_UP_MAX_DAYS_AHEAD, 365);
});

test('validateFollowUpDate normalizes an ISO datetime down to its date', () => {
  assert.deepEqual(validateFollowUpDate('2026-08-05T14:00:00.000Z', TODAY), {
    ok: true,
    value: '2026-08-05',
  });
});

test('validateFollowUpDate refuses to run against an unusable today', () => {
  assert.equal(validateFollowUpDate('2026-08-05', 'junk').ok, false);
});

// ── snoozeFollowUpDate ─────────────────────────────────────────────────────

test('snoozeFollowUpDate advances from TODAY, not from the missed date', () => {
  // The point of a snooze is "not now, try again in 3 days". Advancing from a
  // three-week-old promise would return a date still in the past, and the row
  // would never leave the desk.
  assert.equal(snoozeFollowUpDate(TODAY, 3), '2026-08-03');
  assert.equal(snoozeFollowUpDate(TODAY, 7), '2026-08-07');
});

test('snoozeFollowUpDate crosses month and year boundaries correctly', () => {
  assert.equal(snoozeFollowUpDate('2026-12-30', 7), '2027-01-06');
  assert.equal(snoozeFollowUpDate('2028-02-27', 3), '2028-03-01'); // leap year
  assert.equal(snoozeFollowUpDate('2026-02-27', 3), '2026-03-02'); // non-leap
});

test('snoozeFollowUpDate is DST-proof', () => {
  assert.equal(snoozeFollowUpDate('2026-03-07', 3), '2026-03-10');
});

test('snoozeFollowUpDate returns null on an unusable base date', () => {
  assert.equal(snoozeFollowUpDate('junk', 3), null);
  assert.equal(snoozeFollowUpDate('', 3), null);
});
