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

  // Bounce to login WITH a resume path (?next=) so the buyer lands back on
  // the exact page they were kicked off of after the magic-link round-trip
  // (login page forwards it → login route embeds it in the emailed link →
  // /member/verify honors it). Previously the path was dropped entirely — a
  // logged-out buyer on a guarded page lost their place forever. Read from
  // window.location (checkSession only ever runs client-side, inside
  // useEffect) instead of useSearchParams, which would force a Suspense
  // boundary onto every page that mounts this guard.
  const redirectToLogin = () => {
    const here = window.location.pathname + window.location.search;
    router.push(`/member/login?next=${encodeURIComponent(here)}`);
  };

  const checkSession = async () => {
    try {
      const response = await fetch('/api/auth/member/session');
      if (response.ok) {
        const data = await response.json();
        if (data.authenticated && data.member) {
          setMember(data.member);
        } else {
          redirectToLogin();
        }
      } else {
        redirectToLogin();
      }
    } catch {
      redirectToLogin();
    } finally {
      setIsLoading(false);
    }
  };

  if (isLoading) {
    return (
      <main className="min-h-screen py-24 bg-bone text-charcoal flex items-center justify-center">
        <Container>
          <div className="text-center">
            <div className="inline-block w-8 h-8 border-4 border-charcoal border-t-transparent rounded-full animate-spin" />
            <p className="mt-4 text-saddle">Loading your dashboard...</p>
          </div>
        </Container>
      </main>
    );
  }

  if (!member) return null;

  return <>{children(member)}</>;
}
