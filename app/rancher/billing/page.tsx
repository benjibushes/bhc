'use client';

// Stage-3 Task 5 — /rancher/billing dashboard.
// Tier badge + subscription status + connect status + payouts + add-on shop
// + Stripe Customer Portal link.

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import RancherSubNav from '../RancherSubNav';

interface BillingData {
  pricingModel: string;
  tier: string | null;
  tierLabel: string | null;
  monthlyCents: number | null;
  commissionRate: number | null;
  subscriptionStatus: string;
  subscriptionStarted: string | null;
  subscriptionNext: string | null;
  connectStatus: string;
  connectAccountId: string | null;
  // How many KYC items Stripe is still waiting on (0 when none / unknown).
  connectCurrentlyDueCount?: number;
  // True when a fresh Stripe onboarding link can resume the rancher (the
  // self-serve fix for accounts stuck mid-KYC: no bank / unaccepted TOS).
  connectCanResumeOnboarding?: boolean;
  payouts: Array<{
    id: string;
    amountCents: number;
    status: string;
    reason: string;
    releasedAt: string | null;
    stripeTransferId: string;
  }>;
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

export default function RancherBillingPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-bone text-charcoal flex items-center justify-center"><p>Loading billing…</p></div>}>
      <RancherBillingContent />
    </Suspense>
  );
}

