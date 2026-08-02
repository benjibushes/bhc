'use client';

// ── Billing section (Settings merge, 2026-07-15) ───────────────────────────
// The EXACT /rancher/billing content — tier badge + plan switcher +
// subscription status + Connect status + live Stripe payouts + add-on shop —
// extracted 1:1 into a shared component so it renders in two places:
//   • the dashboard's new Settings tab (billing + account, one spine stop)
//   • the standalone /rancher/billing page (kept alive: emails, the Stripe
//     onboarding return URL ?onboarding=done, and old deep links all point
//     there)
// Pure move, no logic changes. The only seam: `justOnboarded` arrives as a
// prop (the standalone page reads it from useSearchParams inside its own
// Suspense boundary; the Settings tab passes false).

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { formatUSD } from '@/lib/formatUSD';

interface BillingData {
  pricingModel: string;
  tier: string | null;
  tierLabel: string | null;
  monthlyCents: number | null;
  commissionRate: number | null;
  subscriptionStatus: string;
  subscriptionStarted: string | null;
  subscriptionNext: string | null;
  // True only when the rancher has a REAL Stripe Subscription Id —
  // legacy_connect carries a synthetic 'active' status with no subscription,
  // and the plan switcher must hide for them (tier/change 409s without one).
  hasRealSubscription?: boolean;
  connectStatus: string;
  connectAccountId: string | null;
  // How many KYC items Stripe is still waiting on (0 when none / unknown).
  connectCurrentlyDueCount?: number;
  // True when a fresh Stripe onboarding link can resume the rancher (the
  // self-serve fix for accounts stuck mid-KYC: no bank / unaccepted TOS).
  connectCanResumeOnboarding?: boolean;
  // Legacy escrow-model payouts (Airtable Payouts table). Permanently empty
  // under the direct-charge model — kept in the shape for compatibility, but
  // the UI no longer renders it. See stripePayouts below.
  payouts: Array<{
    id: string;
    amountCents: number;
    status: string;
    reason: string;
    releasedAt: string | null;
    stripeTransferId: string;
  }>;
  // LIVE Stripe payouts on the rancher's Connect account (Area E4a) — the
  // truth for "did I get paid?". null/missing = the Stripe read failed
  // (show an error line, never claim "no payouts yet"); [] = genuinely none.
  stripePayouts?: Array<{
    id: string;
    amountCents: number;
    status: string;
    createdISO: string | null;
    arrivalDateISO: string | null;
    destinationLast4: string | null;
  }> | null;
  addOns: Array<{
    id: string;
    type: string;
    amountCents: number;
    status: string;
    purchasedAt: string | null;
    stripeInvoiceId: string;
  }>;
}

const ADDON_CATALOG = [
  { slug: 'video', label: 'Custom Video Shoot', priceCents: 250000, description: 'On-site shoot, 1 hero + 4 short-form clips' },
  { slug: 'photo', label: 'Brand Photo Refresh', priceCents: 150000, description: 'Annual on-site photo shoot, ~40 final images' },
  { slug: 'founder_letter', label: 'Founder-Letter Campaign', priceCents: 75000, description: '3-email founder-voice sequence to your customer list' },
];

// The 3 paid tiers, for the plan switcher (dashboard-audit rank 8).
// Hardcoded like ADDON_CATALOG above — lib/tiers.ts re-exports from
// lib/secrets (throws at import when env is missing), so it is NOT safe to
// import into a client component. Prices/rates mirror TIERS in lib/tiers.ts;
// the server route revalidates the slug against the real catalog anyway.
const TIER_CATALOG = [
  { slug: 'pasture', label: 'Pasture', monthlyCents: 15000, commissionPct: '7%' },
  { slug: 'ranch', label: 'Ranch', monthlyCents: 35000, commissionPct: '3%' },
  { slug: 'operator', label: 'Operator', monthlyCents: 50000, commissionPct: '0%' },
];

