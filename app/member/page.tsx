'use client';

import { useState, useEffect } from 'react';
import Container from '../components/Container';
import Divider from '../components/Divider';
import MemberAuthGuard from '../components/MemberAuthGuard';
import ContactRancherButton from '../components/ContactRancherButton';
import Link from 'next/link';
import { trackEvent } from '@/lib/analytics';
import { normalizeImageUrl } from '@/lib/imageUrl';

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
  rancher_email?: string;
  rancher_phone?: string;
  rancher_slug?: string;
  order_type?: string;
  sale_amount?: number;
  closed_at?: string;
  created_at: string;
  // F16 — engagement loop expansion
  deposit_amount?: number;
  deposit_paid_at?: string;
  rancher_accepted_at?: string;
  final_invoice_url?: string;
  final_paid_at?: string;
  stripe_invoice_url?: string;
  fulfillment_confirmed_at?: string;
  processing_date?: string;
}

type Tab = 'dashboard' | 'ranchers' | 'land' | 'brands';

const statusLabels: Record<string, { label: string; style: string }> = {
  'Pending Approval': { label: 'Being Matched', style: 'bg-amber/20 text-amber-dark' },
  'Waitlisted': { label: 'Waitlisted — No Rancher Yet', style: 'bg-rust/10 text-rust-dark' },
  'Intro Sent': { label: 'Rancher Introduced', style: 'bg-charcoal/10 text-charcoal' },
  'In Progress': { label: 'In Progress', style: 'bg-charcoal/10 text-charcoal' },
  'Awaiting Payment': { label: 'Deposit Invoice Ready', style: 'bg-amber/20 text-amber-dark' },
  'Slot Locked': { label: 'Slot Locked', style: 'bg-sage/15 text-sage-dark' },
  'Closed Won': { label: 'Beef Delivered', style: 'bg-sage/15 text-sage-dark' },
  'Closed Lost': { label: 'Closed', style: 'bg-dust/20 text-saddle' },
  'Rejected': { label: 'No Match Available', style: 'bg-weathered/10 text-weathered' },
};

