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

import { Suspense, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';

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
      <main className="mx-auto max-w-xl px-5 py-16">
        <h1 className="font-serif text-2xl">This reservation isn&apos;t available</h1>
        <p className="mt-3 text-stone-600">{loadError}</p>
        <Link href="/ranchers" className="mt-6 inline-block rounded-sm bg-stone-900 px-5 py-3 text-white">
          Browse ranches
        </Link>
      </main>
    );
  }

  if (!info) {
    return (
      <main className="mx-auto max-w-xl px-5 py-16">
        <p className="text-stone-500">Loading your reservation…</p>
      </main>
    );
  }

  const cut = info.cuts.find((c) => c.slug === selected) || null;

  return (
    <main className="mx-auto max-w-xl px-5 py-12">
      <p className="text-sm uppercase tracking-wide text-stone-500">
        {info.rancher.ranchName || info.rancher.name}
        {info.rancher.state ? ` · ${info.rancher.state}` : ''}
      </p>
      <h1 className="mt-2 font-serif text-3xl">Reserve your share</h1>

      {canceled && (
        <p className="mt-4 rounded-sm border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          No worries — nothing was charged. Pick your share below when you&apos;re ready.
        </p>
      )}

      {info.cuts.length > 1 && (
        <div className="mt-8 space-y-2">
          {info.cuts.map((c) => (
            <button
              key={c.slug}
              type="button"
              onClick={() => setSelected(c.slug)}
              className={`flex w-full items-center justify-between rounded-sm border px-4 py-3 text-left ${
                c.slug === selected ? 'border-stone-900 bg-stone-50' : 'border-stone-300'
              }`}
            >
              <span className="font-medium">{c.label}</span>
              <span className="text-stone-600">{usd(c.priceCents)} total</span>
            </button>
          ))}
        </div>
      )}

      {cut && (
        <div className="mt-8 rounded-sm border border-stone-300 bg-stone-50 p-5">
          <div className="flex items-baseline justify-between">
            <span className="text-stone-600">{cut.label} — total price</span>
            <span className="font-medium">{usd(cut.priceCents)}</span>
          </div>
          <div className="mt-2 flex items-baseline justify-between">
            <span className="text-stone-600">Deposit due today</span>
            <span className="text-2xl font-bold">{usd(cut.dueNowCents)}</span>
          </div>
          <hr className="my-3 border-stone-300" />
          <div className="flex items-baseline justify-between">
            <span className="text-stone-600">Balance you pay the ranch</span>
            <span className="font-medium">{usd(cut.balanceCents)}</span>
          </div>
          <p className="mt-3 text-sm text-stone-600">
            You pay the remaining {usd(cut.balanceCents)} directly to{' '}
            {info.rancher.ranchName || info.rancher.name}, not to BuyHalfCow. {info.balanceNote}
          </p>
        </div>
      )}

      <label className="mt-6 flex items-start gap-3 text-sm text-stone-700">
        <input
          type="checkbox"
          checked={terms}
          onChange={(e) => setTerms(e.target.checked)}
          className="mt-1"
        />
        <span>
          I agree to the{' '}
          <Link href="/terms" className="underline">
            Terms
          </Link>{' '}
          and understand my deposit reserves this share, with the balance paid directly to the ranch.
        </span>
      </label>

      {submitError && <p className="mt-4 text-sm text-red-700">{submitError}</p>}

      <button
        type="button"
        onClick={submit}
        disabled={!cut || !terms || submitting}
        className="mt-6 w-full rounded-sm bg-stone-900 px-5 py-4 text-white disabled:opacity-40"
      >
        {submitting ? 'Starting checkout…' : cut ? `Pay ${usd(cut.dueNowCents)} deposit` : 'Select a share'}
      </button>
      <p className="mt-3 text-center text-xs text-stone-500">Secure checkout by Stripe.</p>
    </main>
  );
}

export default function BrokerCheckoutPage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto max-w-xl px-5 py-16">
          <p className="text-stone-500">Loading…</p>
        </main>
      }
    >
      <BrokerCheckoutInner />
    </Suspense>
  );
}
