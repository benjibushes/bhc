import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidEmail,
  phoneDigits,
  normalizePhone,
  validateAccountPatch,
  isAccountEditableKey,
  ACCOUNT_FIELDS,
} from './accountProfile';

test('isValidEmail accepts normal addresses', () => {
  assert.equal(isValidEmail('jane@ranch.com'), true);
  assert.equal(isValidEmail('a.b+tag@sub.example.co'), true);
});

test('isValidEmail rejects malformed', () => {
  assert.equal(isValidEmail(''), false);
  assert.equal(isValidEmail('no-at-sign'), false);
  assert.equal(isValidEmail('two@@at.com'), false);
  assert.equal(isValidEmail('jane@nodot'), false);
  assert.equal(isValidEmail('has space@x.com'), false);
  assert.equal(isValidEmail('@nodomain.com'), false);
  assert.equal(isValidEmail('trailing@dot.'), false);
});

test('phoneDigits strips non-digits', () => {
  assert.equal(phoneDigits('(406) 555-1234'), '4065551234');
});

test('normalizePhone formats 10 digits', () => {
  const r = normalizePhone('4065551234');
  assert.equal(r.ok, true);
  assert.equal(r.value, '(406) 555-1234');
});

test('normalizePhone strips leading 1 on 11 digits', () => {
  const r = normalizePhone('14065551234');
  assert.equal(r.ok, true);
  assert.equal(r.value, '(406) 555-1234');
});

test('normalizePhone allows empty (clear)', () => {
  const r = normalizePhone('');
  assert.equal(r.ok, true);
  assert.equal(r.value, '');
});

test('normalizePhone rejects wrong length', () => {
  assert.equal(normalizePhone('12345').ok, false);
  assert.equal(normalizePhone('1234567890123').ok, false);
});

test('isAccountEditableKey', () => {
  assert.equal(isAccountEditableKey('Email'), true);
  assert.equal(isAccountEditableKey('Slug'), false);
});

test('validateAccountPatch happy path maps all fields', () => {
  const res = validateAccountPatch({
    'Operator Name': '  Jane Renick ',
    'Ranch Name': 'Renick Ranch',
    'Email': 'Jane@Ranch.com',
    'Phone': '406-555-1234',
  });
  assert.equal(res.ok, true);
  assert.equal(res.fields[ACCOUNT_FIELDS.operatorName], 'Jane Renick');
  assert.equal(res.fields[ACCOUNT_FIELDS.ranchName], 'Renick Ranch');
  assert.equal(res.fields[ACCOUNT_FIELDS.email], 'jane@ranch.com'); // lowercased
  assert.equal(res.fields[ACCOUNT_FIELDS.phone], '(406) 555-1234');
});

test('validateAccountPatch only writes present keys', () => {
  const res = validateAccountPatch({ 'Email': 'x@y.com' });
  assert.equal(res.ok, true);
  assert.deepEqual(Object.keys(res.fields), [ACCOUNT_FIELDS.email]);
});

test('validateAccountPatch rejects empty operator name', () => {
  const res = validateAccountPatch({ 'Operator Name': '   ' });
  assert.equal(res.ok, false);
});

test('validateAccountPatch rejects empty ranch name', () => {
  const res = validateAccountPatch({ 'Ranch Name': '' });
  assert.equal(res.ok, false);
});

test('validateAccountPatch rejects empty + invalid email', () => {
  assert.equal(validateAccountPatch({ 'Email': '' }).ok, false);
  assert.equal(validateAccountPatch({ 'Email': 'nope' }).ok, false);
});

test('validateAccountPatch rejects bad phone', () => {
  const res = validateAccountPatch({ 'Phone': '123' });
  assert.equal(res.ok, false);
});

test('validateAccountPatch allows clearing phone', () => {
  const res = validateAccountPatch({ 'Phone': '' });
  assert.equal(res.ok, true);
  assert.equal(res.fields[ACCOUNT_FIELDS.phone], null);
});
