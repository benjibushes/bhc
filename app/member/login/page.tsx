'use client';

import { useState } from 'react';
import Container from '../../components/Container';
import Divider from '../../components/Divider';
import Link from 'next/link';

export default function MemberLoginPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSending(true);

    try {
      const response = await fetch('/api/auth/member/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Something went wrong');
      }

      setSent(true);
    } catch (err: any) {
      setError(err.message || 'Something went wrong. Please try again.');
    } finally {
      setSending(false);
    }
  };

  if (sent) {
    return (
      <main className="min-h-screen py-24 bg-bone-white text-charcoal-black flex items-center justify-center">
        <Container>
          <div className="max-w-md mx-auto text-center space-y-6">
            <h1 className="font-serif text-4xl">Check Your Email</h1>
            <Divider />
            <p className="text-lg text-saddle-brown leading-relaxed">
              If you have an approved account, you&apos;ll receive a login link at <strong className="text-charcoal-black">{email}</strong>.
            </p>
            <p className="text-sm text-dust-gray">
              The link expires in 1 hour. Check spam if you don&apos;t see it.
            </p>
            <div className="pt-6">
              <button
                onClick={() => { setSent(false); setEmail(''); }}
                className="text-saddle-brown hover:text-charcoal-black transition-colors text-sm"
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
    <main className="min-h-screen py-24 bg-bone-white text-charcoal-black flex items-center justify-center">
      <Container>
        <div className="max-w-md mx-auto">
          <div className="text-center space-y-6 mb-12">
            <h1 className="font-serif text-4xl">Member Login</h1>
            <Divider />
            <p className="text-saddle-brown">
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
                placeholder="your@email.com"
                required
                className="w-full px-4 py-3 border border-dust-gray bg-bone-white text-charcoal-black focus:outline-none focus:border-charcoal-black transition-colors"
              />
            </div>

            {error && (
              <div className="p-4 border border-weathered-red text-weathered-red text-sm">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={sending}
              className="w-full px-6 py-4 bg-charcoal-black text-bone-white hover:bg-saddle-brown transition-colors duration-300 font-medium tracking-wider uppercase disabled:opacity-50"
            >
              {sending ? 'Sending...' : 'Send Login Link'}
            </button>
          </form>

          <div className="mt-8 text-center space-y-3">
            <p className="text-sm text-dust-gray">
              Don&apos;t have an account?
            </p>
            <Link
              href="/access"
              className="inline-block text-charcoal-black hover:text-saddle-brown transition-colors text-sm font-medium"
            >
              Apply for Access →
            </Link>
          </div>

          <div className="mt-12 text-center">
            <Link href="/" className="text-saddle-brown hover:text-charcoal-black transition-colors text-sm">
              ← Back to home
            </Link>
          </div>
        </div>
      </Container>
    </main>
  );
}
