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
  // Landing page fields — used for conversion cards
  Slug?: string;
  'Page Live'?: boolean;
  'Logo URL'?: string;
  Tagline?: string;
  'Quarter Price'?: number;
  'Quarter lbs'?: string;
  'Quarter Payment Link'?: string;
  'Half Price'?: number;
  'Half lbs'?: string;
  'Half Payment Link'?: string;
  'Whole Price'?: number;
  'Whole lbs'?: string;
  'Whole Payment Link'?: string;
  'Next Processing Date'?: string;
  'Reserve Link'?: string;
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
  rancher_id?: string;
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
    hasOrderDetails: boolean;
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
      <main className="min-h-screen py-24 bg-bone text-charcoal">
        <Container>
          <div className="text-center">
            <div className="inline-block w-8 h-8 border-4 border-charcoal border-t-transparent rounded-full animate-spin" />
          </div>
        </Container>
      </main>
    );
  }

  if (fetchError && !data) {
    return (
      <main className="min-h-screen py-24 bg-bone text-charcoal">
        <Container>
          <div className="max-w-md mx-auto text-center space-y-6">
            <h1 className="font-serif text-3xl">Unable to Load</h1>
            <p className="text-saddle">We couldn&apos;t load your dashboard. Please check your connection and try again.</p>
            <button onClick={fetchContent} className="px-6 py-3 bg-charcoal text-bone hover:bg-opacity-80 transition-colors uppercase tracking-wider text-sm font-semibold">
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
    <main className="min-h-screen py-12 bg-bone text-charcoal">
      <Container>
        <div className="space-y-8">
          {/* Header */}
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
            <div>
              <h1 className="font-serif text-3xl md:text-4xl">
                Welcome back, {member.name.split(' ')[0]}
              </h1>
              <p className="text-saddle mt-1">
                {member.state} Member
              </p>
            </div>
            <button
              onClick={handleLogout}
              className="text-sm text-dust hover:text-charcoal transition-colors"
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
                    ? 'bg-charcoal text-bone'
                    : 'border border-dust hover:bg-charcoal hover:text-bone'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Dashboard Tab */}
          {activeTab === 'dashboard' && (
            <div className="space-y-8">
              {/* Your Match Hero — prominent conversion card when a rancher is matched */}
              {(() => {
                const activeRef = data?.memberReferrals?.find(
                  r => r.status !== 'Closed Won' && r.status !== 'Closed Lost' && r.rancher_id
                );
                if (!activeRef?.rancher_id) return null;
                const matchedRancher =
                  data?.stateRanchers?.find(r => r.id === activeRef.rancher_id) ||
                  data?.otherRanchers?.find(r => r.id === activeRef.rancher_id);
                if (!matchedRancher) return null;
                return (
                  <YourMatchHero rancher={matchedRancher} status={activeRef.status} />
                );
              })()}

              <h2 className="font-serif text-2xl">Your Referral Status</h2>

              {data?.memberReferrals && data.memberReferrals.length > 0 ? (
                <div className="space-y-4">
                  {data.memberReferrals.map((ref) => {
                    const statusInfo = statusLabels[ref.status] || { label: ref.status, style: 'bg-gray-100 text-gray-600' };
                    return (
                      <div key={ref.id} className="p-6 border border-dust bg-white">
                        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                          <div>
                            <span className={`inline-block px-3 py-1 text-xs font-medium uppercase tracking-wider ${statusInfo.style}`}>
                              {statusInfo.label}
                            </span>
                            {ref.rancher_name && (
                              <p className="mt-2 text-sm text-saddle">
                                Matched with: <strong className="text-charcoal">{ref.rancher_name}</strong>
                              </p>
                            )}
                          </div>
                          <p className="text-xs text-dust">
                            {ref.created_at ? new Date(ref.created_at).toLocaleDateString() : ''}
                          </p>
                        </div>

                        {ref.status === 'Pending Approval' && (
                          <p className="mt-3 text-sm text-saddle">
                            We&apos;re finding the best rancher match for you. You&apos;ll receive an email introduction soon.
                          </p>
                        )}
                        {ref.status === 'Waitlisted' && (
                          <p className="mt-3 text-sm text-saddle">
                            We don&apos;t have a certified rancher in your area yet, but we&apos;re actively onboarding. You&apos;ll be first to know when one goes live.
                          </p>
                        )}
                        {ref.status === 'Intro Sent' && (
                          <p className="mt-3 text-sm text-saddle">
                            Your rancher has been introduced. Check your email for their contact details.
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="p-8 border border-dust text-center bg-white">
                  <p className="text-saddle mb-4">
                    No active referrals yet. We&apos;re working on matching you with a rancher in {data?.memberState || 'your state'}.
                  </p>
                  <p className="text-sm text-dust">
                    You&apos;ll receive an email when a match is found.
                  </p>
                </div>
              )}

              {/* Order details card — shows for anyone who hasn't told us what they want */}
              {data && !data.hasOrderDetails && !upgradeSuccess && (
                <div className="p-6 border-2 border-charcoal bg-white space-y-4">
                  <h3 className="font-serif text-xl">What Are You Looking For?</h3>
                  <p className="text-sm text-saddle">
                    Tell us what you want and we&apos;ll match you with the right rancher. Takes 30 seconds.
                  </p>
                  <div className="grid sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-saddle mb-1 uppercase tracking-wider">Order Size</label>
                      <select
                        value={upgradeForm.orderType}
                        onChange={(e) => setUpgradeForm(prev => ({ ...prev, orderType: e.target.value }))}
                        className="w-full px-3 py-2 border border-dust bg-bone text-sm"
                      >
                        <option value="">Select...</option>
                        <option value="Quarter">Quarter Cow</option>
                        <option value="Half">Half Cow</option>
                        <option value="Whole">Whole Cow</option>
                        <option value="Not Sure">Not Sure Yet</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-saddle mb-1 uppercase tracking-wider">Budget</label>
                      <select
                        value={upgradeForm.budgetRange}
                        onChange={(e) => setUpgradeForm(prev => ({ ...prev, budgetRange: e.target.value }))}
                        className="w-full px-3 py-2 border border-dust bg-bone text-sm"
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
                    className="px-6 py-3 bg-charcoal text-bone hover:bg-opacity-80 transition-colors uppercase tracking-wider text-sm font-semibold disabled:opacity-50"
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
                <div className="p-6 border border-dust bg-white text-center">
                  <div className="font-serif text-3xl">{data?.stateRanchers?.length || 0}</div>
                  <p className="text-sm text-saddle mt-1">Ranchers in {data?.memberState}</p>
                </div>
                <div className="p-6 border border-dust bg-white text-center">
                  <div className="font-serif text-3xl">{data?.landDeals?.length || 0}</div>
                  <p className="text-sm text-saddle mt-1">Land Deals Available</p>
                </div>
                <div className="p-6 border border-dust bg-white text-center">
                  <div className="font-serif text-3xl">{data?.brands?.length || 0}</div>
                  <p className="text-sm text-saddle mt-1">Active Promotions</p>
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
                <div className="p-8 border border-dust text-center bg-white">
                  <p className="text-saddle">
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
                    <div key={deal.id} className="p-6 border border-dust bg-white space-y-4">
                      <div className="flex justify-between items-start">
                        <div>
                          <h3 className="font-serif text-xl">
                            {deal.Acreage} Acres — {deal['Property Location'] || deal.State}
                          </h3>
                          <p className="text-sm text-saddle">{deal.State} &middot; {deal['Property Type']}</p>
                        </div>
                        <span className="font-serif text-xl">{deal['Asking Price']}</span>
                      </div>
                      {deal.Description && <p className="text-sm leading-relaxed">{deal.Description}</p>}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-8 border border-dust text-center bg-white">
                  <p className="text-saddle">No land deals available right now. Check back soon.</p>
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
                    <div key={brand.id} className="p-6 border border-dust bg-white space-y-4">
                      <h3 className="font-serif text-xl">{brand['Brand Name']}</h3>
                      <p className="text-sm text-saddle">{brand['Product Type']}</p>
                      <Divider />
                      {brand['Promotion Details'] && <p className="text-sm leading-relaxed">{brand['Promotion Details']}</p>}
                      {brand['Discount Offered'] > 0 && (
                        <span className="inline-block px-4 py-2 bg-charcoal text-bone font-medium text-sm">
                          {brand['Discount Offered']}% OFF
                        </span>
                      )}
                      {brand.Website && (
                        <div>
                          <a href={brand.Website} target="_blank" rel="noopener noreferrer" className="text-sm text-charcoal hover:text-saddle transition-colors">
                            Visit Website →
                          </a>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-8 border border-dust text-center bg-white">
                  <p className="text-saddle">No active promotions right now. Check back soon.</p>
                </div>
              )}
            </div>
          )}

          <Divider />

          <div className="text-center">
            <Link href="/" className="text-saddle hover:text-charcoal transition-colors text-sm">
              ← Back to home
            </Link>
          </div>
        </div>
      </Container>
    </main>
  );
}

// Renders the price-tier buy buttons for a rancher that has payment links.
// Uses the tracked redirect endpoint (/ranchers/[slug]/pay/[tier]) so clicks
// are logged in Airtable before the user lands on the payment page.
function BuyTierButtons({ rancher }: { rancher: Rancher }) {
  const slug = rancher.Slug;
  const tiers = [
    { key: 'quarter', label: 'Quarter Cow', price: rancher['Quarter Price'], lbs: rancher['Quarter lbs'], link: rancher['Quarter Payment Link'] },
    { key: 'half', label: 'Half Cow', price: rancher['Half Price'], lbs: rancher['Half lbs'], link: rancher['Half Payment Link'] },
    { key: 'whole', label: 'Whole Cow', price: rancher['Whole Price'], lbs: rancher['Whole lbs'], link: rancher['Whole Payment Link'] },
  ].filter(t => t.link && t.price);

  if (tiers.length === 0) return null;

  return (
    <div className="grid sm:grid-cols-3 gap-3">
      {tiers.map(t => (
        <a
          key={t.key}
          href={slug ? `/ranchers/${slug}/pay/${t.key}` : t.link}
          className="block p-4 border-2 border-charcoal bg-white hover:bg-charcoal hover:text-bone transition-colors text-center group"
        >
          <div className="text-xs uppercase tracking-wider text-saddle group-hover:text-bone">{t.label}</div>
          <div className="font-serif text-2xl mt-1">${Number(t.price).toLocaleString()}</div>
          {t.lbs && <div className="text-xs text-dust group-hover:text-bone mt-0.5">{t.lbs} lbs</div>}
          <div className="mt-2 text-xs font-medium uppercase tracking-wider">Buy Now →</div>
        </a>
      ))}
    </div>
  );
}

// The conversion hero — lives at the top of the member dashboard when the
// member has an active referral and a matched rancher. Shows name, logo,
// processing-date urgency, and direct-buy buttons.
function YourMatchHero({ rancher, status }: { rancher: Rancher; status: string }) {
  const processingDate = rancher['Next Processing Date'];
  const daysToProcessing = processingDate
    ? Math.ceil((new Date(processingDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    : null;
  const urgencyText =
    daysToProcessing !== null && daysToProcessing > 0 && daysToProcessing <= 21
      ? `Next processing in ${daysToProcessing} day${daysToProcessing === 1 ? '' : 's'} — reserve your share now`
      : processingDate
        ? `Next processing: ${new Date(processingDate).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}`
        : null;

  const hasPricing = rancher['Quarter Payment Link'] || rancher['Half Payment Link'] || rancher['Whole Payment Link'];

  return (
    <div className="p-6 md:p-8 border-2 border-charcoal bg-white space-y-5">
      <div className="flex flex-col sm:flex-row gap-5 items-start">
        {rancher['Logo URL'] && (
          <img
            src={rancher['Logo URL']}
            alt={rancher['Ranch Name']}
            className="w-20 h-20 object-cover border border-dust flex-shrink-0"
          />
        )}
        <div className="flex-1 min-w-0">
          <div className="text-xs uppercase tracking-wider text-saddle">Your Matched Rancher</div>
          <h2 className="font-serif text-2xl md:text-3xl mt-1">{rancher['Ranch Name']}</h2>
          {rancher.Tagline ? (
            <p className="text-saddle mt-1">{rancher.Tagline}</p>
          ) : rancher['Operator Name'] ? (
            <p className="text-saddle mt-1">Operated by {rancher['Operator Name']}</p>
          ) : null}
        </div>
        {rancher.Certified && (
          <span className="px-3 py-1 bg-charcoal text-bone text-xs font-medium uppercase tracking-wider flex-shrink-0">
            Certified
          </span>
        )}
      </div>

      {urgencyText && (
        <div className="p-3 bg-bone border-l-4 border-charcoal text-sm font-medium">
          {urgencyText}
        </div>
      )}

      {hasPricing ? (
        <>
          <BuyTierButtons rancher={rancher} />
          <div className="flex flex-wrap items-center gap-4 text-sm pt-2">
            {rancher.Slug && (
              <Link href={`/ranchers/${rancher.Slug}`} className="text-charcoal hover:text-saddle underline underline-offset-2">
                View full ranch page →
              </Link>
            )}
            <ContactRancherButton
              rancher={{
                id: rancher.id,
                ranch_name: rancher['Ranch Name'] || '',
                operator_name: rancher['Operator Name'] || '',
                email: rancher.Email || '',
                state: rancher.State || '',
              }}
            />
          </div>
        </>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-saddle">
            {status === 'Intro Sent'
              ? "We've made the introduction by email — your rancher will reach out with pricing and availability. Check your inbox."
              : "We're finalizing your introduction. Your rancher will reach out within 24-48 hours."}
          </p>
          <ContactRancherButton
            rancher={{
              id: rancher.id,
              ranch_name: rancher['Ranch Name'] || '',
              operator_name: rancher['Operator Name'] || '',
              email: rancher.Email || '',
              state: rancher.State || '',
            }}
          />
        </div>
      )}
    </div>
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
  const hasPricing = rancher['Quarter Payment Link'] || rancher['Half Payment Link'] || rancher['Whole Payment Link'];

  return (
    <div className="p-6 border border-dust bg-white space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          {rancher['Logo URL'] && (
            <img src={rancher['Logo URL']} alt={rancher['Ranch Name']} className="w-12 h-12 object-cover border border-dust flex-shrink-0" />
          )}
          <div className="min-w-0">
            <h3 className="font-serif text-xl">{rancher['Ranch Name']}</h3>
            <p className="text-sm text-saddle">Operator: {rancher['Operator Name']}</p>
            {rancher.Tagline && <p className="text-sm text-dust mt-1 italic">&ldquo;{rancher.Tagline}&rdquo;</p>}
          </div>
        </div>
        {rancher.Certified && (
          <span className="px-3 py-1 bg-charcoal text-bone text-xs font-medium uppercase tracking-wider flex-shrink-0">
            Certified
          </span>
        )}
      </div>
      <div className="grid md:grid-cols-2 gap-3 text-sm">
        <div><span className="text-saddle">Location:</span> {rancher.State}</div>
        <div><span className="text-saddle">Capacity:</span> {rancher['Monthly Capacity']} head/month</div>
        <div className="md:col-span-2"><span className="text-saddle">Beef Types:</span> {rancher['Beef Types']}</div>
        {rancher.Certifications && (
          <div className="md:col-span-2"><span className="text-saddle">Certifications:</span> {rancher.Certifications}</div>
        )}
      </div>
      {hasPricing && <BuyTierButtons rancher={rancher} />}
      <div className="flex flex-wrap items-center gap-4 pt-2">
        {rancher.Slug && (
          <Link href={`/ranchers/${rancher.Slug}`} className="text-sm text-charcoal hover:text-saddle underline underline-offset-2">
            View full ranch page →
          </Link>
        )}
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
