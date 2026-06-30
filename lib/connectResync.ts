// lib/connectResync.ts
//
// Pure decision logic for re-syncing a rancher's cached Stripe Connect status
// from a LIVE Stripe read. Split into its own ZERO-import module (no Stripe
// client, no Airtable, no secrets chain) so it can be unit-tested under the
// repo's standard `npm test` harness (lib/**/*.test.ts).
//
// Background: the only writer of `Stripe Connect Status = 'active'` in normal
// flow is the account.updated webhook. If that event fired before the Connect
// account was merged onto its canonical Ranchers row, or simply never reached
// us, the row stays stuck at 'onboarding'/'not_connected' even though Stripe
// has charges_enabled. The dashboard reads that stale cache, so the rancher
// sees a "connect your bank" banner forever with no self-serve way out.
//
// Both the admin resync endpoint and the new rancher-side resync compute the
// SAME write fields + side effects from a live read. This module factors out
// that decision so the two callers stay in lockstep and the money/migration
// invariants are testable in isolation.

import type { ConnectAccountStatus } from './connectStatusClassify';

export interface ConnectResyncInput {
  /** Live `status` from getConnectAccountStatus(). */
  liveStatus: ConnectAccountStatus;
  /** Current cached value of the Airtable `Stripe Connect Status` field. */
  previousStatus: string;
  /** Truthy when `Stripe Connect Connected At` is already stamped. */
  alreadyConnectedAt: boolean;
  /** Airtable `Pricing Model` (case-insensitive). */
  pricingModel: string;
  /** Airtable `Migration Status` (case-insensitive). */
  migrationStatus: string;
  /** ISO timestamp to stamp on first active-flip. Injected for testability. */
  nowISO: string;
}

export interface ConnectResyncDecision {
  /** True when the live status differs from the cache → an Airtable write is needed. */
  changed: boolean;
  /** True when the live status is 'active' (deposits flow). */
  isNowActive: boolean;
  /** Fields to write to the Ranchers row. Empty object when !changed. */
  writeFields: Record<string, any>;
  /** True when this resync advances the tier_v2 migration tracker to completed. */
  migrationCompleted: boolean;
}

// Migration states that are not yet "done" — an active Connect flip advances
// these to 'completed'. Mirrors app/api/admin/ranchers/[id]/resync-connect.
const INCOMPLETE_MIGRATION = new Set([
  '',
  'not_invited',
  'invited',
  'call_scheduled',
  'upgrading',
]);

/**
 * Compute the Airtable write-back for a Connect status resync. Read-derived:
 * mirrors exactly what the account.updated webhook would have written. No money
 * mutation — flips a status field and (on active-flip) advances the migration
 * tracker. Idempotent: when liveStatus already matches the cache, changed=false
 * and writeFields is empty so the caller can skip the write.
 */
export function computeConnectResync(input: ConnectResyncInput): ConnectResyncDecision {
  const isNowActive = input.liveStatus === 'active';

  if (input.previousStatus === input.liveStatus) {
    return { changed: false, isNowActive, writeFields: {}, migrationCompleted: false };
  }

  const writeFields: Record<string, any> = { 'Stripe Connect Status': input.liveStatus };
  if (isNowActive && !input.alreadyConnectedAt) {
    writeFields['Stripe Connect Connected At'] = input.nowISO;
  }

  const pricingModel = String(input.pricingModel || '').toLowerCase();
  const migStatus = String(input.migrationStatus || '').toLowerCase();
  const migrationCompleted =
    isNowActive && pricingModel === 'tier_v2' && INCOMPLETE_MIGRATION.has(migStatus);
  if (migrationCompleted) {
    writeFields['Migration Status'] = 'completed';
  }

  return { changed: true, isNowActive, writeFields, migrationCompleted };
}
