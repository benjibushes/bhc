'use client';

import { useState, useEffect } from 'react';
import Container from '../../components/Container';
import Divider from '../../components/Divider';
import AdminAuthGuard from '../../components/AdminAuthGuard';
import Link from 'next/link';
import { toast } from '@/lib/toast';

interface Referral {
  id: string;
  buyer_name: string;
  buyer_state: string;
  suggested_rancher_name: string;
  status: string;
  sale_amount: number;
  commission_due: number;
  commission_paid: boolean;
  closed_at: string;
  order_type: string;
}

type FilterStatus = 'all' | 'unpaid' | 'paid';

export default function CommissionsPage() {
  const [referrals, setReferrals] = useState<Referral[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all');
  const [filterMonth, setFilterMonth] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  // P1 audit D-4: replace window.prompt() with an inline modal so mobile users
  // and non-mainstream browsers get the same UX, and so the input is validated
  // before the request fires.
  const [adjustModal, setAdjustModal] = useState<{
    id: string;
    currentAmount: number;
    newAmount: string;
    reason: string;
  } | null>(null);
  const [adjustLoading, setAdjustLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/referrals?status=Closed Won');
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const msg = err.error || `HTTP ${res.status}`;
        setLoadError(msg);
        toast.error('Failed to load commissions', msg);
        setLoading(false);
        return;
      }
      const data = await res.json();
      setReferrals(Array.isArray(data) ? data.filter((r: Referral) => r.status === 'Closed Won') : []);
    } catch (e: any) {
      setLoadError(e?.message || 'Network error');
      toast.error('Network error', e?.message);
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const togglePaid = async (id: string, currentPaid: boolean) => {
    // Optimistic update
    setReferrals(prev => prev.map(r =>
      r.id === id ? { ...r, commission_paid: !currentPaid } : r
    ));
    try {
      const res = await fetch(`/api/referrals/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commissionPaid: !currentPaid }),
      });
      if (!res.ok) {
        // Roll back optimistic update on failure
        setReferrals(prev => prev.map(r =>
          r.id === id ? { ...r, commission_paid: currentPaid } : r
        ));
        const data = await res.json().catch(() => ({}));
        toast.error('Update failed', data.error || `HTTP ${res.status}`);
      } else {
        toast.success(currentPaid ? 'Marked as unpaid' : 'Marked as paid');
      }
    } catch (e: any) {
      setReferrals(prev => prev.map(r =>
        r.id === id ? { ...r, commission_paid: currentPaid } : r
      ));
      toast.error('Network error', e?.message);
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
      const res = await fetch(`/api/admin/referrals/${adjustModal.id}/adjust-commission`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commissionDue: amount, reason: adjustModal.reason }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error('Adjustment failed', data.error);
        setAdjustLoading(false);
        return;
      }
      toast.success('Commission adjusted', `$${data.oldAmount.toFixed(2)} → $${data.newAmount.toFixed(2)}`);
      setAdjustModal(null);
      await load();
    } catch (e: any) {
      toast.error('Network error', e?.message);
    }
    setAdjustLoading(false);
  };

  const months = [...new Set(
    referrals
      .filter(r => r.closed_at)
      .map(r => {
        const d = new Date(r.closed_at);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      })
  )].sort().reverse();

  const filtered = referrals.filter(r => {
    if (filterStatus === 'paid' && !r.commission_paid) return false;
    if (filterStatus === 'unpaid' && r.commission_paid) return false;
    if (filterMonth && r.closed_at) {
      const d = new Date(r.closed_at);
      const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (m !== filterMonth) return false;
    }
    return true;
  });

  const totalSales = filtered.reduce((s, r) => s + (r.sale_amount || 0), 0);
  const totalCommission = filtered.reduce((s, r) => s + (r.commission_due || 0), 0);
  const unpaidCommission = filtered.filter(r => !r.commission_paid).reduce((s, r) => s + (r.commission_due || 0), 0);

  if (loading) {
    return (
      <AdminAuthGuard>
        <main className="min-h-screen py-24 bg-bone text-charcoal">
          <Container><p className="text-lg text-saddle text-center">Loading...</p></Container>
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
              <button onClick={load} className="mt-3 px-3 py-1.5 text-sm bg-weathered text-white hover:opacity-90">
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
            <div className="flex flex-wrap justify-between items-start gap-4">
              <div>
                <h1 className="font-[family-name:var(--font-serif)] text-3xl md:text-4xl">Commission Ledger</h1>
                <p className="text-sm text-saddle mt-2">Track closed deals and commission payments</p>
              </div>
              <Link href="/admin" className="px-4 py-2 text-sm border border-charcoal hover:bg-charcoal hover:text-bone transition-colors">
                &larr; Back
              </Link>
            </div>

            <Divider />

            {/* Summary */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="p-4 border border-dust text-center">
                <div className="font-[family-name:var(--font-serif)] text-3xl">{filtered.length}</div>
                <div className="text-xs text-saddle">Closed Deals</div>
              </div>
              <div className="p-4 border border-dust text-center">
                <div className="font-[family-name:var(--font-serif)] text-3xl">${totalSales.toLocaleString()}</div>
                <div className="text-xs text-saddle">Total Sales</div>
              </div>
              <div className="p-4 border border-sage/40 bg-sage/10 text-center">
                <div className="font-[family-name:var(--font-serif)] text-3xl text-sage-dark">${totalCommission.toLocaleString()}</div>
                <div className="text-xs text-sage-dark font-medium">Total Commission</div>
              </div>
              <div className="p-4 border border-amber/60 bg-amber/10 text-center">
                <div className="font-[family-name:var(--font-serif)] text-3xl text-amber-dark">${unpaidCommission.toLocaleString()}</div>
                <div className="text-xs text-amber-dark font-medium">Unpaid Commission</div>
              </div>
            </div>

            {/* Filters */}
            <div className="flex flex-wrap gap-4">
              <select
                value={filterMonth}
                onChange={(e) => setFilterMonth(e.target.value)}
                className="px-4 py-2 border border-dust bg-bone text-sm"
              >
                <option value="">All Months</option>
                {months.map(m => {
                  const [year, month] = m.split('-');
                  const label = new Date(parseInt(year), parseInt(month) - 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
                  return <option key={m} value={m}>{label}</option>;
                })}
              </select>
              <select
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value as FilterStatus)}
                className="px-4 py-2 border border-dust bg-bone text-sm"
              >
                <option value="all">All</option>
                <option value="unpaid">Unpaid Only</option>
                <option value="paid">Paid Only</option>
              </select>
            </div>

            {/* Ledger Table */}
            {filtered.length === 0 ? (
              <p className="text-center py-12 text-saddle">No closed deals found.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-charcoal text-bone">
                      <th className="px-4 py-3 text-left">Rancher</th>
                      <th className="px-4 py-3 text-left">Buyer</th>
                      <th className="px-4 py-3 text-left">Order</th>
                      <th className="px-4 py-3 text-right">Sale Amount</th>
                      <th className="px-4 py-3 text-right">Commission (10%)</th>
                      <th className="px-4 py-3 text-center">Status</th>
                      <th className="px-4 py-3 text-left">Closed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map(ref => (
                      <tr key={ref.id} className="border-b border-dust/30">
                        <td className="px-4 py-3 font-medium">{ref.suggested_rancher_name || 'Unknown'}</td>
                        <td className="px-4 py-3">{ref.buyer_name} ({ref.buyer_state})</td>
                        <td className="px-4 py-3">{ref.order_type || 'N/A'}</td>
                        <td className="px-4 py-3 text-right">${(ref.sale_amount || 0).toLocaleString()}</td>
                        <td className="px-4 py-3 text-right font-medium">${(ref.commission_due || 0).toLocaleString()}</td>
                        <td className="px-4 py-3 text-center">
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
                        <td className="px-4 py-3 text-saddle">
                          {ref.closed_at ? new Date(ref.closed_at).toLocaleDateString() : 'N/A'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* P1 audit D-4: adjust-commission modal — replaces window.prompt */}
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
                      onChange={(e) => setAdjustModal({ ...adjustModal, newAmount: e.target.value })}
                      autoFocus
                      className="flex-1 px-3 py-2 border border-dust bg-bone"
                    />
                  </div>
                </label>
                <label className="block text-sm">
                  <span className="text-saddle">Reason (optional, logged to notes + Telegram)</span>
                  <textarea
                    value={adjustModal.reason}
                    onChange={(e) => setAdjustModal({ ...adjustModal, reason: e.target.value })}
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
