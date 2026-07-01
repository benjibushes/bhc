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
  searchParams: Promise<{ rancher?: string; state?: string; error?: string }>;
}) {
  const [{ rancher, state, error }, cfg] = await Promise.all([searchParams, getAdminConfig()]);
  // normalizeState accepts "CA", "california", " ca ", etc. and returns the
  // canonical 2-letter code or '' for anything unrecognized — so a junk
  // ?state= param simply leaves the dropdown empty rather than seeding garbage.
  const initialState = normalizeState(state) || undefined;
  // B6 — expired/invalid re-engagement links (from /api/warmup/engage) redirect
  // here with ?error=. Without surfacing it, the buyer lands on a pristine quiz
  // and thinks the form "reset/broke." Map it to a friendly banner.
  const NOTICES: Record<string, string> = {
    'expired-token': 'that link expired — no worries, pick up right here.',
    'invalid-token': "that link didn't work — start fresh below, takes a minute.",
    'used-token': 'looks like that link was already used — pick up here.',
  };
  const notice = error ? (NOTICES[error] || 'let’s pick up where you left off below.') : undefined;
  return (
    <BuyerFunnel
      mode="fresh"
      rancherSlug={typeof rancher === 'string' ? rancher : undefined}
      offerOperatorCall={cfg.funnelOfferOperatorCall}
      initialState={initialState}
      notice={notice}
    />
  );
}
