import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSignupAttemptFields, outcomeFromReport } from './signupAttempts';

test('buildSignupAttemptFields builds the "<email> · <ranch> · <outcome>" summary', () => {
  const f = buildSignupAttemptFields({
    email: 'justin@bar7.com',
    ranchName: 'Bar 7 Ranch',
    door: 'apply',
    outcome: 'server-error',
  });
  assert.equal(f.Summary, 'justin@bar7.com · Bar 7 Ranch · server-error');
  assert.equal(f.Email, 'justin@bar7.com');
  assert.equal(f['Ranch Name'], 'Bar 7 Ranch');
  assert.equal(f.Door, 'apply');
  assert.equal(f.Outcome, 'server-error');
});

test('buildSignupAttemptFields maps every field and trims whitespace', () => {
  const f = buildSignupAttemptFields({
    email: '  a@b.com ',
    ranchName: ' Ranch ',
    state: ' TX ',
    phone: ' (555) 555-5555 ',
    ip: ' 1.2.3.4 ',
    door: 'self-submit',
    outcome: 'rate-limited',
    reason: ' too many ',
  });
  assert.equal(f.Email, 'a@b.com');
  assert.equal(f['Ranch Name'], 'Ranch');
  assert.equal(f.State, 'TX');
  assert.equal(f.Phone, '(555) 555-5555');
  assert.equal(f.IP, '1.2.3.4');
  assert.equal(f.Door, 'self-submit');
  assert.equal(f.Reason, 'too many');
});

test('buildSignupAttemptFields tolerates missing optional fields', () => {
  const f = buildSignupAttemptFields({ door: 'apply', outcome: 'timeout' });
  assert.equal(f.Summary, ' ·  · timeout');
  assert.equal(f.Email, '');
  assert.equal(f['Ranch Name'], '');
  assert.equal(f.State, '');
  assert.equal(f.Reason, '');
});

test('outcomeFromReport: reason markers win over status', () => {
  assert.equal(outcomeFromReport(500, 'client timeout after 25s'), 'timeout');
  assert.equal(outcomeFromReport(500, 'Failed to fetch'), 'network-error');
  assert.equal(outcomeFromReport(0, 'network abort'), 'network-error');
});

test('outcomeFromReport: status maps when no reason marker', () => {
  assert.equal(outcomeFromReport(429, 'Too many requests'), 'rate-limited');
  assert.equal(outcomeFromReport(400, 'Name, ranch, email required'), 'rejected-validation');
  assert.equal(outcomeFromReport(422, ''), 'rejected-validation');
  assert.equal(outcomeFromReport(500, 'Submit failed (500)'), 'server-error');
  assert.equal(outcomeFromReport(503, ''), 'server-error');
});

test('outcomeFromReport: no usable status or marker defaults to network-error', () => {
  assert.equal(outcomeFromReport(0, ''), 'network-error');
  assert.equal(outcomeFromReport(undefined, undefined), 'network-error');
});
