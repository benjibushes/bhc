'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Container from '../../../components/Container';
import Divider from '../../../components/Divider';
import Link from 'next/link';
import AdminAuthGuard from '../../../components/AdminAuthGuard';

interface ConsumerDetail {
  id: string;
  first_name: string;
  email: string;
  phone: string;
  state: string;
  interests: string[];
  status: string;
  membership: string;
  order_type: string;
  budget_range: string;
  notes: string;
  lead_source: string;
  intent_score: number;
  intent_classification: string;
  referral_status: string;
  admin_notes: string;
  last_contacted: string;
  campaign: string;
  created_at: string;
}

export default function ConsumerDetailPage() {
  const params = useParams();
  const [consumer, setConsumer] = useState<ConsumerDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [adminNotes, setAdminNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  useEffect(() => {
    fetchConsumer();
  }, []);

  const fetchConsumer = async () => {
    try {
      const res = await fetch(`/api/admin/consumers/${params.id}`);
      if (!res.ok) throw new Error('Consumer not found');
      const data = await res.json();
      setConsumer(data);
      setAdminNotes(data.admin_notes || '');
    } catch (err: any) {
      setError(err.message);
    }
    setLoading(false);
  };

  const saveNotes = async () => {
    if (!consumer) return;
    setSaving(true);
    setSaveSuccess(false);
    try {
      await fetch(`/api/admin/consumers/${consumer.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_notes: adminNotes }),
      });
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
    } catch {
      alert('Failed to save notes');
    }
    setSaving(false);
  };

  const logCall = async () => {
    if (!consumer) return;
    try {
      await fetch(`/api/admin/consumers/${consumer.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ last_contacted: new Date().toISOString() }),
      });
      fetchConsumer();
    } catch {
      alert('Failed to log call');
    }
  };

  const updateStatus = async (field: string, value: string) => {
    if (!consumer) return;
    try {
      await fetch(`/api/admin/consumers/${consumer.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      });
      fetchConsumer();
    } catch {
      alert('Failed to update');
    }
  };

  if (loading) {
    return (
      <AdminAuthGuard>
        <main className="min-h-screen py-24 bg-bone-white text-charcoal-black">
          <Container><p className="text-center text-saddle-brown">Loading...</p></Container>
        </main>
      </AdminAuthGuard>
    );
  }

  if (error || !consumer) {
    return (
      <AdminAuthGuard>
        <main className="min-h-screen py-24 bg-bone-white text-charcoal-black">
          <Container>
            <div className="text-center space-y-4">
              <h1 className="font-serif text-3xl">Consumer Not Found</h1>
              <p className="text-saddle-brown">{error || 'This consumer does not exist.'}</p>
              <Link href="/admin" className="inline-block px-6 py-3 border border-charcoal-black hover:bg-charcoal-black hover:text-bone-white">
                Back to Admin
              </Link>
            </div>
          </Container>
        </main>
      </AdminAuthGuard>
    );
  }

  const intentColor = consumer.intent_classification === 'High'
    ? 'bg-green-100 text-green-800 border-green-300'
    : consumer.intent_classification === 'Medium'
    ? 'bg-yellow-100 text-yellow-800 border-yellow-300'
    : 'bg-gray-100 text-gray-600 border-gray-300';

  return (
    <AdminAuthGuard>
      <main className="min-h-screen py-12 bg-bone-white text-charcoal-black">
        <Container>
          <div className="max-w-4xl mx-auto space-y-8">
            <div className="flex justify-between items-start">
              <div>
                <Link href="/admin" className="text-sm text-saddle-brown hover:text-charcoal-black mb-2 inline-block">
                  &larr; Back to Admin
                </Link>
                <h1 className="font-serif text-3xl md:text-4xl">
                  {consumer.first_name}
                </h1>
              </div>
              <div className="flex items-center gap-2">
                {consumer.intent_classification && (
                  <span className={`px-3 py-1 text-sm font-medium border ${intentColor}`}>
                    {consumer.intent_classification} Intent ({consumer.intent_score})
                  </span>
                )}
              </div>
            </div>

            <Divider />

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="p-6 border border-dust-gray bg-white space-y-3">
                <h2 className="font-serif text-xl">Contact</h2>
                <div className="space-y-2 text-sm">
                  <p><span className="text-saddle-brown">Email:</span> <a href={`mailto:${consumer.email}`} className="underline">{consumer.email}</a></p>
                  <p>
                    <span className="text-saddle-brown">Phone:</span>{' '}
                    {consumer.phone
                      ? <a href={`tel:${consumer.phone}`} className="underline font-medium">{consumer.phone}</a>
                      : <span className="text-dust-gray">Not provided</span>
                    }
                  </p>
                  <p><span className="text-saddle-brown">State:</span> {consumer.state || 'N/A'}</p>
                  <p><span className="text-saddle-brown">Applied:</span> {new Date(consumer.created_at).toLocaleDateString()}</p>
                  {consumer.last_contacted && (
                    <p><span className="text-saddle-brown">Last Contacted:</span> {new Date(consumer.last_contacted).toLocaleDateString()}</p>
                  )}
                </div>
                <div className="flex gap-2 pt-2">
                  {consumer.phone && (
                    <button
                      onClick={() => { logCall(); window.open(`tel:${consumer.phone}`); }}
                      className="px-4 py-2 text-sm bg-green-700 text-white hover:bg-green-800"
                    >
                      Call & Log
                    </button>
                  )}
                </div>
              </div>

              <div className="p-6 border border-dust-gray bg-white space-y-3">
                <h2 className="font-serif text-xl">Purchase Intent</h2>
                <div className="space-y-2 text-sm">
                  <p><span className="text-saddle-brown">Order Type:</span> {consumer.order_type || 'N/A'}</p>
                  <p><span className="text-saddle-brown">Budget:</span> {consumer.budget_range || 'N/A'}</p>
                  <p><span className="text-saddle-brown">Interests:</span> {consumer.interests?.join(', ') || 'N/A'}</p>
                  {consumer.lead_source && <p><span className="text-saddle-brown">Lead Source:</span> {consumer.lead_source}</p>}
                  {consumer.campaign && <p><span className="text-saddle-brown">Campaign:</span> {consumer.campaign}</p>}
                  <p><span className="text-saddle-brown">Referral Status:</span> {consumer.referral_status}</p>
                </div>
                {consumer.notes && (
                  <div className="mt-2 p-3 bg-bone-white text-sm italic">
                    &quot;{consumer.notes}&quot;
                  </div>
                )}
              </div>
            </div>

            <div className="p-6 border border-dust-gray bg-white">
              <h2 className="font-serif text-xl mb-4">Status</h2>
              <div className="flex flex-wrap gap-4">
                <div>
                  <label className="block text-xs text-saddle-brown mb-1">Application Status</label>
                  <select
                    value={consumer.status}
                    onChange={(e) => updateStatus('status', e.target.value)}
                    className="px-4 py-2 border border-dust-gray bg-bone-white text-sm"
                  >
                    <option value="pending">Pending</option>
                    <option value="approved">Approved</option>
                    <option value="rejected">Rejected</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-saddle-brown mb-1">Membership</label>
                  <select
                    value={consumer.membership}
                    onChange={(e) => updateStatus('membership', e.target.value)}
                    className="px-4 py-2 border border-dust-gray bg-bone-white text-sm"
                  >
                    <option value="none">No Access</option>
                    <option value="active">Active Member</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="p-6 border border-dust-gray bg-white space-y-4">
              <h2 className="font-serif text-xl">Admin Notes</h2>
              <textarea
                value={adminNotes}
                onChange={(e) => setAdminNotes(e.target.value)}
                placeholder="Call outcome, next steps, verification notes..."
                rows={6}
                className="w-full px-4 py-3 border border-dust-gray bg-bone-white text-sm"
              />
              <div className="flex items-center gap-3">
                <button
                  onClick={saveNotes}
                  disabled={saving}
                  className="px-6 py-3 bg-charcoal-black text-bone-white text-sm font-medium hover:bg-divider disabled:opacity-50"
                >
                  {saving ? 'Saving...' : 'Save Notes'}
                </button>
                {saveSuccess && <span className="text-sm text-green-700">Saved!</span>}
              </div>
            </div>
          </div>
        </Container>
      </main>
    </AdminAuthGuard>
  );
}
