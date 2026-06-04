// app/admin/migration/page.tsx — tier_v2 migration funnel tracker.
//
// At-a-glance: completion %, who's done, who's at risk, who hasn't been
// invited yet. Bulk-invite remaining ranchers in one click.

'use client';

import { useEffect, useState } from 'react';

interface MigrationRancher {
  id: string;
  name: string;
  email: string;
  state: string;
  pricingModel: string;
  migrationStatus: string;
  migrationDeadline: string;
  daysLeft: number | null;
  inviteSentAt: string;
  callBookedAt: string;
  subscriptionStatus: string;
  connectStatus: string;
  activeStatus: string;
}

interface MigrationData {
  summary: {
    total: number;
    completed: number;
    completionPct: number;
    notInvited: number;
    invited: number;
    callScheduled: number;
    upgrading: number;
    pausedOverdue: number;
    atRisk: number;
  };
  ranchers: MigrationRancher[];
}

function statusBadge(status: string, pricingModel: string) {
  if (pricingModel === 'tier_v2') return { label: '✓ tier_v2', color: 'bg-green-100 text-green-900 border-green-600' };
  switch (status) {
    case 'completed':
      return { label: '✓ Completed', color: 'bg-green-100 text-green-900 border-green-600' };
    case 'upgrading':
      return { label: '⏳ Upgrading', color: 'bg-blue-100 text-blue-900 border-blue-600' };
    case 'call_scheduled':
      return { label: '📅 Call Booked', color: 'bg-purple-100 text-purple-900 border-purple-600' };
    case 'invited':
      return { label: '📧 Invited', color: 'bg-yellow-100 text-yellow-900 border-yellow-600' };
    case 'paused_overdue':
      return { label: '⏸ Paused — Overdue', color: 'bg-red-100 text-red-900 border-red-600' };
    case 'not_invited':
    default:
      return { label: '— Not Invited', color: 'bg-gray-100 text-gray-700 border-gray-400' };
  }
}

