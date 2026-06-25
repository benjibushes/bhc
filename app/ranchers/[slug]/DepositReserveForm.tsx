'use client';

// Self-serve deposit form for Connect-active (tier_v2) ranchers. Replaces the
// old "Reserve → /access quiz" detour: pick a cut (defaulted to half) + email →
// POST /api/checkout/reserve → straight to the Stripe deposit page. Secondary
// "talk first" link for the operator-led path. Ineligible ranchers fall back to
// the quiz via the 409 { fallback:true } response.

import { useState } from 'react';
import { track } from '@/lib/track';
import { deriveDeposit } from '@/lib/pricing';

type Cut = 'quarter' | 'half' | 'whole';
interface CutData { price: number; lbs?: any }

interface Props {
  slug: string;
  ranchName: string;
  operatorFirst: string;
  bookingUrl: string; // operator "talk first" Cal link ('' = no call offered)
  quarter?: CutData;
  half?: CutData;
  whole?: CutData;
}

const CUT_LABEL: Record<Cut, string> = { quarter: 'Quarter', half: 'Half', whole: 'Whole' };

export default function DepositReserveForm({
  slug, ranchName, operatorFirst, bookingUrl, quarter, half, whole,
}: Props) {
  const data: Record<Cut, CutData | undefined> = { quarter, half, whole };
  // Default = half (default effect; brand namesake). Fall back to first available.
  const defaultCut: Cut = half ? 'half' : whole ? 'whole' : 'quarter';
  const [cut, setCut] = useState<Cut>(defaultCut);
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState('');

  const cd = (c: Cut) => data[c];
  const depositOf = (c: Cut) => {
    const p = cd(c)?.price || 0;
    return p > 0 ? deriveDeposit(p) : 0;
  };

  function pick(c: Cut) {
    track('AddToCart', {
      content_name: ranchName, content_category: CUT_LABEL[c],
      ranchSlug: slug, value: cd(c)?.price || 0, currency: 'USD',
    });
    setCut(c);
    setError('');
  }

  async function reserve(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/checkout/reserve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ slug, cut, email }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Ineligible (legacy / paused / unpriced) → fall back to the standard flow.
        if (j?.fallback) { window.location.href = `/access?rancher=${slug}`; return; }
        setError(j?.error || 'Something went wrong — try again.');
        setLoading(false);
        return;
      }
      // Returning buyer (existing email, not logged in): the server emailed a
      // secure magic link instead of minting a session. Confirm + stop.
      if (j.requiresEmailVerification) {
        setSent(j.message || 'Check your email for a secure link to finish your deposit.');
        setLoading(false);
        return;
      }
      track('InitiateCheckout', {
        content_name: ranchName, ranchSlug: slug,
        value: cd(cut)?.price || 0, currency: 'USD',
      });
      if (j.depositUrl) {
        window.location.href = j.depositUrl; // → /checkout/[refId]/deposit?cut=…
      } else {
        setError('Could not start checkout — try again.');
        setLoading(false);
      }
    } catch {
      setError('Network error — try again.');
      setLoading(false);
    }
  }

  const order: Cut[] = ['whole', 'half', 'quarter'];

  if (sent) {
    return (
      <div id="reserve" className="scroll-mt-12 rounded-lg border border-dust bg-white p-6 text-center space-y-2">
        <p className="text-xs uppercase tracking-widest text-saddle">Check your email</p>
        <p className="text-sm text-charcoal">{sent}</p>
      </div>
    );
  }

  return (
    <div id="reserve" className="space-y-6 scroll-mt-12">
      <div className="grid sm:grid-cols-3 gap-4">
        {order.map((c) => cd(c) ? (
          <button
            key={c}
            type="button"
            onClick={() => pick(c)}
            className={`border p-5 text-center transition-base ${
              cut === c ? 'border-charcoal bg-charcoal text-bone' : 'border-dust bg-bone text-charcoal hover:border-charcoal'
            }`}
          >
            <p className={`text-xs uppercase tracking-widest ${cut === c ? 'text-bone/70' : 'text-saddle'}`}>{CUT_LABEL[c]}</p>
            <p className="font-serif text-3xl mt-1">${Number(cd(c)!.price).toLocaleString()}</p>
            {cd(c)!.lbs ? <p className={`text-xs mt-1 ${cut === c ? 'text-bone/60' : 'text-dust'}`}>~{cd(c)!.lbs} lbs</p> : null}
          </button>
        ) : null)}
      </div>

      <form onSubmit={reserve} className="max-w-md mx-auto space-y-3">
        <input
          type="email"
          required
          placeholder="Your email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full px-4 py-3 border border-dust bg-white text-sm"
        />
        {error && <p className="text-sm text-weathered">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="w-full px-8 py-4 bg-charcoal text-bone text-sm font-medium tracking-wide uppercase transition-base hover:bg-saddle disabled:opacity-50"
        >
          {loading ? 'Starting…' : `Reserve your ${CUT_LABEL[cut]} — $${depositOf(cut).toLocaleString()} deposit →`}
        </button>
        <p className="text-[11px] text-dust text-center">
          Deposit fully refundable for 7 days. {operatorFirst} ships it straight to you.
        </p>
      </form>

      {bookingUrl ? (
        <a
          href={bookingUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="block text-center text-xs text-saddle underline underline-offset-2 hover:text-charcoal"
        >
          Prefer to talk first? Book a 15-min call →
        </a>
      ) : null}
    </div>
  );
}
