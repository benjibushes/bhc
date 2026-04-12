'use client';

import { useState } from 'react';
import Container from '../../components/Container';
import Divider from '../../components/Divider';
import Link from 'next/link';

export default function RancherLoginPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSending(true);

    try {
      const response = await fetch('/api/auth/rancher/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Something went wrong');
      setSent(true);
    } catch (err: any) {
      setError(err.message || 'Something went wrong. Please try again.');
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
              If you have a registered rancher account, you&apos;ll receive a login link at <strong className="text-charcoal">{email}</strong>.
            </p>
            <p className="text-sm text-dust">
              The link expires in 1 hour. Check spam if you don&apos;t see it.
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
            <h1 className="font-serif text-4xl">Rancher Dashboard</h1>
            <Divider />
            <p className="text-saddle">
              Enter your email to receive a login link. No password needed.
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
                placeholder="your@ranch-email.com"
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
            <p className="text-sm text-dust">Not a registered rancher?</p>
            <Link href="/partner" className="inline-block text-charcoal hover:text-saddle transition-colors text-sm font-medium">
              Apply to Join the Network →
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
