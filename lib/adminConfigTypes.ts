// lib/adminConfigTypes.ts
//
// Shared types and defaults for admin config.
// Safe to import on both client and server — no Airtable dependency.
// Server-side read/write lives in lib/adminConfig.ts.

export interface AdminConfig {
  /** Days before a referral with no rancher activity is flagged stalled. */
  stallThresholdDays: number;
  /** Intent score cutoff for "High Intent" classification (0-100). */
  highIntentCutoff: number;
  /** Days until the v2 migration deadline banner fires. */
  migrationDeadlineDays: number;
  /** Rancher capacity fill % that triggers a capacity warning. */
  capacityWarningPct: number;
}

export const ADMIN_CONFIG_DEFAULTS: AdminConfig = {
  stallThresholdDays: 5,
  highIntentCutoff: 70,
  migrationDeadlineDays: 14,
  capacityWarningPct: 80,
};
