'use client';

import { useState, useEffect } from 'react';
import Container from '../components/Container';
import Divider from '../components/Divider';
import Button from '../components/Button';
import AdminAuthGuard from '../components/AdminAuthGuard';

type Tab = 'consumers' | 'ranchers' | 'brands' | 'landDeals';

interface ReferralStats {
  totalBuyers: number;
  totalRanchers: number;
  totalReferrals: number;
  pendingApproval: number;
  closedDealsThisMonth: { count: number; totalCommission: number };
}

interface Consumer {
  id: string;
  first_name: string;
  email: string;
  phone: string;
  state: string;
  interests: string[];
  status: string;
  membership: string;
  segment: string;
  order_type: string;
  budget_range: string;
  notes: string;
  intent_score: number;
  intent_classification: string;
  lead_source: string;
  referral_status: string;
  admin_notes: string;
  last_contacted: string;
  campaign: string;
  created_at: string;
}

interface Rancher {
  id: string;
  ranch_name: string;
  operator_name: string;
  email: string;
  phone: string;
  state: string;
  beef_types: string;
  status: string;
  certified: boolean;
  ranch_tour_interested?: boolean;
  ranch_tour_availability?: string;
  active_status?: string;
  onboarding_status?: string;
  current_active_referrals?: number;
  max_active_referrals?: number;
  monthly_capacity?: number;
  agreement_signed?: boolean;
  docs_sent_at?: string;
  verification_status?: string;
  featured?: boolean;
  release_date?: string;
  created_at: string;
}

interface Brand {
  id: string;
  brand_name: string;
  contact_name: string;
  email: string;
  product_type: string;
  discount_offered: number;
  status: string;
  active: boolean;
  created_at: string;
}

interface LandDeal {
  id: string;
  seller_name: string;
  property_location: string;
  state: string;
  acreage: number;
  asking_price: string;
  status: string;
  visible_to_members: boolean;
  created_at: string;
}

