'use client';

// Stage-3 Task 5 — /rancher/billing dashboard.
// Tier badge + subscription status + connect status + payouts + add-on shop
// + Stripe Customer Portal link.
//
// Settings merge (2026-07-15): the content now lives in the shared
// components/BillingSection (also rendered inside the dashboard's Settings
// tab). This standalone route stays alive on purpose — the Stripe Connect
// onboarding return URL (?onboarding=done → the auto-refresh poll below),
// transactional emails, and years of deep links all point here. This file is
// just the page chrome: subnav + heading + the searchParams → prop seam.

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import RancherSubNav from '../RancherSubNav';
import BillingSection from '../components/BillingSection';

export default function RancherBillingPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-bone text-charcoal flex items-center justify-center"><p>Loading billing…</p></div>}>
      <RancherBillingContent />
    </Suspense>
  );
}

function RancherBillingContent() {
  const search = useSearchParams();
  const justOnboarded = search.get('onboarding') === 'done';

  return (
    <main className="min-h-screen bg-bone text-charcoal">
      <RancherSubNav active="money" />
      <div className="max-w-4xl mx-auto px-6 py-10">
        <h1 className="font-serif text-4xl mb-2">money</h1>
        <p className="text-sm text-saddle mb-6">
          your plan, payouts, and the bank account we pay you into.
        </p>
        <BillingSection justOnboarded={justOnboarded} />
      </div>
    </main>
  );
}
