'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Container from './Container';

interface MemberSession {
  id: string;
  name: string;
  email: string;
  state: string;
}

export default function MemberAuthGuard({
  children,
}: {
  children: (member: MemberSession) => React.ReactNode;
}) {
  const [member, setMember] = useState<MemberSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    checkSession();
  }, []);

  const checkSession = async () => {
    try {
      const response = await fetch('/api/auth/member/session');
      if (response.ok) {
        const data = await response.json();
        if (data.authenticated && data.member) {
          setMember(data.member);
        } else {
          router.push('/member/login');
        }
      } else {
        router.push('/member/login');
      }
    } catch {
      router.push('/member/login');
    } finally {
      setIsLoading(false);
    }
  };

  if (isLoading) {
    return (
      <main className="min-h-screen py-24 bg-bone-white text-charcoal-black flex items-center justify-center">
        <Container>
          <div className="text-center">
            <div className="inline-block w-8 h-8 border-4 border-charcoal-black border-t-transparent rounded-full animate-spin" />
            <p className="mt-4 text-saddle-brown">Loading your dashboard...</p>
          </div>
        </Container>
      </main>
    );
  }

  if (!member) return null;

  return <>{children(member)}</>;
}