export default function AdminPage() {
  const [activeTab, setActiveTab] = useState<Tab>('consumers');
  const [consumers, setConsumers] = useState<Consumer[]>([]);
  const [ranchers, setRanchers] = useState<Rancher[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [landDeals, setLandDeals] = useState<LandDeal[]>([]);
  const [loading, setLoading] = useState(true);
  const [rancherStateFilter, setRancherStateFilter] = useState<string>('');
  const [consumerStateFilter, setConsumerStateFilter] = useState<string>('');
  const [intentFilter, setIntentFilter] = useState<string>('');
  const [segmentFilter, setSegmentFilter] = useState<string>('');
  const [refStats, setRefStats] = useState<ReferralStats | null>(null);
  const [notesModal, setNotesModal] = useState<Consumer | null>(null);
  const [notesText, setNotesText] = useState('');
  const [savingNotes, setSavingNotes] = useState(false);
  const [onboardingModal, setOnboardingModal] = useState<Rancher | null>(null);
  const [onboardingForm, setOnboardingForm] = useState({
    callSummary: '',
    confirmedCapacity: 10,
    specialNotes: '',
    includeVerification: true,
  });
  const [sendingDocs, setSendingDocs] = useState(false);
  const [releaseModal, setReleaseModal] = useState<Rancher | null>(null);
  const [releaseAnnounce, setReleaseAnnounce] = useState(true);

  useEffect(() => {
    fetchAllData();
  }, []);

  const fetchAllData = async () => {
    setLoading(true);
    try {
      const [consumersRes, ranchersRes, brandsRes, landDealsRes, refStatsRes] = await Promise.all([
        fetch('/api/admin/consumers'),
        fetch('/api/admin/ranchers'),
        fetch('/api/admin/brands'),
        fetch('/api/admin/landDeals'),
        fetch('/api/admin/referrals/stats').catch(() => null),
      ]);

      const [consumersData, ranchersData, brandsData, landDealsData] = await Promise.all([
        consumersRes.json(),
        ranchersRes.json(),
        brandsRes.json(),
        landDealsRes.json(),
      ]);

      setConsumers(consumersData);
      setRanchers(ranchersData);
      setBrands(brandsData);
      setLandDeals(landDealsData);

      if (refStatsRes && refStatsRes.ok) {
        setRefStats(await refStatsRes.json());
      }
    } catch (error) {
      console.error('Error fetching admin data:', error);
    }
    setLoading(false);
  };

  const updateConsumerStatus = async (id: string, status: string, membership: string) => {
    try {
      await fetch(`/api/admin/consumers/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, membership }),
      });
      fetchAllData();
    } catch (error) {
      console.error('Error updating consumer:', error);
    }
  };

  const saveAdminNotes = async (id: string, notes: string) => {
    setSavingNotes(true);
    try {
      await fetch(`/api/admin/consumers/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_notes: notes }),
      });
      setNotesModal(null);
      fetchAllData();
    } catch {
      alert('Failed to save notes');
    }
    setSavingNotes(false);
  };

  const logCall = async (consumer: Consumer) => {
    const now = new Date().toISOString();
    try {
      await fetch(`/api/admin/consumers/${consumer.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ last_contacted: now }),
      });
      fetchAllData();
    } catch {
      alert('Failed to log call');
    }
  };

  const updateRancherStatus = async (id: string, status: string, certified: boolean, callScheduled?: boolean) => {
    try {
      const body: any = { status, certified };
      if (callScheduled !== undefined) {
        body.call_scheduled = callScheduled;
      }
      await fetch(`/api/admin/ranchers/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      fetchAllData();
    } catch (error) {
      console.error('Error updating rancher:', error);
    }
  };

  const updateBrandStatus = async (id: string, status: string, active: boolean) => {
    try {
      await fetch(`/api/admin/brands/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, active }),
      });
      fetchAllData();
    } catch (error) {
      console.error('Error updating brand:', error);
    }
  };

  const updateLandDealStatus = async (id: string, status: string, visible: boolean) => {
    try {
      await fetch(`/api/admin/landDeals/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, visible_to_members: visible }),
      });
      fetchAllData();
    } catch (error) {
      console.error('Error updating land deal:', error);
    }
  };

  const handleSendOnboarding = async (rancherId: string) => {
    setSendingDocs(true);
    try {
      const res = await fetch(`/api/ranchers/${rancherId}/send-onboarding`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(onboardingForm),
      });
      const data = await res.json();
      if (data.success) {
        alert('Onboarding package sent!');
        setOnboardingModal(null);
        setOnboardingForm({ callSummary: '', confirmedCapacity: 10, specialNotes: '', includeVerification: true });
        fetchAllData();
      } else {
        alert(data.error || 'Failed to send onboarding package');
      }
    } catch {
      alert('Error sending onboarding package');
    }
    setSendingDocs(false);
  };

  const updateOnboardingStatus = async (rancherId: string, newStatus: string) => {
    try {
      await fetch(`/api/admin/ranchers/${rancherId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ onboarding_status: newStatus }),
      });
      fetchAllData();
    } catch {
      alert('Error updating onboarding status');
    }
  };

  const handleRelease = async (rancher: Rancher) => {
    try {
      await fetch(`/api/admin/ranchers/${rancher.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          onboarding_status: 'Live',
          active_status: 'Active',
          featured: true,
          release_date: new Date().toISOString(),
        }),
      });
      if (releaseAnnounce) {
        const rName = rancher.operator_name || rancher.ranch_name;
        const state = rancher.state;
        window.open(
          `/admin/broadcast?prefill=${encodeURIComponent(JSON.stringify({
            campaignName: `rancher-release-${rName.toLowerCase().replace(/\s/g, '-')}`,
            subject: `New Rancher Available: ${rName} — ${state}`,
            message: `We're excited to announce a new verified rancher has joined the BuyHalfCow network.\n\n${rName} from ${state} is now accepting orders. As a member, you have exclusive early access.\n\nLog in to your member dashboard to learn more and connect.`,
          }))}`,
          '_self'
        );
      } else {
        setReleaseModal(null);
        fetchAllData();
      }
    } catch {
      alert('Error releasing rancher');
    }
  };

  if (loading) {
    return (
      <AdminAuthGuard>
        <main className="min-h-screen py-24 bg-[#F4F1EC] text-[#0E0E0E]">
          <Container>
            <div className="text-center"><p className="text-lg text-[#6B4F3F]">Loading admin dashboard...</p>
            </div>
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
          {/* Header */}
          <div className="flex justify-between items-start mb-8">
            <div className="text-left space-y-4">
              <h1 className="font-[family-name:var(--font-serif)] text-3xl md:text-4xl">
                Admin Dashboard
              </h1>
            </div>
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

          <div className="text-center space-y-4">
            <p className="text-sm text-[#6B4F3F]">Internal CRM — BuyHalfCow</p>
          </div>

          <Divider />

          {/* Stats Overview */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="p-4 border border-[#A7A29A] text-center">
              <div className="font-[family-name:var(--font-serif)] text-3xl">{consumers.length}</div>
              <div className="text-sm text-[#6B4F3F]">Consumers</div>
            </div>
            <div className="p-4 border border-[#A7A29A] text-center">
              <div className="font-[family-name:var(--font-serif)] text-3xl">{ranchers.length}</div>
              <div className="text-sm text-[#6B4F3F]">Ranchers</div>
            </div>
            <div className="p-4 border border-[#A7A29A] text-center">
              <div className="font-[family-name:var(--font-serif)] text-3xl">{brands.length}</div>
              <div className="text-sm text-[#6B4F3F]">Brands</div>
            </div>
            <div className="p-4 border border-[#A7A29A] text-center">
              <div className="font-[family-name:var(--font-serif)] text-3xl">{landDeals.length}</div>
              <div className="text-sm text-[#6B4F3F]">Land Deals</div>
            </div>
          </div>

          {/* Referral Stats Banner */}
          {refStats && refStats.pendingApproval > 0 && (
            <div className="p-4 border-2 border-yellow-400 bg-yellow-50 flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="font-medium text-yellow-800">
                  {refStats.pendingApproval} referral{refStats.pendingApproval > 1 ? 's' : ''} pending approval
                </p>
                <p className="text-sm text-yellow-700">
                  {refStats.totalReferrals} total referrals &middot; {refStats.closedDealsThisMonth.count} closed this month (${refStats.closedDealsThisMonth.totalCommission.toLocaleString()} commission)
                </p>
              </div>
              <Button href="/admin/referrals">
                Review Referrals &rarr;
              </Button>
            </div>
          )}

          {/* Action Links */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Button href="/admin/referrals" variant="secondary">
              🤝 Referral Queue
            </Button>
            <Button href="/admin/heatmap" variant="secondary">
              🗺️ State Heatmap
            </Button>
            <Button href="/admin/commissions" variant="secondary">
              💰 Commissions
            </Button>
            <Button href="/admin/backfill" variant="secondary">
              📧 Backfill Campaign
            </Button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Button href="/admin/broadcast" variant="secondary">
              📤 Broadcast Email
            </Button>
            <Button href="/admin/analytics" variant="secondary">
              📊 Analytics
            </Button>
            <Button href="/admin/compliance" variant="secondary">
              📋 Compliance
            </Button>
            <Button href="/admin/inquiries" variant="secondary">
              📨 Inquiries
            </Button>
          </div>

          {/* Tab Navigation */}
          <div className="flex flex-wrap gap-2 border-b border-[#A7A29A]">
            <button
              onClick={() => setActiveTab('consumers')}
              className={`px-6 py-3 font-medium transition-colors ${
                activeTab === 'consumers'
                  ? 'bg-[#0E0E0E] text-[#F4F1EC]'
                  : 'text-[#0E0E0E] hover:bg-[#A7A29A]'
              }`}
            >
              Consumers
            </button>
            <button
              onClick={() => setActiveTab('ranchers')}
              className={`px-6 py-3 font-medium transition-colors ${
                activeTab === 'ranchers'
                  ? 'bg-[#0E0E0E] text-[#F4F1EC]'
                  : 'text-[#0E0E0E] hover:bg-[#A7A29A]'
              }`}
            >
              Ranchers
            </button>
            <button
              onClick={() => setActiveTab('brands')}
              className={`px-6 py-3 font-medium transition-colors ${
                activeTab === 'brands'
                  ? 'bg-[#0E0E0E] text-[#F4F1EC]'
                  : 'text-[#0E0E0E] hover:bg-[#A7A29A]'
              }`}
            >
              Brands
            </button>
            <button
              onClick={() => setActiveTab('landDeals')}
              className={`px-6 py-3 font-medium transition-colors ${
                activeTab === 'landDeals'
                  ? 'bg-[#0E0E0E] text-[#F4F1EC]'
                  : 'text-[#0E0E0E] hover:bg-[#A7A29A]'
              }`}
            >
              Land Deals
            </button>
          </div>

          {/* Tab Content */}
          <div className="mt-8">
            {/* CONSUMERS TAB */}
            {activeTab === 'consumers' && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
                  <h2 className="font-[family-name:var(--font-serif)] text-2xl">Consumer Applications</h2>
                  
                  <div className="flex items-center gap-3 flex-wrap">
                    <select
                      value={segmentFilter}
                      onChange={(e) => setSegmentFilter(e.target.value)}
                      className="px-4 py-2 border-2 border-[#0E0E0E] bg-[#F4F1EC] text-sm font-medium"
                    >
                      <option value="">All Segments</option>
                      <option value="Beef Buyer">Beef Buyers</option>
                      <option value="Community">Community</option>
                    </select>
                    <select
                      value={intentFilter}
                      onChange={(e) => setIntentFilter(e.target.value)}
                      className="px-4 py-2 border-2 border-[#0E0E0E] bg-[#F4F1EC] text-sm font-medium"
                    >
                      <option value="">All Intent</option>
                      <option value="High">High Intent</option>
                      <option value="Medium">Medium Intent</option>
                      <option value="Low">Low Intent</option>
                    </select>
                    <select
                      value={consumerStateFilter}
                      onChange={(e) => setConsumerStateFilter(e.target.value)}
                      className="px-4 py-2 border-2 border-[#0E0E0E] bg-[#F4F1EC] text-sm font-medium"
                    >
                      <option value="">All States ({consumers.length})</option>
                      {Array.from(new Set(consumers.map(c => c.state).filter(Boolean))).sort().map(state => {
                        const count = consumers.filter(c => c.state === state).length;
                        return <option key={state} value={state}>{state} ({count})</option>;
                      })}
                    </select>
                    
                    {consumerStateFilter && (
                      <button
                        onClick={async () => {
                          const filtered = consumers.filter(c => c.state === consumerStateFilter && c.status === 'pending');
                          if (filtered.length === 0) {
                            alert('No pending consumers in this state');
                            return;
                          }
                          if (!confirm(`Approve ${filtered.length} pending consumer(s) in ${consumerStateFilter}?`)) return;
                          for (const consumer of filtered) {
                            await updateConsumerStatus(consumer.id, 'approved', consumer.membership);
                          }
                          fetchAllData();
                        }}
                        className="px-4 py-2 bg-[#0E0E0E] text-[#F4F1EC] hover:bg-[#2A2A2A] text-sm font-medium whitespace-nowrap"
                      >
                        Approve All Pending
                      </button>
                    )}
                  </div>
                </div>
                
                {consumers.length === 0 ? (
                  <p className="text-[#6B4F3F]">No consumers yet.</p>
                ) : (
                  <>
                    <div className="space-y-4">
                      {consumers
                        .filter(c => !consumerStateFilter || c.state === consumerStateFilter)
                        .filter(c => !intentFilter || c.intent_classification === intentFilter)
                        .filter(c => !segmentFilter || c.segment === segmentFilter)
                        .sort((a, b) => b.intent_score - a.intent_score)
                        .map((consumer) => (
                      <div key={consumer.id} className="p-4 border border-[#A7A29A] space-y-3">
                        <div className="flex flex-wrap items-start justify-between gap-4">
                          <div className="flex-1 min-w-[200px]">
                            <div className="flex items-center gap-2 mb-1">
                              <h3 className="font-medium text-lg">{consumer.first_name}</h3>
                              {consumer.segment && (
                                <span className={`px-2 py-0.5 text-xs font-bold border ${
                                  consumer.segment === 'Beef Buyer' ? 'bg-red-50 text-red-800 border-red-300' :
                                  'bg-purple-50 text-purple-800 border-purple-300'
                                }`}>
                                  {consumer.segment}
                                </span>
                              )}
                              {consumer.intent_classification && (
                                <span className={`px-2 py-0.5 text-xs font-medium border ${
                                  consumer.intent_classification === 'High' ? 'bg-green-100 text-green-800 border-green-300' :
                                  consumer.intent_classification === 'Medium' ? 'bg-yellow-100 text-yellow-800 border-yellow-300' :
                                  'bg-gray-100 text-gray-600 border-gray-300'
                                }`}>
                                  {consumer.intent_classification} ({consumer.intent_score})
                                </span>
                              )}
                              {consumer.referral_status && consumer.referral_status !== 'Unmatched' && consumer.referral_status !== 'Community' && (
                                <span className="px-2 py-0.5 text-xs bg-blue-100 text-blue-800 border border-blue-300">
                                  {consumer.referral_status}
                                </span>
                              )}
                            </div>
                            <p className="text-sm text-[#6B4F3F]">
                              {consumer.email}
                              {consumer.phone && (
                                <> · <a href={`tel:${consumer.phone}`} className="underline hover:text-[#0E0E0E]">{consumer.phone}</a></>
                              )}
                            </p>
                            <p className="text-sm">State: {consumer.state}</p>
                            {consumer.order_type && <p className="text-sm">Order: {consumer.order_type} · Budget: {consumer.budget_range || 'N/A'}</p>}
                            {consumer.notes && <p className="text-sm text-[#6B4F3F] italic truncate max-w-md">&quot;{consumer.notes}&quot;</p>}
                            {consumer.campaign && <p className="text-xs text-[#A7A29A]">Source: {consumer.campaign}</p>}
                            {consumer.admin_notes && (
                              <p className="text-xs mt-1 px-2 py-1 bg-yellow-50 border-l-2 border-yellow-400 text-yellow-800">
                                Notes: {consumer.admin_notes}
                              </p>
                            )}
                            {consumer.last_contacted && (
                              <p className="text-xs text-green-700 mt-1">
                                Last contacted: {new Date(consumer.last_contacted).toLocaleDateString()}
                              </p>
                            )}
                          </div>
                          <div className="flex flex-col gap-2">
                            <select
                              value={consumer.status}
                              onChange={(e) => updateConsumerStatus(consumer.id, e.target.value, consumer.membership)}
                              className="px-3 py-1 border border-[#A7A29A] bg-[#F4F1EC] text-sm"
                            >
                              <option value="pending">Pending</option>
                              <option value="approved">Approved</option>
                              <option value="rejected">Rejected</option>
                            </select>
                            <select
                              value={consumer.membership}
                              onChange={(e) => updateConsumerStatus(consumer.id, consumer.status, e.target.value)}
                              className="px-3 py-1 border border-[#A7A29A] bg-[#F4F1EC] text-sm"
                            >
                              <option value="none">No Access</option>
                              <option value="active">Active Member</option>
                              <option value="inactive">Inactive</option>
                            </select>
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-[#A7A29A]/30">
                          <p className="text-xs text-[#6B4F3F]">
                            Applied: {new Date(consumer.created_at).toLocaleDateString()}
                          </p>
                          <button
                            onClick={() => { setNotesModal(consumer); setNotesText(consumer.admin_notes || ''); }}
                            className="px-3 py-1 text-xs border border-[#A7A29A] hover:bg-[#A7A29A] hover:text-white"
                          >
                            {consumer.admin_notes ? 'Edit Notes' : 'Add Notes'}
                          </button>
                          {consumer.phone && (
                            <button
                              onClick={() => { logCall(consumer); window.open(`tel:${consumer.phone}`); }}
                              className="px-3 py-1 text-xs bg-green-700 text-white hover:bg-green-800"
                            >
                              Log Call
                            </button>
                          )}
                          <a
                            href={`/admin/consumers/${consumer.id}`}
                            className="px-3 py-1 text-xs border border-[#0E0E0E] hover:bg-[#0E0E0E] hover:text-[#F4F1EC]"
                          >
                            View Details
                          </a>
                        </div>
                      </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* RANCHERS TAB */}
            {activeTab === 'ranchers' && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
                  <h2 className="font-[family-name:var(--font-serif)] text-2xl">Rancher Applications</h2>
                  
                  <div className="flex items-center gap-3">
                    <select
                      value={rancherStateFilter}
                      onChange={(e) => setRancherStateFilter(e.target.value)}
                      className="px-4 py-2 border-2 border-[#0E0E0E] bg-[#F4F1EC] text-sm font-medium"
                    >
                      <option value="">All States ({ranchers.length})</option>
                      {Array.from(new Set(ranchers.map(r => r.state).filter(Boolean))).sort().map(state => {
                        const count = ranchers.filter(r => r.state === state).length;
                        return <option key={state} value={state}>{state} ({count})</option>;
                      })}
                    </select>
                    
                    {rancherStateFilter && (
                      <>
                        <button
                          onClick={async () => {
                            const filtered = ranchers.filter(r => r.state === rancherStateFilter && r.status === 'pending');
                            if (filtered.length === 0) {
                              alert('No pending ranchers in this state');
                              return;
                            }
                            if (!confirm(`Approve ${filtered.length} pending rancher(s) in ${rancherStateFilter}?`)) return;
                            for (const rancher of filtered) {
                              await updateRancherStatus(rancher.id, 'approved', rancher.certified);
                            }
                            fetchAllData();
                          }}
                          className="px-4 py-2 bg-[#0E0E0E] text-[#F4F1EC] hover:bg-[#2A2A2A] text-sm font-medium whitespace-nowrap"
                        >
                          ✓ Approve All Pending
                        </button>
                        <button
                          onClick={async () => {
                            const filtered = ranchers.filter(r => r.state === rancherStateFilter && r.status === 'approved' && !r.certified);
                            if (filtered.length === 0) {
                              alert('No uncertified approved ranchers in this state');
                              return;
                            }
                            if (!confirm(`Certify ${filtered.length} rancher(s) in ${rancherStateFilter}?`)) return;
                            for (const rancher of filtered) {
                              await updateRancherStatus(rancher.id, 'approved', true);
                            }
                            fetchAllData();
                          }}
                          className="px-4 py-2 bg-transparent text-[#0E0E0E] border-2 border-[#0E0E0E] hover:bg-[#0E0E0E] hover:text-[#F4F1EC] text-sm font-medium whitespace-nowrap"
                        >
                          🏅 Certify All Approved
                        </button>
                      </>
                    )}
                  </div>
                </div>
                
                {ranchers.length === 0 ? (
                  <p className="text-[#6B4F3F]">No rancher applications yet.</p>
                ) : (
                  <>
                    {rancherStateFilter && (
                      <p className="text-sm text-[#6B4F3F] mb-4">
                        Showing {ranchers.filter(r => r.state === rancherStateFilter).length} rancher(s) in {rancherStateFilter}
                      </p>
                    )}
                    <div className="space-y-4">
                      {ranchers
                        .filter(r => !rancherStateFilter || r.state === rancherStateFilter)
                        .map((rancher) => (
                      <div key={rancher.id} className="p-4 border border-[#A7A29A] space-y-3">
                        <div className="flex flex-wrap items-start justify-between gap-4">
                          <div className="flex-1 min-w-[200px]">
                            <div className="flex items-center gap-2 mb-1">
                              <h3 className="font-medium text-lg">{rancher.ranch_name}</h3>
                              {rancher.onboarding_status && (
                                <span className={`px-2 py-0.5 text-xs border ${
                                  rancher.onboarding_status === 'Live' ? 'bg-green-100 text-green-800 border-green-300' :
                                  rancher.onboarding_status === 'Docs Sent' ? 'bg-orange-100 text-orange-800 border-orange-300' :
                                  rancher.onboarding_status === 'Agreement Signed' ? 'bg-blue-100 text-blue-800 border-blue-300' :
                                  rancher.onboarding_status === 'Verification Complete' ? 'bg-indigo-100 text-indigo-800 border-indigo-300' :
                                  'bg-gray-100 text-gray-600 border-gray-300'
                                }`}>
                                  {rancher.onboarding_status}
                                </span>
                              )}
                              {rancher.featured && (
                                <span className="px-2 py-0.5 text-xs font-bold bg-amber-100 text-amber-800 border border-amber-400">
                                  FEATURED
                                </span>
                              )}
                              {rancher.active_status && rancher.active_status !== 'Pending Onboarding' && (
                                <span className={`px-2 py-0.5 text-xs border ${
                                  rancher.active_status === 'Active' ? 'bg-green-100 text-green-800 border-green-300' :
                                  rancher.active_status === 'At Capacity' ? 'bg-red-100 text-red-800 border-red-300' :
                                  rancher.active_status === 'Paused' ? 'bg-yellow-100 text-yellow-800 border-yellow-300' :
                                  'bg-gray-100 text-gray-600 border-gray-300'
                                }`}>
                                  {rancher.active_status}
                                </span>
                              )}
                            </div>
                            <p className="text-sm text-[#6B4F3F]">Operator: {rancher.operator_name}</p>
                            <p className="text-sm">{rancher.email} &middot; {rancher.phone}</p>
                            <p className="text-sm">State: {rancher.state}</p>
                            <p className="text-sm">Beef Types: {rancher.beef_types}</p>
                            {rancher.current_active_referrals !== undefined && rancher.current_active_referrals > 0 && (
                              <p className="text-sm">Referrals: {rancher.current_active_referrals}/{rancher.max_active_referrals || 5}</p>
                            )}
                            {rancher.docs_sent_at && (
                              <p className="text-xs mt-1 text-orange-700">
                                Docs sent {Math.floor((Date.now() - new Date(rancher.docs_sent_at).getTime()) / 86400000)} days ago
                              </p>
                            )}
                            {rancher.ranch_tour_interested && (
                              <p className="text-xs mt-1 text-[#8C2F2F]">
                                Interested in ranch tour
                                {rancher.ranch_tour_availability && `: ${rancher.ranch_tour_availability}`}
                              </p>
                            )}
                          </div>
                          <div className="flex flex-col gap-2">
                            <select
                              value={rancher.status}
                              onChange={(e) => updateRancherStatus(rancher.id, e.target.value, rancher.certified)}
                              className="px-3 py-1 border border-[#A7A29A] bg-[#F4F1EC] text-sm"
                            >
                              <option value="pending">Pending</option>
                              <option value="approved">Approved</option>
                              <option value="rejected">Rejected</option>
                            </select>
                            <button
                              onClick={() => updateRancherStatus(rancher.id, rancher.status, !rancher.certified)}
                              className={`px-3 py-1 text-sm border ${
                                rancher.certified
                                  ? 'bg-[#0E0E0E] text-[#F4F1EC] border-[#0E0E0E]'
                                  : 'bg-transparent text-[#0E0E0E] border-[#A7A29A]'
                              }`}
                            >
                              {rancher.certified ? 'CERTIFIED' : 'Not Certified'}
                            </button>
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-[#A7A29A]/30">
                          <p className="text-xs text-[#6B4F3F]">
                            Applied: {new Date(rancher.created_at).toLocaleDateString()}
                          </p>
                          {(!rancher.onboarding_status || rancher.onboarding_status === 'Call Scheduled' || rancher.onboarding_status === 'Call Complete') && (
                            <button
                              onClick={() => {
                                setOnboardingModal(rancher);
                                setOnboardingForm({ callSummary: '', confirmedCapacity: 10, specialNotes: '', includeVerification: true });
                              }}
                              className="px-3 py-1 text-xs bg-[#0E0E0E] text-[#F4F1EC] hover:bg-[#2A2A2A]"
                            >
                              Send Onboarding Docs
                            </button>
                          )}
                          {rancher.onboarding_status === 'Docs Sent' && (
                            <button
                              onClick={() => updateOnboardingStatus(rancher.id, 'Agreement Signed')}
                              className="px-3 py-1 text-xs border border-blue-600 text-blue-700 hover:bg-blue-50"
                            >
                              Mark Agreement Signed
                            </button>
                          )}
                          {rancher.onboarding_status === 'Agreement Signed' && (
                            <button
                              onClick={() => updateOnboardingStatus(rancher.id, 'Verification Complete')}
                              className="px-3 py-1 text-xs border border-indigo-600 text-indigo-700 hover:bg-indigo-50"
                            >
                              Mark Verification Complete
                            </button>
                          )}
                          {rancher.onboarding_status === 'Verification Complete' && (
                            <>
                              <button
                                onClick={() => updateOnboardingStatus(rancher.id, 'Live')}
                                className="px-3 py-1 text-xs bg-green-700 text-white hover:bg-green-800"
                              >
                                Mark Live
                              </button>
                              <button
                                onClick={() => { setReleaseModal(rancher); setReleaseAnnounce(true); }}
                                className="px-3 py-1 text-xs bg-amber-600 text-white hover:bg-amber-700"
                              >
                                Release + Announce
                              </button>
                            </>
                          )}
                          {rancher.onboarding_status === 'Live' && !rancher.featured && (
                            <button
                              onClick={async () => {
                                await fetch(`/api/admin/ranchers/${rancher.id}`, {
                                  method: 'PATCH',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ featured: true }),
                                });
                                fetchAllData();
                              }}
                              className="px-3 py-1 text-xs border border-amber-600 text-amber-700 hover:bg-amber-50"
                            >
                              Feature
                            </button>
                          )}
                          {rancher.featured && (
                            <button
                              onClick={async () => {
                                await fetch(`/api/admin/ranchers/${rancher.id}`, {
                                  method: 'PATCH',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ featured: false }),
                                });
                                fetchAllData();
                              }}
                              className="px-3 py-1 text-xs border border-gray-400 text-gray-600 hover:bg-gray-100"
                            >
                              Unfeature
                            </button>
                          )}
                        </div>
                      </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* BRANDS TAB */}
            {activeTab === 'brands' && (
              <div className="space-y-4">
                <h2 className="font-[family-name:var(--font-serif)] text-2xl">Brand Partnerships</h2>
                {brands.length === 0 ? (
                  <p className="text-[#6B4F3F]">No brand applications yet.</p>
                ) : (
                  <div className="space-y-4">
                    {brands.map((brand) => (
                      <div key={brand.id} className="p-4 border border-[#A7A29A] space-y-3">
                        <div className="flex flex-wrap items-start justify-between gap-4">
                          <div>
                            <h3 className="font-medium text-lg">{brand.brand_name}</h3>
                            <p className="text-sm text-[#6B4F3F]">Contact: {brand.contact_name}</p>
                            <p className="text-sm">{brand.email}</p>
                            <p className="text-sm">Product: {brand.product_type}</p>
                            <p className="text-sm">Discount: {brand.discount_offered}%</p>
                          </div>
                          <div className="flex gap-2 flex-wrap">
                            <select
                              value={brand.status}
                              onChange={(e) => updateBrandStatus(brand.id, e.target.value, brand.active)}
                              className="px-3 py-1 border border-[#A7A29A] bg-[#F4F1EC] text-sm"
                            >
                              <option value="pending">Pending</option>
                              <option value="approved">Approved</option>
                              <option value="rejected">Rejected</option>
                            </select>
                            <button
                              onClick={() => updateBrandStatus(brand.id, brand.status, !brand.active)}
                              className={`px-3 py-1 text-sm border ${
                                brand.active
                                  ? 'bg-[#0E0E0E] text-[#F4F1EC] border-[#0E0E0E]'
                                  : 'bg-transparent text-[#0E0E0E] border-[#A7A29A]'
                              }`}
                            >
                              {brand.active ? 'ACTIVE' : 'Inactive'}
                            </button>
                          </div>
                        </div>
                        <p className="text-xs text-[#6B4F3F]">
                          Applied: {new Date(brand.created_at).toLocaleDateString()}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* LAND DEALS TAB */}
            {activeTab === 'landDeals' && (
              <div className="space-y-4">
                <h2 className="font-[family-name:var(--font-serif)] text-2xl">Land Deal Submissions</h2>
                {landDeals.length === 0 ? (
                  <p className="text-[#6B4F3F]">No land deals submitted yet.</p>
                ) : (
                  <div className="space-y-4">
                    {landDeals.map((deal) => (
                      <div key={deal.id} className="p-4 border border-[#A7A29A] space-y-3">
                        <div className="flex flex-wrap items-start justify-between gap-4">
                          <div>
                            <h3 className="font-medium text-lg">
                              {deal.acreage} Acres — {deal.property_location}, {deal.state}
                            </h3>
                            <p className="text-sm text-[#6B4F3F]">Seller: {deal.seller_name}</p>
                            <p className="text-sm font-medium">{deal.asking_price}</p>
                          </div>
                          <div className="flex gap-2 flex-wrap">
                            <select
                              value={deal.status}
                              onChange={(e) => updateLandDealStatus(deal.id, e.target.value, deal.visible_to_members)}
                              className="px-3 py-1 border border-[#A7A29A] bg-[#F4F1EC] text-sm"
                            >
                              <option value="pending">Pending</option>
                              <option value="approved">Approved</option>
                              <option value="rejected">Rejected</option>
                            </select>
                            <button
                              onClick={() => updateLandDealStatus(deal.id, deal.status, !deal.visible_to_members)}
                              className={`px-3 py-1 text-sm border ${
                                deal.visible_to_members
                                  ? 'bg-[#0E0E0E] text-[#F4F1EC] border-[#0E0E0E]'
                                  : 'bg-transparent text-[#0E0E0E] border-[#A7A29A]'
                              }`}
                            >
                              {deal.visible_to_members ? 'VISIBLE' : 'Hidden'}
                            </button>
                          </div>
                        </div>
                        <p className="text-xs text-[#6B4F3F]">
                          Submitted: {new Date(deal.created_at).toLocaleDateString()}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </Container>

      {/* Admin Notes Modal */}
      {notesModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white max-w-lg w-full p-6 space-y-4">
            <h3 className="font-[family-name:var(--font-serif)] text-xl">
              Admin Notes — {notesModal.first_name}
            </h3>
            <p className="text-sm text-[#6B4F3F]">
              {notesModal.email} · {notesModal.phone || 'No phone'}
            </p>
            <textarea
              value={notesText}
              onChange={(e) => setNotesText(e.target.value)}
              placeholder="Call outcome, next steps, verification notes..."
              rows={6}
              className="w-full px-4 py-3 border border-[#A7A29A] bg-[#F4F1EC] text-sm"
            />
            <div className="flex gap-2">
              <button
                onClick={() => saveAdminNotes(notesModal.id, notesText)}
                disabled={savingNotes}
                className="flex-1 px-4 py-3 bg-[#0E0E0E] text-[#F4F1EC] text-sm font-medium hover:bg-[#2A2A2A] disabled:opacity-50"
              >
                {savingNotes ? 'Saving...' : 'Save Notes'}
              </button>
              <button
                onClick={() => setNotesModal(null)}
                className="flex-1 px-4 py-3 border border-[#A7A29A] text-sm hover:bg-[#A7A29A]"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Onboarding Docs Modal */}
      {onboardingModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white max-w-lg w-full p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <h3 className="font-[family-name:var(--font-serif)] text-xl">
              Send Onboarding Package
            </h3>
            <p className="text-sm text-[#6B4F3F]">
              Sending to <strong>{onboardingModal.operator_name || onboardingModal.ranch_name}</strong> ({onboardingModal.email})
            </p>

            <div className="space-y-4">
              <div className="space-y-2">
                <label className="block text-sm font-medium">Call Summary</label>
                <textarea
                  value={onboardingForm.callSummary}
                  onChange={(e) => setOnboardingForm(p => ({ ...p, callSummary: e.target.value }))}
                  placeholder="Summarize what you discussed on the call..."
                  rows={4}
                  className="w-full px-4 py-3 border border-[#A7A29A] bg-[#F4F1EC] text-sm"
                />
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium">Confirmed Capacity (orders/month)</label>
                <input
                  type="number"
                  value={onboardingForm.confirmedCapacity}
                  onChange={(e) => setOnboardingForm(p => ({ ...p, confirmedCapacity: parseInt(e.target.value) || 0 }))}
                  className="w-full px-4 py-3 border border-[#A7A29A] bg-[#F4F1EC] text-sm"
                />
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium">Special Notes (goals, alignment)</label>
                <textarea
                  value={onboardingForm.specialNotes}
                  onChange={(e) => setOnboardingForm(p => ({ ...p, specialNotes: e.target.value }))}
                  placeholder="What makes them a great fit..."
                  rows={3}
                  className="w-full px-4 py-3 border border-[#A7A29A] bg-[#F4F1EC] text-sm"
                />
              </div>

              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={onboardingForm.includeVerification}
                  onChange={(e) => setOnboardingForm(p => ({ ...p, includeVerification: e.target.checked }))}
                  className="w-4 h-4"
                />
                <span className="text-sm">Include beef verification requirement</span>
              </label>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                onClick={() => handleSendOnboarding(onboardingModal.id)}
                disabled={sendingDocs}
                className="flex-1 px-4 py-3 bg-[#0E0E0E] text-[#F4F1EC] text-sm font-medium hover:bg-[#2A2A2A] disabled:opacity-50"
              >
                {sendingDocs ? 'Sending...' : 'Send Package'}
              </button>
              <button
                onClick={() => setOnboardingModal(null)}
                className="flex-1 px-4 py-3 border border-[#A7A29A] text-sm hover:bg-[#A7A29A]"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Release + Announce Modal */}
      {releaseModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white max-w-lg w-full p-6 space-y-4">
            <h3 className="font-[family-name:var(--font-serif)] text-xl">
              Release Rancher
            </h3>
            <p className="text-sm text-[#6B4F3F]">
              This will mark <strong>{releaseModal.operator_name || releaseModal.ranch_name}</strong> as Live, Featured, and set their release date to today.
            </p>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={releaseAnnounce}
                onChange={(e) => setReleaseAnnounce(e.target.checked)}
                className="w-4 h-4"
              />
              <span className="text-sm">Draft a broadcast email announcing this rancher</span>
            </label>
            <div className="flex gap-2 pt-2">
              <button
                onClick={() => handleRelease(releaseModal)}
                className="flex-1 px-4 py-3 bg-amber-600 text-white text-sm font-medium hover:bg-amber-700"
              >
                {releaseAnnounce ? 'Release & Draft Email' : 'Release Now'}
              </button>
              <button
                onClick={() => setReleaseModal(null)}
                className="flex-1 px-4 py-3 border border-[#A7A29A] text-sm hover:bg-[#A7A29A]"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
    </AdminAuthGuard>
  );
}

