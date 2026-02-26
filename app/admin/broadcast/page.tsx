'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Container from '../../components/Container';
import Divider from '../../components/Divider';
import Input from '../../components/Input';
import Link from 'next/link';
import AdminAuthGuard from '../../components/AdminAuthGuard';

interface AudienceStats {
  allConsumers: number;
  allRanchers: number;
  byState: Record<string, number>;
  beefBuyers: number;
  community: number;
}

export default function BroadcastEmailPage() {
  return (
    <Suspense fallback={
      <AdminAuthGuard>
        <main className="min-h-screen py-24 bg-[#F4F1EC] text-[#0E0E0E]">
          <Container><p className="text-center">Loading...</p></Container>
        </main>
      </AdminAuthGuard>
    }>
      <BroadcastEmailInner />
    </Suspense>
  );
}

function BroadcastEmailInner() {
  const searchParams = useSearchParams();
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [campaignName, setCampaignName] = useState('');
  const [audienceType, setAudienceType] = useState<'consumers' | 'ranchers' | 'consumers-by-state' | 'consumers-beef' | 'consumers-community'>('consumers');
  const [selectedStates, setSelectedStates] = useState<string[]>([]);
  const [includeCTA, setIncludeCTA] = useState(true);
  const [ctaText, setCtaText] = useState('Browse Ranchers');
  const [ctaLink, setCtaLink] = useState('/member');
  
  const [stats, setStats] = useState<AudienceStats | null>(null);
  const [recipientCount, setRecipientCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [sendMode, setSendMode] = useState<'now' | 'scheduled'>('now');
  const [scheduledDate, setScheduledDate] = useState('');
  const [scheduledTime, setScheduledTime] = useState('09:00');
  const [sending, setSending] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [previewData, setPreviewData] = useState<any>(null);
  const [success, setSuccess] = useState(false);
  const [successData, setSuccessData] = useState<any>(null);
  const [error, setError] = useState('');

  const US_STATES = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'];

  useEffect(() => {
    fetchStats();
    const prefill = searchParams.get('prefill');
    if (prefill) {
      try {
        const data = JSON.parse(prefill);
        if (data.campaignName) setCampaignName(data.campaignName);
        if (data.subject) setSubject(data.subject);
        if (data.message) setMessage(data.message);
      } catch { /* invalid prefill, ignore */ }
    }
  }, []);

  useEffect(() => {
    calculateRecipients();
  }, [audienceType, selectedStates, stats]);

  const fetchStats = async () => {
    try {
      const response = await fetch('/api/admin/broadcast/stats');
      const data = await response.json();
      setStats(data);
      setLoading(false);
    } catch (err) {
      console.error('Error fetching stats:', err);
      setLoading(false);
    }
  };

  const calculateRecipients = () => {
    if (!stats) return;

    if (audienceType === 'consumers') {
      setRecipientCount(stats.allConsumers);
    } else if (audienceType === 'ranchers') {
      setRecipientCount(stats.allRanchers);
    } else if (audienceType === 'consumers-by-state') {
      const count = selectedStates.reduce((sum, state) => sum + (stats.byState[state] || 0), 0);
      setRecipientCount(count);
    } else if (audienceType === 'consumers-beef') {
      setRecipientCount(stats.beefBuyers || 0);
    } else if (audienceType === 'consumers-community') {
      setRecipientCount(stats.community || 0);
    }
  };

  const handleStateToggle = (state: string) => {
    if (selectedStates.includes(state)) {
      setSelectedStates(selectedStates.filter(s => s !== state));
    } else {
      setSelectedStates([...selectedStates, state]);
    }
  };

  const handlePreview = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!subject || !message || !campaignName) {
      setError('Please fill in all required fields');
      return;
    }

    if (audienceType === 'consumers-by-state' && selectedStates.length === 0) {
      setError('Please select at least one state');
      return;
    }

    setPreviewing(true);
    try {
      const response = await fetch('/api/admin/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subject, message, campaignName, audienceType, selectedStates,
          includeCTA, ctaText, ctaLink, preview: true,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to preview');
      setPreviewData(data);
    } catch (err: any) {
      setError(err.message || 'Failed to preview');
    } finally {
      setPreviewing(false);
    }
  };

  const handleSend = async () => {
    setError('');

    let scheduledFor: string | undefined;
    if (sendMode === 'scheduled') {
      if (!scheduledDate || !scheduledTime) {
        setError('Please select a date and time for scheduling');
        return;
      }
      scheduledFor = new Date(`${scheduledDate}T${scheduledTime}`).toISOString();
      if (new Date(scheduledFor).getTime() <= Date.now()) {
        setError('Scheduled time must be in the future');
        return;
      }
    }

    const action = sendMode === 'scheduled'
      ? `Schedule "${subject}" for ${new Date(`${scheduledDate}T${scheduledTime}`).toLocaleString()}?`
      : `Send "${subject}" to ${previewData?.recipientCount || recipientCount} recipients? This cannot be undone.`;
    if (!confirm(action)) return;

    setSending(true);
    try {
      const response = await fetch('/api/admin/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subject, message, campaignName, audienceType, selectedStates,
          includeCTA, ctaText, ctaLink, scheduledFor,
        }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to send emails');
      setSuccess(true);
      setSuccessData(data);
    } catch (err: any) {
      setError(err.message || 'Failed to send emails');
    } finally {
      setSending(false);
    }
  };

  if (loading) {
    return (
      <AdminAuthGuard>
        <main className="min-h-screen py-24 bg-[#F4F1EC] text-[#0E0E0E]">
          <Container>
            <p className="text-center">Loading...</p>
          </Container>
        </main>
      </AdminAuthGuard>
    );
  }

  if (success) {
    const isScheduled = successData?.scheduled;
    return (
      <AdminAuthGuard>
        <main className="min-h-screen py-24 bg-[#F4F1EC] text-[#0E0E0E]">
          <Container>
            <div className="max-w-2xl mx-auto text-center space-y-6">
              <div className="text-6xl">{isScheduled ? '⏱' : '✓'}</div>
              <h1 className="font-[family-name:var(--font-serif)] text-4xl">
                {isScheduled ? 'Campaign Scheduled' : 'Email Sent Successfully'}
              </h1>
              <p className="text-lg text-[#6B4F3F]">
                {isScheduled
                  ? `Your campaign will be sent at ${new Date(successData.scheduledFor).toLocaleString()}.`
                  : `Your broadcast email has been sent to ${successData?.recipientCount || recipientCount} recipients.`
                }
              </p>
              <div className="p-6 border border-[#A7A29A] bg-white space-y-2">
                <p><strong>Campaign:</strong> {campaignName}</p>
                <p><strong>Subject:</strong> {subject}</p>
                <p><strong>Recipients:</strong> {successData?.recipientCount || recipientCount}</p>
                {isScheduled && <p><strong>Scheduled:</strong> {new Date(successData.scheduledFor).toLocaleString()}</p>}
              </div>
              <div className="flex gap-4 justify-center pt-6">
                <Link 
                  href="/admin/analytics" 
                  className="px-6 py-3 border border-[#0E0E0E] hover:bg-[#0E0E0E] hover:text-[#F4F1EC] transition-colors"
                >
                  View Analytics
                </Link>
                <button
                  onClick={() => {
                    setSuccess(false);
                    setSuccessData(null);
                    setSubject('');
                    setMessage('');
                    setCampaignName('');
                    setSelectedStates([]);
                    setSendMode('now');
                    setScheduledDate('');
                    setScheduledTime('09:00');
                    setPreviewData(null);
                  }}
                  className="px-6 py-3 border border-[#A7A29A] hover:bg-[#A7A29A] transition-colors"
                >
                  Send Another
                </button>
              </div>
            </div>
          </Container>
        </main>
      </AdminAuthGuard>
    );
  }

  return (
    <AdminAuthGuard>
      <main className="min-h-screen py-24 bg-[#F4F1EC] text-[#0E0E0E]">
        <Container>
          <div className="max-w-4xl mx-auto space-y-8">
            {/* Header */}
            <div className="flex justify-between items-start">
              <div>
                <h1 className="font-[family-name:var(--font-serif)] text-4xl mb-2">
                  Broadcast Email
                </h1>
                <p className="text-[#6B4F3F]">
                  Send tracked email campaigns to your audience
                </p>
              </div>
              <Link 
                href="/admin" 
                className="px-4 py-2 border border-[#0E0E0E] hover:bg-[#0E0E0E] hover:text-[#F4F1EC] transition-colors"
              >
                ← Back to Admin
              </Link>
            </div>

            <Divider />

            {/* Form */}
            <form onSubmit={handlePreview} className="space-y-8">
              {/* Campaign Name */}
              <div>
                <label className="block text-sm font-medium mb-2">
                  Campaign Name <span className="text-[#8C2F2F]">*</span>
                </label>
                <input
                  type="text"
                  value={campaignName}
                  onChange={(e) => setCampaignName(e.target.value)}
                  placeholder="e.g., january-texas-beef"
                  className="w-full px-4 py-3 border border-[#A7A29A] bg-white focus:outline-none focus:border-[#0E0E0E]"
                  required
                />
                <p className="text-sm text-[#6B4F3F] mt-1">
                  Used for tracking - use lowercase with dashes, no spaces
                </p>
              </div>

              {/* Subject */}
              <div>
                <label className="block text-sm font-medium mb-2">
                  Subject Line <span className="text-[#8C2F2F]">*</span>
                </label>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="e.g., New Texas Rancher Available - Half Cows Ready Now"
                  className="w-full px-4 py-3 border border-[#A7A29A] bg-white focus:outline-none focus:border-[#0E0E0E]"
                  required
                />
              </div>

              {/* Message */}
              <div>
                <label className="block text-sm font-medium mb-2">
                  Message <span className="text-[#8C2F2F]">*</span>
                </label>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Write your message here... (supports line breaks)"
                  rows={10}
                  className="w-full px-4 py-3 border border-[#A7A29A] bg-white focus:outline-none focus:border-[#0E0E0E]"
                  required
                />
              </div>

              {/* CTA Button */}
              <div className="border border-[#A7A29A] p-6 bg-white">
                <div className="flex items-center gap-3 mb-4">
                  <input
                    type="checkbox"
                    id="includeCTA"
                    checked={includeCTA}
                    onChange={(e) => setIncludeCTA(e.target.checked)}
                    className="w-4 h-4"
                  />
                  <label htmlFor="includeCTA" className="text-sm font-medium">
                    Include Call-to-Action Button
                  </label>
                </div>
                {includeCTA && (
                  <div className="space-y-4">
                    <input
                      type="text"
                      value={ctaText}
                      onChange={(e) => setCtaText(e.target.value)}
                      placeholder="Button text"
                      className="w-full px-4 py-2 border border-[#A7A29A] bg-white focus:outline-none focus:border-[#0E0E0E]"
                    />
                    <input
                      type="text"
                      value={ctaLink}
                      onChange={(e) => setCtaLink(e.target.value)}
                      placeholder="/member or full URL"
                      className="w-full px-4 py-2 border border-[#A7A29A] bg-white focus:outline-none focus:border-[#0E0E0E]"
                    />
                  </div>
                )}
              </div>

              <Divider />

              {/* Audience Selection */}
              <div>
                <label className="block text-sm font-medium mb-4">
                  Select Audience <span className="text-[#8C2F2F]">*</span>
                </label>
                
                <div className="space-y-3">
                  <label className="flex items-center gap-3 p-4 border border-[#A7A29A] cursor-pointer hover:bg-white">
                    <input
                      type="radio"
                      name="audience"
                      value="consumers"
                      checked={audienceType === 'consumers'}
                      onChange={() => setAudienceType('consumers')}
                      className="w-4 h-4"
                    />
                    <span>All Consumers ({stats?.allConsumers || 0})</span>
                  </label>

                  <label className="flex items-center gap-3 p-4 border border-[#A7A29A] cursor-pointer hover:bg-white">
                    <input
                      type="radio"
                      name="audience"
                      value="consumers-beef"
                      checked={audienceType === 'consumers-beef'}
                      onChange={() => setAudienceType('consumers-beef')}
                      className="w-4 h-4"
                    />
                    <span>Beef Buyers Only ({stats?.beefBuyers || 0})</span>
                  </label>

                  <label className="flex items-center gap-3 p-4 border border-[#A7A29A] cursor-pointer hover:bg-white">
                    <input
                      type="radio"
                      name="audience"
                      value="consumers-community"
                      checked={audienceType === 'consumers-community'}
                      onChange={() => setAudienceType('consumers-community')}
                      className="w-4 h-4"
                    />
                    <span>Community Only ({stats?.community || 0})</span>
                  </label>

                  <label className="flex items-center gap-3 p-4 border border-[#A7A29A] cursor-pointer hover:bg-white">
                    <input
                      type="radio"
                      name="audience"
                      value="consumers-by-state"
                      checked={audienceType === 'consumers-by-state'}
                      onChange={() => setAudienceType('consumers-by-state')}
                      className="w-4 h-4"
                    />
                    <span>Consumers by State</span>
                  </label>

                  {audienceType === 'consumers-by-state' && (
                    <div className="ml-8 p-4 border border-[#A7A29A] bg-white">
                      <p className="text-sm mb-3">Select states:</p>
                      <div className="grid grid-cols-4 md:grid-cols-6 gap-2">
                        {US_STATES.map(state => (
                          <label key={state} className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={selectedStates.includes(state)}
                              onChange={() => handleStateToggle(state)}
                              className="w-4 h-4"
                            />
                            <span className="text-sm">{state}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}

                  <label className="flex items-center gap-3 p-4 border border-[#A7A29A] cursor-pointer hover:bg-white">
                    <input
                      type="radio"
                      name="audience"
                      value="ranchers"
                      checked={audienceType === 'ranchers'}
                      onChange={() => setAudienceType('ranchers')}
                      className="w-4 h-4"
                    />
                    <span>All Ranchers ({stats?.allRanchers || 0})</span>
                  </label>
                </div>
              </div>

              {/* Send Timing */}
              <div className="border border-[#A7A29A] p-6 bg-white space-y-4">
                <label className="block text-sm font-medium mb-2">When to Send</label>
                <div className="flex gap-4">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="sendMode"
                      checked={sendMode === 'now'}
                      onChange={() => setSendMode('now')}
                      className="w-4 h-4"
                    />
                    <span className="text-sm">Send Immediately</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="sendMode"
                      checked={sendMode === 'scheduled'}
                      onChange={() => setSendMode('scheduled')}
                      className="w-4 h-4"
                    />
                    <span className="text-sm">Schedule for Later</span>
                  </label>
                </div>
                {sendMode === 'scheduled' && (
                  <div className="flex gap-4 items-end">
                    <div className="flex-1">
                      <label className="block text-xs text-[#6B4F3F] mb-1">Date</label>
                      <input
                        type="date"
                        value={scheduledDate}
                        onChange={(e) => setScheduledDate(e.target.value)}
                        min={new Date().toISOString().split('T')[0]}
                        className="w-full px-4 py-2 border border-[#A7A29A] bg-[#F4F1EC] text-sm"
                      />
                    </div>
                    <div className="flex-1">
                      <label className="block text-xs text-[#6B4F3F] mb-1">Time</label>
                      <input
                        type="time"
                        value={scheduledTime}
                        onChange={(e) => setScheduledTime(e.target.value)}
                        className="w-full px-4 py-2 border border-[#A7A29A] bg-[#F4F1EC] text-sm"
                      />
                    </div>
                  </div>
                )}
                {sendMode === 'scheduled' && (
                  <p className="text-xs text-[#6B4F3F]">
                    Campaigns are checked every 5 minutes. Time is in your browser&apos;s timezone.
                  </p>
                )}
              </div>

              {/* Recipient Count */}
              <div className="p-6 border border-[#0E0E0E] bg-white">
                <div className="flex justify-between items-center">
                  <span className="text-lg">Recipients:</span>
                  <span className="text-3xl font-[family-name:var(--font-serif)]">{recipientCount}</span>
                </div>
              </div>

              {/* Preview Panel */}
              {previewData && (
                <div className="border-2 border-[#0E0E0E] bg-white p-6 space-y-4">
                  <h3 className="font-[family-name:var(--font-serif)] text-xl">Preview</h3>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div><strong>Campaign:</strong> {previewData.campaignName}</div>
                    <div><strong>Subject:</strong> {previewData.subject}</div>
                    <div><strong>Recipients:</strong> {previewData.recipientCount}</div>
                  </div>
                  {previewData.sampleRecipients?.length > 0 && (
                    <div>
                      <p className="text-sm font-medium mb-2">Sample recipients:</p>
                      <div className="text-sm text-[#6B4F3F] space-y-1">
                        {previewData.sampleRecipients.map((r: any, i: number) => (
                          <div key={i}>{r.name} — {r.email}</div>
                        ))}
                        {previewData.recipientCount > 10 && (
                          <div className="text-[#A7A29A]">...and {previewData.recipientCount - 10} more</div>
                        )}
                      </div>
                    </div>
                  )}
                  <div className="flex gap-4 pt-2">
                    <button
                      type="button"
                      onClick={handleSend}
                      disabled={sending}
                      className="flex-1 px-6 py-4 bg-[#0E0E0E] text-[#F4F1EC] hover:bg-[#2A2A2A] transition-colors disabled:opacity-50 uppercase font-semibold tracking-wider"
                    >
                      {sending
                        ? (sendMode === 'scheduled' ? 'Scheduling...' : 'Sending...')
                        : sendMode === 'scheduled'
                        ? `Schedule for ${scheduledDate} ${scheduledTime}`
                        : `Confirm & Send to ${previewData.recipientCount}`
                      }
                    </button>
                    <button
                      type="button"
                      onClick={() => setPreviewData(null)}
                      disabled={sending}
                      className="px-6 py-4 border border-[#A7A29A] hover:bg-[#A7A29A] transition-colors"
                    >
                      Edit
                    </button>
                  </div>
                </div>
              )}

              {/* Error Message */}
              {error && (
                <div className="p-4 border border-[#8C2F2F] bg-transparent text-[#8C2F2F]">
                  {error}
                </div>
              )}

              {/* Preview Button */}
              {!previewData && (
                <button
                  type="submit"
                  disabled={previewing || sending || recipientCount === 0}
                  className="w-full px-6 py-4 bg-[#0E0E0E] text-[#F4F1EC] hover:bg-[#2A2A2A] transition-colors disabled:opacity-50 disabled:cursor-not-allowed uppercase font-semibold tracking-wider"
                >
                  {previewing ? 'Loading Preview...' : `Preview — ${recipientCount} Recipients`}
                </button>
              )}
            </form>
          </div>
        </Container>
      </main>
    </AdminAuthGuard>
  );
}


