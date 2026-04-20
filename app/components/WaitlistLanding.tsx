'use client';

import { useState } from 'react';
import Image from 'next/image';
import Container from './Container';
import Divider from './Divider';

// Minimal-friction waitlist capture. Renders on / when MAINTENANCE_MODE=true.
// Captures email + optional name/state/interest into Airtable via /api/waitlist.
// Zero downstream processing — the records sit tagged with Source='relaunch_waitlist'
// until we're ready to relaunch, then get processed in a single clean batch.
export default function WaitlistLanding() {
  const [form, setForm] = useState({
    email: '',
    fullName: '',
    state: '',
    interest: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!form.email.trim()) {
      setError('Email is required.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: form.email.trim(),
          fullName: form.fullName.trim(),
          state: form.state.trim(),
          interest: form.interest.trim(),
          referrer: typeof document !== 'undefined' ? document.referrer : '',
        }),
      });
      const data = await res.json();
      if (res.ok && data.ok !== false) {
        setSent(true);
      } else {
        setError(data.error || 'Something went wrong. Try again in a minute.');
      }
    } catch {
      setError('Network error. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen bg-bone text-charcoal flex items-center justify-center py-16">
      <Container>
        <div className="max-w-xl mx-auto text-center space-y-8">
          {/* Logo */}
          <div className="flex justify-center">
            <Image
              src="/bhc-logo.png"
              alt="BuyHalfCow"
              width={72}
              height={72}
              className="object-contain"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
          </div>

          <div className="space-y-3">
            <p className="text-xs uppercase tracking-widest text-saddle">BuyHalfCow · Upgrading the platform</p>
            <h1 className="font-serif text-4xl md:text-5xl leading-tight">
              We&apos;re rebuilding something better.
            </h1>
            <p className="text-saddle text-lg leading-relaxed">
              The private network for sourcing ranch beef direct is being rebuilt from the ground up. Drop your email and we&apos;ll invite you back the moment we re-open.
            </p>
          </div>

          <Divider />

          {sent ? (
            <div className="space-y-4">
              <div className="text-5xl">&#10003;</div>
              <h2 className="font-serif text-2xl">You&apos;re on the list.</h2>
              <p className="text-saddle">
                We&apos;ll email <strong className="text-charcoal">{form.email}</strong> as soon as doors open. No spam in the meantime.
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4 text-left">
              <div>
                <label htmlFor="wl-email" className="block text-sm font-medium mb-1">
                  Email <span className="text-[#8C2F2F]">*</span>
                </label>
                <input
                  id="wl-email"
                  type="email"
                  required
                  value={form.email}
                  onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                  placeholder="you@example.com"
                  className="w-full px-4 py-3 border border-dust bg-white focus:outline-none focus:border-charcoal"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="wl-name" className="block text-sm font-medium mb-1">
                    Name <span className="text-dust text-xs">(optional)</span>
                  </label>
                  <input
                    id="wl-name"
                    type="text"
                    value={form.fullName}
                    onChange={(e) => setForm((f) => ({ ...f, fullName: e.target.value }))}
                    placeholder="First Last"
                    className="w-full px-4 py-3 border border-dust bg-white focus:outline-none focus:border-charcoal"
                  />
                </div>
                <div>
                  <label htmlFor="wl-state" className="block text-sm font-medium mb-1">
                    State <span className="text-dust text-xs">(optional, 2-letter)</span>
                  </label>
                  <input
                    id="wl-state"
                    type="text"
                    maxLength={2}
                    value={form.state}
                    onChange={(e) => setForm((f) => ({ ...f, state: e.target.value.toUpperCase() }))}
                    placeholder="MT"
                    className="w-full px-4 py-3 border border-dust bg-white focus:outline-none focus:border-charcoal font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">
                  What brought you here? <span className="text-dust text-xs">(optional)</span>
                </label>
                <div className="flex flex-wrap gap-2">
                  {(['Beef Buyer', 'Rancher', 'Land Seller', 'Brand Partner', 'Just Looking'] as const).map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => setForm((f) => ({ ...f, interest: f.interest === opt ? '' : opt }))}
                      className={`px-3 py-2 text-xs uppercase tracking-wider transition-colors ${
                        form.interest === opt
                          ? 'bg-charcoal text-bone border border-charcoal'
                          : 'border border-dust hover:border-charcoal bg-white'
                      }`}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              </div>

              {error && (
                <div className="p-3 border border-[#8C2F2F] text-[#8C2F2F] text-sm">{error}</div>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="w-full px-6 py-4 bg-charcoal text-bone hover:bg-saddle transition-colors font-semibold uppercase tracking-wider text-sm disabled:opacity-50"
              >
                {submitting ? 'Saving your spot...' : 'Get Early Access'}
              </button>

              <p className="text-xs text-dust text-center pt-2">
                No commitments. Unsubscribe anytime. We never sell your info.
              </p>
            </form>
          )}

          <Divider />

          <div className="text-xs text-dust space-y-1">
            <p>Already a member?{' '}
              <a href="/member/login" className="text-charcoal hover:text-saddle underline underline-offset-2">
                Member login
              </a>
              {' · '}
              <a href="/rancher/login" className="text-charcoal hover:text-saddle underline underline-offset-2">
                Rancher login
              </a>
            </p>
            <p>Questions? Email <a href="mailto:hello@buyhalfcow.com" className="text-charcoal hover:text-saddle">hello@buyhalfcow.com</a></p>
          </div>
        </div>
      </Container>
    </main>
  );
}
