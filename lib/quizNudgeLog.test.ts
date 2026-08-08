import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseQuizNudgeDates,
  decideQuizNudge,
  appendQuizNudgeLog,
  QUIZ_NUDGE_MAX_TOUCHES,
} from './quizNudgeLog';

const TODAY = '2026-08-02';

test('fresh buyer (no notes, no log) → send touch 1', () => {
  assert.deepEqual(decideQuizNudge({ notes: '', log: '', today: TODAY }), {
    action: 'send',
    touchNum: 1,
  });
});

test('parseQuizNudgeDates merges notes markers + log entries, deduped + sorted', () => {
  const notes = '[quiz-nudge 2026-07-30 t2] sent. [quiz-nudge 2026-07-28 t1] sent. hello';
  const log = 't1:2026-07-28;t2:2026-07-30';
  assert.deepEqual(parseQuizNudgeDates(notes, log), ['2026-07-28', '2026-07-30']);
});

test('legacy [abandoned-quiz-nudge] notes stamp still counts as a touch', () => {
  assert.deepEqual(parseQuizNudgeDates('[abandoned-quiz-nudge 2026-07-25] sent', ''), [
    '2026-07-25',
  ]);
});

test('TRUNCATION FIX: log-only state (notes markers sliced away) does NOT restart the drip', () => {
  // The exact bug: a chatty Notes field lost its markers to .slice(0, 2000).
  // With the durable log carrying all 4 touches, the drip stays exhausted.
  const longNotes = 'x'.repeat(1900); // no markers survived
  const log = 't1:2026-07-10;t2:2026-07-12;t3:2026-07-16;t4:2026-07-23';
  assert.deepEqual(decideQuizNudge({ notes: longNotes, log, today: TODAY }), {
    action: 'skip',
    reason: 'exhausted',
  });
});

test('TRANSITION: notes marker present but log still empty must not restart', () => {
  // Deploy-window case: buyer was nudged t1 under the old Notes-only scheme.
  // Empty log + surviving marker → next touch is t2, never a fresh t1.
  const notes = '[quiz-nudge 2026-07-31 t1] sent. some earlier notes';
  const d = decideQuizNudge({ notes, log: '', today: TODAY });
  assert.deepEqual(d, { action: 'send', touchNum: 2 }); // 2 days elapsed ≥ spacing[1]=2
});

test('one touch per day: same-day marker in EITHER source skips', () => {
  assert.deepEqual(
    decideQuizNudge({ notes: `[quiz-nudge ${TODAY} t1] sent.`, log: '', today: TODAY }),
    { action: 'skip', reason: 'sent-today' },
  );
  assert.deepEqual(decideQuizNudge({ notes: '', log: `t1:${TODAY}`, today: TODAY }), {
    action: 'skip',
    reason: 'sent-today',
  });
});

test('spacing: touch 2 waits 2 days after touch 1', () => {
  assert.deepEqual(decideQuizNudge({ notes: '', log: 't1:2026-08-01', today: TODAY }), {
    action: 'skip',
    reason: 'spacing',
  });
  assert.deepEqual(decideQuizNudge({ notes: '', log: 't1:2026-07-31', today: TODAY }), {
    action: 'send',
    touchNum: 2,
  });
});

test('P5′: touch 3 due at day 4 (~48h after touch 2)', () => {
  assert.deepEqual(
    decideQuizNudge({ notes: '', log: 't1:2026-07-29;t2:2026-07-31', today: TODAY }),
    { action: 'send', touchNum: 3 },
  );
  // Inside the 48h gap → held.
  assert.deepEqual(
    decideQuizNudge({ notes: '', log: 't1:2026-07-30;t2:2026-08-01', today: TODAY }),
    { action: 'skip', reason: 'spacing' },
  );
});

test('P5′: touch 4 is the ONE decay touch — after the 7d window, "last call"', () => {
  // t1 07-24 → window ends 07-31; today 08-02 is decay; 5d since t3 → send.
  assert.deepEqual(
    decideQuizNudge({ notes: '', log: 't1:2026-07-24;t2:2026-07-26;t3:2026-07-28', today: TODAY }),
    { action: 'send', touchNum: 4 },
  );
  // Sprint budget spent but window still open → silent (decay comes later).
  assert.deepEqual(
    decideQuizNudge({ notes: '', log: 't1:2026-07-28;t2:2026-07-30;t3:2026-08-01', today: TODAY }),
    { action: 'skip', reason: 'spacing' },
  );
});

test('P5′: decay window expired (t1 + 14d) → exhausted, never a late touch 4', () => {
  assert.deepEqual(
    decideQuizNudge({ notes: '', log: 't1:2026-07-10;t2:2026-07-12;t3:2026-07-16', today: TODAY }),
    { action: 'skip', reason: 'exhausted' },
  );
});

test('exhausted after MAX_TOUCHES', () => {
  const log = 't1:2026-07-01;t2:2026-07-03;t3:2026-07-07;t4:2026-07-14';
  assert.equal(QUIZ_NUDGE_MAX_TOUCHES, 4);
  assert.deepEqual(decideQuizNudge({ notes: '', log, today: TODAY }), {
    action: 'skip',
    reason: 'exhausted',
  });
});

test('appendQuizNudgeLog builds the tN:date format append-only', () => {
  assert.equal(appendQuizNudgeLog('', 1, '2026-08-02'), 't1:2026-08-02');
  assert.equal(appendQuizNudgeLog(undefined, 1, '2026-08-02'), 't1:2026-08-02');
  assert.equal(
    appendQuizNudgeLog('t1:2026-08-02', 2, '2026-08-04'),
    't1:2026-08-02;t2:2026-08-04',
  );
});

test('malformed inputs never throw and never send a bogus touch number', () => {
  assert.deepEqual(decideQuizNudge({ notes: null, log: undefined, today: TODAY }), {
    action: 'send',
    touchNum: 1,
  });
  assert.deepEqual(parseQuizNudgeDates(12345 as unknown, { junk: true } as unknown), []);
});
