import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Server-side redirect to Stripe Payment Links for brand partner tiers.
//
// Why this endpoint instead of inlining URLs into the page?
// The Stripe Payment Link URLs already exist as Vercel env vars
// (STRIPE_BRAND_LINK_SPOTLIGHT / STRIPE_BRAND_LINK_FEATURED / STRIPE_BRAND_LINK_COMARKETED)
// from a prior session. Re-prefixing them with NEXT_PUBLIC_ would
// require either re-pasting the secret values (already encrypted in
// Vercel) or pulling them to local first (security risk). Server-side
// redirect lets the page point CTAs at /api/checkout/brand?tier=spotlight
// and we read the existing env var server-side without exposing the
// URL to the client bundle.
//
// Caveat: the redirected URL ends up in the browser's address bar
// anyway after the 302, so this isn't a "secret" — it's the same
// Stripe Payment Link a buyer would see if they clicked an embedded
// `<a href=...>` directly. We're just sidestepping the env var rename
// dance.
//
// If env var missing for a tier, redirect to /brand-partners#contact
// (the existing fallback anchor) so the CTA degrades gracefully.

const TIER_TO_ENV: Record<string, string> = {
  spotlight: 'STRIPE_BRAND_LINK_SPOTLIGHT',
  featured: 'STRIPE_BRAND_LINK_FEATURED',
  founding: 'STRIPE_BRAND_LINK_COMARKETED', // $1500 tier — co-marketed product
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const tier = (url.searchParams.get('tier') || '').toLowerCase();

  const envName = TIER_TO_ENV[tier];
  if (!envName) {
    return NextResponse.redirect(new URL('/brand-partners#contact', url.origin), 302);
  }

  const target = process.env[envName];
  if (!target) {
    console.warn(`[checkout/brand] ${envName} not set — falling back to /brand-partners#contact`);
    return NextResponse.redirect(new URL('/brand-partners#contact', url.origin), 302);
  }

  // 302 vs 301: 302 (Found) keeps the URL temporary so future
  // redeploys can change the destination without browser caching
  // the old URL.
  return NextResponse.redirect(target, 302);
}