function MemberDashboard({ member }: { member: { id: string; name: string; email: string; state: string } }) {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const [upgradeForm, setUpgradeForm] = useState({ orderType: '', budgetRange: '' });
  const [upgrading, setUpgrading] = useState(false);
  const [upgradeSuccess, setUpgradeSuccess] = useState(false);
  // Detect ?warmup=engaged so we can show a celebratory banner. The buyer
  // just clicked YES on the re-engagement email and we routed them — they
  // need to know their click WORKED, not wonder if they're being asked to
  // sign up again.
  const [warmupCelebration, setWarmupCelebration] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('warmup') === 'engaged') {
      setWarmupCelebration(true);
      // Strip the param so a refresh doesn't re-trigger the banner
      const url = new URL(window.location.href);
      url.searchParams.delete('warmup');
      window.history.replaceState({}, '', url.toString());
    }
  }, []);
  const [data, setData] = useState<{
    memberState: string;
    memberSegment: string;
    affiliateCode?: string;
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
          {/* Warmup engagement celebration — shows when buyer just clicked YES
              on the re-engagement email. Confirms the click registered + tells
              them what happens next. Removes itself on history.replaceState. */}
          {warmupCelebration && (
            <div className="border-2 border-charcoal bg-bone p-6 space-y-2">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="font-serif text-2xl">🔥 You&apos;re in.</p>
                  <p className="text-saddle mt-2">
                    We just fired your intro to the rancher in {member.state}. They&apos;ll reach out via email or phone within 1–2 business days. Their contact info is below — feel free to reach out first if you&apos;d like.
                  </p>
                </div>
                <button
                  onClick={() => setWarmupCelebration(false)}
                  className="text-dust hover:text-charcoal text-sm"
                  aria-label="Dismiss"
                >
                  ✕
                </button>
              </div>
            </div>
          )}

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

          {/* Merch banner — drives traffic to Shopify /shop from highest-engagement surface */}
          <a
            href="https://buyhalfcow.com/shop"
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => trackEvent('shop_click', { surface: 'member' })}
            className="block my-6 border border-dust p-4 bg-bone hover:bg-divider transition flex items-center justify-between"
          >
            <div>
              <div className="font-serif text-lg text-charcoal">rep the rebuild</div>
              <p className="text-saddle text-sm mt-1">patches · hats · shirts</p>
            </div>
            <span className="text-charcoal font-semibold uppercase tracking-wider text-xs">shop →</span>
          </a>

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

              {/* Ready-to-buy signal — visible to ALL approved buyers, matched or not */}
              {data?.memberSegment === 'Beef Buyer' && (() => {
                const hasActive = !!data?.memberReferrals?.find(
                  r => r.status !== 'Closed Won' && r.status !== 'Closed Lost' && r.rancher_id
                );
                return <ReadyToBuyButton hasMatch={hasActive} />;
              })()}

              {/* Past Orders / Reorder — repeat customers are the highest-LTV
                  segment and the easiest to convert. Surfacing this as a
                  prominent dashboard section means buyers don't have to email
                  the rancher direct (which costs us the commission). */}
              {(() => {
                const closedWons = (data?.memberReferrals || []).filter(
                  r => r.status === 'Closed Won' && r.rancher_id
                );
                if (closedWons.length === 0) return null;
                const hasActiveMatch = !!data?.memberReferrals?.find(
                  r => r.status !== 'Closed Won' && r.status !== 'Closed Lost' && r.rancher_id
                );
                return (
                  <PastOrdersSection
                    orders={closedWons}
                    hasActiveOrder={hasActiveMatch}
                    rancherLookup={(id) => {
                      return (
                        data?.stateRanchers?.find(r => r.id === id) ||
                        data?.otherRanchers?.find(r => r.id === id) ||
                        null
                      );
                    }}
                  />
                );
              })()}

              <h2 className="font-serif text-2xl">Your Referral Status</h2>

              {data?.memberReferrals && data.memberReferrals.length > 0 ? (
                <div className="space-y-4">
                  {data.memberReferrals.map((ref) => {
                    const statusInfo = statusLabels[ref.status] || { label: ref.status, style: 'bg-dust/20 text-saddle' };
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
                          <div className="mt-3 space-y-2 text-sm text-saddle">
                            <p>Your rancher has been introduced. Reach out to them directly to discuss timing and pickup:</p>
                            {(ref.rancher_email || ref.rancher_phone) && (
                              <div className="bg-bone border border-dust p-4 mt-2 space-y-1">
                                <p className="font-semibold text-charcoal">{ref.rancher_name}</p>
                                {ref.rancher_email && (
                                  <p>
                                    <span className="text-dust">Email:</span>{' '}
                                    <a href={`mailto:${ref.rancher_email}`} className="text-charcoal underline">{ref.rancher_email}</a>
                                  </p>
                                )}
                                {ref.rancher_phone && (
                                  <p>
                                    <span className="text-dust">Phone:</span>{' '}
                                    <a href={`tel:${ref.rancher_phone}`} className="text-charcoal underline">{ref.rancher_phone}</a>
                                  </p>
                                )}
                                {ref.rancher_slug && (
                                  <p className="pt-1">
                                    <Link href={`/r/${ref.rancher_slug}`} className="text-charcoal underline text-xs uppercase tracking-wider">View their page →</Link>
                                  </p>
                                )}
                              </div>
                            )}
                          </div>
                        )}

                        {/* F16 — engagement branches: Awaiting Payment / Slot Locked / Closed Won */}
                        {ref.status === 'Awaiting Payment' && (
                          <div className="mt-3 space-y-3 text-sm text-saddle">
                            <p className="text-charcoal font-medium">
                              Your deposit invoice is ready. Lock your slot at {ref.rancher_name}:
                            </p>
                            {ref.stripe_invoice_url ? (
                              <a
                                href={ref.stripe_invoice_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-block px-5 py-2 bg-charcoal text-bone hover:bg-saddle text-xs uppercase tracking-widest font-semibold"
                              >
                                Pay deposit → {ref.deposit_amount ? `$${ref.deposit_amount}` : ''}
                              </a>
                            ) : (
                              <p className="text-xs text-dust">Check your email for the Stripe link.</p>
                            )}
                            <p className="text-xs text-dust">
                              Once paid, your rancher confirms the slot. Deposit becomes non-refundable at that point.
                            </p>
                          </div>
                        )}

                        {ref.status === 'Slot Locked' && (
                          <div className="mt-3 space-y-2 text-sm text-saddle">
                            <p className="text-charcoal font-medium">
                              🔒 Slot locked at {ref.rancher_name}.
                            </p>
                            {ref.processing_date ? (
                              <p>
                                <span className="text-dust">Processing date:</span>{' '}
                                <strong className="text-charcoal">
                                  {new Date(ref.processing_date).toLocaleDateString()}
                                </strong>
                              </p>
                            ) : (
                              <p>Your rancher will confirm the processing date soon.</p>
                            )}
                            {ref.rancher_accepted_at && (
                              <p className="text-xs text-dust">
                                Rancher accepted {new Date(ref.rancher_accepted_at).toLocaleDateString()}.
                                Per BHC promise, your deposit is now locked toward this slot.
                              </p>
                            )}
                            {ref.final_invoice_url && !ref.final_paid_at && (
                              <p className="pt-2">
                                <a
                                  href={ref.final_invoice_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-block px-5 py-2 bg-charcoal text-bone hover:bg-saddle text-xs uppercase tracking-widest font-semibold"
                                >
                                  Pay final invoice →
                                </a>
                              </p>
                            )}
                          </div>
                        )}

                        {ref.status === 'Closed Won' && (
                          <div className="mt-3 space-y-3 text-sm">
                            <p className="text-charcoal font-medium">
                              ✓ Your beef has been delivered.
                            </p>
                            {ref.sale_amount ? (
                              <p className="text-saddle text-xs">
                                Final amount: <strong>${ref.sale_amount.toLocaleString()}</strong>
                              </p>
                            ) : null}
                            <div className="flex flex-wrap gap-2 pt-1">
                              <Link
                                href="/access"
                                className="inline-block px-4 py-2 border border-charcoal bg-charcoal text-bone hover:bg-saddle text-xs uppercase tracking-widest font-semibold"
                              >
                                Re-order →
                              </Link>
                              {ref.rancher_slug && (
                                <Link
                                  href={`/r/${ref.rancher_slug}#review`}
                                  className="inline-block px-4 py-2 border border-charcoal text-charcoal hover:bg-bone-warm text-xs uppercase tracking-widest font-semibold"
                                >
                                  Leave a review →
                                </Link>
                              )}
                            </div>
                          </div>
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

              {/* F17 — Affiliate code surface for Closed Won buyers (auto-enrolled per I-9) */}
              {data?.affiliateCode && (
                <div className="p-6 border-2 border-charcoal bg-bone-warm space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="text-xs uppercase tracking-widest text-saddle">Refer a friend, earn $</span>
                  </div>
                  <h3 className="font-serif text-xl text-charcoal">Your affiliate link</h3>
                  <p className="text-sm text-saddle leading-relaxed">
                    Share this link. When a friend completes a quarter/half/whole, you earn a commission. Track all of it on your affiliate dashboard.
                  </p>
                  <div className="bg-white border border-dust p-3 font-mono text-xs text-charcoal break-all select-all">
                    https://www.buyhalfcow.com/?ref={data.affiliateCode}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <a
                      href="/affiliate"
                      className="inline-block px-5 py-2 bg-charcoal text-bone hover:bg-saddle text-xs uppercase tracking-widest font-semibold"
                    >
                      Open affiliate dashboard →
                    </a>
                    <button
                      type="button"
                      onClick={() => navigator.clipboard?.writeText(`https://www.buyhalfcow.com/?ref=${data.affiliateCode}`)}
                      className="inline-block px-5 py-2 border border-charcoal text-charcoal hover:bg-bone text-xs uppercase tracking-widest font-semibold"
                    >
                      Copy link
                    </button>
                  </div>
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
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-saddle mb-1 uppercase tracking-wider">Budget</label>
                      <select
                        value={upgradeForm.budgetRange}
                        onChange={(e) => setUpgradeForm(prev => ({ ...prev, budgetRange: e.target.value }))}
                        className="w-full px-3 py-2 border border-dust bg-bone text-sm"
                      >
                        {/* Brackets mirror /access intentionally — old brackets
                            (<$500, $500-1000, etc) were below any real rancher's
                            price and produced unmatchable leads. */}
                        <option value="">Select...</option>
                        <option value="$1,000-$1,500">$1,000 - $1,500</option>
                        <option value="$2,000-$2,500">$2,000 - $2,500</option>
                        <option value="$4,000-$5,000">$4,000 - $5,000</option>
                        <option value="$5,000+">$5,000+</option>
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
                <div className="p-6 border-2 border-sage-dark bg-sage/10 text-center">
                  <p className="font-serif text-xl text-sage-dark">You&apos;re on the list!</p>
                  <p className="text-sm text-sage-dark mt-2">We&apos;re matching you with a rancher in {data?.memberState || 'your area'}. You&apos;ll hear from us soon.</p>
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

// Past orders + reorder card. Repeat customers are the easiest revenue capture
// in the platform — without this, a happy buyer goes direct to the rancher on
// their next order and we collect $0. This routes the reorder back through the
// platform via the matching engine's direct-page-lead code path.
function PastOrdersSection({
  orders,
  hasActiveOrder,
  rancherLookup,
}: {
  orders: MemberReferral[];
  hasActiveOrder: boolean;
  rancherLookup: (id: string) => Rancher | null;
}) {
  const [reordering, setReordering] = useState<string | null>(null);
  const [resultByOrderId, setResultByOrderId] = useState<Record<string, { ok: boolean; message: string }>>({});

  const handleReorder = async (order: MemberReferral) => {
    if (!order.rancher_id) return;
    setReordering(order.id);
    try {
      const res = await fetch('/api/member/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ previousReferralId: order.id, rancherId: order.rancher_id }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setResultByOrderId(prev => ({
          ...prev,
          [order.id]: {
            ok: true,
            message: `Reorder request sent to ${data.rancherName}. Watch your inbox for a re-introduction.`,
          },
        }));
      } else {
        setResultByOrderId(prev => ({
          ...prev,
          [order.id]: {
            ok: false,
            message: data.error || 'Reorder failed. Try again or email hello@buyhalfcow.com.',
          },
        }));
      }
    } catch {
      setResultByOrderId(prev => ({
        ...prev,
        [order.id]: { ok: false, message: 'Network error. Try again.' },
      }));
    } finally {
      setReordering(null);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-serif text-2xl">Past Orders</h2>
        <p className="text-sm text-saddle mt-1">
          Reorder from a rancher you&apos;ve worked with before. We&apos;ll re-introduce you and they&apos;ll prioritize repeat customers.
        </p>
      </div>
      <div className="space-y-3">
        {orders.map((order) => {
          const rancher = order.rancher_id ? rancherLookup(order.rancher_id) : null;
          const result = resultByOrderId[order.id];
          const closedDate = order.closed_at ? new Date(order.closed_at).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : '';
          return (
            <div key={order.id} className="p-5 border border-dust bg-white space-y-3">
              <div className="flex flex-col sm:flex-row gap-4 sm:items-center justify-between">
                <div className="flex items-center gap-3 min-w-0">
                  {rancher?.['Logo URL'] && (
                    <img
                      src={normalizeImageUrl(rancher['Logo URL'] || '')}
                      alt={rancher['Ranch Name']}
                      loading="lazy"
                      className="w-12 h-12 object-cover border border-dust flex-shrink-0"
                    />
                  )}
                  <div className="min-w-0">
                    <p className="font-serif text-lg truncate">
                      {rancher?.['Ranch Name'] || order.rancher_name || 'Past rancher'}
                    </p>
                    <p className="text-xs text-dust">
                      {[order.order_type, closedDate, order.sale_amount ? `$${Number(order.sale_amount).toLocaleString()}` : null]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => handleReorder(order)}
                  disabled={reordering === order.id || hasActiveOrder || !rancher}
                  className="px-4 py-2 text-sm bg-charcoal text-bone hover:bg-saddle transition-colors disabled:opacity-50 disabled:cursor-not-allowed uppercase tracking-wider font-medium flex-shrink-0"
                  title={hasActiveOrder ? "You already have an active order in progress" : !rancher ? "This rancher's profile isn't currently available" : ''}
                >
                  {reordering === order.id ? 'Sending...' : hasActiveOrder ? 'Order in progress' : 'Reorder'}
                </button>
              </div>
              {result && (
                <div className={`p-3 text-sm ${result.ok ? 'border border-sage-dark bg-sage/10 text-sage-dark' : 'border border-weathered text-weathered'}`}>
                  {result.message}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Single-click "I'm ready to buy this month" signal. Pings Telegram + emails
// the matched rancher. This is the highest-intent signal the buyer can send.
function ReadyToBuyButton({ hasMatch }: { hasMatch: boolean }) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [matchName, setMatchName] = useState<string | null>(null);

  const handleClick = async () => {
    setState('sending');
    try {
      const res = await fetch('/api/member/ready-to-buy', { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.success) {
        setMatchName(data.rancherName || null);
        setState('sent');
      } else {
        setState('error');
      }
    } catch {
      setState('error');
    }
  };

  if (state === 'sent') {
    return (
      <div className="p-5 border-2 border-sage-dark bg-sage/10 text-center space-y-1">
        <p className="font-serif text-xl text-sage-dark">We're on it.</p>
        <p className="text-sm text-sage-dark">
          {matchName
            ? `${matchName} has been notified you're ready. Expect to hear from them within 24-48 hours.`
            : "Benjamin got the signal and will reach out personally this week."}
        </p>
      </div>
    );
  }

  return (
    <div className="p-5 border-2 border-charcoal bg-bone text-center space-y-3">
      <div>
        <p className="font-serif text-xl">Ready to buy this month?</p>
        <p className="text-sm text-saddle mt-1">
          {hasMatch
            ? "Tap below to tell your rancher — they'll prioritize your order."
            : "One tap and Benjamin will call you personally to match you fast."}
        </p>
      </div>
      <button
        onClick={handleClick}
        disabled={state === 'sending'}
        className="w-full px-6 py-4 bg-charcoal text-bone hover:bg-saddle transition-colors font-semibold uppercase tracking-wider text-sm disabled:opacity-50"
      >
        {state === 'sending' ? 'Sending signal...' : "I'm Ready to Buy This Month"}
      </button>
      {state === 'error' && (
        <p className="text-xs text-weathered">Couldn't send — try again in a moment or email hello@buyhalfcow.com.</p>
      )}
    </div>
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
            src={normalizeImageUrl(rancher['Logo URL'] || '')}
            alt={rancher['Ranch Name']}
            loading="lazy"
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
            <img src={normalizeImageUrl(rancher['Logo URL'] || '')} alt={rancher['Ranch Name']} loading="lazy" className="w-12 h-12 object-cover border border-dust flex-shrink-0" />
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
