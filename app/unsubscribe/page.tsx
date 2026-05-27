'use client';

import { useSearchParams } from 'next/navigation';
import { useState, Suspense } from 'react';
import Container from '@/app/components/Container';

function UnsubscribeContent() {
  const searchParams = useSearchParams();
  const success = searchParams.get('success') === 'true';
  const emailParam = searchParams.get('email') || '';
  const [email, setEmail] = useState(emailParam);
  const [submitted, setSubmitted] = useState(success);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/unsubscribe?email=${encodeURIComponent(email)}`, {
        method: 'POST',
      });
      if (res.ok) {
        setSubmitted(true);
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
          {submitted ? (
            <>
              <h1 className="font-serif text-2xl mb-3 text-charcoal">
                You&apos;ve been unsubscribed
              </h1>
              <p className="text-saddle leading-relaxed mb-6">
                We&apos;ve removed <strong>{email}</strong> from our mailing list.
                You won&apos;t receive any more emails from us.
              </p>
              <p className="text-dust text-sm">
                Changed your mind? Email{' '}
                <a href="mailto:support@buyhalfcow.com" className="text-saddle hover:underline transition-base">
                  support@buyhalfcow.com
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
                Enter your email to unsubscribe from BuyHalfCow emails.
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
