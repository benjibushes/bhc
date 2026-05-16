'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Container from '../../components/Container';
import Link from 'next/link';

function VerifyContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [status, setStatus] = useState<'verifying' | 'success' | 'error'>('verifying');
  const [error, setError] = useState('');

  // Depend on serialized string — useSearchParams() returns a fresh object
  // each render, which hammered verifyToken with duplicate fetches.
  const searchParamsString = searchParams.toString();
  useEffect(() => {
    const token = searchParams.get('token');
    if (!token) {
      setStatus('error');
      setError('No login token found. Please request a new login link.');
      return;
    }
    verifyToken(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParamsString]);

  const verifyToken = async (token: string) => {
    try {
      const response = await fetch('/api/auth/rancher/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Verification failed');

      setStatus('success');
      setTimeout(() => router.push('/rancher'), 1500);
    } catch (err: any) {
      // Dead-end recovery: when a token is expired/invalid, peek at the
      // payload (without verification — it's untrusted, used only to
      // prefill the email on the login page) and bounce the rancher to
      // /rancher/login?relogin=1&email=<x>. Two clicks back in instead of
      // them giving up at a generic error page.
      let prefillEmail = '';
      try {
        const parts = token.split('.');
        if (parts.length === 3) {
          const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
          const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
          const payload = JSON.parse(atob(padded));
          if (payload?.email && typeof payload.email === 'string') {
            prefillEmail = payload.email;
          }
        }
      } catch {}
      if (prefillEmail) {
        // Brief flash before redirect so user sees what happened.
        setStatus('error');
        setError('Link expired. Sending you back to request a fresh one…');
        setTimeout(() => {
          router.push(`/rancher/login?relogin=1&email=${encodeURIComponent(prefillEmail)}`);
        }, 1500);
      } else {
        setStatus('error');
        setError(err.message || 'Something went wrong. Please request a new login link.');
      }
    }
  };

  return (
    <main className="min-h-screen py-24 bg-bone text-charcoal flex items-center justify-center">
      <Container>
        <div className="max-w-md mx-auto text-center space-y-6">
          {status === 'verifying' && (
            <>
              <div className="inline-block w-8 h-8 border-4 border-charcoal border-t-transparent rounded-full animate-spin" />
              <h1 className="font-serif text-3xl">Logging you in...</h1>
            </>
          )}
          {status === 'success' && (
            <>
              <div className="text-5xl">&#10003;</div>
              <h1 className="font-serif text-3xl">You&apos;re logged in</h1>
              <p className="text-saddle">Redirecting to your dashboard...</p>
            </>
          )}
          {status === 'error' && (
            <>
              <h1 className="font-serif text-3xl">Login Failed</h1>
              <p className="text-weathered">{error}</p>
              <div className="pt-4">
                <Link href="/rancher/login" className="inline-block px-6 py-3 bg-charcoal text-bone hover:bg-saddle transition-colors font-medium tracking-wider uppercase text-sm">
                  Request New Link
                </Link>
              </div>
            </>
          )}
        </div>
      </Container>
    </main>
  );
}

export default function RancherVerifyPage() {
  return (
    <Suspense fallback={
      <main className="min-h-screen py-24 bg-bone text-charcoal flex items-center justify-center">
        <Container>
          <div className="text-center">
            <div className="inline-block w-8 h-8 border-4 border-charcoal border-t-transparent rounded-full animate-spin" />
          </div>
        </Container>
      </main>
    }>
      <VerifyContent />
    </Suspense>
  );
}
