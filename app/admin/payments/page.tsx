'use client';

// Stage-3 Task 12 — admin payments + payouts console.
// Lists Stripe Connect deposits + payouts joined w/ rancher/buyer names.
// Admin can refund a succeeded deposit via the Refund button (calls
// /api/admin/payments/refund/[paymentId] which hits Stripe Refund API on
// the connected account, then markDepositRefunded for instant UI feedback).

import { useEffect, useState } from 'react';
import Container from '../../components/Container';
import Divider from '../../components/Divider';
import AdminAuthGuard from '../../components/AdminAuthGuard';

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
      return { label: 'Succeeded', cls: 'bg-green-100 text-green-900' };
    case 'pending':
      return { label: 'Pending', cls: 'bg-amber-100 text-amber-900' };
    case 'refunded':
      return { label: 'Refunded', cls: 'bg-gray-200 text-gray-700' };
    case 'failed':
      return { label: 'Failed', cls: 'bg-red-100 text-red-900' };
    case 'paid':
      return { label: 'Paid', cls: 'bg-green-100 text-green-900' };
    default:
      return { label: status || '—', cls: 'bg-gray-100 text-gray-700' };
  }
}

export default function AdminPaymentsPage() {
  return (
    <AdminAuthGuard>
      <AdminPaymentsContent />
    </AdminAuthGuard>
  );
}

type RefundReason = 'requested_by_customer' | 'duplicate' | 'fraudulent';

interface RefundModalState {
  payment: Payment;
  amountDollars: string;
  reason: RefundReason;
  busy: boolean;
  error: string;
}

