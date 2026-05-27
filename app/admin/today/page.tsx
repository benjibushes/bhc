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
  // P1 fix D-1: per-row action loading so inline buttons don't all flicker
  const [rowLoading, setRowLoading] = useState<string | null>(null);

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

  // Inline action: approve a Pending Approval referral
  const handleApprove = async (referralId: string) => {
    setRowLoading(referralId);
    try {
      const res = await fetch(`/api/referrals/${referralId}/approve`, { method: 'PATCH' });
      const payload = await res.json();
      if (!res.ok || payload?.error) {
        toast.error('Approve failed', payload?.error || `HTTP ${res.status}`);
      } else {
        toast.success('Approved', payload?.message || 'Intro sent');
        await load();
      }
    } catch (e: any) {
      toast.error('Approve failed', e?.message);
    } finally {
      setRowLoading(null);
    }
  };

  // Inline action: flip a rancher to Live + fire warmup blast
  const handleGoLive = async (rancherId: string) => {
    setRowLoading(rancherId);
    try {
      const res = await fetch(`/api/admin/ranchers/${rancherId}/go-live`, { method: 'POST' });
      const payload = await res.json();
      if (!res.ok || payload?.error) {
        toast.error('Go-Live failed', payload?.error || `HTTP ${res.status}`);
      } else {
        toast.success('Rancher live', payload?.matched ? `Auto-matched ${payload.matched} waiting buyers` : undefined);
        await load();
      }
    } catch (e: any) {
      toast.error('Go-Live failed', e?.message);
    } finally {
      setRowLoading(null);
    }
  };

  // Inline action: mark a referral's commission as paid
  const handleMarkPaid = async (referralId: string) => {
    setRowLoading(referralId);
    try {
      const res = await fetch(`/api/referrals/${referralId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commissionPaid: true }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || payload?.error) {
        toast.error('Mark Paid failed', payload?.error || `HTTP ${res.status}`);
      } else {
        toast.success('Commission marked paid');
        await load();
      }
    } catch (e: any) {
      toast.error('Mark Paid failed', e?.message);
    } finally {
      setRowLoading(null);
    }
  };

  if (loading) {
    return (
      <div className="p-8">
        <p className="text-sm text-saddle">Loading today's priorities…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8 max-w-xl">
        <div className="p-4 border border-rust bg-bone text-rust-dark">
          <p className="font-medium">Failed to load dashboard</p>
          <p className="text-sm mt-1">{error}</p>
          <button onClick={load} className="mt-3 px-3 py-1.5 text-sm bg-rust-dark text-bone hover:bg-rust">
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
        <h1 className="font-[family-name:var(--font-serif)] text-3xl md:text-4xl lowercase">today</h1>
        <p className="text-sm text-saddle mt-1">what needs your attention. Expand any group to act inline.</p>
      </header>

      {/* Top-line numbers */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Metric label="Needs approval" value={counts.pendingApproval} flag={counts.pendingApproval > 0 ? 'amber' : undefined} href="/admin/referrals?filter=Pending%20Approval" />
        <Metric label="Stalled 5+ days" value={counts.stalled} flag={counts.stalled > 5 ? 'red' : counts.stalled > 0 ? 'amber' : undefined} href="/admin/referrals?filter=Intro%20Sent" />
        <Metric label="Unpaid commission" value={`$${counts.unpaidTotal.toLocaleString()}`} sub={`${counts.unpaidCommissions} invoices`} flag={counts.unpaidCommissions > 10 ? 'amber' : undefined} href="/admin/commissions" />
        <Metric label="Warmup engaged" value={counts.warmupEngaged} sub="said YES, not yet matched" flag={counts.warmupEngaged > 0 ? 'green' : undefined} href="/admin/referrals" />
      </div>

      {/* Action groups — top 3 are inline-actionable drawers, rest stay as link lists */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* INLINE-ACTION DRAWER: Approve */}
        <ActionDrawer
          title="Needs approval"
          count={samples.pendingApproval.length}
          emptyText="No pending referrals. Nice work."
          fullListHref="/admin/referrals?filter=Pending%20Approval"
        >
          {samples.pendingApproval.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 p-2 border-b border-dust last:border-b-0">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-charcoal truncate">{r.buyer_name}</p>
                <p className="text-xs text-saddle truncate">
                  {r.buyer_state} · intent {r.intent_score}
                  {r.suggested_rancher ? ` · → ${r.suggested_rancher}` : ' · no rancher'}
                </p>
              </div>
              <button
                onClick={() => handleApprove(r.id)}
                disabled={rowLoading === r.id}
                className="shrink-0 px-3 py-1 bg-charcoal text-bone uppercase text-xs tracking-wider hover:bg-saddle disabled:opacity-50"
              >
                {rowLoading === r.id ? '…' : 'Approve'}
              </button>
            </li>
          ))}
        </ActionDrawer>

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

        {/* INLINE-ACTION DRAWER: Go Live */}
        <ActionDrawer
          title="Ready to go live"
          count={samples.pendingGoLive.length}
          emptyText="No ranchers awaiting launch."
          fullListHref="/admin/ranchers"
        >
          {samples.pendingGoLive.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 p-2 border-b border-dust last:border-b-0">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-charcoal truncate">{r.ranch_name}</p>
                <p className="text-xs text-saddle truncate">
                  {r.operator} · {r.state} · {r.status}
                </p>
              </div>
              <button
                onClick={() => handleGoLive(r.id)}
                disabled={rowLoading === r.id}
                className="shrink-0 px-3 py-1 bg-charcoal text-bone uppercase text-xs tracking-wider hover:bg-saddle disabled:opacity-50"
              >
                {rowLoading === r.id ? '…' : 'Go Live'}
              </button>
            </li>
          ))}
        </ActionDrawer>

        {/* INLINE-ACTION DRAWER: Mark Paid */}
        <ActionDrawer
          title="Unpaid commissions — oldest first"
          count={samples.unpaidCommissions.length}
          emptyText="All commissions paid."
          fullListHref="/admin/commissions"
        >
          {samples.unpaidCommissions.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 p-2 border-b border-dust last:border-b-0">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-charcoal truncate">
                  ${Number(r.commission_due).toLocaleString()} — {r.rancher_name || 'unknown'}
                </p>
                <p className="text-xs text-saddle truncate">
                  {r.buyer_name} · closed {r.closed_at ? new Date(r.closed_at).toLocaleDateString() : 'unknown'}
                </p>
              </div>
              <button
                onClick={() => handleMarkPaid(r.id)}
                disabled={rowLoading === r.id}
                className="shrink-0 px-3 py-1 bg-charcoal text-bone uppercase text-xs tracking-wider hover:bg-saddle disabled:opacity-50"
              >
                {rowLoading === r.id ? '…' : 'Mark Paid'}
              </button>
            </li>
          ))}
        </ActionDrawer>

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

      <div className="pt-6 text-xs text-dust border-t border-dust">
        Press <kbd className="px-1.5 py-0.5 border border-dust font-mono">⌘K</kbd> to search or jump to any page. Last loaded {new Date().toLocaleTimeString()}.
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
    flag === 'red' ? 'bg-rust-dark' :
    flag === 'amber' ? 'bg-amber' :
    flag === 'green' ? 'bg-sage' :
    'bg-dust';
  return (
    <Link
      href={href}
      className="block p-4 border border-dust bg-white hover:border-charcoal transition-colors"
    >
      <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-saddle">
        <span className={`w-2 h-2 rounded-full ${dotColor}`} />
        {label}
      </div>
      <div className="mt-1 text-3xl font-[family-name:var(--font-serif)]">{value}</div>
      {sub && <div className="text-xs text-dust mt-0.5">{sub}</div>}
    </Link>
  );
}

// D-1 audit fix: expandable drawer w/ inline action buttons per row.
// Replaces the dead-end ActionGroup link list for the highest-volume
// daily ops categories (approve / go-live / mark-paid).
function ActionDrawer({
  title,
  count,
  emptyText,
  fullListHref,
  children,
}: {
  title: string;
  count: number;
  emptyText: string;
  fullListHref: string;
  children: React.ReactNode;
}) {
  return (
    <details className="border border-dust bg-white" open={count > 0}>
      <summary className="cursor-pointer px-4 py-2.5 border-b border-dust flex items-center justify-between hover:bg-bone-warm">
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="text-xs text-rust font-medium">{count}</span>
      </summary>
      {count === 0 ? (
        <p className="px-4 py-6 text-sm text-dust italic">{emptyText}</p>
      ) : (
        <>
          <ul className="px-2 py-2">{children}</ul>
          <div className="px-4 py-2 border-t border-dust bg-bone-warm">
            <Link href={fullListHref} className="text-xs text-saddle hover:text-charcoal underline">
              view full list →
            </Link>
          </div>
        </>
      )}
    </details>
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
    <section className="border border-dust bg-white">
      <header className="px-4 py-2.5 border-b border-dust flex items-center justify-between">
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="text-xs text-dust">{items.length}</span>
      </header>
      {items.length === 0 ? (
        <p className="px-4 py-6 text-sm text-dust italic">{emptyText}</p>
      ) : (
        <ul className="divide-y divide-bone-deep">
          {items.map((item) => (
            <li key={item.key}>
              <Link
                href={item.href}
                className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-bone transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-charcoal truncate">{item.primary}</p>
                  {item.secondary && (
                    <p className="text-xs text-saddle truncate mt-0.5">{item.secondary}</p>
                  )}
                </div>
                {item.badge && (
                  <span
                    className={`text-xs px-2 py-0.5 border ${
                      item.badge.tone === 'red' ? 'bg-bone border-rust text-rust-dark' :
                      item.badge.tone === 'amber' ? 'bg-bone border-amber text-amber-dark' :
                      item.badge.tone === 'green' ? 'bg-bone border-sage text-sage-dark' :
                      'bg-bone border-dust text-saddle'
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
