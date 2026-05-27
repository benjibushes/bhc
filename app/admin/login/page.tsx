'use client';

// Admin login — plain password form.
//
// POSTs to /api/admin/auth which sets the bhc-admin cookie after
// constant-time compare against ADMIN_PASSWORD env. Server-to-server
// callers (Telegram bot, cron, ops) still authenticate with the
// x-admin-password HTTP header — see lib/adminAuth.ts.
//
// Clerk was wired in via Auth Phase 0 (2026-05-26) but pulled out
// 2026-05-26 after a domain reservation conflict on Clerk's platform
// blocked production activation. Clerk wrappers in lib/adminAuth.ts +
// lib/buyerAuth.ts + lib/rancherAuth.ts remain as dead code behind
// CLERK_*_ENABLED flags (all default false), no runtime cost. Revisit
// auth upgrade (TOTP via otplib or Auth.js v5) in a future sprint.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Container from '../../components/Container';
import Input from '../../components/Input';
import Button from '../../components/Button';

export default function AdminLoginPage() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();

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
        router.push('/admin');
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
    <main className="min-h-screen py-24 bg-[#F4F1EC] text-[#0E0E0E] flex items-center justify-center">
      <Container>
        <div className="max-w-md mx-auto">
          <div className="text-center space-y-6 mb-12">
            <h1 className="font-[family-name:var(--font-serif)] text-4xl">
              Admin Login
            </h1>
            <p className="text-[#6B4F3F]">
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
              <div className="p-4 border border-[#8C2F2F] bg-transparent text-[#8C2F2F] text-sm">
                {error}
              </div>
            )}

            <Button type="submit" disabled={isLoading}>
              {isLoading ? 'Checking...' : 'Login'}
            </Button>
          </form>

          <div className="mt-12 text-center">
            <a href="/" className="text-[#6B4F3F] hover:text-[#0E0E0E] transition-colors text-sm">
              ← Back to home
            </a>
          </div>
        </div>
      </Container>
    </main>
  );
}
