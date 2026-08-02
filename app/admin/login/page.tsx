'use client';

// Admin login — plain password form.
//
// POSTs to /api/admin/auth which sets the bhc-admin cookie after
// constant-time compare against ADMIN_PASSWORD env. Server-to-server
// callers (Telegram bot, cron, ops) still authenticate with the
// x-admin-password HTTP header — see lib/adminAuth.ts.
//
// Wave 1B (2026-08-01): honors a validated `?next=` param. Every guard mints
// one (server pages, the admin layout), but this page previously hardcoded
// router.push('/admin') — so an expired-session Telegram deep-link lost its
// destination at the login wall. Default landing is the /admin/today cockpit,
// not the 2+ MB /admin dashboard.

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Container from '../../components/Container';
import Input from '../../components/Input';
import Button from '../../components/Button';

/**
 * Only ever navigate to a same-origin /admin path. Anything else (absolute
 * URLs, protocol-relative //host, junk) falls back to the cockpit.
 */
function safeNext(raw: string | null): string {
  if (
    raw &&
    raw.startsWith('/admin') &&
    !raw.includes('//') &&
    !/[\r\n\\]/.test(raw)
  ) {
    return raw;
  }
  return '/admin/today';
}

function AdminLoginForm() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      const response = await fetch('/api/admin/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });

      if (response.ok) {
        router.push(safeNext(searchParams.get('next')));
      } else {
        setError('Invalid password. Try again.');
        setIsLoading(false);
      }
    } catch {
      setError('Something went wrong. Please try again.');
      setIsLoading(false);
    }
  };

  return (
    <main className="min-h-screen py-24 bg-bone text-charcoal flex items-center justify-center">
      <Container>
        <div className="max-w-md mx-auto">
          <div className="text-center space-y-6 mb-12">
            <h1 className="font-[family-name:var(--font-serif)] text-4xl">
              Admin Login
            </h1>
            <p className="text-saddle">
              Enter your password to access the admin dashboard
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6">
            <Input
              label="Password"
              name="password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />

            {error && (
              <div className="p-4 border border-weathered bg-transparent text-weathered text-sm">
                {error}
              </div>
            )}

            <Button type="submit" disabled={isLoading}>
              {isLoading ? 'Checking...' : 'Login'}
            </Button>
          </form>

          <div className="mt-12 text-center">
            <a href="/" className="text-saddle hover:text-charcoal transition-colors text-sm">
              ← Back to home
            </a>
          </div>
        </div>
      </Container>
    </main>
  );
}

// useSearchParams requires a Suspense boundary for prerender (Next 15).
export default function AdminLoginPage() {
  return (
    <Suspense fallback={null}>
      <AdminLoginForm />
    </Suspense>
  );
}
