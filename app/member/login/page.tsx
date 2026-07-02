'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Container from '../../components/Container';
import Divider from '../../components/Divider';
import Link from 'next/link';
import { safeNextPath } from '@/lib/safeNextPath';

export default function MemberLoginPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const router = useRouter();

  // Already-authed buyers skip the form entirely — a member with a live
  // bhc-member-auth cookie who clicks a "My Order" / email link lands straight
  // on their dashboard (or the validated ?next= resume path) instead of being
  // asked to re-request a magic link they don't need. Non-blocking: the form
  // renders immediately and this quietly redirects only on a confirmed session.
  useEffect(() => {
    let alive = true;
    fetch('/api/auth/member/session')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!alive || !data?.authenticated) return;
        const next = new URLSearchParams(window.location.search).get('next');
        router.replace(safeNextPath(next));
      })
      .catch(() => { /* no session — stay on the form */ });
    return () => { alive = false; };
  }, [router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSending(true);

    // Resume path — arrives as ?next=/checkout/<refId>/deposit when the buyer
    // was bounced here mid-checkout (deposit page 401 CTA / MemberAuthGuard).
    // Forwarded in the POST body so the login route can embed it in the magic
    // link; the server validates it (safeNextPath) before it rides the email.
    // Read via window.location at submit time (client event handler — always
    // available) rather than useSearchParams, which would force a Suspense
    // boundary around this whole page for zero benefit.
    const next = new URLSearchParams(window.location.search).get('next');

    try {
      const response = await fetch('/api/auth/member/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          ...(next ? { next } : {}),
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Could not send your login link - the server did not accept the request. Check the email and try again.');
      }

      setSent(true);
    } catch (err: any) {
      setError(err.message || 'Could not send your login link - the server did not respond. Try again in a minute.');
    } finally {
      setSending(false);
    }
  };

  if (sent) {
    return (
      <main className="min-h-screen py-24 bg-bone text-charcoal flex items-center justify-center">
        <Container>
          <div className="max-w-md mx-auto text-center space-y-6">
            <h1 className="font-serif text-4xl">Check Your Email</h1>
            <Divider />
            <p className="text-lg text-saddle leading-relaxed">
              If you have an approved account, you&apos;ll receive a login link at <strong className="text-charcoal">{email}</strong>.
            </p>
            <p className="text-sm text-dust">
              The link works for 7 days. Check spam if you don&apos;t see it.
            </p>
            <div className="pt-6">
              <button
                onClick={() => { setSent(false); setEmail(''); }}
                className="text-saddle hover:text-charcoal transition-colors text-sm"
              >
                Try a different email
              </button>
            </div>
          </div>
        </Container>
      </main>
    );
  }

  return (
    <main className="min-h-screen py-24 bg-bone text-charcoal flex items-center justify-center">
      <Container>
        <div className="max-w-md mx-auto">
          <div className="text-center space-y-6 mb-12">
            <h1 className="font-serif text-4xl">Check Your Order</h1>
            <Divider />
            <p className="text-saddle">
              Member login for buyers — order status, tracking, and your rancher
              thread. We&apos;ll email you a sign-in link. No password needed.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label className="block text-sm font-medium mb-2 uppercase tracking-wider">
                Email Address
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="your@email.com"
                required
                className="w-full px-4 py-3 border border-dust bg-bone text-charcoal focus:outline-none focus:border-charcoal transition-colors"
              />
            </div>

            {error && (
              <div className="p-4 border border-weathered text-weathered text-sm">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={sending}
              className="w-full px-6 py-4 bg-charcoal text-bone hover:bg-saddle transition-colors duration-300 font-medium tracking-wider uppercase disabled:opacity-50"
            >
              {sending ? 'Sending...' : 'Send Login Link'}
            </button>
          </form>

          <div className="mt-8 text-center space-y-3">
            <p className="text-sm text-dust">
              Don&apos;t have an account?
            </p>
            <Link
              href="/access"
              className="inline-block text-charcoal hover:text-saddle transition-colors text-sm font-medium"
            >
              Apply for Access →
            </Link>
          </div>

          <div className="mt-12 text-center">
            <Link href="/" className="text-saddle hover:text-charcoal transition-colors text-sm">
              ← Back to home
            </Link>
          </div>
        </div>
      </Container>
    </main>
  );
}
