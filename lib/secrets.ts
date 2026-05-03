// Centralized, validated environment secrets.
//
// Every auth-critical secret (JWT_SECRET, ADMIN_PASSWORD, CRON_SECRET) was
// being read individually with `process.env.X || 'fallback-string'` across
// 30+ files. The fallbacks were development conveniences that became
// security holes:
//
//   1. If any env var got accidentally unset on deploy (mistyped name,
//      Vercel env var deleted, staging copy missing the var), every file
//      silently fell back to a hardcoded string. Anyone who knew that string
//      could forge JWTs / log into admin / trigger crons.
//
//   2. The `'changeme123'` admin fallback and `'bhc-member-secret-change-me'`
//      JWT fallback were grep-able from the public GitHub repo.
//
// Fix: import from this module instead. If a required secret is missing,
// the import itself throws — failing the whole route loudly with a clear
// error in logs. No silent fallbacks, no insecure defaults.
//
// Usage:
//   import { JWT_SECRET, ADMIN_PASSWORD, CRON_SECRET } from '@/lib/secrets';
//
// Tests / local dev: set the vars in .env.local. The fail-fast behavior
// makes missing config visible immediately, not after a security incident.

function requireEnv(name: string, opts?: { allowEmptyInDev?: boolean }): string {
  const value = process.env[name];
  if (value && value.length > 0) return value;
  // In production, ALWAYS throw. In dev, throw unless explicitly opted out.
  // (No env opts out of JWT_SECRET — even local dev needs deterministic auth.)
  if (process.env.NODE_ENV === 'production' || !opts?.allowEmptyInDev) {
    throw new Error(
      `Required env var ${name} is not set. ` +
      `Add it to .env.local for development or set it in Vercel for production. ` +
      `No insecure fallback is provided — see lib/secrets.ts.`
    );
  }
  return '';
}

// JWT signing key for member/rancher/affiliate sessions + warmup engage tokens
// + check-in tokens + activate/decline tokens. Without this, every signed link
// in every email becomes forgeable. Required in all environments.
export const JWT_SECRET = requireEnv('JWT_SECRET');

// Admin login password (operator UI gate). Required.
export const ADMIN_PASSWORD = requireEnv('ADMIN_PASSWORD');

// Cron auth — Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Required
// to prevent anyone who guesses cron URLs from triggering expensive jobs (mass
// emails, bulk DB writes).
export const CRON_SECRET = requireEnv('CRON_SECRET');

// Internal-API secret for service-to-service calls (e.g., /api/consumers
// calling /api/matching/suggest). Optional — if absent, internal callers
// fall back to admin password / member session for auth.
export const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || '';

// ─── Project 1 — Discover Map / AI scraper ──────────────────────────────────

// Tavily web search API key. Used by lib/aiSearch.ts as the primary search
// provider for the discover-ranchers scraper. If unset, the scraper falls
// back to Anthropic native web_search tool (slower, lower-quality results).
// Optional.
export const TAVILY_API_KEY = process.env.TAVILY_API_KEY || '';

// User-Agent header for Nominatim (OpenStreetMap) reverse-geocoding requests.
// REQUIRED by Nominatim ToS — anonymous requests get banned. Format must
// include a contact email, e.g. `BuyHalfCow/1.0 (ben@buyhalfcow.com)`.
// Required only at the moment the scraper actually calls Nominatim — the
// `/map` page itself never reads this. Optional at build time.
export const NOMINATIM_USER_AGENT =
  process.env.NOMINATIM_USER_AGENT || 'BuyHalfCow/1.0 (ben@buyhalfcow.com)';

// =============================================================================
// PROJECT 3 — FOUNDING HERD CAPITAL RAISE
// =============================================================================
//
// Five-tier paid backer campaign at /founders. Stripe Payment Links handle the
// 7 fixed-price tiers; Founding 100 uses a thin Checkout route so we can
// enforce the 100-spot cap and flip the price from $1,000 → $1,500 on Day 7
// without surgery in Stripe (env-driven, page-side flip).
//
// All Founding 100 / cap / Stripe Payment Link envs default to safe values so
// `npm run build` succeeds in CI without them being set. Production reads are
// fail-loud via requireEnv() where mandatory.

