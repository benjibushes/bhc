'use client';

import { useState } from 'react';
import Container from '../../components/Container';
import Divider from '../../components/Divider';
import Link from 'next/link';

export default function AffiliateLoginPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSending(true);

    try {
      const response = await fetch('/api/auth/affiliate/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Something went wrong');
      }

      setSent(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setSending(false);
    }
  };

  if (sent) {
    return (
      <main className="min-h-screen py-24 bg-[#F4F1EC] text-[#0E0E0E] flex items-center justify-center">
        <Container>
          <div className="max-w-md mx-auto text-center space-y-6">
            <h1 className="font-serif text-4xl">Check Your Email</h1>
            <Divider />
            <p className="text-lg text-[#6B4F3F] leading-relaxed">
              If you&apos;re a registered affiliate, you&apos;ll receive a login link at <strong className="text-[#0E0E0E]">{email}</strong>.
            </p>
            <p className="text-sm text-[#A7A29A]">
              The link expires in 24 hours. Check spam if you don&apos;t see it.
            </p>
            <div className="pt-6">
              <button
                onClick={() => { setSent(false); setEmail(''); }}
                className="text-[#6B4F3F] hover:text-[#0E0E0E] transition-colors text-sm"
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
    <main className="min-h-screen py-24 bg-[#F4F1EC] text-[#0E0E0E] flex items-center justify-center">
      <Container>
        <div className="max-w-md mx-auto">
          <div className="text-center space-y-6 mb-12">
            <h1 className="font-serif text-4xl">Affiliate Login</h1>
            <Divider />
            <p className="text-[#6B4F3F]">
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
                className="w-full px-4 py-3 border border-[#A7A29A] bg-white text-[#0E0E0E] focus:outline-none focus:border-[#0E0E0E] transition-colors"
              />
            </div>

            {error && (
              <div className="p-4 border border-[#8C2F2F] text-[#8C2F2F] text-sm">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={sending}
              className="w-full px-6 py-4 bg-[#0E0E0E] text-[#F4F1EC] hover:bg-[#2A2A2A] transition-colors duration-300 font-medium tracking-wider uppercase disabled:opacity-50"
            >
              {sending ? 'Sending...' : 'Send Login Link'}
            </button>
          </form>

          <div className="mt-12 text-center">
            <Link href="/" className="text-[#6B4F3F] hover:text-[#0E0E0E] transition-colors text-sm">
              ← Back to home
            </Link>
          </div>
        </div>
      </Container>
    </main>
  );
}
