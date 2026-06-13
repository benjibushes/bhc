'use client';

import { useSearchParams } from 'next/navigation';
import { useState, Suspense, useEffect } from 'react';
import jwt from 'jsonwebtoken';
import Container from '@/app/components/Container';

function ResubscribeContent() {
  const searchParams = useSearchParams();
  const tokenParam = searchParams.get('token') || '';

  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [tokenError, setTokenError] = useState('');
  const [submitError, setSubmitError] = useState('');

  useEffect(() => {
    if (!tokenParam) {
      setTokenError('Missing resubscribe link');
      return;
    }
    try {
      const decoded = jwt.decode(tokenParam) as any;
      if (decoded?.email) {
        setEmail(decoded.email);
      } else {
        setTokenError('Invalid resubscribe link');
      }
    } catch {
      setTokenError('Invalid or expired resubscribe link');
    }
  }, [tokenParam]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!tokenParam) return;
    setLoading(true);
    setSubmitError('');
    try {
      const res = await fetch('/api/resubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: tokenParam }),
      });
      if (res.ok) {
        setSubmitted(true);
      } else {
        const body = await res.json().catch(() => ({}));
        setSubmitError(body?.error || 'Could not resubscribe you - the server rejected the request. Email hello@buyhalfcow.com and we will sort it out.');
      }
    } catch {
      setSubmitError('Could not resubscribe you - the server rejected the request. Email hello@buyhalfcow.com and we will sort it out.');
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
                {tokenError}. Email{' '}
                <a href="mailto:hello@buyhalfcow.com" className="text-charcoal hover:underline transition-base">
                  hello@buyhalfcow.com
                </a>{' '}
                and we&apos;ll add you back manually.
              </p>
            </>
          ) : submitted ? (
            <>
              <h1 className="font-serif text-2xl mb-3 text-charcoal">
                You&rsquo;re back on the list
              </h1>
              <p className="text-saddle leading-relaxed mb-6">
                We&apos;ll start emailing <strong>{email}</strong> again.
              </p>
              <p className="text-saddle text-sm">
                Changed your mind? You can unsubscribe any time from the link at the bottom of any email.
              </p>
            </>
          ) : (
            <>
              <h1 className="font-serif text-2xl mb-3 text-charcoal">
                Resubscribe
              </h1>
              <p className="text-saddle leading-relaxed mb-6">
                {email
                  ? `Add ${email} back to the BuyHalfCow list?`
                  : 'Add this email back to the BuyHalfCow list?'}
              </p>
              <form onSubmit={handleSubmit}>
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full px-4 py-3 text-base font-medium bg-saddle text-bone rounded-lg transition-base hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {loading ? 'Resubscribing...' : 'Yes, resubscribe me'}
                </button>
              </form>
              {submitError && (
                <p className="text-sm text-saddle mt-4">{submitError}</p>
              )}
            </>
          )}
        </div>
      </Container>
    </div>
  );
}

export default function ResubscribePage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-bone">
        <p className="text-saddle">Loading...</p>
      </div>
    }>
      <ResubscribeContent />
    </Suspense>
  );
}
