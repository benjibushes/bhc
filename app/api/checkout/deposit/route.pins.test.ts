import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Source pins for the deposit GET projection (grep-based — App Router route
// files can't be imported under tsx --test).
//
// WHAT THESE PROTECT (broker-rail truthfulness, 2026-08-17): the post-deposit
// success page is the success_url for BOTH deposit rails, and it can only stop
// telling a broker buyer Connect fictions if this endpoint tells it which rail
// it is on. The already-paid (referral_closed) branch is the one every success
// page load hits, and it already reads the rancher record — the rail costs no
// extra Airtable call.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(HERE, 'route.ts'), 'utf8');

// The POST handler carries its own `referral_closed` 409 — the GET one (the
// branch every success-page load hits) is the LAST occurrence in the file.
const paidBranch = () => {
  const start = src.lastIndexOf("error: 'referral_closed'");
  assert.ok(start > -1, 'the already-paid 409 must exist');
  return src.slice(src.lastIndexOf('let paidSlug', start), src.indexOf('const rancherLinks', start));
};

test('PIN: the already-paid 409 tells the client which rail the deposit was on', () => {
  assert.match(paidBranch(), /rail: paidRail/);
  assert.match(src, /depositRailForReferral\(referral, paidRancher\)/);
  // A failed rancher read must not downgrade a broker sale to Connect copy.
  assert.match(src, /depositRailForReferral\(referral, null\)/);
});

test('PIN: the already-paid 409 carries the ranch name, not just the slug', () => {
  const branch = paidBranch();
  assert.match(branch, /rancher: \{ slug: paidSlug, name: paidRancherName, ranchName: paidRanchName \}/);
});

test('PIN: the broker sheet-delivery verdict is surfaced, never the raw Notes', () => {
  const branch = paidBranch();
  assert.match(branch, /rancherNotified/);
  assert.match(src, /brokerSheetDelivery\(referral\)/);
  assert.doesNotMatch(
    branch,
    /Notes: /,
    'Notes is operator-internal free text and must never be shipped to a browser',
  );
});

test('PIN: the verdict is computed for the broker rail only', () => {
  assert.match(src, /paidRail === 'broker'\s*\?\s*brokerSheetDelivery\(referral\)/);
});

test('PIN: the unpaid broker 409 also names the rail (webhook-lag window)', () => {
  const brokerGate = src.slice(src.lastIndexOf("railForRancherGet === 'broker'"));
  assert.match(brokerGate, /rail: 'broker'/);
  assert.match(brokerGate, /redirectUrl: `\/checkout\/\$\{referralId\}\/broker`/);
});
