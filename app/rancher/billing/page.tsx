'use client';

// Stage-3 Task 5 — /rancher/billing dashboard.
// Tier badge + subscription status + connect status + payouts + add-on shop
// + Stripe Customer Portal link.

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';

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
  const search = useSearchParams();
  const [data, setData] = useState<BillingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const justOnboarded = search.get('onboarding') === 'done';

  useEffect(() => {
    fetch('/api/rancher/billing/data', { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => {
        if (j?.error) setError(j.error);
        else setData(j);
        setLoading(false);
      })
      .catch((e) => {
        setError(e?.message || 'Load failed');
        setLoading(false);
      });
  }, []);

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
      <div className="min-h-screen bg-bone text-charcoal p-8">
        <p>Error: {error || 'No data'}</p>
        <Link href="/rancher" className="underline text-saddle">← Back to dashboard</Link>
      </div>
    );
  }

  const fmtCurrency = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  const fmtDate = (iso: string | null) => iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

  return (
    <main className="min-h-screen bg-bone text-charcoal">
      <div className="max-w-4xl mx-auto px-6 py-10">
        <Link href="/rancher" className="text-saddle text-sm hover:underline">← Back to dashboard</Link>

        <h1 className="text-4xl mt-4 mb-6" style={{ fontFamily: 'Georgia, serif' }}>Billing</h1>

        {justOnboarded && (
          <div className="border border-dust bg-white p-4 mb-6">
            <p className="text-sm">✅ Stripe onboarding complete. Status is refreshing — banner above will update within 30 seconds.</p>
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

        {/* Connect status */}
        <div className="border border-dust bg-white p-6 mb-4">
          <div className="text-xs text-saddle uppercase tracking-wider mb-2">Bank account (Stripe Connect)</div>
          <div className="flex items-baseline gap-3 mb-2">
            <span className={`text-sm ${data.connectStatus === 'active' ? 'text-green-700' : 'text-saddle'}`}>
              {data.connectStatus === 'active' && '✅ Connected'}
              {data.connectStatus === 'onboarding' && '⏳ Onboarding incomplete'}
              {data.connectStatus === 'restricted' && '⚠️ Restricted — action required'}
              {data.connectStatus === 'not_connected' && '❌ Not connected'}
            </span>
            {data.connectAccountId && (
              <span className="text-saddle text-xs">· {data.connectAccountId}</span>
            )}
          </div>
          {data.connectStatus !== 'active' && (
            <button
              onClick={startConnect}
              className="bg-charcoal text-bone px-6 py-2 uppercase tracking-wider text-xs"
            >
              {data.connectStatus === 'not_connected' ? 'Connect bank →' : 'Continue onboarding →'}
            </button>
          )}
        </div>

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
                      const res = await fetch('/api/rancher/addons/purchase', {
                        method: 'POST',
                        credentials: 'include',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ slug: a.slug }),
                      });
                      const j = await res.json();
                      if (j?.invoiceUrl) window.location.href = j.invoiceUrl;
                      else alert(j?.error || 'Purchase failed');
                    }}
                    className="text-saddle text-sm underline hover:text-charcoal"
                  >
                    Purchase →
                  </button>
                </div>
              ))}
            </div>
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
