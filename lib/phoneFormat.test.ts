// lib/phoneFormat.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhoneDigits, isValidUsPhone, formatPhoneInput } from './phoneFormat';

// ── THE REGRESSION ──────────────────────────────────────────────────────────
// Every door used to slice(0,10) the raw digit string, so a leading country
// code shifted the whole number left and produced a DIFFERENT, still-10-digit,
// still-"valid" phone. Phone is the email-bounce rescue channel; a silently
// wrong one is worse than a missing one.

test('leading US country code is stripped, not sliced off the end', () => {
  assert.equal(normalizePhoneDigits('14065551234'), '4065551234');
  assert.equal(formatPhoneInput('14065551234'), '(406) 555-1234');
});

test('every human spelling of the same number lands on the same digits', () => {
  for (const raw of [
    '1 (406) 555-1234',
    '+1 406 555 1234',
    '1-406-555-1234',
    '1.406.555.1234',
    '(406) 555-1234',
    '406 555 1234',
    '4065551234',
  ]) {
    assert.equal(normalizePhoneDigits(raw), '4065551234', `failed for ${raw}`);
    assert.equal(formatPhoneInput(raw), '(406) 555-1234', `failed for ${raw}`);
  }
});

test('a plain 10-digit number is untouched', () => {
  assert.equal(normalizePhoneDigits('4065551234'), '4065551234');
  assert.equal(formatPhoneInput('4065551234'), '(406) 555-1234');
});

// ── validity ────────────────────────────────────────────────────────────────

test('7 digits stays invalid (a local number is not reachable)', () => {
  assert.equal(isValidUsPhone('5551234'), false);
  assert.equal(isValidUsPhone('555-1234'), false);
});

test('10 digits and 1+10 digits are both valid', () => {
  assert.equal(isValidUsPhone('4065551234'), true);
  assert.equal(isValidUsPhone('1 (406) 555-1234'), true);
  assert.equal(isValidUsPhone('+1 406 555 1234'), true);
});

test('empty / null / undefined are invalid, never a crash', () => {
  assert.equal(isValidUsPhone(''), false);
  assert.equal(isValidUsPhone(null), false);
  assert.equal(isValidUsPhone(undefined), false);
  assert.equal(normalizePhoneDigits(null), '');
  assert.equal(formatPhoneInput(undefined), '');
});

test('11 digits NOT starting with 1 is left whole — never truncated', () => {
  // 44… is a UK country code; slicing it to 10 would fabricate a US number.
  assert.equal(normalizePhoneDigits('44065551234'), '44065551234');
  assert.equal(formatPhoneInput('44065551234'), '(440) 655-51234');
});

test('acceptance matches the guards this replaces (>= 10 digits) — no NEW rejections', () => {
  // Supply is the only constraint: a door must never start rejecting ranchers
  // it used to accept. An extension or an international number still gets in;
  // what changed is that nothing is silently truncated into a WRONG number.
  assert.equal(isValidUsPhone('44065551234'), true);
  assert.equal(isValidUsPhone('406-555-1234 x12'), true);
  assert.equal(formatPhoneInput('406-555-1234 x12'), '(406) 555-123412');
});

// ── formatter shape (typing progression) ────────────────────────────────────

test('non-digits are stripped', () => {
  assert.equal(normalizePhoneDigits('abc406def555ghi1234'), '4065551234');
  assert.equal(formatPhoneInput('ext. 406-555-1234'), '(406) 555-1234');
});

test('partial entry formats progressively', () => {
  assert.equal(formatPhoneInput(''), '');
  assert.equal(formatPhoneInput('4'), '(4');
  assert.equal(formatPhoneInput('406'), '(406');
  assert.equal(formatPhoneInput('4065'), '(406) 5');
  assert.equal(formatPhoneInput('406555'), '(406) 555');
  assert.equal(formatPhoneInput('4065551'), '(406) 555-1');
});

test('a lone country-code digit still types forward (no dead input)', () => {
  // The user typed "1" first — it is not yet an 11-digit string, so it renders
  // as the start of an area code and resolves itself as they keep typing.
  assert.equal(formatPhoneInput('1'), '(1');
  assert.equal(formatPhoneInput('1406555123'), '(140) 655-5123');
  // …and the moment the 11th digit lands, the country code drops out.
  assert.equal(formatPhoneInput('14065551234'), '(406) 555-1234');
});
