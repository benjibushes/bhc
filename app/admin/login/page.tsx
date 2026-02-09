'use client';

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
    } catch (err) {
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


