'use client';

import { useState, useEffect } from 'react';
import Container from '../components/Container';
import Divider from '../components/Divider';
import Button from '../components/Button';
import AdminAuthGuard from '../components/AdminAuthGuard';
import CommandCenter from './components/CommandCenter';

type Tab = 'consumers' | 'ranchers' | 'brands' | 'landDeals';

interface ReferralStats {
  totalBuyers: number;
  totalRanchers: number;
  totalReferrals: number;
  pendingApproval: number;
  stalledLeads: number;
  closedDealsThisMonth: { count: number; totalCommission: number };
  // All-time unpaid commission across every Closed Won referral.
  commissionUnpaid?: number;
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
  referred_by: string;
  admin_notes: string;
  last_contacted: string;
  campaign: string;
  created_at: string;
  sequence_stage: string;
  ai_recommended_action: string;
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
  referred_by?: string;
  slug?: string;
  page_live?: boolean;
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
  payment_status: string;
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
  const [rancherViewFilter, setRancherViewFilter] = useState<string>('');
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

  // New state for redesign
  const [searchQuery, setSearchQuery] = useState('');
  const [pipelineFilter, setPipelineFilter] = useState('');
  const [expandedRancher, setExpandedRancher] = useState<string | null>(null);
  const [expandedConsumer, setExpandedConsumer] = useState<string | null>(null);
  const [toast, setToast] = useState<{message: string; type: 'success' | 'error' | 'warning'} | null>(null);
  const [confirmAction, setConfirmAction] = useState<{message: string; onConfirm: () => void} | null>(null);

