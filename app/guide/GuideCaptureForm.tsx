'use client';

// Guide capture form — email required, phone + SMS opt-in optional (explicit
// consent language; consent only ever flips false→true server-side). Honeypot
// field ('website') screens bots. Posts to /api/guide/signup which upserts the
// Consumer and emails the full guide.

import { useState } from 'react';
import Button from '../components/Button';

export default function GuideCaptureForm() {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [smsOptIn, setSmsOptIn] = useState(false);
  const [website, setWebsite] = useState(''); // honeypot
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/guide/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, fullName, phone, smsOptIn, website }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'something went wrong — try again');
      setDone(true);
    } catch (err: any) {
      setError(err?.message || 'something went wrong — try again');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="border-2 border-sage bg-bone-warm p-6 text-center space-y-3">
        <p className="text-xs uppercase tracking-widest text-sage font-semibold">
          it&rsquo;s on the way
        </p>
        <p className="text-[15px] text-charcoal m-0">
          the full guide just left for your inbox. while you&rsquo;re here — the same ranches
          ship smaller boxes nationwide.
        </p>
        <div className="flex gap-2 justify-center flex-wrap pt-1">
          <Button href="/shop" size="md">shop the ranches &rarr;</Button>
          <Button href="/access" variant="secondary" size="md">take the quiz</Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="border border-dust bg-bone-warm p-6 space-y-4">
      <div>
        <h2 className="font-serif text-xl m-0">get the full guide</h2>
        <p className="text-[13.5px] text-saddle mt-1 mb-0">
          the complete breakdown — cut list, freezer math, deposit walkthrough — plus first
          word when a ranch opens up near you.
        </p>
      </div>
      {/* Honeypot — visually hidden, tab-skipped; bots fill it, humans never see it. */}
      <input
        type="text"
        value={website}
        onChange={(e) => setWebsite(e.target.value)}
        name="website"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="absolute opacity-0 h-0 w-0 pointer-events-none"
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="block text-xs uppercase tracking-wider text-saddle mb-1.5">name</span>
          <input
            type="text"
            value={fullName}
            maxLength={100}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="First Last"
            className="w-full p-3 border border-dust bg-bone text-[15px]"
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-wider text-saddle mb-1.5">
            email (required)
          </span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@email.com"
            className="w-full p-3 border border-dust bg-bone text-[15px]"
          />
        </label>
      </div>
      <label className="block">
        <span className="block text-xs uppercase tracking-wider text-saddle mb-1.5">
          phone (optional)
        </span>
        <input
          type="tel"
          value={phone}
          maxLength={30}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="(555) 555-5555"
          className="w-full p-3 border border-dust bg-bone text-[15px]"
        />
      </label>
      {phone.trim() !== '' && (
        <label className="flex items-start gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={smsOptIn}
            onChange={(e) => setSmsOptIn(e.target.checked)}
            className="mt-1"
          />
          <span className="text-[12.5px] text-saddle leading-relaxed">
            text me when a ranch opens up near me (occasional messages from BuyHalfCow —
            reply STOP anytime; msg &amp; data rates may apply)
          </span>
        </label>
      )}
      {error && <p className="text-weathered text-sm m-0">{error}</p>}
      <Button type="submit" size="lg" fullWidth loading={busy} disabled={busy}>
        {busy ? 'sending…' : 'send me the guide →'}
      </Button>
      <p className="text-[11.5px] text-saddle m-0 text-center">
        no spam — the guide, then only what you asked for. unsubscribe anytime.
      </p>
    </form>
  );
}
