'use client';

// ApplyForm — client component.
//
// Submits to /api/apply. The server ALWAYS auto-approves and returns a
// wizardUrl (setup-wizard token, 60d) — even for <5-head applicants, who are
// only flagged for Ben's triage in the Telegram alert. The success state
// offers two paths: book the 15-min discovery call (recommended) or skip
// straight to the wizard.

import { useState, useEffect } from 'react';

const STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY',
];

type VolumeBand = '<5' | '5-25' | '25-100' | '100+';
type Constraint = 'more_buyers' | 'better_pricing' | 'easier_logistics' | 'brand_visibility' | 'all_above';
type Channel =
  | 'word_of_mouth'
  | 'social'
  | 'own_website'
  | 'farmers_markets'
  | 'wholesale'
  | 'none';

export default function ApplyForm() {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState<{ wizardUrl?: string } | null>(null);

  // Live discovery-call Cal link, resolved at runtime. The hardcoded slug and
  // the 142d-old NEXT_PUBLIC_CALENDLY_LINK env are both stale (those events were
  // deleted), so embedding either renders a dead booker. /api/book/link confirms
  // a live event via the Cal API; env stays as a fallback.
  const [resolvedDiscoveryCal, setResolvedDiscoveryCal] = useState('');
  useEffect(() => {
    let alive = true;
    fetch('/api/book/link?purpose=rancher')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && d?.url) setResolvedDiscoveryCal(String(d.url));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const [form, setForm] = useState({
    operatorName: '',
    ranchName: '',
    email: '',
    phone: '',
    city: '',
    state: '',
    headPerYear: '' as VolumeBand | '',
    constraint: '' as Constraint | '',
    channels: [] as Channel[],
    acceptsDeposits: '' as 'yes' | 'no' | '',
    website: '',
    notes: '',
    // honeypot — bots fill, humans don't see
    fax: '',
  });

  const setField = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((prev) => ({ ...prev, [k]: v }));

  const toggleChannel = (c: Channel) =>
    setForm((prev) => ({
      ...prev,
      channels: prev.channels.includes(c)
        ? prev.channels.filter((x) => x !== c)
        : [...prev.channels, c],
    }));

  const formatPhone = (v: string) => {
    const d = v.replace(/\D/g, '').slice(0, 10);
    if (d.length < 4) return d;
    if (d.length < 7) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!form.operatorName.trim() || !form.ranchName.trim() || !form.email.trim() || !form.state) {
      setError('Name, ranch, email, and state are required.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
      setError('Please enter a valid email.');
      return;
    }
    // PHONE REQUIRED (2026-07-20). Vale Creek Ranch signed up with a typo'd
    // email (nikki_subley@yahoo.com — hard bounce, "mailbox not found") and no
    // phone. She was approved, sent a setup link that could never arrive, and
    // became permanently unreachable with nobody alerted. Email as the ONLY
    // channel means one typo = a silently lost rancher. Require a second way in.
    // 10 digits = US number after formatPhone() strips punctuation.
    if (form.phone.replace(/\D/g, '').length < 10) {
      setError('A phone number is required — it is how we reach you if email fails.');
      return;
    }
    // headPerYear + constraint are genuinely OPTIONAL (2026-07-08) — they live
    // inside the collapsed "optional: 30 more seconds" accordion and the server
    // only requires name/ranch/email/state. Requiring them here made Submit
    // silently no-op for anyone who filled just the 4 required fields: the
    // early return fired before setSubmitting(true), and the only error render
    // sat hidden inside the closed <details>. Never re-add without moving the
    // fields out of the accordion.
    setSubmitting(true);
    try {
      const res = await fetch('/api/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Submit failed (${res.status})`);
      }
      const data = await res.json();
      setSuccess({ wizardUrl: data.wizardUrl });
      // Don't auto-redirect — user picks between book-discovery vs skip-to-wizard
      // via UI in the success state (2-call architecture).
    } catch (err: any) {
      setError(err?.message || 'Could not submit application. Try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (success) {
    // Two-call architecture: Discovery (15-min, BEFORE wizard) + Onboarding
    // (30-min, IN wizard Step 4). The Discovery call is optional for hot
    // leads who self-redirect to the wizard immediately, but recommended
    // for everyone else. Cal.com embed inline below CTA so they can book
    // without leaving the page.
    // Rancher-call-path fix (2026-07-06): the old 4th fallback was the
    // hardcoded 'ben-beauchman-1itnsg' slug whose events were DELETED in the
    // 2026-06-14 incident — a dead 404 iframe at the exact moment a rancher
    // says yes. No live link → render a button to /book?purpose=rancher
    // (the on-site page that resolves the live event server-side and can
    // never 404) instead of embedding anything stale.
    const DISCOVERY_CAL =
      resolvedDiscoveryCal ||
      process.env.NEXT_PUBLIC_CALENDLY_DISCOVERY_LINK ||
      process.env.NEXT_PUBLIC_CALENDLY_LINK ||
      '';
    const calEmbed = DISCOVERY_CAL
      ? DISCOVERY_CAL.includes('?')
        ? `${DISCOVERY_CAL}&embed=true&theme=light`
        : `${DISCOVERY_CAL}?embed=true&theme=light`
      : '';

    return (
      <div className="space-y-6 max-w-2xl">
        <div className="border border-dust bg-bone-warm p-8">
          {/* The server always returns wizardUrl on a real submission — the
              guards below only cover the hypothetical missing-field case
              (e.g. the honeypot's decoy response, which no human ever sees). */}
          <p className="text-xs uppercase tracking-wider text-sage font-semibold mb-3">
            you&apos;re in 🤝
          </p>
          <h2 className="font-serif text-3xl text-charcoal mb-3">
            welcome to the network.
          </h2>
          <p className="text-saddle text-sm sm:text-base leading-relaxed mb-5">
            your ranch page is reserved. build it now — takes about 5 minutes,
            and you can save and come back anytime. buyers in your state see
            it the moment you go live.
          </p>
          {success.wizardUrl && (
            <a
              href={success.wizardUrl}
              className="inline-flex items-center gap-2 px-8 py-4 bg-charcoal text-bone text-sm font-medium tracking-wide uppercase transition-base hover:bg-saddle"
            >
              build my page — 5 minutes →
            </a>
          )}
        </div>

        {success.wizardUrl && (
          <div className="border border-dust bg-bone p-6 space-y-4">
            <div>
              <p className="text-xs uppercase tracking-wider text-saddle font-semibold mb-2">
                or, if you&apos;d rather talk first
              </p>
              <h3 className="font-serif text-xl text-charcoal mb-2">
                15-min call with Ben — totally optional
              </h3>
              <p className="text-sm text-saddle leading-relaxed">
                questions about pricing, processing, how buyers reach you —
                grab a slot and we&apos;ll walk it together. your page link
                stays live either way.
              </p>
            </div>
            {calEmbed ? (
              <div
                className="relative w-full overflow-hidden border border-dust"
                style={{ paddingBottom: '85%' }}
              >
                <iframe
                  src={calEmbed}
                  title="Book discovery call with Ben"
                  className="absolute inset-0 w-full h-full"
                  frameBorder={0}
                />
              </div>
            ) : (
              <a
                href="/book?purpose=rancher"
                className="inline-flex items-center gap-2 px-7 py-3.5 bg-charcoal text-bone text-sm font-medium tracking-wide uppercase transition-base hover:bg-divider"
              >
                Book the 15-min call →
              </a>
            )}
            <p className="text-xs text-saddle italic">
              After booking, your wizard link stays available — we'll
              email it again with the calendar invite. Or skip the call
              and use the CTA above.
            </p>
          </div>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6 max-w-2xl">
      {/* Honeypot — hidden field, real users don't see it */}
      <input
        type="text"
        name="fax"
        value={form.fax}
        onChange={(e) => setField('fax', e.target.value)}
        tabIndex={-1}
        autoComplete="off"
        style={{ position: 'absolute', left: '-9999px', width: '1px', height: '1px' }}
        aria-hidden="true"
      />

      {/* Contact basics */}
      <div className="bg-bone border border-dust p-5 sm:p-6 space-y-4">
        <p className="text-xs uppercase tracking-wider text-saddle font-semibold">
          Contact
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-charcoal mb-1.5">
              Your name *
            </label>
            <input
              type="text"
              required
              value={form.operatorName}
              onChange={(e) => setField('operatorName', e.target.value)}
              placeholder="Jane Doe"
              className="w-full px-3 py-2.5 border border-dust bg-bone-warm text-charcoal focus:outline-none focus:border-charcoal"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-charcoal mb-1.5">
              Ranch name *
            </label>
            <input
              type="text"
              required
              value={form.ranchName}
              onChange={(e) => setField('ranchName', e.target.value)}
              placeholder="Doe Ranch"
              className="w-full px-3 py-2.5 border border-dust bg-bone-warm text-charcoal focus:outline-none focus:border-charcoal"
            />
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-charcoal mb-1.5">
              Email *
            </label>
            <input
              type="email"
              required
              value={form.email}
              onChange={(e) => setField('email', e.target.value)}
              placeholder="you@yourranch.com"
              className="w-full px-3 py-2.5 border border-dust bg-bone-warm text-charcoal focus:outline-none focus:border-charcoal"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-charcoal mb-1.5">
              Phone
            </label>
            <input
              type="tel"
              required
              value={form.phone}
              onChange={(e) => setField('phone', formatPhone(e.target.value))}
              placeholder="(555) 555-5555"
              className="w-full px-3 py-2.5 border border-dust bg-bone-warm text-charcoal focus:outline-none focus:border-charcoal"
            />
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-6 gap-4">
          <div className="sm:col-span-4">
            <label className="block text-sm font-medium text-charcoal mb-1.5">
              City
            </label>
            <input
              type="text"
              value={form.city}
              onChange={(e) => setField('city', e.target.value)}
              placeholder="Bozeman"
              className="w-full px-3 py-2.5 border border-dust bg-bone-warm text-charcoal focus:outline-none focus:border-charcoal"
            />
          </div>
          <div className="sm:col-span-2">
            <label className="block text-sm font-medium text-charcoal mb-1.5">
              State *
            </label>
            <select
              required
              value={form.state}
              onChange={(e) => setField('state', e.target.value)}
              className="w-full px-3 py-2.5 border border-dust bg-bone-warm text-charcoal focus:outline-none focus:border-charcoal"
            >
              <option value="">—</option>
              {STATES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Fit-check + extras — OPTIONAL (stupid-simple signup 2026-07-08).
          Four fields get a rancher in; everything below just helps Ben route
          buyers faster. Collapsed by default so the form reads as one card. */}
      <details className="group border border-dust bg-bone">
        <summary className="cursor-pointer list-none p-5 sm:p-6 flex items-center justify-between gap-3">
          <span>
            <span className="block text-sm font-medium text-charcoal">
              optional: 30 more seconds → buyers routed faster
            </span>
            <span className="block text-xs text-saddle mt-0.5">
              volume, what you need most, how you sell today — skip it if you're in a hurry.
            </span>
          </span>
          <span className="text-saddle text-lg leading-none group-open:rotate-45 transition-transform">+</span>
        </summary>
        <div className="px-0 pb-0 space-y-4">
      {/* Fit-check questions */}
      <div className="bg-bone border border-dust p-5 sm:p-6 space-y-5">
        <p className="text-xs uppercase tracking-wider text-saddle font-semibold">
          Fit check
        </p>

        <div>
          <p className="text-sm font-medium text-charcoal mb-2">
            How many head do you sell D2C per year?
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {(['<5', '5-25', '25-100', '100+'] as VolumeBand[]).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setField('headPerYear', v)}
                className={`px-3 py-2.5 text-sm font-medium border transition-base ${
                  form.headPerYear === v
                    ? 'bg-charcoal text-bone border-charcoal'
                    : 'bg-bone-warm text-charcoal border-dust hover:border-saddle'
                }`}
              >
                {v} head
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="text-sm font-medium text-charcoal mb-2">
            Biggest constraint right now?
          </p>
          <div className="space-y-2">
            {(
              [
                ['more_buyers', 'Finding more buyers'],
                ['better_pricing', 'Better pricing / margins'],
                ['easier_logistics', 'Easier logistics & fulfillment'],
                ['brand_visibility', 'Brand visibility'],
                ['all_above', 'All of the above'],
              ] as [Constraint, string][]
            ).map(([val, label]) => (
              <label
                key={val}
                className="flex items-center gap-2.5 cursor-pointer text-sm text-charcoal"
              >
                <input
                  type="radio"
                  name="constraint"
                  checked={form.constraint === val}
                  onChange={() => setField('constraint', val)}
                  className="cursor-pointer"
                />
                {label}
              </label>
            ))}
          </div>
        </div>

        <div>
          <p className="text-sm font-medium text-charcoal mb-2">
            What's working for you today? (pick all that apply)
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {(
              [
                ['word_of_mouth', 'Word of mouth'],
                ['social', 'Facebook / Instagram'],
                ['own_website', 'Your own website'],
                ['farmers_markets', 'Farmers markets'],
                ['wholesale', 'Wholesale to restaurants/butchers'],
                ['none', "None — just starting"],
              ] as [Channel, string][]
            ).map(([val, label]) => (
              <label
                key={val}
                className="flex items-center gap-2.5 cursor-pointer text-sm text-charcoal"
              >
                <input
                  type="checkbox"
                  checked={form.channels.includes(val)}
                  onChange={() => toggleChannel(val)}
                  className="cursor-pointer"
                />
                {label}
              </label>
            ))}
          </div>
        </div>

        <div>
          <p className="text-sm font-medium text-charcoal mb-2">
            Currently accept buyer deposits online (Stripe, Shopify, etc)?
          </p>
          <div className="flex gap-3">
            {(['yes', 'no'] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setField('acceptsDeposits', v)}
                className={`px-5 py-2 text-sm font-medium uppercase tracking-wide border transition-base ${
                  form.acceptsDeposits === v
                    ? 'bg-charcoal text-bone border-charcoal'
                    : 'bg-bone-warm text-charcoal border-dust hover:border-saddle'
                }`}
              >
                {v === 'yes' ? 'Yes' : 'No'}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-charcoal mb-1.5">
            Website (optional)
          </label>
          <input
            type="url"
            value={form.website}
            onChange={(e) => setField('website', e.target.value)}
            placeholder="https://yourranch.com"
            className="w-full px-3 py-2.5 border border-dust bg-bone-warm text-charcoal focus:outline-none focus:border-charcoal"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-charcoal mb-1.5">
            Anything else we should know? (optional)
          </label>
          <textarea
            value={form.notes}
            onChange={(e) => setField('notes', e.target.value)}
            rows={3}
            placeholder="What you raise, processing setup, who you sell to today, etc."
            className="w-full px-3 py-2.5 border border-dust bg-bone-warm text-charcoal focus:outline-none focus:border-charcoal"
          />
        </div>
      </div>

        </div>
      </details>

      {/* Error renders OUTSIDE the optional <details>, next to Submit
          (2026-07-08). It used to live inside the collapsed accordion, so a
          fetch failure (429/500) was invisible unless the rancher happened to
          have opened "optional: 30 more seconds". */}
      {error && (
        <div className="p-3 border border-weathered text-weathered text-sm">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-7 py-3.5 bg-charcoal text-bone text-sm font-medium tracking-wide uppercase transition-base hover:bg-divider disabled:opacity-50"
      >
        {submitting ? 'Sending…' : 'Submit application →'}
      </button>
    </form>
  );
}
