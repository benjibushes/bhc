'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Container from '../components/Container';
import Divider from '../components/Divider';
import Link from 'next/link';

interface RancherInfo {
  id: string;
  name: string;
  ranchName: string;
  state: string;
  activeStatus: string;
  onboardingStatus: string;
  agreementSigned: boolean;
  currentActiveReferrals: number;
  maxActiveReferrals: number;
  monthlyCapacity: number;
  beefTypes: string;
  // Landing page fields
  slug: string;
  pageLive: boolean;
  logoUrl: string;
  tagline: string;
  aboutText: string;
  videoUrl: string;
  quarterPrice: string | number;
  quarterLbs: string;
  quarterPaymentLink: string;
  halfPrice: string | number;
  halfLbs: string;
  halfPaymentLink: string;
  wholePrice: string | number;
  wholeLbs: string;
  wholePaymentLink: string;
  nextProcessingDate: string;
  reserveLink: string;
  customNotes: string;
  // Click tracking
  quarterClicks: number;
  halfClicks: number;
  wholeClicks: number;
}

interface Stats {
  totalReferrals: number;
  activeReferrals: number;
  closedWon: number;
  closedLost: number;
  totalRevenue: number;
  totalCommission: number;
  unpaidCommission: number;
  netEarnings: number;
}

interface Referral {
  id: string;
  status: string;
  buyer_name: string;
  buyer_email: string;
  buyer_phone: string;
  buyer_state: string;
  order_type: string;
  budget_range: string;
  notes: string;
  sale_amount: number;
  commission_due: number;
  commission_paid: boolean;
  created_at: string;
  intro_sent_at: string;
  closed_at: string;
}

interface NetworkBenefit {
  id: string;
  brand_name: string;
  product_type: string;
  discount_offered: number;
  description: string;
  website: string;
  contact_email: string;
}

type Tab = 'overview' | 'referrals' | 'earnings' | 'benefits' | 'my_page';

const statusStyles: Record<string, string> = {
  'Intro Sent': 'bg-blue-100 text-blue-800',
  'Rancher Contacted': 'bg-indigo-100 text-indigo-800',
  'Negotiation': 'bg-yellow-100 text-yellow-800',
  'Closed Won': 'bg-green-100 text-green-800',
  'Closed Lost': 'bg-gray-100 text-gray-600',
  'Pending Approval': 'bg-orange-100 text-orange-800',
};