function RancherBillingContent() {
  const search = useSearchParams();
  const [data, setData] = useState<BillingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Add-on purchase error — kept separate from `error` (which is page-fatal and
  // swaps the whole view for an error screen). Renders inline in the add-on shop.
  const [purchaseErr, setPurchaseErr] = useState('');
  const justOnboarded = search.get('onboarding') === 'done';
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
    try {
      const res = await fetch('/api/rancher/tier/portal', { credentials: 'include' });
      const j = await res.json();
      if (j?.url) window.location.href = j.url;
      else setError(j?.error || 'Portal session failed');
    } catch (e: any) {
      setError(e?.message);
    }
  };

  const startConnect = async () => {
    try {
      const res = await fetch('/api/rancher/connect/start', { method: 'POST', credentials: 'include' });
      const j = await res.json();
      if (j?.url) window.location.href = j.url;
      else setError(j?.error || 'Connect start failed');
    } catch (e: any) {
      setError(e?.message);
    }
  };

  if (loading) {
    return <div className="min-h-screen bg-bone text-charcoal p-8">Loading…</div>;
  }
  if (error || !data) {
    return (
      <div className="min-h-screen bg-bone text-charcoal">
        <RancherSubNav active="money" />
        <div className="max-w-4xl mx-auto px-6 py-10">
          <p>Error: {error || 'No data'}</p>
        </div>
      </div>
    );
  }

  const fmtCurrency = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  const fmtDate = (iso: string | null) => iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

  return (
    <main className="min-h-screen bg-bone text-charcoal">
      <RancherSubNav active="money" />
      <div className="max-w-4xl mx-auto px-6 py-10">
        <h1 className="text-4xl mb-2" style={{ fontFamily: 'Georgia, serif' }}>money</h1>
        <p className="text-sm text-saddle mb-6">
          your plan, payouts, and the bank account we pay you into.
        </p>

        {justOnboarded && data.connectStatus === 'active' && (
          <div className="border border-green-600 bg-green-50 p-4 mb-6">
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
              🎁 You're on the legacy 10% post-close commission model.{' '}
              <Link href="/partner?from=upgrade" className="underline">Upgrade to a tier →</Link>{' '}
              for marketing perks + lower commission.
            </p>
          </div>
        )}

        {/* Tier badge + price */}
        <div className="border border-dust bg-white p-6 mb-4">
          <div className="text-xs text-saddle uppercase tracking-wider mb-1">Current plan</div>
          <div className="text-2xl mb-1" style={{ fontFamily: 'Georgia, serif' }}>
            {data.tierLabel || 'No tier selected'}
          </div>
          {data.monthlyCents != null && data.commissionRate != null && (
            <div className="text-saddle">
              {fmtCurrency(data.monthlyCents)}/mo + {(data.commissionRate * 100).toFixed(0)}% commission
            </div>
          )}
          {!data.tier && (
            <Link
              href="/partner"
              className="inline-block mt-3 bg-charcoal text-bone px-6 py-2 uppercase tracking-wider text-xs"
            >
              Pick a plan →
            </Link>
          )}
        </div>

        {/* Subscription status */}
        <div className="border border-dust bg-white p-6 mb-4">
          <div className="text-xs text-saddle uppercase tracking-wider mb-2">Subscription</div>
          <div className="flex items-baseline gap-3">
            <span className={`text-sm ${data.subscriptionStatus === 'active' ? 'text-green-700' : 'text-saddle'}`}>
              {data.subscriptionStatus === 'active' ? '✅ Active' : data.subscriptionStatus}
            </span>
            {data.subscriptionNext && (
              <span className="text-saddle text-sm">
                · Next invoice {fmtDate(data.subscriptionNext)} for {data.monthlyCents ? fmtCurrency(data.monthlyCents) : ''}
              </span>
            )}
          </div>
          {data.subscriptionStatus === 'active' && (
            <button
              onClick={openPortal}
              className="mt-3 text-saddle text-sm underline hover:text-charcoal"
            >
              Manage payment method / cancel →
            </button>
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
            <div className={`border bg-white p-6 mb-4 ${data.connectStatus === 'restricted' ? 'border-red-600' : data.connectStatus === 'active' ? 'border-dust' : 'border-amber-dark'}`}>
              <div className="text-xs text-saddle uppercase tracking-wider mb-2">Bank account (Stripe Connect)</div>
              <div className="flex items-baseline gap-3 mb-2">
                <span className={`text-sm ${data.connectStatus === 'active' ? 'text-green-700' : data.connectStatus === 'restricted' ? 'text-red-700' : 'text-saddle'}`}>
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

        {/* Payouts table */}
        <div className="border border-dust bg-white p-6 mb-4">
          <div className="text-xs text-saddle uppercase tracking-wider mb-3">Recent payouts</div>
          {data.payouts.length === 0 ? (
            <p className="text-saddle text-sm">No payouts yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-divider">
                <tr className="text-left text-saddle text-xs uppercase tracking-wider">
                  <th className="pb-2 font-normal">Date</th>
                  <th className="pb-2 font-normal">Amount</th>
                  <th className="pb-2 font-normal">Status</th>
                  <th className="pb-2 font-normal">Reason</th>
                </tr>
              </thead>
              <tbody>
                {data.payouts.map((p) => (
                  <tr key={p.id} className="border-b border-divider last:border-0">
                    <td className="py-2">{fmtDate(p.releasedAt)}</td>
                    <td className="py-2">{fmtCurrency(p.amountCents)}</td>
                    <td className="py-2 capitalize">{p.status}</td>
                    <td className="py-2 text-saddle text-xs">{p.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
              <div className="p-3 mb-4 border-l-4 border-red-500 bg-red-50 text-sm text-red-900 flex items-center justify-between gap-3">
                <span>{purchaseErr}</span>
                <button type="button" onClick={() => setPurchaseErr('')} className="text-lg leading-none hover:opacity-70">×</button>
              </div>
            )}
            {data.addOns.length > 0 && (
              <>
                <div className="text-xs text-saddle uppercase tracking-wider mb-2">Your add-on history</div>
                <table className="w-full text-sm">
                  <thead className="border-b border-divider">
                    <tr className="text-left text-saddle text-xs uppercase tracking-wider">
                      <th className="pb-2 font-normal">Date</th>
                      <th className="pb-2 font-normal">Type</th>
                      <th className="pb-2 font-normal">Amount</th>
                      <th className="pb-2 font-normal">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.addOns.map((a) => (
                      <tr key={a.id} className="border-b border-divider last:border-0">
                        <td className="py-2">{fmtDate(a.purchasedAt)}</td>
                        <td className="py-2">{a.type}</td>
                        <td className="py-2">{fmtCurrency(a.amountCents)}</td>
                        <td className="py-2 capitalize">{a.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
