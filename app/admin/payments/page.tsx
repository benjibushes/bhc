'use client';

// Stage-3 Task 12 — admin payments + payouts console.
// Lists Stripe Connect deposits + payouts joined w/ rancher/buyer names.
// Admin can refund a succeeded deposit via the Refund button (calls
// /api/admin/payments/refund/[paymentId] which hits Stripe Refund API on
// the connected account, then markDepositRefunded for instant UI feedback).
//
// Redesign additions (2026-06-18):
//  - SearchSortBar: client-side search + sort via useListSearch
//  - DensityToggle: compact / default / comfortable row height
//  - SavedViewsBar: named filter presets persisted to localStorage
//  - Status filter tabs
//  - Refund modal: correct UI max capped to net-refundable (amountCents -
//    refundedAmountCents), net-remaining displayed
//  - NRD-override section: appears when server returns 412, requires a
//    reason textarea (>=6 chars) + fires re-submit with nrdOverride=true

import { useEffect, useState, useCallback } from 'react';
import Container from '../../components/Container';
import Divider from '../../components/Divider';
import AdminAuthGuard from '../../components/AdminAuthGuard';
import { toast } from '@/lib/toast';
import {
  useListSearch,
  SearchSortBar,
  useDensity,
  densityPad,
  DensityToggle,
  useSavedViews,
  SavedViewsBar,
} from '@/app/admin/components/ListControls';

// ── Types ────────────────────────────────────────────────────────────────────

interface Payment {
  id: string;
  stripePaymentIntentId: string;
  rancherId: string;
  rancherName: string;
  buyerId: string;
  buyerName: string;
  tier: string;
  amountCents: number;
  platformFeeCents: number;
  /** Cumulative amount already refunded (sum of partial refunds). 0 if none. */
  refundedAmountCents: number;
  status: string;
  createdAt: string;
  capturedAt: string;
  refundedAt: string;
}

interface Payout {
  id: string;
  stripeTransferId: string;
  rancherId: string;
  rancherName: string;
  amountCents: number;
  status: string;
  reason: string;
  releasedAt: string;
}

