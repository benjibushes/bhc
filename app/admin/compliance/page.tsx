'use client';

import { useState, useEffect } from 'react';
import Container from '../../components/Container';
import Divider from '../../components/Divider';
import AdminAuthGuard from '../../components/AdminAuthGuard';
import Link from 'next/link';

interface Rancher {
  id: string;
  ranch_name: string;
  operator_name: string;
  email: string;
  state: string;
  active_status: string;
  agreement_signed: boolean;
  onboarding_status: string;
}

export default function CompliancePage() {
  const [ranchers, setRanchers] = useState<Rancher[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/admin/ranchers')
      .then(res => res.json())
      .then(data => { setRanchers(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const sendReminder = async (id: string, email: string, name: string) => {
    try {
      const month = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });
      await fetch('/api/admin/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipients: [{ email, name }],
          subject: `BuyHalfCow Sales Report Reminder - ${month}`,
          message: `Hi ${name},\n\nThis is a reminder to submit your monthly sales report for BuyHalfCow referrals.\n\nPlease reply with your sales from last month, or "No sales" if none.\n\nThanks,\nBenjamin`,
          campaignName: 'compliance-reminder-manual',
        }),
      });
      alert(`Reminder sent to ${name}`);
    } catch {
      alert('Error sending reminder');
    }
  };

  const updateStatus = async (id: string, newStatus: string) => {
    try {
      await fetch(`/api/admin/ranchers/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active_status: newStatus }),
      });
      setRanchers(prev => prev.map(r =>
        r.id === id ? { ...r, active_status: newStatus } : r
      ));
    } catch {
      alert('Error updating status');
    }
  };

  if (loading) {
    return (
      <AdminAuthGuard>
        <main className="min-h-screen py-24 bg-[#F4F1EC] text-[#0E0E0E]">
          <Container><p className="text-lg text-[#6B4F3F] text-center">Loading...</p></Container>
        </main>
      </AdminAuthGuard>
    );
  }

  const activeRanchers = ranchers.filter(r => r.active_status === 'Active' || r.active_status === 'Non-Compliant');
  const nonCompliant = ranchers.filter(r => r.active_status === 'Non-Compliant');

  return (
    <AdminAuthGuard>
      <main className="min-h-screen py-12 bg-[#F4F1EC] text-[#0E0E0E]">
        <Container>
          <div className="space-y-8">
            <div className="flex flex-wrap justify-between items-start gap-4">
              <div>
                <h1 className="font-[family-name:var(--font-serif)] text-3xl md:text-4xl">Compliance</h1>
                <p className="text-sm text-[#6B4F3F] mt-2">Rancher reporting and compliance tracking</p>
              </div>
              <Link href="/admin" className="px-4 py-2 text-sm border border-[#0E0E0E] hover:bg-[#0E0E0E] hover:text-[#F4F1EC] transition-colors">
                &larr; Back
              </Link>
            </div>

            <Divider />

            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <div className="p-4 border border-[#A7A29A] text-center">
                <div className="font-[family-name:var(--font-serif)] text-3xl">{activeRanchers.length}</div>
                <div className="text-xs text-[#6B4F3F]">Active Ranchers</div>
              </div>
              <div className="p-4 border border-red-300 bg-red-50 text-center">
                <div className="font-[family-name:var(--font-serif)] text-3xl text-red-700">{nonCompliant.length}</div>
                <div className="text-xs text-red-700 font-medium">Non-Compliant</div>
              </div>
              <div className="p-4 border border-[#A7A29A] text-center">
                <button
                  onClick={() => {
                    if (confirm('Send compliance reminders to all active ranchers?')) {
                      fetch('/api/cron/compliance-reminders?secret=' + encodeURIComponent(process.env.NEXT_PUBLIC_CRON_SECRET || ''))
                        .then(r => r.json())
                        .then(d => alert(`Sent ${d.sentCount} reminders`))
                        .catch(() => alert('Error'));
                    }
                  }}
                  className="px-4 py-2 bg-[#0E0E0E] text-[#F4F1EC] text-sm hover:bg-[#2A2A2A]"
                >
                  Send Bulk Reminders
                </button>
              </div>
            </div>

            <div className="space-y-4">
              {activeRanchers.map(rancher => (
                <div key={rancher.id} className={`p-4 border space-y-2 ${
                  rancher.active_status === 'Non-Compliant' ? 'border-red-300 bg-red-50' : 'border-[#A7A29A]'
                }`}>
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <h3 className="font-medium">{rancher.operator_name || rancher.ranch_name}</h3>
                      <p className="text-sm text-[#6B4F3F]">{rancher.email} &middot; {rancher.state}</p>
                      <span className={`inline-block px-2 py-0.5 text-xs mt-1 ${
                        rancher.active_status === 'Non-Compliant' ? 'bg-red-200 text-red-800' : 'bg-green-200 text-green-800'
                      }`}>
                        {rancher.active_status}
                      </span>
                    </div>
                    <div className="flex gap-2 flex-wrap">
                      <button
                        onClick={() => sendReminder(rancher.id, rancher.email, rancher.operator_name || rancher.ranch_name)}
                        className="px-3 py-1 text-xs border border-[#0E0E0E] hover:bg-[#0E0E0E] hover:text-[#F4F1EC]"
                      >
                        Send Reminder
                      </button>
                      {rancher.active_status === 'Non-Compliant' && (
                        <button
                          onClick={() => updateStatus(rancher.id, 'Active')}
                          className="px-3 py-1 text-xs bg-green-700 text-white hover:bg-green-800"
                        >
                          Mark Compliant
                        </button>
                      )}
                      {rancher.active_status === 'Active' && (
                        <button
                          onClick={() => updateStatus(rancher.id, 'Paused')}
                          className="px-3 py-1 text-xs border border-yellow-600 text-yellow-700 hover:bg-yellow-50"
                        >
                          Pause
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Container>
      </main>
    </AdminAuthGuard>
  );
}
