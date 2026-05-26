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

function AdminPaymentsContent() {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [counts, setCounts] = useState<{ payments: number; payouts: number }>({ payments: 0, payouts: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refundingId, setRefundingId] = useState<string>('');

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

  async function refundPayment(p: Payment) {
    const reason = window.prompt(
      `Refund ${dollars(p.amountCents)} from ${p.rancherName} → ${p.buyerName}?\n\nThis fires a Stripe refund on the connected account + clawbacks the application fee. Cannot be undone.\n\nOptional refund reason (requested_by_customer / duplicate / fraudulent):`,
      'requested_by_customer',
    );
    if (reason === null) return; // Cancelled
    setRefundingId(p.id);
    try {
      const res = await fetch(`/api/admin/payments/refund/${encodeURIComponent(p.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ reason: reason || undefined, refundApplicationFee: true }),
      });
      const data = await res.json();
      if (res.ok) {
        await loadData();
        window.alert(`Refund ${data?.refundId || ''} ${data?.status || 'created'}.`);
      } else {
        window.alert(`Refund failed: ${data?.error || 'unknown error'}`);
      }
    } catch (e: any) {
      window.alert(`Refund failed: ${e?.message || 'network error'}`);
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
                                onClick={() => refundPayment(p)}
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
    </Container>
  );
}
