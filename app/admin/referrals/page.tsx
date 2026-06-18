'use client';

import { useState, useEffect } from 'react';
import Container from '../../components/Container';
import Divider from '../../components/Divider';
import AdminAuthGuard from '../../components/AdminAuthGuard';
import Link from 'next/link';
import { toast } from '@/lib/toast';
import { useListSearch, SearchSortBar } from '@/app/admin/components/ListControls';

interface Referral {
  id: string;
  buyer_id: string;
  rancher_id: string;
  suggested_rancher_id: string;
  status: string;
  buyer_name: string;
  buyer_email: string;
  buyer_phone: string;
  buyer_state: string;
  order_type: string;
  budget_range: string;
  intent_score: number;
  intent_classification: string;
  suggested_rancher_name: string;
  suggested_rancher_state: string;
  rancher_email: string;
  rancher_phone: string;
  notes: string;
  sale_amount: number;
  commission_due: number;
  commission_paid: boolean;
  created_at: string;
  approved_at: string;
  intro_sent_at: string;
  closed_at: string;
  chase_count: number;
  last_chased_at: string;
  rancher_reminded_at: string;
  warmup_stage: string;
  warmup_sent_at: string;
  warmup_engaged_at: string;
}

function daysSince(iso: string): number | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (isNaN(ms)) return null;
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

interface Rancher {
  id: string;
  ranch_name: string;
  operator_name: string;
  state: string;
  active_status: string;
  current_active_referrals: number;
  max_active_referrals: number;
}

interface Stats {
  totalBuyers: number;
  totalRanchers: number;
  totalReferrals: number;
  pendingApproval: number;
  closedDealsThisMonth: { count: number; totalCommission: number };
  statusCounts: Record<string, number>;
}

const STATUS_OPTIONS = [
  'Pending Approval',
  'Intro Sent',
  'Rancher Contacted',
  'Negotiation',
  'Closed Won',
  'Closed Lost',
  'Dormant',
  'Reassigned',
];

const STATUS_COLORS: Record<string, string> = {
  'Pending Approval': 'bg-amber/15 text-amber-dark border-amber/60',
  'Intro Sent': 'bg-dust/25 text-saddle border-dust',
  'Rancher Contacted': 'bg-saddle/15 text-saddle border-saddle/40',
  'Negotiation': 'bg-saddle/15 text-saddle border-saddle/40',
  'Closed Won': 'bg-sage/15 text-sage-dark border-sage/40',
  'Closed Lost': 'bg-weathered/15 text-weathered border-weathered/40',
  'Dormant': 'bg-bone-deep text-charcoal border-dust',
  'Reassigned': 'bg-amber/15 text-amber-dark border-amber/60',
};

const SEARCH_FIELDS: (keyof Referral)[] = [
  'buyer_name', 'buyer_email', 'buyer_state', 'order_type',
  'suggested_rancher_name', 'suggested_rancher_state', 'rancher_email',
];
const SORT_OPTIONS = [
  { key: '-created_at', label: 'Newest' },
  { key: 'created_at', label: 'Oldest' },
  { key: '-intent_score', label: 'Highest intent' },
  { key: '-sale_amount', label: 'Largest sale' },
  { key: '-closed_at', label: 'Recently closed' },
];

