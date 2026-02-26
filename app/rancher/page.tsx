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

type Tab = 'overview' | 'referrals' | 'earnings' | 'benefits';

const statusStyles: Record<string, string> = {
  'Intro Sent': 'bg-blue-100 text-blue-800',
  'Rancher Contacted': 'bg-indigo-100 text-indigo-800',
  'In Progress': 'bg-purple-100 text-purple-800',
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

  const activeRefs = referrals.filter(r => ['Intro Sent', 'Rancher Contacted', 'In Progress', 'Negotiation'].includes(r.status));
  const closedRefs = referrals.filter(r => ['Closed Won', 'Closed Lost'].includes(r.status));

  const tabs: { key: Tab; label: string }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'referrals', label: `Active Leads (${activeRefs.length})` },
    { key: 'earnings', label: 'Earnings' },
    { key: 'benefits', label: `Network Benefits${benefits.length > 0 ? ` (${benefits.length})` : ''}` },
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
            <div className="p-4 border-2 border-yellow-400 bg-yellow-50">
              <p className="font-medium">Onboarding Status: {rancherInfo.onboardingStatus}</p>
              <p className="text-sm text-saddle-brown mt-1">
                {rancherInfo.onboardingStatus === 'Docs Sent' && 'Please review and sign the agreement documents sent to your email.'}
                {rancherInfo.onboardingStatus === 'Agreement Signed' && 'Your agreement is signed. Verification is pending.'}
                {rancherInfo.onboardingStatus === 'Verification Pending' && 'We are verifying your operation. You will be notified when you go live.'}
                {!['Docs Sent', 'Agreement Signed', 'Verification Pending'].includes(rancherInfo.onboardingStatus) && 'Complete your onboarding to start receiving buyer leads.'}
              </p>
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
                  <h3 className="font-serif text-xl mb-4">Capacity</h3>
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
