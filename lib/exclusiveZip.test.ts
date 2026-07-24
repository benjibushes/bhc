// lib/exclusiveZip.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseServiceZipPrefixes,
  hasServiceZipGate,
  buyerZipServedBy,
} from './exclusiveZip';

// ── parseServiceZipPrefixes ─────────────────────────────────────────────────

test('parseServiceZipPrefixes: empty / null / undefined → []', () => {
  assert.deepEqual(parseServiceZipPrefixes(''), []);
  assert.deepEqual(parseServiceZipPrefixes(null), []);
  assert.deepEqual(parseServiceZipPrefixes(undefined), []);
  assert.deepEqual(parseServiceZipPrefixes('   '), []);
});

test('parseServiceZipPrefixes: single prefix', () => {
  assert.deepEqual(parseServiceZipPrefixes('77'), ['77']);
});

test('parseServiceZipPrefixes: comma list is split + trimmed', () => {
  assert.deepEqual(parseServiceZipPrefixes('77, 78 ,79'), ['77', '78', '79']);
});

test('parseServiceZipPrefixes: non-digit tokens are dropped (fail safe)', () => {
  assert.deepEqual(parseServiceZipPrefixes('77,abc,,78'), ['77', '78']);
  assert.deepEqual(parseServiceZipPrefixes('7a,b7'), []);
});

// ── hasServiceZipGate ───────────────────────────────────────────────────────

test('hasServiceZipGate: true only when at least one valid prefix is set', () => {
  assert.equal(hasServiceZipGate({ 'Service ZIP Prefixes': '77' }), true);
  assert.equal(hasServiceZipGate({ 'Service ZIP Prefixes': '77,78' }), true);
  assert.equal(hasServiceZipGate({ 'Service ZIP Prefixes': '' }), false);
  assert.equal(hasServiceZipGate({}), false);
  assert.equal(hasServiceZipGate(null), false);
  assert.equal(hasServiceZipGate({ 'Service ZIP Prefixes': 'abc' }), false);
});

// ── buyerZipServedBy — the four mandated cases ──────────────────────────────

test('buyerZipServedBy: in-prefix buyer routes (true)', () => {
  assert.equal(buyerZipServedBy('77002', { 'Service ZIP Prefixes': '77' }), true);
});

test('buyerZipServedBy: out-of-prefix buyer excluded (false)', () => {
  assert.equal(buyerZipServedBy('78701', { 'Service ZIP Prefixes': '77' }), false);
});

test('buyerZipServedBy: gated rancher + NO buyer ZIP → excluded, FAIL CLOSED', () => {
  assert.equal(buyerZipServedBy('', { 'Service ZIP Prefixes': '77' }), false);
  assert.equal(buyerZipServedBy(null, { 'Service ZIP Prefixes': '77' }), false);
  assert.equal(buyerZipServedBy(undefined, { 'Service ZIP Prefixes': '77' }), false);
  // A malformed ZIP is not a ZIP — same fail-closed verdict.
  assert.equal(buyerZipServedBy('ABCDE', { 'Service ZIP Prefixes': '77' }), false);
});

test('buyerZipServedBy: empty prefixes → no restriction, falls through (true)', () => {
  assert.equal(buyerZipServedBy('78701', { 'Service ZIP Prefixes': '' }), true);
  assert.equal(buyerZipServedBy('78701', {}), true);
  // Even a no-ZIP buyer is fine when the rancher has NO gate.
  assert.equal(buyerZipServedBy(null, { 'Service ZIP Prefixes': '' }), true);
  assert.equal(buyerZipServedBy(null, {}), true);
});

// ── buyerZipServedBy — robustness ───────────────────────────────────────────

test('buyerZipServedBy: multi-prefix — Austin ZIP served when 78 added', () => {
  assert.equal(buyerZipServedBy('78701', { 'Service ZIP Prefixes': '77,78' }), true);
  assert.equal(buyerZipServedBy('75001', { 'Service ZIP Prefixes': '77,78' }), false);
});

test('buyerZipServedBy: ZIP+4 and surrounding whitespace normalize before matching', () => {
  assert.equal(buyerZipServedBy('77002-1234', { 'Service ZIP Prefixes': '77' }), true);
  assert.equal(buyerZipServedBy(' 77002 ', { 'Service ZIP Prefixes': '77' }), true);
});

test('buyerZipServedBy: numeric ZIP is coerced (leading-zero safe)', () => {
  assert.equal(buyerZipServedBy(77002, { 'Service ZIP Prefixes': '77' }), true);
  // New England: numeric 1001 must pad to "01001" and match "01".
  assert.equal(buyerZipServedBy(1001, { 'Service ZIP Prefixes': '01' }), true);
});

test('buyerZipServedBy: prefix is a true startsWith, not a loose contains', () => {
  assert.equal(buyerZipServedBy('77002', { 'Service ZIP Prefixes': '770' }), true);
  assert.equal(buyerZipServedBy('77100', { 'Service ZIP Prefixes': '770' }), false);
  // "77" must not match a ZIP that merely contains 77 later.
  assert.equal(buyerZipServedBy('60077', { 'Service ZIP Prefixes': '77' }), false);
});
