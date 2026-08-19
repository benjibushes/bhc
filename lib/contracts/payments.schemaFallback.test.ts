// lib/contracts/payments.schemaFallback.test.ts
//
// Data-layer audit P3 (2026-08-18) — the unreachable schema-fallback retries
// must stay gone.
//
// Run: JWT_SECRET=test-secret-ci npx tsx --test lib/contracts/payments.schemaFallback.test.ts
// (or the full suite: npm test)
//
// Eleven money-path writes were wrapped in a try/catch that re-issued the
// write with the newest fields stripped, "in case the schema hasn't caught
// up". Every one was DEAD: lib/airtable's updateRecord/createRecord catch
// `Unknown field name` themselves, delete the key, raise a deduped operator
// signal and retry — they succeed rather than throw, so the fallback never
// ran. And because the catches were untyped they swallowed real failures
// (rate-limit exhaustion, revoked scope) into a second doomed write whose
// error replaced the original.
//
// The pin is deliberately about the SHAPE of the dead pattern — a catch whose
// body issues another write to the same table — not about try/catch in
// general. Plenty of genuinely reachable catches remain in these files
// (best-effort emails, Telegram, Redis, operator signals) and must not be
// touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FILES = [
  '../../lib/contracts/payments.ts',
  '../../lib/refundLifecycle.ts',
  '../../app/api/webhooks/stripe/route.ts',
  '../../app/api/webhooks/stripe-connect/route.ts',
];

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/**
 * Source with comments removed. The notes explaining WHY the fallbacks are
 * gone necessarily quote the dead vocabulary; only executable code counts.
 */
const codeOf = (rel: string) =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

test('no money-path write is followed by a schema-fallback retry', () => {
  // The tell: a catch block that issues another updateRecord/createRecord.
  const RETRY_IN_CATCH = /catch\s*\([^)]*\)\s*\{(?:[^{}]|\{[^{}]*\})*?\b(?:updateRecord|createRecord)\s*\(/;
  for (const rel of FILES) {
    const m = RETRY_IN_CATCH.exec(codeOf(rel));
    assert.equal(
      m,
      null,
      `${rel} re-writes inside a catch — lib/airtable already strips-and-succeeds, so that path is dead ` +
        `and it hides the real error:\n${m?.[0]?.slice(0, 200)}`,
    );
  }
});

test('the "schema fallback" vocabulary is gone from the money paths', () => {
  for (const rel of FILES) {
    const code = codeOf(rel);
    assert.ok(!/schema fallback/i.test(code), `${rel} still logs a schema fallback`);
    assert.ok(
      !/retrying (with|without) /i.test(code),
      `${rel} still logs a retry-with-fewer-fields that cannot happen`,
    );
  }
});

test('the strip alarm these catches masked is still the loud signal', () => {
  // If lib/airtable ever stops strip-and-succeeding, the reasoning above is
  // void and the catches would become reachable again. Pin the behaviour.
  const airtable = read('../../lib/airtable.ts');
  assert.match(airtable, /Unknown field name: "\(\[\^"\]\+\)"/);
  assert.match(airtable, /delete currentFields\[unknownField\[1\]\];\s*\n\s*continue;/);
  assert.match(airtable, /summary: `Airtable strip \$\{tableName\}\.\$\{unknownField\[1\]\} \(update\)`/);
});

test('no write nulls a field that exists on no table', () => {
  assert.ok(
    !/'Commission Status'/.test(codeOf('../../lib/refundLifecycle.ts')),
    'Commission Status is a phantom key — every refund fired a strip alarm for it',
  );
});
