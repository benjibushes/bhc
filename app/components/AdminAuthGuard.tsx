'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Container from './Container';

export default function AdminAuthGuard({ children }: { children: React.ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    checkAuth();
  }, []);

  const checkAuth = async () => {
    try {
      const response = await fetch('/api/admin/auth');
      if (response.ok) {
        setIsAuthenticated(true);
      } else {
        router.push('/admin/login');
      }
    } catch (error) {
      console.error('Auth check failed:', error);
      router.push('/admin/login');
    } finally {
      setIsLoading(false);
    }
  };

  if (isLoading) {
    return (
      <main className="min-h-screen py-24 bg-[#F4F1EC] text-[#0E0E0E] flex items-center justify-center">
        <Container>
          <div className="text-center">
            <div className="inline-block w-8 h-8 border-4 border-[#0E0E0E] border-t-transparent rounded-full animate-spin"></div>
            <p className="mt-4 text-[#6B4F3F]">Checking authentication...</p>
          </div>
        </Container>
      </main>
    );
  }

  if (!isAuthenticated) {
    return null; // Router will redirect
  }

  return <>{children}</>;
}



