'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Container from '../../components/Container';
import Divider from '../../components/Divider';
import Link from 'next/link';

function RancherLoginInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const isRelogin = searchParams.get('relogin') === '1';

  // Two ways in, side by side: a password login (Supabase Auth) and the
  // original "email me a link" magic-link flow. Password is the default; the
  // link flow stays one click away and doubles as "forgot password".
  const [mode, setMode] = useState<'password' | 'link'>('password');
  const [password, setPassword] = useState('');
  const [pwError, setPwError] = useState('');
  const [pwSubmitting, setPwSubmitting] = useState(false);

  const handlePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwError('');
    setPwSubmitting(true);
    try {
      const response = await fetch('/api/auth/rancher/password-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Invalid email or password');
      router.push('/rancher');
    } catch (err: any) {
      setPwError(err.message || 'Invalid email or password');
      setPwSubmitting(false);
    }
  };

  // Prefill email from query (verify dead-end recovery uses this).
  useEffect(() => {
    const e = searchParams.get('email');
    if (e) setEmail(e);
  }, [searchParams]);

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
              The link works for 7 days. Check spam if you don&apos;t see it.
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
            {isRelogin ? (
              <div className="p-4 border border-saddle bg-bone text-saddle text-sm">
                Your last login link expired. Confirm your email below and we&apos;ll send a fresh one.
              </div>
            ) : null}
            <p className="text-saddle">
              {mode === 'password'
                ? 'Log in with your email and password.'
                : 'Enter your email to receive a login link. No password needed.'}
            </p>
          </div>

          {mode === 'password' ? (
            <form onSubmit={handlePasswordLogin} className="space-y-6">
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
                  autoComplete="username"
                  className="w-full px-4 py-3 border border-dust bg-bone text-charcoal focus:outline-none focus:border-charcoal transition-colors"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-2 uppercase tracking-wider">
                  Password
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Your password"
                  required
                  autoComplete="current-password"
                  className="w-full px-4 py-3 border border-dust bg-bone text-charcoal focus:outline-none focus:border-charcoal transition-colors"
                />
              </div>

              {pwError && (
                <div className="p-4 border border-weathered text-weathered text-sm">
                  {pwError}
                </div>
              )}

              <button
                type="submit"
                disabled={pwSubmitting}
                className="w-full px-6 py-4 bg-charcoal text-bone hover:bg-saddle transition-colors duration-300 font-medium tracking-wider uppercase disabled:opacity-50"
              >
                {pwSubmitting ? 'Logging in...' : 'Log In'}
              </button>

              <div className="text-center">
                <button
                  type="button"
                  onClick={() => { setMode('link'); setPwError(''); }}
                  className="text-saddle hover:text-charcoal transition-colors text-sm underline underline-offset-2"
                >
                  Forgot password? Email me a login link instead
                </button>
              </div>
            </form>
          ) : (
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
                  autoComplete="username"
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

              <div className="text-center">
                <button
                  type="button"
                  onClick={() => { setMode('password'); setError(''); }}
                  className="text-saddle hover:text-charcoal transition-colors text-sm underline underline-offset-2"
                >
                  Log in with a password instead
                </button>
              </div>
            </form>
          )}

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

export default function RancherLoginPage() {
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
      <RancherLoginInner />
    </Suspense>
  );
}
