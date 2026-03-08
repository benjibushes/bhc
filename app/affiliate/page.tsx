'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Container from '../components/Container';
import Divider from '../components/Divider';
import Link from 'next/link';

interface DashboardData {
  code: string;
  links: { buyer: string; rancher: string };
  referredConsumersCount: number;
  referredRanchersCount: number;
  referredConsumers: Array<{ id: string; name: string; state: string; created: string }>;
  referredRanchers: Array<{ id: string; name: string; state: string; created: string }>;
}

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text);
}

export default function AffiliateDashboardPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<DashboardData | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/affiliate/dashboard')
      .then((res) => {
        if (res.status === 401 || res.status === 403) {
          router.replace('/affiliate/login');
          return null;
        }
        return res.json();
      })
      .then((json) => {
        if (json) setData(json);
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
        router.replace('/affiliate/login');
      });
  }, [router]);

  const handleCopy = (label: string, text: string) => {
    copyToClipboard(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  };

  const handleLogout = async () => {
    await fetch('/api/auth/affiliate/session', { method: 'DELETE' });
    router.replace('/affiliate/login');
  };

  if (loading) {
    return (
      <main className="min-h-screen py-24 bg-[#F4F1EC] text-[#0E0E0E] flex items-center justify-center">
        <Container>
          <div className="text-center">
            <div className="inline-block w-8 h-8 border-4 border-[#0E0E0E] border-t-transparent rounded-full animate-spin" />
            <p className="mt-4 text-[#6B4F3F]">Loading your dashboard...</p>
          </div>
        </Container>
      </main>
    );
  }

  if (!data) {
    return null;
  }

  return (
    <main className="min-h-screen py-12 bg-[#F4F1EC] text-[#0E0E0E]">
      <Container>
        <div className="flex flex-wrap justify-between items-start gap-4 mb-8">
          <div>
            <h1 className="font-serif text-3xl md:text-4xl">Affiliate Dashboard</h1>
            <p className="text-[#6B4F3F] mt-2">Share your links to refer buyers and ranchers</p>
          </div>
          <div className="flex gap-3">
            <Link
              href="/"
              className="px-4 py-2 border border-[#0E0E0E] hover:bg-[#0E0E0E] hover:text-[#F4F1EC] transition-colors text-sm"
            >
              Visit Site
            </Link>
            <button
              onClick={handleLogout}
              className="px-4 py-2 text-[#6B4F3F] hover:text-[#0E0E0E] transition-colors text-sm"
            >
              Log out
            </button>
          </div>
        </div>

        <Divider />

        <div className="grid gap-8 md:grid-cols-2">
          <div className="p-6 border border-[#A7A29A] bg-white">
            <h2 className="font-serif text-xl mb-4">Your Links</h2>
            <p className="text-sm text-[#6B4F3F] mb-4">Share these links — every signup will be attributed to you.</p>

            <div className="space-y-4">
              <div>
                <label className="block text-xs uppercase tracking-wider text-[#6B4F3F] mb-1">Buyer link</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    readOnly
                    value={data.links.buyer}
                    className="flex-1 px-3 py-2 border border-[#A7A29A] bg-[#F4F1EC] text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => handleCopy('buyer', data.links.buyer)}
                    className="px-4 py-2 bg-[#0E0E0E] text-[#F4F1EC] text-sm hover:bg-[#2A2A2A] transition-colors"
                  >
                    {copied === 'buyer' ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-xs uppercase tracking-wider text-[#6B4F3F] mb-1">Rancher link</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    readOnly
                    value={data.links.rancher}
                    className="flex-1 px-3 py-2 border border-[#A7A29A] bg-[#F4F1EC] text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => handleCopy('rancher', data.links.rancher)}
                    className="px-4 py-2 bg-[#0E0E0E] text-[#F4F1EC] text-sm hover:bg-[#2A2A2A] transition-colors"
                  >
                    {copied === 'rancher' ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="p-6 border border-[#A7A29A] bg-white">
            <h2 className="font-serif text-xl mb-4">Your Referrals</h2>
            <div className="grid grid-cols-2 gap-4">
              <div className="p-4 border border-[#A7A29A] text-center">
                <div className="font-serif text-3xl text-[#0E0E0E]">{data.referredConsumersCount}</div>
                <div className="text-xs text-[#6B4F3F] uppercase tracking-wider mt-1">Buyers referred</div>
              </div>
              <div className="p-4 border border-[#A7A29A] text-center">
                <div className="font-serif text-3xl text-[#0E0E0E]">{data.referredRanchersCount}</div>
                <div className="text-xs text-[#6B4F3F] uppercase tracking-wider mt-1">Ranchers referred</div>
              </div>
            </div>

            {data.referredConsumers.length > 0 && (
              <div className="mt-6">
                <h3 className="text-sm font-medium uppercase tracking-wider text-[#6B4F3F] mb-2">Recent buyers</h3>
                <ul className="space-y-1 text-sm">
                  {data.referredConsumers.slice(0, 5).map((c) => (
                    <li key={c.id} className="flex justify-between">
                      <span>{c.name || 'Unknown'}</span>
                      <span className="text-[#A7A29A]">{c.state}</span>
                    </li>
                  ))}
                  {data.referredConsumers.length > 5 && (
                    <li className="text-[#A7A29A]">+{data.referredConsumers.length - 5} more</li>
                  )}
                </ul>
              </div>
            )}

            {data.referredRanchers.length > 0 && (
              <div className="mt-6">
                <h3 className="text-sm font-medium uppercase tracking-wider text-[#6B4F3F] mb-2">Recent ranchers</h3>
                <ul className="space-y-1 text-sm">
                  {data.referredRanchers.slice(0, 5).map((r) => (
                    <li key={r.id} className="flex justify-between">
                      <span>{r.name || 'Unknown'}</span>
                      <span className="text-[#A7A29A]">{r.state}</span>
                    </li>
                  ))}
                  {data.referredRanchers.length > 5 && (
                    <li className="text-[#A7A29A]">+{data.referredRanchers.length - 5} more</li>
                  )}
                </ul>
              </div>
            )}
          </div>
        </div>

        <div className="mt-8 text-center">
          <Link href="/" className="text-[#6B4F3F] hover:text-[#0E0E0E] transition-colors text-sm">
            ← Back to home
          </Link>
        </div>
      </Container>
    </main>
  );
}
