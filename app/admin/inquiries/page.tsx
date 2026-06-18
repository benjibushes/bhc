'use client';

import { useState, useEffect } from 'react';
import Container from '../../components/Container';
import Divider from '../../components/Divider';
import Link from 'next/link';
import AdminAuthGuard from '../../components/AdminAuthGuard';

interface Inquiry {
  id: string;
  consumer_name: string;
  consumer_email: string;
  consumer_phone: string;
  message: string;
  interest_type: string;
  status: string;
  sale_amount: number | null;
  commission_amount: number | null;
  commission_paid: boolean;
  notes: string | null;
  created_at: string;
  status_changed_at?: string | null;
  business_name?: string;
  buyer_state?: string;
  matched_ranchers?: { id: string; ranch_name: string; operator_name: string; state: string }[];
  ranchers: {
    ranch_name: string;
    operator_name: string;
    email: string;
    state: string;
  };
}

// Ranchers list for the wholesale match picker. Kept light — only the
// fields we need to render the dropdown w/ state filter.
interface RancherLite {
  id: string;
  ranch_name: string;
  operator_name: string;
  state: string;
}

export default function AdminInquiriesPage() {
  const [inquiries, setInquiries] = useState<Inquiry[]>([]);
  const [ranchers, setRanchers] = useState<RancherLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Wholesale match drawer state — null when no row is in match-mode,
  // otherwise the inquiry ID + selected rancher ID list.
  const [matchingId, setMatchingId] = useState<string | null>(null);
  const [matchSelected, setMatchSelected] = useState<string[]>([]);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [editData, setEditData] = useState<{
    status: string;
    sale_amount: string;
    commission_paid: boolean;
    notes: string;
  }>({
    status: '',
    sale_amount: '',
    commission_paid: false,
    notes: '',
  });

  useEffect(() => {
    fetchInquiries();
    fetchRanchers();
  }, []);

  const fetchInquiries = async () => {
    try {
      const response = await fetch('/api/inquiries');
      const data = await response.json();
      setInquiries(data);
      setLoading(false);
    } catch (error) {
      console.error('Error fetching inquiries:', error);
      setLoading(false);
    }
  };

  // Pull the rancher list once so the wholesale match picker can filter by
  // state without an N+1 lookup per inquiry. We only need a slim shape.
  const fetchRanchers = async () => {
    try {
      const response = await fetch('/api/admin/ranchers');
      const data = await response.json();
      if (Array.isArray(data)) {
        setRanchers(
          data.map((r: any) => ({
            id: r.id,
            ranch_name: r.ranch_name || '',
            operator_name: r.operator_name || '',
            state: r.state || '',
          })),
        );
      }
    } catch (error) {
      console.error('Error fetching ranchers (for wholesale match picker):', error);
    }
  };

  // Wholesale Status step buttons — fire a transition + (when entering
  // Routed) also push the selected rancher IDs in one PATCH. Keeps the
  // round-trip atomic so admin can't accidentally save a "Routed" row
  // without ranchers attached.
  const handleWholesaleTransition = async (
    id: string,
    nextStatus: 'Routed' | 'Quoted' | 'Closed Won' | 'Closed Lost',
    opts?: { matchedRancherIds?: string[]; saleAmount?: number; notes?: string },
  ) => {
    setRowBusy(id);
    try {
      const payload: Record<string, unknown> = { status: nextStatus };
      if (opts?.matchedRancherIds) payload.matchedRancherIds = opts.matchedRancherIds;
      if (opts?.saleAmount !== undefined) payload.sale_amount = opts.saleAmount;
      if (opts?.notes !== undefined) payload.notes = opts.notes;
      const response = await fetch(`/api/inquiries/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        alert(`Failed: ${err?.error || response.status}`);
        return;
      }
      await fetchInquiries();
      // Clean up match drawer state
      setMatchingId(null);
      setMatchSelected([]);
    } catch (error: any) {
      console.error('Wholesale transition failed:', error);
      alert(`Failed: ${error?.message || 'unknown'}`);
    } finally {
      setRowBusy(null);
    }
  };

  const handleMarkClosedWon = async (id: string) => {
    const raw = prompt('Sale amount ($)?');
    if (!raw) return;
    const amt = Number(raw);
    if (!isFinite(amt) || amt <= 0) {
      alert('Sale amount must be a positive number');
      return;
    }
    await handleWholesaleTransition(id, 'Closed Won', { saleAmount: amt });
  };

  const handleMarkClosedLost = async (id: string) => {
    const reason = prompt('Reason for Closed Lost (optional)?') || '';
    // APPEND the reason — never replace Notes, or the structured buyer State /
    // Monthly Volume that readWholesaleField parses out is destroyed. Leave
    // Notes untouched entirely when no reason is given.
    const opts: { notes?: string } = {};
    if (reason.trim()) {
      const existing = (inquiries.find((i) => i.id === id)?.notes || '').trim();
      opts.notes = existing ? `${existing}\n\n[Closed Lost] ${reason.trim()}` : reason.trim();
    }
    await handleWholesaleTransition(id, 'Closed Lost', opts);
  };

  const handleEdit = (inquiry: Inquiry) => {
    setEditingId(inquiry.id);
    setEditData({
      status: inquiry.status,
      sale_amount: inquiry.sale_amount?.toString() || '',
      commission_paid: inquiry.commission_paid,
      notes: inquiry.notes || '',
    });
  };

  const handleApprove = async (id: string) => {
    try {
      const response = await fetch(`/api/inquiries/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'Approved' }),
      });

      if (response.ok) {
        await fetchInquiries();
        alert('Inquiry approved! Rancher has been notified.');
      }
    } catch (error) {
      console.error('Error approving inquiry:', error);
      alert('Failed to approve inquiry.');
    }
  };

  const handleReject = async (id: string) => {
    if (!confirm('Are you sure you want to reject this inquiry? The consumer will not be notified.')) {
      return;
    }

    try {
      const response = await fetch(`/api/inquiries/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'Rejected' }),
      });

      if (response.ok) {
        await fetchInquiries();
      }
    } catch (error) {
      console.error('Error rejecting inquiry:', error);
      alert('Failed to reject inquiry.');
    }
  };

  const handleUpdate = async (id: string) => {
    try {
      const saleAmount = editData.sale_amount ? parseFloat(editData.sale_amount) : null;
      // Commission rate normalized — accepts "10" or "0.10" or "10%". See lib/commission.ts.
      const raw = Number((process.env.NEXT_PUBLIC_COMMISSION_RATE || '0.10').replace('%', ''));
      const commissionRate = !isFinite(raw) || raw <= 0 ? 0.10 : (raw > 1 ? raw / 100 : raw);
      const commissionAmount = saleAmount ? Math.round(saleAmount * commissionRate * 100) / 100 : null;

      const response = await fetch(`/api/inquiries/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: editData.status,
          sale_amount: saleAmount,
          commission_amount: commissionAmount,
          commission_paid: editData.commission_paid,
          notes: editData.notes,
        }),
      });

      if (response.ok) {
        await fetchInquiries();
        setEditingId(null);
      }
    } catch (error) {
      console.error('Error updating inquiry:', error);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status.toLowerCase()) {
      case 'pending': return 'bg-amber-dark';
      case 'approved': return 'bg-sage';
      case 'rejected': return 'bg-weathered';
      case 'sent': return 'bg-dust';
      case 'replied': return 'bg-saddle';
      case 'sale_completed': return 'bg-charcoal';
      case 'no_sale': return 'bg-weathered';
      // Wholesale statuses
      case 'new': return 'bg-amber-dark';
      case 'routed': return 'bg-saddle';
      case 'quoted': return 'bg-charcoal';
      case 'closed won': return 'bg-sage';
      case 'closed lost': return 'bg-weathered';
      default: return 'bg-dust';
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { 
      month: 'short', 
      day: 'numeric', 
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const interestLabels: Record<string, string> = {
    half_cow: 'Half Cow',
    quarter_cow: 'Quarter Cow',
    whole_cow: 'Whole Cow',
    custom: 'Custom Order',
    // Title-cased Airtable values that come straight back from the API:
    'Half Cow': 'Half Cow',
    'Quarter Cow': 'Quarter Cow',
    'Whole Cow': 'Whole Cow',
    'Custom Order': 'Custom Order',
    Wholesale: 'Wholesale (B2B)',
  };

  // Calculate commission summary. Member inquiries close as 'Sale Completed';
  // wholesale inquiries close as 'Closed Won'. Both count toward revenue —
  // excluding 'Closed Won' hid all wholesale ($5-15k AOV) from every card.
  const completedSales = inquiries.filter(i => i.status === 'Sale Completed' || i.status === 'Closed Won');
  const totalSales = completedSales.reduce((sum, i) => sum + (i.sale_amount || 0), 0);
  const totalCommission = completedSales.reduce((sum, i) => sum + (i.commission_amount || 0), 0);
  const unpaidCommission = completedSales
    .filter(i => !i.commission_paid)
    .reduce((sum, i) => sum + (i.commission_amount || 0), 0);

  if (loading) {
    return (
      <AdminAuthGuard>
        <main className="min-h-screen py-24 bg-bone text-charcoal">
          <Container>
            <p className="text-center">Loading inquiries...</p>
          </Container>
        </main>
      </AdminAuthGuard>
    );
  }

  return (
    <AdminAuthGuard>
      <main className="min-h-screen py-24 bg-bone text-charcoal">
      <Container>
        <div className="space-y-8">
          {/* Header */}
          <div className="flex justify-between items-start">
            <div>
              <h1 className="font-[family-name:var(--font-serif)] text-4xl mb-2">
                Inquiry Management
              </h1>
              <p className="text-saddle">
                Track member inquiries and commission revenue
              </p>
            </div>
            <div className="flex gap-2">
              <Link 
                href="/admin" 
                className="px-4 py-2 border border-charcoal hover:bg-charcoal hover:text-bone transition-colors"
              >
                ← Back to Admin
              </Link>
              <button
                onClick={async () => {
                  await fetch('/api/admin/auth', { method: 'DELETE' });
                  window.location.href = '/admin/login';
                }}
                className="px-4 py-2 text-sm border border-weathered text-weathered hover:bg-weathered hover:text-white transition-colors"
              >
                Logout
              </button>
            </div>
          </div>

          <Divider />

          {/* Commission Summary */}
          <div className="grid md:grid-cols-4 gap-4">
            <div className="p-6 border border-dust bg-white">
              <div className="text-sm text-saddle mb-1">Total Inquiries</div>
              <div className="text-3xl font-[family-name:var(--font-serif)]">
                {inquiries.length}
              </div>
            </div>
            <div className="p-6 border border-dust bg-white">
              <div className="text-sm text-saddle mb-1">Completed Sales</div>
              <div className="text-3xl font-[family-name:var(--font-serif)]">
                {completedSales.length}
              </div>
            </div>
            <div className="p-6 border border-dust bg-white">
              <div className="text-sm text-saddle mb-1">Total Commission</div>
              <div className="text-3xl font-[family-name:var(--font-serif)]">
                ${totalCommission.toFixed(2)}
              </div>
            </div>
            <div className="p-6 border border-dust bg-white">
              <div className="text-sm text-saddle mb-1">Unpaid Commission</div>
              <div className="text-3xl font-[family-name:var(--font-serif)] text-weathered">
                ${unpaidCommission.toFixed(2)}
              </div>
            </div>
          </div>

          <Divider />

          {/* Inquiries List */}
          <div className="space-y-4">
            {inquiries.length === 0 ? (
              <div className="p-12 border border-dust text-center">
                <p className="text-saddle">No inquiries yet.</p>
              </div>
            ) : (
              inquiries.map((inquiry) => (
                <div key={inquiry.id} className="p-6 border border-dust bg-white space-y-4">
                  {editingId === inquiry.id ? (
                    // Edit Mode
                    <div className="space-y-4">
                      <div className="flex justify-between items-start">
                        <div>
                          <h3 className="font-[family-name:var(--font-serif)] text-xl">
                            {inquiry.consumer_name} → {inquiry.ranchers.ranch_name}
                          </h3>
                          <p className="text-sm text-saddle">
                            {formatDate(inquiry.created_at)} • ID: {inquiry.id.slice(0, 8)}
                          </p>
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleUpdate(inquiry.id)}
                            className="px-4 py-2 bg-charcoal text-bone text-sm"
                          >
                            Save
                          </button>
                          <button
                            onClick={() => setEditingId(null)}
                            className="px-4 py-2 border border-dust text-sm"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>

                      <div className="grid md:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-sm font-medium mb-2">Status</label>
                          <select
                            value={editData.status}
                            onChange={(e) => setEditData({ ...editData, status: e.target.value })}
                            className="w-full px-3 py-2 border border-dust bg-bone"
                          >
                            {inquiry.interest_type === 'Wholesale' ? (
                              <>
                                <option value="New">New</option>
                                <option value="Routed">Routed</option>
                                <option value="Quoted">Quoted</option>
                                <option value="Closed Won">Closed Won</option>
                                <option value="Closed Lost">Closed Lost</option>
                              </>
                            ) : (
                              <>
                                <option value="Pending">Pending</option>
                                <option value="Approved">Approved</option>
                                <option value="Rejected">Rejected</option>
                                <option value="Replied">Replied</option>
                                <option value="Sale Completed">Sale Completed</option>
                                <option value="No Sale">No Sale</option>
                              </>
                            )}
                          </select>
                        </div>
                        <div>
                          <label className="block text-sm font-medium mb-2">Sale Amount ($)</label>
                          <input
                            type="number"
                            step="0.01"
                            value={editData.sale_amount}
                            onChange={(e) => setEditData({ ...editData, sale_amount: e.target.value })}
                            className="w-full px-3 py-2 border border-dust bg-bone"
                            placeholder="0.00"
                          />
                        </div>
                        <div className="md:col-span-2">
                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={editData.commission_paid}
                              onChange={(e) => setEditData({ ...editData, commission_paid: e.target.checked })}
                              className="w-4 h-4"
                            />
                            <span className="text-sm">Commission Paid</span>
                          </label>
                        </div>
                        <div className="md:col-span-2">
                          <label className="block text-sm font-medium mb-2">Admin Notes</label>
                          <textarea
                            value={editData.notes}
                            onChange={(e) => setEditData({ ...editData, notes: e.target.value })}
                            className="w-full px-3 py-2 border border-dust bg-bone"
                            rows={3}
                            placeholder="Internal notes..."
                          />
                        </div>
                      </div>
                    </div>
                  ) : (
                    // View Mode
                    <>
                      <div className="flex justify-between items-start">
                        <div className="flex-1">
                          <div className="flex items-center gap-3 mb-2">
                            <h3 className="font-[family-name:var(--font-serif)] text-xl">
                              {inquiry.interest_type === 'Wholesale' ? (
                                <>
                                  {inquiry.business_name || inquiry.consumer_name}
                                  <span className="ml-2 text-sm text-saddle font-normal">
                                    ({inquiry.consumer_name})
                                  </span>
                                </>
                              ) : (
                                <>{inquiry.consumer_name} → {inquiry.ranchers.ranch_name}</>
                              )}
                            </h3>
                            <span className={`px-3 py-1 text-bone text-xs uppercase ${getStatusColor(inquiry.status)}`}>
                              {inquiry.status.replace('_', ' ')}
                            </span>
                            {inquiry.interest_type === 'Wholesale' && (
                              <span className="px-2 py-0.5 bg-charcoal text-bone text-[10px] uppercase tracking-wider">
                                B2B
                              </span>
                            )}
                          </div>
                          <p className="text-sm text-saddle">
                            {formatDate(inquiry.created_at)} • {interestLabels[inquiry.interest_type] || inquiry.interest_type}
                            {inquiry.buyer_state ? ` • ${inquiry.buyer_state}` : ''}
                          </p>
                        </div>
                        <div className="flex gap-2">
                          {/* Wholesale step buttons — visible only when row is
                              Wholesale and not yet in a terminal state. The
                              "Match Ranchers" button toggles an inline picker
                              drawer below; the rest are direct transitions. */}
                          {inquiry.interest_type === 'Wholesale' && (
                            <>
                              {inquiry.status === 'New' && (
                                <button
                                  onClick={() => {
                                    setMatchingId(matchingId === inquiry.id ? null : inquiry.id);
                                    setMatchSelected(inquiry.matched_ranchers?.map((m) => m.id) || []);
                                  }}
                                  disabled={rowBusy === inquiry.id}
                                  className="px-4 py-2 bg-saddle text-bone hover:bg-charcoal transition-colors text-sm font-medium disabled:opacity-50"
                                >
                                  {matchingId === inquiry.id ? 'Cancel match' : 'Match ranchers'}
                                </button>
                              )}
                              {inquiry.status === 'Routed' && (
                                <button
                                  onClick={() => handleWholesaleTransition(inquiry.id, 'Quoted')}
                                  disabled={rowBusy === inquiry.id}
                                  className="px-4 py-2 bg-charcoal text-white hover:bg-divider transition-colors text-sm font-medium disabled:opacity-50"
                                >
                                  Mark Quoted
                                </button>
                              )}
                              {(inquiry.status === 'Routed' || inquiry.status === 'Quoted') && (
                                <>
                                  <button
                                    onClick={() => handleMarkClosedWon(inquiry.id)}
                                    disabled={rowBusy === inquiry.id}
                                    className="px-4 py-2 bg-sage text-white hover:bg-sage-dark transition-colors text-sm font-medium disabled:opacity-50"
                                  >
                                    Closed Won
                                  </button>
                                  <button
                                    onClick={() => handleMarkClosedLost(inquiry.id)}
                                    disabled={rowBusy === inquiry.id}
                                    className="px-4 py-2 bg-weathered text-white hover:opacity-90 transition-colors text-sm font-medium disabled:opacity-50"
                                  >
                                    Closed Lost
                                  </button>
                                </>
                              )}
                            </>
                          )}
                          {/* Retail Pending approve/reject — unchanged. */}
                          {inquiry.interest_type !== 'Wholesale' && inquiry.status === 'Pending' && (
                            <>
                              <button
                                onClick={() => handleApprove(inquiry.id)}
                                className="px-4 py-2 bg-sage text-white hover:bg-sage-dark transition-colors text-sm font-medium"
                              >
                                ✓ Approve
                              </button>
                              <button
                                onClick={() => handleReject(inquiry.id)}
                                className="px-4 py-2 bg-weathered text-white hover:opacity-90 transition-colors text-sm font-medium"
                              >
                                ✗ Reject
                              </button>
                            </>
                          )}
                          <button
                            onClick={() => handleEdit(inquiry)}
                            className="px-4 py-2 border border-charcoal hover:bg-charcoal hover:text-bone transition-colors text-sm"
                          >
                            Edit
                          </button>
                        </div>
                      </div>

                      <Divider />

                      <div className="grid md:grid-cols-2 gap-6">
                        <div>
                          <h4 className="text-sm font-medium text-saddle mb-2">
                            {inquiry.interest_type === 'Wholesale' ? 'Buyer Contact' : 'Consumer'}
                          </h4>
                          <p className="text-sm">{inquiry.consumer_name}</p>
                          <p className="text-sm text-saddle">{inquiry.consumer_email}</p>
                          <p className="text-sm text-saddle">{inquiry.consumer_phone}</p>
                        </div>
                        {inquiry.interest_type === 'Wholesale' ? (
                          <div>
                            <h4 className="text-sm font-medium text-saddle mb-2">
                              Matched Ranchers ({inquiry.matched_ranchers?.length || 0})
                            </h4>
                            {!inquiry.matched_ranchers || inquiry.matched_ranchers.length === 0 ? (
                              <p className="text-sm italic text-dust">No ranchers matched yet.</p>
                            ) : (
                              <ul className="space-y-1">
                                {inquiry.matched_ranchers.map((m) => (
                                  <li key={m.id} className="text-sm">
                                    {m.ranch_name || '(no name)'} — {m.operator_name} <span className="text-saddle">({m.state})</span>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        ) : (
                          <div>
                            <h4 className="text-sm font-medium text-saddle mb-2">Rancher</h4>
                            <p className="text-sm">{inquiry.ranchers.ranch_name}</p>
                            <p className="text-sm text-saddle">{inquiry.ranchers.operator_name}</p>
                            <p className="text-sm text-saddle">{inquiry.ranchers.email}</p>
                          </div>
                        )}
                      </div>

                      {/* Wholesale match drawer — inline rancher picker that
                          opens when admin clicks "Match ranchers". Filters
                          ranchers by buyer state by default; admin can flip
                          to "Show all" if they want to ship out-of-state.
                          Submitting fires the Routed transition + attaches
                          the rancher IDs in a single PATCH. */}
                      {matchingId === inquiry.id && inquiry.interest_type === 'Wholesale' && (
                        <WholesaleMatchDrawer
                          inquiry={inquiry}
                          ranchers={ranchers}
                          selected={matchSelected}
                          onToggle={(rid) =>
                            setMatchSelected((prev) =>
                              prev.includes(rid)
                                ? prev.filter((x) => x !== rid)
                                : prev.length < 3
                                ? [...prev, rid]
                                : prev,
                            )
                          }
                          onSubmit={() => {
                            if (matchSelected.length === 0) {
                              alert('Pick at least one rancher to route to.');
                              return;
                            }
                            handleWholesaleTransition(inquiry.id, 'Routed', {
                              matchedRancherIds: matchSelected,
                            });
                          }}
                          busy={rowBusy === inquiry.id}
                        />
                      )}

                      <div className="bg-bone p-4 border-l-4 border-saddle">
                        <p className="text-sm leading-relaxed whitespace-pre-line">{inquiry.message}</p>
                      </div>

                      {inquiry.sale_amount && (
                        <div className="flex items-center justify-between p-4 bg-bone">
                          <div>
                            <span className="text-sm text-saddle">Sale Amount:</span>{' '}
                            <span className="font-medium">${inquiry.sale_amount.toFixed(2)}</span>
                          </div>
                          <div>
                            <span className="text-sm text-saddle">Commission (10%):</span>{' '}
                            <span className="font-medium">${inquiry.commission_amount?.toFixed(2)}</span>
                          </div>
                          <div>
                            {inquiry.commission_paid ? (
                              <span className="px-3 py-1 bg-charcoal text-bone text-xs">PAID</span>
                            ) : (
                              <span className="px-3 py-1 bg-weathered text-bone text-xs">UNPAID</span>
                            )}
                          </div>
                        </div>
                      )}

                      {inquiry.notes && (
                        <div className="text-sm text-saddle italic">
                          <strong>Notes:</strong> {inquiry.notes}
                        </div>
                      )}
                    </>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </Container>
    </main>
    </AdminAuthGuard>
  );
}

// Inline rancher picker for wholesale matches. Defaults to filtering by the
// buyer's state (most matches stay in-state for shipping cost reasons) but
// admin can flip to "All states" if they want to route cross-country. Caps
// the selection at 3 to keep the rancher introductions manageable.
function WholesaleMatchDrawer({
  inquiry,
  ranchers,
  selected,
  onToggle,
  onSubmit,
  busy,
}: {
  inquiry: Inquiry;
  ranchers: RancherLite[];
  selected: string[];
  onToggle: (rid: string) => void;
  onSubmit: () => void;
  busy: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const buyerState = (inquiry.buyer_state || '').toUpperCase();
  const filtered = showAll || !buyerState
    ? ranchers
    : ranchers.filter((r) => (r.state || '').toUpperCase() === buyerState);

  return (
    <div className="p-4 border border-saddle bg-white space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium">
          Pick up to 3 ranchers to route this wholesale buyer to
        </h4>
        <label className="text-xs flex items-center gap-2 text-saddle">
          <input
            type="checkbox"
            checked={showAll}
            onChange={(e) => setShowAll(e.target.checked)}
          />
          Show ranchers from all states
        </label>
      </div>
      {buyerState && (
        <p className="text-xs text-saddle">
          Filtering by buyer state: <strong>{buyerState}</strong>
          {filtered.length === 0 && ' — no ranchers in this state. Toggle "Show all" to pick from anywhere.'}
        </p>
      )}
      <div className="max-h-64 overflow-y-auto border border-dust">
        {filtered.length === 0 ? (
          <p className="p-3 text-sm italic text-dust">No ranchers to show.</p>
        ) : (
          <ul className="divide-y divide-bone">
            {filtered.map((r) => {
              const checked = selected.includes(r.id);
              const disabled = !checked && selected.length >= 3;
              return (
                <li key={r.id} className="flex items-center gap-2 p-2 hover:bg-bone">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled}
                    onChange={() => onToggle(r.id)}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm truncate">
                      {r.ranch_name || '(unnamed)'} <span className="text-saddle">— {r.operator_name}</span>
                    </p>
                    <p className="text-xs text-dust">{r.state}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="flex justify-between items-center">
        <p className="text-xs text-saddle">{selected.length}/3 picked</p>
        <button
          onClick={onSubmit}
          disabled={busy || selected.length === 0}
          className="px-4 py-2 bg-charcoal text-bone text-sm font-medium disabled:opacity-50"
        >
          {busy ? 'Routing…' : `Route to ${selected.length || '0'} rancher${selected.length === 1 ? '' : 's'}`}
        </button>
      </div>
    </div>
  );
}


