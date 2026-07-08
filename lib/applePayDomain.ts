// lib/applePayDomain.ts
//
// WALLETS ON DIRECT CHARGES (Payment Element migration, PR D — spec §6).
// For a direct charge the CONNECTED account is the merchant of record, so
// Apple Pay requires our domains registered on EACH rancher's account —
// platform-level registration is NOT enough. Google Pay + Link need nothing.
//
// Mirrors the ensureStripePrice mint-on-first-sell pattern: lazily called
// fire-and-forget at checkout mint, result cached on the Ranchers row
// ('Apple Pay Domain Registered' checkbox) so we never re-call per buy.
// Every path fails SOFT — an unvalidated domain just means the wallet button
// doesn't render (card checkout unaffected), so this must never block a mint.
//
// Prereq (shipped with this PR): Stripe's association file served at
// /.well-known/apple-developer-merchantid-domain-association (one shared
// static file covers every connected account).

import { getStripeClient } from '@/lib/stripeConnect';
import { updateRecord, TABLES } from '@/lib/airtable';
import { isDemoMode } from '@/lib/demo/demoMode';

const DOMAINS = ['www.buyhalfcow.com', 'buyhalfcow.com'];

/**
 * Register our payment-method domains on the rancher's connected account
 * (idempotent — Stripe re-validates an existing domain instead of erroring).
 * Call fire-and-forget: `void ensureApplePayDomains(rancher).catch(() => {})`.
 */
export async function ensureApplePayDomains(rancher: {
  id: string;
  connectAccountId: string;
  alreadyRegistered?: boolean;
}): Promise<void> {
  if (isDemoMode()) return;
  if (!rancher?.connectAccountId || rancher.alreadyRegistered) return;

  const stripe = getStripeClient();
  let allOk = true;
  for (const domain_name of DOMAINS) {
    try {
      const d = await stripe.paymentMethodDomains.create(
        { domain_name },
        { stripeAccount: rancher.connectAccountId },
      );
      // apple_pay.status validates async on Stripe's side; 'active' or
      // 'pending' both count as registered (pending self-resolves once the
      // .well-known file is crawled). Anything else → retry next mint.
      const status = (d as any)?.apple_pay?.status;
      if (status && status !== 'active' && status !== 'pending') allOk = false;
    } catch (e: any) {
      allOk = false;
      console.warn(`[applePayDomain] ${domain_name} on ${rancher.connectAccountId} failed (non-fatal):`, e?.message);
    }
  }

  if (allOk) {
    await updateRecord(TABLES.RANCHERS, rancher.id, { 'Apple Pay Domain Registered': true }).catch(() => {});
  }
}
