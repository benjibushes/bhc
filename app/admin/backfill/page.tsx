'use client';

import { useState, useEffect } from 'react';
import Container from '../../components/Container';
import Divider from '../../components/Divider';
import AdminAuthGuard from '../../components/AdminAuthGuard';
import Link from 'next/link';

export default function BackfillPage() {
  const [consumers, setConsumers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [csv, setCsv] = useState('');
  const [batchSize, setBatchSize] = useState(50);
  const [lastResult, setLastResult] = useState<any>(null);

  useEffect(() => {
    fetch('/api/admin/consumers')
      .then(res => res.json())
      .then(data => { setConsumers(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const needsBackfill = consumers.filter(c => !c.order_type && !c.budget_range);
  const hasBackfill = consumers.filter(c => c.order_type || c.budget_range);
  const emailSent = consumers.filter(c => (c as any).backfill_email_sent);
  const responded = hasBackfill.length;
  const conversionRate = emailSent.length > 0
    ? Math.round((responded / emailSent.length) * 100)
    : 0;

  const generateLinks = async () => {
    setGenerating(true);
    try {
      const res = await fetch('/api/backfill/generate-links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: batchSize }),
      });
      const data = await res.json();
      if (data.csv) {
        setCsv(data.csv);
      }
      setLastResult(data);
    } catch {
      alert('Error generating links');
    }
    setGenerating(false);
  };

  const sendCampaign = async () => {
    if (!confirm(`Send backfill emails to up to ${batchSize} leads?`)) return;
    setSending(true);
    try {
      const res = await fetch('/api/backfill/send-campaign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchSize }),
      });
      const data = await res.json();
      setLastResult(data);
      alert(`Sent ${data.sentCount} emails. ${data.remaining} remaining.`);
      // Refresh data
      const refreshRes = await fetch('/api/admin/consumers');
      setConsumers(await refreshRes.json());
    } catch {
      alert('Error sending campaign');
    }
    setSending(false);
  };

  const downloadCsv = () => {
    if (!csv) return;
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `backfill-links-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
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

  return (
    <AdminAuthGuard>
      <main className="min-h-screen py-12 bg-[#F4F1EC] text-[#0E0E0E]">
        <Container>
          <div className="space-y-8">
            <div className="flex flex-wrap justify-between items-start gap-4">
              <div>
                <h1 className="font-[family-name:var(--font-serif)] text-3xl md:text-4xl">Backfill Campaign</h1>
                <p className="text-sm text-[#6B4F3F] mt-2">Capture intent from existing leads</p>
              </div>
              <Link href="/admin" className="px-4 py-2 text-sm border border-[#0E0E0E] hover:bg-[#0E0E0E] hover:text-[#F4F1EC] transition-colors">
                &larr; Back
              </Link>
            </div>

            <Divider />

            {/* Stats */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
              <div className="p-4 border border-[#A7A29A] text-center">
                <div className="font-[family-name:var(--font-serif)] text-3xl">{consumers.length}</div>
                <div className="text-xs text-[#6B4F3F]">Total Leads</div>
              </div>
              <div className="p-4 border border-red-300 bg-red-50 text-center">
                <div className="font-[family-name:var(--font-serif)] text-3xl text-red-700">{needsBackfill.length}</div>
                <div className="text-xs text-red-700 font-medium">Missing Intent Data</div>
              </div>
              <div className="p-4 border border-blue-300 bg-blue-50 text-center">
                <div className="font-[family-name:var(--font-serif)] text-3xl text-blue-700">{emailSent.length}</div>
                <div className="text-xs text-blue-700">Emails Sent</div>
              </div>
              <div className="p-4 border border-green-300 bg-green-50 text-center">
                <div className="font-[family-name:var(--font-serif)] text-3xl text-green-700">{responded}</div>
                <div className="text-xs text-green-700">Responses</div>
              </div>
              <div className="p-4 border border-[#A7A29A] text-center">
                <div className="font-[family-name:var(--font-serif)] text-3xl">{conversionRate}%</div>
                <div className="text-xs text-[#6B4F3F]">Conversion Rate</div>
              </div>
            </div>

            {/* Actions */}
            <div className="p-6 border border-[#A7A29A] bg-white space-y-4">
              <h3 className="font-[family-name:var(--font-serif)] text-xl">Send Backfill Campaign</h3>
              <p className="text-sm text-[#6B4F3F]">
                Send personalized emails with secure update links to leads missing intent data.
                Emails are sent at ~1/second to avoid spam flags.
              </p>

              <div className="flex flex-wrap items-end gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Batch Size</label>
                  <input
                    type="number"
                    value={batchSize}
                    onChange={(e) => setBatchSize(Math.max(1, parseInt(e.target.value) || 1))}
                    className="px-4 py-2 border border-[#A7A29A] bg-[#F4F1EC] w-24"
                  />
                </div>
                <button
                  onClick={sendCampaign}
                  disabled={sending || needsBackfill.length === 0}
                  className="px-6 py-2 bg-[#0E0E0E] text-[#F4F1EC] text-sm font-medium hover:bg-[#2A2A2A] disabled:opacity-50"
                >
                  {sending ? 'Sending...' : `Send to ${Math.min(batchSize, needsBackfill.length)} Leads`}
                </button>
                <button
                  onClick={generateLinks}
                  disabled={generating || needsBackfill.length === 0}
                  className="px-6 py-2 border border-[#0E0E0E] text-sm font-medium hover:bg-[#0E0E0E] hover:text-[#F4F1EC] disabled:opacity-50"
                >
                  {generating ? 'Generating...' : 'Generate CSV Links'}
                </button>
                {csv && (
                  <button
                    onClick={downloadCsv}
                    className="px-6 py-2 border border-green-600 text-green-700 text-sm font-medium hover:bg-green-50"
                  >
                    Download CSV
                  </button>
                )}
              </div>

              {lastResult && (
                <div className="mt-4 p-4 bg-[#F4F1EC] text-sm">
                  <p><strong>Last Action:</strong></p>
                  {lastResult.sentCount !== undefined && (
                    <p>Emails sent: {lastResult.sentCount} | Remaining: {lastResult.remaining}</p>
                  )}
                  {lastResult.linksGenerated !== undefined && (
                    <p>Links generated: {lastResult.linksGenerated} | Total needing backfill: {lastResult.totalNeedingBackfill}</p>
                  )}
                </div>
              )}
            </div>

            {/* Email Preview */}
            <div className="p-6 border border-[#A7A29A] bg-white space-y-4">
              <h3 className="font-[family-name:var(--font-serif)] text-xl">Email Preview</h3>
              <div className="p-4 bg-[#F4F1EC] border border-[#A7A29A] text-sm space-y-2">
                <p><strong>Subject:</strong> Quick Update: Help Us Match You With Ranchers</p>
                <Divider />
                <p>Hi [First Name],</p>
                <p>You signed up for BuyHalfCow access in [State]!</p>
                <p>We&apos;re now matching buyers with verified ranchers in your area. To speed up your match, update your preferences:</p>
                <p className="text-center py-4">
                  <span className="px-6 py-3 bg-[#0E0E0E] text-[#F4F1EC] text-sm font-medium">
                    UPDATE YOUR PREFERENCES
                  </span>
                </p>
                <p>Takes 30 seconds. You&apos;ll hear from us within 48 hours.</p>
                <p className="text-xs text-[#A7A29A]">— Benji, Founder, BuyHalfCow</p>
              </div>
            </div>
          </div>
        </Container>
      </main>
    </AdminAuthGuard>
  );
}
