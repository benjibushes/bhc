'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from '@/lib/toast';
import { confirmBlast } from '@/app/admin/components/ListControls';

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
    wholesaleNew?: number;
    wholesaleActive?: number;
  };
  samples: {
    pendingApproval: { id: string; buyer_name: string; buyer_state: string; intent_score: number; suggested_rancher: string }[];
    stalled: { id: string; buyer_name: string; rancher_name: string; days: number }[];
    unpaidCommissions: { id: string; buyer_name: string; rancher_name: string; commission_due: number; closed_at: string }[];
    highIntentWaiting: { id: string; name: string; state: string; intent: number; warmup: string }[];
    pendingGoLive: {
      id: string;
      ranch_name: string;
      operator: string;
      state: string;
      status: string;
      /** active_status from Airtable — used to show Pause/Resume affordance */
      active_status?: string;
      /** stripe_connect status — used to show Resync-Connect affordance */
      stripe_connect_status?: string;
    }[];
    warmupEngaged: { id: string; name: string; state: string; engaged_at: string }[];
    wholesaleActive?: { id: string; business_name: string; contact_name: string; state: string; status: string; created_at: string }[];
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
  // confirmBlast guard: sends intro email to buyer + rancher (2 live sends)
  const handleApprove = async (referralId: string, buyerName: string) => {
    if (!confirmBlast(2, `send intro emails for "${buyerName}"`)) return;
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
  // confirmBlast guard: go-live triggers warmup email to waiting buyers
  const handleGoLive = async (rancherId: string, ranchName: string, waitingBuyerCount?: number) => {
    // Go-live warmup-blasts every waiting buyer in the rancher's state; we don't
    // have the exact count here, so use an honest plain confirm instead of a
    // confirmBlast that would claim a specific (and wrong) "1 person" count.
    void waitingBuyerCount;
    if (!window.confirm(`Go live: publish "${ranchName}" and email every waiting buyer in their state. This cannot be undone. Continue?`)) return;
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

  // Rancher action: Pause (stop receiving new leads)
  const handlePauseRancher = async (rancherId: string, ranchName: string) => {
    setRowLoading(`pause-${rancherId}`);
    try {
      const res = await fetch(`/api/admin/ranchers/${rancherId}/pause`, { method: 'POST' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || payload?.error) {
        toast.error('Pause failed', payload?.error || `HTTP ${res.status}`);
      } else {
        toast.success(`${ranchName} paused`, 'No new leads until resumed');
        await load();
      }
    } catch (e: any) {
      toast.error('Pause failed', e?.message);
    } finally {
      setRowLoading(null);
    }
  };

  // Rancher action: Resume (re-open to new leads)
  const handleResumeRancher = async (rancherId: string, ranchName: string) => {
    setRowLoading(`resume-${rancherId}`);
    try {
      const res = await fetch(`/api/admin/ranchers/${rancherId}/resume`, { method: 'POST' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || payload?.error) {
        toast.error('Resume failed', payload?.error || `HTTP ${res.status}`);
      } else {
        toast.success(`${ranchName} resumed`, 'Now accepting new leads');
        await load();
      }
    } catch (e: any) {
      toast.error('Resume failed', e?.message);
    } finally {
      setRowLoading(null);
    }
  };

  // Rancher action: Resync Stripe Connect (fix stuck onboarding)
  const handleResyncConnect = async (rancherId: string, ranchName: string) => {
    setRowLoading(`resync-${rancherId}`);
    try {
      const res = await fetch(`/api/admin/ranchers/${rancherId}/resync-connect`, { method: 'POST' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || payload?.error) {
        toast.error('Resync failed', payload?.error || `HTTP ${res.status}`);
      } else {
        toast.success(`${ranchName} Connect resynced`, payload?.message);
        await load();
      }
    } catch (e: any) {
      toast.error('Resync failed', e?.message);
    } finally {
      setRowLoading(null);
    }
  };

  if (loading) {
    return (
      <div className="p-8">
        <p className="text-sm text-saddle">Loading today&apos;s priorities…</p>
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
        <Metric label="Wholesale active" value={counts.wholesaleActive ?? 0} sub={counts.wholesaleNew ? `${counts.wholesaleNew} new` : 'in flight'} flag={(counts.wholesaleNew ?? 0) > 0 ? 'amber' : undefined} href="/admin/inquiries" />
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
                onClick={() => handleApprove(r.id, r.buyer_name)}
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

        {/* INLINE-ACTION DRAWER: Go Live + Pause / Resume / Resync-Connect */}
        <ActionDrawer
          title="Ready to go live"
          count={samples.pendingGoLive.length}
          emptyText="No ranchers awaiting launch."
          fullListHref="/admin/ranchers"
        >
          {samples.pendingGoLive.map((r) => {
            const isPaused = r.active_status === 'Paused';
            const isActive = r.active_status === 'Active';
            const needsResync = r.stripe_connect_status === 'pending' || r.stripe_connect_status === 'incomplete';

            return (
              <li key={r.id} className="flex items-center justify-between gap-2 p-2 border-b border-dust last:border-b-0">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-charcoal truncate">{r.ranch_name}</p>
                  <p className="text-xs text-saddle truncate">
                    {r.operator} · {r.state} · {r.status}
                    {r.active_status && ` · ${r.active_status}`}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {/* Go Live — only show when not already live */}
                  {r.status !== 'Live' && (
                    <button
                      onClick={() => handleGoLive(r.id, r.ranch_name)}
                      disabled={rowLoading === r.id}
                      className="px-3 py-1 bg-charcoal text-bone uppercase text-xs tracking-wider hover:bg-saddle disabled:opacity-50"
                    >
                      {rowLoading === r.id ? '…' : 'Go Live'}
                    </button>
                  )}
                  {/* Pause / Resume — for live ranchers whose capacity needs toggling */}
                  {isActive && (
                    <button
                      onClick={() => handlePauseRancher(r.id, r.ranch_name)}
                      disabled={rowLoading === `pause-${r.id}`}
                      title="Stop this rancher from receiving new leads"
                      className="px-2 py-1 border border-amber-dark text-amber-dark text-xs hover:bg-amber/10 disabled:opacity-50"
                    >
                      {rowLoading === `pause-${r.id}` ? '…' : 'Pause'}
                    </button>
                  )}
                  {isPaused && (
                    <button
                      onClick={() => handleResumeRancher(r.id, r.ranch_name)}
                      disabled={rowLoading === `resume-${r.id}`}
                      title="Re-open this rancher to new leads"
                      className="px-2 py-1 border border-sage text-sage-dark text-xs hover:bg-sage/10 disabled:opacity-50"
                    >
                      {rowLoading === `resume-${r.id}` ? '…' : 'Resume'}
                    </button>
                  )}
                  {/* Resync Connect — fix stuck Stripe Connect onboarding */}
                  {needsResync && (
                    <button
                      onClick={() => handleResyncConnect(r.id, r.ranch_name)}
                      disabled={rowLoading === `resync-${r.id}`}
                      title="Re-pull Stripe Connect account status to unblock deposit gate"
                      className="px-2 py-1 border border-saddle text-saddle text-xs hover:bg-saddle/10 disabled:opacity-50"
                    >
                      {rowLoading === `resync-${r.id}` ? '…' : 'Resync ↻'}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
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

        {/* Wholesale active queue — wholesale buyers (restaurants/butchers,
            $5-15k AOV) move through New → Routed → Quoted → Closed. Newest
            first. Clicking a row jumps to /admin/inquiries where admin can
            match ranchers + step status. New rows get a red badge to flag
            "hasn't been touched yet". */}
        <ActionGroup
          title="Wholesale — active queue"
          emptyText="No active wholesale inquiries."
          items={(samples.wholesaleActive || []).map((w) => ({
            key: w.id,
            primary: w.business_name,
            secondary: `${w.contact_name}${w.state ? ` · ${w.state}` : ''}${w.created_at ? ` · ${new Date(w.created_at).toLocaleDateString()}` : ''}`,
            href: `/admin/inquiries`,
            badge: w.status === 'New'
              ? { text: 'NEW', tone: 'red' as const }
              : w.status === 'Routed'
              ? { text: 'ROUTED', tone: 'amber' as const }
              : w.status === 'Quoted'
              ? { text: 'QUOTED', tone: 'amber' as const }
              : { text: w.status?.toUpperCase() || '', tone: 'gray' as const },
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