export default function ReferralsPage() {
  const [referrals, setReferrals] = useState<Referral[]>([]);
  const [ranchers, setRanchers] = useState<Rancher[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [reassignModal, setReassignModal] = useState<{ referralId: string; buyerState: string } | null>(null);
  const [reassignReason, setReassignReason] = useState('');
  const [saleModal, setSaleModal] = useState<{ referralId: string } | null>(null);
  const [saleAmount, setSaleAmount] = useState('');
  // Branded modals replacing window.prompt flows (mobile-hostile, no validation).
  const [adjustModal, setAdjustModal] = useState<{ referralId: string; current: number } | null>(null);
  const [adjustAmount, setAdjustAmount] = useState('');
  const [adjustReason, setAdjustReason] = useState('');
  const [offPlatformModal, setOffPlatformModal] = useState<{ referralId: string } | null>(null);
  const [offPlatformAmount, setOffPlatformAmount] = useState('');
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // P1 audit D-2: bulk select state. Track Set of selected referral IDs +
  // bulk-op in-flight flag so the sticky bar can show a progress spinner.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [refRes, ranchRes, statsRes] = await Promise.all([
        fetch('/api/referrals'),
        fetch('/api/admin/ranchers'),
        fetch('/api/admin/referrals/stats'),
      ]);
      if (!refRes.ok || !ranchRes.ok || !statsRes.ok) {
        const failing = [
          !refRes.ok && `referrals(${refRes.status})`,
          !ranchRes.ok && `ranchers(${ranchRes.status})`,
          !statsRes.ok && `stats(${statsRes.status})`,
        ].filter(Boolean).join(', ');
        setLoadError(`Failed to load: ${failing}`);
        toast.error('Failed to load referrals', failing);
        setLoading(false);
        return;
      }
      const [refData, ranchData, statsData] = await Promise.all([
        refRes.json(),
        ranchRes.json(),
        statsRes.json(),
      ]);
      setReferrals(Array.isArray(refData) ? refData : []);
      setRanchers(Array.isArray(ranchData) ? ranchData : []);
      setStats(statsData);
    } catch (error: any) {
      console.error('Error fetching referral data:', error);
      setLoadError(error?.message || 'Network error');
      toast.error('Network error loading referrals', error?.message);
    }
    setLoading(false);
  };

  const handleApprove = async (id: string) => {
    setActionLoading(id);
    try {
      const res = await fetch(`/api/referrals/${id}/approve`, { method: 'PATCH' });
      const data = await res.json();
      if (data.success) {
        await fetchData();
      } else {
        toast.error('Failed to approve', data.error);
      }
    } catch {
      toast.error('Error approving referral');
    }
    setActionLoading(null);
  };

  const handleReject = async (id: string) => {
    if (!confirm('Reject this referral?')) return;
    setActionLoading(id);
    try {
      const res = await fetch(`/api/referrals/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'Closed Lost' }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error('Failed to reject', data.error);
        setActionLoading(null);
        return;
      }
      await fetchData();
    } catch {
      toast.error('Error rejecting referral');
    }
    setActionLoading(null);
  };

  // REOPEN — restore a Closed Lost referral. Backs /api/admin/referrals/[id]/revive.
  // The revive endpoint clears Closed At + chase throttles and flips Status
  // back to Pending Approval (default) so batch-approve treats it like fresh.
  const handleReopen = async (id: string) => {
    if (!confirm('Reopen this lead? Status will flip back to Pending Approval and the rancher will see it on their dashboard again.')) return;
    setActionLoading(id);
    try {
      const res = await fetch(`/api/admin/referrals/${id}/revive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toStatus: 'Intro Sent' }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || 'revive failed');
      toast.success('Lead reopened');
      await fetchData();
    } catch (e: any) {
      toast.error(e?.message || 'Error reopening lead');
    }
    setActionLoading(null);
  };

  // ADJUST COMMISSION — manually set commission on a Closed Won referral.
  // Common when the legacy rancher closed off-platform at a different price
  // than originally captured. Backs /api/admin/referrals/[id]/adjust-commission.
  const handleAdjustCommission = (id: string, currentCommission: number) => {
    setAdjustAmount(currentCommission.toFixed(2));
    setAdjustReason('');
    setAdjustModal({ referralId: id, current: currentCommission });
  };

  const submitAdjustCommission = async () => {
    if (!adjustModal) return;
    const num = Number(adjustAmount);
    if (!isFinite(num) || num < 0) {
      toast.error('Commission must be a non-negative number');
      return;
    }
    const id = adjustModal.referralId;
    setActionLoading(id);
    try {
      const res = await fetch(`/api/admin/referrals/${id}/adjust-commission`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commissionDue: num, reason: adjustReason.trim() }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || 'adjust failed');
      toast.success('Commission adjusted');
      setAdjustModal(null);
      await fetchData();
    } catch (e: any) {
      toast.error(e?.message || 'Error adjusting commission');
    }
    setActionLoading(null);
  };

  // OFF-PLATFORM CLOSE — revive a Closed Lost referral and immediately close it
  // as Closed Won w/ a sale amount. Common workflow: legacy rancher tells us
  // they actually closed the buyer outside the platform and BHC should
  // count it. Two-step under the hood (revive → close) so it composes with
  // existing handlers.
  const handleMarkOffPlatformWon = (id: string) => {
    setOffPlatformAmount('');
    setOffPlatformModal({ referralId: id });
  };

  const submitOffPlatformWon = async () => {
    if (!offPlatformModal) return;
    const saleNum = Number(offPlatformAmount);
    if (!isFinite(saleNum) || saleNum <= 0) {
      toast.error('Sale must be a positive number');
      return;
    }
    const id = offPlatformModal.referralId;
    setActionLoading(id);
    try {
      // Step 1: revive into Negotiation so the close handler accepts it.
      const reviveRes = await fetch(`/api/admin/referrals/${id}/revive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toStatus: 'Negotiation' }),
      });
      if (!reviveRes.ok) {
        const j = await reviveRes.json().catch(() => ({}));
        throw new Error(j?.error || 'revive failed');
      }
      // Step 2: close as won w/ sale amount (uses /api/referrals/[id] PATCH path).
      const closeRes = await fetch(`/api/referrals/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'Closed Won', saleAmount: saleNum }),
      });
      if (!closeRes.ok) {
        const j = await closeRes.json().catch(() => ({}));
        throw new Error(j?.error || 'close-won failed');
      }
      toast.success('Reopened + marked Won');
      setOffPlatformModal(null);
      await fetchData();
    } catch (e: any) {
      toast.error(e?.message || 'Error');
    }
    setActionLoading(null);
  };

  const handleStatusChange = async (id: string, newStatus: string) => {
    if (newStatus === 'Closed Won') {
      setSaleModal({ referralId: id });
      return;
    }
    setActionLoading(id);
    try {
      const res = await fetch(`/api/referrals/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error('Failed to update status', data.error);
        setActionLoading(null);
        return;
      }
      await fetchData();
    } catch {
      toast.error('Error updating status');
    }
    setActionLoading(null);
  };

  const handleCloseDeal = async () => {
    if (!saleModal) return;
    const amount = parseFloat(saleAmount);
    if (isNaN(amount) || amount <= 0) {
      toast.error('Enter a valid sale amount');
      return;
    }
    setActionLoading(saleModal.referralId);
    try {
      const res = await fetch(`/api/referrals/${saleModal.referralId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'Closed Won', saleAmount: amount }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error('Failed to close deal', data.error);
        setActionLoading(null);
        return;
      }
      setSaleModal(null);
      setSaleAmount('');
      await fetchData();
    } catch {
      toast.error('Error closing deal');
    }
    setActionLoading(null);
  };

  const handleReassign = async (referralId: string, newRancherId: string) => {
    setActionLoading(referralId);
    try {
      // Pending Approval → use the approve endpoint (same as before).
      // Active/mid-flight → use the new admin reassign endpoint which
      // handles capacity rebalancing + fires a fresh intro email.
      const target = referrals.find(r => r.id === referralId);
      const useAdminReassign = target && target.status !== 'Pending Approval';
      if (useAdminReassign) {
        const res = await fetch(`/api/admin/referrals/${referralId}/reassign`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newRancherId, reason: reassignReason.trim() }),
        });
        const data = await res.json();
        if (!res.ok) {
          toast.error('Failed to reassign', data.error);
          setActionLoading(null);
          return;
        }
        toast.success('Reassigned', data.message);
      } else {
        const res = await fetch(`/api/referrals/${referralId}/approve`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rancherId: newRancherId }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          toast.error('Failed to reassign', data.error);
          setActionLoading(null);
          return;
        }
      }
      setReassignModal(null);
      setReassignReason('');
      await fetchData();
    } catch {
      toast.error('Error reassigning');
    }
    setActionLoading(null);
  };

  const handleResendIntro = async (id: string) => {
    if (!confirm('Resend intro email to both the rancher and the buyer?')) return;
    setActionLoading(id);
    try {
      const res = await fetch(`/api/admin/referrals/${id}/resend-intro`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        toast.error('Failed to resend', data.error);
      } else {
        toast.success('Intro resent', `Rancher: ${data.rancherSent ? '✓' : '✗'} · Buyer: ${data.buyerSent ? '✓' : '✗'}`);
        await fetchData();
      }
    } catch {
      toast.error('Error resending intro');
    }
    setActionLoading(null);
  };

  const handleCommissionPaid = async (id: string, paid: boolean) => {
    try {
      const res = await fetch(`/api/referrals/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commissionPaid: paid }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error('Failed to update commission status', data.error);
        return;
      }
      await fetchData();
    } catch {
      toast.error('Error updating commission status');
    }
  };

  // P1 audit D-2: bulk-select helpers
  const toggleSelected = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const clearSelection = () => setSelectedIds(new Set());
  const selectAllVisible = (visibleIds: string[]) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      visibleIds.forEach(id => next.add(id));
      return next;
    });
  };

  const handleBulkApprove = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    if (!confirm(`Approve ${ids.length} referral${ids.length === 1 ? '' : 's'}?`)) return;
    setBulkLoading(true);
    try {
      const res = await fetch('/api/admin/referrals/bulk-approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      const payload = await res.json();
      if (!res.ok) {
        toast.error('Bulk approve failed', payload?.error || `HTTP ${res.status}`);
      } else if (payload.failed > 0) {
        toast.warning(
          `Approved ${payload.approved}/${payload.total}`,
          `${payload.failed} failed (check capacity / status)`,
        );
      } else {
        toast.success(`Approved ${payload.approved}/${payload.total}`);
      }
      clearSelection();
      await fetchData();
    } catch (e: any) {
      toast.error('Bulk approve error', e?.message);
    }
    setBulkLoading(false);
  };

  const handleBulkReject = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    if (!confirm(`Reject (Closed Lost) ${ids.length} referral${ids.length === 1 ? '' : 's'}? This cannot be undone in bulk.`)) return;
    setBulkLoading(true);
    try {
      const res = await fetch('/api/admin/referrals/bulk-reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      const payload = await res.json();
      if (!res.ok) {
        toast.error('Bulk reject failed', payload?.error || `HTTP ${res.status}`);
      } else if (payload.failed > 0) {
        toast.warning(
          `Rejected ${payload.rejected}/${payload.total}`,
          `${payload.failed} failed`,
        );
      } else {
        toast.success(`Rejected ${payload.rejected}/${payload.total}`);
      }
      clearSelection();
      await fetchData();
    } catch (e: any) {
      toast.error('Bulk reject error', e?.message);
    }
    setBulkLoading(false);
  };

  const statusFiltered = filter === 'all'
    ? referrals
    : referrals.filter(r => r.status === filter);
  const { filtered: filteredReferrals, query, setQuery, sortKey, setSortKey } = useListSearch(statusFiltered, {
    searchFields: SEARCH_FIELDS,
    sortOptions: SORT_OPTIONS,
  });

  if (loading) {
    return (
      <AdminAuthGuard>
        <main className="min-h-screen py-24 bg-bone text-charcoal">
          <Container>
            <p className="text-lg text-saddle text-center">Loading referrals...</p>
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
            <div className="flex flex-wrap justify-between items-start gap-4">
              <div>
                <h1 className="font-[family-name:var(--font-serif)] text-3xl md:text-4xl">
                  Referral Queue
                </h1>
                <p className="text-sm text-saddle mt-2">Manage buyer-rancher referrals</p>
              </div>
              <Link
                href="/admin"
                className="px-4 py-2 text-sm border border-charcoal hover:bg-charcoal hover:text-bone transition-colors"
              >
                &larr; Back to Dashboard
              </Link>
            </div>

            <Divider />

            {/* Quick Stats */}
            {stats && (
              <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                <div className="p-4 border border-dust text-center">
                  <div className="font-[family-name:var(--font-serif)] text-3xl">{stats.totalBuyers}</div>
                  <div className="text-xs text-saddle">Total Buyers</div>
                </div>
                <div className="p-4 border border-amber/60 bg-amber/10 text-center">
                  <div className="font-[family-name:var(--font-serif)] text-3xl text-amber-dark">{stats.pendingApproval}</div>
                  <div className="text-xs text-amber-dark font-medium">Pending Approval</div>
                </div>
                <div className="p-4 border border-dust text-center">
                  <div className="font-[family-name:var(--font-serif)] text-3xl">{stats.totalReferrals}</div>
                  <div className="text-xs text-saddle">Total Referrals</div>
                </div>
                <div className="p-4 border border-sage/50 bg-sage/10 text-center">
                  <div className="font-[family-name:var(--font-serif)] text-3xl text-sage-dark">{stats.closedDealsThisMonth.count}</div>
                  <div className="text-xs text-sage-dark font-medium">Closed This Month</div>
                </div>
                <div className="p-4 border border-sage/50 bg-sage/10 text-center">
                  <div className="font-[family-name:var(--font-serif)] text-3xl text-sage-dark">${stats.closedDealsThisMonth.totalCommission.toLocaleString()}</div>
                  <div className="text-xs text-sage-dark font-medium">Commission This Month</div>
                </div>
              </div>
            )}

            {/* Filters */}
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setFilter('all')}
                className={`px-4 py-2 text-sm border transition-colors ${filter === 'all' ? 'bg-charcoal text-bone border-charcoal' : 'border-dust hover:bg-dust'}`}
              >
                All ({referrals.length})
              </button>
              {STATUS_OPTIONS.map(s => {
                const count = referrals.filter(r => r.status === s).length;
                if (count === 0) return null;
                return (
                  <button
                    key={s}
                    onClick={() => setFilter(s)}
                    className={`px-4 py-2 text-sm border transition-colors ${filter === s ? 'bg-charcoal text-bone border-charcoal' : 'border-dust hover:bg-dust'}`}
                  >
                    {s} ({count})
                  </button>
                );
              })}
            </div>

            <SearchSortBar
              query={query}
              setQuery={setQuery}
              sortKey={sortKey}
              setSortKey={setSortKey}
              sortOptions={SORT_OPTIONS}
              placeholder="Search buyer, email, state, rancher…"
              resultCount={filteredReferrals.length}
              totalCount={statusFiltered.length}
            />

            {/* Referral Cards */}
            {filteredReferrals.length === 0 ? (
              <div className="text-center py-12 text-saddle">
                <p className="text-lg">No referrals found</p>
                <p className="text-sm mt-2">New buyer submissions will appear here for your review.</p>
              </div>
            ) : (
              <div className="space-y-4">
                {/* P1 audit D-2: select-all toggle for current filter view */}
                <div className="flex items-center justify-between text-xs text-saddle px-2">
                  <button
                    type="button"
                    onClick={() => {
                      const visibleIds = filteredReferrals.map(r => r.id);
                      const allSelected = visibleIds.every(id => selectedIds.has(id));
                      if (allSelected) {
                        // Deselect just the visible ones
                        setSelectedIds(prev => {
                          const next = new Set(prev);
                          visibleIds.forEach(id => next.delete(id));
                          return next;
                        });
                      } else {
                        selectAllVisible(visibleIds);
                      }
                    }}
                    className="underline hover:text-charcoal"
                  >
                    {filteredReferrals.every(r => selectedIds.has(r.id)) && filteredReferrals.length > 0
                      ? `Deselect all (${filteredReferrals.length})`
                      : `Select all visible (${filteredReferrals.length})`}
                  </button>
                  {selectedIds.size > 0 && (
                    <span>{selectedIds.size} selected</span>
                  )}
                </div>
                {filteredReferrals.map((ref) => (
                  <div
                    key={ref.id}
                    className={`p-6 border bg-white space-y-4 ${
                      selectedIds.has(ref.id) ? 'border-charcoal ring-1 ring-charcoal' : 'border-dust'
                    }`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="flex-1 min-w-[250px]">
                        <div className="flex items-center gap-3 mb-2">
                          {/* P1 audit D-2: per-row select checkbox */}
                          <input
                            type="checkbox"
                            checked={selectedIds.has(ref.id)}
                            onChange={() => toggleSelected(ref.id)}
                            aria-label={`Select ${ref.buyer_name}`}
                            className="w-4 h-4 accent-charcoal cursor-pointer"
                          />
                          <h3 className="font-medium text-lg">{ref.buyer_name}</h3>
                          <span className={`px-2 py-0.5 text-xs border ${STATUS_COLORS[ref.status] || 'bg-bone-deep'}`}>
                            {ref.status}
                          </span>
                          {/* LOCK badge (2026-06-06): visual cue that this referral
                              is locked to its rancher and no auto-path will touch it.
                              Same set as lib/referralLock.ts LOCKED_STATUSES. */}
                          {(['Rancher Contacted', 'Negotiation', 'Awaiting Payment'].includes(ref.status)) && (
                            <span
                              className="px-2 py-0.5 text-xs border bg-saddle/15 text-saddle border-saddle/40"
                              title="LOCKED — rancher is working this lead. No auto-reassign or auto-close. Admin reassign requires unlockOverride."
                            >
                              🔒 Rancher Working
                            </span>
                          )}
                          {ref.intent_classification && (
                            <span className={`px-2 py-0.5 text-xs border ${
                              ref.intent_classification === 'High' ? 'bg-sage/15 text-sage-dark border-sage/40' :
                              ref.intent_classification === 'Medium' ? 'bg-amber/15 text-amber-dark border-amber/60' :
                              'bg-bone-deep text-saddle border-dust'
                            }`}>
                              {ref.intent_classification} Intent ({ref.intent_score})
                            </span>
                          )}
                        </div>
                        <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm">
                          <p><span className="text-saddle">State:</span> {ref.buyer_state}</p>
                          <p><span className="text-saddle">Order:</span> {ref.order_type || 'N/A'}</p>
                          <p><span className="text-saddle">Email:</span> {ref.buyer_email}</p>
                          <p><span className="text-saddle">Budget:</span> {ref.budget_range || 'N/A'}</p>
                          <p><span className="text-saddle">Phone:</span> {ref.buyer_phone || 'N/A'}</p>
                        </div>
                        {ref.notes && (
                          <p className="text-sm mt-2 text-saddle italic">&ldquo;{ref.notes}&rdquo;</p>
                        )}
                        {ref.suggested_rancher_name && (
                          <div className="mt-3 p-3 bg-bone border-l-2 border-charcoal text-sm space-y-1">
                            <p>
                              <span className="text-saddle">Rancher:</span>{' '}
                              <strong>{ref.suggested_rancher_name}</strong> ({ref.suggested_rancher_state})
                            </p>
                            {ref.rancher_email && (
                              <p className="text-xs">
                                <a href={`mailto:${ref.rancher_email}`} className="underline text-charcoal">
                                  📧 {ref.rancher_email}
                                </a>
                                {ref.rancher_phone && (
                                  <>
                                    {' · '}
                                    <a href={`tel:${ref.rancher_phone}`} className="underline text-charcoal">
                                      📱 {ref.rancher_phone}
                                    </a>
                                  </>
                                )}
                              </p>
                            )}
                          </div>
                        )}

                        {/* Stage + activity badges */}
                        <div className="flex flex-wrap gap-1.5 mt-2">
                          {ref.intro_sent_at && ref.status !== 'Closed Won' && ref.status !== 'Closed Lost' && (() => {
                            const d = daysSince(ref.intro_sent_at);
                            return d !== null ? (
                              <span className={`px-2 py-0.5 text-xs border ${d >= 7 ? 'bg-weathered/10 text-weathered border-weathered/40' : d >= 3 ? 'bg-amber/10 text-amber-dark border-amber/60' : 'bg-bone text-saddle border-dust'}`}>
                                Intro sent {d === 0 ? 'today' : `${d}d ago`}
                              </span>
                            ) : null;
                          })()}
                          {ref.chase_count > 0 && (
                            <span className="px-2 py-0.5 text-xs border bg-amber/10 text-amber-dark border-amber/60">
                              Chased {ref.chase_count}/3
                            </span>
                          )}
                          {ref.rancher_reminded_at && (() => {
                            const d = daysSince(ref.rancher_reminded_at);
                            return d !== null ? (
                              <span className="px-2 py-0.5 text-xs border bg-saddle/10 text-saddle border-saddle/40">
                                Rancher nudged {d === 0 ? 'today' : `${d}d ago`}
                              </span>
                            ) : null;
                          })()}
                          {ref.warmup_stage && (
                            <span className={`px-2 py-0.5 text-xs border ${
                              ref.warmup_stage === 'engaged' ? 'bg-sage/10 text-sage-dark border-sage/40' :
                              ref.warmup_stage === 'matched' ? 'bg-dust/15 text-saddle border-dust' :
                              ref.warmup_stage === 'dropped' ? 'bg-bone text-saddle border-dust' :
                              'bg-cyan-50 text-cyan-700 border-cyan-300'
                            }`}>
                              Warmup: {ref.warmup_stage}
                            </span>
                          )}
                        </div>

                        {/* Quick-contact bar */}
                        <div className="flex flex-wrap gap-2 mt-3 text-xs">
                          {ref.buyer_email && (
                            <a
                              href={`mailto:${ref.buyer_email}?subject=${encodeURIComponent(`BuyHalfCow — following up on your interest`)}`}
                              className="px-2 py-1 border border-charcoal hover:bg-charcoal hover:text-bone"
                            >
                              📧 Email Buyer
                            </a>
                          )}
                          {ref.buyer_phone && (
                            <a
                              href={`tel:${ref.buyer_phone}`}
                              className="px-2 py-1 border border-charcoal hover:bg-charcoal hover:text-bone"
                            >
                              📱 Call Buyer
                            </a>
                          )}
                          {ref.buyer_phone && (() => {
                            const first = (ref.buyer_name || '').split(' ')[0] || 'there';
                            const ranch = ref.suggested_rancher_name;
                            const body = ranch
                              ? `Hi ${first}, Ben from BuyHalfCow. We just paired you with ${ranch} in ${ref.buyer_state}. Want me to make the intro this week? Reply YES if still interested.`
                              : `Hi ${first}, Ben from BuyHalfCow. Circling back — we're getting ranchers active in ${ref.buyer_state}. Still want to get matched? Reply YES if yes.`;
                            const href = `sms:${ref.buyer_phone}?&body=${encodeURIComponent(body)}`;
                            return (
                              <a
                                href={href}
                                className="px-2 py-1 border border-charcoal bg-charcoal text-bone hover:bg-divider"
                              >
                                💬 SMS Buyer
                              </a>
                            );
                          })()}
                          {ref.rancher_email && (
                            <a
                              href={`mailto:${ref.rancher_email}?subject=${encodeURIComponent(`Following up on ${ref.buyer_name} lead`)}`}
                              className="px-2 py-1 border border-saddle text-saddle hover:bg-saddle hover:text-bone"
                            >
                              📧 Email Rancher
                            </a>
                          )}
                          {ref.rancher_phone && (
                            <a
                              href={`tel:${ref.rancher_phone}`}
                              className="px-2 py-1 border border-saddle text-saddle hover:bg-saddle hover:text-bone"
                            >
                              📱 Call Rancher
                            </a>
                          )}
                        </div>
                      </div>

                      <div className="flex flex-col gap-2 min-w-[180px]">
                        {ref.status === 'Pending Approval' && (
                          <>
                            <button
                              onClick={() => handleApprove(ref.id)}
                              disabled={actionLoading === ref.id}
                              className="px-4 py-2 bg-charcoal text-bone text-sm font-medium hover:bg-divider disabled:opacity-50"
                            >
                              {actionLoading === ref.id ? 'Processing...' : 'Approve & Send Intro'}
                            </button>
                            <button
                              onClick={() => setReassignModal({ referralId: ref.id, buyerState: ref.buyer_state })}
                              className="px-4 py-2 border border-charcoal text-sm font-medium hover:bg-charcoal hover:text-bone"
                            >
                              Reassign Rancher
                            </button>
                            <button
                              onClick={() => handleReject(ref.id)}
                              disabled={actionLoading === ref.id}
                              className="px-4 py-2 border border-weathered text-weathered text-sm hover:bg-weathered hover:text-white disabled:opacity-50"
                            >
                              Reject
                            </button>
                          </>
                        )}

                        {ref.status !== 'Pending Approval' && ref.status !== 'Closed Won' && ref.status !== 'Closed Lost' && (
                          <>
                            <select
                              value={ref.status}
                              onChange={(e) => handleStatusChange(ref.id, e.target.value)}
                              className="px-3 py-2 border border-dust bg-bone text-sm"
                            >
                              {STATUS_OPTIONS.map(s => (
                                <option key={s} value={s}>{s}</option>
                              ))}
                            </select>
                            <button
                              onClick={() => setReassignModal({ referralId: ref.id, buyerState: ref.buyer_state })}
                              disabled={actionLoading === ref.id}
                              className="px-4 py-2 border border-charcoal text-sm font-medium hover:bg-charcoal hover:text-bone disabled:opacity-50"
                            >
                              🔀 Reroute to different rancher
                            </button>
                            <button
                              onClick={() => handleResendIntro(ref.id)}
                              disabled={actionLoading === ref.id}
                              className="px-4 py-2 border border-saddle text-saddle text-sm hover:bg-saddle hover:text-bone disabled:opacity-50"
                            >
                              {actionLoading === ref.id ? 'Sending…' : '↻ Resend intro email'}
                            </button>
                          </>
                        )}

                        {ref.status === 'Closed Won' && (
                          <div className="text-sm space-y-1">
                            <p className="font-medium text-sage-dark">Sale: ${ref.sale_amount.toLocaleString()}</p>
                            <p className="text-saddle">Commission: ${ref.commission_due.toLocaleString()}</p>
                            <div className="flex gap-2">
                              <button
                                onClick={() => handleCommissionPaid(ref.id, !ref.commission_paid)}
                                className={`px-3 py-1 text-xs border ${
                                  ref.commission_paid
                                    ? 'bg-sage/15 text-sage-dark border-sage/40'
                                    : 'bg-amber/15 text-amber-dark border-amber/60'
                                }`}
                              >
                                {ref.commission_paid ? 'Paid' : 'Mark as Paid'}
                              </button>
                              <button
                                onClick={() => handleAdjustCommission(ref.id, ref.commission_due)}
                                disabled={actionLoading === ref.id}
                                className="px-3 py-1 text-xs border border-charcoal hover:bg-charcoal hover:text-bone disabled:opacity-50"
                                title="Edit commission amount (audit-logged)"
                              >
                                ✎ Edit commission
                              </button>
                            </div>
                          </div>
                        )}

                        {ref.status === 'Closed Lost' && (
                          <div className="flex flex-wrap gap-2 text-sm">
                            <button
                              onClick={() => handleReopen(ref.id)}
                              disabled={actionLoading === ref.id}
                              className="px-3 py-1.5 border border-charcoal text-charcoal hover:bg-charcoal hover:text-bone disabled:opacity-50"
                              title="Restore this lead to active and re-show it to the rancher"
                            >
                              ↺ Reopen
                            </button>
                            <button
                              onClick={() => handleMarkOffPlatformWon(ref.id)}
                              disabled={actionLoading === ref.id}
                              className="px-3 py-1.5 bg-sage-dark text-white hover:bg-sage-dark disabled:opacity-50"
                              title="Rancher closed off-platform — reopen + mark Closed Won with sale amount"
                            >
                              ✓ Mark Won (off-platform)
                            </button>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-4 text-xs text-saddle pt-2 border-t border-dust/30">
                      <span>Created: {new Date(ref.created_at).toLocaleDateString()}</span>
                      {ref.approved_at && <span>Approved: {new Date(ref.approved_at).toLocaleDateString()}</span>}
                      {ref.closed_at && <span>Closed: {new Date(ref.closed_at).toLocaleDateString()}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* P1 audit D-2: sticky bulk-action bar */}
          {selectedIds.size > 0 && (
            <div className="fixed bottom-0 left-0 right-0 z-40 bg-charcoal text-bone shadow-lg">
              <div className="max-w-7xl mx-auto px-4 py-3 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="font-medium">Selected {selectedIds.size}</span>
                  <span className="text-xs text-dust">
                    {(() => {
                      const sel = referrals.filter(r => selectedIds.has(r.id));
                      const pending = sel.filter(r => r.status === 'Pending Approval').length;
                      return `${pending} pending · ${sel.length - pending} other`;
                    })()}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={handleBulkApprove}
                    disabled={bulkLoading}
                    className="px-4 py-2 bg-bone text-charcoal text-sm font-medium hover:bg-white disabled:opacity-50"
                  >
                    {bulkLoading ? 'Approving…' : 'Approve Selected'}
                  </button>
                  <button
                    onClick={handleBulkReject}
                    disabled={bulkLoading}
                    className="px-4 py-2 border border-rust text-rust text-sm hover:bg-rust hover:text-bone disabled:opacity-50"
                  >
                    {bulkLoading ? 'Rejecting…' : 'Reject Selected'}
                  </button>
                  <button
                    onClick={clearSelection}
                    disabled={bulkLoading}
                    className="px-3 py-2 border border-dust text-dust text-sm hover:bg-dust hover:text-charcoal disabled:opacity-50"
                  >
                    Clear
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Reassign Modal */}
          {reassignModal && (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
              <div className="bg-white max-w-md w-full p-6 space-y-4">
                <h3 className="font-[family-name:var(--font-serif)] text-xl">Reassign Rancher</h3>
                <p className="text-sm text-saddle">Select a rancher for this buyer:</p>
                <div className="max-h-60 overflow-y-auto space-y-2">
                  {ranchers
                    .filter(r => r.active_status === 'Active' && r.current_active_referrals < r.max_active_referrals)
                    .map(r => (
                      <button
                        key={r.id}
                        onClick={() => handleReassign(reassignModal.referralId, r.id)}
                        className="w-full text-left p-3 border border-dust hover:bg-bone transition-colors"
                      >
                        <div className="font-medium">{r.operator_name || r.ranch_name}</div>
                        <div className="text-sm text-saddle">
                          {r.state} &middot; {r.current_active_referrals}/{r.max_active_referrals} referrals
                        </div>
                      </button>
                    ))}
                  {ranchers.filter(r => r.active_status === 'Active').length === 0 && (
                    <p className="text-sm text-saddle">No available ranchers.</p>
                  )}
                </div>
                <input
                  type="text"
                  value={reassignReason}
                  onChange={(e) => setReassignReason(e.target.value)}
                  placeholder="Reason (optional — logged to Telegram + notes)"
                  className="w-full px-3 py-2 border border-dust bg-bone text-charcoal text-sm"
                />
                <button
                  onClick={() => { setReassignModal(null); setReassignReason(''); }}
                  className="w-full px-4 py-2 border border-dust text-sm hover:bg-dust"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Sale Amount Modal */}
          {saleModal && (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
              <div className="bg-white max-w-sm w-full p-6 space-y-4">
                <h3 className="font-[family-name:var(--font-serif)] text-xl">Close Deal</h3>
                <p className="text-sm text-saddle">Enter the total sale amount:</p>
                <div className="flex items-center gap-2">
                  <span className="text-lg">$</span>
                  <input
                    type="number"
                    value={saleAmount}
                    onChange={(e) => setSaleAmount(e.target.value)}
                    placeholder="0.00"
                    className="flex-1 px-4 py-3 border border-dust bg-bone text-charcoal"
                  />
                </div>
                {saleAmount && !isNaN(parseFloat(saleAmount)) && (
                  <p className="text-sm text-saddle">
                    Commission (10%): <strong>${(parseFloat(saleAmount) * 0.10).toFixed(2)}</strong>
                  </p>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={handleCloseDeal}
                    className="flex-1 px-4 py-2 bg-charcoal text-bone text-sm font-medium hover:bg-divider"
                  >
                    Close Deal
                  </button>
                  <button
                    onClick={() => { setSaleModal(null); setSaleAmount(''); }}
                    className="flex-1 px-4 py-2 border border-dust text-sm hover:bg-dust"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Adjust Commission Modal — replaces the old window.prompt flow */}
          {adjustModal && (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
              <div className="bg-white max-w-sm w-full p-6 space-y-4">
                <h3 className="font-[family-name:var(--font-serif)] text-xl">Adjust Commission</h3>
                <p className="text-sm text-saddle">
                  Current: <strong>${adjustModal.current.toFixed(2)}</strong>. Set the corrected
                  commission for this Closed Won deal.
                </p>
                <div className="flex items-center gap-2">
                  <span className="text-lg">$</span>
                  <input
                    type="number"
                    value={adjustAmount}
                    onChange={(e) => setAdjustAmount(e.target.value)}
                    placeholder="0.00"
                    autoFocus
                    className="flex-1 px-4 py-3 border border-dust bg-bone text-charcoal"
                  />
                </div>
                <input
                  type="text"
                  value={adjustReason}
                  onChange={(e) => setAdjustReason(e.target.value)}
                  placeholder="Reason for adjustment (audit log)"
                  className="w-full px-3 py-2 border border-dust bg-bone text-charcoal text-sm"
                />
                <div className="flex gap-2">
                  <button
                    onClick={submitAdjustCommission}
                    disabled={actionLoading === adjustModal.referralId}
                    className="flex-1 px-4 py-2 bg-charcoal text-bone text-sm font-medium hover:bg-divider disabled:opacity-50"
                  >
                    {actionLoading === adjustModal.referralId ? 'Saving…' : 'Save Adjustment'}
                  </button>
                  <button
                    onClick={() => setAdjustModal(null)}
                    className="flex-1 px-4 py-2 border border-dust text-sm hover:bg-dust"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Off-Platform Close Modal — replaces the old window.prompt + confirm flow */}
          {offPlatformModal && (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
              <div className="bg-white max-w-sm w-full p-6 space-y-4">
                <h3 className="font-[family-name:var(--font-serif)] text-xl">Off-Platform Close</h3>
                <p className="text-sm text-saddle">
                  Reopens this lost lead and marks it Closed Won at the sale amount below.
                  Commission calcs from the rancher&apos;s rate.
                </p>
                <div className="flex items-center gap-2">
                  <span className="text-lg">$</span>
                  <input
                    type="number"
                    value={offPlatformAmount}
                    onChange={(e) => setOffPlatformAmount(e.target.value)}
                    placeholder="0.00"
                    autoFocus
                    className="flex-1 px-4 py-3 border border-dust bg-bone text-charcoal"
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={submitOffPlatformWon}
                    disabled={actionLoading === offPlatformModal.referralId}
                    className="flex-1 px-4 py-2 bg-charcoal text-bone text-sm font-medium hover:bg-divider disabled:opacity-50"
                  >
                    {actionLoading === offPlatformModal.referralId ? 'Closing…' : 'Reopen + Mark Won'}
                  </button>
                  <button
                    onClick={() => setOffPlatformModal(null)}
                    className="flex-1 px-4 py-2 border border-dust text-sm hover:bg-dust"
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