  // Auto-dismiss toast after 3 seconds
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(t);
    }
  }, [toast]);

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
      const res = await fetch(`/api/admin/consumers/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, membership }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setToast({ message: data.error || 'Failed to update buyer status', type: 'error' });
        return;
      }
      fetchAllData();
    } catch (error) {
      console.error('Error updating consumer:', error);
      setToast({ message: 'Network error updating buyer', type: 'error' });
    }
  };

  const saveAdminNotes = async (id: string, notes: string) => {
    setSavingNotes(true);
    try {
      const res = await fetch(`/api/admin/consumers/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_notes: notes }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setToast({ message: data.error || 'Failed to save notes', type: 'error' });
      } else {
        setNotesModal(null);
        setToast({ message: 'Notes saved', type: 'success' });
        fetchAllData();
      }
    } catch {
      setToast({ message: 'Failed to save notes', type: 'error' });
    }
    setSavingNotes(false);
  };

  const logCall = async (consumer: Consumer) => {
    const now = new Date().toISOString();
    try {
      const res = await fetch(`/api/admin/consumers/${consumer.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ last_contacted: now }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setToast({ message: data.error || 'Failed to log call', type: 'error' });
        return;
      }
      setToast({ message: 'Call logged', type: 'success' });
      fetchAllData();
    } catch {
      setToast({ message: 'Failed to log call', type: 'error' });
    }
  };

  const updateRancherStatus = async (id: string, status: string, certified: boolean, callScheduled?: boolean) => {
    try {
      const body: any = { status, certified };
      if (callScheduled !== undefined) {
        body.call_scheduled = callScheduled;
      }
      const res = await fetch(`/api/admin/ranchers/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setToast({ message: data.error || 'Failed to update rancher', type: 'error' });
        return;
      }
      fetchAllData();
    } catch (error) {
      console.error('Error updating rancher:', error);
      setToast({ message: 'Network error updating rancher', type: 'error' });
    }
  };

  const updateBrandStatus = async (id: string, status: string, active: boolean) => {
    try {
      const res = await fetch(`/api/admin/brands/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, active }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setToast({ message: data.error || 'Failed to update brand', type: 'error' });
        return;
      }
      fetchAllData();
    } catch (error) {
      console.error('Error updating brand:', error);
      setToast({ message: 'Network error updating brand', type: 'error' });
    }
  };

  const updateLandDealStatus = async (id: string, status: string, visible: boolean) => {
    try {
      const res = await fetch(`/api/admin/landDeals/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, visible_to_members: visible }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setToast({ message: data.error || 'Failed to update land deal', type: 'error' });
        return;
      }
      fetchAllData();
    } catch (error) {
      console.error('Error updating land deal:', error);
      setToast({ message: 'Network error updating land deal', type: 'error' });
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
        setToast({ message: 'Onboarding package sent!', type: 'success' });
        setOnboardingModal(null);
        setOnboardingForm({ callSummary: '', confirmedCapacity: 10, specialNotes: '', includeVerification: true });
        fetchAllData();
      } else {
        setToast({ message: data.error || 'Failed to send onboarding package', type: 'error' });
      }
    } catch {
      setToast({ message: 'Error sending onboarding package', type: 'error' });
    }
    setSendingDocs(false);
  };

  const updateOnboardingStatus = async (rancherId: string, newStatus: string) => {
    try {
      const body: Record<string, string | boolean> = { onboarding_status: newStatus };
      if (newStatus === 'Live') {
        body.active_status = 'Active';
        // Go-Live must ALSO publish the public page — otherwise the rancher is
        // routable + warmup-blasted while their /ranchers/[slug] page stays
        // hidden (the PATCH route only sets Page Live when page_live is passed).
        body.page_live = true;
      }
      const res = await fetch(`/api/admin/ranchers/${rancherId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setToast({ message: data.error || 'Error updating onboarding status', type: 'error' });
        return;
      }
      setToast({ message: `Status updated to ${newStatus}`, type: 'success' });
      fetchAllData();
    } catch {
      setToast({ message: 'Error updating onboarding status', type: 'error' });
    }
  };

  const handleRelease = async (rancher: Rancher) => {
    try {
      const res = await fetch(`/api/admin/ranchers/${rancher.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          onboarding_status: 'Live',
          active_status: 'Active',
          featured: true,
          release_date: new Date().toISOString(),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setToast({ message: data.error || 'Error releasing rancher', type: 'error' });
        return;
      }
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
        setToast({ message: 'Rancher released!', type: 'success' });
        fetchAllData();
      }
    } catch {
      setToast({ message: 'Error releasing rancher', type: 'error' });
    }
  };

  // Helper: get rancher pipeline stage
  const getRancherPipelineStage = (r: Rancher): string => {
    const s = r.onboarding_status;
    if (!s || s === 'Pending' || s === 'Call Scheduled' || s === 'Call Complete') return 'New';
    if (s === 'Docs Sent') return 'Docs Sent';
    if (s === 'Agreement Signed') return 'Agreement Signed';
    if (s === 'Verification Pending' || s === 'Verification Complete') return 'Verified';
    if (s === 'Live') return 'Live';
    return 'New';
  };

  // Helper: count unsigned agreements >7 days
  const unsignedAgreementsCount = ranchers.filter(r => {
    if (r.onboarding_status !== 'Docs Sent') return false;
    if (!r.docs_sent_at) return false;
    const daysSince = Math.floor((Date.now() - new Date(r.docs_sent_at).getTime()) / (1000 * 60 * 60 * 24));
    return daysSince > 7;
  }).length;

  // Helper: ranchers ready to go live
  const readyToGoLiveCount = ranchers.filter(r =>
    (r.onboarding_status === 'Verification Complete' || (r.agreement_signed && r.verification_status === 'Verified'))
    && r.page_live !== true
    && r.slug
  ).length;

  // Helper: stalled leads count
  const stalledLeadsCount = refStats?.stalledLeads ?? 0;

  // Search filtering
  const searchLower = searchQuery.toLowerCase().trim();
  const filteredConsumersBySearch = searchLower
    ? consumers.filter(c =>
        (c.first_name && c.first_name.toLowerCase().includes(searchLower)) ||
        (c.email && c.email.toLowerCase().includes(searchLower))
      )
    : [];
  const filteredRanchersBySearch = searchLower
    ? ranchers.filter(r =>
        (r.ranch_name && r.ranch_name.toLowerCase().includes(searchLower)) ||
        (r.operator_name && r.operator_name.toLowerCase().includes(searchLower)) ||
        (r.email && r.email.toLowerCase().includes(searchLower))
      )
    : [];

  if (loading) {
    return (
      <AdminAuthGuard>
        <main className="min-h-screen py-24 bg-bone text-charcoal">
          <Container>
            <div className="text-center"><p className="text-lg text-saddle">Loading admin dashboard...</p>
            </div>
          </Container>
        </main>
      </AdminAuthGuard>
    );
  }

  return (
    <AdminAuthGuard>
      <main className="min-h-screen py-12 bg-bone text-charcoal">

      {/* Toast Notification */}
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-6 py-3 shadow-lg text-white text-sm font-medium ${
          toast.type === 'success' ? 'bg-sage' : toast.type === 'error' ? 'bg-weathered' : 'bg-amber-dark'
        }`}>
          {toast.message}
        </div>
      )}

      {/* Confirmation Dialog */}
      {confirmAction && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white p-6 max-w-sm space-y-4">
            <p>{confirmAction.message}</p>
            <div className="flex gap-3">
              <button onClick={() => { confirmAction.onConfirm(); setConfirmAction(null); }} className="px-4 py-2 bg-charcoal text-white text-sm">Confirm</button>
              <button onClick={() => setConfirmAction(null)} className="px-4 py-2 border text-sm">Cancel</button>
            </div>
          </div>
        </div>
      )}

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
                // Clear bhc-admin cookie via /api/admin/auth DELETE.
                await fetch('/api/admin/auth', { method: 'DELETE' });
                window.location.href = '/admin/login';
              }}
              className="px-4 py-2 text-sm border border-weathered text-weathered hover:bg-weathered hover:text-white transition-colors"
            >
              Logout
            </button>
          </div>

          <div className="text-center space-y-4">
            <p className="text-sm text-saddle">Internal CRM — BuyHalfCow</p>
          </div>

          {/* Global Search Bar */}
          <div className="w-full">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search consumers or ranchers by name or email..."
              className="w-full px-5 py-3 border-2 border-dust bg-white text-sm focus:border-charcoal focus:outline-none transition-colors"
            />
          </div>

          {/* Search Results */}
          {searchLower ? (
            <div className="space-y-6">
              <h2 className="font-[family-name:var(--font-serif)] text-xl">
                Search Results for &quot;{searchQuery}&quot;
              </h2>

              {filteredConsumersBySearch.length === 0 && filteredRanchersBySearch.length === 0 && (
                <p className="text-saddle">No results found.</p>
              )}

              {filteredConsumersBySearch.length > 0 && (
                <div className="space-y-3">
                  <h3 className="text-sm font-medium text-saddle uppercase tracking-wide">Consumers ({filteredConsumersBySearch.length})</h3>
                  {filteredConsumersBySearch.map(consumer => (
                    <div key={consumer.id} className="p-4 border border-dust bg-white">
                      <div className="flex items-center justify-between gap-4">
                        <div>
                          <span className="font-medium">{consumer.first_name}</span>
                          <span className="text-sm text-saddle ml-2">{consumer.email}</span>
                          <span className="text-sm text-saddle ml-2">{consumer.state}</span>
                          {consumer.segment && (
                            <span className={`ml-2 px-2 py-0.5 text-xs font-bold border ${
                              consumer.segment === 'Beef Buyer' ? 'bg-weathered/10 text-weathered border-weathered/40' :
                              'bg-saddle/10 text-saddle border-saddle/40'
                            }`}>{consumer.segment}</span>
                          )}
                        </div>
                        <a
                          href={`/admin/consumers/${consumer.id}`}
                          className="px-3 py-1 text-xs border border-charcoal hover:bg-charcoal hover:text-bone"
                        >
                          View Details
                        </a>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {filteredRanchersBySearch.length > 0 && (
                <div className="space-y-3">
                  <h3 className="text-sm font-medium text-saddle uppercase tracking-wide">Ranchers ({filteredRanchersBySearch.length})</h3>
                  {filteredRanchersBySearch.map(rancher => (
                    <div key={rancher.id} className="p-4 border border-dust bg-white">
                      <div className="flex items-center justify-between gap-4">
                        <div>
                          <span className="font-medium">{rancher.ranch_name}</span>
                          <span className="text-sm text-saddle ml-2">{rancher.operator_name}</span>
                          <span className="text-sm text-saddle ml-2">{rancher.email}</span>
                          <span className="text-sm text-saddle ml-2">{rancher.state}</span>
                          {rancher.onboarding_status && (
                            <span className={`ml-2 px-2 py-0.5 text-xs border ${
                              rancher.onboarding_status === 'Live' ? 'bg-sage/15 text-sage-dark border-sage/40' :
                              'bg-bone-deep text-saddle border-dust'
                            }`}>{rancher.onboarding_status}</span>
                          )}
                        </div>
                        <a
                          href={`/admin/ranchers/${rancher.id}`}
                          className="px-3 py-1 text-xs border border-saddle text-saddle hover:bg-saddle hover:text-white"
                        >
                          Edit Page
                        </a>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <>
              {/* Command Center — lifeblood overview (money / funnel / channel /
                  touchpoints / where-to-unlock). Composes existing admin
                  endpoints; sits on top of the detail views below, which stay
                  fully reachable. */}
              <CommandCenter />

              <Divider />

              {/* Stats Overview */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="p-4 border border-dust text-center">
                  <div className="font-[family-name:var(--font-serif)] text-3xl">{consumers.length}</div>
                  <div className="text-sm text-saddle">Consumers</div>
                </div>
                <div className="p-4 border border-dust text-center">
                  <div className="font-[family-name:var(--font-serif)] text-3xl">{ranchers.length}</div>
                  <div className="text-sm text-saddle">Ranchers</div>
                </div>
                <div className="p-4 border border-dust text-center">
                  <div className="font-[family-name:var(--font-serif)] text-3xl">{brands.length}</div>
                  <div className="text-sm text-saddle">Brands</div>
                </div>
                <div className="p-4 border border-dust text-center">
                  <div className="font-[family-name:var(--font-serif)] text-3xl">{landDeals.length}</div>
                  <div className="text-sm text-saddle">Land Deals</div>
                </div>
              </div>

              {/* What Needs Your Attention */}
              <div className="p-6 border-2 border-amber/60 bg-amber/10 space-y-4">
                <h2 className="text-lg font-bold">What Needs Your Attention</h2>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                  <a href="/admin/referrals" className="p-3 border border-amber/60 bg-white text-center hover:bg-amber/20 transition-colors block">
                    <div className="font-[family-name:var(--font-serif)] text-2xl font-bold">{refStats?.pendingApproval || 0}</div>
                    <div className="text-xs text-saddle mt-1">Pending Referrals</div>
                    <span className="text-xs text-amber-dark underline mt-1 inline-block">Review</span>
                  </a>
                  <button
                    onClick={() => { setActiveTab('ranchers'); setRancherViewFilter('ready'); setPipelineFilter(''); }}
                    className="p-3 border border-amber/60 bg-white text-center hover:bg-amber/20 transition-colors"
                  >
                    <div className="font-[family-name:var(--font-serif)] text-2xl font-bold">{readyToGoLiveCount}</div>
                    <div className="text-xs text-saddle mt-1">Ready to Go Live</div>
                    <span className="text-xs text-amber-dark underline mt-1 inline-block">View</span>
                  </button>
                  <button
                    onClick={() => { setActiveTab('ranchers'); setPipelineFilter('Docs Sent'); setRancherViewFilter(''); }}
                    className="p-3 border border-amber/60 bg-white text-center hover:bg-amber/20 transition-colors"
                  >
                    <div className="font-[family-name:var(--font-serif)] text-2xl font-bold">{unsignedAgreementsCount}</div>
                    <div className="text-xs text-saddle mt-1">Unsigned Agreements</div>
                    <span className="text-xs text-dust mt-0.5 inline-block">&gt;7 days old</span>
                  </button>
                  <a href="/admin/commissions" className="p-3 border border-amber/60 bg-white text-center hover:bg-amber/20 transition-colors block">
                    <div className="font-[family-name:var(--font-serif)] text-2xl font-bold">${(refStats?.commissionUnpaid ?? 0).toLocaleString()}</div>
                    <div className="text-xs text-saddle mt-1">Unpaid Commission</div>
                    <span className="text-xs text-dust mt-0.5 inline-block">all-time</span>
                  </a>
                  <div className="p-3 border border-amber/60 bg-white text-center">
                    <div className="font-[family-name:var(--font-serif)] text-2xl font-bold">{stalledLeadsCount}</div>
                    <div className="text-xs text-saddle mt-1">Stalled Leads</div>
                    <span className="text-xs text-dust mt-0.5 inline-block">No action needed</span>
                  </div>
                </div>
              </div>

              {/* Action Links */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <Button href="/admin/referrals" variant="secondary">
                  Referral Queue
                </Button>
                <Button href="/admin/heatmap" variant="secondary">
                  State Heatmap
                </Button>
                <Button href="/admin/commissions" variant="secondary">
                  Commissions
                </Button>
                <Button href="/admin/affiliates" variant="secondary">
                  Affiliates
                </Button>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <Button href="/admin/broadcast" variant="secondary">
                  Broadcast Email
                </Button>
                <Button href="/admin/analytics" variant="secondary">
                  Analytics
                </Button>
                <Button href="/admin/compliance" variant="secondary">
                  Compliance
                </Button>
                <Button href="/admin/inquiries" variant="secondary">
                  Inquiries
                </Button>
                <Button href="/admin/backfill" variant="secondary">
                  Backfill Campaign
                </Button>
              </div>

              {/* Quick Actions (replaces AI & Automation) */}
              <div className="border border-dust bg-white p-6 space-y-4">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <h2 className="font-[family-name:var(--font-serif)] text-xl">Quick Actions</h2>
                  <div className="flex gap-2 flex-wrap">
                    <button
                      onClick={async () => {
                        setConfirmAction({
                          message: 'Run batch-approve now? This will process all pending consumers.',
                          onConfirm: async () => {
                            try {
                              const res = await fetch('/api/cron/batch-approve', { method: 'POST' });
                              const data = await res.json();
                              setToast({ message: res.ok ? `Batch approve complete: ${data.approved || 0} approved` : `Error: ${data.error}`, type: res.ok ? 'success' : 'error' });
                            } catch (e: any) {
                              setToast({ message: `Failed: ${e.message}`, type: 'error' });
                            }
                          }
                        });
                      }}
                      className="px-3 py-1.5 text-xs border border-saddle text-saddle hover:bg-saddle hover:text-white transition-colors"
                    >
                      Run Batch Approve
                    </button>
                    <button
                      onClick={() => {
                        const pw = prompt('Enter admin password:');
                        if (pw) window.open(`/api/admin/setup-ai-fields?password=${encodeURIComponent(pw)}`, '_blank');
                      }}
                      className="px-3 py-1.5 text-xs border border-dust hover:bg-dust hover:text-white transition-colors"
                    >
                      Run AI Field Setup
                    </button>
                  </div>
                </div>
                <p className="text-sm text-saddle">
                  Most automations run via Telegram bot (/qualify, /brief, /chasup, /draft). Email sequences and batch approval run on daily cron schedules.
                </p>
              </div>

              {/* Tab Navigation */}
              <div className="flex flex-wrap gap-2 border-b border-dust">
                <button
                  onClick={() => setActiveTab('consumers')}
                  className={`px-6 py-3 font-medium transition-colors ${
                    activeTab === 'consumers'
                      ? 'bg-charcoal text-bone'
                      : 'text-charcoal hover:bg-dust'
                  }`}
                >
                  Consumers
                </button>
                <button
                  onClick={() => setActiveTab('ranchers')}
                  className={`px-6 py-3 font-medium transition-colors ${
                    activeTab === 'ranchers'
                      ? 'bg-charcoal text-bone'
                      : 'text-charcoal hover:bg-dust'
                  }`}
                >
                  Ranchers
                </button>
                <button
                  onClick={() => setActiveTab('brands')}
                  className={`px-6 py-3 font-medium transition-colors ${
                    activeTab === 'brands'
                      ? 'bg-charcoal text-bone'
                      : 'text-charcoal hover:bg-dust'
                  }`}
                >
                  Brands
                </button>
                <button
                  onClick={() => setActiveTab('landDeals')}
                  className={`px-6 py-3 font-medium transition-colors ${
                    activeTab === 'landDeals'
                      ? 'bg-charcoal text-bone'
                      : 'text-charcoal hover:bg-dust'
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
                          className="px-4 py-2 border-2 border-charcoal bg-bone text-sm font-medium"
                        >
                          <option value="">All Segments</option>
                          <option value="Beef Buyer">Beef Buyers</option>
                          <option value="Community">Community</option>
                        </select>
                        <select
                          value={intentFilter}
                          onChange={(e) => setIntentFilter(e.target.value)}
                          className="px-4 py-2 border-2 border-charcoal bg-bone text-sm font-medium"
                        >
                          <option value="">All Intent</option>
                          <option value="High">High Intent</option>
                          <option value="Medium">Medium Intent</option>
                          <option value="Low">Low Intent</option>
                        </select>
                        <select
                          value={consumerStateFilter}
                          onChange={(e) => setConsumerStateFilter(e.target.value)}
                          className="px-4 py-2 border-2 border-charcoal bg-bone text-sm font-medium"
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
                              const filtered = consumers.filter(c => c.state === consumerStateFilter && c.status === 'Pending');
                              if (filtered.length === 0) {
                                setToast({ message: 'No pending consumers in this state', type: 'warning' });
                                return;
                              }
                              setConfirmAction({
                                message: `Approve ${filtered.length} pending consumer(s) in ${consumerStateFilter}?`,
                                onConfirm: async () => {
                                  for (const consumer of filtered) {
                                    await updateConsumerStatus(consumer.id, 'Approved', consumer.membership);
                                  }
                                  setToast({ message: `${filtered.length} consumer(s) approved`, type: 'success' });
                                  fetchAllData();
                                }
                              });
                            }}
                            className="px-4 py-2 bg-charcoal text-bone hover:bg-divider text-sm font-medium whitespace-nowrap"
                          >
                            Approve All Pending
                          </button>
                        )}
                      </div>
                    </div>

                    {consumers.length === 0 ? (
                      <p className="text-saddle">No consumers yet.</p>
                    ) : (
                      <>
                        <div className="space-y-3">
                          {consumers
                            .filter(c => !consumerStateFilter || c.state === consumerStateFilter)
                            .filter(c => !intentFilter || c.intent_classification === intentFilter)
                            .filter(c => !segmentFilter || c.segment === segmentFilter)
                            .sort((a, b) => b.intent_score - a.intent_score)
                            .map((consumer) => {
                              const daysSinceSignup = Math.floor((Date.now() - new Date(consumer.created_at).getTime()) / (1000*60*60*24));
                              const isExpanded = expandedConsumer === consumer.id;

                              return (
                                <div key={consumer.id} className="border border-dust bg-white">
                                  {/* Collapsed View */}
                                  <div className="p-4 flex flex-wrap items-center justify-between gap-3">
                                    <div className="flex items-center gap-3 flex-wrap flex-1 min-w-[200px]">
                                      <h3 className="font-medium">{consumer.first_name}</h3>
                                      {consumer.state && <span className="text-sm text-saddle">{consumer.state}</span>}
                                      {consumer.segment && (
                                        <span className={`px-2 py-0.5 text-xs font-bold border ${
                                          consumer.segment === 'Beef Buyer' ? 'bg-weathered/10 text-weathered border-weathered/40' :
                                          'bg-saddle/10 text-saddle border-saddle/40'
                                        }`}>
                                          {consumer.segment}
                                        </span>
                                      )}
                                      {consumer.intent_classification && (
                                        <span className={`px-2 py-0.5 text-xs font-medium border ${
                                          consumer.intent_classification === 'High' ? 'bg-sage/15 text-sage-dark border-sage/40' :
                                          consumer.intent_classification === 'Medium' ? 'bg-amber/15 text-amber-dark border-amber/60' :
                                          'bg-bone-deep text-saddle border-dust'
                                        }`}>
                                          {consumer.intent_classification} ({consumer.intent_score})
                                          <span className="text-xs text-dust ml-1">Higher = more likely to buy</span>
                                        </span>
                                      )}
                                      {consumer.referral_status && consumer.referral_status !== 'Unmatched' && consumer.referral_status !== 'Community' && (
                                        <span className="px-2 py-0.5 text-xs bg-dust/25 text-saddle border border-dust">
                                          {consumer.referral_status}
                                          <span className="text-xs text-dust ml-1">Referral match status</span>
                                        </span>
                                      )}
                                      <span className="text-xs text-dust">{daysSinceSignup}d ago</span>
                                    </div>

                                    <div className="flex items-center gap-2">
                                      <select
                                        value={consumer.status}
                                        onChange={(e) => updateConsumerStatus(consumer.id, e.target.value, consumer.membership)}
                                        className="px-3 py-1 border border-dust bg-bone text-sm"
                                      >
                                        <option value="Pending">Pending</option>
                                        <option value="Approved">Approved</option>
                                        <option value="Rejected">Rejected</option>
                                      </select>
                                      <button
                                        onClick={() => setExpandedConsumer(isExpanded ? null : consumer.id)}
                                        className="px-3 py-1 text-xs border border-dust hover:bg-dust hover:text-white"
                                      >
                                        {isExpanded ? 'Hide Details' : 'Show Details'}
                                      </button>
                                    </div>
                                  </div>

                                  {/* Expanded View */}
                                  {isExpanded && (
                                    <div className="px-4 pb-4 border-t border-dust/30 pt-3 space-y-2">
                                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                                        <div>
                                          <p><span className="text-saddle">Email:</span> {consumer.email}</p>
                                          {consumer.phone && (
                                            <p><span className="text-saddle">Phone:</span> <a href={`tel:${consumer.phone}`} className="underline hover:text-charcoal">{consumer.phone}</a></p>
                                          )}
                                          {consumer.order_type && <p><span className="text-saddle">Order:</span> {consumer.order_type} / Budget: {consumer.budget_range || 'N/A'}</p>}
                                          {consumer.campaign && <p><span className="text-saddle">Source:</span> {consumer.campaign}</p>}
                                          {consumer.referred_by && <p className="text-saddle">Referred by: {consumer.referred_by}</p>}
                                        </div>
                                        <div>
                                          {consumer.notes && <p className="text-saddle italic">&quot;{consumer.notes}&quot;</p>}
                                          {consumer.sequence_stage && <p className="text-saddle">Sequence: {consumer.sequence_stage}</p>}
                                          {/* AI Recommended Action hidden — no writer yet (audit 2026-06-22); re-add when the AI qualifier writes it */}
                                          {consumer.admin_notes && (
                                            <p className="px-2 py-1 bg-amber/10 border-l-2 border-amber/60 text-amber-dark text-xs">
                                              Notes: {consumer.admin_notes}
                                            </p>
                                          )}
                                          {consumer.last_contacted && (
                                            <p className="text-sage-dark text-xs">
                                              Last contacted: {new Date(consumer.last_contacted).toLocaleDateString()}
                                            </p>
                                          )}
                                        </div>
                                      </div>

                                      <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-dust/30">
                                        {/* Membership hidden — empty until consumer subscriptions exist (audit 2026-06-22) */}
                                        <button
                                          onClick={() => { setNotesModal(consumer); setNotesText(consumer.admin_notes || ''); }}
                                          className="px-3 py-1 text-xs border border-dust hover:bg-dust hover:text-white"
                                        >
                                          {consumer.admin_notes ? 'Edit Notes' : 'Add Notes'}
                                        </button>
                                        {consumer.phone && (
                                          <button
                                            onClick={() => { logCall(consumer); window.open(`tel:${consumer.phone}`); }}
                                            className="px-3 py-1 text-xs bg-sage-dark text-white hover:bg-sage-dark"
                                          >
                                            Log Call
                                          </button>
                                        )}
                                        <a
                                          href={`/admin/consumers/${consumer.id}`}
                                          className="px-3 py-1 text-xs border border-charcoal hover:bg-charcoal hover:text-bone"
                                        >
                                          View Details
                                        </a>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
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

                      <div className="flex items-center gap-3 flex-wrap">
                        <a
                          href="/map/add-a-rancher"
                          target="_blank"
                          className="px-4 py-2 border-2 border-charcoal bg-charcoal text-bone text-sm font-medium hover:bg-divider"
                          title="Opens the self-submit form. Use for ranchers you want to onboard yourself — fill in their info, they get a setup link emailed."
                        >
                          + Add Rancher
                        </a>
                        <select
                          value={rancherViewFilter}
                          onChange={(e) => { setRancherViewFilter(e.target.value); setPipelineFilter(''); }}
                          className="px-4 py-2 border-2 border-charcoal bg-bone text-sm font-medium"
                        >
                          <option value="">All Ranchers</option>
                          <option value="ready">
                            Ready to go live ({ranchers.filter(r => r.agreement_signed && r.onboarding_status === 'Verification Complete').length})
                          </option>
                          <option value="broken">
                            Live but not receiving ({ranchers.filter(r => r.onboarding_status === 'Live' && r.active_status !== 'Active').length})
                          </option>
                        </select>
                        <select
                          value={rancherStateFilter}
                          onChange={(e) => setRancherStateFilter(e.target.value)}
                          className="px-4 py-2 border-2 border-charcoal bg-bone text-sm font-medium"
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
                                const filtered = ranchers.filter(r => r.state === rancherStateFilter && r.status === 'Pending');
                                if (filtered.length === 0) {
                                  setToast({ message: 'No pending ranchers in this state', type: 'warning' });
                                  return;
                                }
                                setConfirmAction({
                                  message: `Approve ${filtered.length} pending rancher(s) in ${rancherStateFilter}?`,
                                  onConfirm: async () => {
                                    for (const rancher of filtered) {
                                      await updateRancherStatus(rancher.id, 'Approved', rancher.certified);
                                    }
                                    setToast({ message: `${filtered.length} rancher(s) approved`, type: 'success' });
                                    fetchAllData();
                                  }
                                });
                              }}
                              className="px-4 py-2 bg-charcoal text-bone hover:bg-divider text-sm font-medium whitespace-nowrap"
                            >
                              Approve All Pending
                            </button>
                            <button
                              onClick={async () => {
                                const filtered = ranchers.filter(r => r.state === rancherStateFilter && r.status === 'Approved' && !r.certified);
                                if (filtered.length === 0) {
                                  setToast({ message: 'No uncertified approved ranchers in this state', type: 'warning' });
                                  return;
                                }
                                setConfirmAction({
                                  message: `Certify ${filtered.length} rancher(s) in ${rancherStateFilter}?`,
                                  onConfirm: async () => {
                                    for (const rancher of filtered) {
                                      await updateRancherStatus(rancher.id, 'Approved', true);
                                    }
                                    setToast({ message: `${filtered.length} rancher(s) certified`, type: 'success' });
                                    fetchAllData();
                                  }
                                });
                              }}
                              className="px-4 py-2 bg-transparent text-charcoal border-2 border-charcoal hover:bg-charcoal hover:text-bone text-sm font-medium whitespace-nowrap"
                            >
                              Certify All Approved
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Pipeline View */}
                    <div className="flex gap-1 overflow-x-auto pb-2">
                      <button
                        onClick={() => { setPipelineFilter(''); setRancherViewFilter(''); }}
                        className={`px-3 py-1.5 text-xs font-medium whitespace-nowrap border transition-colors ${
                          !pipelineFilter ? 'bg-charcoal text-bone border-charcoal' : 'border-dust hover:bg-dust'
                        }`}
                      >
                        All ({ranchers.length})
                      </button>
                      {['New', 'Docs Sent', 'Agreement Signed', 'Verified', 'Live'].map(stage => {
                        const count = ranchers.filter(r => getRancherPipelineStage(r) === stage).length;
                        const stageHint = stage === 'New' ? 'Pending / just applied' :
                          stage === 'Docs Sent' ? 'Agreement emailed, awaiting signature' :
                          stage === 'Agreement Signed' ? 'Signed, needs verification' :
                          stage === 'Verified' ? 'Ready to go live' :
                          'Active on platform';
                        return (
                          <button
                            key={stage}
                            onClick={() => { setPipelineFilter(stage); setRancherViewFilter(''); }}
                            title={stageHint}
                            className={`px-3 py-1.5 text-xs font-medium whitespace-nowrap border transition-colors ${
                              pipelineFilter === stage ? 'bg-charcoal text-bone border-charcoal' : 'border-dust hover:bg-dust'
                            }`}
                          >
                            {stage} ({count})
                          </button>
                        );
                      })}
                    </div>

                    {ranchers.length === 0 ? (
                      <p className="text-saddle">No rancher applications yet.</p>
                    ) : (
                      <>
                        {(rancherStateFilter || rancherViewFilter || pipelineFilter) && (
                          <p className="text-sm text-saddle mb-4">
                            Showing {ranchers.filter(r => {
                              if (rancherStateFilter && r.state !== rancherStateFilter) return false;
                              if (rancherViewFilter === 'ready') return !!(r.agreement_signed && r.onboarding_status === 'Verification Complete');
                              if (rancherViewFilter === 'broken') return !!(r.onboarding_status === 'Live' && r.active_status !== 'Active');
                              if (pipelineFilter && getRancherPipelineStage(r) !== pipelineFilter) return false;
                              return true;
                            }).length} rancher(s)
                            {rancherViewFilter === 'ready' && ' (ready to go live)'}
                            {rancherViewFilter === 'broken' && ' (Live but not receiving leads)'}
                            {pipelineFilter && ` in "${pipelineFilter}" stage`}
                            {rancherStateFilter && ` in ${rancherStateFilter}`}
                          </p>
                        )}
                        <div className="space-y-3">
                          {ranchers
                            .filter(r => {
                              if (rancherStateFilter && r.state !== rancherStateFilter) return false;
                              if (rancherViewFilter === 'ready') return !!(r.agreement_signed && r.onboarding_status === 'Verification Complete');
                              if (rancherViewFilter === 'broken') return !!(r.onboarding_status === 'Live' && r.active_status !== 'Active');
                              if (pipelineFilter && getRancherPipelineStage(r) !== pipelineFilter) return false;
                              return true;
                            })
                            .map((rancher) => {
                              const isExpanded = expandedRancher === rancher.id;
                              const stage = getRancherPipelineStage(rancher);

                              // Determine next action button
                              const renderNextAction = () => {
                                if (stage === 'New') {
                                  return (
                                    <button
                                      onClick={() => {
                                        setOnboardingModal(rancher);
                                        setOnboardingForm({ callSummary: '', confirmedCapacity: 10, specialNotes: '', includeVerification: true });
                                      }}
                                      className="px-3 py-1 text-xs bg-charcoal text-bone hover:bg-divider"
                                    >
                                      Send Agreement
                                    </button>
                                  );
                                }
                                if (stage === 'Docs Sent') {
                                  return (
                                    <button
                                      onClick={() => {
                                        setOnboardingModal(rancher);
                                        setOnboardingForm({ callSummary: '', confirmedCapacity: rancher.monthly_capacity || 10, specialNotes: '', includeVerification: true });
                                      }}
                                      className="px-3 py-1 text-xs border border-amber-dark text-amber-dark hover:bg-amber/10"
                                    >
                                      Resend Agreement
                                    </button>
                                  );
                                }
                                if (stage === 'Agreement Signed') {
                                  return (
                                    <span className="px-3 py-1 text-xs border border-dust text-dust cursor-default">
                                      Awaiting Verification
                                    </span>
                                  );
                                }
                                if (stage === 'Verified') {
                                  return (
                                    <button
                                      onClick={() => {
                                        setConfirmAction({
                                          message: `Mark ${rancher.ranch_name || rancher.operator_name} as Live?`,
                                          onConfirm: () => updateOnboardingStatus(rancher.id, 'Live')
                                        });
                                      }}
                                      className="px-3 py-1 text-xs bg-sage-dark text-white hover:bg-sage-dark"
                                    >
                                      Go Live
                                    </button>
                                  );
                                }
                                if (stage === 'Live' && rancher.slug) {
                                  return (
                                    <a
                                      href={`/ranchers/${rancher.slug}`}
                                      target="_blank"
                                      className="px-3 py-1 text-xs border border-sage text-sage-dark hover:bg-sage/10"
                                    >
                                      View Page
                                    </a>
                                  );
                                }
                                return null;
                              };

                              return (
                                <div key={rancher.id} className="border border-dust bg-white">
                                  {/* Collapsed View */}
                                  <div className="p-4 flex flex-wrap items-center justify-between gap-3">
                                    <div className="flex items-center gap-3 flex-wrap flex-1 min-w-[200px]">
                                      <h3 className="font-medium">{rancher.ranch_name}</h3>
                                      {rancher.operator_name && <span className="text-sm text-saddle">{rancher.operator_name}</span>}
                                      {rancher.state && <span className="text-sm text-saddle">{rancher.state}</span>}
                                      {rancher.onboarding_status && (
                                        <span className={`px-2 py-0.5 text-xs border ${
                                          rancher.onboarding_status === 'Live' ? 'bg-sage/15 text-sage-dark border-sage/40' :
                                          rancher.onboarding_status === 'Docs Sent' ? 'bg-amber/15 text-amber-dark border-amber/60' :
                                          rancher.onboarding_status === 'Agreement Signed' ? 'bg-dust/25 text-saddle border-dust' :
                                          rancher.onboarding_status === 'Verification Pending' ? 'bg-saddle/15 text-saddle border-saddle/40' :
                                          rancher.onboarding_status === 'Verification Complete' ? 'bg-saddle/15 text-saddle border-saddle/40' :
                                          'bg-bone-deep text-saddle border-dust'
                                        }`}>
                                          {rancher.onboarding_status}
                                        </span>
                                      )}
                                      {rancher.featured && (
                                        <span className="px-2 py-0.5 text-xs font-bold bg-amber/15 text-amber-dark border border-amber/60">
                                          FEATURED
                                        </span>
                                      )}
                                    </div>

                                    <div className="flex items-center gap-2">
                                      {renderNextAction()}
                                      <button
                                        onClick={() => {
                                          setConfirmAction({
                                            message: `View dashboard as ${rancher.operator_name || rancher.ranch_name}? Audit alert fires to Telegram. 4h session.`,
                                            onConfirm: async () => {
                                              const res = await fetch(`/api/admin/ranchers/${rancher.id}/impersonate`, { method: 'POST' });
                                              if (!res.ok) {
                                                setToast({ message: 'Impersonation failed — check console', type: 'error' });
                                                console.error(await res.text());
                                                return;
                                              }
                                              const data = await res.json();
                                              setToast({ message: 'Opening rancher dashboard…', type: 'success' });
                                              window.open(data.redirectTo || '/rancher', '_blank');
                                            },
                                          });
                                        }}
                                        className="px-3 py-1 text-xs border border-charcoal bg-charcoal text-bone hover:bg-divider"
                                        title="Open this rancher's dashboard in a new tab. Audit alert fires."
                                      >
                                        🕵️ View as Rancher
                                      </button>
                                      <button
                                        onClick={() => setExpandedRancher(isExpanded ? null : rancher.id)}
                                        className="px-3 py-1 text-xs border border-dust hover:bg-dust hover:text-white"
                                      >
                                        {isExpanded ? 'Hide Details' : 'Show Details'}
                                      </button>
                                    </div>
                                  </div>

                                  {/* Expanded View */}
                                  {isExpanded && (
                                    <div className="px-4 pb-4 border-t border-dust/30 pt-3 space-y-2">
                                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                                        <div>
                                          <p><span className="text-saddle">Email:</span> {rancher.email}</p>
                                          <p><span className="text-saddle">Phone:</span> {rancher.phone}</p>
                                          <p><span className="text-saddle">Beef Types:</span> {rancher.beef_types}</p>
                                          {rancher.monthly_capacity && <p><span className="text-saddle">Monthly Capacity:</span> {rancher.monthly_capacity}</p>}
                                          {rancher.current_active_referrals !== undefined && rancher.current_active_referrals > 0 && (
                                            <p><span className="text-saddle">Referrals:</span> {rancher.current_active_referrals}/{rancher.max_active_referrals || 5}</p>
                                          )}
                                        </div>
                                        <div>
                                          {rancher.docs_sent_at && (
                                            <p className="text-amber-dark text-xs">
                                              Docs sent {Math.floor((Date.now() - new Date(rancher.docs_sent_at).getTime()) / 86400000)} days ago
                                            </p>
                                          )}
                                          {rancher.referred_by && <p className="text-xs text-saddle">Referred by: {rancher.referred_by}</p>}
                                          {rancher.ranch_tour_interested && (
                                            <p className="text-xs text-weathered">
                                              Interested in ranch tour
                                              {rancher.ranch_tour_availability && `: ${rancher.ranch_tour_availability}`}
                                            </p>
                                          )}
                                          {rancher.active_status && rancher.active_status !== 'Pending Onboarding' && (
                                            <p className="text-xs">Active Status: <span className={
                                              rancher.active_status === 'Active' ? 'text-sage-dark' :
                                              rancher.active_status === 'At Capacity' ? 'text-weathered' :
                                              'text-amber-dark'
                                            }>{rancher.active_status}</span></p>
                                          )}
                                          <p className="text-xs text-saddle">Applied: {new Date(rancher.created_at).toLocaleDateString()}</p>
                                        </div>
                                      </div>

                                      <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-dust/30">
                                        <select
                                          value={rancher.status}
                                          onChange={(e) => updateRancherStatus(rancher.id, e.target.value, rancher.certified)}
                                          className="px-3 py-1 border border-dust bg-bone text-sm"
                                        >
                                          <option value="Pending">Pending</option>
                                          <option value="Approved">Approved</option>
                                          <option value="Rejected">Rejected</option>
                                        </select>
                                        <button
                                          onClick={() => updateRancherStatus(rancher.id, rancher.status, !rancher.certified)}
                                          className={`px-3 py-1 text-sm border ${
                                            rancher.certified
                                              ? 'bg-charcoal text-bone border-charcoal'
                                              : 'bg-transparent text-charcoal border-dust'
                                          }`}
                                        >
                                          {rancher.certified ? 'CERTIFIED' : 'Not Certified'}
                                        </button>

                                        {/* All action buttons from original, shown in expanded view */}
                                        {(!rancher.onboarding_status || rancher.onboarding_status === 'Call Scheduled' || rancher.onboarding_status === 'Call Complete') && (
                                          <button
                                            onClick={() => {
                                              setOnboardingModal(rancher);
                                              setOnboardingForm({ callSummary: '', confirmedCapacity: 10, specialNotes: '', includeVerification: true });
                                            }}
                                            className="px-3 py-1 text-xs bg-charcoal text-bone hover:bg-divider"
                                          >
                                            Send Agreement
                                          </button>
                                        )}
                                        {rancher.onboarding_status === 'Docs Sent' && (
                                          <>
                                            <button
                                              onClick={() => {
                                                setOnboardingModal(rancher);
                                                setOnboardingForm({ callSummary: '', confirmedCapacity: rancher.monthly_capacity || 10, specialNotes: '', includeVerification: true });
                                              }}
                                              className="px-3 py-1 text-xs border border-amber-dark text-amber-dark hover:bg-amber/10"
                                            >
                                              Resend Agreement
                                            </button>
                                            <button
                                              onClick={() => updateOnboardingStatus(rancher.id, 'Agreement Signed')}
                                              className="px-3 py-1 text-xs border border-charcoal text-saddle hover:bg-dust/15"
                                            >
                                              Mark Agreement Signed
                                            </button>
                                          </>
                                        )}
                                        {(rancher.onboarding_status === 'Agreement Signed' || rancher.onboarding_status === 'Verification Pending') && (
                                          <>
                                            <button
                                              onClick={() => {
                                                setOnboardingModal(rancher);
                                                setOnboardingForm({ callSummary: '', confirmedCapacity: rancher.monthly_capacity || 10, specialNotes: '', includeVerification: true });
                                              }}
                                              className="px-3 py-1 text-xs border border-amber-dark text-amber-dark hover:bg-amber/10"
                                            >
                                              Resend Agreement
                                            </button>
                                            <button
                                              onClick={() => updateOnboardingStatus(rancher.id, 'Verification Complete')}
                                              className="px-3 py-1 text-xs border border-saddle text-saddle hover:bg-saddle/10"
                                            >
                                              Mark Verification Complete
                                            </button>
                                          </>
                                        )}
                                        {rancher.onboarding_status === 'Verification Complete' && (
                                          <>
                                            <button
                                              onClick={() => {
                                                setConfirmAction({
                                                  message: `Mark ${rancher.ranch_name || rancher.operator_name} as Live?`,
                                                  onConfirm: () => updateOnboardingStatus(rancher.id, 'Live')
                                                });
                                              }}
                                              className="px-3 py-1 text-xs bg-sage-dark text-white hover:bg-sage-dark"
                                            >
                                              Mark Live
                                            </button>
                                            <button
                                              onClick={() => { setReleaseModal(rancher); setReleaseAnnounce(true); }}
                                              className="px-3 py-1 text-xs bg-amber-dark text-white hover:opacity-90"
                                            >
                                              Release + Announce
                                            </button>
                                          </>
                                        )}
                                        {rancher.onboarding_status === 'Live' && !rancher.featured && (
                                          <button
                                            onClick={async () => {
                                              const res = await fetch(`/api/admin/ranchers/${rancher.id}`, {
                                                method: 'PATCH',
                                                headers: { 'Content-Type': 'application/json' },
                                                body: JSON.stringify({ featured: true }),
                                              });
                                              if (!res.ok) {
                                                setToast({ message: 'Failed to feature rancher', type: 'error' });
                                                return;
                                              }
                                              setToast({ message: 'Rancher featured!', type: 'success' });
                                              fetchAllData();
                                            }}
                                            className="px-3 py-1 text-xs border border-amber-dark text-amber-dark hover:bg-amber/10"
                                          >
                                            Feature
                                          </button>
                                        )}
                                        {rancher.featured && (
                                          <button
                                            onClick={async () => {
                                              const res = await fetch(`/api/admin/ranchers/${rancher.id}`, {
                                                method: 'PATCH',
                                                headers: { 'Content-Type': 'application/json' },
                                                body: JSON.stringify({ featured: false }),
                                              });
                                              if (!res.ok) {
                                                setToast({ message: 'Failed to unfeature rancher', type: 'error' });
                                                return;
                                              }
                                              setToast({ message: 'Rancher unfeatured', type: 'success' });
                                              fetchAllData();
                                            }}
                                            className="px-3 py-1 text-xs border border-dust text-saddle hover:bg-bone-deep"
                                          >
                                            Unfeature
                                          </button>
                                        )}
                                        <a
                                          href={`/admin/ranchers/${rancher.id}`}
                                          className="px-3 py-1 text-xs border border-saddle text-saddle hover:bg-saddle hover:text-white transition-colors"
                                        >
                                          Edit Page
                                        </a>
                                        {rancher.slug && rancher.page_live && (
                                          <a
                                            href={`/ranchers/${rancher.slug}`}
                                            target="_blank"
                                            className="px-3 py-1 text-xs border border-sage text-sage-dark hover:bg-sage/10"
                                          >
                                            View Live
                                          </a>
                                        )}
                                        {rancher.slug && !rancher.page_live && (
                                          <button
                                            onClick={async () => {
                                              setConfirmAction({
                                                message: `Publish ${rancher.ranch_name || rancher.operator_name}'s landing page at /ranchers/${rancher.slug}?`,
                                                onConfirm: async () => {
                                                  const res = await fetch(`/api/admin/ranchers/${rancher.id}/go-live`, { method: 'POST' });
                                                  if (res.ok) {
                                                    setToast({ message: 'Page is now live!', type: 'success' });
                                                    fetchAllData();
                                                  } else {
                                                    setToast({ message: 'Failed to go live', type: 'error' });
                                                  }
                                                }
                                              });
                                            }}
                                            className="px-3 py-1 text-xs bg-sage text-white hover:bg-sage-dark"
                                          >
                                            Go Live
                                          </button>
                                        )}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
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
                      <p className="text-saddle">No brand applications yet.</p>
                    ) : (
                      <div className="space-y-4">
                        {brands.map((brand) => (
                          <div key={brand.id} className="p-4 border border-dust space-y-3">
                            <div className="flex flex-wrap items-start justify-between gap-4">
                              <div>
                                <h3 className="font-medium text-lg">{brand.brand_name}</h3>
                                <p className="text-sm text-saddle">Contact: {brand.contact_name}</p>
                                <p className="text-sm">{brand.email}</p>
                                <p className="text-sm">Product: {brand.product_type}</p>
                                <p className="text-sm">Discount: {brand.discount_offered}%</p>
                                {brand.payment_status === 'Paid' ? (
                                  <span className="inline-block mt-1 px-2 py-0.5 bg-sage/15 text-sage-dark text-xs font-medium">PAID</span>
                                ) : brand.status === 'Approved' ? (
                                  <span className="inline-block mt-1 px-2 py-0.5 bg-amber/15 text-amber-dark text-xs font-medium">PAYMENT PENDING</span>
                                ) : null}
                              </div>
                              <div className="flex gap-2 flex-wrap">
                                <select
                                  value={brand.status}
                                  onChange={(e) => updateBrandStatus(brand.id, e.target.value, brand.active)}
                                  className="px-3 py-1 border border-dust bg-bone text-sm"
                                >
                                  <option value="Pending">Pending</option>
                                  <option value="Approved">Approved</option>
                                  <option value="Rejected">Rejected</option>
                                </select>
                                <button
                                  onClick={() => updateBrandStatus(brand.id, brand.status, !brand.active)}
                                  className={`px-3 py-1 text-sm border ${
                                    brand.active
                                      ? 'bg-charcoal text-bone border-charcoal'
                                      : 'bg-transparent text-charcoal border-dust'
                                  }`}
                                >
                                  {brand.active ? 'ACTIVE' : 'Inactive'}
                                </button>
                              </div>
                            </div>
                            <p className="text-xs text-saddle">
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
                      <p className="text-saddle">No land deals submitted yet.</p>
                    ) : (
                      <div className="space-y-4">
                        {landDeals.map((deal) => (
                          <div key={deal.id} className="p-4 border border-dust space-y-3">
                            <div className="flex flex-wrap items-start justify-between gap-4">
                              <div>
                                <h3 className="font-medium text-lg">
                                  {deal.acreage} Acres — {deal.property_location}, {deal.state}
                                </h3>
                                <p className="text-sm text-saddle">Seller: {deal.seller_name}</p>
                                <p className="text-sm font-medium">{deal.asking_price}</p>
                              </div>
                              <div className="flex gap-2 flex-wrap">
                                <select
                                  value={deal.status}
                                  onChange={(e) => updateLandDealStatus(deal.id, e.target.value, deal.visible_to_members)}
                                  className="px-3 py-1 border border-dust bg-bone text-sm"
                                >
                                  <option value="Pending">Pending</option>
                                  <option value="Approved">Approved</option>
                                  <option value="Rejected">Rejected</option>
                                </select>
                                <button
                                  onClick={() => updateLandDealStatus(deal.id, deal.status, !deal.visible_to_members)}
                                  className={`px-3 py-1 text-sm border ${
                                    deal.visible_to_members
                                      ? 'bg-charcoal text-bone border-charcoal'
                                      : 'bg-transparent text-charcoal border-dust'
                                  }`}
                                >
                                  {deal.visible_to_members ? 'VISIBLE' : 'Hidden'}
                                </button>
                              </div>
                            </div>
                            <p className="text-xs text-saddle">
                              Submitted: {new Date(deal.created_at).toLocaleDateString()}
                            </p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </Container>

      {/* Admin Notes Modal */}
      {notesModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white max-w-lg w-full p-6 space-y-4">
            <h3 className="font-[family-name:var(--font-serif)] text-xl">
              Admin Notes — {notesModal.first_name}
            </h3>
            <p className="text-sm text-saddle">
              {notesModal.email} · {notesModal.phone || 'No phone'}
            </p>
            <textarea
              value={notesText}
              onChange={(e) => setNotesText(e.target.value)}
              placeholder="Call outcome, next steps, verification notes..."
              rows={6}
              className="w-full px-4 py-3 border border-dust bg-bone text-sm"
            />
            <div className="flex gap-2">
              <button
                onClick={() => saveAdminNotes(notesModal.id, notesText)}
                disabled={savingNotes}
                className="flex-1 px-4 py-3 bg-charcoal text-bone text-sm font-medium hover:bg-divider disabled:opacity-50"
              >
                {savingNotes ? 'Saving...' : 'Save Notes'}
              </button>
              <button
                onClick={() => setNotesModal(null)}
                className="flex-1 px-4 py-3 border border-dust text-sm hover:bg-dust"
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
            <p className="text-sm text-saddle">
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
                  className="w-full px-4 py-3 border border-dust bg-bone text-sm"
                />
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium">Confirmed Capacity (orders/month)</label>
                <input
                  type="number"
                  value={onboardingForm.confirmedCapacity}
                  onChange={(e) => setOnboardingForm(p => ({ ...p, confirmedCapacity: parseInt(e.target.value) || 0 }))}
                  className="w-full px-4 py-3 border border-dust bg-bone text-sm"
                />
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium">Special Notes (goals, alignment)</label>
                <textarea
                  value={onboardingForm.specialNotes}
                  onChange={(e) => setOnboardingForm(p => ({ ...p, specialNotes: e.target.value }))}
                  placeholder="What makes them a great fit..."
                  rows={3}
                  className="w-full px-4 py-3 border border-dust bg-bone text-sm"
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
                className="flex-1 px-4 py-3 bg-charcoal text-bone text-sm font-medium hover:bg-divider disabled:opacity-50"
              >
                {sendingDocs ? 'Sending...' : 'Send Package'}
              </button>
              <button
                onClick={() => setOnboardingModal(null)}
                className="flex-1 px-4 py-3 border border-dust text-sm hover:bg-dust"
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
            <p className="text-sm text-saddle">
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
                className="flex-1 px-4 py-3 bg-amber-dark text-white text-sm font-medium hover:opacity-90"
              >
                {releaseAnnounce ? 'Release & Draft Email' : 'Release Now'}
              </button>
              <button
                onClick={() => setReleaseModal(null)}
                className="flex-1 px-4 py-3 border border-dust text-sm hover:bg-dust"
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
