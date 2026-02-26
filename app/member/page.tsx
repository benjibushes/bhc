'use client';

import { useState, useEffect } from 'react';
import Container from '../components/Container';
import Divider from '../components/Divider';
import MemberAuthGuard from '../components/MemberAuthGuard';
import ContactRancherButton from '../components/ContactRancherButton';
import Link from 'next/link';

interface Rancher {
  id: string;
  'Ranch Name': string;
  'Operator Name': string;
  Email: string;
  Phone: string;
  State: string;
  'Beef Types': string;
  'Monthly Capacity': number;
  Certifications: string;
  Certified: boolean;
}

interface LandDeal {
  id: string;
  'Property Location': string;
  State: string;
  Acreage: number;
  'Asking Price': string;
  'Property Type': string;
  Description: string;
}

interface Brand {
  id: string;
  'Brand Name': string;
  'Product Type': string;
  Website: string;
  'Promotion Details': string;
  'Discount Offered': number;
}

interface MemberReferral {
  id: string;
  status: string;
  rancher_name: string;
  created_at: string;
}

type Tab = 'dashboard' | 'ranchers' | 'land' | 'brands';

const statusLabels: Record<string, { label: string; style: string }> = {
  'Pending Approval': { label: 'Being Matched', style: 'bg-yellow-100 text-yellow-800' },
  'Waitlisted': { label: 'Waitlisted — No Rancher Yet', style: 'bg-orange-100 text-orange-800' },
  'Intro Sent': { label: 'Rancher Introduced', style: 'bg-blue-100 text-blue-800' },
  'In Progress': { label: 'In Progress', style: 'bg-purple-100 text-purple-800' },
  'Closed Won': { label: 'Completed', style: 'bg-green-100 text-green-800' },
  'Closed Lost': { label: 'Closed', style: 'bg-gray-100 text-gray-600' },
  'Rejected': { label: 'No Match Available', style: 'bg-red-100 text-red-800' },
};

