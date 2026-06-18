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
  DensityToggle,
  densityPad,
  useSavedViews,
  SavedViewsBar,
  type SortOption,
} from '@/app/admin/components/ListControls';

// ── Types ────────────────────────────────────────────────────────────────────

interface Referral {
  id: string;
  buyer_name: string;
  buyer_state: string;
  suggested_rancher_name: string;
  rancher_email: string;
  rancher_phone: string;
  status: string;
  sale_amount: number;
  commission_due: number;
  commission_paid: boolean;
  closed_at: string;
  order_type: string;
}

type FilterStatus = 'all' | 'unpaid' | 'paid';

// View-state blob persisted by SavedViewsBar
interface ViewState {
  query: string;
  sortKey: string;
  filterStatus: FilterStatus;
  filterMonth: string;
  filterRancher: string;
}

// ── Module-level constants ────────────────────────────────────────────────────

const PAGE_KEY = 'commissions';

const SEARCH_FIELDS: (keyof Referral)[] = [
  'buyer_name',
  'buyer_state',
  'suggested_rancher_name',
  'rancher_email',
  'rancher_phone',
  'order_type',
];

const SORT_OPTIONS: SortOption[] = [
  { key: '-closed_at', label: 'Closed (newest)' },
  { key: 'closed_at', label: 'Closed (oldest)' },
  { key: '-commission_due', label: 'Commission (high → low)' },
  { key: 'commission_due', label: 'Commission (low → high)' },
  { key: '-sale_amount', label: 'Sale (high → low)' },
  { key: 'suggested_rancher_name', label: 'Rancher (A-Z)' },
  { key: 'buyer_name', label: 'Buyer (A-Z)' },
];

// ── CSV export ────────────────────────────────────────────────────────────────

