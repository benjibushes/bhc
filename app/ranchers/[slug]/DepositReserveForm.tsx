'use client';

// Self-serve deposit form for Connect-active (tier_v2) ranchers. Replaces the
// old "Reserve → /access quiz" detour: pick a cut (defaulted to half) + email →
// POST /api/checkout/reserve → straight to the Stripe deposit page. Secondary
// "talk first" link for the operator-led path. Ineligible ranchers fall back to
// the quiz via the 409 { fallback:true } response.

import { useEffect, useState } from 'react';
import { track } from '@/lib/track';
import { deriveDeposit } from '@/lib/pricing';
import { REFUND_POLICY_SHORT } from '@/lib/refundPolicy';
import { accessFallbackUrl } from '@/lib/accessFallbackUrl';
import SmsConsentCheckbox, { TermsNotice } from '@/app/components/SmsConsentCheckbox';

type Cut = 'quarter' | 'half' | 'whole';
// depositDue: the ALL-IN deposit (commission baked in, whole dollars) computed
// server-side by the rancher page via lib/pricing depositDisplay — matches the
// checkout page + Stripe charge exactly. FEE-INVISIBLE (founder directive
// 2026-07-01): the buyer sees one number, never a deposit/fee split.
interface CutData { price: number; lbs?: any; depositDue?: number }

interface Props {
  slug: string;
  ranchName: string;
  operatorFirst: string;
  bookingUrl: string; // operator "talk first" Cal link ('' = no call offered)
  quarter?: CutData;
  half?: CutData;
  whole?: CutData;
  /**
   * ZIP-CAPTURE DECISION (2026-07-25). True only when this rancher has
   * `Service ZIP Prefixes` — an exclusivity contract where the buyer's ZIP
   * decides eligibility and therefore must be known BEFORE the charge.
   *
   * For every other rancher (all of them today) this stays false and the form
   * is byte-identical to before: adding a required field to the fastest
   * checkout in the product would cost conversion on the exact endpoint the
   * ads point at, for zero eligibility benefit. Their ZIP is captured after
   * payment instead, from the address Stripe already collects.
   */
  requireZip?: boolean;
}

const CUT_LABEL: Record<Cut, string> = { quarter: 'Quarter', half: 'Half', whole: 'Whole' };