export default function RancherDashboardPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [rancherInfo, setRancherInfo] = useState<RancherInfo | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [referrals, setReferrals] = useState<Referral[]>([]);
  const [closeModal, setCloseModal] = useState<Referral | null>(null);
  const [benefits, setBenefits] = useState<NetworkBenefit[]>([]);
  const [closeForm, setCloseForm] = useState({ status: 'Closed Won', saleAmount: '', notes: '' });
  const [updating, setUpdating] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState('');
  const [pageForm, setPageForm] = useState<Record<string, string>>({});
  const [pageSaving, setPageSaving] = useState(false);
  const [pageSaved, setPageSaved] = useState(false);
  const [pageError, setPageError] = useState('');
  // Capacity editor
  const [editingCapacity, setEditingCapacity] = useState(false);
  const [capacityValue, setCapacityValue] = useState('');
  const [capacitySaving, setCapacitySaving] = useState(false);
  // Go-live request
  const [goLiveRequested, setGoLiveRequested] = useState(false);
  const [goLiveLoading, setGoLiveLoading] = useState(false);
  // Verification
  const [verificationMethod, setVerificationMethod] = useState<'sample' | 'visit'>('sample');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [verificationSubmitting, setVerificationSubmitting] = useState(false);
  const [verificationSubmitted, setVerificationSubmitted] = useState(false);

  useEffect(() => {
    fetchDashboard();
  }, []);

  const fetchDashboard = async () => {
    try {
      const sessionRes = await fetch('/api/auth/rancher/session');
      if (!sessionRes.ok) {
        router.push('/rancher/login');
        return;
      }

      const dashRes = await fetch('/api/rancher/dashboard');
      if (!dashRes.ok) {
        router.push('/rancher/login');
        return;
      }

      const data = await dashRes.json();
      setRancherInfo(data.rancher);
      setStats(data.stats);
      setReferrals(data.referrals);
      setBenefits(data.networkBenefits || []);
      // Populate landing page form with current values
      const r = data.rancher;
      setPageForm({
        'Slug': r.slug || '',
        'Logo URL': r.logoUrl || '',
        'Tagline': r.tagline || '',
        'About Text': r.aboutText || '',
        'Video URL': r.videoUrl || '',
        'Quarter Price': r.quarterPrice ? String(r.quarterPrice) : '',
        'Quarter lbs': r.quarterLbs || '',
        'Quarter Payment Link': r.quarterPaymentLink || '',
        'Half Price': r.halfPrice ? String(r.halfPrice) : '',
        'Half lbs': r.halfLbs || '',
        'Half Payment Link': r.halfPaymentLink || '',
        'Whole Price': r.wholePrice ? String(r.wholePrice) : '',
        'Whole lbs': r.wholeLbs || '',
        'Whole Payment Link': r.wholePaymentLink || '',
        'Next Processing Date': r.nextProcessingDate || '',
        'Reserve Link': r.reserveLink || '',
        'Custom Notes': r.customNotes || '',
      });
    } catch {
      router.push('/rancher/login');
    } finally {
      setLoading(false);
    }
  };

  const updateReferralStatus = async (referralId: string, status: string) => {
    setUpdating(referralId);
    setUpdateError('');
    try {
      const res = await fetch(`/api/rancher/referrals/${referralId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setUpdateError(data.error || 'Failed to update status. Please try again.');
      }
      await fetchDashboard();
    } catch {
      setUpdateError('Network error. Please check your connection.');
    } finally {
      setUpdating(null);
    }
  };

  const handleCloseDeal = async () => {
    if (!closeModal) return;

    if (closeForm.status === 'Closed Won' && (!closeForm.saleAmount || parseFloat(closeForm.saleAmount) <= 0)) {
      setUpdateError('Please enter a valid sale amount greater than $0.');
      return;
    }

    setUpdating(closeModal.id);
    setUpdateError('');
    try {
      const res = await fetch(`/api/rancher/referrals/${closeModal.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: closeForm.status,
          saleAmount: closeForm.status === 'Closed Won' ? parseFloat(closeForm.saleAmount) || 0 : undefined,
          notes: closeForm.notes || undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setUpdateError(data.error || 'Failed to close deal. Please try again.');
        return;
      }
      setCloseModal(null);
      setCloseForm({ status: 'Closed Won', saleAmount: '', notes: '' });
      await fetchDashboard();
    } catch {
      setUpdateError('Network error. Please check your connection.');
    } finally {
      setUpdating(null);
    }
  };

  const handleLogout = async () => {
    await fetch('/api/auth/rancher/session', { method: 'DELETE' });
    router.push('/');
  };

  const handleSavePage = async () => {
    setPageSaving(true);
    setPageError('');
    setPageSaved(false);
    try {
      // Convert price fields to numbers
      const body: Record<string, any> = { ...pageForm };
      for (const key of ['Quarter Price', 'Half Price', 'Whole Price']) {
        if (body[key]) body[key] = parseFloat(body[key]) || null;
        else body[key] = null;
      }
      const res = await fetch('/api/rancher/landing-page', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setPageError(data.error || 'Failed to save. Please try again.');
        return;
      }
      setPageSaved(true);
      setTimeout(() => setPageSaved(false), 3000);
    } catch {
      setPageError('Network error. Please check your connection.');
    } finally {
      setPageSaving(false);
    }
  };

  const handleUpdateCapacity = async () => {
    const val = parseInt(capacityValue);
    if (isNaN(val) || val < 1 || val > 50) {
      setUpdateError('Capacity must be between 1 and 50');
      return;
    }
    setCapacitySaving(true);
    try {
      const res = await fetch('/api/rancher/landing-page', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ _action: 'update-capacity', maxActiveReferrals: val }),
      });
      if (res.ok) {
        setEditingCapacity(false);
        await fetchDashboard();
      } else {
        const data = await res.json().catch(() => ({}));
        setUpdateError(data.error || 'Failed to update capacity');
      }
    } catch {
      setUpdateError('Network error');
    } finally {
      setCapacitySaving(false);
    }
  };

  const handleRequestGoLive = async () => {
    setGoLiveLoading(true);
    try {
      const res = await fetch('/api/rancher/landing-page', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ _action: 'request-go-live' }),
      });
      if (res.ok) {
        setGoLiveRequested(true);
      }
    } catch {
      // silent
    } finally {
      setGoLiveLoading(false);
    }
  };

  if (loading) {
    return (
      <main className="min-h-screen py-24 bg-bone-white text-charcoal-black flex items-center justify-center">
        <Container>
          <div className="text-center">
            <div className="inline-block w-8 h-8 border-4 border-charcoal-black border-t-transparent rounded-full animate-spin" />
            <p className="mt-4 text-saddle-brown">Loading your dashboard...</p>
          </div>
        </Container>
      </main>
    );
  }

  if (!rancherInfo || !stats) return null;

  const activeRefs = referrals.filter(r => ['Intro Sent', 'Rancher Contacted', 'Negotiation'].includes(r.status));
  const closedRefs = referrals.filter(r => ['Closed Won', 'Closed Lost'].includes(r.status));

  const tabs: { key: Tab; label: string }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'referrals', label: `Active Leads (${activeRefs.length})` },
    { key: 'earnings', label: 'Earnings' },
    { key: 'benefits', label: `Network Benefits${benefits.length > 0 ? ` (${benefits.length})` : ''}` },
    { key: 'my_page', label: 'My Page' },
  ];

  return (
    <main className="min-h-screen py-12 bg-bone-white text-charcoal-black">
      <Container>
        <div className="space-y-8">
          {/* Header */}
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
            <div>
              <h1 className="font-serif text-3xl md:text-4xl">{rancherInfo.ranchName}</h1>
              <p className="text-saddle-brown mt-1">{rancherInfo.name} &middot; {rancherInfo.state}</p>
            </div>
            <div className="flex items-center gap-4">
              <span className={`px-3 py-1 text-xs font-medium uppercase tracking-wider ${
                rancherInfo.activeStatus === 'Active' ? 'bg-green-100 text-green-800' :
                rancherInfo.activeStatus === 'At Capacity' ? 'bg-yellow-100 text-yellow-800' :
                'bg-gray-100 text-gray-600'
              }`}>
                {rancherInfo.activeStatus || 'Pending'}
              </span>
              <button onClick={handleLogout} className="text-sm text-dust-gray hover:text-charcoal-black transition-colors">
                Log out
              </button>
            </div>
          </div>

          <Divider />

          {/* Onboarding Banner */}
          {rancherInfo.onboardingStatus && rancherInfo.onboardingStatus !== 'Live' && (
            <div className="p-4 border-2 border-yellow-400 bg-yellow-50 space-y-3">
              <p className="font-medium">Onboarding Status: {rancherInfo.onboardingStatus}</p>
              <p className="text-sm text-saddle-brown">
                {rancherInfo.onboardingStatus === 'Docs Sent' && 'Please review and sign the agreement documents sent to your email.'}
                {rancherInfo.onboardingStatus === 'Verification Complete' && "You're approved! We're activating your profile. You'll receive an email when you're live."}
                {rancherInfo.onboardingStatus === 'Verification Pending' && !verificationSubmitted && "Ship a product sample to get verified and go live."}
                {rancherInfo.onboardingStatus === 'Verification Pending' && verificationSubmitted && "Verification request submitted! We'll follow up shortly."}
                {(rancherInfo.onboardingStatus === 'Agreement Signed') && "Next step: start verification so we can get you live."}
                {!['Docs Sent', 'Agreement Signed', 'Verification Complete', 'Verification Pending'].includes(rancherInfo.onboardingStatus) && "Complete your onboarding to start receiving buyer leads."}
              </p>
              <div className="pt-3 border-t border-yellow-300">
                <p className="text-xs font-medium text-saddle-brown uppercase tracking-wider mb-2">Steps to go live</p>
                <ol className="text-sm text-saddle-brown space-y-1">
                  <li className={['Docs Sent', 'Agreement Signed', 'Verification Complete', 'Verification Pending', 'Live'].includes(rancherInfo.onboardingStatus) ? 'line-through text-gray-500' : ''}>
                    1. Sign agreement {['Agreement Signed', 'Verification Complete', 'Verification Pending', 'Live'].includes(rancherInfo.onboardingStatus) && '✓'}
                  </li>
                  <li className={['Verification Complete', 'Live'].includes(rancherInfo.onboardingStatus) ? 'line-through text-gray-500' : ''}>
                    2. Verification {['Verification Complete', 'Live'].includes(rancherInfo.onboardingStatus) && '✓'}
                  </li>
                  <li>3. Set up your ranch page</li>
                  <li>4. Go live</li>
                </ol>
              </div>

              {/* Self-service verification form */}
              {['Agreement Signed', 'Verification Pending'].includes(rancherInfo.onboardingStatus) && !verificationSubmitted && (
                <div className="mt-3 pt-3 border-t border-yellow-300 space-y-3">
                  <p className="text-sm font-medium">Start Verification</p>
                  <div className="flex gap-3">
                    <button
                      onClick={() => setVerificationMethod('sample')}
                      className={`flex-1 py-2 px-3 text-xs font-medium border ${verificationMethod === 'sample' ? 'bg-charcoal-black text-bone-white border-charcoal-black' : 'border-dust-gray hover:bg-gray-100'}`}
                    >
                      Ship Product Sample
                    </button>
                    <button
                      onClick={() => setVerificationMethod('visit')}
                      className={`flex-1 py-2 px-3 text-xs font-medium border ${verificationMethod === 'visit' ? 'bg-charcoal-black text-bone-white border-charcoal-black' : 'border-dust-gray hover:bg-gray-100'}`}
                    >
                      Request Ranch Visit
                    </button>
                  </div>

                  {verificationMethod === 'sample' && (
                    <div className="space-y-2">
                      <div className="text-xs text-saddle-brown bg-white p-3 border border-dust-gray">
                        <p className="font-medium mb-1">Ship to:</p>
                        <p>BuyHalfCow Verification<br/>420 N Walnut St<br/>Colorado Springs, CO 80905</p>
                        <p className="mt-2">Include a few representative cuts. We review packaging, marbling, and presentation.</p>
                      </div>
                      <input
                        type="text"
                        placeholder="Tracking number (optional)"
                        value={trackingNumber}
                        onChange={(e) => setTrackingNumber(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-dust-gray"
                      />
                    </div>
                  )}

                  {verificationMethod === 'visit' && (
                    <p className="text-xs text-saddle-brown">We&apos;ll coordinate an on-site visit to your ranch. This includes a walkthrough, feeding program review, and optional media documentation.</p>
                  )}

                  <button
                    onClick={async () => {
                      setVerificationSubmitting(true);
                      try {
                        const res = await fetch('/api/rancher/landing-page', {
                          method: 'PATCH',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            _action: 'request-verification',
                            verificationMethod,
                            trackingNumber: trackingNumber.trim(),
                          }),
                        });
                        if (res.ok) {
                          setVerificationSubmitted(true);
                        }
                      } catch (e) {
                        console.error('Verification request error:', e);
                      }
                      setVerificationSubmitting(false);
                    }}
                    disabled={verificationSubmitting}
                    className="w-full py-3 bg-charcoal-black text-bone-white text-sm font-medium uppercase tracking-wider hover:bg-saddle-brown transition-colors disabled:opacity-50"
                  >
                    {verificationSubmitting ? 'Submitting...' : verificationMethod === 'sample' ? 'I\'ve Shipped My Sample' : 'Request Ranch Visit'}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Tabs */}
          <div className="flex flex-wrap gap-2">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`px-4 py-2 text-sm font-medium tracking-wider uppercase transition-colors ${
                  activeTab === tab.key
                    ? 'bg-charcoal-black text-bone-white'
                    : 'border border-dust-gray hover:bg-charcoal-black hover:text-bone-white'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Overview Tab */}
          {activeTab === 'overview' && (
            <div className="space-y-8">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <StatCard label="Active Leads" value={stats.activeReferrals} />
                <StatCard label="Deals Closed" value={stats.closedWon} />
                <StatCard label="Total Revenue" value={`$${stats.totalRevenue.toLocaleString()}`} />
                <StatCard label="Your Earnings" value={`$${stats.netEarnings.toLocaleString()}`} sub="(after 10% commission)" />
              </div>

              <Divider />

              <div className="grid md:grid-cols-2 gap-6">
                <div className="p-6 border border-dust-gray bg-white">
                  <div className="flex justify-between items-center mb-4">
                    <h3 className="font-serif text-xl">Capacity</h3>
                    {!editingCapacity && (
                      <button
                        onClick={() => { setEditingCapacity(true); setCapacityValue(String(rancherInfo.maxActiveReferrals)); }}
                        className="text-xs text-saddle-brown hover:text-charcoal-black transition-colors"
                      >
                        Edit Max
                      </button>
                    )}
                  </div>
                  <div className="space-y-3">
                    <div className="flex justify-between text-sm">
                      <span className="text-saddle-brown">Active Referrals</span>
                      <span className="font-medium">{rancherInfo.currentActiveReferrals} / {rancherInfo.maxActiveReferrals}</span>
                    </div>
                    <div className="w-full bg-gray-200 h-2">
                      <div
                        className={`h-2 transition-all ${rancherInfo.currentActiveReferrals >= rancherInfo.maxActiveReferrals ? 'bg-weathered-red' : 'bg-charcoal-black'}`}
                        style={{ width: `${Math.min(100, (rancherInfo.currentActiveReferrals / rancherInfo.maxActiveReferrals) * 100)}%` }}
                      />
                    </div>
                    <p className="text-xs text-dust-gray">
                      {rancherInfo.currentActiveReferrals >= rancherInfo.maxActiveReferrals
                        ? 'At capacity — new leads paused until a deal closes'
                        : `${rancherInfo.maxActiveReferrals - rancherInfo.currentActiveReferrals} more leads available`}
                    </p>
                    {editingCapacity && (
                      <div className="pt-2 border-t border-dust-gray space-y-2">
                        <label className="text-xs text-saddle-brown">Max active leads at a time</label>
                        <div className="flex gap-2">
                          <input
                            type="number"
                            min="1"
                            max="50"
                            value={capacityValue}
                            onChange={e => setCapacityValue(e.target.value)}
                            className="flex-1 px-3 py-2 border border-dust-gray bg-bone-white text-sm focus:outline-none focus:border-charcoal-black"
                          />
                          <button
                            onClick={handleUpdateCapacity}
                            disabled={capacitySaving}
                            className="px-4 py-2 text-xs bg-charcoal-black text-bone-white hover:bg-saddle-brown transition-colors disabled:opacity-50"
                          >
                            {capacitySaving ? '...' : 'Save'}
                          </button>
                          <button
                            onClick={() => setEditingCapacity(false)}
                            className="px-3 py-2 text-xs border border-dust-gray hover:bg-dust-gray hover:text-bone-white transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                        <p className="text-xs text-dust-gray">Set how many buyer leads you can handle at once. We&apos;ll pause new leads when you hit this limit.</p>
                      </div>
                    )}
                  </div>
                </div>

                <div className="p-6 border border-dust-gray bg-white">
                  <h3 className="font-serif text-xl mb-4">Your Operation</h3>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-saddle-brown">State</span>
                      <span>{rancherInfo.state}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-saddle-brown">Beef Types</span>
                      <span>{rancherInfo.beefTypes || 'Not set'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-saddle-brown">Monthly Capacity</span>
                      <span>{rancherInfo.monthlyCapacity} head</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-saddle-brown">Agreement</span>
                      <span>{rancherInfo.agreementSigned ? 'Signed' : 'Pending'}</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Recent Active Leads */}
              {activeRefs.length > 0 && (
                <>
                  <h3 className="font-serif text-xl">Recent Leads</h3>
                  <div className="space-y-3">
                    {activeRefs.slice(0, 3).map((ref) => (
                      <ReferralRow key={ref.id} referral={ref} onUpdate={updateReferralStatus} onClose={() => setCloseModal(ref)} updating={updating} />
                    ))}
                    {activeRefs.length > 3 && (
                      <button onClick={() => setActiveTab('referrals')} className="text-sm text-saddle-brown hover:text-charcoal-black transition-colors">
                        View all {activeRefs.length} active leads →
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Referrals Tab */}
          {activeTab === 'referrals' && (
            <div className="space-y-8">
              <h2 className="font-serif text-2xl">Active Leads</h2>
              {activeRefs.length > 0 ? (
                <div className="space-y-4">
                  {activeRefs.map((ref) => (
                    <ReferralCard key={ref.id} referral={ref} onUpdate={updateReferralStatus} onClose={() => setCloseModal(ref)} updating={updating} />
                  ))}
                </div>
              ) : (
                <div className="p-8 border border-dust-gray text-center bg-white">
                  <p className="text-saddle-brown">No active leads right now. New buyer introductions will appear here.</p>
                </div>
              )}

              {closedRefs.length > 0 && (
                <>
                  <Divider />
                  <h2 className="font-serif text-2xl">Closed Deals</h2>
                  <div className="space-y-4">
                    {closedRefs.map((ref) => (
                      <div key={ref.id} className="p-4 border border-dust-gray bg-white flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                        <div>
                          <span className={`inline-block px-2 py-0.5 text-xs font-medium ${statusStyles[ref.status] || 'bg-gray-100 text-gray-600'}`}>
                            {ref.status}
                          </span>
                          <p className="font-medium mt-1">{ref.buyer_name}</p>
                          <p className="text-xs text-dust-gray">{ref.closed_at ? new Date(ref.closed_at).toLocaleDateString() : ''}</p>
                        </div>
                        {ref.status === 'Closed Won' && (
                          <div className="text-right">
                            <p className="font-serif text-lg">${ref.sale_amount.toLocaleString()}</p>
                            <p className="text-xs text-dust-gray">Commission: ${ref.commission_due.toLocaleString()}</p>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Earnings Tab */}
          {activeTab === 'earnings' && (
            <div className="space-y-8">
              <h2 className="font-serif text-2xl">Earnings Summary</h2>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <StatCard label="Total Revenue" value={`$${stats.totalRevenue.toLocaleString()}`} />
                <StatCard label="Commission (10%)" value={`$${stats.totalCommission.toLocaleString()}`} />
                <StatCard label="Your Net" value={`$${stats.netEarnings.toLocaleString()}`} />
                <StatCard label="Unpaid Commission" value={`$${stats.unpaidCommission.toLocaleString()}`} sub={stats.unpaidCommission > 0 ? 'Invoice pending' : ''} />
              </div>

              <Divider />

              <h3 className="font-serif text-xl">Completed Sales</h3>
              {referrals.filter(r => r.status === 'Closed Won').length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-dust-gray text-left">
                        <th className="py-3 pr-4 font-medium">Buyer</th>
                        <th className="py-3 pr-4 font-medium">Sale</th>
                        <th className="py-3 pr-4 font-medium">Commission</th>
                        <th className="py-3 pr-4 font-medium">Your Net</th>
                        <th className="py-3 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {referrals.filter(r => r.status === 'Closed Won').map((ref) => (
                        <tr key={ref.id} className="border-b border-gray-100">
                          <td className="py-3 pr-4">{ref.buyer_name}</td>
                          <td className="py-3 pr-4">${ref.sale_amount.toLocaleString()}</td>
                          <td className="py-3 pr-4">${ref.commission_due.toLocaleString()}</td>
                          <td className="py-3 pr-4 font-medium">${(ref.sale_amount - ref.commission_due).toLocaleString()}</td>
                          <td className="py-3">
                            <span className={`px-2 py-0.5 text-xs ${ref.commission_paid ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'}`}>
                              {ref.commission_paid ? 'Paid' : 'Pending'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="p-8 border border-dust-gray text-center bg-white">
                  <p className="text-saddle-brown">No completed sales yet. Close your first deal to see earnings here.</p>
                </div>
              )}
            </div>
          )}

          {/* Network Benefits Tab */}
          {activeTab === 'benefits' && (
            <div className="space-y-6">
              <div>
                <h2 className="font-serif text-2xl">Network Benefits</h2>
                <p className="text-sm text-saddle-brown mt-1">
                  Exclusive deals and partnerships available to BuyHalfCow ranchers.
                </p>
              </div>

              {benefits.length > 0 ? (
                <div className="grid gap-4 md:grid-cols-2">
                  {benefits.map((benefit) => (
                    <div key={benefit.id} className="p-6 border border-dust-gray bg-white space-y-3">
                      <div className="flex items-start justify-between">
                        <h3 className="font-serif text-lg">{benefit.brand_name}</h3>
                        {benefit.discount_offered > 0 && (
                          <span className="px-2 py-1 text-xs font-bold bg-green-100 text-green-800">
                            {benefit.discount_offered}% OFF
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-saddle-brown">{benefit.product_type}</p>
                      {benefit.description && (
                        <p className="text-sm">{benefit.description}</p>
                      )}
                      <div className="flex gap-3 pt-2">
                        {benefit.website && (
                          <a
                            href={benefit.website.startsWith('http') ? benefit.website : `https://${benefit.website}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="px-4 py-2 text-xs border border-charcoal-black hover:bg-charcoal-black hover:text-bone-white transition-colors"
                          >
                            Visit Website
                          </a>
                        )}
                        {benefit.contact_email && (
                          <a
                            href={`mailto:${benefit.contact_email}`}
                            className="px-4 py-2 text-xs border border-dust-gray hover:bg-dust-gray hover:text-bone-white transition-colors"
                          >
                            Contact
                          </a>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-8 border border-dust-gray text-center bg-white">
                  <p className="text-saddle-brown">Partner benefits are being finalized. Check back soon for exclusive deals on insurance, equipment, and more.</p>
                </div>
              )}
            </div>
          )}

          {/* My Page Tab */}
          {activeTab === 'my_page' && (
            <div className="space-y-8">
              <div className="flex flex-col sm:flex-row justify-between items-start gap-4">
                <div>
                  <h2 className="font-serif text-2xl">My Landing Page</h2>
                  <p className="text-sm text-saddle-brown mt-1">
                    Fill this out to publish your public ranch page on BuyHalfCow.
                  </p>
                </div>
                {rancherInfo.slug && (
                  <a
                    href={`/ranchers/${rancherInfo.slug}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm px-4 py-2 border border-charcoal-black hover:bg-charcoal-black hover:text-bone-white transition-colors"
                  >
                    Preview Page →
                  </a>
                )}
              </div>

              {!rancherInfo.pageLive && (
                <div className="p-4 bg-yellow-50 border border-yellow-400 text-sm text-saddle-brown flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                  <p>Your page is not live yet. Fill out the fields below and request to go live when you&apos;re ready.</p>
                  {goLiveRequested ? (
                    <span className="text-xs bg-green-100 text-green-800 px-3 py-1.5 whitespace-nowrap">Request sent!</span>
                  ) : (
                    <button
                      onClick={handleRequestGoLive}
                      disabled={goLiveLoading || !rancherInfo.slug}
                      className="px-4 py-2 text-xs bg-charcoal-black text-bone-white hover:bg-saddle-brown transition-colors whitespace-nowrap disabled:opacity-50"
                    >
                      {goLiveLoading ? 'Requesting...' : 'Request Go Live'}
                    </button>
                  )}
                </div>
              )}

              {/* Page Click Stats */}
              {rancherInfo.pageLive && (rancherInfo.quarterClicks > 0 || rancherInfo.halfClicks > 0 || rancherInfo.wholeClicks > 0) && (
                <div className="grid grid-cols-3 gap-4">
                  <div className="p-4 border border-dust-gray bg-white text-center">
                    <div className="font-serif text-2xl">{rancherInfo.quarterClicks}</div>
                    <p className="text-xs text-saddle-brown mt-1 uppercase tracking-wider">Quarter Clicks</p>
                  </div>
                  <div className="p-4 border border-dust-gray bg-white text-center">
                    <div className="font-serif text-2xl">{rancherInfo.halfClicks}</div>
                    <p className="text-xs text-saddle-brown mt-1 uppercase tracking-wider">Half Clicks</p>
                  </div>
                  <div className="p-4 border border-dust-gray bg-white text-center">
                    <div className="font-serif text-2xl">{rancherInfo.wholeClicks}</div>
                    <p className="text-xs text-saddle-brown mt-1 uppercase tracking-wider">Whole Clicks</p>
                  </div>
                </div>
              )}

              <div className="grid md:grid-cols-2 gap-8">

                {/* Left column: Brand & Story */}
                <div className="space-y-5">
                  <h3 className="font-serif text-lg border-b border-dust-gray pb-2">Brand &amp; Story</h3>

                  <div className="space-y-1">
                    <label className="block text-sm font-medium">Page URL Slug <span className="text-dust-gray font-normal">(e.g. rocking-r-ranch)</span></label>
                    <input
                      type="text"
                      value={pageForm['Slug'] || ''}
                      onChange={e => setPageForm(p => ({ ...p, 'Slug': e.target.value }))}
                      placeholder="your-ranch-name"
                      className="w-full px-4 py-3 border border-dust-gray bg-bone-white focus:outline-none focus:border-charcoal-black text-sm"
                    />
                    {pageForm['Slug'] && (
                      <p className="text-xs text-dust-gray">buyhalfcow.com/ranchers/{pageForm['Slug'].toLowerCase().replace(/[^a-z0-9-]/g, '-')}</p>
                    )}
                  </div>

                  <div className="space-y-1">
                    <label className="block text-sm font-medium">Logo URL <span className="text-dust-gray font-normal">(paste a link to your logo image)</span></label>
                    <input
                      type="url"
                      value={pageForm['Logo URL'] || ''}
                      onChange={e => setPageForm(p => ({ ...p, 'Logo URL': e.target.value }))}
                      placeholder="https://..."
                      className="w-full px-4 py-3 border border-dust-gray bg-bone-white focus:outline-none focus:border-charcoal-black text-sm"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="block text-sm font-medium">Tagline <span className="text-dust-gray font-normal">(one sentence)</span></label>
                    <input
                      type="text"
                      value={pageForm['Tagline'] || ''}
                      onChange={e => setPageForm(p => ({ ...p, 'Tagline': e.target.value }))}
                      placeholder="Grass-fed Angus raised on open pasture in Colorado"
                      className="w-full px-4 py-3 border border-dust-gray bg-bone-white focus:outline-none focus:border-charcoal-black text-sm"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="block text-sm font-medium">About Your Ranch</label>
                    <textarea
                      rows={6}
                      value={pageForm['About Text'] || ''}
                      onChange={e => setPageForm(p => ({ ...p, 'About Text': e.target.value }))}
                      placeholder="Tell buyers your story — how long you've been ranching, your practices, what makes you different..."
                      className="w-full px-4 py-3 border border-dust-gray bg-bone-white focus:outline-none focus:border-charcoal-black text-sm"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="block text-sm font-medium">Interview Video URL <span className="text-dust-gray font-normal">(YouTube link)</span></label>
                    <input
                      type="url"
                      value={pageForm['Video URL'] || ''}
                      onChange={e => setPageForm(p => ({ ...p, 'Video URL': e.target.value }))}
                      placeholder="https://youtube.com/watch?v=..."
                      className="w-full px-4 py-3 border border-dust-gray bg-bone-white focus:outline-none focus:border-charcoal-black text-sm"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="block text-sm font-medium">Custom Notes <span className="text-dust-gray font-normal">(optional — anything extra buyers should know)</span></label>
                    <textarea
                      rows={3}
                      value={pageForm['Custom Notes'] || ''}
                      onChange={e => setPageForm(p => ({ ...p, 'Custom Notes': e.target.value }))}
                      placeholder="e.g. We do on-farm pickup only. Delivery available within 50 miles..."
                      className="w-full px-4 py-3 border border-dust-gray bg-bone-white focus:outline-none focus:border-charcoal-black text-sm"
                    />
                  </div>
                </div>

                {/* Right column: Pricing */}
                <div className="space-y-5">
                  <h3 className="font-serif text-lg border-b border-dust-gray pb-2">Pricing &amp; Payment</h3>
                  <p className="text-xs text-dust-gray">Leave a section blank if you don't offer that cut size. Payment links go to your Square, PayPal, or Stripe checkout.</p>

                  {/* Quarter */}
                  <div className="p-4 border border-dust-gray bg-white space-y-3">
                    <p className="text-sm font-medium uppercase tracking-wider">Quarter</p>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-xs text-dust-gray">Price ($)</label>
                        <input
                          type="number"
                          value={pageForm['Quarter Price'] || ''}
                          onChange={e => setPageForm(p => ({ ...p, 'Quarter Price': e.target.value }))}
                          placeholder="450"
                          className="w-full px-3 py-2 border border-dust-gray bg-bone-white focus:outline-none focus:border-charcoal-black text-sm"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-dust-gray">Approx. lbs</label>
                        <input
                          type="text"
                          value={pageForm['Quarter lbs'] || ''}
                          onChange={e => setPageForm(p => ({ ...p, 'Quarter lbs': e.target.value }))}
                          placeholder="~85 lbs"
                          className="w-full px-3 py-2 border border-dust-gray bg-bone-white focus:outline-none focus:border-charcoal-black text-sm"
                        />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-dust-gray">Payment Link</label>
                      <input
                        type="url"
                        value={pageForm['Quarter Payment Link'] || ''}
                        onChange={e => setPageForm(p => ({ ...p, 'Quarter Payment Link': e.target.value }))}
                        placeholder="https://square.com/pay/..."
                        className="w-full px-3 py-2 border border-dust-gray bg-bone-white focus:outline-none focus:border-charcoal-black text-sm"
                      />
                    </div>
                  </div>

                  {/* Half */}
                  <div className="p-4 border-2 border-saddle-brown bg-white space-y-3">
                    <p className="text-sm font-medium uppercase tracking-wider text-saddle-brown">Half <span className="text-xs font-normal normal-case text-dust-gray">(most popular)</span></p>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-xs text-dust-gray">Price ($)</label>
                        <input
                          type="number"
                          value={pageForm['Half Price'] || ''}
                          onChange={e => setPageForm(p => ({ ...p, 'Half Price': e.target.value }))}
                          placeholder="875"
                          className="w-full px-3 py-2 border border-dust-gray bg-bone-white focus:outline-none focus:border-charcoal-black text-sm"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-dust-gray">Approx. lbs</label>
                        <input
                          type="text"
                          value={pageForm['Half lbs'] || ''}
                          onChange={e => setPageForm(p => ({ ...p, 'Half lbs': e.target.value }))}
                          placeholder="~170 lbs"
                          className="w-full px-3 py-2 border border-dust-gray bg-bone-white focus:outline-none focus:border-charcoal-black text-sm"
                        />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-dust-gray">Payment Link</label>
                      <input
                        type="url"
                        value={pageForm['Half Payment Link'] || ''}
                        onChange={e => setPageForm(p => ({ ...p, 'Half Payment Link': e.target.value }))}
                        placeholder="https://square.com/pay/..."
                        className="w-full px-3 py-2 border border-dust-gray bg-bone-white focus:outline-none focus:border-charcoal-black text-sm"
                      />
                    </div>
                  </div>

                  {/* Whole */}
                  <div className="p-4 border border-dust-gray bg-white space-y-3">
                    <p className="text-sm font-medium uppercase tracking-wider">Whole</p>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-xs text-dust-gray">Price ($)</label>
                        <input
                          type="number"
                          value={pageForm['Whole Price'] || ''}
                          onChange={e => setPageForm(p => ({ ...p, 'Whole Price': e.target.value }))}
                          placeholder="1600"
                          className="w-full px-3 py-2 border border-dust-gray bg-bone-white focus:outline-none focus:border-charcoal-black text-sm"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-dust-gray">Approx. lbs</label>
                        <input
                          type="text"
                          value={pageForm['Whole lbs'] || ''}
                          onChange={e => setPageForm(p => ({ ...p, 'Whole lbs': e.target.value }))}
                          placeholder="~340 lbs"
                          className="w-full px-3 py-2 border border-dust-gray bg-bone-white focus:outline-none focus:border-charcoal-black text-sm"
                        />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-dust-gray">Payment Link</label>
                      <input
                        type="url"
                        value={pageForm['Whole Payment Link'] || ''}
                        onChange={e => setPageForm(p => ({ ...p, 'Whole Payment Link': e.target.value }))}
                        placeholder="https://square.com/pay/..."
                        className="w-full px-3 py-2 border border-dust-gray bg-bone-white focus:outline-none focus:border-charcoal-black text-sm"
                      />
                    </div>
                  </div>

                  <Divider />

                  {/* Reservation */}
                  <div className="space-y-3">
                    <p className="text-sm font-medium">Reservation / Deposit</p>
                    <div className="space-y-1">
                      <label className="text-xs text-dust-gray">Next Processing Date</label>
                      <input
                        type="date"
                        value={pageForm['Next Processing Date'] || ''}
                        onChange={e => setPageForm(p => ({ ...p, 'Next Processing Date': e.target.value }))}
                        className="w-full px-3 py-2 border border-dust-gray bg-bone-white focus:outline-none focus:border-charcoal-black text-sm"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-dust-gray">Reserve Link <span className="text-dust-gray">(deposit / waitlist link)</span></label>
                      <input
                        type="url"
                        value={pageForm['Reserve Link'] || ''}
                        onChange={e => setPageForm(p => ({ ...p, 'Reserve Link': e.target.value }))}
                        placeholder="https://..."
                        className="w-full px-3 py-2 border border-dust-gray bg-bone-white focus:outline-none focus:border-charcoal-black text-sm"
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Save button */}
              {pageError && (
                <div className="p-3 border border-[#8C2F2F] text-[#8C2F2F] text-sm">{pageError}</div>
              )}
              {pageSaved && (
                <div className="p-3 border border-green-600 text-green-700 bg-green-50 text-sm">Changes saved! {rancherInfo.slug && <span>Your page: <a href={`/ranchers/${rancherInfo.slug}`} target="_blank" className="underline">/ranchers/{rancherInfo.slug}</a></span>}</div>
              )}
              <div className="flex items-center gap-4">
                <button
                  onClick={handleSavePage}
                  disabled={pageSaving}
                  className="px-8 py-3 bg-charcoal-black text-bone-white hover:bg-saddle-brown transition-colors font-medium uppercase text-sm tracking-wider disabled:opacity-50"
                >
                  {pageSaving ? 'Saving...' : 'Save Page'}
                </button>
                {!rancherInfo.pageLive && rancherInfo.slug && (
                  <p className="text-xs text-dust-gray">
                    After saving, click &quot;Request Go Live&quot; above to notify us.
                  </p>
                )}
              </div>
            </div>
          )}

          <Divider />

          <div className="text-center text-sm text-dust-gray space-y-2">
            <p>Questions? Email <a href="mailto:support@buyhalfcow.com" className="text-charcoal-black hover:text-saddle-brown transition-colors">support@buyhalfcow.com</a></p>
            <Link href="/" className="text-saddle-brown hover:text-charcoal-black transition-colors">
              &larr; Back to home
            </Link>
          </div>
        </div>
      </Container>

      {/* Close Deal Modal */}
      {closeModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-bone-white p-8 max-w-md w-full space-y-6">
            <div className="flex justify-between items-start">
              <h2 className="font-serif text-2xl">Close Deal</h2>
              <button onClick={() => setCloseModal(null)} className="text-2xl leading-none hover:text-saddle-brown">×</button>
            </div>
            <p className="text-sm text-saddle-brown">Buyer: <strong className="text-charcoal-black">{closeModal.buyer_name}</strong></p>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-2">Outcome</label>
                <select
                  value={closeForm.status}
                  onChange={(e) => setCloseForm(prev => ({ ...prev, status: e.target.value }))}
                  className="w-full px-4 py-3 border border-dust-gray bg-bone-white focus:outline-none focus:border-charcoal-black"
                >
                  <option value="Closed Won">Deal Closed (Sale Made)</option>
                  <option value="Closed Lost">No Sale (Lost)</option>
                </select>
              </div>

              {closeForm.status === 'Closed Won' && (
                <div>
                  <label className="block text-sm font-medium mb-2">Sale Amount ($)</label>
                  <input
                    type="number"
                    value={closeForm.saleAmount}
                    onChange={(e) => setCloseForm(prev => ({ ...prev, saleAmount: e.target.value }))}
                    placeholder="e.g. 2500"
                    className="w-full px-4 py-3 border border-dust-gray bg-bone-white focus:outline-none focus:border-charcoal-black"
                  />
                  {closeForm.saleAmount && (
                    <p className="text-xs text-saddle-brown mt-1">
                      Commission (10%): ${(parseFloat(closeForm.saleAmount) * 0.10).toFixed(2)} &middot; You keep: ${(parseFloat(closeForm.saleAmount) * 0.90).toFixed(2)}
                    </p>
                  )}
                </div>
              )}

              <div>
                <label className="block text-sm font-medium mb-2">Notes (optional)</label>
                <textarea
                  value={closeForm.notes}
                  onChange={(e) => setCloseForm(prev => ({ ...prev, notes: e.target.value }))}
                  rows={3}
                  placeholder="Any details about the deal..."
                  className="w-full px-4 py-3 border border-dust-gray bg-bone-white focus:outline-none focus:border-charcoal-black"
                />
              </div>
            </div>

            {updateError && (
              <div className="p-3 border border-[#8C2F2F] text-[#8C2F2F] text-sm">
                {updateError}
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={() => { setCloseModal(null); setUpdateError(''); }}
                className="flex-1 px-4 py-3 border border-charcoal-black text-charcoal-black hover:bg-charcoal-black hover:text-bone-white transition-colors font-medium uppercase text-sm tracking-wider"
              >
                Cancel
              </button>
              <button
                onClick={handleCloseDeal}
                disabled={!!updating || (closeForm.status === 'Closed Won' && !closeForm.saleAmount)}
                className="flex-1 px-4 py-3 bg-charcoal-black text-bone-white hover:bg-saddle-brown transition-colors font-medium uppercase text-sm tracking-wider disabled:opacity-50"
              >
                {updating ? 'Saving...' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="p-4 border border-dust-gray bg-white text-center">
      <div className="font-serif text-2xl">{value}</div>
      <p className="text-xs text-saddle-brown mt-1 uppercase tracking-wider">{label}</p>
      {sub && <p className="text-xs text-dust-gray mt-0.5">{sub}</p>}
    </div>
  );
}

function ReferralRow({ referral, onUpdate, onClose, updating }: { referral: Referral; onUpdate: (id: string, status: string) => void; onClose: () => void; updating: string | null }) {
  return (
    <div className="p-4 border border-dust-gray bg-white flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
      <div>
        <span className={`inline-block px-2 py-0.5 text-xs font-medium ${statusStyles[referral.status] || 'bg-gray-100'}`}>
          {referral.status}
        </span>
        <p className="font-medium mt-1">{referral.buyer_name}</p>
        <p className="text-xs text-dust-gray">{referral.buyer_state} &middot; {referral.order_type}</p>
      </div>
      <div className="flex gap-2">
        {referral.status === 'Intro Sent' && (
          <button
            onClick={() => onUpdate(referral.id, 'Rancher Contacted')}
            disabled={updating === referral.id}
            className="px-3 py-1.5 text-xs border border-charcoal-black hover:bg-charcoal-black hover:text-bone-white transition-colors disabled:opacity-50"
          >
            Mark Contacted
          </button>
        )}
        <button
          onClick={onClose}
          className="px-3 py-1.5 text-xs bg-charcoal-black text-bone-white hover:bg-saddle-brown transition-colors"
        >
          Close Deal
        </button>
      </div>
    </div>
  );
}

function ReferralCard({ referral, onUpdate, onClose, updating }: { referral: Referral; onUpdate: (id: string, status: string) => void; onClose: () => void; updating: string | null }) {
  return (
    <div className="p-6 border border-dust-gray bg-white space-y-4">
      <div className="flex flex-col sm:flex-row justify-between items-start gap-3">
        <div>
          <span className={`inline-block px-2 py-0.5 text-xs font-medium ${statusStyles[referral.status] || 'bg-gray-100'}`}>
            {referral.status}
          </span>
          <h3 className="font-serif text-xl mt-2">{referral.buyer_name}</h3>
          <p className="text-sm text-dust-gray">
            {referral.intro_sent_at ? `Introduced ${new Date(referral.intro_sent_at).toLocaleDateString()}` : ''}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 text-sm">
        <div><span className="text-saddle-brown">Email:</span> <a href={`mailto:${referral.buyer_email}`} className="text-charcoal-black hover:underline">{referral.buyer_email}</a></div>
        <div><span className="text-saddle-brown">Phone:</span> <a href={`tel:${referral.buyer_phone}`} className="text-charcoal-black hover:underline">{referral.buyer_phone}</a></div>
        <div><span className="text-saddle-brown">State:</span> {referral.buyer_state}</div>
        <div><span className="text-saddle-brown">Looking for:</span> {referral.order_type}</div>
        <div><span className="text-saddle-brown">Budget:</span> {referral.budget_range}</div>
      </div>

      {referral.notes && (
        <p className="text-sm p-3 bg-bone-white border border-dust-gray">
          <span className="text-saddle-brown font-medium">Notes:</span> {referral.notes}
        </p>
      )}

      <div className="flex flex-wrap gap-2 pt-2">
        {referral.status === 'Intro Sent' && (
          <button
            onClick={() => onUpdate(referral.id, 'Rancher Contacted')}
            disabled={updating === referral.id}
            className="px-4 py-2 text-sm border border-charcoal-black hover:bg-charcoal-black hover:text-bone-white transition-colors disabled:opacity-50"
          >
            {updating === referral.id ? 'Updating...' : "I've Contacted This Buyer"}
          </button>
        )}
        {referral.status === 'Rancher Contacted' && (
          <button
            onClick={() => onUpdate(referral.id, 'Negotiation')}
            disabled={updating === referral.id}
            className="px-4 py-2 text-sm border border-charcoal-black hover:bg-charcoal-black hover:text-bone-white transition-colors disabled:opacity-50"
          >
            {updating === referral.id ? 'Updating...' : 'In Negotiation'}
          </button>
        )}
        <button
          onClick={onClose}
          className="px-4 py-2 text-sm bg-charcoal-black text-bone-white hover:bg-saddle-brown transition-colors"
        >
          Close Deal
        </button>
      </div>
    </div>
  );
}
