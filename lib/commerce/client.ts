// lib/commerce/client.ts — server-only Supabase client for the commerce
// system-of-record (catalog, variants, inventory, orders, page blocks, domains).
//
// BHC uses its OWN JWT auth (rancher/buyer sessions), NOT Supabase Auth. All
// commerce access is server-side via the SERVICE-ROLE key (bypasses RLS), with
// tenant isolation enforced in the repository layer by always filtering on
// rancher_id. The schema enables RLS deny-all as a backstop (lib/../supabase/
// migrations/0001_commerce_foundation.sql).
//
// BUILD-DARK: when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are unset (no
// Supabase project provisioned yet), getCommerceDb() returns null instead of
// throwing — so importing this is safe at build time and in prod before
// provisioning. Callers MUST null-check and fall back to the Airtable path until
// the commerce DB is live. Matches BHC's build-dark → provision → flip pattern.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let _client: SupabaseClient | null = null;

/**
 * Returns the service-role Supabase client, or null if the commerce DB isn't
 * provisioned yet. Server-side only — never import into a client component
 * (the service-role key must never reach the browser).
 */
export function getCommerceDb(): SupabaseClient | null {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null; // not provisioned — build-dark
  _client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}

/** True once the commerce DB env is configured. Use to fork Airtable vs Supabase. */
export function isCommerceDbConfigured(): boolean {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/**
 * Like getCommerceDb() but throws a clear error when unconfigured. Use in code
 * paths that should only run AFTER provisioning (the migration runner, the ETL,
 * Phase-1 commerce routes) so a missing env fails loud instead of silently
 * no-op'ing.
 */
export function requireCommerceDb(): SupabaseClient {
  const db = getCommerceDb();
  if (!db) {
    throw new Error(
      'Commerce DB not configured — set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY. ' +
      'See docs/superpowers/specs/2026-06-20-rancher-commerce-platform.md.',
    );
  }
  return db;
}
