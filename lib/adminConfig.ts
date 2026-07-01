// lib/adminConfig.ts
//
// Operator-tunable knobs for the BuyHalfCow admin pipeline.
//
// Storage: Airtable "Admin Config" table — key/value rows.
//   Columns: Key (single-line text), Value (single-line text).
//   Table and individual keys may be absent at any time. This module
//   NEVER throws when the table or a key is missing — it falls back to
//   the baked-in defaults so the platform stays operational even before
//   the Airtable schema is provisioned.
//
// Usage (server-side only):
//   const cfg = await getAdminConfig();
//   const threshold = cfg.stallThresholdDays; // always a number
//
// The POST path saves a partial update (only supplied keys):
//   await saveAdminConfig({ stallThresholdDays: 7 });
//
// Types and defaults live in lib/adminConfigTypes.ts (client-safe).

import Airtable from 'airtable';
export type { AdminConfig } from './adminConfigTypes';
export { ADMIN_CONFIG_DEFAULTS } from './adminConfigTypes';
import type { AdminConfig } from './adminConfigTypes';
import { ADMIN_CONFIG_DEFAULTS } from './adminConfigTypes';

// ── Airtable key → AdminConfig field mapping ──────────────────────────────
const KEY_MAP: Record<string, keyof AdminConfig> = {
  'stall_threshold_days': 'stallThresholdDays',
  'high_intent_cutoff': 'highIntentCutoff',
  'migration_deadline_days': 'migrationDeadlineDays',
  'capacity_warning_pct': 'capacityWarningPct',
  'funnel_offer_operator_call': 'funnelOfferOperatorCall',
};

// Fields parsed as booleans (Airtable Value of "true"/"false"). Everything else
// is parsed as a number.
const BOOLEAN_FIELDS: Set<keyof AdminConfig> = new Set(['funnelOfferOperatorCall']);

// Inverse map for saving
const FIELD_TO_KEY: Record<keyof AdminConfig, string> = Object.fromEntries(
  Object.entries(KEY_MAP).map(([k, v]) => [v, k])
) as Record<keyof AdminConfig, string>;

const ADMIN_CONFIG_TABLE = 'Admin Config';

// ── Airtable access ───────────────────────────────────────────────────────
function getBase() {
  const apiKey = process.env.AIRTABLE_API_KEY;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!apiKey || !baseId) return null;
  const at = new Airtable({ apiKey });
  return at.base(baseId);
}

// ── Read ──────────────────────────────────────────────────────────────────
/**
 * Fetch the current operator config.
 * Falls back to ADMIN_CONFIG_DEFAULTS for any missing key or if the table
 * does not exist. Never throws.
 */
let _cfgCache: { value: AdminConfig; at: number } | null = null;
const CFG_TTL_MS = 60_000;

export async function getAdminConfig(): Promise<AdminConfig> {
  // Module TTL cache — /access (the paid-ad front door) calls this on EVERY
  // render. The Airtable read can error (permission) and fall back to defaults,
  // so without a cache every ad hit pays a failing round-trip on the critical
  // render path (a root cause of "things hardly load"). Cache the resolved
  // value (even the default) for 60s so at most one read/min happens. Config
  // toggles rarely; 60s staleness is acceptable.
  if (_cfgCache && Date.now() - _cfgCache.at < CFG_TTL_MS) return _cfgCache.value;
  const value = await _loadAdminConfig();
  _cfgCache = { value, at: Date.now() };
  return value;
}

async function _loadAdminConfig(): Promise<AdminConfig> {
  const base = getBase();
  if (!base) return { ...ADMIN_CONFIG_DEFAULTS };

  try {
    const records = await base(ADMIN_CONFIG_TABLE).select({ maxRecords: 50 }).all();

    const overrides: Partial<AdminConfig> = {};
    for (const rec of records) {
      const key = String(rec.fields['Key'] || '').trim();
      const raw = String(rec.fields['Value'] ?? '').trim();
      const field = KEY_MAP[key];
      if (!field) continue;
      if (BOOLEAN_FIELDS.has(field)) {
        const lower = raw.toLowerCase();
        if (lower === 'true' || lower === 'false') (overrides as any)[field] = lower === 'true';
        continue;
      }
      const num = Number(raw);
      if (!isNaN(num)) {
        (overrides as any)[field] = num;
      }
    }

    return { ...ADMIN_CONFIG_DEFAULTS, ...overrides };
  } catch (err: any) {
    // Table missing, permission denied, network error — degrade gracefully
    const msg = String(err?.message || err || '');
    const isMissing =
      msg.includes('Could not find table') ||
      msg.includes('TABLE_NOT_FOUND') ||
      msg.includes('NOT_FOUND') ||
      msg.includes('404');
    if (!isMissing) {
      console.warn('[adminConfig] getAdminConfig error (using defaults):', msg);
    }
    return { ...ADMIN_CONFIG_DEFAULTS };
  }
}

// ── Write ─────────────────────────────────────────────────────────────────
/**
 * Persist a partial config update to Airtable.
 * For each supplied key:
 *   - If a row with Key=<airtable_key> exists → update its Value.
 *   - Otherwise → create a new row.
 * Falls back silently if the table is missing.
 * Returns the resulting full config.
 */
export async function saveAdminConfig(
  updates: Partial<AdminConfig>,
): Promise<AdminConfig> {
  const base = getBase();
  if (!base) return getAdminConfig();

  try {
    // Fetch existing rows so we know which keys already have a record id
    const records = await base(ADMIN_CONFIG_TABLE).select({ maxRecords: 50 }).all();
    const existingByKey: Record<string, string> = {};
    for (const rec of records) {
      const k = String(rec.fields['Key'] || '').trim();
      if (k) existingByKey[k] = rec.id;
    }

    const toUpdate: { id: string; fields: { Value: string } }[] = [];
    const toCreate: { fields: { Key: string; Value: string } }[] = [];

    for (const [field, value] of Object.entries(updates) as [keyof AdminConfig, number][]) {
      const airtableKey = FIELD_TO_KEY[field];
      if (!airtableKey) continue;
      const strValue = String(value);
      if (existingByKey[airtableKey]) {
        toUpdate.push({ id: existingByKey[airtableKey], fields: { Value: strValue } });
      } else {
        toCreate.push({ fields: { Key: airtableKey, Value: strValue } });
      }
    }

    // Airtable allows up to 10 records per batch
    const batch = <T>(arr: T[], size: number): T[][] =>
      Array.from({ length: Math.ceil(arr.length / size) }, (_, i) =>
        arr.slice(i * size, i * size + size),
      );

    await Promise.all([
      ...batch(toUpdate, 10).map((chunk) => base(ADMIN_CONFIG_TABLE).update(chunk)),
      ...batch(toCreate, 10).map((chunk) => base(ADMIN_CONFIG_TABLE).create(chunk)),
    ]);
  } catch (err: any) {
    const msg = String(err?.message || err || '');
    console.warn('[adminConfig] saveAdminConfig error:', msg);
    // Return defaults-merged result even if save failed
  }

  return getAdminConfig();
}