function MemberDashboard({ member }: { member: { id: string; name: string; email: string; state: string } }) {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const [upgradeForm, setUpgradeForm] = useState({ orderType: '', budgetRange: '' });
  const [upgrading, setUpgrading] = useState(false);
  const [upgradeSuccess, setUpgradeSuccess] = useState(false);
  const [data, setData] = useState<{
    memberState: string;
    memberSegment: string;
    stateRanchers: Rancher[];
    otherRanchers: Rancher[];
    landDeals: LandDeal[];
    brands: Brand[];
    memberReferrals: MemberReferral[];
  } | null>(null);

  useEffect(() => {
    fetchContent();
  }, []);

  const fetchContent = async () => {
    setFetchError(false);
    try {
      const response = await fetch('/api/member/content');
      if (response.ok) {
        const content = await response.json();
        setData(content);
      } else {
        setFetchError(true);
      }
    } catch {
      setFetchError(true);
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    await fetch('/api/auth/member/session', { method: 'DELETE' });
    window.location.href = '/';
  };

  const handleUpgradeIntent = async () => {
    if (!upgradeForm.orderType) return;
    setUpgrading(true);
    try {
      const res = await fetch('/api/member/upgrade-intent', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(upgradeForm),
      });
      if (res.ok) {
        setUpgradeSuccess(true);
        fetchContent();
      }
    } catch {
      // Silently fail
    }
    setUpgrading(false);
  };

  if (loading) {
    return (
      <main className="min-h-screen py-24 bg-bone-white text-charcoal-black">
        <Container>
          <div className="text-center">
            <div className="inline-block w-8 h-8 border-4 border-charcoal-black border-t-transparent rounded-full animate-spin" />
          </div>
        </Container>
      </main>
    );
  }

  if (fetchError && !data) {
    return (
      <main className="min-h-screen py-24 bg-bone-white text-charcoal-black">
        <Container>
          <div className="max-w-md mx-auto text-center space-y-6">
            <h1 className="font-serif text-3xl">Unable to Load</h1>
            <p className="text-saddle-brown">We couldn&apos;t load your dashboard. Please check your connection and try again.</p>
            <button onClick={fetchContent} className="px-6 py-3 bg-charcoal-black text-bone-white hover:bg-opacity-80 transition-colors uppercase tracking-wider text-sm font-semibold">
              Retry
            </button>
          </div>
        </Container>
      </main>
    );
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: 'dashboard', label: 'My Status' },
    { key: 'ranchers', label: `Ranchers${data?.stateRanchers?.length ? ` (${data.stateRanchers.length} in ${data.memberState})` : ''}` },
    { key: 'land', label: `Land Deals (${data?.landDeals?.length || 0})` },
    { key: 'brands', label: `Promotions (${data?.brands?.length || 0})` },
  ];

  return (
    <main className="min-h-screen py-12 bg-bone-white text-charcoal-black">
      <Container>
        <div className="space-y-8">
          {/* Header */}
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
            <div>
              <h1 className="font-serif text-3xl md:text-4xl">
                Welcome back, {member.name.split(' ')[0]}
              </h1>
              <p className="text-saddle-brown mt-1">
                {member.state} Member
              </p>
            </div>
            <button
              onClick={handleLogout}
              className="text-sm text-dust-gray hover:text-charcoal-black transition-colors"
            >
              Log out
            </button>
          </div>

          <Divider />

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

          {/* Dashboard Tab */}
          {activeTab === 'dashboard' && (
            <div className="space-y-8">
              <h2 className="font-serif text-2xl">Your Referral Status</h2>

              {data?.memberReferrals && data.memberReferrals.length > 0 ? (
                <div className="space-y-4">
                  {data.memberReferrals.map((ref) => {
                    const statusInfo = statusLabels[ref.status] || { label: ref.status, style: 'bg-gray-100 text-gray-600' };
                    return (
                      <div key={ref.id} className="p-6 border border-dust-gray bg-white">
                        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                          <div>
                            <span className={`inline-block px-3 py-1 text-xs font-medium uppercase tracking-wider ${statusInfo.style}`}>
                              {statusInfo.label}
                            </span>
                            {ref.rancher_name && (
                              <p className="mt-2 text-sm text-saddle-brown">
                                Matched with: <strong className="text-charcoal-black">{ref.rancher_name}</strong>
                              </p>
                            )}
                          </div>
                          <p className="text-xs text-dust-gray">
                            {ref.created_at ? new Date(ref.created_at).toLocaleDateString() : ''}
                          </p>
                        </div>

                        {ref.status === 'Pending Approval' && (
                          <p className="mt-3 text-sm text-saddle-brown">
                            We&apos;re finding the best rancher match for you. You&apos;ll receive an email introduction soon.
                          </p>
                        )}
                        {ref.status === 'Waitlisted' && (
                          <p className="mt-3 text-sm text-saddle-brown">
                            We don&apos;t have a certified rancher in your area yet, but we&apos;re actively onboarding. You&apos;ll be first to know when one goes live.
                          </p>
                        )}
                        {ref.status === 'Intro Sent' && (
                          <p className="mt-3 text-sm text-saddle-brown">
                            Your rancher has been introduced. Check your email for their contact details.
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="p-8 border border-dust-gray text-center bg-white">
                  <p className="text-saddle-brown mb-4">
                    No active referrals yet. We&apos;re working on matching you with a rancher in {data?.memberState || 'your state'}.
                  </p>
                  <p className="text-sm text-dust-gray">
                    You&apos;ll receive an email when a match is found.
                  </p>
                </div>
              )}

              {/* Upgrade to Beef Buyer card for Community members */}
              {data?.memberSegment && data.memberSegment !== 'Beef Buyer' && !upgradeSuccess && (
                <div className="p-6 border-2 border-charcoal-black bg-white space-y-4">
                  <h3 className="font-serif text-xl">Interested in Sourcing Beef?</h3>
                  <p className="text-sm text-saddle-brown">
                    Get matched directly with a verified rancher in your area. Tell us what you&apos;re looking for and we&apos;ll find the right fit.
                  </p>
                  <div className="grid sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-saddle-brown mb-1 uppercase tracking-wider">Order Size</label>
                      <select
                        value={upgradeForm.orderType}
                        onChange={(e) => setUpgradeForm(prev => ({ ...prev, orderType: e.target.value }))}
                        className="w-full px-3 py-2 border border-dust-gray bg-bone-white text-sm"
                      >
                        <option value="">Select...</option>
                        <option value="Quarter">Quarter Cow</option>
                        <option value="Half">Half Cow</option>
                        <option value="Whole">Whole Cow</option>
                        <option value="Not Sure">Not Sure Yet</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-saddle-brown mb-1 uppercase tracking-wider">Budget</label>
                      <select
                        value={upgradeForm.budgetRange}
                        onChange={(e) => setUpgradeForm(prev => ({ ...prev, budgetRange: e.target.value }))}
                        className="w-full px-3 py-2 border border-dust-gray bg-bone-white text-sm"
                      >
                        <option value="">Select...</option>
                        <option value="<$500">Under $500</option>
                        <option value="$500-$1000">$500 - $1,000</option>
                        <option value="$1000-$2000">$1,000 - $2,000</option>
                        <option value="$2000+">$2,000+</option>
                        <option value="Unsure">Unsure</option>
                      </select>
                    </div>
                  </div>
                  <button
                    onClick={handleUpgradeIntent}
                    disabled={!upgradeForm.orderType || upgrading}
                    className="px-6 py-3 bg-charcoal-black text-bone-white hover:bg-opacity-80 transition-colors uppercase tracking-wider text-sm font-semibold disabled:opacity-50"
                  >
                    {upgrading ? 'Submitting...' : 'Match Me With a Rancher'}
                  </button>
                </div>
              )}

              {upgradeSuccess && (
                <div className="p-6 border-2 border-green-600 bg-green-50 text-center">
                  <p className="font-serif text-xl text-green-800">You&apos;re on the list!</p>
                  <p className="text-sm text-green-700 mt-2">We&apos;re matching you with a rancher in {data?.memberState || 'your area'}. You&apos;ll hear from us soon.</p>
                </div>
              )}

              <Divider />

              <div className="grid md:grid-cols-3 gap-6">
                <div className="p-6 border border-dust-gray bg-white text-center">
                  <div className="font-serif text-3xl">{data?.stateRanchers?.length || 0}</div>
                  <p className="text-sm text-saddle-brown mt-1">Ranchers in {data?.memberState}</p>
                </div>
                <div className="p-6 border border-dust-gray bg-white text-center">
                  <div className="font-serif text-3xl">{data?.landDeals?.length || 0}</div>
                  <p className="text-sm text-saddle-brown mt-1">Land Deals Available</p>
                </div>
                <div className="p-6 border border-dust-gray bg-white text-center">
                  <div className="font-serif text-3xl">{data?.brands?.length || 0}</div>
                  <p className="text-sm text-saddle-brown mt-1">Active Promotions</p>
                </div>
              </div>
            </div>
          )}

          {/* Ranchers Tab */}
          {activeTab === 'ranchers' && (
            <div className="space-y-8">
              {data?.stateRanchers && data.stateRanchers.length > 0 && (
                <>
                  <h2 className="font-serif text-2xl">Ranchers in {data.memberState}</h2>
                  <div className="space-y-6">
                    {data.stateRanchers.map((rancher) => (
                      <RancherCard key={rancher.id} rancher={rancher} />
                    ))}
                  </div>
                </>
              )}

              {data?.stateRanchers?.length === 0 && (
                <div className="p-8 border border-dust-gray text-center bg-white">
                  <p className="text-saddle-brown">
                    No certified ranchers in {data.memberState} yet. We&apos;re actively onboarding ranchers in your area.
                  </p>
                </div>
              )}

              {data?.otherRanchers && data.otherRanchers.length > 0 && (
                <>
                  <Divider />
                  <h2 className="font-serif text-2xl">Other Certified Ranchers</h2>
                  <div className="space-y-6">
                    {data.otherRanchers.map((rancher) => (
                      <RancherCard key={rancher.id} rancher={rancher} />
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Land Deals Tab */}
          {activeTab === 'land' && (
            <div className="space-y-8">
              <h2 className="font-serif text-2xl">Exclusive Land Deals</h2>
              {data?.landDeals && data.landDeals.length > 0 ? (
                <div className="space-y-6">
                  {data.landDeals.map((deal) => (
                    <div key={deal.id} className="p-6 border border-dust-gray bg-white space-y-4">
                      <div className="flex justify-between items-start">
                        <div>
                          <h3 className="font-serif text-xl">
                            {deal.Acreage} Acres — {deal['Property Location'] || deal.State}
                          </h3>
                          <p className="text-sm text-saddle-brown">{deal.State} &middot; {deal['Property Type']}</p>
                        </div>
                        <span className="font-serif text-xl">{deal['Asking Price']}</span>
                      </div>
                      {deal.Description && <p className="text-sm leading-relaxed">{deal.Description}</p>}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-8 border border-dust-gray text-center bg-white">
                  <p className="text-saddle-brown">No land deals available right now. Check back soon.</p>
                </div>
              )}
            </div>
          )}

          {/* Brands Tab */}
          {activeTab === 'brands' && (
            <div className="space-y-8">
              <h2 className="font-serif text-2xl">Member Promotions</h2>
              {data?.brands && data.brands.length > 0 ? (
                <div className="grid md:grid-cols-2 gap-6">
                  {data.brands.map((brand) => (
                    <div key={brand.id} className="p-6 border border-dust-gray bg-white space-y-4">
                      <h3 className="font-serif text-xl">{brand['Brand Name']}</h3>
                      <p className="text-sm text-saddle-brown">{brand['Product Type']}</p>
                      <Divider />
                      {brand['Promotion Details'] && <p className="text-sm leading-relaxed">{brand['Promotion Details']}</p>}
                      {brand['Discount Offered'] > 0 && (
                        <span className="inline-block px-4 py-2 bg-charcoal-black text-bone-white font-medium text-sm">
                          {brand['Discount Offered']}% OFF
                        </span>
                      )}
                      {brand.Website && (
                        <div>
                          <a href={brand.Website} target="_blank" rel="noopener noreferrer" className="text-sm text-charcoal-black hover:text-saddle-brown transition-colors">
                            Visit Website →
                          </a>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-8 border border-dust-gray text-center bg-white">
                  <p className="text-saddle-brown">No active promotions right now. Check back soon.</p>
                </div>
              )}
            </div>
          )}

          <Divider />

          <div className="text-center">
            <Link href="/" className="text-saddle-brown hover:text-charcoal-black transition-colors text-sm">
              ← Back to home
            </Link>
          </div>
        </div>
      </Container>
    </main>
  );
}

function RancherCard({ rancher }: { rancher: Rancher }) {
  const rancherForContact = {
    id: rancher.id,
    ranch_name: rancher['Ranch Name'] || '',
    operator_name: rancher['Operator Name'] || '',
    email: rancher.Email || '',
    state: rancher.State || '',
  };

  return (
    <div className="p-6 border border-dust-gray bg-white space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="font-serif text-xl">{rancher['Ranch Name']}</h3>
          <p className="text-sm text-saddle-brown">Operator: {rancher['Operator Name']}</p>
        </div>
        {rancher.Certified && (
          <span className="px-3 py-1 bg-charcoal-black text-bone-white text-xs font-medium uppercase tracking-wider">
            Certified
          </span>
        )}
      </div>
      <div className="grid md:grid-cols-2 gap-3 text-sm">
        <div><span className="text-saddle-brown">Location:</span> {rancher.State}</div>
        <div><span className="text-saddle-brown">Capacity:</span> {rancher['Monthly Capacity']} head/month</div>
        <div className="md:col-span-2"><span className="text-saddle-brown">Beef Types:</span> {rancher['Beef Types']}</div>
        {rancher.Certifications && (
          <div className="md:col-span-2"><span className="text-saddle-brown">Certifications:</span> {rancher.Certifications}</div>
        )}
      </div>
      <div className="pt-2">
        <ContactRancherButton rancher={rancherForContact} />
      </div>
    </div>
  );
}

export default function MemberPage() {
  return (
    <MemberAuthGuard>
      {(member) => <MemberDashboard member={member} />}
    </MemberAuthGuard>
  );
}
