'use client';

import { useState, useEffect } from 'react';
import Container from '../../components/Container';
import Divider from '../../components/Divider';
import AdminAuthGuard from '../../components/AdminAuthGuard';
import Link from 'next/link';

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
  notes: string;
  sale_amount: number;
  commission_due: number;
  commission_paid: boolean;
  created_at: string;
  approved_at: string;
  intro_sent_at: string;
  closed_at: string;
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
  'Pending Approval': 'bg-yellow-100 text-yellow-800 border-yellow-300',
  'Intro Sent': 'bg-blue-100 text-blue-800 border-blue-300',
  'Rancher Contacted': 'bg-indigo-100 text-indigo-800 border-indigo-300',
  'Negotiation': 'bg-purple-100 text-purple-800 border-purple-300',
  'Closed Won': 'bg-green-100 text-green-800 border-green-300',
  'Closed Lost': 'bg-red-100 text-red-800 border-red-300',
  'Dormant': 'bg-gray-100 text-gray-800 border-gray-300',
  'Reassigned': 'bg-orange-100 text-orange-800 border-orange-300',
};

export default function ReferralsPage() {
  const [referrals, setReferrals] = useState<Referral[]>([]);
  const [ranchers, setRanchers] = useState<Rancher[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [reassignModal, setReassignModal] = useState<{ referralId: string; buyerState: string } | null>(null);
  const [saleModal, setSaleModal] = useState<{ referralId: string } | null>(null);
  const [saleAmount, setSaleAmount] = useState('');
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [refRes, ranchRes, statsRes] = await Promise.all([
        fetch('/api/referrals'),
        fetch('/api/admin/ranchers'),
        fetch('/api/admin/referrals/stats'),
      ]);
      const [refData, ranchData, statsData] = await Promise.all([
        refRes.json(),
        ranchRes.json(),
        statsRes.json(),
      ]);
      setReferrals(refData);
      setRanchers(ranchData);
      setStats(statsData);
    } catch (error) {
      console.error('Error fetching referral data:', error);
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
        alert(data.error || 'Failed to approve');
      }
    } catch {
      alert('Error approving referral');
    }
    setActionLoading(null);
  };

  const handleReject = async (id: string) => {
    if (!confirm('Reject this referral?')) return;
    setActionLoading(id);
    try {
      await fetch(`/api/referrals/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'Closed Lost' }),
      });
      await fetchData();
    } catch {
      alert('Error rejecting referral');
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
      await fetch(`/api/referrals/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      await fetchData();
    } catch {
      alert('Error updating status');
    }
    setActionLoading(null);
  };

  const handleCloseDeal = async () => {
    if (!saleModal) return;
    const amount = parseFloat(saleAmount);
    if (isNaN(amount) || amount <= 0) {
      alert('Please enter a valid sale amount');
      return;
    }
    setActionLoading(saleModal.referralId);
    try {
      await fetch(`/api/referrals/${saleModal.referralId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'Closed Won', saleAmount: amount }),
      });
      setSaleModal(null);
      setSaleAmount('');
      await fetchData();
    } catch {
      alert('Error closing deal');
    }
    setActionLoading(null);
  };

  const handleReassign = async (referralId: string, newRancherId: string) => {
    setActionLoading(referralId);
    try {
      await fetch(`/api/referrals/${referralId}/approve`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rancherId: newRancherId }),
      });
      setReassignModal(null);
      await fetchData();
    } catch {
      alert('Error reassigning');
    }
    setActionLoading(null);
  };

  const handleCommissionPaid = async (id: string, paid: boolean) => {
    try {
      await fetch(`/api/referrals/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commissionPaid: paid }),
      });
      await fetchData();
    } catch {
      alert('Error updating commission status');
    }
  };

  const filteredReferrals = filter === 'all'
    ? referrals
    : referrals.filter(r => r.status === filter);

  if (loading) {
    return (
      <AdminAuthGuard>
        <main className="min-h-screen py-24 bg-[#F4F1EC] text-[#0E0E0E]">
          <Container>
            <p className="text-lg text-[#6B4F3F] text-center">Loading referrals...</p>
          </Container>
        </main>
      </AdminAuthGuard>
    );
  }

  return (
    <AdminAuthGuard>
      <main className="min-h-screen py-12 bg-[#F4F1EC] text-[#0E0E0E]">
        <Container>
          <div className="space-y-8">
            <div className="flex flex-wrap justify-between items-start gap-4">
              <div>
                <h1 className="font-[family-name:var(--font-serif)] text-3xl md:text-4xl">
                  Referral Queue
                </h1>
                <p className="text-sm text-[#6B4F3F] mt-2">Manage buyer-rancher referrals</p>
              </div>
              <Link
                href="/admin"
                className="px-4 py-2 text-sm border border-[#0E0E0E] hover:bg-[#0E0E0E] hover:text-[#F4F1EC] transition-colors"
              >
                &larr; Back to Dashboard
              </Link>
            </div>

            <Divider />

            {/* Quick Stats */}
            {stats && (
              <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                <div className="p-4 border border-[#A7A29A] text-center">
                  <div className="font-[family-name:var(--font-serif)] text-3xl">{stats.totalBuyers}</div>
                  <div className="text-xs text-[#6B4F3F]">Total Buyers</div>
                </div>
                <div className="p-4 border border-yellow-400 bg-yellow-50 text-center">
                  <div className="font-[family-name:var(--font-serif)] text-3xl text-yellow-700">{stats.pendingApproval}</div>
                  <div className="text-xs text-yellow-700 font-medium">Pending Approval</div>
                </div>
                <div className="p-4 border border-[#A7A29A] text-center">
                  <div className="font-[family-name:var(--font-serif)] text-3xl">{stats.totalReferrals}</div>
                  <div className="text-xs text-[#6B4F3F]">Total Referrals</div>
                </div>
                <div className="p-4 border border-green-400 bg-green-50 text-center">
                  <div className="font-[family-name:var(--font-serif)] text-3xl text-green-700">{stats.closedDealsThisMonth.count}</div>
                  <div className="text-xs text-green-700 font-medium">Closed This Month</div>
                </div>
                <div className="p-4 border border-green-400 bg-green-50 text-center">
                  <div className="font-[family-name:var(--font-serif)] text-3xl text-green-700">${stats.closedDealsThisMonth.totalCommission.toLocaleString()}</div>
                  <div className="text-xs text-green-700 font-medium">Commission This Month</div>
                </div>
              </div>
            )}

            {/* Filters */}
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setFilter('all')}
                className={`px-4 py-2 text-sm border transition-colors ${filter === 'all' ? 'bg-[#0E0E0E] text-[#F4F1EC] border-[#0E0E0E]' : 'border-[#A7A29A] hover:bg-[#A7A29A]'}`}
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
                    className={`px-4 py-2 text-sm border transition-colors ${filter === s ? 'bg-[#0E0E0E] text-[#F4F1EC] border-[#0E0E0E]' : 'border-[#A7A29A] hover:bg-[#A7A29A]'}`}
                  >
                    {s} ({count})
                  </button>
                );
              })}
            </div>

            {/* Referral Cards */}
            {filteredReferrals.length === 0 ? (
              <div className="text-center py-12 text-[#6B4F3F]">
                <p className="text-lg">No referrals found</p>
                <p className="text-sm mt-2">New buyer submissions will appear here for your review.</p>
              </div>
            ) : (
              <div className="space-y-4">
                {filteredReferrals.map((ref) => (
                  <div key={ref.id} className="p-6 border border-[#A7A29A] bg-white space-y-4">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="flex-1 min-w-[250px]">
                        <div className="flex items-center gap-3 mb-2">
                          <h3 className="font-medium text-lg">{ref.buyer_name}</h3>
                          <span className={`px-2 py-0.5 text-xs border ${STATUS_COLORS[ref.status] || 'bg-gray-100'}`}>
                            {ref.status}
                          </span>
                          {ref.intent_classification && (
                            <span className={`px-2 py-0.5 text-xs border ${
                              ref.intent_classification === 'High' ? 'bg-green-100 text-green-800 border-green-300' :
                              ref.intent_classification === 'Medium' ? 'bg-yellow-100 text-yellow-800 border-yellow-300' :
                              'bg-gray-100 text-gray-600 border-gray-300'
                            }`}>
                              {ref.intent_classification} Intent ({ref.intent_score})
                            </span>
                          )}
                        </div>
                        <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm">
                          <p><span className="text-[#6B4F3F]">State:</span> {ref.buyer_state}</p>
                          <p><span className="text-[#6B4F3F]">Order:</span> {ref.order_type || 'N/A'}</p>
                          <p><span className="text-[#6B4F3F]">Email:</span> {ref.buyer_email}</p>
                          <p><span className="text-[#6B4F3F]">Budget:</span> {ref.budget_range || 'N/A'}</p>
                          <p><span className="text-[#6B4F3F]">Phone:</span> {ref.buyer_phone || 'N/A'}</p>
                        </div>
                        {ref.notes && (
                          <p className="text-sm mt-2 text-[#6B4F3F] italic">&ldquo;{ref.notes}&rdquo;</p>
                        )}
                        {ref.suggested_rancher_name && (
                          <p className="text-sm mt-2">
                            <span className="text-[#6B4F3F]">Suggested Rancher:</span>{' '}
                            <strong>{ref.suggested_rancher_name}</strong> ({ref.suggested_rancher_state})
                          </p>
                        )}
                      </div>

                      <div className="flex flex-col gap-2 min-w-[180px]">
                        {ref.status === 'Pending Approval' && (
                          <>
                            <button
                              onClick={() => handleApprove(ref.id)}
                              disabled={actionLoading === ref.id}
                              className="px-4 py-2 bg-[#0E0E0E] text-[#F4F1EC] text-sm font-medium hover:bg-[#2A2A2A] disabled:opacity-50"
                            >
                              {actionLoading === ref.id ? 'Processing...' : 'Approve & Send Intro'}
                            </button>
                            <button
                              onClick={() => setReassignModal({ referralId: ref.id, buyerState: ref.buyer_state })}
                              className="px-4 py-2 border border-[#0E0E0E] text-sm font-medium hover:bg-[#0E0E0E] hover:text-[#F4F1EC]"
                            >
                              Reassign Rancher
                            </button>
                            <button
                              onClick={() => handleReject(ref.id)}
                              disabled={actionLoading === ref.id}
                              className="px-4 py-2 border border-[#8C2F2F] text-[#8C2F2F] text-sm hover:bg-[#8C2F2F] hover:text-white disabled:opacity-50"
                            >
                              Reject
                            </button>
                          </>
                        )}

                        {ref.status !== 'Pending Approval' && ref.status !== 'Closed Won' && ref.status !== 'Closed Lost' && (
                          <select
                            value={ref.status}
                            onChange={(e) => handleStatusChange(ref.id, e.target.value)}
                            className="px-3 py-2 border border-[#A7A29A] bg-[#F4F1EC] text-sm"
                          >
                            {STATUS_OPTIONS.map(s => (
                              <option key={s} value={s}>{s}</option>
                            ))}
                          </select>
                        )}

                        {ref.status === 'Closed Won' && (
                          <div className="text-sm space-y-1">
                            <p className="font-medium text-green-700">Sale: ${ref.sale_amount.toLocaleString()}</p>
                            <p className="text-[#6B4F3F]">Commission: ${ref.commission_due.toLocaleString()}</p>
                            <button
                              onClick={() => handleCommissionPaid(ref.id, !ref.commission_paid)}
                              className={`px-3 py-1 text-xs border ${
                                ref.commission_paid
                                  ? 'bg-green-100 text-green-800 border-green-300'
                                  : 'bg-yellow-100 text-yellow-800 border-yellow-300'
                              }`}
                            >
                              {ref.commission_paid ? 'Paid' : 'Mark as Paid'}
                            </button>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-4 text-xs text-[#6B4F3F] pt-2 border-t border-[#A7A29A]/30">
                      <span>Created: {new Date(ref.created_at).toLocaleDateString()}</span>
                      {ref.approved_at && <span>Approved: {new Date(ref.approved_at).toLocaleDateString()}</span>}
                      {ref.closed_at && <span>Closed: {new Date(ref.closed_at).toLocaleDateString()}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Reassign Modal */}
          {reassignModal && (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
              <div className="bg-white max-w-md w-full p-6 space-y-4">
                <h3 className="font-[family-name:var(--font-serif)] text-xl">Reassign Rancher</h3>
                <p className="text-sm text-[#6B4F3F]">Select a rancher for this buyer:</p>
                <div className="max-h-60 overflow-y-auto space-y-2">
                  {ranchers
                    .filter(r => r.active_status === 'Active' && r.current_active_referrals < r.max_active_referrals)
                    .map(r => (
                      <button
                        key={r.id}
                        onClick={() => handleReassign(reassignModal.referralId, r.id)}
                        className="w-full text-left p-3 border border-[#A7A29A] hover:bg-[#F4F1EC] transition-colors"
                      >
                        <div className="font-medium">{r.operator_name || r.ranch_name}</div>
                        <div className="text-sm text-[#6B4F3F]">
                          {r.state} &middot; {r.current_active_referrals}/{r.max_active_referrals} referrals
                        </div>
                      </button>
                    ))}
                  {ranchers.filter(r => r.active_status === 'Active').length === 0 && (
                    <p className="text-sm text-[#6B4F3F]">No available ranchers.</p>
                  )}
                </div>
                <button
                  onClick={() => setReassignModal(null)}
                  className="w-full px-4 py-2 border border-[#A7A29A] text-sm hover:bg-[#A7A29A]"
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
                <p className="text-sm text-[#6B4F3F]">Enter the total sale amount:</p>
                <div className="flex items-center gap-2">
                  <span className="text-lg">$</span>
                  <input
                    type="number"
                    value={saleAmount}
                    onChange={(e) => setSaleAmount(e.target.value)}
                    placeholder="0.00"
                    className="flex-1 px-4 py-3 border border-[#A7A29A] bg-[#F4F1EC] text-[#0E0E0E]"
                  />
                </div>
                {saleAmount && !isNaN(parseFloat(saleAmount)) && (
                  <p className="text-sm text-[#6B4F3F]">
                    Commission (10%): <strong>${(parseFloat(saleAmount) * 0.10).toFixed(2)}</strong>
                  </p>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={handleCloseDeal}
                    className="flex-1 px-4 py-2 bg-[#0E0E0E] text-[#F4F1EC] text-sm font-medium hover:bg-[#2A2A2A]"
                  >
                    Close Deal
                  </button>
                  <button
                    onClick={() => { setSaleModal(null); setSaleAmount(''); }}
                    className="flex-1 px-4 py-2 border border-[#A7A29A] text-sm hover:bg-[#A7A29A]"
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