export default function BillingSection({ justOnboarded }: { justOnboarded: boolean }) {
  const [data, setData] = useState<BillingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Add-on purchase error — kept separate from `error` (which is section-fatal and
  // swaps the whole view for an error line). Renders inline in the add-on shop.
  const [purchaseErr, setPurchaseErr] = useState('');
  // Connect-start error (Wave 1A, 2026-08-01) — startConnect used to write the
  // section-fatal `error` state, so ONE Stripe hiccup on the button click
  // replaced the entire Billing view (plan card, payouts, the Connect button
  // itself) with a single error line and no retry. Renders inline above the
  // button instead; the button survives for a second attempt.
  const [connectErr, setConnectErr] = useState('');
  // Same failure mode for the Stripe billing-portal buttons — inline, not fatal.
  const [portalErr, setPortalErr] = useState('');
  // Plan switcher (dashboard-audit rank 8) — POST /api/rancher/tier/change had
  // ZERO UI callers, so a subscribed rancher literally could not change plans
  // anywhere (tier/select 409s them toward the change route this UI now calls).
  const [showPlans, setShowPlans] = useState(false);
  const [tierChanging, setTierChanging] = useState<string | null>(null);
  const [tierChangeMsg, setTierChangeMsg] = useState('');
  const [tierChangeErr, setTierChangeErr] = useState('');
  // While polling for the post-onboarding status flip (Stripe webhook → Airtable
  // → live read can lag a few seconds), show a "still refreshing" hint.
  const [refreshing, setRefreshing] = useState(false);

  // Single source of truth for loading billing data — reused by the initial
  // mount AND the post-onboarding auto-refresh poll.
  const loadData = async (): Promise<BillingData | null> => {
    const r = await fetch('/api/rancher/billing/data', { credentials: 'include' });
    const j = await r.json();
    if (j?.error) {
      setError(j.error);
      return null;
    }
    setData(j);
    return j as BillingData;
  };

  useEffect(() => {
    loadData()
      .catch((e) => setError(e?.message || 'Load failed'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-refresh after returning from Stripe onboarding. Stripe redirects back
  // with ?onboarding=done, but the connect status only flips once Stripe's
  // webhook lands + the next live read picks it up. Without this the rancher
  // returns "done" yet still sees "onboarding incomplete" and has to manually
  // reload — a confusing dead-end. Poll every 4s (max ~40s) until the status
  // reaches a terminal state (active or restricted) or the budget runs out.
  useEffect(() => {
    if (!justOnboarded || loading) return;
    if (data && data.connectStatus !== 'onboarding') return; // already resolved
    setRefreshing(true);
    let tries = 0;
    const timer = setInterval(async () => {
      tries += 1;
      try {
        const fresh = await loadData();
        if (!fresh || fresh.connectStatus !== 'onboarding' || tries >= 10) {
          clearInterval(timer);
          setRefreshing(false);
        }
      } catch {
        if (tries >= 10) {
          clearInterval(timer);
          setRefreshing(false);
        }
      }
    }, 4000);
    return () => {
      clearInterval(timer);
      setRefreshing(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [justOnboarded, loading, data?.connectStatus]);

  const openPortal = async () => {
    setPortalErr('');
    try {
      const res = await fetch('/api/rancher/tier/portal', { credentials: 'include' });
      const j = await res.json();
      if (j?.url) window.location.href = j.url;
      else setPortalErr(j?.error || 'Portal session failed — try again.');
    } catch (e: any) {
      setPortalErr(e?.message || 'Portal session failed — try again.');
    }
  };

  const changeTier = async (slug: string, label: string, priceLabel: string) => {
    if (!window.confirm(`Switch to ${label} (${priceLabel}/mo)? The difference is prorated on your next invoice.`)) return;
    setTierChanging(slug);
    setTierChangeErr('');
    setTierChangeMsg('');
    try {
      const res = await fetch('/api/rancher/tier/change', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tier: slug }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j?.ok) {
        // The Airtable Tier field flips when the customer.subscription.updated
        // webhook lands — the refetched label can lag a few seconds.
        setTierChangeMsg('Plan updated — your next invoice reflects the change. The plan shown here may take a minute to catch up.');
        await loadData();
      } else if (res.status === 409) {
        // No real subscription after all — the no-subscription path the
        // change route itself points at is the tier checkout.
        window.location.href = `/partner/checkout/${slug}`;
      } else {
        setTierChangeErr(typeof j?.error === 'string' ? j.error : 'Plan change failed — try again.');
      }
    } catch (e: any) {
      setTierChangeErr(e?.message || 'Plan change failed — try again.');
    } finally {
      setTierChanging(null);
    }
  };

  const startConnect = async () => {
    setConnectErr('');
    try {
      const res = await fetch('/api/rancher/connect/start', { method: 'POST', credentials: 'include' });
      const j = await res.json();
      if (j?.url) window.location.href = j.url;
      else setConnectErr(j?.error || 'Connect start failed — try again.');
    } catch (e: any) {
      setConnectErr(e?.message || 'Connect start failed — try again.');
    }
  };

  if (loading) {
    return <p className="text-saddle text-sm py-4">Loading billing…</p>;
  }
  if (error || !data) {
    return <p className="text-sm py-4">Error: {error || 'No data'}</p>;
  }

  // Wave 1A (2026-08-01): one rancher money format (lib/formatUSD) — whole
  // dollars stay whole, real cents always print as two digits.
  const fmtCurrency = (cents: number) => formatUSD(cents / 100);
  const fmtDate = (iso: string | null) => iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
  // SLICE E — 0.04 → "4", 0.075 → "7.5". One decimal max, no trailing ".0",
  // so negotiated rates (Ashcraft 4%) render exactly, never rounded to a
  // number we don't actually bill. Falls back to the platform default label.
  const fmtRatePct = (rate: number | null) =>
    rate != null ? (rate * 100).toFixed(1).replace(/\.0$/, '') : '10';

  return (
    <div>
      {justOnboarded && data.connectStatus === 'active' && (
        <div className="border border-sage bg-sage/10 p-4 mb-6">
          <p className="text-sm">✅ Stripe onboarding complete — your bank is connected and payouts are active.</p>
        </div>
      )}
      {justOnboarded && data.connectStatus !== 'active' && (
        <div className="border border-dust bg-white p-4 mb-6">
          <p className="text-sm">
            {refreshing
              ? '⏳ Checking with Stripe — your payout status will update here automatically in a few seconds.'
              : "Thanks — we're back from Stripe. If anything's still outstanding it's shown below; you can pick up right where you left off."}
          </p>
        </div>
      )}

      {data.pricingModel === 'legacy' && (
        <div className="border border-amber-dark bg-bone p-4 mb-6">
          <p className="text-sm">
            {/* SLICE E — real rate, not hardcoded "10%". The API returns the
                rancher's locked 'Commission Rate' (negotiated — e.g. Ashcraft
                4%) when set, else the tier/platform default. Displayed rate
                must always match the billed rate (2026-05-20 Ashcraft-dispute
                pattern). */}
            {/* Slice-D follow-up: /partner is the new-rancher application page
                (no tier cards) — link each tier's session-authed checkout. */}
            🎁 You're on the legacy {fmtRatePct(data.commissionRate)}% post-close commission model.
            Upgrade to a tier for marketing perks + lower commission:{' '}
            <Link href="/partner/checkout/pasture" className="underline">Pasture $150/mo</Link>
            {' · '}
            <Link href="/partner/checkout/ranch" className="underline">Ranch $350/mo</Link>
            {' · '}
            <Link href="/partner/checkout/operator" className="underline">Operator $500/mo</Link>
          </p>
        </div>
      )}

      {/* Tier badge + price */}
      <div className="border border-dust bg-white p-6 mb-4">
        <div className="text-xs text-saddle uppercase tracking-wider mb-1">Current plan</div>
        <div className="font-serif text-2xl mb-1">
          {data.tierLabel || 'No tier selected'}
        </div>
        {data.monthlyCents != null && data.commissionRate != null && (
          <div className="text-saddle">
            {fmtCurrency(data.monthlyCents)}/mo + {fmtRatePct(data.commissionRate)}% commission
          </div>
        )}
        {/* Plan switcher — only for ranchers with a REAL subscription
            (legacy_connect's synthetic 'active' has nothing to prorate;
            they upgrade via the legacy banner's checkout links above).
            past_due is allowed — Stripe permits subscription updates and
            the rank-7 dunning banner stays the primary call to action. */}
        {data.tier && data.hasRealSubscription && (
          <div className="mt-4 pt-3 border-t border-divider">
            {!showPlans ? (
              <button
                onClick={() => setShowPlans(true)}
                className="text-saddle text-sm underline hover:text-charcoal"
              >
                Change plan →
              </button>
            ) : (
              <div className="space-y-2">
                <div className="text-xs text-saddle uppercase tracking-wider mb-1">Change plan</div>
                {TIER_CATALOG.map((t) => {
                  const isCurrent = t.slug === data.tier;
                  return (
                    <div key={t.slug} className="flex items-center justify-between gap-3 border border-divider p-3">
                      <div className="text-sm">
                        <span className="font-semibold">{t.label}</span>{' '}
                        <span className="text-saddle">
                          · {fmtCurrency(t.monthlyCents)}/mo + {t.commissionPct} commission
                        </span>
                      </div>
                      {isCurrent ? (
                        <span className="text-xs text-saddle uppercase tracking-wider">Current plan</span>
                      ) : (
                        <button
                          onClick={() => changeTier(t.slug, t.label, fmtCurrency(t.monthlyCents))}
                          disabled={tierChanging !== null}
                          className="text-sm underline text-saddle hover:text-charcoal disabled:opacity-50"
                        >
                          {tierChanging === t.slug ? 'Switching…' : 'Switch →'}
                        </button>
                      )}
                    </div>
                  );
                })}
                <p className="text-xs text-saddle">
                  Switching is prorated by Stripe on your next invoice — no double charge.
                </p>
              </div>
            )}
            {tierChangeMsg && (
              <div className="mt-3 p-3 border border-sage/40 bg-sage/10 text-sage-dark text-sm">{tierChangeMsg}</div>
            )}
            {tierChangeErr && (
              <div className="mt-3 p-3 border-l-4 border-weathered bg-weathered/10 text-sm text-weathered flex items-center justify-between gap-3">
                <span>{tierChangeErr}</span>
                <button type="button" onClick={() => setTierChangeErr('')} className="text-lg leading-none hover:opacity-70">×</button>
              </div>
            )}
          </div>
        )}
        {!data.tier && (
          <div className="mt-3 flex gap-2 flex-wrap">
            {/* Slice-D follow-up: pick-a-plan goes straight to each tier's
                session-authed checkout — /partner renders no tier cards. */}
            <Link
              href="/partner/checkout/pasture"
              className="inline-block bg-charcoal text-bone px-6 py-2 uppercase tracking-wider text-xs"
            >
              Pasture $150/mo →
            </Link>
            <Link
              href="/partner/checkout/ranch"
              className="inline-block bg-charcoal text-bone px-6 py-2 uppercase tracking-wider text-xs"
            >
              Ranch $350/mo →
            </Link>
            <Link
              href="/partner/checkout/operator"
              className="inline-block bg-charcoal text-bone px-6 py-2 uppercase tracking-wider text-xs"
            >
              Operator $500/mo →
            </Link>
          </div>
        )}
      </div>

      {/* Subscription status.
          Portal button gate (dashboard-audit rank 7): was `=== 'active'`
          only — a past_due rancher (the one who most needs to fix a card)
          had NO self-serve path to the Stripe portal. Any state Stripe can
          still update a payment method in gets the button; past_due/unpaid
          additionally get a prominent warning banner. */}
      {['past_due', 'unpaid'].includes(data.subscriptionStatus) && (
        <div className="border border-weathered bg-weathered/10 p-4 mb-4">
          <p className="text-sm mb-3">
            ⚠️ <strong>Your last payment failed</strong> — your plan and its perks are at
            risk of lapsing. Update your card:
          </p>
          <button
            onClick={openPortal}
            className="bg-charcoal text-bone px-6 py-2 uppercase tracking-wider text-xs"
          >
            Update payment method →
          </button>
        </div>
      )}
      <div className="border border-dust bg-white p-6 mb-4">
        <div className="text-xs text-saddle uppercase tracking-wider mb-2">Subscription</div>
        <div className="flex items-baseline gap-3">
          <span className={`text-sm ${data.subscriptionStatus === 'active' ? 'text-sage-dark' : 'text-saddle'}`}>
            {data.subscriptionStatus === 'active' ? '✅ Active' : data.subscriptionStatus}
          </span>
          {data.subscriptionNext && (
            <span className="text-saddle text-sm">
              · Next invoice {fmtDate(data.subscriptionNext)} for {data.monthlyCents ? fmtCurrency(data.monthlyCents) : ''}
            </span>
          )}
        </div>
        {['active', 'past_due', 'unpaid', 'trialing'].includes(data.subscriptionStatus) && (
          <button
            onClick={openPortal}
            className="mt-3 text-saddle text-sm underline hover:text-charcoal"
          >
            Manage payment method / cancel →
          </button>
        )}
        {portalErr && (
          <div className="mt-3 p-3 border-l-4 border-weathered bg-weathered/10 text-sm text-weathered flex items-center justify-between gap-3">
            <span>{portalErr}</span>
            <button type="button" onClick={() => setPortalErr('')} className="text-lg leading-none hover:opacity-70">×</button>
          </div>
        )}
      </div>

      {/* Connect status — "finish your payout setup". For any non-active
          account that still has Stripe requirements outstanding, the resume
          action is the Stripe-hosted onboarding link (re-minted fresh every
          time, so an expired link never dead-ends). A restricted account that
          an onboarding link CAN'T fix (rare — e.g. a Stripe-side hold) routes
          to the portal / support instead. */}
      {(() => {
        const dueCount = data.connectCurrentlyDueCount ?? 0;
        const canResume = data.connectCanResumeOnboarding ?? (data.connectStatus !== 'active' && data.connectStatus !== 'not_connected');
        // What's-left line, said plainly. The 4 stuck ranchers need to know it's
        // their bank + identity (TOS), not something on our end.
        let whatsLeft = '';
        if (data.connectStatus === 'not_connected') {
          whatsLeft = "Add your bank account and verify your identity so we can pay you. Takes about 5 minutes through Stripe.";
        } else if (data.connectStatus === 'restricted' && !canResume) {
          whatsLeft = "Stripe has placed a hold on your account that we can't clear from here. Open your Stripe dashboard or email hello@buyhalfcow.com and we'll sort it with you.";
        } else if (dueCount > 0) {
          whatsLeft = `Stripe still needs ${dueCount} more ${dueCount === 1 ? 'thing' : 'things'} from you${data.connectStatus === 'restricted' ? ' — payouts are paused until it’s done' : ''}. Usually your bank details and accepting Stripe’s terms.`;
        } else if (data.connectStatus !== 'active') {
          whatsLeft = "Pick up where you left off — Stripe will take you straight to the next required step (usually your bank details and accepting their terms).";
        }
        const resumeLabel =
          data.connectStatus === 'not_connected'
            ? 'Connect bank →'
            : data.connectStatus === 'restricted'
            ? 'Fix payout setup →'
            : 'Finish payout setup →';
        return (
          <div className={`border bg-white p-6 mb-4 ${data.connectStatus === 'restricted' ? 'border-weathered' : data.connectStatus === 'active' ? 'border-dust' : 'border-amber-dark'}`}>
            <div className="text-xs text-saddle uppercase tracking-wider mb-2">Bank account (Stripe Connect)</div>
            <div className="flex items-baseline gap-3 mb-2">
              <span className={`text-sm ${data.connectStatus === 'active' ? 'text-sage-dark' : data.connectStatus === 'restricted' ? 'text-weathered' : 'text-saddle'}`}>
                {data.connectStatus === 'active' && '✅ Connected — payouts active'}
                {data.connectStatus === 'onboarding' && '⏳ Payout setup unfinished'}
                {data.connectStatus === 'restricted' && '⚠️ Payouts paused — action required'}
                {data.connectStatus === 'not_connected' && '❌ Not connected'}
              </span>
              {data.connectAccountId && (
                <span className="text-saddle text-xs">· {data.connectAccountId}</span>
              )}
            </div>
            {whatsLeft && (
              <p className="text-sm text-saddle mb-3">{whatsLeft}</p>
            )}
            {connectErr && (
              <div className="p-3 mb-3 border-l-4 border-weathered bg-weathered/10 text-sm text-weathered flex items-center justify-between gap-3">
                <span>{connectErr}</span>
                <button type="button" onClick={() => setConnectErr('')} className="text-lg leading-none hover:opacity-70">×</button>
              </div>
            )}
            {data.connectStatus !== 'active' && canResume && (
              <button
                onClick={startConnect}
                className="bg-charcoal text-bone px-6 py-2 uppercase tracking-wider text-xs"
              >
                {resumeLabel}
              </button>
            )}
            {data.connectStatus === 'restricted' && !canResume && (
              <a
                href="mailto:hello@buyhalfcow.com?subject=Stripe%20payout%20account%20restricted"
                className="inline-block bg-charcoal text-bone px-6 py-2 uppercase tracking-wider text-xs"
              >
                Email us to unblock →
              </a>
            )}
          </div>
        );
      })()}

      {/* Payouts table — renders LIVE Stripe payouts on the rancher's
          Connect account (Area E4a). The old escrow-model `payouts` array is
          dead (releasePayout has zero callers under direct charges), so
          rendering it said "No payouts yet" forever — even after a rancher
          had been paid. */}
      <div className="border border-dust bg-white p-6 mb-4">
        <div className="text-xs text-saddle uppercase tracking-wider mb-3">Recent payouts</div>
        {data.stripePayouts == null ? (
          <p className="text-saddle text-sm">
            We couldn’t reach Stripe to load your payouts just now — your money isn’t affected. Refresh in a minute.
          </p>
        ) : data.stripePayouts.length === 0 ? (
          <p className="text-saddle text-sm">
            No payouts yet — your first payout lands about 2 business days after your first deposit clears.
          </p>
        ) : (
          /* Wave 1A (2026-08-01): 5 columns overflow a 375px phone — scroll
             inside the card instead of pushing the whole page sideways. Money
             column is right-aligned tabular-nums so amounts line up. */
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-divider">
                <tr className="text-left text-saddle text-xs uppercase tracking-wider">
                  <th className="pb-2 font-normal">Date</th>
                  <th className="pb-2 font-normal text-right">Amount</th>
                  <th className="pb-2 font-normal">Status</th>
                  <th className="pb-2 font-normal">Arrives</th>
                  <th className="pb-2 font-normal">Bank</th>
                </tr>
              </thead>
              <tbody>
                {data.stripePayouts.map((p) => (
                  <tr key={p.id} className="border-b border-divider last:border-0">
                    <td className="py-2">{fmtDate(p.createdISO)}</td>
                    <td className="py-2 text-right tabular-nums">{fmtCurrency(p.amountCents)}</td>
                    <td className="py-2 capitalize">{p.status.replace(/_/g, ' ')}</td>
                    <td className="py-2">{fmtDate(p.arrivalDateISO)}</td>
                    <td className="py-2 text-saddle text-xs">{p.destinationLast4 ? `••${p.destinationLast4}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Add-on shop */}
      {data.tier && data.connectStatus === 'active' && (
        <div className="border border-dust bg-white p-6 mb-4">
          <div className="text-xs text-saddle uppercase tracking-wider mb-3">Add-ons (one-time purchases)</div>
          <div className="grid md:grid-cols-3 gap-4 mb-4">
            {ADDON_CATALOG.map((a) => (
              <div key={a.slug} className="border border-divider p-4">
                <div className="font-semibold mb-1">{a.label}</div>
                <div className="text-saddle text-sm mb-2">{a.description}</div>
                <div className="text-charcoal mb-3">{fmtCurrency(a.priceCents)}</div>
                <button
                  onClick={async () => {
                    // Wave 1A (2026-08-01): this finalizes a REAL Stripe
                    // invoice — it must never fire off a stray tap. Confirm
                    // with the amount, same pattern as changeTier above.
                    if (!window.confirm(`Purchase ${a.label} for ${fmtCurrency(a.priceCents)}? This creates a Stripe invoice you'll be taken to for payment.`)) return;
                    setPurchaseErr('');
                    const res = await fetch('/api/rancher/addons/purchase', {
                      method: 'POST',
                      credentials: 'include',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ slug: a.slug }),
                    });
                    const j = await res.json();
                    if (j?.invoiceUrl) window.location.href = j.invoiceUrl;
                    else setPurchaseErr(j?.error || 'Purchase failed');
                  }}
                  className="text-saddle text-sm underline hover:text-charcoal"
                >
                  Purchase →
                </button>
              </div>
            ))}
          </div>
          {purchaseErr && (
            <div className="p-3 mb-4 border-l-4 border-weathered bg-weathered/10 text-sm text-weathered flex items-center justify-between gap-3">
              <span>{purchaseErr}</span>
              <button type="button" onClick={() => setPurchaseErr('')} className="text-lg leading-none hover:opacity-70">×</button>
            </div>
          )}
          {data.addOns.length > 0 && (
            <>
              <div className="text-xs text-saddle uppercase tracking-wider mb-2">Your add-on history</div>
              {/* Wave 1A: same phone-overflow + money-column treatment as the
                  payouts table above. */}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-divider">
                    <tr className="text-left text-saddle text-xs uppercase tracking-wider">
                      <th className="pb-2 font-normal">Date</th>
                      <th className="pb-2 font-normal">Type</th>
                      <th className="pb-2 font-normal text-right">Amount</th>
                      <th className="pb-2 font-normal">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.addOns.map((a) => (
                      <tr key={a.id} className="border-b border-divider last:border-0">
                        <td className="py-2">{fmtDate(a.purchasedAt)}</td>
                        <td className="py-2">{a.type}</td>
                        <td className="py-2 text-right tabular-nums">{fmtCurrency(a.amountCents)}</td>
                        <td className="py-2 capitalize">{a.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
