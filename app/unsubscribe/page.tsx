'use client';

import { useSearchParams } from 'next/navigation';
import { useState, Suspense, useEffect } from 'react';
import jwt from 'jsonwebtoken';
import Container from '@/app/components/Container';

function UnsubscribeContent() {
  const searchParams = useSearchParams();
  const success = searchParams.get('success') === 'true';
  const tokenParam = searchParams.get('token') || '';
  const emailParam = searchParams.get('email') || '';

  // Extract email from token if provided
  const [email, setEmail] = useState(emailParam);
  const [emailFromToken, setEmailFromToken] = useState('');
  const [submitted, setSubmitted] = useState(success);
  const [loading, setLoading] = useState(false);
  const [tokenError, setTokenError] = useState('');

  useEffect(() => {
    if (tokenParam) {
      try {
        const decoded = jwt.decode(tokenParam) as any;
        if (decoded?.email) {
          setEmailFromToken(decoded.email);
          setEmail(decoded.email);
        }
      } catch {
        setTokenError('Invalid or expired unsubscribe link');
      }
    }
  }, [tokenParam]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;
    setLoading(true);
    try {
      // Use token if available (preferred), fall back to email
      const unsubUrl = tokenParam
        ? `/api/unsubscribe?token=${encodeURIComponent(tokenParam)}`
        : `/api/unsubscribe?email=${encodeURIComponent(email)}`;
      const res = await fetch(unsubUrl, {
        method: 'POST',
      });
      if (res.ok) {
        setSubmitted(true);
      } else {
        alert('Something went wrong. Please try again or email support@buyhalfcow.com');
      }
    } catch {
      alert('Something went wrong. Please try again or email support@buyhalfcow.com');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-bone px-6 py-12">
      <Container className="w-full max-w-md">
        <div className="bg-bone rounded-lg border border-dust p-10 text-center">
          {tokenError ? (
            <>
              <h1 className="font-serif text-2xl mb-3 text-charcoal">
                Link expired
              </h1>
              <p className="text-saddle leading-relaxed mb-6">
                {tokenError}. You can still unsubscribe by entering your email below.
              </p>
              <form onSubmit={handleSubmit}>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="your@email.com"
                  required
                  className="w-full px-4 py-3 text-base border border-dust rounded-lg mb-4 text-charcoal placeholder-dust bg-bone focus:outline-none focus:ring-2 focus:ring-saddle"
                />
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full px-4 py-3 text-base font-medium bg-saddle text-bone rounded-lg transition-base hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {loading ? 'Unsubscribing...' : 'Unsubscribe'}
                </button>
              </form>
            </>
          ) : submitted ? (
            <>
              <h1 className="font-serif text-2xl mb-3 text-charcoal">
                You&rsquo;re unsubscribed
              </h1>
              <p className="text-saddle leading-relaxed mb-6">
                We won&apos;t email <strong>{email}</strong> again.
              </p>
              <p className="text-saddle text-sm">
                If this was a mistake, reply{' '}
                <a href="mailto:hi@buyhalfcow.com" className="text-charcoal hover:underline transition-base">
                  hi@buyhalfcow.com
                </a>{' '}
                and we&apos;ll add you back.
              </p>
            </>
          ) : (
            <>
              <h1 className="font-serif text-2xl mb-3 text-charcoal">
                Unsubscribe
              </h1>
              <p className="text-saddle leading-relaxed mb-6">
                {emailFromToken
                  ? `We're about to remove ${emailFromToken} from our list.`
                  : 'Enter your email to stop BuyHalfCow emails.'}
              </p>
              <form onSubmit={handleSubmit}>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="your@email.com"
                  required
                  className="w-full px-4 py-3 text-base border border-dust rounded-lg mb-4 text-charcoal placeholder-dust bg-bone focus:outline-none focus:ring-2 focus:ring-saddle"
                />
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full px-4 py-3 text-base font-medium bg-saddle text-bone rounded-lg transition-base hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {loading ? 'Unsubscribing...' : 'Unsubscribe'}
                </button>
              </form>
            </>
          )}
        </div>
      </Container>
    </div>
  );
}

export default function UnsubscribePage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-bone">
        <p className="text-saddle">Loading...</p>
      </div>
    }>
      <UnsubscribeContent />
    </Suspense>
  );
}
