// lib/quizStart.test.ts
// Runner: JWT_SECRET=test-secret-ci npx tsx --test lib/quizStart.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldFireQuizStart,
  buildQuizStartPayload,
  sanitizeQuizStartMetadata,
  QUIZ_START_STAGE,
  QUIZ_START_METADATA_KEYS,
} from './quizStart';

test('stage name is the audited constant (dashboard joins on it)', () => {
  assert.equal(QUIZ_START_STAGE, 'quiz_start');
});

// ── double-fire guard ────────────────────────────────────────────────────────

test('fires for a fresh-mode first answer', () => {
  assert.equal(shouldFireQuizStart({ mode: 'fresh', alreadyFired: false }), true);
});

test('NEVER double-fires: alreadyFired blocks regardless of mode', () => {
  assert.equal(shouldFireQuizStart({ mode: 'fresh', alreadyFired: true }), false);
  assert.equal(shouldFireQuizStart({ mode: 'resume', alreadyFired: true }), false);
});

test('resume mode never fires (buyer already has a signup event)', () => {
  assert.equal(shouldFireQuizStart({ mode: 'resume', alreadyFired: false }), false);
});

test('unknown mode fails closed (no event)', () => {
  assert.equal(shouldFireQuizStart({ mode: '', alreadyFired: false }), false);
  assert.equal(shouldFireQuizStart({ mode: 'weird', alreadyFired: false }), false);
});

// ── client payload builder ───────────────────────────────────────────────────

test('payload keeps allowlisted keys, drops empties, clamps long values', () => {
  const p = buildQuizStartPayload({
    state: 'TX',
    source: ' funnel ',
    utm_source: 'x'.repeat(500),
    utm_medium: '',
    campaign: undefined,
  });
  assert.equal(p.state, 'TX');
  assert.equal(p.source, 'funnel');
  assert.equal(p.utm_source?.length, 200);
  assert.equal('utm_medium' in p, false);
  assert.equal('campaign' in p, false);
});

// ── server-side sanitizer (public endpoint — must fail closed) ───────────────

test('sanitizer rejects non-object bodies', () => {
  assert.equal(sanitizeQuizStartMetadata(null), null);
  assert.equal(sanitizeQuizStartMetadata('quiz_start'), null);
  assert.equal(sanitizeQuizStartMetadata(42), null);
  assert.equal(sanitizeQuizStartMetadata([{ state: 'TX' }]), null);
});

test('sanitizer drops unknown keys and non-string values', () => {
  const m = sanitizeQuizStartMetadata({
    state: 'CO',
    evil: 'ignore-me',
    __proto__foo: 'x',
    utm_campaign: { nested: true },
    utm_source: 123,
  });
  assert.ok(m);
  assert.equal(m!.state, 'CO');
  assert.equal('evil' in m!, false);
  assert.equal('utm_campaign' in m!, false);
  assert.equal(m!.utm_source, '123'); // numbers coerce (harmless)
});

test('sanitizer clamps every value to 200 chars', () => {
  const m = sanitizeQuizStartMetadata({ source: 'y'.repeat(9999) });
  assert.ok(m);
  assert.equal(m!.source.length, 200);
});

test('sanitizer of an empty object is an empty metadata (still a valid event)', () => {
  const m = sanitizeQuizStartMetadata({});
  assert.ok(m);
  assert.equal(Object.keys(m!).length, 0);
});

test('allowlist covers the dimensions the signup event stores', () => {
  for (const k of ['state', 'source', 'utm_source', 'utm_campaign']) {
    assert.ok((QUIZ_START_METADATA_KEYS as readonly string[]).includes(k));
  }
});
