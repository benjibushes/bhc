import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  needsRevalidation,
  sessionRevalidationVerdict,
  SESSION_REVALIDATE_INTERVAL_MS,
} from './rancherSessionRevalidate';

const NOW = Date.parse('2026-07-14T12:00:00.000Z');

// ── needsRevalidation ───────────────────────────────────────────────────────

test('fresh revalidatedAt claim skips the re-check', () => {
  assert.equal(needsRevalidation({ revalidatedAt: NOW - 1000 }, NOW), false);
});

test('stale revalidatedAt claim (>24h) triggers the re-check', () => {
  assert.equal(
    needsRevalidation({ revalidatedAt: NOW - SESSION_REVALIDATE_INTERVAL_MS - 1 }, NOW),
    true,
  );
});

test('pre-fix cookie (no claim) falls back to iat seconds', () => {
  const freshIat = Math.floor((NOW - 60_000) / 1000);
  const staleIat = Math.floor((NOW - SESSION_REVALIDATE_INTERVAL_MS - 60_000) / 1000);
  assert.equal(needsRevalidation({ iat: freshIat }, NOW), false);
  assert.equal(needsRevalidation({ iat: staleIat }, NOW), true);
});

test('claim-less, iat-less token fails toward checking', () => {
  assert.equal(needsRevalidation({}, NOW), true);
  assert.equal(needsRevalidation({ revalidatedAt: 'garbage', iat: null }, NOW), true);
});

// ── sessionRevalidationVerdict ──────────────────────────────────────────────

function rancher(over: Record<string, unknown> = {}) {
  return {
    'Email': 'owner@ranch.com',
    'Team Emails': 'spouse@ranch.com, hand@ranch.com',
    'Active Status': 'Active',
    'Verification Status': 'Verified',
    ...over,
  };
}

test('owner email still on the row passes', () => {
  assert.deepEqual(
    sessionRevalidationVerdict(rancher(), { email: 'Owner@Ranch.com' }),
    { ok: true },
  );
});

test('team email still on the row passes (any separator)', () => {
  assert.deepEqual(
    sessionRevalidationVerdict(rancher({ 'Team Emails': 'a@x.com;hand@ranch.com\nb@y.com' }), {
      email: 'hand@ranch.com',
    }),
    { ok: true },
  );
});

test('removed team email is revoked', () => {
  const out = sessionRevalidationVerdict(rancher({ 'Team Emails': 'spouse@ranch.com' }), {
    email: 'hand@ranch.com',
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'email-removed');
});

test('closed account (Verification Status=Removed) is revoked — enum-object shape too', () => {
  assert.equal(
    sessionRevalidationVerdict(rancher({ 'Verification Status': 'Removed' }), { email: 'owner@ranch.com' }).reason,
    'account-closed',
  );
  assert.equal(
    sessionRevalidationVerdict(rancher({ 'Verification Status': { name: 'Removed' } }), { email: 'owner@ranch.com' }).reason,
    'account-closed',
  );
});

test('Non-Compliant is revoked', () => {
  assert.equal(
    sessionRevalidationVerdict(rancher({ 'Active Status': 'Non-Compliant' }), { email: 'owner@ranch.com' }).reason,
    'non-compliant',
  );
});

test('Paused stays valid — vacation mode is not a revocation', () => {
  assert.equal(
    sessionRevalidationVerdict(rancher({ 'Active Status': 'Paused' }), { email: 'owner@ranch.com' }).ok,
    true,
  );
});

test('admin impersonation skips the membership check but not the status gates', () => {
  assert.equal(
    sessionRevalidationVerdict(rancher(), { email: 'admin@bhc.com', impersonatedBy: 'ben' }).ok,
    true,
  );
  assert.equal(
    sessionRevalidationVerdict(rancher({ 'Verification Status': 'Removed' }), {
      email: 'admin@bhc.com',
      impersonatedBy: 'ben',
    }).reason,
    'account-closed',
  );
});

test('missing rancher row or missing session email is revoked', () => {
  assert.equal(sessionRevalidationVerdict(null, { email: 'x@y.com' }).reason, 'rancher-missing');
  assert.equal(sessionRevalidationVerdict(rancher(), { email: '' }).reason, 'session-email-missing');
});
