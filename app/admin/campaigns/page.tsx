// app/admin/campaigns/page.tsx — campaign console (history + engagement).
//
// Read-only table of every campaign (broadcasts + rancher reactivation
// waves), newest-first, with delivered / opened / clicked engagement pulled
// from Email Sends attribution. "+ New Campaign" jumps to the existing
// composer at /admin/broadcast. Auth is handled by app/admin/layout.tsx.
//
// Additions (redesign):
//   - Toolbar: search by name/audience/status, sort by date/name/recipients.
//   - Saved views: persist named filter+sort presets in localStorage.
//   - Density toggle: compact / default / comfortable row padding.
//   - Abort control for rows stuck in "Sending" status.

'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import React from 'react';
import {
  useListSearch,
  SearchSortBar,
  useDensity,
  DensityToggle,
  densityPad,
  useSavedViews,
  SavedViewsBar,
} from '@/app/admin/components/ListControls';

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

// ── View state shape persisted by SavedViewsBar ────────────────────────────
interface CampaignViewState {
  query: string;
  sortKey: string;
  statusFilter: string;
}

const PAGE_KEY = 'campaigns';

// ── Module-level search / sort config ─────────────────────────────────────
const SEARCH_FIELDS: (keyof CampaignRow)[] = ['name', 'audience', 'status'];

const SORT_OPTIONS = [
  { key: '-sentAt',    label: 'Sent (newest first)' },
  { key: 'sentAt',    label: 'Sent (oldest first)' },
  { key: '-recipients', label: 'Recipients (high → low)' },
  { key: 'recipients', label: 'Recipients (low → high)' },
  { key: 'name',      label: 'Name A → Z' },
  { key: '-name',     label: 'Name Z → A' },
];