function AdminPaymentsContent() {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [counts, setCounts] = useState<{ payments: number; payouts: number }>({ payments: 0, payouts: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refundingId, setRefundingId] = useState<string>('');
  const [modal, setModal] = useState<RefundModalState | null>(null);

  async function loadData() {
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
  }

  useEffect(() => {
    loadData();
  }, []);

  function openRefundModal(p: Payment) {
    setModal({
      payment: p,
      amountDollars: (p.amountCents / 100).toFixed(2),
      reason: 'requested_by_customer',
      busy: false,
      error: '',
    });
  }

  async function submitRefund() {
    if (!modal) return;
    const p = modal.payment;

    // Validate amount.
    const parsed = Number(modal.amountDollars);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setModal({ ...modal, error: 'Amount must be a positive number.' });
      return;
    }
    const amountCents = Math.round(parsed * 100);
    if (amountCents > p.amountCents) {
      setModal({
        ...modal,
        error: `Amount exceeds original ${dollars(p.amountCents)}.`,
      });
      return;
    }
    const isPartial = amountCents < p.amountCents;
    const confirmMsg = isPartial
      ? `Partial refund of ${dollars(amountCents)} from ${dollars(p.amountCents)} for ${p.rancherName} → ${p.buyerName}?\n\nRemaining after refund: ${dollars(p.amountCents - amountCents)}.\n\nThis cannot be undone.`
      : `Full refund of ${dollars(p.amountCents)} from ${p.rancherName} → ${p.buyerName}?\n\nThis cannot be undone.`;
    if (!window.confirm(confirmMsg)) return;

    setModal({ ...modal, busy: true, error: '' });
    setRefundingId(p.id);
    try {
      const res = await fetch(`/api/admin/payments/refund/${encodeURIComponent(p.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          reason: modal.reason,
          refundApplicationFee: true,
          // Only pass amountCents when partial — full refunds omit it so the
          // server uses the default full-amount path.
          ...(isPartial ? { amountCents } : {}),
        }),
      });
      const data = await res.json();
      if (res.ok) {
        await loadData();
        setModal(null);
        window.alert(
          `Refund ${data?.refundId || ''} ${data?.status || 'created'} — ${dollars(data?.amount ?? amountCents)} refunded${
            data?.partial ? `, ${dollars(data?.remainingCents ?? 0)} remaining` : ''
          }.`,
        );
      } else {
        setModal({ ...modal, busy: false, error: data?.error || 'unknown error' });
      }
    } catch (e: any) {
      setModal({ ...modal, busy: false, error: e?.message || 'network error' });
    } finally {
      setRefundingId('');
    }
  }

  return (
    <Container>
      <h1 className="text-3xl font-serif mb-2">Payments</h1>
      <p className="text-saddle mb-6">
        Stripe Connect deposits + payouts. Refunds fire on the connected account; webhook + audit
        log are best-effort.
      </p>
      <Divider />

      {loading && <p className="py-6 text-saddle">Loading…</p>}
      {error && (
        <div className="my-4 p-4 bg-red-50 border-l-4 border-red-600 text-sm text-red-900">{error}</div>
      )}

      {!loading && !error && (
        <>
          <section className="my-6">
            <h2 className="text-xl font-serif mb-3">
              Payments <span className="text-sm text-saddle">({counts.payments} total, showing latest {payments.length})</span>
            </h2>
            {payments.length === 0 ? (
              <p className="text-saddle py-6">No payments yet.</p>
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
                      <th className="py-2 pr-3">Status</th>
                      <th className="py-2 pr-3">PI</th>
                      <th className="py-2 pr-3"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {payments.map((p) => {
                      const pill = statusPill(p.status);
                      const canRefund = p.status === 'succeeded';
                      return (
                        <tr key={p.id} className="border-b border-divider/50 hover:bg-bone/50">
                          <td className="py-2 pr-3 whitespace-nowrap">{shortTs(p.createdAt)}</td>
                          <td className="py-2 pr-3">{p.rancherName}</td>
                          <td className="py-2 pr-3">{p.buyerName}</td>
                          <td className="py-2 pr-3">{p.tier}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{dollars(p.amountCents)}</td>
                          <td className="py-2 pr-3 text-right tabular-nums text-saddle">{dollars(p.platformFeeCents)}</td>
                          <td className="py-2 pr-3">
                            <span className={`inline-block px-2 py-0.5 text-xs rounded ${pill.cls}`}>{pill.label}</span>
                          </td>
                          <td className="py-2 pr-3 text-xs font-mono text-saddle">
                            {p.stripePaymentIntentId ? p.stripePaymentIntentId.slice(-10) : '—'}
                          </td>
                          <td className="py-2 pr-3">
                            {canRefund && (
                              <button
                                type="button"
                                onClick={() => openRefundModal(p)}
                                disabled={refundingId === p.id}
                                className="px-3 py-1 text-xs font-semibold uppercase tracking-widest border border-red-600 text-red-700 hover:bg-red-50 disabled:opacity-50"
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

          <section className="my-6">
            <h2 className="text-xl font-serif mb-3">
              Payouts <span className="text-sm text-saddle">({counts.payouts} total, showing latest {payouts.length})</span>
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
                        <tr key={p.id} className="border-b border-divider/50 hover:bg-bone/50">
                          <td className="py-2 pr-3 whitespace-nowrap">{shortTs(p.releasedAt)}</td>
                          <td className="py-2 pr-3">{p.rancherName}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{dollars(p.amountCents)}</td>
                          <td className="py-2 pr-3">{p.reason || '—'}</td>
                          <td className="py-2 pr-3">
                            <span className={`inline-block px-2 py-0.5 text-xs rounded ${pill.cls}`}>{pill.label}</span>
                          </td>
                          <td className="py-2 pr-3 text-xs font-mono text-saddle">
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

      {modal && (() => {
        const p = modal.payment;
        const parsed = Number(modal.amountDollars);
        const amountCents = Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) : 0;
        const isPartial = amountCents > 0 && amountCents < p.amountCents;
        const remainingCents = Math.max(0, p.amountCents - amountCents);
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/60 p-4"
            onClick={() => !modal.busy && setModal(null)}
          >
            <div
              className="w-full max-w-md bg-bone p-6 border border-divider"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-xl font-serif mb-1">Refund</h3>
              <p className="text-sm text-saddle mb-4">
                {p.rancherName} → {p.buyerName} · Original {dollars(p.amountCents)}
              </p>

              <label className="block text-xs uppercase tracking-widest text-saddle mb-1">
                Amount (USD)
              </label>
              <input
                type="number"
                step="0.01"
                min="0.01"
                max={(p.amountCents / 100).toFixed(2)}
                value={modal.amountDollars}
                onChange={(e) =>
                  setModal({ ...modal, amountDollars: e.target.value, error: '' })
                }
                disabled={modal.busy}
                className="w-full px-3 py-2 mb-1 border border-divider bg-bone font-mono"
              />
              <p className="text-xs text-saddle mb-4 tabular-nums">
                {isPartial
                  ? `Partial: refunding ${dollars(amountCents)}, ${dollars(remainingCents)} remaining.`
                  : amountCents === p.amountCents
                  ? `Full refund.`
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

              {modal.error && (
                <p className="text-sm text-rust mb-3">{modal.error}</p>
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
                <button
                  type="button"
                  onClick={submitRefund}
                  disabled={modal.busy}
                  className="px-4 py-2 text-sm font-semibold uppercase tracking-widest bg-rust text-bone hover:bg-rust/90 disabled:opacity-50"
                >
                  {modal.busy ? 'Refunding…' : isPartial ? 'Partial refund' : 'Refund full'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </Container>
  );
}
