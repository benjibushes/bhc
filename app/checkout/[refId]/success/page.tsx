'use client';

// Stage-3 Task 8 — post-deposit success page.

import { Suspense, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';

interface Info {
  rancher: { name: string; ranchName: string };
}

export default function DepositSuccessPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-bg text-text-primary flex items-center justify-center"><p>Loading…</p></div>}>
      <DepositSuccessContent />
    </Suspense>
  );
}

function DepositSuccessContent() {
  const params = useParams<{ refId: string }>();
  const search = useSearchParams();
  const refId = params.refId;
  const sessionId = search.get('session_id') || '';

  const [info, setInfo] = useState<Info | null>(null);

  useEffect(() => {
    fetch(`/api/checkout/deposit?refId=${encodeURIComponent(refId)}`, { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => { if (!j?.error) setInfo(j); })
      .catch(() => {});
  }, [refId]);

  const rancherName = info?.rancher?.name || 'your rancher';

  return (
    <main className="min-h-screen bg-bone text-charcoal">
      <div className="max-w-2xl mx-auto px-6 py-12">
        <h1 className="text-4xl mb-2" style={{ fontFamily: 'Georgia, serif' }}>
          Deposit confirmed
        </h1>
        <p className="text-saddle mb-8 text-lg">
          Your payment to <strong>{rancherName}</strong> went through.
        </p>

        <div className="bg-white border border-dust p-6 mb-8">
          <h2 className="text-xl mb-4" style={{ fontFamily: 'Georgia, serif' }}>What happens next:</h2>
          <ol className="space-y-3 text-charcoal">
            <li><span className="text-saddle">1.</span> {rancherName} got an email + text. They&apos;ll reply within 24h.</li>
            <li><span className="text-saddle">2.</span> You + {rancherName} arrange pickup/delivery in the message thread.</li>
            <li><span className="text-saddle">3.</span> Once you receive your beef, {rancherName} confirms fulfillment and gets paid out.</li>
          </ol>
        </div>

        <div className="flex flex-col sm:flex-row gap-3">
          <Link
            href={`/checkout/${refId}/ask`}
            className="flex-1 text-center bg-charcoal text-bone px-6 py-3 uppercase tracking-wider text-sm hover:bg-saddle transition"
          >
            Open thread →
          </Link>
          <Link
            href="/member"
            className="flex-1 text-center bg-bone border border-charcoal text-charcoal px-6 py-3 uppercase tracking-wider text-sm hover:bg-divider transition"
          >
            Your dashboard
          </Link>
        </div>

        <div className="mt-8 pt-6 border-t border-divider text-center text-saddle text-sm">
          <p>Receipt sent to your email. You&apos;ll get tracking when your beef ships.</p>
          {sessionId && (
            <p className="text-xs text-dust mt-2">
              <code>{sessionId.slice(0, 28)}…</code>
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