function exportCSV(rows: Referral[], filename = 'commissions.csv') {
  const headers = [
    'Rancher',
    'Rancher Email',
    'Rancher Phone',
    'Buyer',
    'Buyer State',
    'Order Type',
    'Sale Amount',
    'Commission Due',
    'Commission Paid',
    'Closed At',
  ];
  const escape = (v: unknown) => {
    const s = String(v ?? '');
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const lines = [
    headers.map(escape).join(','),
    ...rows.map((r) =>
      [
        r.suggested_rancher_name || '',
        r.rancher_email || '',
        r.rancher_phone || '',
        r.buyer_name || '',
        r.buyer_state || '',
        r.order_type || '',
        (r.sale_amount || 0).toFixed(2),
        (r.commission_due || 0).toFixed(2),
        r.commission_paid ? 'Yes' : 'No',
        r.closed_at ? new Date(r.closed_at).toLocaleDateString() : '',
      ]
        .map(escape)
        .join(','),
    ),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function CommissionsPage() {
  const [referrals, setReferrals] = useState<Referral[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all');
  const [filterMonth, setFilterMonth] = useState('');
  const [filterRancher, setFilterRancher] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);

  // Density
  const [density, setDensity] = useDensity(PAGE_KEY);

  // Saved views
  const { views, save: saveView, remove: removeView } = useSavedViews<ViewState>(PAGE_KEY);

  // Adjust-commission modal
  const [adjustModal, setAdjustModal] = useState<{
    id: string;
    currentAmount: number;
    newAmount: string;
    reason: string;
  } | null>(null);
  const [adjustLoading, setAdjustLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/referrals?status=Closed Won');
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const msg = (err as { error?: string }).error || `HTTP ${res.status}`;
        setLoadError(msg);
        toast.error('Failed to load commissions', msg);
        setLoading(false);
        return;
      }
      const data = await res.json();
      setReferrals(
        Array.isArray(data)
          ? (data as Referral[]).filter((r) => r.status === 'Closed Won')
          : [],
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Network error';
      setLoadError(msg);
      toast.error('Network error', msg);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const togglePaid = async (id: string, currentPaid: boolean) => {
    // Optimistic update
    setReferrals((prev) =>
      prev.map((r) => (r.id === id ? { ...r, commission_paid: !currentPaid } : r)),
    );
    try {
      const res = await fetch(`/api/referrals/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commissionPaid: !currentPaid }),
      });
      if (!res.ok) {
        // Roll back on failure
        setReferrals((prev) =>
          prev.map((r) => (r.id === id ? { ...r, commission_paid: currentPaid } : r)),
        );
        const data = await res.json().catch(() => ({}));
        toast.error(
          'Update failed',
          (data as { error?: string }).error || `HTTP ${res.status}`,
        );
      } else {
        toast.success(currentPaid ? 'Marked as unpaid' : 'Marked as paid');
      }
    } catch (e: unknown) {
      setReferrals((prev) =>
        prev.map((r) => (r.id === id ? { ...r, commission_paid: currentPaid } : r)),
      );
      toast.error('Network error', e instanceof Error ? e.message : undefined);
    }
  };

  const openAdjustModal = (id: string, currentAmount: number) => {
    setAdjustModal({ id, currentAmount, newAmount: currentAmount.toFixed(2), reason: '' });
  };

  const submitAdjustCommission = async () => {
    if (!adjustModal) return;
    const amount = parseFloat(adjustModal.newAmount);
    if (isNaN(amount) || amount < 0) {
      toast.error('Enter a valid amount');
      return;
    }
    setAdjustLoading(true);
    try {
      const res = await fetch(
        `/api/admin/referrals/${adjustModal.id}/adjust-commission`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ commissionDue: amount, reason: adjustModal.reason }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        toast.error('Adjustment failed', (data as { error?: string }).error);
        setAdjustLoading(false);
        return;
      }
      const d = data as { oldAmount: number; newAmount: number };
      toast.success(
        'Commission adjusted',
        `$${d.oldAmount.toFixed(2)} → $${d.newAmount.toFixed(2)}`,
      );
      setAdjustModal(null);
      await load();
    } catch (e: unknown) {
      toast.error('Network error', e instanceof Error ? e.message : undefined);
    }
    setAdjustLoading(false);
  };

  // ── Derived filter values ──────────────────────────────────────────────────

  const months = [
    ...new Set(
      referrals
        .filter((r) => r.closed_at)
        .map((r) => {
          const d = new Date(r.closed_at);
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        }),
    ),
  ]
    .sort()
    .reverse();

  // Unique rancher names for the rancher filter dropdown
  const rancherNames = [
    ...new Set(referrals.map((r) => r.suggested_rancher_name || 'Unknown').filter(Boolean)),
  ].sort();

  // First apply status + month + rancher filters (these are tab/dropdown filters)
  const statusFiltered = referrals.filter((r) => {
    if (filterStatus === 'paid' && !r.commission_paid) return false;
    if (filterStatus === 'unpaid' && r.commission_paid) return false;
    if (filterMonth && r.closed_at) {
      const d = new Date(r.closed_at);
      const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (m !== filterMonth) return false;
    }
    if (filterRancher && (r.suggested_rancher_name || 'Unknown') !== filterRancher) return false;
    return true;
  });

  // Then apply search + sort via the kit
  const { filtered: filteredReferrals, query, setQuery, sortKey, setSortKey } =
    useListSearch(statusFiltered, {
      searchFields: SEARCH_FIELDS,
      sortOptions: SORT_OPTIONS,
      defaultSort: '-closed_at',
    });

  // ── Summary stats over the search-filtered set ────────────────────────────

  const totalSales = filteredReferrals.reduce((s, r) => s + (r.sale_amount || 0), 0);
  const totalCommission = filteredReferrals.reduce((s, r) => s + (r.commission_due || 0), 0);
  const unpaidCommission = filteredReferrals
    .filter((r) => !r.commission_paid)
    .reduce((s, r) => s + (r.commission_due || 0), 0);

  // ── Per-rancher grouping for payout tool view ─────────────────────────────

  type RancherGroup = {
    name: string;
    email: string;
    phone: string;
    rows: Referral[];
    totalSales: number;
    totalCommission: number;
    unpaidCommission: number;
    paidCommission: number;
  };

  const rancherGroups: RancherGroup[] = [];
  const groupMap = new Map<string, RancherGroup>();
  for (const r of filteredReferrals) {
    const name = r.suggested_rancher_name || 'Unknown';
    if (!groupMap.has(name)) {
      groupMap.set(name, {
        name,
        email: r.rancher_email || '',
        phone: r.rancher_phone || '',
        rows: [],
        totalSales: 0,
        totalCommission: 0,
        unpaidCommission: 0,
        paidCommission: 0,
      });
    }
    const g = groupMap.get(name)!;
    g.rows.push(r);
    g.totalSales += r.sale_amount || 0;
    g.totalCommission += r.commission_due || 0;
    if (!r.commission_paid) g.unpaidCommission += r.commission_due || 0;
    else g.paidCommission += r.commission_due || 0;
    // Keep the first non-empty contact info we encounter
    if (!g.email && r.rancher_email) g.email = r.rancher_email;
    if (!g.phone && r.rancher_phone) g.phone = r.rancher_phone;
  }
  for (const g of groupMap.values()) rancherGroups.push(g);
  // Sort groups: most unpaid commission first
  rancherGroups.sort((a, b) => b.unpaidCommission - a.unpaidCommission);

  // ── Saved-views helpers ───────────────────────────────────────────────────

  const applyView = (s: ViewState) => {
    setQuery(s.query ?? '');
    setSortKey(s.sortKey ?? '-closed_at');
    setFilterStatus(s.filterStatus ?? 'all');
    setFilterMonth(s.filterMonth ?? '');
    setFilterRancher(s.filterRancher ?? '');
  };

  const saveCurrentView = () => {
    const name = window.prompt('Name this view:');
    if (!name?.trim()) return;
    saveView(name.trim(), { query, sortKey, filterStatus, filterMonth, filterRancher });
  };

  // ── Loading / error states ────────────────────────────────────────────────

  if (loading) {
    return (
      <AdminAuthGuard>
        <main className="min-h-screen py-24 bg-bone text-charcoal">
          <Container>
            <p className="text-lg text-saddle text-center">Loading commissions...</p>
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
            <div className="max-w-xl mx-auto p-4 border border-weathered/40 bg-weathered/10 text-weathered">
              <p className="font-medium">Failed to load commissions</p>
              <p className="text-sm mt-1">{loadError}</p>
              <button
                onClick={load}
                className="mt-3 px-3 py-1.5 text-sm bg-weathered text-white hover:opacity-90"
              >
                Retry
              </button>
            </div>
          </Container>
        </main>
      </AdminAuthGuard>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <AdminAuthGuard>
      <main className="min-h-screen py-12 bg-bone text-charcoal">
        <Container>
          <div className="space-y-8">

            {/* ── Header ── */}
            <div className="flex flex-wrap justify-between items-start gap-4">
              <div>
                <h1 className="font-[family-name:var(--font-serif)] text-3xl md:text-4xl">
                  Commission Ledger
                </h1>
                <p className="text-sm text-saddle mt-2">
                  Track closed deals and commission payments
                </p>
              </div>
              <div className="flex items-center gap-3">
                <DensityToggle density={density} setDensity={setDensity} />
                <button
                  onClick={() => exportCSV(filteredReferrals)}
                  className="px-3 py-2 text-sm border border-charcoal hover:bg-charcoal hover:text-bone transition-colors"
                  title={`Export ${filteredReferrals.length} rows to CSV`}
                >
                  Export CSV
                </button>
                <Link
                  href="/admin"
                  className="px-4 py-2 text-sm border border-charcoal hover:bg-charcoal hover:text-bone transition-colors"
                >
                  &larr; Back
                </Link>
              </div>
            </div>

            <Divider />

            {/* ── Summary stats ── */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="p-4 border border-dust text-center">
                <div className="font-[family-name:var(--font-serif)] text-3xl">
                  {filteredReferrals.length}
                </div>
                <div className="text-xs text-saddle">Closed Deals</div>
              </div>
              <div className="p-4 border border-dust text-center">
                <div className="font-[family-name:var(--font-serif)] text-3xl">
                  ${totalSales.toLocaleString()}
                </div>
                <div className="text-xs text-saddle">Total Sales</div>
              </div>
              <div className="p-4 border border-sage/40 bg-sage/10 text-center">
                <div className="font-[family-name:var(--font-serif)] text-3xl text-sage-dark">
                  ${totalCommission.toLocaleString()}
                </div>
                <div className="text-xs text-sage-dark font-medium">Total Commission</div>
              </div>
              <div className="p-4 border border-amber/60 bg-amber/10 text-center">
                <div className="font-[family-name:var(--font-serif)] text-3xl text-amber-dark">
                  ${unpaidCommission.toLocaleString()}
                </div>
                <div className="text-xs text-amber-dark font-medium">Unpaid Commission</div>
              </div>
            </div>

            {/* ── Saved views ── */}
            <SavedViewsBar
              views={views}
              onApply={applyView}
              onSaveCurrent={saveCurrentView}
              onDelete={removeView}
            />

            {/* ── Filters toolbar ── */}
            <div className="flex flex-wrap gap-4">
              {/* Month filter */}
              <select
                value={filterMonth}
                onChange={(e) => setFilterMonth(e.target.value)}
                className="px-4 py-2 border border-dust bg-bone text-sm"
              >
                <option value="">All Months</option>
                {months.map((m) => {
                  const [year, month] = m.split('-');
                  const label = new Date(parseInt(year), parseInt(month) - 1).toLocaleString(
                    'en-US',
                    { month: 'long', year: 'numeric' },
                  );
                  return (
                    <option key={m} value={m}>
                      {label}
                    </option>
                  );
                })}
              </select>

              {/* Status filter */}
              <select
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value as FilterStatus)}
                className="px-4 py-2 border border-dust bg-bone text-sm"
              >
                <option value="all">All</option>
                <option value="unpaid">Unpaid Only</option>
                <option value="paid">Paid Only</option>
              </select>

              {/* Per-rancher filter */}
              <select
                value={filterRancher}
                onChange={(e) => setFilterRancher(e.target.value)}
                className="px-4 py-2 border border-dust bg-bone text-sm"
              >
                <option value="">All Ranchers</option>
                {rancherNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>

              {/* Clear all filters */}
              {(filterStatus !== 'all' || filterMonth || filterRancher || query) && (
                <button
                  onClick={() => {
                    setFilterStatus('all');
                    setFilterMonth('');
                    setFilterRancher('');
                    setQuery('');
                  }}
                  className="px-3 py-2 text-xs border border-dust hover:bg-dust"
                >
                  Clear filters
                </button>
              )}
            </div>

            {/* ── Search + sort bar ── */}
            <SearchSortBar
              query={query}
              setQuery={setQuery}
              sortKey={sortKey}
              setSortKey={setSortKey}
              sortOptions={SORT_OPTIONS}
              placeholder="Search rancher, buyer, state, order type…"
              resultCount={filteredReferrals.length}
              totalCount={referrals.length}
            />

            {/* ── Per-rancher payout groups ── */}
            {filteredReferrals.length === 0 ? (
              <p className="text-center py-12 text-saddle">No closed deals match your filters.</p>
            ) : (
              <div className="space-y-6">
                {rancherGroups.map((group) => (
                  <div key={group.name} className="border border-dust">
                    {/* Rancher header row */}
                    <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 bg-charcoal/5 border-b border-dust">
                      <div>
                        <span className="font-medium text-base">{group.name}</span>
                        {(group.email || group.phone) && (
                          <span className="ml-3 text-xs text-saddle">
                            {group.email && (
                              <a
                                href={`mailto:${group.email}`}
                                className="underline hover:text-charcoal mr-2"
                              >
                                {group.email}
                              </a>
                            )}
                            {group.phone && (
                              <a
                                href={`tel:${group.phone}`}
                                className="underline hover:text-charcoal"
                              >
                                {group.phone}
                              </a>
                            )}
                          </span>
                        )}
                      </div>
                      {/* Rancher subtotal */}
                      <div className="flex flex-wrap items-center gap-4 text-sm">
                        <span className="text-saddle">
                          {group.rows.length} deal{group.rows.length !== 1 ? 's' : ''}
                        </span>
                        <span>
                          Sales:{' '}
                          <strong>${group.totalSales.toLocaleString()}</strong>
                        </span>
                        {group.unpaidCommission > 0 && (
                          <span className="px-2 py-0.5 border border-amber/60 bg-amber/10 text-amber-dark font-medium">
                            Owed: ${group.unpaidCommission.toLocaleString()}
                          </span>
                        )}
                        {group.paidCommission > 0 && (
                          <span className="px-2 py-0.5 border border-sage/40 bg-sage/10 text-sage-dark">
                            Paid: ${group.paidCommission.toLocaleString()}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Deal rows for this rancher */}
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-charcoal text-bone">
                            <th className="px-4 py-2 text-left">Buyer</th>
                            <th className="px-4 py-2 text-left">Order</th>
                            <th className="px-4 py-2 text-right">Sale</th>
                            <th className="px-4 py-2 text-right">Commission</th>
                            <th className="px-4 py-2 text-center">Paid</th>
                            <th className="px-4 py-2 text-left">Closed</th>
                          </tr>
                        </thead>
                        <tbody>
                          {group.rows.map((ref) => (
                            <tr key={ref.id} className={`border-b border-dust/30 ${densityPad[density]}`}>
                              <td className={`px-4 ${densityPad[density]}`}>
                                {ref.buyer_name} ({ref.buyer_state})
                              </td>
                              <td className={`px-4 ${densityPad[density]}`}>
                                {ref.order_type || 'N/A'}
                              </td>
                              <td className={`px-4 ${densityPad[density]} text-right`}>
                                ${(ref.sale_amount || 0).toLocaleString()}
                              </td>
                              <td className={`px-4 ${densityPad[density]} text-right font-medium`}>
                                ${(ref.commission_due || 0).toLocaleString()}
                              </td>
                              <td className={`px-4 ${densityPad[density]} text-center`}>
                                <div className="flex items-center justify-center gap-1.5">
                                  <button
                                    onClick={() => togglePaid(ref.id, ref.commission_paid)}
                                    className={`px-3 py-1 text-xs border ${
                                      ref.commission_paid
                                        ? 'bg-sage/15 text-sage-dark border-sage/40'
                                        : 'bg-amber/15 text-amber-dark border-amber/60 hover:bg-amber/25'
                                    }`}
                                  >
                                    {ref.commission_paid ? 'Paid' : 'Mark Paid'}
                                  </button>
                                  <button
                                    onClick={() => openAdjustModal(ref.id, ref.commission_due || 0)}
                                    title="Adjust commission amount"
                                    className="px-2 py-1 text-xs border border-dust hover:bg-bone"
                                  >
                                    ✎
                                  </button>
                                </div>
                              </td>
                              <td className={`px-4 ${densityPad[density]} text-saddle`}>
                                {ref.closed_at
                                  ? new Date(ref.closed_at).toLocaleDateString()
                                  : 'N/A'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Adjust-commission modal ── */}
          {adjustModal && (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
              <div className="bg-white max-w-sm w-full p-6 space-y-4">
                <h3 className="font-[family-name:var(--font-serif)] text-xl">Adjust commission</h3>
                <p className="text-sm text-saddle">
                  Current: <strong>${adjustModal.currentAmount.toFixed(2)}</strong>
                </p>
                <label className="block text-sm">
                  <span className="text-saddle">New amount (USD)</span>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="text-lg">$</span>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={adjustModal.newAmount}
                      onChange={(e) =>
                        setAdjustModal({ ...adjustModal, newAmount: e.target.value })
                      }
                      autoFocus
                      className="flex-1 px-3 py-2 border border-dust bg-bone"
                    />
                  </div>
                </label>
                <label className="block text-sm">
                  <span className="text-saddle">Reason (optional, logged to notes + Telegram)</span>
                  <textarea
                    value={adjustModal.reason}
                    onChange={(e) =>
                      setAdjustModal({ ...adjustModal, reason: e.target.value })
                    }
                    rows={2}
                    className="mt-1 w-full px-3 py-2 border border-dust bg-bone"
                  />
                </label>
                <div className="flex gap-2">
                  <button
                    onClick={submitAdjustCommission}
                    disabled={adjustLoading}
                    className="flex-1 px-4 py-2 bg-charcoal text-bone text-sm font-medium hover:bg-divider disabled:opacity-50"
                  >
                    {adjustLoading ? 'Adjusting…' : 'Adjust'}
                  </button>
                  <button
                    onClick={() => setAdjustModal(null)}
                    disabled={adjustLoading}
                    className="flex-1 px-4 py-2 border border-dust text-sm hover:bg-dust disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          )}
        </Container>
      </main>
    </AdminAuthGuard>
  );
}
