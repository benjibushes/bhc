'use client';

// Tiny client button that POSTs to /api/founders/checkout and follows the
// returned Stripe URL. Used for the cap-enforced Founding 100 + Title
// Founder + (when FOUNDERS_TEST_MODE) the $1 verification tier. The 6
// fixed-price subscription/lifetime tiers ship as plain Stripe Payment
// Links rendered as <a> tags from the server page — no JS needed.

import { useState } from 'react';
import { trackEvent } from '@/lib/analytics';

export default function FounderCheckoutButton({
  tier,
  label,
  disabled,
}: {
  tier: 'founding-100' | 'title-founder' | 'test-1';
  label: string;
  disabled?: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onClick = async () => {
    if (loading || disabled) return;
    // Attribution events — fire BEFORE the Stripe redirect so Meta+GA
    // see the funnel step even if the network call hangs or the user
    // bounces mid-checkout. Wired 2026-05-26 (audit F4).
    trackEvent('founders_tier_click', { tier });
    trackEvent('founders_checkout_start', { tier });
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/founders/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier }),
      });
      const data = await res.json();
      if (!res.ok || !data.url) {
        setError(data?.error || 'Could not start checkout. Try again.');
        setLoading(false);
        return;
      }
      window.location.href = data.url;
    } catch (e: any) {
      setError(e?.message || 'Network error');
      setLoading(false);
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled || loading}
        className={`w-full text-center px-6 py-3 text-sm tracking-wide ${
          disabled
            ? 'bg-[#A7A29A] text-[#F4F1EC] cursor-not-allowed'
            : loading
            ? 'bg-[#6B4F3F] text-[#F4F1EC] cursor-wait'
            : 'bg-[#0E0E0E] text-[#F4F1EC] hover:bg-[#6B4F3F]'
        }`}
      >
        {loading ? 'Opening Stripe…' : label}
      </button>
      {error && (
        <p className="text-xs text-[#8C2F2F] mt-2 text-center">{error}</p>
      )}
    </div>
  );
}