export default function MigrationTrackerPage() {
  const [data, setData] = useState<MigrationData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [bulkSending, setBulkSending] = useState(false);
  const [bulkResult, setBulkResult] = useState<{ sent: number; failed: number } | null>(null);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const r = await fetch('/api/admin/migration', { cache: 'no-store' });
      if (!r.ok) {
        setError(`Failed to load: HTTP ${r.status}`);
        return;
      }
      setData(await r.json());
    } catch (e: any) {
      setError(e?.message || 'Network error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function fireSingle(id: string) {
    if (!confirm('Send v2 upgrade invite to this rancher?')) return;
    const r = await fetch(`/api/admin/ranchers/${id}/send-v2-upgrade`, { method: 'POST' });
    if (!r.ok) {
      alert(`Failed: ${await r.text()}`);
      return;
    }
    load();
  }

  async function fireBulk() {
    if (!data) return;
    const notInvited = data.ranchers.filter((r) => r.migrationStatus === 'not_invited');
    if (notInvited.length === 0) {
      alert('No not-invited ranchers to send to.');
      return;
    }
    if (!confirm(`Bulk-send v2 upgrade invite to ${notInvited.length} ranchers?\n\n${notInvited.map((r) => `• ${r.name}`).join('\n')}`)) return;
    setBulkSending(true);
    setBulkResult(null);
    try {
      const r = await fetch('/api/admin/migration', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      const j = await r.json();
      setBulkResult({ sent: j.sent || 0, failed: j.failed || 0 });
      load();
    } catch (e: any) {
      setError(e?.message || 'Bulk send failed');
    } finally {
      setBulkSending(false);
    }
  }

  if (loading) return <main className="p-8 text-saddle">Loading migration funnel…</main>;
  if (error || !data) return <main className="p-8 text-red-700">Error: {error || 'No data'}</main>;

  return (
    <main className="min-h-screen bg-bone py-8 px-4 md:px-8">
      <div className="max-w-6xl mx-auto space-y-6">
        <header className="flex justify-between items-center flex-wrap gap-3">
          <div>
            <p className="text-xs uppercase tracking-widest text-saddle mb-1">Admin</p>
            <h1 className="font-serif text-3xl text-charcoal">tier_v2 Migration Tracker</h1>
          </div>
          <div className="flex gap-2">
            <button onClick={load} className="px-4 py-2 text-sm border border-dust hover:bg-white">↻ Refresh</button>
            <button
              onClick={fireBulk}
              disabled={bulkSending || data.summary.notInvited === 0}
              className="px-4 py-2 text-sm bg-charcoal text-bone hover:bg-saddle disabled:opacity-50"
            >
              {bulkSending ? 'Sending…' : `🚀 Bulk Invite ${data.summary.notInvited} Not-Invited`}
            </button>
          </div>
        </header>

        {/* Summary cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-white border border-dust p-4">
            <p className="text-xs uppercase tracking-wide text-saddle">Completion</p>
            <p className="font-serif text-3xl text-charcoal mt-1">{data.summary.completionPct}%</p>
            <p className="text-xs text-saddle mt-1">{data.summary.completed} / {data.summary.total}</p>
            <div className="h-2 bg-dust mt-2">
              <div className="h-full bg-charcoal" style={{ width: `${data.summary.completionPct}%` }} />
            </div>
          </div>
          <div className="bg-white border border-dust p-4">
            <p className="text-xs uppercase tracking-wide text-saddle">In Flight</p>
            <p className="font-serif text-3xl text-charcoal mt-1">{data.summary.invited + data.summary.callScheduled + data.summary.upgrading}</p>
            <p className="text-xs text-saddle mt-1">invited / scheduled / upgrading</p>
          </div>
          <div className="bg-white border border-dust p-4">
            <p className="text-xs uppercase tracking-wide text-saddle">At Risk (≤3d)</p>
            <p className="font-serif text-3xl text-charcoal mt-1">{data.summary.atRisk}</p>
            <p className="text-xs text-saddle mt-1">close to deadline</p>
          </div>
          <div className="bg-white border border-dust p-4">
            <p className="text-xs uppercase tracking-wide text-saddle">Paused Overdue</p>
            <p className="font-serif text-3xl text-charcoal mt-1">{data.summary.pausedOverdue}</p>
            <p className="text-xs text-saddle mt-1">past deadline, paused</p>
          </div>
        </div>

        {bulkResult && (
          <div className="bg-bone border border-charcoal p-4 text-sm">
            ✓ Bulk send complete. Sent: {bulkResult.sent} · Failed: {bulkResult.failed}
          </div>
        )}

        {/* Per-rancher table */}
        <div className="bg-white border border-dust overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-bone border-b border-dust text-left text-xs uppercase tracking-wide text-saddle">
              <tr>
                <th className="px-3 py-2">Rancher</th>
                <th className="px-3 py-2">State</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Days Left</th>
                <th className="px-3 py-2">Sub</th>
                <th className="px-3 py-2">Connect</th>
                <th className="px-3 py-2">Invite Sent</th>
                <th className="px-3 py-2">Call Booked</th>
                <th className="px-3 py-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {data.ranchers.map((r) => {
                const badge = statusBadge(r.migrationStatus, r.pricingModel);
                const atRisk = r.daysLeft !== null && r.daysLeft >= 0 && r.daysLeft <= 3 && r.pricingModel !== 'tier_v2';
                return (
                  <tr key={r.id} className={`border-b border-dust ${atRisk ? 'bg-yellow-50' : ''}`}>
                    <td className="px-3 py-2 font-medium text-charcoal">{r.name}</td>
                    <td className="px-3 py-2 text-saddle">{r.state}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-block text-xs px-2 py-1 border ${badge.color}`}>{badge.label}</span>
                    </td>
                    <td className="px-3 py-2 text-saddle">
                      {r.pricingModel === 'tier_v2' ? '—' : r.daysLeft === null ? '—' : r.daysLeft <= 0 ? <span className="text-red-700 font-medium">OVERDUE</span> : `${r.daysLeft}d`}
                    </td>
                    <td className="px-3 py-2 text-saddle">{r.subscriptionStatus || '—'}</td>
                    <td className="px-3 py-2 text-saddle">{r.connectStatus || '—'}</td>
                    <td className="px-3 py-2 text-saddle text-xs">{r.inviteSentAt ? new Date(r.inviteSentAt).toLocaleDateString() : '—'}</td>
                    <td className="px-3 py-2 text-saddle text-xs">{r.callBookedAt ? new Date(r.callBookedAt).toLocaleDateString() : '—'}</td>
                    <td className="px-3 py-2">
                      {r.pricingModel !== 'tier_v2' && (
                        <button onClick={() => fireSingle(r.id)} className="text-xs underline text-charcoal hover:text-saddle">
                          {r.migrationStatus === 'not_invited' ? 'Send invite' : 'Re-send'}
                        </button>
                      )}
                      <a href={`/admin/ranchers/${r.id}`} className="text-xs underline text-charcoal hover:text-saddle ml-2">View</a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-saddle">
          Highlighted yellow rows = ≤3 days to deadline. After deadline passes, the
          migration-deadline cron auto-flips Active Status to Paused and routing stops
          to that rancher until they complete the upgrade.
        </p>
      </div>
    </main>
  );
}
