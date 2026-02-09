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
  ranchers: {
    ranch_name: string;
    operator_name: string;
    email: string;
    state: string;
  };
}

export default function AdminInquiriesPage() {
  const [inquiries, setInquiries] = useState<Inquiry[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
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
      // Commission is 10% by default (configurable via env)
      const commissionRate = parseFloat(process.env.NEXT_PUBLIC_COMMISSION_RATE || '10') / 100;
      const commissionAmount = saleAmount ? saleAmount * commissionRate : null;

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
      case 'pending': return 'bg-yellow-600';
      case 'approved': return 'bg-green-600';
      case 'rejected': return 'bg-[#8C2F2F]';
      case 'sent': return 'bg-[#A7A29A]';
      case 'replied': return 'bg-[#6B4F3F]';
      case 'sale_completed': return 'bg-[#0E0E0E]';
      case 'no_sale': return 'bg-[#8C2F2F]';
      default: return 'bg-[#A7A29A]';
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
    custom: 'Custom Order'
  };

  // Calculate commission summary
  const completedSales = inquiries.filter(i => i.status === 'Sale Completed');
  const totalSales = completedSales.reduce((sum, i) => sum + (i.sale_amount || 0), 0);
  const totalCommission = completedSales.reduce((sum, i) => sum + (i.commission_amount || 0), 0);
  const unpaidCommission = completedSales
    .filter(i => !i.commission_paid)
    .reduce((sum, i) => sum + (i.commission_amount || 0), 0);

  if (loading) {
    return (
      <AdminAuthGuard>
        <main className="min-h-screen py-24 bg-[#F4F1EC] text-[#0E0E0E]">
          <Container>
            <p className="text-center">Loading inquiries...</p>
          </Container>
        </main>
      </AdminAuthGuard>
    );
  }

  return (
    <AdminAuthGuard>
      <main className="min-h-screen py-24 bg-[#F4F1EC] text-[#0E0E0E]">
      <Container>
        <div className="space-y-8">
          {/* Header */}
          <div className="flex justify-between items-start">
            <div>
              <h1 className="font-[family-name:var(--font-serif)] text-4xl mb-2">
                Inquiry Management
              </h1>
              <p className="text-[#6B4F3F]">
                Track member inquiries and commission revenue
              </p>
            </div>
            <div className="flex gap-2">
              <Link 
                href="/admin" 
                className="px-4 py-2 border border-[#0E0E0E] hover:bg-[#0E0E0E] hover:text-[#F4F1EC] transition-colors"
              >
                ← Back to Admin
              </Link>
              <button
                onClick={async () => {
                  await fetch('/api/admin/auth', { method: 'DELETE' });
                  window.location.href = '/admin/login';
                }}
                className="px-4 py-2 text-sm border border-[#8C2F2F] text-[#8C2F2F] hover:bg-[#8C2F2F] hover:text-white transition-colors"
              >
                Logout
              </button>
            </div>
          </div>

          <Divider />

          {/* Commission Summary */}
          <div className="grid md:grid-cols-4 gap-4">
            <div className="p-6 border border-[#A7A29A] bg-white">
              <div className="text-sm text-[#6B4F3F] mb-1">Total Inquiries</div>
              <div className="text-3xl font-[family-name:var(--font-serif)]">
                {inquiries.length}
              </div>
            </div>
            <div className="p-6 border border-[#A7A29A] bg-white">
              <div className="text-sm text-[#6B4F3F] mb-1">Completed Sales</div>
              <div className="text-3xl font-[family-name:var(--font-serif)]">
                {completedSales.length}
              </div>
            </div>
            <div className="p-6 border border-[#A7A29A] bg-white">
              <div className="text-sm text-[#6B4F3F] mb-1">Total Commission</div>
              <div className="text-3xl font-[family-name:var(--font-serif)]">
                ${totalCommission.toFixed(2)}
              </div>
            </div>
            <div className="p-6 border border-[#A7A29A] bg-white">
              <div className="text-sm text-[#6B4F3F] mb-1">Unpaid Commission</div>
              <div className="text-3xl font-[family-name:var(--font-serif)] text-[#8C2F2F]">
                ${unpaidCommission.toFixed(2)}
              </div>
            </div>
          </div>

          <Divider />

          {/* Inquiries List */}
          <div className="space-y-4">
            {inquiries.length === 0 ? (
              <div className="p-12 border border-[#A7A29A] text-center">
                <p className="text-[#6B4F3F]">No inquiries yet.</p>
              </div>
            ) : (
              inquiries.map((inquiry) => (
                <div key={inquiry.id} className="p-6 border border-[#A7A29A] bg-white space-y-4">
                  {editingId === inquiry.id ? (
                    // Edit Mode
                    <div className="space-y-4">
                      <div className="flex justify-between items-start">
                        <div>
                          <h3 className="font-[family-name:var(--font-serif)] text-xl">
                            {inquiry.consumer_name} → {inquiry.ranchers.ranch_name}
                          </h3>
                          <p className="text-sm text-[#6B4F3F]">
                            {formatDate(inquiry.created_at)} • ID: {inquiry.id.slice(0, 8)}
                          </p>
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleUpdate(inquiry.id)}
                            className="px-4 py-2 bg-[#0E0E0E] text-[#F4F1EC] text-sm"
                          >
                            Save
                          </button>
                          <button
                            onClick={() => setEditingId(null)}
                            className="px-4 py-2 border border-[#A7A29A] text-sm"
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
                            className="w-full px-3 py-2 border border-[#A7A29A] bg-[#F4F1EC]"
                          >
                            <option value="Pending">Pending</option>
                            <option value="Approved">Approved</option>
                            <option value="Rejected">Rejected</option>
                            <option value="Replied">Replied</option>
                            <option value="Sale Completed">Sale Completed</option>
                            <option value="No Sale">No Sale</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-sm font-medium mb-2">Sale Amount ($)</label>
                          <input
                            type="number"
                            step="0.01"
                            value={editData.sale_amount}
                            onChange={(e) => setEditData({ ...editData, sale_amount: e.target.value })}
                            className="w-full px-3 py-2 border border-[#A7A29A] bg-[#F4F1EC]"
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
                            className="w-full px-3 py-2 border border-[#A7A29A] bg-[#F4F1EC]"
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
                              {inquiry.consumer_name} → {inquiry.ranchers.ranch_name}
                            </h3>
                            <span className={`px-3 py-1 text-[#F4F1EC] text-xs uppercase ${getStatusColor(inquiry.status)}`}>
                              {inquiry.status.replace('_', ' ')}
                            </span>
                          </div>
                          <p className="text-sm text-[#6B4F3F]">
                            {formatDate(inquiry.created_at)} • {interestLabels[inquiry.interest_type]}
                          </p>
                        </div>
                        <div className="flex gap-2">
                          {inquiry.status === 'Pending' && (
                            <>
                              <button
                                onClick={() => handleApprove(inquiry.id)}
                                className="px-4 py-2 bg-green-600 text-white hover:bg-green-700 transition-colors text-sm font-medium"
                              >
                                ✓ Approve
                              </button>
                              <button
                                onClick={() => handleReject(inquiry.id)}
                                className="px-4 py-2 bg-[#8C2F2F] text-white hover:bg-red-800 transition-colors text-sm font-medium"
                              >
                                ✗ Reject
                              </button>
                            </>
                          )}
                          <button
                            onClick={() => handleEdit(inquiry)}
                            className="px-4 py-2 border border-[#0E0E0E] hover:bg-[#0E0E0E] hover:text-[#F4F1EC] transition-colors text-sm"
                          >
                            Edit
                          </button>
                        </div>
                      </div>

                      <Divider />

                      <div className="grid md:grid-cols-2 gap-6">
                        <div>
                          <h4 className="text-sm font-medium text-[#6B4F3F] mb-2">Consumer</h4>
                          <p className="text-sm">{inquiry.consumer_name}</p>
                          <p className="text-sm text-[#6B4F3F]">{inquiry.consumer_email}</p>
                          <p className="text-sm text-[#6B4F3F]">{inquiry.consumer_phone}</p>
                        </div>
                        <div>
                          <h4 className="text-sm font-medium text-[#6B4F3F] mb-2">Rancher</h4>
                          <p className="text-sm">{inquiry.ranchers.ranch_name}</p>
                          <p className="text-sm text-[#6B4F3F]">{inquiry.ranchers.operator_name}</p>
                          <p className="text-sm text-[#6B4F3F]">{inquiry.ranchers.email}</p>
                        </div>
                      </div>

                      <div className="bg-[#F4F1EC] p-4 border-l-4 border-[#6B4F3F]">
                        <p className="text-sm leading-relaxed">{inquiry.message}</p>
                      </div>

                      {inquiry.sale_amount && (
                        <div className="flex items-center justify-between p-4 bg-[#F4F1EC]">
                          <div>
                            <span className="text-sm text-[#6B4F3F]">Sale Amount:</span>{' '}
                            <span className="font-medium">${inquiry.sale_amount.toFixed(2)}</span>
                          </div>
                          <div>
                            <span className="text-sm text-[#6B4F3F]">Commission (10%):</span>{' '}
                            <span className="font-medium">${inquiry.commission_amount?.toFixed(2)}</span>
                          </div>
                          <div>
                            {inquiry.commission_paid ? (
                              <span className="px-3 py-1 bg-[#0E0E0E] text-[#F4F1EC] text-xs">PAID</span>
                            ) : (
                              <span className="px-3 py-1 bg-[#8C2F2F] text-[#F4F1EC] text-xs">UNPAID</span>
                            )}
                          </div>
                        </div>
                      )}

                      {inquiry.notes && (
                        <div className="text-sm text-[#6B4F3F] italic">
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


