'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from '@/lib/toast';

interface TodayData {
  counts: {
    pendingApproval: number;
    stalled: number;
    unpaidCommissions: number;
    unpaidTotal: number;
    highIntentWaiting: number;
    underused: number;
    pendingGoLive: number;
    warmupEngaged: number;
  };
  samples: {
    pendingApproval: { id: string; buyer_name: string; buyer_state: string; intent_score: number; suggested_rancher: string }[];
    stalled: { id: string; buyer_name: string; rancher_name: string; days: number }[];
    unpaidCommissions: { id: string; buyer_name: string; rancher_name: string; commission_due: number; closed_at: string }[];
    highIntentWaiting: { id: string; name: string; state: string; intent: number; warmup: string }[];
    pendingGoLive: { id: string; ranch_name: string; operator: string; state: string; status: string }[];
    warmupEngaged: { id: string; name: string; state: string; engaged_at: string }[];
  };
}

export default function TodayPage() {
  const [data, setData] = useState<TodayData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/today');
      const payload = await res.json();
      if (!res.ok) {
        setError(payload.error || `Failed (HTTP ${res.status})`);
        toast.error('Failed to load today dashboard', payload.error);
        return;
      }
      setData(payload);
    } catch (e: any) {
      setError(e?.message || 'Network error');
      toast.error('Network error loading dashboard');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  if (loading) {
    return (
      <div className="p-8">
        <p className="text-sm text-[#6B4F3F]">Loading today's priorities…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8 max-w-xl">
        <div className="p-4 border border-red-300 bg-red-50 text-red-700">
          <p className="font-medium">Failed to load dashboard</p>
          <p className="text-sm mt-1">{error}</p>
          <button onClick={load} className="mt-3 px-3 py-1.5 text-sm bg-red-700 text-white hover:bg-red-800">
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const { counts, samples } = data;

  return (
    <div className="p-6 lg:p-10 space-y-8">
      <header>
        <h1 className="font-[family-name:var(--font-serif)] text-3xl md:text-4xl">Today</h1>
        <p className="text-sm text-[#6B4F3F] mt-1">What needs your attention. Tap any row to jump to the detail.</p>
      </header>

      {/* Top-line numbers */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Metric label="Needs approval" value={counts.pendingApproval} flag={counts.pendingApproval > 0 ? 'amber' : undefined} href="/admin/referrals?filter=Pending%20Approval" />
        <Metric label="Stalled 5+ days" value={counts.stalled} flag={counts.stalled > 5 ? 'red' : counts.stalled > 0 ? 'amber' : undefined} href="/admin/referrals?filter=Intro%20Sent" />
        <Metric label="Unpaid commission" value={`$${counts.unpaidTotal.toLocaleString()}`} sub={`${counts.unpaidCommissions} invoices`} flag={counts.unpaidCommissions > 10 ? 'amber' : undefined} href="/admin/commissions" />
        <Metric label="Warmup engaged" value={counts.warmupEngaged} sub="said YES, not yet matched" flag={counts.warmupEngaged > 0 ? 'green' : undefined} href="/admin/referrals" />
      </div>

      {/* Action groups */}
      <div className="grid gap-6 lg:grid-cols-2">
        <ActionGroup
          title="Needs approval"
          emptyText="No pending referrals. Nice work."
          items={samples.pendingApproval.map((r) => ({
            key: r.id,
            primary: r.buyer_name,
            secondary: `${r.buyer_state} · Intent ${r.intent_score} · → ${r.suggested_rancher || 'no rancher'}`,
            href: `/admin/referrals`,
          }))}
        />

        <ActionGroup
          title="Stalled — Intro sent 5+ days"
          emptyText="No stalled referrals."
          items={samples.stalled.map((r) => ({
            key: r.id,
            primary: `${r.buyer_name} × ${r.rancher_name || 'unknown'}`,
            secondary: `${r.days}d since intro`,
            href: `/admin/referrals`,
            badge: r.days >= 10 ? { text: `${r.days}d`, tone: 'red' as const } : { text: `${r.days}d`, tone: 'amber' as const },
          }))}
        />

        <ActionGroup
          title="Ready to go live"
          emptyText="No ranchers awaiting launch."
          items={samples.pendingGoLive.map((r) => ({
            key: r.id,
            primary: r.ranch_name,
            secondary: `${r.operator} · ${r.state} · ${r.status}`,
            href: `/admin/ranchers/${r.id}`,
          }))}
        />

        <ActionGroup
          title="Unpaid commissions — oldest first"
          emptyText="All commissions paid."
          items={samples.unpaidCommissions.map((r) => ({
            key: r.id,
            primary: `$${Number(r.commission_due).toLocaleString()} — ${r.rancher_name || 'unknown'}`,
            secondary: `${r.buyer_name} · closed ${r.closed_at ? new Date(r.closed_at).toLocaleDateString() : 'unknown'}`,
            href: `/admin/commissions`,
          }))}
        />

        <ActionGroup
          title="High-intent buyers waiting"
          emptyText="No high-intent waiting buyers."
          items={samples.highIntentWaiting.map((c) => ({
            key: c.id,
            primary: c.name,
            secondary: `${c.state} · Intent ${c.intent}${c.warmup ? ` · Warmup: ${c.warmup}` : ''}`,
            href: `/admin/consumers/${c.id}`,
          }))}
        />

        <ActionGroup
          title="Warmup engaged — said YES"
          emptyText="No engaged waitlisted buyers."
          items={samples.warmupEngaged.map((c) => ({
            key: c.id,
            primary: c.name,
            secondary: `${c.state} · engaged ${c.engaged_at ? new Date(c.engaged_at).toLocaleDateString() : ''}`,
            href: `/admin/consumers/${c.id}`,
            badge: { text: 'YES', tone: 'green' as const },
          }))}
        />
      </div>

      <div className="pt-6 text-xs text-[#A7A29A] border-t border-[#A7A29A]">
        Press <kbd className="px-1.5 py-0.5 border border-[#A7A29A] font-mono">⌘K</kbd> to search or jump to any page. Last loaded {new Date().toLocaleTimeString()}.
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  sub,
  flag,
  href,
}: {
  label: string;
  value: string | number;
  sub?: string;
  flag?: 'red' | 'amber' | 'green';
  href: string;
}) {
  const dotColor =
    flag === 'red' ? 'bg-red-500' :
    flag === 'amber' ? 'bg-yellow-500' :
    flag === 'green' ? 'bg-green-500' :
    'bg-gray-300';
  return (
    <Link
      href={href}
      className="block p-4 border border-[#A7A29A] bg-white hover:border-[#0E0E0E] transition-colors"
    >
      <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-[#6B4F3F]">
        <span className={`w-2 h-2 rounded-full ${dotColor}`} />
        {label}
      </div>
      <div className="mt-1 text-3xl font-[family-name:var(--font-serif)]">{value}</div>
      {sub && <div className="text-xs text-[#A7A29A] mt-0.5">{sub}</div>}
    </Link>
  );
}

function ActionGroup({
  title,
  items,
  emptyText,
}: {
  title: string;
  items: { key: string; primary: string; secondary?: string; href: string; badge?: { text: string; tone: 'red' | 'amber' | 'green' | 'gray' } }[];
  emptyText: string;
}) {
  return (
    <section className="border border-[#A7A29A] bg-white">
      <header className="px-4 py-2.5 border-b border-[#A7A29A] flex items-center justify-between">
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="text-xs text-[#A7A29A]">{items.length}</span>
      </header>
      {items.length === 0 ? (
        <p className="px-4 py-6 text-sm text-[#A7A29A] italic">{emptyText}</p>
      ) : (
        <ul className="divide-y divide-[#E5E2DC]">
          {items.map((item) => (
            <li key={item.key}>
              <Link
                href={item.href}
                className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-[#F4F1EC] transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-[#0E0E0E] truncate">{item.primary}</p>
                  {item.secondary && (
                    <p className="text-xs text-[#6B4F3F] truncate mt-0.5">{item.secondary}</p>
                  )}
                </div>
                {item.badge && (
                  <span
                    className={`text-xs px-2 py-0.5 border ${
                      item.badge.tone === 'red' ? 'bg-red-50 border-red-300 text-red-700' :
                      item.badge.tone === 'amber' ? 'bg-yellow-50 border-yellow-300 text-yellow-700' :
                      item.badge.tone === 'green' ? 'bg-green-50 border-green-300 text-green-700' :
                      'bg-gray-50 border-gray-300 text-gray-700'
                    }`}
                  >
                    {item.badge.text}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
