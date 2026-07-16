import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePhoneE164,
  isLikelyUsMobileShape,
  formatPhonePretty,
  smsHref,
  telHref,
  buyerIntroSmsBody,
  areaCodeState,
  phoneLooksOutOfState,
  AREA_CODE_STATE,
} from './phoneHygiene';

// ── normalizePhoneE164 ──────────────────────────────────────────────────────
test('normalizes common US formats to E.164', () => {
  assert.equal(normalizePhoneE164('7204917819'), '+17204917819');
  assert.equal(normalizePhoneE164('(720) 491-7819'), '+17204917819');
  assert.equal(normalizePhoneE164('720-491-7819'), '+17204917819');
  assert.equal(normalizePhoneE164('720.491.7819'), '+17204917819');
  assert.equal(normalizePhoneE164('17204917819'), '+17204917819');
  assert.equal(normalizePhoneE164('+1 720 491 7819'), '+17204917819');
});

test('rejects non-NANP shapes', () => {
  assert.equal(normalizePhoneE164('123456789'), null); // 9 digits
  assert.equal(normalizePhoneE164('12345678901234'), null); // too many
  assert.equal(normalizePhoneE164('0204917819'), null); // area code starts 0
  assert.equal(normalizePhoneE164('1204917819'), null); // area code starts 1
  assert.equal(normalizePhoneE164('7201917819'), null); // exchange starts 1
  assert.equal(normalizePhoneE164(''), null);
  assert.equal(normalizePhoneE164(null), null);
  assert.equal(normalizePhoneE164(undefined), null);
  assert.equal(normalizePhoneE164('not a phone'), null);
});

test('rejects obvious junk numbers', () => {
  assert.equal(normalizePhoneE164('5555555555'), null); // repeated digits
  assert.equal(normalizePhoneE164('9999999999'), null);
  assert.equal(normalizePhoneE164('1234567890'), null); // ascending
  assert.equal(normalizePhoneE164('7205551234'), null); // 555 exchange
  assert.equal(normalizePhoneE164('7205550100'), null); // fictional block
});

test('isLikelyUsMobileShape mirrors normalization', () => {
  assert.equal(isLikelyUsMobileShape('(406) 555-0100'), false);
  assert.equal(isLikelyUsMobileShape('(406) 240-1234'), true);
});

// ── formatPhonePretty ───────────────────────────────────────────────────────
test('pretty format for normalizable numbers', () => {
  assert.equal(formatPhonePretty('7204917819'), '(720) 491-7819');
  assert.equal(formatPhonePretty('+17204917819'), '(720) 491-7819');
});

test('pretty format falls back to trimmed input when unparseable', () => {
  assert.equal(formatPhonePretty('  call the barn  '), 'call the barn');
  assert.equal(formatPhonePretty(''), '');
  assert.equal(formatPhonePretty(null), '');
});

// ── smsHref / telHref ───────────────────────────────────────────────────────
test('smsHref builds the cross-platform ?&body= link', () => {
  const href = smsHref('(720) 491-7819', 'hi ben — quick question');
  assert.equal(href, `sms:+17204917819?&body=${encodeURIComponent('hi ben — quick question')}`);
});

test('smsHref with empty body is a bare sms: link', () => {
  assert.equal(smsHref('7204917819', ''), 'sms:+17204917819');
});

test('smsHref/telHref return null on a bad phone — never a broken link', () => {
  assert.equal(smsHref('5555555555', 'hello'), null);
  assert.equal(smsHref('', 'hello'), null);
  assert.equal(telHref('junk'), null);
  assert.equal(telHref('7204917819'), 'tel:+17204917819');
});

// ── buyerIntroSmsBody ───────────────────────────────────────────────────────
test('intro sms body carries rancher first, cut, buyer signature', () => {
  assert.equal(
    buyerIntroSmsBody('Randy', 'Amie', 'Half'),
    "hi Randy, just matched with you on buyhalfcow — i'm looking for a half. — Amie",
  );
});

test('intro sms body degrades gracefully without cut or names', () => {
  assert.equal(
    buyerIntroSmsBody('', 'Amie', ''),
    "hi there, just matched with you on buyhalfcow — i'm looking for a beef share. — Amie",
  );
  assert.equal(
    buyerIntroSmsBody('Randy', '', 'Not Sure'),
    "hi Randy, just matched with you on buyhalfcow — i'm looking for a beef share.",
  );
});

test("intro sms body contract: callers pass RAW names, never HTML-escaped", () => {
  // The email surface builds its HTML with esc(); the SMS body must receive
  // the unescaped name or D'Arcy prefills as "hi D&#039;Arcy". smsHref is
  // the only encoder (percent-encoding), applied once, at link time.
  const body = buyerIntroSmsBody("D'Arcy", 'J&L Cattle Co');
  assert.equal(
    body,
    "hi D'Arcy, just matched with you on buyhalfcow — i'm looking for a beef share. — J&L Cattle Co",
  );
  assert.ok(!body.includes('&#039;'));
  const href = smsHref('7204917819', body);
  assert.ok(href!.includes(encodeURIComponent("D'Arcy")));
  assert.ok(!href!.includes('&#039;'));
});

// ── areaCodeState / phoneLooksOutOfState ────────────────────────────────────
test('area code maps to state for known codes', () => {
  assert.equal(areaCodeState('7204917819'), 'CO');
  assert.equal(areaCodeState('(406) 240-1234'), 'MT');
  assert.equal(areaCodeState('2142401234'), 'TX');
});

test('unknown area code or bad phone → null (never guess)', () => {
  // 907 (AK) deliberately absent from the honest table.
  assert.equal(areaCodeState('9072401234'), null);
  assert.equal(areaCodeState('junk'), null);
});

test('every table entry is a 3-digit code mapping to a 2-letter state', () => {
  for (const [code, state] of Object.entries(AREA_CODE_STATE)) {
    assert.match(code, /^[2-9]\d\d$/, `bad code key: ${code}`);
    assert.match(state, /^[A-Z]{2}$/, `bad state for ${code}: ${state}`);
  }
});

test('phoneLooksOutOfState fires only on a positive, known mismatch', () => {
  assert.equal(phoneLooksOutOfState('7204917819', 'TX'), true); // CO code, TX buyer
  assert.equal(phoneLooksOutOfState('7204917819', 'CO'), false); // matches
  assert.equal(phoneLooksOutOfState('7204917819', 'Colorado'), false); // normalized match
  assert.equal(phoneLooksOutOfState('9072401234', 'TX'), false); // unknown code
  assert.equal(phoneLooksOutOfState('junk', 'TX'), false); // unparseable
  assert.equal(phoneLooksOutOfState('7204917819', ''), false); // unknown buyer state
  assert.equal(phoneLooksOutOfState('7204917819', 'Bogusland'), false);
});
