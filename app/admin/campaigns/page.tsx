// app/admin/campaigns/page.tsx — campaign console (history + engagement).
//
// Read-only table of every campaign (broadcasts + rancher reactivation
// waves), newest-first, with delivered / opened / clicked engagement pulled
// from Email Sends attribution. "＋ New Campaign" jumps to the existing
// composer at /admin/broadcast. Auth is handled by app/admin/layout.tsx.

'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface CampaignRow {
  id: string;
  name: string;
  audience: string;
  status: string;
  scheduledFor: string;
  sentAt: string;
  recipients: number;
  sent: number;
  failed: number;
  delivered: number;
  opened: number;
  clicked: number;
  openRate: number;
  clickRate: number;
}

function statusBadge(status: string) {
  switch (status) {
    case 'Sent':
      return 'bg-sage/15 text-sage-dark border-sage';
    case 'Sending':
      return 'bg-amber/15 text-amber-dark border-amber-dark';
    case 'Scheduled':
      return 'bg-dust/25 text-saddle border-charcoal';
    case 'Partial':
      return 'bg-amber/15 text-amber-dark border-amber-dark';
    case 'Aborted':
    case 'Aborting':
      return 'bg-weathered/15 text-weathered border-weathered';
    default:
      return 'bg-bone-deep text-saddle border-dust';
  }
}

function fmtDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
}

function fmtPct(rate: number): string {
  return `${Math.round((rate || 0) * 100)}%`;
}

export default function CampaignsConsolePage() {
  const [campaigns, setCampaigns] = useState<CampaignRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      const r = await fetch('/api/admin/campaigns', { cache: 'no-store' });
      if (!r.ok) {
        setError(`Failed to load: HTTP ${r.status}`);
        return;
      }
      const j = await r.json();
      setCampaigns(j.campaigns || []);
    } catch (e: any) {
      setError(e?.message || 'Network error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  if (loading) return <main className="p-8 text-saddle">Loading campaigns…</main>;
  if (error) return <main className="p-8 text-weathered">Error: {error}</main>;

  const rows = campaigns || [];

  return (
    <main className="min-h-screen bg-bone py-8 px-4 md:px-8">
      <div className="max-w-6xl mx-auto space-y-6">
        <header className="flex justify-between items-center flex-wrap gap-3">
          <div>
            <p className="text-xs uppercase tracking-widest text-saddle mb-1">Admin</p>
            <h1 className="font-serif text-3xl text-charcoal">Campaign Console</h1>
            <p className="text-xs text-saddle mt-1 max-w-2xl">
              Every broadcast and rancher-reactivation wave, newest first.
              Delivered / opened / clicked are attributed from the Email Sends
              log via each campaign&apos;s name.
            </p>
          </div>
          <div className="flex gap-2">
            <button onClick={load} className="px-4 py-2 text-sm border border-dust hover:bg-white">
              ↻ Refresh
            </button>
            <Link
              href="/admin/broadcast"
              className="px-4 py-2 text-sm bg-charcoal text-bone hover:bg-saddle"
            >
              ＋ New Campaign
            </Link>
          </div>
        </header>

        {rows.length === 0 ? (
          <div className="bg-white border border-dust p-8 text-center text-saddle text-sm">
            No campaigns yet. Hit <span className="text-charcoal font-medium">＋ New Campaign</span> to send your first broadcast.
          </div>
        ) : (
          <div className="bg-white border border-dust overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-bone border-b border-dust text-left text-xs uppercase tracking-wide text-saddle">
                <tr>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Audience</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Sent At</th>
                  <th className="px-3 py-2 text-right">Recipients</th>
                  <th className="px-3 py-2 text-right">Sent / Failed</th>
                  <th className="px-3 py-2 text-right">Delivered</th>
                  <th className="px-3 py-2 text-right">Opened</th>
                  <th className="px-3 py-2 text-right">Clicked</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className="border-b border-dust">
                    <td className="px-3 py-2 font-medium text-charcoal">{c.name}</td>
                    <td className="px-3 py-2 text-saddle">{c.audience || '—'}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-block text-xs px-2 py-1 border ${statusBadge(c.status)}`}>
                        {c.status || '—'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-saddle text-xs">{fmtDate(c.sentAt)}</td>
                    <td className="px-3 py-2 text-saddle text-right">{c.recipients}</td>
                    <td className="px-3 py-2 text-right text-saddle">
                      <span className="text-charcoal">{c.sent}</span>
                      {' / '}
                      <span className={c.failed > 0 ? 'text-weathered font-medium' : ''}>{c.failed}</span>
                    </td>
                    <td className="px-3 py-2 text-charcoal text-right">{c.delivered}</td>
                    <td className="px-3 py-2 text-right text-saddle">
                      <span className="text-charcoal">{c.opened}</span>
                      <span className="text-xs ml-1">({fmtPct(c.openRate)})</span>
                    </td>
                    <td className="px-3 py-2 text-right text-saddle">
                      <span className="text-charcoal">{c.clicked}</span>
                      <span className="text-xs ml-1">({fmtPct(c.clickRate)})</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-xs text-saddle">
          Open / click rates are denominated on delivered emails. Engagement
          stamps arrive via the Resend webhook, so they fill in over the hours
          after a send.
        </p>
      </div>
    </main>
  );
}