// Founding 100 pricing — flips from $1,000 to $1,500 on the early-bird end date
export const FOUNDING_100_PRICE_CENTS = parseInt(
  process.env.FOUNDING_100_PRICE_CENTS || '100000',
  10
);

// ISO datetime when early-bird $1,000 price flips to $1,500. Page reads this
// and swaps the price block; Founding 100 checkout uses the post-flip price
// when Date.now() >= this. Empty = no flip configured (early-bird forever).
export const FOUNDING_100_EARLY_BIRD_END = process.env.FOUNDING_100_EARLY_BIRD_END || '';

// Hard caps — checked pre-checkout for Founding 100 / Title Founder
export const FOUNDING_100_CAP = parseInt(process.env.FOUNDING_100_CAP || '100', 10);
export const TITLE_FOUNDER_CAP = parseInt(process.env.TITLE_FOUNDER_CAP || '10', 10);

// Stripe Payment Links (created manually in the Stripe dashboard with the
// metadata described in PROJECT-3-FOUNDERS-COMPLETE.md). Page renders these
// as buttons. Founding 100 is intentionally NOT a Payment Link — it goes
// through /api/founders/checkout for cap enforcement.
export const STRIPE_PAYMENT_LINK_HERD_MONTHLY = process.env.STRIPE_PAYMENT_LINK_HERD_MONTHLY || '';
export const STRIPE_PAYMENT_LINK_HERD_ANNUAL = process.env.STRIPE_PAYMENT_LINK_HERD_ANNUAL || '';
export const STRIPE_PAYMENT_LINK_OUTLAW_MONTHLY = process.env.STRIPE_PAYMENT_LINK_OUTLAW_MONTHLY || '';
export const STRIPE_PAYMENT_LINK_OUTLAW_ANNUAL = process.env.STRIPE_PAYMENT_LINK_OUTLAW_ANNUAL || '';
export const STRIPE_PAYMENT_LINK_STEWARD_MONTHLY = process.env.STRIPE_PAYMENT_LINK_STEWARD_MONTHLY || '';
export const STRIPE_PAYMENT_LINK_STEWARD_ANNUAL = process.env.STRIPE_PAYMENT_LINK_STEWARD_ANNUAL || '';
export const STRIPE_PAYMENT_LINK_TITLE_FOUNDER = process.env.STRIPE_PAYMENT_LINK_TITLE_FOUNDER || '';

// Verification mode — when true, /founders surfaces a hidden $1 tier for E2E
// testing on a real card. The Stripe webhook treats the resulting purchase as
// a normal `founder-lifetime` event but with a `tier: 'test-1'` metadata so
// the Wall + dashboards can filter it out cleanly.
export const FOUNDERS_TEST_MODE =
  (process.env.FOUNDERS_TEST_MODE || 'false').toLowerCase() === 'true';

// Helper: returns the live Founding 100 price in cents honoring the early-bird
// flip. Used by both the page (for display) and the checkout route.
export function getFounding100PriceCents(): number {
  if (!FOUNDING_100_EARLY_BIRD_END) return FOUNDING_100_PRICE_CENTS;
  const flipAt = new Date(FOUNDING_100_EARLY_BIRD_END).getTime();
  if (isNaN(flipAt)) return FOUNDING_100_PRICE_CENTS;
  return Date.now() < flipAt ? FOUNDING_100_PRICE_CENTS : 150000;
}

// Helper: convenient label, e.g. "$1,000" or "$1,500"
export function getFounding100PriceLabel(): string {
  const dollars = Math.round(getFounding100PriceCents() / 100);
  return `$${dollars.toLocaleString('en-US')}`;
}
