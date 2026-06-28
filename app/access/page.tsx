// /access — the unified buyer funnel (2026-06-18)
//
// This is the single front door for every beef buyer. It replaces the old
// multi-field signup form + the separate /qualify quiz with ONE game-like
// wizard (BuyerFunnel, mode="fresh"). The flow seals the chrome (ChromeGate
// adds '/access' to its focused prefixes) so it's a checkout-style room.
//
// Server component: reads the runtime operator config (getAdminConfig) so the
// reveal can flip between "your rancher reaches out" and "book Ben's call" with
// no redeploy. SEO/OG metadata lives in app/access/layout.tsx — preserved.
//
// ?rancher=<slug> still prefills the pinned rancher through the flow (passed as
// rancherSlug → used for campaign attribution at lead creation).

import { getAdminConfig } from '@/lib/adminConfig';
import { normalizeState } from '@/lib/states';
import BuyerFunnel from '@/app/components/funnel/BuyerFunnel';

export default async function AccessPage({
  searchParams,
}: {
  // ?state=XX is set by the geo landing pages (/access/[state] links to
  // /access?state=XX). Read + normalize it so BuyerFunnel can seed its state
  // dropdown; the buyer can still change it.
  searchParams: Promise<{ rancher?: string; state?: string }>;
}) {
  const [{ rancher, state }, cfg] = await Promise.all([searchParams, getAdminConfig()]);
  // normalizeState accepts "CA", "california", " ca ", etc. and returns the
  // canonical 2-letter code or '' for anything unrecognized — so a junk
  // ?state= param simply leaves the dropdown empty rather than seeding garbage.
  const initialState = normalizeState(state) || undefined;
  return (
    <BuyerFunnel
      mode="fresh"
      rancherSlug={typeof rancher === 'string' ? rancher : undefined}
      offerOperatorCall={cfg.funnelOfferOperatorCall}
      initialState={initialState}
    />
  );
}
