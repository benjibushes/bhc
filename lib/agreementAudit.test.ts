import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGREEMENT_VERSION, signatureAuditFields } from './agreementAudit';

// Minimal Headers-shaped fake (same .get(name) contract as Request.headers).
function fakeHeaders(map: Record<string, string>): { get(name: string): string | null } {
  const lower = Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => (name.toLowerCase() in lower ? lower[name.toLowerCase()] : null) };
}

test('AGREEMENT_VERSION is the pre-rewrite legacy tag', () => {
  assert.equal(AGREEMENT_VERSION, '2026-04-legacy');
});

test('signatureAuditFields: first hop of x-forwarded-for wins', () => {
  const fields = signatureAuditFields(
    fakeHeaders({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1, 172.16.0.9', 'user-agent': 'TestUA/1.0' }),
  );
  assert.equal(fields['Signature IP'], '203.0.113.7');
  assert.equal(fields['Signature User Agent'], 'TestUA/1.0');
  assert.equal(fields['Agreement Version'], AGREEMENT_VERSION);
});

test('signatureAuditFields: trims whitespace around the first hop', () => {
  const fields = signatureAuditFields(fakeHeaders({ 'x-forwarded-for': '  203.0.113.7 , 10.0.0.1' }));
  assert.equal(fields['Signature IP'], '203.0.113.7');
});

test('signatureAuditFields: falls back to x-real-ip when x-forwarded-for is absent', () => {
  const fields = signatureAuditFields(fakeHeaders({ 'x-real-ip': '198.51.100.4' }));
  assert.equal(fields['Signature IP'], '198.51.100.4');
});

test('signatureAuditFields: missing headers are OMITTED, never thrown', () => {
  const fields = signatureAuditFields(fakeHeaders({}));
  assert.ok(!('Signature IP' in fields));
  assert.ok(!('Signature User Agent' in fields));
  // Version is repo truth, not request-derived — always present.
  assert.equal(fields['Agreement Version'], AGREEMENT_VERSION);
});

test('signatureAuditFields: user agent truncated to 500 chars', () => {
  const longUA = 'x'.repeat(1200);
  const fields = signatureAuditFields(fakeHeaders({ 'user-agent': longUA }));
  assert.equal(fields['Signature User Agent']?.length, 500);
});

test('signatureAuditFields: null/undefined headers object still returns the version', () => {
  assert.equal(signatureAuditFields(null)['Agreement Version'], AGREEMENT_VERSION);
  assert.equal(signatureAuditFields(undefined)['Agreement Version'], AGREEMENT_VERSION);
});

test('signatureAuditFields: a throwing headers.get never blocks signing', () => {
  const hostile = { get(_name: string): string | null { throw new Error('boom'); } };
  const fields = signatureAuditFields(hostile);
  assert.equal(fields['Agreement Version'], AGREEMENT_VERSION);
  assert.ok(!('Signature IP' in fields));
});