/** View state shape persisted to localStorage as a saved view. */
interface PaymentsViewState {
  query: string;
  sortKey: string;
  statusFilter: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PAGE_KEY = 'payments';

const SEARCH_FIELDS: (keyof Payment)[] = ['rancherName', 'buyerName', 'tier', 'stripePaymentIntentId', 'status'];

const SORT_OPTIONS = [
  { key: '-createdAt', label: 'Newest first' },
  { key: 'createdAt', label: 'Oldest first' },
  { key: '-amountCents', label: 'Largest first' },
  { key: 'amountCents', label: 'Smallest first' },
  { key: 'rancherName', label: 'Rancher A→Z' },
  { key: 'buyerName', label: 'Buyer A→Z' },
  { key: 'status', label: 'Status A→Z' },
];

const STATUS_FILTERS = ['all', 'succeeded', 'pending', 'refunded', 'failed'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function shortTs(ts: string): string {
  if (!ts) return '—';
  try {
    const d = new Date(ts);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return ts;
  }
}

function statusPill(status: string): { label: string; cls: string } {
  switch (status) {
    case 'succeeded':
      return { label: 'Succeeded', cls: 'bg-sage/15 text-sage-dark' };
    case 'pending':
      return { label: 'Pending', cls: 'bg-amber/15 text-amber-dark' };
    case 'refunded':
      return { label: 'Refunded', cls: 'bg-dust/40 text-saddle' };
    case 'failed':
      return { label: 'Failed', cls: 'bg-weathered/15 text-weathered' };
    case 'paid':
      return { label: 'Paid', cls: 'bg-sage/15 text-sage-dark' };
    default:
      return { label: status || '—', cls: 'bg-bone-deep text-saddle' };
  }
}

// ── Page shell ────────────────────────────────────────────────────────────────

export default function AdminPaymentsPage() {
  return (
    <AdminAuthGuard>
      <AdminPaymentsContent />
    </AdminAuthGuard>
  );
}

// ── Refund modal state ────────────────────────────────────────────────────────

type RefundReason = 'requested_by_customer' | 'duplicate' | 'fraudulent';

interface RefundModalState {
  payment: Payment;
  amountDollars: string;
  reason: RefundReason;
  busy: boolean;
  error: string;
  /** When server returns a 412 NRD block, surface NRD override section. */
  nrdBlock: {
    acceptedAt: string;
    hint: string;
  } | null;
  nrdReason: string;
}

// ── Main content ──────────────────────────────────────────────────────────────

function AdminPaymentsContent() {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [counts, setCounts] = useState<{ payments: number; payouts: number }>({ payments: 0, payouts: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refundingId, setRefundingId] = useState<string>('');
  const [modal, setModal] = useState<RefundModalState | null>(null);

  // Status filter tab (pre-search).
  const [statusFilter, setStatusFilter] = useState<string>('all');

  // Density.
  const [density, setDensity] = useDensity(PAGE_KEY);
  const rowPad = densityPad[density];

  // Saved views.
  const { views, save: saveView, remove: removeView } = useSavedViews<PaymentsViewState>(PAGE_KEY);

  // Search + sort over status-filtered slice.
  const statusFiltered = statusFilter === 'all'
    ? payments
    : payments.filter((p) => p.status === statusFilter);

  const { filtered: filteredPayments, query, setQuery, sortKey, setSortKey } = useListSearch(
    statusFiltered,
    { searchFields: SEARCH_FIELDS, sortOptions: SORT_OPTIONS, defaultSort: '-createdAt' },
  );

  // ── Data loading ─────────────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/admin/payments/data', { credentials: 'include' });
      const data = await res.json();
      if (res.ok) {
        setPayments(data.payments || []);
        setPayouts(data.payouts || []);
        setCounts(data.counts || { payments: 0, payouts: 0 });
      } else {
        setError(data?.error || 'Could not load payments.');
      }
    } catch (e: any) {
      setError(e?.message || 'Network error.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // ── Saved-view helpers ────────────────────────────────────────────────────

  function applyView(s: PaymentsViewState) {
    setQuery(s.query);
    setSortKey(s.sortKey);
    setStatusFilter(s.statusFilter);
  }

  function saveCurrentView() {
    const name = window.prompt('View name:')?.trim();
    if (!name) return;
    saveView(name, { query, sortKey, statusFilter });
    toast.success('View saved', name);
  }

  // ── Refund modal ──────────────────────────────────────────────────────────

  function openRefundModal(p: Payment) {
    const netRefundable = Math.max(0, p.amountCents - (p.refundedAmountCents || 0));
    setModal({
      payment: p,
      // Default to full net-refundable remaining (not original, to prevent over-refund).
      amountDollars: (netRefundable / 100).toFixed(2),
      reason: 'requested_by_customer',
      busy: false,
      error: '',
      nrdBlock: null,
      nrdReason: '',
    });
  }

  async function submitRefund(opts?: { nrdOverride?: boolean }) {
    if (!modal) return;
    const p = modal.payment;
    const nrdOverride = opts?.nrdOverride === true;

    // Validate amount.
    const parsed = Number(modal.amountDollars);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setModal({ ...modal, error: 'Amount must be a positive number.' });
      return;
    }
    const amountCents = Math.round(parsed * 100);

    // Cap against net-refundable on the client side.
    const netRefundableCents = Math.max(0, p.amountCents - (p.refundedAmountCents || 0));
    if (amountCents > netRefundableCents) {
      setModal({
        ...modal,
        error: `Amount exceeds net-refundable ${dollars(netRefundableCents)} (${dollars(p.amountCents)} original − ${dollars(p.refundedAmountCents || 0)} already refunded).`,
      });
      return;
    }

    // NRD override: require reason.
    if (nrdOverride) {
      if (!modal.nrdReason || modal.nrdReason.trim().length < 6) {
        setModal({ ...modal, error: 'Override reason must be at least 6 characters.' });
        return;
      }
    }

    const isPartial = amountCents < netRefundableCents;
    const remainingCents = Math.max(0, netRefundableCents - amountCents);
    const confirmMsg = isPartial
      ? `Partial refund of ${dollars(amountCents)} from ${dollars(netRefundableCents)} net-refundable for ${p.rancherName} → ${p.buyerName}?\n\nRemaining after refund: ${dollars(remainingCents)}.\n\nThis cannot be undone.`
      : `Full refund of ${dollars(netRefundableCents)} from ${p.rancherName} → ${p.buyerName}?\n\nThis cannot be undone.`;
    if (!window.confirm(confirmMsg)) return;

    setModal({ ...modal, busy: true, error: '' });
    setRefundingId(p.id);
    try {
      const body: Record<string, any> = {
        reason: modal.reason,
        refundApplicationFee: true,
        // Only pass amountCents when partial — full refunds omit it so the
        // server uses the default full-amount path.
        ...(isPartial ? { amountCents } : {}),
      };
      if (nrdOverride) {
        body.nrdOverride = true;
        body.nrdOverrideReason = modal.nrdReason.trim();
      }

      const res = await fetch(`/api/admin/payments/refund/${encodeURIComponent(p.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const data = await res.json();

      if (res.ok) {
        await loadData();
        setModal(null);
        toast.success(
          `Refund ${data?.status || 'created'}`,
          `${dollars(data?.amount ?? amountCents)} refunded${
            data?.partial ? `, ${dollars(data?.remainingCents ?? 0)} remaining` : ''
          }${data?.refundId ? ` · ${data.refundId}` : ''}`,
        );
      } else if (res.status === 412 && data?.hint) {
        // NRD block — surface override section in modal.
        setModal({
          ...modal,
          busy: false,
          error: data?.error || 'Refund blocked by NRD policy.',
          nrdBlock: {
            acceptedAt: data?.acceptedAt || '',
            hint: data?.hint || '',
          },
        });
      } else {
        setModal({ ...modal, busy: false, error: data?.error || 'unknown error' });
      }
    } catch (e: any) {
      setModal({ ...modal, busy: false, error: e?.message || 'network error' });
    } finally {
      setRefundingId('');
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Container>
      <div className="flex flex-wrap items-start justify-between gap-4 mb-2">
        <div>
          <h1 className="text-3xl font-serif">Payments</h1>
          <p className="text-saddle mt-1 text-sm">
            Stripe Connect deposits + payouts. Refunds fire on the connected account; webhook + audit
            log are best-effort.
          </p>
        </div>
        <DensityToggle density={density} setDensity={setDensity} />
      </div>

      <Divider />

      {loading && <p className="py-6 text-saddle">Loading…</p>}
      {error && (
        <div className="my-4 p-4 bg-weathered/10 border-l-4 border-weathered text-sm text-weathered">{error}</div>
      )}

      {!loading && !error && (
        <>
          {/* ── Payments section ── */}
          <section className="my-6">
            <h2 className="text-xl font-serif mb-3">
              Payments{' '}
              <span className="text-sm text-saddle">
                ({counts.payments} total, showing latest {payments.length})
              </span>
            </h2>

            {/* Saved views */}
            <SavedViewsBar
              views={views}
              onApply={applyView}
              onSaveCurrent={saveCurrentView}
              onDelete={removeView}
            />

            {/* Status filter tabs */}
            <div className="flex flex-wrap gap-2 mb-3">
              {STATUS_FILTERS.map((s) => {
                const count = s === 'all' ? payments.length : payments.filter((p) => p.status === s).length;
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setStatusFilter(s)}
                    className={`px-3 py-1 text-xs border transition-colors ${
                      statusFilter === s
                        ? 'bg-charcoal text-bone border-charcoal'
                        : 'border-dust hover:bg-dust'
                    }`}
                  >
                    {s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)} ({count})
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
              placeholder="Search rancher, buyer, PI, tier, status…"
              resultCount={filteredPayments.length}
              totalCount={statusFiltered.length}
            />

            {filteredPayments.length === 0 ? (
              <p className="text-saddle py-6">
                {query || statusFilter !== 'all' ? 'No payments match your filters.' : 'No payments yet.'}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-widest text-saddle border-b border-divider">
                      <th className="py-2 pr-3">Created</th>
                      <th className="py-2 pr-3">Rancher</th>
                      <th className="py-2 pr-3">Buyer</th>
                      <th className="py-2 pr-3">Tier</th>
                      <th className="py-2 pr-3 text-right">Amount</th>
                      <th className="py-2 pr-3 text-right">Fee</th>
                      <th className="py-2 pr-3 text-right">Refunded</th>
                      <th className="py-2 pr-3 text-right">Net left</th>
                      <th className="py-2 pr-3">Status</th>
                      <th className="py-2 pr-3">PI</th>
                      <th className="py-2 pr-3"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredPayments.map((p) => {
                      const pill = statusPill(p.status);
                      const canRefund = p.status === 'succeeded';
                      const refundedAmt = p.refundedAmountCents || 0;
                      const netLeft = Math.max(0, p.amountCents - refundedAmt);
                      return (
                        <tr key={p.id} className="border-b border-divider/50 hover:bg-bone/50 align-middle">
                          <td className={`${rowPad} pr-3 whitespace-nowrap`}>{shortTs(p.createdAt)}</td>
                          <td className={`${rowPad} pr-3`}>{p.rancherName}</td>
                          <td className={`${rowPad} pr-3`}>{p.buyerName}</td>
                          <td className={`${rowPad} pr-3`}>{p.tier}</td>
                          <td className={`${rowPad} pr-3 text-right tabular-nums`}>{dollars(p.amountCents)}</td>
                          <td className={`${rowPad} pr-3 text-right tabular-nums text-saddle`}>{dollars(p.platformFeeCents)}</td>
                          <td className={`${rowPad} pr-3 text-right tabular-nums ${refundedAmt > 0 ? 'text-weathered' : 'text-saddle'}`}>
                            {refundedAmt > 0 ? dollars(refundedAmt) : '—'}
                          </td>
                          <td className={`${rowPad} pr-3 text-right tabular-nums ${netLeft < p.amountCents && netLeft > 0 ? 'text-amber-dark' : ''}`}>
                            {netLeft > 0 ? dollars(netLeft) : <span className="text-saddle">—</span>}
                          </td>
                          <td className={`${rowPad} pr-3`}>
                            <span className={`inline-block px-2 py-0.5 text-xs rounded ${pill.cls}`}>{pill.label}</span>
                          </td>
                          <td className={`${rowPad} pr-3 text-xs font-mono text-saddle`}>
                            {p.stripePaymentIntentId ? p.stripePaymentIntentId.slice(-10) : '—'}
                          </td>
                          <td className={`${rowPad} pr-3`}>
                            {canRefund && netLeft > 0 && (
                              <button
                                type="button"
                                onClick={() => openRefundModal(p)}
                                disabled={refundingId === p.id}
                                className="px-3 py-1 text-xs font-semibold uppercase tracking-widest border border-weathered text-weathered hover:bg-weathered/10 disabled:opacity-50"
                              >
                                {refundingId === p.id ? 'Refunding…' : 'Refund'}
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <Divider />

          {/* ── Payouts section ── */}
          <section className="my-6">
            <h2 className="text-xl font-serif mb-3">
              Payouts{' '}
              <span className="text-sm text-saddle">
                ({counts.payouts} total, showing latest {payouts.length})
              </span>
            </h2>
            {payouts.length === 0 ? (
              <p className="text-saddle py-6">
                No payouts recorded yet. (Stripe Connect direct charges settle to the rancher&rsquo;s
                bank automatically per the connected account&rsquo;s payout schedule — Payouts rows
                only populate if payout.paid webhook is wired or releasePayout is called manually.)
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-widest text-saddle border-b border-divider">
                      <th className="py-2 pr-3">Released</th>
                      <th className="py-2 pr-3">Rancher</th>
                      <th className="py-2 pr-3 text-right">Amount</th>
                      <th className="py-2 pr-3">Reason</th>
                      <th className="py-2 pr-3">Status</th>
                      <th className="py-2 pr-3">Transfer</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payouts.map((p) => {
                      const pill = statusPill(p.status);
                      return (
                        <tr key={p.id} className={`border-b border-divider/50 hover:bg-bone/50`}>
                          <td className={`${rowPad} pr-3 whitespace-nowrap`}>{shortTs(p.releasedAt)}</td>
                          <td className={`${rowPad} pr-3`}>{p.rancherName}</td>
                          <td className={`${rowPad} pr-3 text-right tabular-nums`}>{dollars(p.amountCents)}</td>
                          <td className={`${rowPad} pr-3`}>{p.reason || '—'}</td>
                          <td className={`${rowPad} pr-3`}>
                            <span className={`inline-block px-2 py-0.5 text-xs rounded ${pill.cls}`}>{pill.label}</span>
                          </td>
                          <td className={`${rowPad} pr-3 text-xs font-mono text-saddle`}>
                            {p.stripeTransferId ? p.stripeTransferId.slice(-10) : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      {/* ── Refund modal ── */}
      {modal && (() => {
        const p = modal.payment;
        const parsed = Number(modal.amountDollars);
        const amountCents = Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) : 0;
        const netRefundableCents = Math.max(0, p.amountCents - (p.refundedAmountCents || 0));
        const isPartial = amountCents > 0 && amountCents < netRefundableCents;
        const remainingCents = Math.max(0, netRefundableCents - amountCents);
        const hasNrdBlock = modal.nrdBlock !== null;
        const nrdReasonOk = modal.nrdReason.trim().length >= 6;

        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/60 p-4"
            onClick={() => !modal.busy && setModal(null)}
          >
            <div
              className="w-full max-w-md bg-bone p-6 border border-divider overflow-y-auto max-h-[90vh]"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-xl font-serif mb-1">Refund</h3>
              <p className="text-sm text-saddle mb-1">
                {p.rancherName} → {p.buyerName}
              </p>
              <div className="flex gap-4 text-xs text-saddle mb-4">
                <span>Original: <strong className="text-charcoal">{dollars(p.amountCents)}</strong></span>
                {(p.refundedAmountCents || 0) > 0 && (
                  <span>Already refunded: <strong className="text-weathered">{dollars(p.refundedAmountCents || 0)}</strong></span>
                )}
                <span>Net refundable: <strong className="text-charcoal">{dollars(netRefundableCents)}</strong></span>
              </div>

              <label className="block text-xs uppercase tracking-widest text-saddle mb-1">
                Amount (USD)
              </label>
              <input
                type="number"
                step="0.01"
                min="0.01"
                max={(netRefundableCents / 100).toFixed(2)}
                value={modal.amountDollars}
                onChange={(e) =>
                  setModal({ ...modal, amountDollars: e.target.value, error: '' })
                }
                disabled={modal.busy}
                className="w-full px-3 py-2 mb-1 border border-divider bg-bone font-mono"
              />
              <p className="text-xs text-saddle mb-4 tabular-nums">
                {isPartial
                  ? `Partial: refunding ${dollars(amountCents)}, ${dollars(remainingCents)} remaining net.`
                  : amountCents > 0 && amountCents === netRefundableCents
                  ? `Full net refund.${(p.refundedAmountCents || 0) > 0 ? ` (${dollars(p.refundedAmountCents || 0)} was previously refunded.)` : ''}`
                  : 'Enter an amount to see split.'}
              </p>

              <label className="block text-xs uppercase tracking-widest text-saddle mb-1">
                Reason
              </label>
              <select
                value={modal.reason}
                onChange={(e) => setModal({ ...modal, reason: e.target.value as RefundReason })}
                disabled={modal.busy}
                className="w-full px-3 py-2 mb-4 border border-divider bg-bone"
              >
                <option value="requested_by_customer">requested_by_customer</option>
                <option value="duplicate">duplicate</option>
                <option value="fraudulent">fraudulent</option>
              </select>

              {/* NRD override section — appears after server returns 412 */}
              {hasNrdBlock && (
                <div className="mb-4 p-4 border-l-4 border-amber bg-amber/10">
                  <p className="text-sm font-semibold text-amber-dark mb-1">
                    Deposit locked — NRD policy
                  </p>
                  <p className="text-xs text-saddle mb-2">
                    Rancher accepted this slot at{' '}
                    <strong>{shortTs(modal.nrdBlock!.acceptedAt)}</strong>. The deposit is
                    non-refundable per the NRD agreement.
                  </p>
                  <p className="text-xs text-saddle mb-3">{modal.nrdBlock!.hint}</p>

                  <label className="block text-xs uppercase tracking-widest text-saddle mb-1">
                    Override reason (min 6 chars — audit-logged)
                  </label>
                  <textarea
                    rows={3}
                    value={modal.nrdReason}
                    onChange={(e) => setModal({ ...modal, nrdReason: e.target.value, error: '' })}
                    disabled={modal.busy}
                    placeholder="Why is this locked deposit being force-refunded? (e.g. rancher cancelled, force majeure, chargeback prevention)"
                    className="w-full px-3 py-2 mb-3 border border-divider bg-bone text-sm resize-y"
                  />

                  <button
                    type="button"
                    onClick={() => submitRefund({ nrdOverride: true })}
                    disabled={modal.busy || !nrdReasonOk}
                    className="w-full px-4 py-2 text-sm font-semibold uppercase tracking-widest bg-amber text-charcoal hover:bg-amber/80 disabled:opacity-50 border border-amber"
                  >
                    {modal.busy ? 'Refunding…' : 'Force refund (NRD override)'}
                  </button>
                </div>
              )}

              {modal.error && (
                <p className="text-sm text-weathered mb-3">{modal.error}</p>
              )}

              <div className="flex gap-3 justify-end pt-2">
                <button
                  type="button"
                  onClick={() => setModal(null)}
                  disabled={modal.busy}
                  className="px-4 py-2 text-sm border border-divider hover:bg-dust/30 disabled:opacity-50"
                >
                  Cancel
                </button>
                {/* Primary submit — not shown if NRD block is active (override section handles it). */}
                {!hasNrdBlock && (
                  <button
                    type="button"
                    onClick={() => submitRefund()}
                    disabled={modal.busy}
                    className="px-4 py-2 text-sm font-semibold uppercase tracking-widest bg-weathered text-bone hover:bg-weathered/90 disabled:opacity-50"
                  >
                    {modal.busy ? 'Refunding…' : isPartial ? 'Partial refund' : 'Refund full'}
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </Container>
  );
}
