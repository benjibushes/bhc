'use client';

// BROKER RAIL checkout page.
//
// The buyer-facing half of docs/BUSINESS-MODEL.md model 3. Deliberately its own
// page rather than a branch inside the 700-line Connect deposit page: the two
// rails price differently (there is no fee-on-top here), and a shared page
// would be one careless edit away from charging under the wrong money model.
//
// WHAT THE BUYER SEES, and why it is honest: a deposit toward their share, and
// the exact balance they will pay the RANCH directly. Their total is identical
// to buying from the ranch direct. That BHC keeps the deposit as its brokerage
// commission is a matter between BHC and the rancher (who agreed to it at
// signup) — it is not the buyer's transaction and is not shown here.
//
// WAVE 2 buyer UI (2026-08-01) — PRESENTATION rebuild only. This is a LIVE
// money page that shipped on raw stone-*/amber-* utilities with no brand
// tokens and no trust content (no refund policy, no BHC Promise, no cold-chain
// guarantee, no security line — just a bare Terms checkbox). It now renders on
// the brand system and carries the SAME trust blocks as the Connect deposit
// page (BHCPromiseBadge, REFUND_POLICY_SHORT, the secured-by-stripe line).
// Money logic, amounts, and the POST flow are untouched.

import { Suspense, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import BHCPromiseBadge from '@/app/components/BHCPromiseBadge';
import { REFUND_POLICY_SHORT } from '@/lib/refundPolicy';

interface BrokerCut {
  slug: string;
  label: string;
  priceCents: number;
  dueNowCents: number;
  balanceCents: number;
}

interface BrokerInfo {
  rancher: { name: string; ranchName: string; state: string };
  rail: string;
  balanceNote: string;
  cuts: BrokerCut[];
}

function usd(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function BrokerCheckoutInner() {
  const params = useParams<{ refId: string }>();
  const search = useSearchParams();
  const refId = String(params?.refId || '');
  const presetCut = (search?.get('cut') || '').toLowerCase();
  const canceled = search?.get('canceled') === '1';

  const [info, setInfo] = useState<BrokerInfo | null>(null);
  const [loadError, setLoadError] = useState<string>('');
  const [selected, setSelected] = useState<string>('');
  const [terms, setTerms] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  useEffect(() => {
    if (!refId) return;
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/checkout/broker?refId=${encodeURIComponent(refId)}`);
        const data = await res.json().catch(() => ({}));
        if (!alive) return;
        if (!res.ok) {
          setLoadError(
            data?.message ||
              (res.status === 401
                ? 'Open this page from the link we sent you.'
                : 'We could not load this reservation.'),
          );
          return;
        }
        setInfo(data);
        const cuts: BrokerCut[] = data?.cuts || [];
        const preset = cuts.find((c) => c.slug === presetCut);
        setSelected(preset?.slug || cuts[0]?.slug || '');
      } catch {
        if (alive) setLoadError('We could not load this reservation.');
      }
    })();
    return () => {
      alive = false;
    };
  }, [refId, presetCut]);

  async function submit() {
    if (!selected || !terms || submitting) return;
    setSubmitting(true);
    setSubmitError('');
    try {
      const res = await fetch('/api/checkout/broker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ referralId: refId, cutSize: selected }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.url) {
        setSubmitError(data?.message || 'We could not start your reservation. Your card was not charged.');
        setSubmitting(false);
        return;
      }
      window.location.href = data.url;
    } catch {
      setSubmitError('We could not start your reservation. Your card was not charged.');
      setSubmitting(false);
    }
  }

  if (loadError) {
    return (
      <main className="min-h-screen bg-bone text-charcoal">
        <div className="mx-auto max-w-xl px-5 py-16">
          <h1 className="font-serif text-2xl">This reservation isn&apos;t available</h1>
          <p className="mt-3 text-saddle">{loadError}</p>
          <Link
            href="/ranchers"
            className="mt-6 inline-block rounded-sm bg-charcoal px-5 py-3 text-bone text-sm uppercase tracking-wide hover:bg-saddle transition-colors"
          >
            Browse ranches
          </Link>
        </div>
      </main>
    );
  }

  if (!info) {
    return (
      <main className="min-h-screen bg-bone text-charcoal">
        <div className="mx-auto max-w-xl px-5 py-16">
          <p className="text-saddle">Loading your reservation…</p>
        </div>
      </main>
    );
  }

  const cut = info.cuts.find((c) => c.slug === selected) || null;

  return (
    <main className="min-h-screen bg-bone text-charcoal">
      <div className="mx-auto max-w-xl px-5 py-10 md:py-12">
        <p className="text-sm uppercase tracking-wide text-saddle">
          {info.rancher.ranchName || info.rancher.name}
          {info.rancher.state ? ` · ${info.rancher.state}` : ''}
        </p>
        <h1 className="mt-2 font-serif text-3xl">Reserve your share</h1>

        {canceled && (
          <p className="mt-4 rounded-sm border border-dust bg-bone-warm px-4 py-3 text-sm text-charcoal">
            No worries — nothing was charged. Pick your share below when you&apos;re ready.
          </p>
        )}

        {info.cuts.length > 1 && (
          <div className="mt-8 space-y-2" role="radiogroup" aria-label="Pick your share">
            {info.cuts.map((c) => (
              <button
                key={c.slug}
                type="button"
                role="radio"
                aria-checked={c.slug === selected}
                onClick={() => setSelected(c.slug)}
                className={`flex w-full min-h-11 items-center justify-between rounded-sm border-2 bg-white px-4 py-3 text-left transition-colors ${
                  c.slug === selected ? 'border-charcoal ring-1 ring-charcoal' : 'border-dust hover:border-saddle'
                }`}
              >
                <span className="font-medium">{c.label}</span>
                <span className="text-saddle">{usd(c.priceCents)} total</span>
              </button>
            ))}
          </div>
        )}

        {cut && (
          <div className="mt-8 rounded-sm border border-dust bg-white p-5">
            <div className="flex items-baseline justify-between">
              <span className="text-saddle">{cut.label} — total price</span>
              <span className="font-medium">{usd(cut.priceCents)}</span>
            </div>
            <div className="mt-2 flex items-baseline justify-between">
              <span className="text-saddle">Deposit due today</span>
              <span className="font-serif text-2xl font-bold">{usd(cut.dueNowCents)}</span>
            </div>
            <hr className="my-3 border-dust" />
            <div className="flex items-baseline justify-between">
              <span className="text-saddle">Balance you pay the ranch</span>
              <span className="font-medium">{usd(cut.balanceCents)}</span>
            </div>
            <p className="mt-3 text-sm text-saddle leading-relaxed">
              Your deposit counts toward your share price. You pay the remaining{' '}
              {usd(cut.balanceCents)} directly to{' '}
              {info.rancher.ranchName || info.rancher.name}, not to BuyHalfCow. {info.balanceNote}
            </p>
          </div>
        )}

        {/* The same platform trust floor the Connect deposit page carries —
            refund window, cold-chain guarantee, mediation. */}
        <div className="mt-6">
          <BHCPromiseBadge />
        </div>

        <label className="mt-6 flex items-start gap-3 text-sm text-charcoal/85 leading-relaxed cursor-pointer">
          <input
            type="checkbox"
            checked={terms}
            onChange={(e) => setTerms(e.target.checked)}
            className="mt-1 w-4 h-4 accent-charcoal cursor-pointer shrink-0"
          />
          <span>
            I agree to the{' '}
            <Link href="/terms" className="underline underline-offset-2 hover:text-saddle">
              Terms of Service
            </Link>{' '}
            and the refund policy: {REFUND_POLICY_SHORT}. My deposit reserves this share, with the
            balance paid directly to the ranch.
          </span>
        </label>

        {submitError && (
          <p role="alert" className="mt-4 text-sm text-weathered">
            {submitError}
          </p>
        )}

        <button
          type="button"
          onClick={submit}
          disabled={!cut || !terms || submitting}
          className="mt-6 w-full min-h-[48px] rounded-sm bg-charcoal px-5 py-4 text-bone text-base hover:bg-saddle transition-colors disabled:opacity-50 flex items-center justify-center"
        >
          {submitting ? 'Starting checkout…' : cut ? `Pay ${usd(cut.dueNowCents)} deposit` : 'Select a share'}
        </button>

        {/* Security line — directly under the pay button, where deposit
            anxiety peaks (same placement as the Connect deposit page). */}
        <p className="mt-2 text-center text-xs text-saddle leading-relaxed">
          {REFUND_POLICY_SHORT} · secured by Stripe · we don&apos;t store card data
        </p>
      </div>
    </main>
  );
}

export default function BrokerCheckoutPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-bone text-charcoal">
          <div className="mx-auto max-w-xl px-5 py-16">
            <p className="text-saddle">Loading…</p>
          </div>
        </main>
      }
    >
      <BrokerCheckoutInner />
    </Suspense>
  );
}
