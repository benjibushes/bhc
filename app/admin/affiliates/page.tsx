'use client';

import { useState, useEffect, useCallback } from 'react';
import Container from '../../components/Container';
import Divider from '../../components/Divider';
import AdminAuthGuard from '../../components/AdminAuthGuard';
import Link from 'next/link';
import { toast } from '@/lib/toast';
import {
  useListSearch,
  SearchSortBar,
  useDensity,
  densityPad,
  DensityToggle,
  useSavedViews,
  SavedViewsBar,
  confirmBlast,
  type SortOption,
} from '@/app/admin/components/ListControls';

interface Affiliate {
  id: string;
  name: string;
  email: string;
  code: string;
  status: string;
  // Optional stats fields — may not be returned by older API; handle defensively.
  created_at?: string;
  click_count?: number;
  earnings_pending?: number;
  last_click_at?: string;
}

// View-state blob for saved views.
interface AffiliatesViewState {
  query: string;
  sortKey: string;
  statusFilter: string;
}

const PAGE_KEY = 'affiliates';

const SEARCH_FIELDS: (keyof Affiliate)[] = ['name', 'email', 'code', 'status'];

const SORT_OPTIONS: SortOption[] = [
  { key: '-created_at', label: 'Newest first' },
  { key: 'created_at', label: 'Oldest first' },
  { key: 'name', label: 'Name A→Z' },
  { key: '-name', label: 'Name Z→A' },
  { key: 'status', label: 'Status' },
  { key: '-click_count', label: 'Most clicks' },
  { key: '-earnings_pending', label: 'Most earnings' },
];

const STATUS_FILTERS = ['all', 'Active', 'Inactive'];

