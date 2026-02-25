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

  useEffect(() => {
    const token = searchParams.get('token');
    if (!token) {
      setStatus('error');
      setError('No login token found. Please request a new login link.');
      return;
    }
    verifyToken(token);
  }, [searchParams]);

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
      setStatus('error');
      setError(err.message || 'Something went wrong. Please request a new login link.');
    }
  };

  return (
    <main className="min-h-screen py-24 bg-bone-white text-charcoal-black flex items-center justify-center">
      <Container>
        <div className="max-w-md mx-auto text-center space-y-6">
          {status === 'verifying' && (
            <>
              <div className="inline-block w-8 h-8 border-4 border-charcoal-black border-t-transparent rounded-full animate-spin" />
              <h1 className="font-serif text-3xl">Logging you in...</h1>
            </>
          )}
          {status === 'success' && (
            <>
              <div className="text-5xl">&#10003;</div>
              <h1 className="font-serif text-3xl">You&apos;re logged in</h1>
              <p className="text-saddle-brown">Redirecting to your dashboard...</p>
            </>
          )}
          {status === 'error' && (
            <>
              <h1 className="font-serif text-3xl">Login Failed</h1>
              <p className="text-weathered-red">{error}</p>
              <div className="pt-4">
                <Link href="/rancher/login" className="inline-block px-6 py-3 bg-charcoal-black text-bone-white hover:bg-saddle-brown transition-colors font-medium tracking-wider uppercase text-sm">
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
      <main className="min-h-screen py-24 bg-bone-white text-charcoal-black flex items-center justify-center">
        <Container>
          <div className="text-center">
            <div className="inline-block w-8 h-8 border-4 border-charcoal-black border-t-transparent rounded-full animate-spin" />
          </div>
        </Container>
      </main>
    }>
      <VerifyContent />
    </Suspense>
  );
}
