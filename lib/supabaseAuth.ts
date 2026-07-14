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

// Accept BOTH the bare names and Supabase's canonical Next.js NEXT_PUBLIC_*
// names for the URL + anon key — whichever convention was set in Vercel works
// (these two are public-by-design, so the NEXT_PUBLIC_ prefix is safe). The
// service-role key is a SECRET — bare name only, never NEXT_PUBLIC_.
const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  '';
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

/**
 * Locate a Supabase Auth user id by email. The admin SDK exposes only
 * listUsers (paginated), so we page until we find a case-insensitive email
 * match or run out of pages. Bounded to 20 pages (20k users) as a safety cap.
 *
 * Shared by set-password (upsert-by-email) and the landing-page email-change
 * sync (dashboard-audit rank 9: an email change must move the Supabase Auth
 * user with it or password login silently breaks).
 */
export async function findSupabaseUserIdByEmail(
  admin: SupabaseClient,
  email: string,
): Promise<string | null> {
  const target = email.trim().toLowerCase();
  const perPage = 1000;
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error || !data) return null;
    const match = data.users.find(
      (u) => String(u.email || '').trim().toLowerCase() === target,
    );
    if (match) return match.id;
    if (data.users.length < perPage) break; // last page
  }
  return null;
}