const ALL_STATUSES = ['Sent', 'Sending', 'Scheduled', 'Partial', 'Aborted', 'Aborting'];

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
  const [statusFilter, setStatusFilter] = useState('');
  const [abortingIds, setAbortingIds] = useState<Set<string>>(new Set());
  const [abortToasts, setAbortToasts] = useState<Record<string, string>>({});

  // ── Density + saved views ────────────────────────────────────────────────
  const [density, setDensity] = useDensity(PAGE_KEY);
  const { views, save: saveView, remove: removeView } = useSavedViews<CampaignViewState>(PAGE_KEY);

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

  // ── Search + sort (operates on status-filtered slice) ───────────────────
  const rows = campaigns || [];

  const statusFiltered = statusFilter
    ? rows.filter((c) => c.status === statusFilter)
    : rows;

  const {
    filtered: filteredCampaigns,
    query,
    setQuery,
    sortKey,
    setSortKey,
  } = useListSearch(statusFiltered, {
    searchFields: SEARCH_FIELDS,
    sortOptions: SORT_OPTIONS,
    defaultSort: '-sentAt',
  });

  // ── Apply a saved view ───────────────────────────────────────────────────
  const applyView = useCallback((s: CampaignViewState) => {
    setQuery(s.query);
    setSortKey(s.sortKey);
    setStatusFilter(s.statusFilter);
  }, [setQuery, setSortKey]);

  const saveCurrentView = useCallback(() => {
    const name = window.prompt('Save view as:');
    if (!name?.trim()) return;
    saveView(name.trim(), { query, sortKey, statusFilter });
  }, [query, sortKey, statusFilter, saveView]);

  // ── Abort a stuck "Sending" campaign ────────────────────────────────────
  const handleAbort = useCallback(async (campaignName: string, campaignId: string) => {
    if (!window.confirm(
      `ABORT "${campaignName}"? The in-flight batch will finish then the send loop exits.`
    )) return;

    setAbortingIds((prev) => new Set(prev).add(campaignId));
    setAbortToasts((prev) => ({ ...prev, [campaignId]: '' }));

    try {
      const res = await fetch('/api/admin/broadcast/abort', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaignName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Abort failed');
      setAbortToasts((prev) => ({
        ...prev,
        [campaignId]: 'Abort flag set — send loop exits at next batch boundary.',
      }));
      // Refresh so Status flips to Aborting/Aborted.
      await load();
    } catch (err: any) {
      setAbortToasts((prev) => ({
        ...prev,
        [campaignId]: `Abort error: ${err.message || 'unknown'}`,
      }));
    } finally {
      setAbortingIds((prev) => {
        const next = new Set(prev);
        next.delete(campaignId);
        return next;
      });
    }
  }, []);

  if (loading) return <main className="p-8 text-saddle">Loading campaigns…</main>;
  if (error) return <main className="p-8 text-weathered">Error: {error}</main>;

  return (
    <main className="min-h-screen bg-bone py-8 px-4 md:px-8">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
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
          <div className="flex gap-2 items-center">
            <DensityToggle density={density} setDensity={setDensity} />
            <button onClick={load} className="px-4 py-2 text-sm border border-dust hover:bg-white">
              &#x21BB; Refresh
            </button>
            <Link
              href="/admin/broadcast"
              className="px-4 py-2 text-sm bg-charcoal text-bone hover:bg-saddle"
            >
              &#xFF0B; New Campaign
            </Link>
          </div>
        </header>

        {/* Saved views bar */}
        <SavedViewsBar<CampaignViewState>
          views={views}
          onApply={applyView}
          onSaveCurrent={saveCurrentView}
          onDelete={removeView}
        />

        {/* Status filter tabs */}
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setStatusFilter('')}
            className={`px-3 py-1.5 text-xs border transition-colors ${
              statusFilter === '' ? 'bg-charcoal text-bone border-charcoal' : 'border-dust text-saddle hover:bg-dust'
            }`}
          >
            All ({rows.length})
          </button>
          {ALL_STATUSES.map((s) => {
            const count = rows.filter((c) => c.status === s).length;
            if (count === 0) return null;
            return (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`px-3 py-1.5 text-xs border transition-colors ${
                  statusFilter === s ? 'bg-charcoal text-bone border-charcoal' : 'border-dust text-saddle hover:bg-dust'
                }`}
              >
                {s} ({count})
              </button>
            );
          })}
        </div>

        {/* Search + sort toolbar */}
        <SearchSortBar
          query={query}
          setQuery={setQuery}
          sortKey={sortKey}
          setSortKey={setSortKey}
          sortOptions={SORT_OPTIONS}
          placeholder="Search campaigns by name, audience, status…"
          resultCount={filteredCampaigns.length}
          totalCount={statusFiltered.length}
        />

        {rows.length === 0 ? (
          <div className="bg-white border border-dust p-8 text-center text-saddle text-sm">
            No campaigns yet. Hit <span className="text-charcoal font-medium">&#xFF0B; New Campaign</span> to send your first broadcast.
          </div>
        ) : filteredCampaigns.length === 0 ? (
          <div className="bg-white border border-dust p-8 text-center text-saddle text-sm">
            No campaigns match your search. <button onClick={() => { setQuery(''); setStatusFilter(''); }} className="underline text-charcoal">Clear filters</button>
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
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {filteredCampaigns.map((c) => (
                  <React.Fragment key={c.id}>
                    <tr className={`border-b border-dust ${densityPad[density]}`}>
                      <td className={`px-3 font-medium text-charcoal ${densityPad[density]}`}>{c.name}</td>
                      <td className={`px-3 text-saddle ${densityPad[density]}`}>{c.audience || '—'}</td>
                      <td className={`px-3 ${densityPad[density]}`}>
                        <span className={`inline-block text-xs px-2 py-1 border ${statusBadge(c.status)}`}>
                          {c.status || '—'}
                        </span>
                      </td>
                      <td className={`px-3 text-saddle text-xs ${densityPad[density]}`}>{fmtDate(c.sentAt)}</td>
                      <td className={`px-3 text-saddle text-right ${densityPad[density]}`}>{c.recipients}</td>
                      <td className={`px-3 text-right text-saddle ${densityPad[density]}`}>
                        <span className="text-charcoal">{c.sent}</span>
                        {' / '}
                        <span className={c.failed > 0 ? 'text-weathered font-medium' : ''}>{c.failed}</span>
                      </td>
                      <td className={`px-3 text-charcoal text-right ${densityPad[density]}`}>{c.delivered}</td>
                      <td className={`px-3 text-right text-saddle ${densityPad[density]}`}>
                        <span className="text-charcoal">{c.opened}</span>
                        <span className="text-xs ml-1">({fmtPct(c.openRate)})</span>
                      </td>
                      <td className={`px-3 text-right text-saddle ${densityPad[density]}`}>
                        <span className="text-charcoal">{c.clicked}</span>
                        <span className="text-xs ml-1">({fmtPct(c.clickRate)})</span>
                      </td>
                      <td className={`px-3 text-right ${densityPad[density]}`}>
                        {/* Abort control — only shown for rows stuck in Sending */}
                        {(c.status === 'Sending') && (
                          <button
                            type="button"
                            onClick={() => handleAbort(c.name, c.id)}
                            disabled={abortingIds.has(c.id)}
                            className="px-2 py-1 text-xs border border-weathered text-weathered hover:bg-weathered hover:text-white disabled:opacity-50 whitespace-nowrap"
                            title="Abort this in-flight broadcast"
                          >
                            {abortingIds.has(c.id) ? 'Aborting…' : 'Abort'}
                          </button>
                        )}
                      </td>
                    </tr>
                    {/* Per-row abort toast */}
                    {abortToasts[c.id] && (
                      <tr className="bg-bone/50">
                        <td colSpan={10} className="px-3 py-1 text-xs text-saddle">
                          {abortToasts[c.id]}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
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
