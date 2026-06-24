// Thin server-side Supabase client — used ONLY as the credential store for
// rancher password login (alongside the existing magic-link path). Supabase
// Auth hashes/salts the passwords; we never see or store plaintext.
//
// BUILD-DARK-SAFE: every getter returns null when its env var is unset, so
// `npm run build` and any deploy without Supabase env keeps working — the
// magic-link login is entirely unaffected. The password routes check these
// and 503 when null.
//
// NEVER import this in client components — it reads the service-role key.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// Memoize so we don't spin up a fresh client per request. Module-level cache
// is safe — these clients are stateless (no session persistence).
let _admin: SupabaseClient | null = null;
let _anon: SupabaseClient | null = null;

/**
 * Service-role client — can create/update Supabase Auth users (set-password).
 * Returns null when SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is unset
 * (build-dark). autoRefreshToken/persistSession off: this is a server-side,
 * request-scoped admin client, not a logged-in user session.
 */
export function getSupabaseAdmin(): SupabaseClient | null {
  if (_admin) return _admin;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  _admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return _admin;
}

/**
 * Anon client — used to verify a password via signInWithPassword (password
 * login). Returns null when SUPABASE_URL or SUPABASE_ANON_KEY is unset
 * (build-dark). persistSession off: we mint our OWN bhc-rancher-auth cookie
 * from the Airtable record after a successful credential check; we don't keep
 * the Supabase session around.
 */
export function getSupabaseAnon(): SupabaseClient | null {
  if (_anon) return _anon;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  _anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return _anon;
}

/**
 * True only when BOTH the admin (service-role) and anon credentials are
 * present — i.e. password set AND password login can both function. When
 * false, the password routes 503 and the magic-link path carries on alone.
 */
export function isSupabaseAuthConfigured(): boolean {
  return Boolean(
    SUPABASE_URL && SUPABASE_ANON_KEY && SUPABASE_SERVICE_ROLE_KEY,
  );
}