export default function DepositReserveForm({
  slug, ranchName, operatorFirst, bookingUrl, quarter, half, whole, requireZip = false,
}: Props) {
  const data: Record<Cut, CutData | undefined> = { quarter, half, whole };
  // Default = half (default effect; brand namesake). Fall back to first available.
  const defaultCut: Cut = half ? 'half' : whole ? 'whole' : 'quarter';
  const [cut, setCut] = useState<Cut>(defaultCut);
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  // TCPA SMS consent — UNCHECKED by default, never gates the reserve.
  const [smsOptIn, setSmsOptIn] = useState(false);
  // Only rendered (and only sent) when `requireZip` — see the prop docs.
  const [zip, setZip] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState('');
  // P2 (2026-07-28): seconds until the magic-link "resend" re-enables. A buyer
  // whose email is slow (or misfiled) used to hit a dead end on the "check your
  // email" card. No dedicated resend endpoint exists — re-POSTing the reserve
  // re-sends the link (same referral is reused server-side); the client-side
  // cooldown keeps a tap-happy buyer from burning sends.
  const [resendCooldown, setResendCooldown] = useState(0);
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const t = setTimeout(() => setResendCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendCooldown]);
  // T2.2 (2026-07-02): affiliate attribution. Success-page share links append
  // ?ref=<code> to this rancher page; capture it client-side (the page itself
  // is a server component — reading searchParams there would fragment its
  // cache) and thread it into the reserve POST, where the server validates it
  // (existence, Active, self-referral block) before stamping 'Referred By'.
  // Also count the click once per browser session — same sessionStorage
  // pattern as /access + /partner.
  const [refCode, setRefCode] = useState('');
  useEffect(() => {
    try {
      const ref = new URLSearchParams(window.location.search).get('ref') || '';
      if (!ref || ref.length > 50) return;
      setRefCode(ref);
      const dedupeKey = `bhc-ref-click-${ref}`;
      if (!sessionStorage.getItem(dedupeKey)) {
        sessionStorage.setItem(dedupeKey, '1');
        fetch(`/api/affiliates/track-click?ref=${encodeURIComponent(ref)}`, {
          method: 'POST',
          keepalive: true,
        }).catch(() => {});
      }
    } catch {}
  }, []);

  const cd = (c: Cut) => data[c];
  // Prefer the server-computed all-in deposit (commission baked in — matches
  // checkout + the card charge). deriveDeposit fallback only guards a missing
  // prop (e.g. stale caller) and understates by the commission; the server
  // page always passes depositDue for Connect ranchers.
  const depositOf = (c: Cut) => {
    const due = cd(c)?.depositDue;
    if (typeof due === 'number' && due > 0) return due;
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
    // A half-typed ZIP is a typo, not a choice — catch it before the round
    // trip, which would come back as a generic "can't serve your area".
    if (requireZip && !/^\d{5}$/.test(zip.trim())) {
      setError('Please enter your 5-digit ZIP code.');
      return;
    }
    await submitReserve();
  }

  // Core POST — shared by the submit button and the magic-link "resend" (P2).
  async function submitReserve() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/checkout/reserve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        // smsOptIn rides along using the funnel's exact payload convention
        // (→ Airtable `SMS Opt-In`). ref = affiliate attribution captured from
        // the URL above; server-validated before any stamp. No `state`: the
        // server never required it, and settlement now genuinely harvests it
        // (lib/stripeSettlement: stateFromStripePayment off the Stripe
        // address, ZIP-centroid fallback, blank-only fill — preference-
        // fidelity audit 2026-08-12; the old claim that "state arrives from
        // the billing address" was false for a year: only postal_code was
        // harvested). Asking here only stalled the reserve.
        body: JSON.stringify({
          slug, cut, email, phone, smsOptIn,
          ...(requireZip ? { zip: zip.trim() } : {}),
          ...(refCode ? { ref: refCode } : {}),
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Ineligible (legacy / paused / unpriced) → fall back to the standard
        // flow, re-pinning this ranch so the buyer lands back here qualified.
        // EXCEPT out-of-area: this ranch can never serve them, so re-pinning it
        // would loop them right back — send them to the open quiz instead.
        // K1 (2026-07-28): every quiz hand-off carries ?error= so /access shows
        // an honest banner instead of a pristine quiz with zero explanation.
        if (j?.outOfArea) { window.location.href = accessFallbackUrl('out_of_area'); return; }
        if (j?.fallback) { window.location.href = accessFallbackUrl('reserve_fallback', slug); return; }
        // Server error (Airtable/Stripe transient, unexpected 5xx): never
        // dead-end the buyer on the fast path. Route them to the quiz, which
        // mints its own referral + session and still lands them at a deposit.
        // 4xx validation (bad email, etc.) stays inline so they can correct it.
        if (res.status >= 500) { window.location.href = accessFallbackUrl('reserve_fallback', slug); return; }
        setError(j?.error || 'Something went wrong — try again.');
        setLoading(false);
        return;
      }
      // Returning buyer (existing email, not logged in): the server emailed a
      // secure magic link instead of minting a session. Confirm + stop.
      // Arm the resend cooldown (P2) — a send just happened.
      if (j.requiresEmailVerification) {
        setSent(j.message || 'Check your email for a secure link to finish your deposit.');
        setResendCooldown(30);
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
      <div id="reserve" className="scroll-mt-20 rounded-lg border border-dust bg-white p-6 text-center space-y-3">
        <p className="text-xs uppercase tracking-widest text-saddle">Check your email</p>
        <p className="text-sm text-charcoal">{sent}</p>
        {/* P2 — nothing arrived? Re-POST the reserve (the server re-sends the
            magic link for the same reservation); 30s client-side cooldown. */}
        {error && <p className="text-sm text-weathered">{error}</p>}
        <button
          type="button"
          disabled={loading || resendCooldown > 0}
          onClick={() => { setResendCooldown(30); void submitReserve(); }}
          className="text-xs text-saddle underline underline-offset-2 hover:text-charcoal disabled:opacity-50 disabled:no-underline"
        >
          {loading
            ? 'Sending…'
            : resendCooldown > 0
              ? `Didn't get it? Resend in ${resendCooldown}s`
              : "Didn't get it? Resend the link"}
        </button>
      </div>
    );
  }

  return (
    <div id="reserve" className="space-y-6 scroll-mt-20">
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
            {cd(c)!.lbs ? <p className={`text-xs mt-1 ${cut === c ? 'text-bone/60' : 'text-muted'}`}>~{cd(c)!.lbs} lbs</p> : null}
          </button>
        ) : null)}
      </div>

      <form onSubmit={reserve} className="max-w-md mx-auto space-y-3">
        <label htmlFor="reserve-email" className="sr-only">Your email</label>
        <input
          id="reserve-email"
          type="email"
          required
          placeholder="Your email"
          aria-label="Your email"
          autoComplete="email"
          inputMode="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full px-4 py-3 border border-dust bg-white text-sm"
        />
        <input
          type="tel"
          required
          placeholder="Phone"
          autoComplete="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          className="w-full px-4 py-3 border border-dust bg-white text-sm"
        />
        {/* REQUIRED, and only for a ZIP-gated ranch — the fast path stays 4
            fields for everyone else and gets its ZIP from Stripe at payment. */}
        {requireZip && (
          <input
            type="text"
            required
            placeholder="Delivery ZIP"
            aria-label="Delivery ZIP code"
            autoComplete="postal-code"
            inputMode="numeric"
            pattern="\d{5}"
            maxLength={5}
            value={zip}
            onChange={(e) => setZip(e.target.value.replace(/\D/g, '').slice(0, 5))}
            className="w-full px-4 py-3 border border-dust bg-white text-sm"
          />
        )}
        <SmsConsentCheckbox checked={smsOptIn} onChange={setSmsOptIn} />
        {error && <p className="text-sm text-weathered">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="w-full px-8 py-4 bg-charcoal text-bone text-sm font-medium tracking-wide uppercase transition-base hover:bg-saddle disabled:opacity-50"
        >
          {loading ? 'Starting…' : `Reserve your ${CUT_LABEL[cut]} — $${depositOf(cut).toLocaleString()} deposit →`}
        </button>
        <p className="text-[11px] text-muted text-center">
          {REFUND_POLICY_SHORT}. {operatorFirst} ships your beef straight to you.
        </p>
        <TermsNotice />
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
