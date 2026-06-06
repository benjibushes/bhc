'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Container from '../components/Container';
import Divider from '../components/Divider';
import Link from 'next/link';

interface DashboardData {
  code: string;
  profile: { fullName: string; email: string };
  links: { landing: string; buyer: string; rancher: string };
  stats?: {
    clicks: number;
    signups: number;
    conversionPct: number;
    closedWonCount: number;
    lastClickAt: string | null;
  };
  referredConsumersCount: number;
  referredRanchersCount: number;
  referredConsumers: Array<{ id: string; name: string; state: string; created: string }>;
  referredRanchers: Array<{ id: string; name: string; state: string; created: string }>;
  recentCloses?: Array<{ id: string; buyer: string; closedAt: string }>;
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
            <p className="text-sm text-[#6B4F3F] mb-4">
              <strong>Share the short link</strong> — the lead picks what they&rsquo;re here for (buyer / rancher / brand / wholesale) and you get credit either way.
            </p>

            <div className="space-y-4">
              <div>
                <label className="block text-xs uppercase tracking-wider text-[#6B4F3F] mb-1">
                  Short link (recommended) <span className="text-[#0E0E0E] normal-case font-medium ml-1">→ self-select picker</span>
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    readOnly
                    value={data.links.landing}
                    className="flex-1 px-3 py-2 border-2 border-[#0E0E0E] bg-[#F4F1EC] text-sm font-medium"
                  />
                  <button
                    type="button"
                    onClick={() => handleCopy('landing', data.links.landing)}
                    className="px-4 py-2 bg-[#0E0E0E] text-[#F4F1EC] text-sm hover:bg-[#2A2A2A] transition-colors"
                  >
                    {copied === 'landing' ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              </div>

              <details className="text-sm">
                <summary className="cursor-pointer text-[#6B4F3F] hover:text-[#0E0E0E]">Direct links to specific funnels</summary>
                <div className="mt-3 space-y-3 pl-2">
                  <div>
                    <label className="block text-xs uppercase tracking-wider text-[#6B4F3F] mb-1">Buyer signup (skip picker)</label>
                    <div className="flex gap-2">
                      <input type="text" readOnly value={data.links.buyer} className="flex-1 px-3 py-2 border border-[#A7A29A] bg-[#F4F1EC] text-xs" />
                      <button type="button" onClick={() => handleCopy('buyer', data.links.buyer)} className="px-3 py-2 bg-[#0E0E0E] text-[#F4F1EC] text-xs hover:bg-[#2A2A2A] transition-colors">
                        {copied === 'buyer' ? 'Copied!' : 'Copy'}
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs uppercase tracking-wider text-[#6B4F3F] mb-1">Rancher / brand / land signup</label>
                    <div className="flex gap-2">
                      <input type="text" readOnly value={data.links.rancher} className="flex-1 px-3 py-2 border border-[#A7A29A] bg-[#F4F1EC] text-xs" />
                      <button type="button" onClick={() => handleCopy('rancher', data.links.rancher)} className="px-3 py-2 bg-[#0E0E0E] text-[#F4F1EC] text-xs hover:bg-[#2A2A2A] transition-colors">
                        {copied === 'rancher' ? 'Copied!' : 'Copy'}
                      </button>
                    </div>
                  </div>
                </div>
              </details>
            </div>

            {/* Profile edit */}
            <ProfileEdit profile={data.profile} code={data.code} />
          </div>

          {data.stats && (
            <div className="p-6 border border-[#A7A29A] bg-white">
              <h2 className="font-serif text-xl mb-4">Performance</h2>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="p-4 border border-[#A7A29A] text-center">
                  <div className="font-serif text-3xl text-[#0E0E0E]">{data.stats.clicks}</div>
                  <div className="text-xs text-[#6B4F3F] uppercase tracking-wider mt-1">Clicks</div>
                </div>
                <div className="p-4 border border-[#A7A29A] text-center">
                  <div className="font-serif text-3xl text-[#0E0E0E]">{data.stats.signups}</div>
                  <div className="text-xs text-[#6B4F3F] uppercase tracking-wider mt-1">Signups</div>
                </div>
                <div className="p-4 border border-[#A7A29A] text-center">
                  <div className="font-serif text-3xl text-[#0E0E0E]">{data.stats.conversionPct}%</div>
                  <div className="text-xs text-[#6B4F3F] uppercase tracking-wider mt-1">Conversion</div>
                </div>
                <div className="p-4 border border-[#A7A29A] text-center">
                  <div className="font-serif text-3xl text-[#0E0E0E]">{data.stats.closedWonCount}</div>
                  <div className="text-xs text-[#6B4F3F] uppercase tracking-wider mt-1">Deals closed</div>
                </div>
              </div>
            </div>
          )}

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

// Inline profile-edit form. Lets affiliate update display name, login email,
// and the URL slug (their `code`). Code uniqueness + reserved-word checks run
// server-side at PATCH; this form surfaces inline errors to the affiliate.
function ProfileEdit({ profile, code }: { profile: { fullName: string; email: string }; code: string }) {
  const [open, setOpen] = useState(false);
  const [fullName, setFullName] = useState(profile.fullName);
  const [email, setEmail] = useState(profile.email);
  const [codeInput, setCodeInput] = useState(code);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [savedMsg, setSavedMsg] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setSavedMsg('');
    try {
      const body: Record<string, string> = {};
      if (fullName.trim() && fullName.trim() !== profile.fullName) body.fullName = fullName.trim();
      if (email.trim() && email.trim().toLowerCase() !== profile.email.toLowerCase()) body.email = email.trim();
      if (codeInput.trim() && codeInput.trim().toLowerCase() !== code.toLowerCase()) body.code = codeInput.trim();
      if (Object.keys(body).length === 0) {
        setSavedMsg('Nothing changed.');
        setSaving(false);
        return;
      }
      const res = await fetch('/api/affiliate/dashboard', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(j?.error || 'Save failed');
        setSaving(false);
        return;
      }
      setSavedMsg('Saved. Reloading...');
      // Reload so the new code propagates into the shareable links + URL.
      setTimeout(() => window.location.reload(), 600);
    } catch {
      setError('Network error');
      setSaving(false);
    }
  }

  return (
    <div className="mt-6 pt-6 border-t border-[#E5E2DC]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-xs uppercase tracking-wider text-[#6B4F3F] hover:text-[#0E0E0E] transition-colors"
      >
        {open ? '− Hide profile settings' : '+ Edit profile settings'}
      </button>

      {open && (
        <form onSubmit={submit} className="mt-4 space-y-3">
          <div>
            <label className="block text-xs uppercase tracking-wider text-[#6B4F3F] mb-1">Display name</label>
            <input
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              required
              minLength={2}
              maxLength={100}
              className="w-full px-3 py-2 border border-[#A7A29A] bg-white text-sm"
            />
          </div>
          <div>
            <label className="block text-xs uppercase tracking-wider text-[#6B4F3F] mb-1">Login email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              maxLength={200}
              className="w-full px-3 py-2 border border-[#A7A29A] bg-white text-sm"
            />
          </div>
          <div>
            <label className="block text-xs uppercase tracking-wider text-[#6B4F3F] mb-1">
              Your code (URL slug) — buyhalfcow.com/r/<strong>{codeInput || code}</strong>
            </label>
            <input
              type="text"
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value.toLowerCase())}
              required
              minLength={3}
              maxLength={32}
              pattern="[a-z0-9_-]+"
              className="w-full px-3 py-2 border border-[#A7A29A] bg-white text-sm font-mono"
            />
            <p className="text-xs text-[#6B4F3F] mt-1">3-32 chars. Letters, numbers, hyphens, underscores. Lowercase only.</p>
          </div>
          {error && <p className="text-sm text-red-700">{error}</p>}
          {savedMsg && <p className="text-sm text-green-700">{savedMsg}</p>}
          <button
            type="submit"
            disabled={saving}
            className="px-5 py-2 bg-[#0E0E0E] text-[#F4F1EC] text-sm hover:bg-[#2A2A2A] transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save profile'}
          </button>
        </form>
      )}
    </div>
  );
}