export default function AdminAffiliatesPage() {
  const [affiliates, setAffiliates] = useState<Affiliate[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [sending, setSending] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', email: '', code: '' });
  const [error, setError] = useState('');

  // Status filter
  const [statusFilter, setStatusFilter] = useState<string>('all');

  // Density
  const [density, setDensity] = useDensity(PAGE_KEY);

  // Saved views
  const { views, save: saveView, remove: removeView } = useSavedViews<AffiliatesViewState>(PAGE_KEY);

  const fetchAffiliates = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/admin/affiliates');
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setAffiliates(Array.isArray(data) ? data : []);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Network error';
      setLoadError(msg);
      toast.error('Failed to load affiliates', msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAffiliates();
  }, [fetchAffiliates]);

  // Filter by status first, then hand to useListSearch for query+sort.
  const statusFiltered =
    statusFilter === 'all'
      ? affiliates
      : affiliates.filter((a) => a.status === statusFilter);

  const {
    filtered: filteredAffiliates,
    query,
    setQuery,
    sortKey,
    setSortKey,
  } = useListSearch(statusFiltered, {
    searchFields: SEARCH_FIELDS,
    sortOptions: SORT_OPTIONS,
    defaultSort: '-created_at',
  });

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setCreating(true);
    try {
      const res = await fetch('/api/admin/affiliates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create');
      // Refetch the list — the POST response doesn't include a full affiliate
      // record, so pushing data.affiliate (undefined) crashed the table row.
      await fetchAffiliates();
      setForm({ name: '', email: '', code: '' });
      toast.success('Affiliate created');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create affiliate');
    } finally {
      setCreating(false);
    }
  };

  const handleSendInvite = async (id: string, name: string) => {
    if (!confirmBlast(1, `Send invite to ${name}`)) return;
    setSending(id);
    try {
      const res = await fetch(`/api/admin/affiliates/${id}/send-invite`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to send');
      toast.success('Invite sent');
    } catch (err: unknown) {
      toast.error('Failed to send invite', err instanceof Error ? err.message : undefined);
    } finally {
      setSending(null);
    }
  };

  const handleDeactivate = async (id: string, name: string) => {
    if (!confirm(`Deactivate ${name}? Their referral link will go inert immediately.`)) return;
    setActionLoading(id);
    try {
      const res = await fetch(`/api/admin/affiliates/${id}/deactivate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: '' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Deactivate failed');
      toast.success(`${name} deactivated`);
      await fetchAffiliates();
    } catch (err: unknown) {
      toast.error('Deactivate failed', err instanceof Error ? err.message : undefined);
    } finally {
      setActionLoading(null);
    }
  };

  const handleReactivate = async (id: string, name: string) => {
    if (!confirm(`Reactivate ${name}? Their referral link will go live again.`)) return;
    setActionLoading(id);
    try {
      const res = await fetch(`/api/admin/affiliates/${id}/reactivate`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Reactivate failed');
      toast.success(`${name} reactivated`);
      await fetchAffiliates();
    } catch (err: unknown) {
      toast.error('Reactivate failed', err instanceof Error ? err.message : undefined);
    } finally {
      setActionLoading(null);
    }
  };

  const applyView = (state: AffiliatesViewState) => {
    setQuery(state.query);
    setSortKey(state.sortKey);
    setStatusFilter(state.statusFilter);
  };

  const saveCurrentView = () => {
    const name = window.prompt('Save view as:')?.trim();
    if (!name) return;
    saveView(name, { query, sortKey, statusFilter });
    toast.success(`View "${name}" saved`);
  };

  if (loading) {
    return (
      <AdminAuthGuard>
        <main className="min-h-screen py-24 bg-bone text-charcoal">
          <Container>
            <p className="text-lg text-saddle text-center">Loading affiliates...</p>
          </Container>
        </main>
      </AdminAuthGuard>
    );
  }

  if (loadError) {
    return (
      <AdminAuthGuard>
        <main className="min-h-screen py-24 bg-bone text-charcoal">
          <Container>
            <div className="text-center space-y-4">
              <p className="text-lg text-weathered">{loadError}</p>
              <button
                onClick={fetchAffiliates}
                className="px-6 py-2 bg-charcoal text-bone text-sm hover:bg-divider"
              >
                Retry
              </button>
            </div>
          </Container>
        </main>
      </AdminAuthGuard>
    );
  }

  return (
    <AdminAuthGuard>
      <main className="min-h-screen py-12 bg-bone text-charcoal">
        <Container>
          <div className="space-y-8">
            {/* Header */}
            <div className="flex flex-wrap justify-between items-start gap-4">
              <div>
                <h1 className="font-[family-name:var(--font-serif)] text-3xl md:text-4xl">
                  Affiliates
                </h1>
                <p className="text-sm text-saddle mt-2">
                  Invite-only brand promoters. Create affiliates and send them their links.
                </p>
              </div>
              <Link
                href="/admin"
                className="px-4 py-2 text-sm border border-charcoal hover:bg-charcoal hover:text-bone transition-colors"
              >
                &larr; Back
              </Link>
            </div>

            <Divider />

            {/* Quick stats strip */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="p-4 border border-dust text-center">
                <div className="font-[family-name:var(--font-serif)] text-3xl">{affiliates.length}</div>
                <div className="text-xs text-saddle">Total</div>
              </div>
              <div className="p-4 border border-sage/50 bg-sage/10 text-center">
                <div className="font-[family-name:var(--font-serif)] text-3xl text-sage-dark">
                  {affiliates.filter((a) => a.status === 'Active').length}
                </div>
                <div className="text-xs text-sage-dark font-medium">Active</div>
              </div>
              <div className="p-4 border border-dust text-center">
                <div className="font-[family-name:var(--font-serif)] text-3xl">
                  {affiliates.filter((a) => a.status === 'Inactive').length}
                </div>
                <div className="text-xs text-saddle">Inactive</div>
              </div>
              <div className="p-4 border border-amber/60 bg-amber/10 text-center">
                <div className="font-[family-name:var(--font-serif)] text-3xl text-amber-dark">
                  {affiliates.reduce((sum, a) => sum + (a.click_count ?? 0), 0)}
                </div>
                <div className="text-xs text-amber-dark font-medium">Total Clicks</div>
              </div>
            </div>

            {/* Create affiliate form */}
            <div className="p-6 border border-dust bg-white space-y-4">
              <h3 className="font-[family-name:var(--font-serif)] text-xl">Create Affiliate</h3>
              <form onSubmit={handleCreate} className="grid gap-4 md:grid-cols-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Name</label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    placeholder="Jane Doe"
                    required
                    className="w-full px-4 py-2 border border-dust bg-bone"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Email</label>
                  <input
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                    placeholder="jane@example.com"
                    required
                    className="w-full px-4 py-2 border border-dust bg-bone"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Code (optional)</label>
                  <input
                    type="text"
                    value={form.code}
                    onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
                    placeholder="auto-generated if blank"
                    className="w-full px-4 py-2 border border-dust bg-bone"
                  />
                </div>
                <div className="flex items-end">
                  <button
                    type="submit"
                    disabled={creating}
                    className="px-6 py-2 bg-charcoal text-bone text-sm font-medium hover:bg-divider disabled:opacity-50"
                  >
                    {creating ? 'Creating...' : 'Create'}
                  </button>
                </div>
              </form>
              {error && <p className="text-sm text-weathered">{error}</p>}
            </div>

            {/* Affiliate list + toolbar */}
            <div className="p-6 border border-dust bg-white space-y-4">
              {/* Toolbar row: density + heading */}
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <h3 className="font-[family-name:var(--font-serif)] text-xl">Affiliate List</h3>
                <DensityToggle density={density} setDensity={setDensity} />
              </div>

              {/* Saved views */}
              <SavedViewsBar
                views={views}
                onApply={applyView}
                onSaveCurrent={saveCurrentView}
                onDelete={removeView}
              />

              {/* Status filter tabs */}
              <div className="flex flex-wrap gap-2">
                {STATUS_FILTERS.map((s) => {
                  const count = s === 'all' ? affiliates.length : affiliates.filter((a) => a.status === s).length;
                  return (
                    <button
                      key={s}
                      onClick={() => setStatusFilter(s)}
                      className={`px-4 py-2 text-sm border transition-colors ${
                        statusFilter === s
                          ? 'bg-charcoal text-bone border-charcoal'
                          : 'border-dust hover:bg-dust'
                      }`}
                    >
                      {s === 'all' ? 'All' : s} ({count})
                    </button>
                  );
                })}
              </div>

              {/* Search + sort bar */}
              <SearchSortBar
                query={query}
                setQuery={setQuery}
                sortKey={sortKey}
                setSortKey={setSortKey}
                sortOptions={SORT_OPTIONS}
                placeholder="Search name, email, code…"
                resultCount={filteredAffiliates.length}
                totalCount={statusFiltered.length}
              />

              {filteredAffiliates.length === 0 ? (
                <p className="text-saddle py-6 text-center">
                  {query || statusFilter !== 'all'
                    ? 'No affiliates match your filters.'
                    : 'No affiliates yet. Create one above.'}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-dust">
                        <th className="text-left py-2 pr-4">Name</th>
                        <th className="text-left py-2 pr-4">Email</th>
                        <th className="text-left py-2 pr-4">Code</th>
                        <th className="text-left py-2 pr-4">Status</th>
                        <th className="text-left py-2 pr-4">Stats</th>
                        <th className="text-left py-2 pr-4">Created</th>
                        <th className="text-left py-2">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredAffiliates.map((a) => {
                        const isActive = a.status === 'Active';
                        const busy = actionLoading === a.id || sending === a.id;
                        return (
                          <tr
                            key={a.id}
                            className={`border-b border-dust/50 ${densityPad[density]}`}
                          >
                            <td className={`pr-4 font-medium ${densityPad[density]}`}>
                              {a.name || '—'}
                            </td>
                            <td className={`pr-4 text-saddle ${densityPad[density]}`}>
                              {a.email || '—'}
                            </td>
                            <td className={`pr-4 ${densityPad[density]}`}>
                              <code className="bg-bone px-2 py-0.5 text-xs">{a.code || '—'}</code>
                            </td>
                            <td className={`pr-4 ${densityPad[density]}`}>
                              <span
                                className={`px-2 py-0.5 text-xs border ${
                                  isActive
                                    ? 'bg-sage/15 text-sage-dark border-sage/40'
                                    : 'bg-weathered/15 text-weathered border-weathered/40'
                                }`}
                              >
                                {a.status || '—'}
                              </span>
                            </td>
                            <td className={`pr-4 text-xs text-saddle whitespace-nowrap ${densityPad[density]}`}>
                              {a.click_count != null ? (
                                <span>{a.click_count} clicks</span>
                              ) : null}
                              {a.earnings_pending != null && a.earnings_pending > 0 ? (
                                <span className="ml-2 text-sage-dark">
                                  ${a.earnings_pending.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} pending
                                </span>
                              ) : null}
                              {a.click_count == null && (a.earnings_pending == null || a.earnings_pending === 0) && (
                                <span className="text-dust">—</span>
                              )}
                            </td>
                            <td className={`pr-4 text-saddle whitespace-nowrap ${densityPad[density]}`}>
                              {a.created_at ? new Date(a.created_at).toLocaleDateString() : '—'}
                            </td>
                            <td className={`${densityPad[density]}`}>
                              <div className="flex flex-wrap gap-2">
                                {/* Send invite — only for active affiliates */}
                                {isActive && (
                                  <button
                                    type="button"
                                    onClick={() => handleSendInvite(a.id, a.name)}
                                    disabled={busy}
                                    className="px-3 py-1 text-xs border border-saddle text-saddle hover:bg-saddle hover:text-bone disabled:opacity-50"
                                  >
                                    {sending === a.id ? 'Sending…' : 'Send invite'}
                                  </button>
                                )}
                                {/* Deactivate / Reactivate */}
                                {isActive ? (
                                  <button
                                    type="button"
                                    onClick={() => handleDeactivate(a.id, a.name)}
                                    disabled={busy}
                                    className="px-3 py-1 text-xs border border-weathered text-weathered hover:bg-weathered hover:text-white disabled:opacity-50"
                                  >
                                    {actionLoading === a.id ? 'Deactivating…' : 'Deactivate'}
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => handleReactivate(a.id, a.name)}
                                    disabled={busy}
                                    className="px-3 py-1 text-xs border border-sage text-sage-dark hover:bg-sage/20 disabled:opacity-50"
                                  >
                                    {actionLoading === a.id ? 'Reactivating…' : 'Reactivate'}
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </Container>
      </main>
    </AdminAuthGuard>
  );
}
