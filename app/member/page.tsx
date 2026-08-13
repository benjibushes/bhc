'use client';

import { useState, useEffect } from 'react';
import Container from '../components/Container';
import Divider from '../components/Divider';
import MemberAuthGuard from '../components/MemberAuthGuard';
import ContactRancherButton from '../components/ContactRancherButton';
import GearBlock from '../components/GearBlock';
import { cutForBuyer } from '@/lib/demandRouter';
import Link from 'next/link';
import { trackEvent } from '@/lib/analytics';
import { normalizeImageUrl } from '@/lib/imageUrl';
import { isRancherOnConnect } from '@/lib/rancherEligibility';
import { carrierTrackingUrl } from '@/lib/trackingLink';
import {
  buildBuyerDealLadder,
  formatMoney,
  handoffWord,
  nextStepGuidance,
  resolveHandoffMode,
  shouldShowDealLadder,
  type BuyerDealFields,
  type BuyerDealStep,
} from '@/lib/buyerDealStage';
import { FULFILLMENT_STATUS_LABELS, isFulfillmentStatus } from '@/lib/fulfillmentTracking';
import CallbackRequest from '../components/CallbackRequest';
import { isPaidLiveDeal, resolveMemberCallbackReason } from '@/lib/callbackRail';

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
  // Used to decide Connect-deposit vs legacy Payment-Link routing.
  'Pricing Model'?: string;
  'Stripe Connect Status'?: string;
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
  ranch_name?: string;
  order_type?: string;
  sale_amount?: number;
  closed_at?: string;
  created_at: string;
  // F16 — engagement loop expansion
  deposit_amount?: number;
  deposit_paid_at?: string;
  deposit_requested_at?: string;
  rancher_accepted_at?: string;
  final_invoice_url?: string;
  final_paid_at?: string;
  stripe_invoice_url?: string;
  fulfillment_confirmed_at?: string;
  processing_date?: string;
  // D3 — shipment surface (rancher-typed fulfillment tracker fields)
  fulfillment_status?: string;
  fulfillment_method?: string;
  shipping_carrier?: string;
  tracking_number?: string;
  fulfillment_updated_at?: string;
  // WAVE 3 — the facts the buyer paid for and could not see
  handoff_date?: string;
  final_invoice_amount?: number;
  final_invoice_sent_at?: string;
  total_sale_amount?: number;
  buyer_cut_notes?: string;
  buyer_window_pref?: string;
  buyer_fulfillment_pref?: string;
  buyer_preferences_set_at?: string;
  rancher_pickup_address?: string;
  rancher_pickup_instructions?: string;
}

// WAVE 2 buyer UI (2026-08-01) — a shop/broker order from Rancher Orders
// (written by lib/productSettlement). Worded server-side by the SAME view
// model as /order/<token> so the dashboard and the emailed status page can
// never disagree. status_path is the signed read-only /order/<token> link
// ('' when it couldn't be minted — render no link, never a broken one).
interface ShopOrder {
  id: string;
  product_name: string;
  quantity: number;
  buyer_paid: number;
  kind: 'ship' | 'pickup' | 'deposit';
  state: 'new' | 'shipped' | 'delivered' | 'refunded' | 'cancelled';
  status_label: string;
  status_detail: string;
  ordered_at: string;
  shipped_at: string;
  tracking_number: string;
  tracking_url: string | null;
  carrier: string;
  rancher_name: string;
  status_path: string;
}

// WAVE 3 — one adapter, so every consumer of the stage model reads the SAME
// referral shape. Airtable field names stay in the route; camelCase stays in
// lib/buyerDealStage; this is the only bridge.
function toDealFields(ref: MemberReferral): BuyerDealFields {
  return {
    status: ref.status,
    depositPaidAt: ref.deposit_paid_at,
    depositRequestedAt: ref.deposit_requested_at,
    depositAmount: ref.deposit_amount,
    rancherAcceptedAt: ref.rancher_accepted_at,
    handoffDate: ref.handoff_date,
    processingDate: ref.processing_date,
    fulfillmentStatus: ref.fulfillment_status,
    fulfillmentMethod: ref.fulfillment_method,
    buyerFulfillmentPref: ref.buyer_fulfillment_pref,
    finalInvoiceSentAt: ref.final_invoice_sent_at,
    finalInvoiceAmount: ref.final_invoice_amount,
    finalPaidAt: ref.final_paid_at,
    fulfillmentConfirmedAt: ref.fulfillment_confirmed_at,
    rancherName: ref.rancher_name,
  };
}

/**
 * A deal that is live and already has the buyer's money in it.
 *
 * Delegates to lib/callbackRail so "has this buyer actually paid" has ONE
 * definition — the same one that decides whether they have earned a phone call.
 * Two copies of this rule drifting apart is how a paying customer ends up
 * being asked "ready to buy?" above their own paid order.
 */
function isPaidActiveDeal(ref: MemberReferral): boolean {
  return isPaidLiveDeal({ status: ref.status, depositPaidAt: ref.deposit_paid_at });
}

function formatDate(value?: string): string {
  if (!value) return '';
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  // Date-only Airtable values ('2026-08-14') parse as UTC midnight — render
  // them in UTC so a US-evening viewer isn't shown the day before.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(value).trim());
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    ...(dateOnly ? { timeZone: 'UTC' } : {}),
  });
}

type Tab = 'dashboard' | 'ranchers' | 'brands';

const statusLabels: Record<string, { label: string; style: string }> = {
  // Buyer-facing labels — plain language, not CRM jargon. A buyer never
  // "referred" anyone; these describe THEIR order.
  // WAVE 3 honesty pass: 'Pending Approval' and 'Rejected' both used to render
  // as "finding your rancher" — an open-ended promise on a request that may
  // never move, and a flat lie on one we already declined.
  'Pending Approval': { label: 'awaiting review', style: 'bg-amber/20 text-amber-dark' },
  'Waitlisted': { label: 'finding a rancher near you', style: 'bg-rust/10 text-rust-dark' },
  'Intro Sent': { label: 'meet your rancher', style: 'bg-charcoal/10 text-charcoal' },
  'In Progress': { label: 'in progress', style: 'bg-charcoal/10 text-charcoal' },
  'Awaiting Payment': { label: 'ready to reserve', style: 'bg-amber/20 text-amber-dark' },
  'Slot Locked': { label: 'reserved', style: 'bg-sage/15 text-sage-dark' },
  'Closed Won': { label: 'beef delivered', style: 'bg-sage/15 text-sage-dark' },
  'Closed Lost': { label: 'closed', style: 'bg-dust/20 text-saddle' },
  'Rejected': { label: 'not matched', style: 'bg-weathered/10 text-weathered' },
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
  // Detect ?invoice=paid|canceled — the Stripe final-invoice success/cancel
  // URLs (send-final-invoice + /r/f durable links) land HERE after the LARGEST
  // payment of the relationship. Until 2026-07-29 these params were dead: the
  // buyer who just wired ~$2k saw a generic dashboard with zero acknowledgment.
  // paid → prominent success banner; canceled → gentle "balance still open".
  const [invoiceOutcome, setInvoiceOutcome] = useState<'paid' | 'canceled' | null>(null);
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
    const invoice = params.get('invoice');
    if (invoice === 'paid' || invoice === 'canceled') {
      setInvoiceOutcome(invoice);
      // Strip the param so a refresh doesn't re-trigger the banner
      const url = new URL(window.location.href);
      url.searchParams.delete('invoice');
      window.history.replaceState({}, '', url.toString());
    }
  }, []);
  const [data, setData] = useState<{
    memberState: string;
    memberSegment: string;
    affiliateCode?: string;
    // '' (never asked) | 'nationwide-ok' | 'local-only' — drives the
    // Matching Preference toggle below.
    nationwidePreference?: string;
    hasOrderDetails: boolean;
    stateRanchers: Rancher[];
    otherRanchers: Rancher[];
    brands: Brand[];
    memberReferrals: MemberReferral[];
    shopOrders?: ShopOrder[];
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
            <button onClick={fetchContent} className="px-6 py-3 bg-charcoal text-bone hover:bg-charcoal/80 transition-colors uppercase tracking-wider text-sm font-semibold">
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
                  <p className="font-serif text-2xl">You&apos;re in.</p>
                  <p className="text-saddle mt-2">
                    We just fired your intro to the rancher in {member.state}. They&apos;ll reach out via email or phone within 1–2 business days. Their contact info is below — feel free to reach out first if you&apos;d like.
                  </p>
                </div>
                <button
                  onClick={() => setWarmupCelebration(false)}
                  className="text-muted hover:text-charcoal text-sm"
                  aria-label="Dismiss"
                >
                  ✕
                </button>
              </div>
            </div>
          )}

          {/* Final-invoice outcome — the buyer just came back from the Stripe
              checkout for their balance (the largest payment they'll make).
              paid: confirm it landed + set the next expectation. canceled:
              honest note that nothing was charged and the balance stays open.
              Mirrors the warmup banner pattern above (strip-param + dismiss). */}
          {invoiceOutcome === 'paid' && (
            <div className="border-2 border-sage-dark bg-bone p-6 space-y-2">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="font-serif text-2xl">Final payment received — you&apos;re all set.</p>
                  <p className="text-saddle mt-2">
                    Your balance is paid in full and your beef is officially yours. Your rancher will coordinate delivery or pickup with you directly — watch your email (and your order status below) for the details.
                  </p>
                </div>
                <button
                  onClick={() => setInvoiceOutcome(null)}
                  className="text-muted hover:text-charcoal text-sm"
                  aria-label="Dismiss"
                >
                  ✕
                </button>
              </div>
            </div>
          )}
          {invoiceOutcome === 'canceled' && (
            <div className="border border-dust bg-bone p-6 space-y-2">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="font-serif text-xl">Payment canceled — nothing was charged.</p>
                  <p className="text-saddle mt-2">
                    Your balance is still open. The payment link in your email keeps working whenever you&apos;re ready — or just reply to it if something looks off and we&apos;ll sort it out.
                  </p>
                </div>
                <button
                  onClick={() => setInvoiceOutcome(null)}
                  className="text-muted hover:text-charcoal text-sm"
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
                {member.state} Member · Signed in as {member.email}
              </p>
            </div>
            <button
              onClick={handleLogout}
              className="text-sm text-muted hover:text-charcoal transition-colors"
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
                  <YourMatchHero rancher={matchedRancher} status={activeRef.status} consumerId={member.id} />
                );
              })()}

              {/* Ready-to-buy signal — visible to approved buyers who have NOT
                  already put money down. WAVE 3: it used to render for
                  everyone, so a buyer whose deposit had cleared was still being
                  asked "ready to buy this month?" above their own paid order. */}
              {data?.memberSegment === 'Beef Buyer' &&
                !(data?.memberReferrals || []).some(isPaidActiveDeal) && (() => {
                const hasActive = !!data?.memberReferrals?.find(
                  r => r.status !== 'Closed Won' && r.status !== 'Closed Lost' && r.rancher_id
                );
                return <ReadyToBuyButton hasMatch={hasActive} memberEmail={member.email} />;
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
                    memberEmail={member.email}
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

              <h2 className="font-serif text-2xl">Your order</h2>

              {data?.memberReferrals && data.memberReferrals.length > 0 && (
                <div className="space-y-4">
                  {data.memberReferrals.map((ref) => {
                    // BLOCKER-1 (2026-07-01): Status='Awaiting Payment' +
                    // Deposit Paid At set is THE post-payment state —
                    // settlement stamps Deposit Paid At and keeps the status
                    // until the rancher accepts (→ Slot Locked). The badge
                    // must not say "ready to reserve" to a buyer who paid.
                    //
                    // WAVE 3 narrowing: 'Awaiting Payment' is written a THIRD
                    // time — send-final-invoice flips the status back to it
                    // when the rancher bills the balance. The old flag caught
                    // that row too, so a buyer holding an unpaid final invoice
                    // was told "waiting for your rancher to accept your slot"
                    // (they already had) with no way to pay. Both later stamps
                    // now disqualify the accept-wait branch.
                    const depositPaidAwaitingAccept =
                      ref.status === 'Awaiting Payment' &&
                      !!ref.deposit_paid_at &&
                      !ref.rancher_accepted_at &&
                      !ref.final_invoice_sent_at;
                    const statusInfo = depositPaidAwaitingAccept
                      ? { label: 'deposit paid', style: 'bg-sage/15 text-sage-dark' }
                      : statusLabels[ref.status] || { label: ref.status, style: 'bg-dust/20 text-saddle' };
                    const dealFields = toDealFields(ref);
                    const showLadder = shouldShowDealLadder(dealFields);
                    const handoffMode = resolveHandoffMode({
                      method: ref.fulfillment_method,
                      buyerPref: ref.buyer_fulfillment_pref,
                    });
                    // The final balance is owed the moment the rancher sends
                    // the invoice — independent of which status the row is
                    // parked in.
                    const balanceDue = !!ref.final_invoice_url && !ref.final_paid_at && !!ref.deposit_paid_at;
                    // Rancher-typed tracker status, worded by the SHARED label
                    // map (lib/fulfillmentTracking) so buyer and rancher read
                    // the same word for the same state.
                    const fulfillmentLabel = isFulfillmentStatus(ref.fulfillment_status)
                      ? FULFILLMENT_STATUS_LABELS[ref.fulfillment_status]
                      : '';
                    return (
                      <div key={ref.id} className="p-6 border border-dust bg-white">
                        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                          <div>
                            <span className={`inline-block px-3 py-1 text-xs font-medium uppercase tracking-wider ${statusInfo.style}`}>
                              {statusInfo.label}
                            </span>
                            {ref.rancher_name && (
                              <p className="mt-2 text-sm text-saddle">
                                {ref.order_type ? `${ref.order_type} · ` : ''}
                                Matched with: <strong className="text-charcoal">{ref.rancher_name}</strong>
                              </p>
                            )}
                          </div>
                          <p className="text-xs text-muted">
                            {ref.created_at ? new Date(ref.created_at).toLocaleDateString() : ''}
                          </p>
                        </div>

                        {/* WAVE 3 FIX 1 — the deal ladder. Six ordered steps at
                            the TOP of the card, replacing the disjoint
                            status-prose paragraphs that used to be scattered
                            below it. The honest wording of each of those
                            paragraphs now lives as the current step's detail
                            (lib/buyerDealStage), so it stays accurate as the
                            deal moves instead of being frozen per-status. */}
                        {showLadder && <DealStepper ladder={buildBuyerDealLadder(dealFields)} />}

                        {/* WAVE 3 FIX 2 — the money. Paid X, balance Y, total Z. */}
                        {showLadder && <OrderMoneySummary deal={ref} />}

                        {/* WAVE 3 FIX 2 — the date, and (for a pickup) WHERE. */}
                        {showLadder && <HandoffBlock deal={ref} mode={handoffMode} />}

                        {ref.status === 'Pending Approval' && (
                          <p className="mt-3 text-sm text-saddle">
                            We&apos;re reviewing your request and looking for a rancher who can take it.
                            If you haven&apos;t heard from us in a few days, that means something stalled on our
                            end, not yours — reach out and we&apos;ll tell you exactly where it sits.
                          </p>
                        )}
                        {ref.status === 'Rejected' && (
                          <p className="mt-3 text-sm text-saddle">
                            We couldn&apos;t match this request to a rancher, and nothing was charged.
                            That is usually about coverage or timing rather than anything you did — ask us
                            and we&apos;ll tell you why, and what your options are.
                          </p>
                        )}
                        {ref.status === 'Waitlisted' && (
                          <p className="mt-3 text-sm text-saddle">
                            We don&apos;t have a certified rancher in your area yet, but we&apos;re actively onboarding. You&apos;ll be first to know when one goes live.
                          </p>
                        )}
                        {ref.status === 'Intro Sent' && (
                          <p className="mt-3 text-sm text-saddle">
                            Your rancher has been introduced. Reach out to them directly to discuss timing and pickup.
                          </p>
                        )}

                        {/* F16 — engagement branches: Awaiting Payment / Slot Locked / Closed Won */}

                        {/* WAVE 3: the old "✓ Deposit paid — waiting for X to
                            accept your slot / you'll get an email the moment it
                            locks" paragraph is not deleted, it MOVED. It is now
                            the `accepted` step's current-state detail in
                            lib/buyerDealStage, where it renders in position on
                            the ladder instead of floating under it. */}

                        {ref.status === 'Awaiting Payment' && !ref.deposit_paid_at && (
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
                              <p className="text-xs text-muted">Check your email for the Stripe link.</p>
                            )}
                            <p className="text-xs text-muted">
                              Once paid, your rancher confirms the slot. Deposit becomes non-refundable at that point.
                            </p>
                          </div>
                        )}

                        {/* Slot Locked: the ladder now carries the accept date
                            and the processing date. All that is left here is
                            the promise the buyer actually bought. */}
                        {ref.status === 'Slot Locked' && ref.rancher_accepted_at && (
                          <p className="mt-3 text-xs text-muted">
                            {ref.rancher_name || 'Your rancher'} accepted on {formatDate(ref.rancher_accepted_at)}.
                            Per the BHC promise, your deposit is now locked toward this slot.
                          </p>
                        )}

                        {/* WAVE 3 FIX 2 — the final-balance CTA, hoisted out of
                            the Slot Locked branch and priced.
                            THE BUG IT FIXES: send-final-invoice flips Status to
                            'Awaiting Payment' when it bills the balance, so the
                            `status === 'Slot Locked'` gate this button used to
                            sit behind was FALSE for every buyer who actually
                            had an invoice. The one payment the buyer most needs
                            to make was structurally unreachable from their own
                            dashboard. It now gates on the invoice itself. */}
                        {balanceDue && (
                          <div className="mt-4 border-2 border-charcoal bg-bone p-4 space-y-3">
                            <p className="text-sm text-charcoal font-medium">
                              {ref.final_invoice_amount
                                ? `Your final balance of ${formatMoney(ref.final_invoice_amount)} is due.`
                                : 'Your final balance is due.'}
                            </p>
                            <a
                              href={ref.final_invoice_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-block px-5 py-3 bg-charcoal text-bone hover:bg-saddle text-xs uppercase tracking-widest font-semibold"
                            >
                              Pay final balance
                              {ref.final_invoice_amount ? ` · ${formatMoney(ref.final_invoice_amount)}` : ''} →
                            </a>
                            <p className="text-xs text-muted">
                              Every cent of the balance goes to {ref.rancher_name || 'your rancher'}.
                              {' '}
                              <Link
                                href={`/support?email=${encodeURIComponent(member.email)}&ref=${encodeURIComponent(ref.id)}`}
                                className="underline hover:text-charcoal"
                              >
                                Something look wrong?
                              </Link>
                            </p>
                          </div>
                        )}

                        {ref.status === 'Closed Won' && (
                          <div className="mt-3 space-y-3 text-sm">
                            <p className="text-charcoal font-medium">
                              ✓ Your beef has been delivered.
                            </p>
                            {/* The dollar figure moved into the money summary
                                above, where it sits next to the deposit and the
                                balance instead of alone at the bottom. */}
                            <div className="flex flex-wrap gap-2 pt-1">
                              <Link
                                href="/access"
                                className="inline-block px-4 py-2 border border-charcoal bg-charcoal text-bone hover:bg-saddle text-xs uppercase tracking-widest font-semibold"
                              >
                                Re-order →
                              </Link>
                              {ref.rancher_slug && (
                                <Link
                                  href={`/ranchers/${ref.rancher_slug}#reviews`}
                                  className="inline-block px-4 py-2 border border-charcoal text-charcoal hover:bg-bone-warm text-xs uppercase tracking-widest font-semibold"
                                >
                                  Leave a review →
                                </Link>
                              )}
                            </div>
                          </div>
                        )}

                        {/* WAVE 3 FIX 3 — the rancher's fulfillment status,
                            UNGATED from the tracking number.
                            THE BUG IT FIXES: the whole scheduled → processing →
                            ready → fulfilled ladder used to live INSIDE the
                            `ref.tracking_number` branch below. A pickup buyer
                            never has a tracking number, so the single most
                            important word in their entire flow — "ready for
                            pickup" — was unreachable by construction. The
                            shipment card below stays gated on a tracking
                            number, which is the only thing it is actually
                            about. */}
                        {fulfillmentLabel && (
                          <div className="mt-4 bg-bone border border-dust p-4 space-y-1 text-sm text-saddle">
                            <p className="text-xs uppercase tracking-widest text-saddle">Fulfillment</p>
                            <p className="text-charcoal font-medium">{fulfillmentLabel}</p>
                            {ref.fulfillment_updated_at && (
                              <p className="text-xs text-muted">
                                Updated {formatDate(ref.fulfillment_updated_at)} by {ref.rancher_name || 'your rancher'}.
                              </p>
                            )}
                          </div>
                        )}

                        {/* D3 — shipment surface. The rancher types carrier +
                            tracking into the fulfillment tracker; this is where
                            the buyer finally SEES it. Gated hard on a tracking
                            number existing — no empty shell, no "tracking
                            pending" placeholder. Renders for any status
                            (including Closed Won: the delivered line replaces
                            the shipped line, and the number stays useful for
                            reference). */}
                        {ref.tracking_number ? (() => {
                          const trackUrl = carrierTrackingUrl(ref.shipping_carrier || '', ref.tracking_number);
                          const delivered = ref.fulfillment_status === 'fulfilled' || !!ref.fulfillment_confirmed_at;
                          const statusDate = delivered
                            ? (ref.fulfillment_confirmed_at || ref.fulfillment_updated_at)
                            : ref.fulfillment_updated_at;
                          const statusLine = `${delivered ? 'Delivered' : 'Shipped'}${statusDate ? ` ${new Date(statusDate).toLocaleDateString()}` : ''}`;
                          return (
                            <div className="mt-4 bg-bone border border-dust p-4 space-y-2 text-sm text-saddle">
                              <p className="text-xs uppercase tracking-widest text-saddle">Shipment</p>
                              {ref.shipping_carrier && (
                                <p>
                                  <span className="text-muted">Carrier:</span>{' '}
                                  <strong className="text-charcoal">{ref.shipping_carrier}</strong>
                                </p>
                              )}
                              <p>
                                <span className="text-muted">Tracking #:</span>{' '}
                                <span className="font-mono text-xs text-charcoal select-all break-all">{ref.tracking_number}</span>
                              </p>
                              <p className="text-xs text-muted">{statusLine}</p>
                              {trackUrl && (
                                <p className="pt-1">
                                  <a
                                    href={trackUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-block px-4 py-2 border border-charcoal text-charcoal hover:bg-bone-warm text-xs uppercase tracking-widest font-semibold"
                                  >
                                    Track shipment →
                                  </a>
                                </p>
                              )}
                            </div>
                          );
                        })() : null}

                        {/* Pending-deposit resume — the durable way back into
                            checkout. A buyer who bounced off
                            /checkout/<refId>/deposit (closed the tab, session
                            expired) previously had NO path back from the
                            dashboard. Gating mirrors POST /api/checkout/deposit
                            exactly: it 409s on Deposit Paid At, Awaiting
                            Payment (legacy invoice rail — has its own Pay CTA
                            above), Slot Locked, Closed Won/Lost, or a missing
                            rancher — so the CTA renders only for the allowlist
                            of statuses that rail accepts, with a rancher
                            linked and no paid marker. */}
                        {ref.rancher_id &&
                          !ref.deposit_paid_at &&
                          ['Pending Approval', 'Intro Sent', 'Waitlisted'].includes(ref.status) && (
                          <p className="mt-4">
                            <Link
                              href={`/checkout/${ref.id}/deposit`}
                              className="inline-block px-5 py-2 bg-charcoal text-bone hover:bg-saddle text-xs uppercase tracking-widest font-semibold"
                            >
                              Finish reserving your share →
                            </Link>
                          </p>
                        )}

                        {/* WAVE 3 FIX 5 — the buyer's own cut sheet, readable
                            at last. They fill it in once at
                            /checkout/<refId>/preferences and, until now, never
                            saw it again — write-only from their point of view,
                            with no link back to change it. */}
                        {showLadder && <CutSheetSummary deal={ref} />}

                        {/* WAVE 3 FIX 4 — rancher contact in EVERY active
                            post-deposit state. These lines used to render only
                            inside the `Intro Sent` branch, so the rancher's
                            email and phone vanished from the buyer's screen the
                            instant they paid. That is exactly backwards: the
                            money is down, the questions start now.
                            E5 — the thread link at /checkout/<refId>/ask rides
                            in the same block. The member session is accepted by
                            both thread APIs (ownership-checked against the
                            referral's Buyer link), so the dashboard is the
                            durable way back into the conversation; the thread
                            API 409s with no rancher linked, hence the gate. */}
                        {ref.rancher_id &&
                          !['Closed Lost', 'Refunded', 'Rejected'].includes(ref.status) && (
                          <RancherContactBlock deal={ref} />
                        )}

                        {/* WAVE 3 FIX 6 — "what happens next", keyed off the
                            CURRENT step. The honest Today / This week / When
                            ready block on the deposit-success page is the best
                            artifact in the flow and a buyer sees it exactly
                            once. This is the same block, except it moves with
                            the deal instead of freezing at day one. */}
                        {showLadder && (
                          <WhatHappensNext
                            lines={nextStepGuidance(dealFields, { rancherName: ref.rancher_name })}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* WAVE 2 buyer UI — shop/broker orders (Rancher Orders rows).
                  A buyer who paid on /shop and clicked "My Order" used to be
                  told "no active referrals yet" — their money was real, their
                  dashboard said otherwise. Same words as /order/<token>
                  (shared view model server-side), plus that signed link. */}
              {(data?.shopOrders || []).length > 0 && (
                <div className="space-y-4">
                  {(data?.memberReferrals || []).length > 0 && (
                    <h3 className="font-serif text-xl">Shop orders</h3>
                  )}
                  {(data?.shopOrders || []).map((o) => {
                    const badge =
                      o.state === 'shipped' || o.state === 'delivered'
                        ? 'bg-sage/15 text-sage-dark'
                        : o.state === 'refunded' || o.state === 'cancelled'
                          ? 'bg-dust/20 text-saddle'
                          : 'bg-charcoal/10 text-charcoal';
                    return (
                      <div key={o.id} className="p-6 border border-dust bg-white">
                        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                          <div>
                            <span className={`inline-block px-3 py-1 text-xs font-medium uppercase tracking-wider ${badge}`}>
                              {o.status_label}
                            </span>
                            <p className="mt-2 text-sm text-saddle">
                              {o.quantity > 1 ? `${o.quantity}× ` : ''}
                              <strong className="text-charcoal">{o.product_name}</strong>
                              {o.rancher_name ? ` from ${o.rancher_name}` : ''}
                            </p>
                          </div>
                          <p className="text-xs text-muted">
                            {o.ordered_at ? new Date(o.ordered_at).toLocaleDateString() : ''}
                          </p>
                        </div>
                        <p className="mt-3 text-sm text-saddle leading-relaxed">{o.status_detail}</p>
                        <p className="mt-2 text-sm text-saddle">
                          Paid <strong className="text-charcoal">${Number(o.buyer_paid || 0).toFixed(2)}</strong>
                        </p>
                        {o.tracking_number && (
                          <p className="mt-2 text-sm text-saddle">
                            Tracking:{' '}
                            {o.tracking_url ? (
                              <a
                                href={o.tracking_url}
                                target="_blank"
                                rel="noopener noreferrer nofollow"
                                className="underline hover:text-charcoal break-all"
                              >
                                {o.carrier ? `${o.carrier} · ` : ''}
                                {o.tracking_number}
                              </a>
                            ) : (
                              <span className="font-mono text-xs text-charcoal select-all break-all">
                                {o.carrier ? `${o.carrier} · ` : ''}
                                {o.tracking_number}
                              </span>
                            )}
                          </p>
                        )}
                        {o.status_path && (
                          <p className="mt-4">
                            <Link
                              href={o.status_path}
                              className="inline-block px-4 py-2 border border-charcoal text-charcoal hover:bg-bone-warm text-xs uppercase tracking-widest font-semibold"
                            >
                              View order status →
                            </Link>
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Honest empty state — only when there is genuinely NOTHING on
                  the account (no share journey, no shop orders). No fake
                  "we're matching you" promise: with zero referrals, nobody is
                  matching anything. Give them the two real doors instead. */}
              {(data?.memberReferrals || []).length === 0 &&
                (data?.shopOrders || []).length === 0 && (
                <div className="p-8 border border-dust text-center bg-white space-y-4">
                  <p className="text-charcoal font-medium">No orders on this account yet.</p>
                  <p className="text-sm text-saddle max-w-md mx-auto leading-relaxed">
                    When you reserve a share or buy from the shop with this email
                    ({member.email}), it shows up here with live status and tracking.
                  </p>
                  <div className="flex flex-wrap justify-center gap-2 pt-1">
                    <Link
                      href="/access"
                      className="inline-block px-5 py-3 bg-charcoal text-bone hover:bg-saddle text-xs uppercase tracking-widest font-semibold"
                    >
                      Get matched with a rancher →
                    </Link>
                    <Link
                      href="/shop"
                      className="inline-block px-5 py-3 border border-charcoal text-charcoal hover:bg-bone-warm text-xs uppercase tracking-widest font-semibold"
                    >
                      Browse the shop
                    </Link>
                  </div>
                  <p className="text-xs text-muted">
                    Ordered with a different email? Log in with that one, or{' '}
                    <Link href="/support" className="underline hover:text-charcoal">
                      tell a real person
                    </Link>{' '}
                    and we&apos;ll find it.
                  </p>
                </div>
              )}

              {/* A PAYING CUSTOMER DESERVES A HUMAN. Gated on a live, PAID
                  deal — never on merely having an account, because a browsing
                  visitor with a phone number is the tire-kicker call this rail
                  exists to replace.

                  The copy sharpens when a deal has gone quiet on the rancher's
                  side (paid, accepted, and then nothing for a week — see
                  lib/callbackRail.isStalledOnRancher). That is the single
                  biggest deal-killer in the business and the buyer is usually
                  the last to be told, so on those rows the offer changes from
                  "we're here" to "let's chase it". The signal is free: every
                  field it reads is already on this page.

                  Renders NOTHING while CALLBACK_RAIL_ENABLED is off. */}
              {(() => {
                const reason = resolveMemberCallbackReason(
                  (data?.memberReferrals || []).map(toDealFields),
                  Date.now(),
                );
                if (!reason) return null;
                return (
                  <CallbackRequest
                    variant={reason === 'stalled-on-rancher' ? 'member-stalled' : 'member'}
                    className="py-2"
                  />
                );
              })()}

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

              {/* Affiliate gear — curated on-brand gear, stage-aware. Stage is
                  derived from the buyer's latest referral: a delivered/closed
                  order → "keep your beef at its best" (delivered); anything
                  active → "while you wait…" (waiting). cutForBuyer maps the
                  referral's Order Type → cut. Self-fetches /api/gear; renders
                  NOTHING when the catalog is empty (today's reality). */}
              {(() => {
                const refs = data?.memberReferrals || [];
                // Latest referral by created_at (falls back to array order).
                const latest = refs.length
                  ? refs.slice().sort((a, b) =>
                      (Date.parse(b.created_at || '') || 0) - (Date.parse(a.created_at || '') || 0),
                    )[0]
                  : null;
                const delivered =
                  latest?.status === 'Closed Won' || !!latest?.fulfillment_confirmed_at;
                const gearStage: 'waiting' | 'delivered' = delivered ? 'delivered' : 'waiting';
                const gearCut = cutForBuyer({ 'Order Type': latest?.order_type || '' });
                return (
                  <div className="space-y-2">
                    {/* Attribution (2026-07-28): 118 gear clicks, 0 attributed —
                        the /go/product route reads ?buyer= and ?ref= but this
                        emitter never passed them. The page KNOWS the session
                        buyer (member.id) + their latest referral. */}
                    <GearBlock
                      stage={gearStage}
                      cut={gearCut}
                      surface="member"
                      buyerId={member.id}
                      refId={latest?.id || ''}
                    />
                    <p className="text-xs text-muted">
                      <Link href="/gear" className="underline hover:text-charcoal">
                        see all the gear we trust →
                      </Link>
                    </p>
                  </div>
                );
              })()}

              {/* Matching preference (2026-07-01) — nationwide opt-in/opt-out.
                  Mirrors the funnel waitlist choice; whichever surface the
                  buyer touched last wins (both write the same Consumers
                  field via POST /api/member/preferences). */}
              {data && (
                <MatchingPreferenceBlock initial={data.nationwidePreference || ''} />
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
                    className="px-6 py-3 bg-charcoal text-bone hover:bg-charcoal/80 transition-colors uppercase tracking-wider text-sm font-semibold disabled:opacity-50"
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
                      <RancherCard key={rancher.id} rancher={rancher} consumerId={member.id} />
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
                      <RancherCard key={rancher.id} rancher={rancher} consumerId={member.id} />
                    ))}
                  </div>
                </>
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

          {/* Merch banner — drives traffic to Shopify /shop from the
              highest-engagement surface. WAVE 3: moved BELOW the order status.
              It used to sit between the welcome header and "Your order", so the
              first thing a buyer waiting on $2,000 of beef saw was a hat ad. */}
          <a
            href="https://www.buyhalfcow.com/shop"
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

          <Divider />

          {/* WAVE 3 — the persistent help door. Before this, /support and
              hello@buyhalfcow.com appeared ONLY inside two failure branches
              (a reorder error and a ready-to-buy error), so a buyer with a
              normal question had nowhere to go from their own dashboard.
              Prefilled the same way the deposit-success page does it. */}
          <div className="text-center text-sm text-saddle">
            Something not right, or just want a human?{' '}
            <Link
              href={`/support?email=${encodeURIComponent(member.email)}`}
              className="underline hover:text-charcoal"
            >
              Get help
            </Link>{' '}
            or email{' '}
            <a href="mailto:hello@buyhalfcow.com" className="underline hover:text-charcoal">
              hello@buyhalfcow.com
            </a>
            .
          </div>

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

// ── WAVE 3 buyer-portal blocks ──────────────────────────────────────────────
//
// All six are dumb renderers over lib/buyerDealStage + the referral row. No
// fetching, no writes: pref edits keep going through the EXISTING
// /checkout/<refId>/preferences page, and /api/member/preferences stays the
// one deliberate boolean it was built to be.

// The deal ladder. Compact vertical stepper, mobile-first: a one-column rail
// of dots and connectors with the label + date + honest detail beside it.
function DealStepper({ ladder }: { ladder: BuyerDealStep[] }) {
  return (
    <ol className="mt-4 pt-4 border-t border-divider">
      {ladder.map((step, i) => {
        const isLast = i === ladder.length - 1;
        const done = step.state === 'done';
        const current = step.state === 'current';
        return (
          <li
            key={step.key}
            className="flex gap-3"
            aria-current={current ? 'step' : undefined}
          >
            <div className="flex flex-col items-center flex-shrink-0" aria-hidden="true">
              <span
                className={`flex items-center justify-center w-5 h-5 rounded-full text-[10px] leading-none border ${
                  done
                    ? 'bg-charcoal border-charcoal text-bone'
                    : current
                      ? 'bg-bone border-2 border-charcoal text-charcoal'
                      : 'bg-bone border-dust text-muted'
                }`}
              >
                {done ? '✓' : ''}
              </span>
              {!isLast && (
                <span className={`w-px flex-1 min-h-[16px] ${done ? 'bg-charcoal' : 'bg-dust'}`} />
              )}
            </div>
            <div className={`min-w-0 flex-1 ${isLast ? '' : 'pb-4'}`}>
              <p
                className={`text-sm leading-tight ${
                  current ? 'text-charcoal font-semibold' : done ? 'text-charcoal' : 'text-muted'
                }`}
              >
                {step.label}
                {step.date && (
                  <span className="text-muted font-normal"> · {formatDate(step.date)}</span>
                )}
              </p>
              {step.detail && step.state !== 'upcoming' && (
                <p className="mt-1 text-xs text-saddle leading-relaxed">{step.detail}</p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// Paid X, balance Y, total Z. Until Wave 3 the buyer could see none of the
// three: the deposit figure rendered only BEFORE they paid it, and the final
// balance had no figure anywhere on the page at all.
function OrderMoneySummary({ deal }: { deal: MemberReferral }) {
  const total = Number(deal.total_sale_amount || deal.sale_amount || 0);
  const deposit = deal.deposit_paid_at ? Number(deal.deposit_amount || 0) : 0;
  const balance = Number(deal.final_invoice_amount || 0);
  const balancePaid = !!deal.final_paid_at;
  if (!total && !deposit && !balance) return null;

  const rows: { label: string; value: string; strong?: boolean }[] = [];
  if (total) rows.push({ label: 'Total for your share', value: formatMoney(total) });
  if (deposit) rows.push({ label: 'Deposit paid', value: `− ${formatMoney(deposit)}` });
  if (balance) {
    rows.push({
      label: balancePaid ? 'Balance paid' : 'Balance still owed',
      value: balancePaid ? `− ${formatMoney(balance)}` : formatMoney(balance),
      strong: !balancePaid,
    });
  }

  return (
    <div className="mt-4 border border-dust bg-bone p-4">
      <p className="text-xs uppercase tracking-widest text-saddle mb-2">Your money</p>
      <dl className="space-y-1 text-sm">
        {rows.map((row) => (
          <div key={row.label} className="flex justify-between gap-4">
            <dt className="text-saddle">{row.label}</dt>
            <dd className={row.strong ? 'text-charcoal font-semibold' : 'text-charcoal'}>
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
      {balancePaid && (
        <p className="mt-2 text-xs text-muted">Paid in full. Nothing else is owed.</p>
      )}
    </div>
  );
}

// The date, and — for a pickup — WHERE. Handoff Date is the Wave 2 field
// (fldZpGyngRdeBq5y0): the buyer-facing pickup/delivery day, distinct from
// Processing Date (the abattoir day). Wave 2 emailed it once and the portal
// never showed it. Pickup Address / Instructions are the Wave 1 Ranchers
// fields; they already ride the product receipt (lib/productSettlement) and
// this is the share-buyer half of that same fix.
function HandoffBlock({ deal, mode }: { deal: MemberReferral; mode: 'pickup' | 'delivery' | null }) {
  const word = handoffWord(mode);
  const scheduled = formatDate(deal.handoff_date);
  const isPickup = mode === 'pickup';
  const address = isPickup ? (deal.rancher_pickup_address || '').trim() : '';
  const instructions = isPickup ? (deal.rancher_pickup_instructions || '').trim() : '';
  if (!scheduled && !address && !instructions) return null;

  return (
    <div className="mt-4 border border-dust bg-bone p-4 space-y-2 text-sm">
      <p className="text-xs uppercase tracking-widest text-saddle">
        {word === 'handoff' ? 'Handoff' : word}
      </p>
      {scheduled ? (
        <p className="text-charcoal">
          {word === 'pickup' ? 'Pickup' : word === 'delivery' ? 'Delivery' : 'Handoff'} scheduled:{' '}
          <strong>{scheduled}</strong>
        </p>
      ) : (
        <p className="text-saddle">
          No {word} date set yet. {deal.rancher_name || 'Your rancher'} sets it, and you get an
          email the moment they do.
        </p>
      )}
      {(address || instructions) && (
        <div className="pt-1 border-t border-divider space-y-1">
          <p className="text-xs uppercase tracking-widest text-saddle pt-2">Where to go</p>
          {address && <p className="text-charcoal font-medium">{address}</p>}
          {instructions && (
            <p className="text-saddle text-xs whitespace-pre-wrap leading-relaxed">{instructions}</p>
          )}
        </div>
      )}
    </div>
  );
}

// The buyer's own cut sheet. They answer these three questions once, at
// /checkout/<refId>/preferences, and — until Wave 3 — never see the answers
// again. Read-only here by design: the edit path is that same existing page,
// which already re-notifies the rancher on a correction (Wave 2).
function CutSheetSummary({ deal }: { deal: MemberReferral }) {
  const fulfillment = (deal.buyer_fulfillment_pref || '').trim();
  const windowPref = (deal.buyer_window_pref || '').trim();
  const cutNotes = (deal.buyer_cut_notes || '').trim();
  const anySet = !!(deal.buyer_preferences_set_at || fulfillment || windowPref || cutNotes);
  const rancherFirst = (deal.rancher_name || 'your rancher').split(' ')[0];

  if (!anySet) {
    return (
      <div className="mt-4 border-2 border-charcoal bg-white p-4 space-y-2">
        <p className="text-sm text-charcoal font-medium">
          Tell {rancherFirst} how you want it cut.
        </p>
        <p className="text-xs text-saddle leading-relaxed">
          Delivery or pickup, roughly when you want it, and anything for the cut sheet — steak
          thickness, roast sizes, how much ground. Thirty seconds, and {rancherFirst} has it before
          they book your processing slot.
        </p>
        <Link
          href={`/checkout/${deal.id}/preferences`}
          className="inline-block px-5 py-2 bg-charcoal text-bone hover:bg-saddle text-xs uppercase tracking-widest font-semibold"
        >
          Set your cut sheet →
        </Link>
      </div>
    );
  }

  return (
    <div className="mt-4 border border-dust bg-bone p-4 space-y-2 text-sm">
      <p className="text-xs uppercase tracking-widest text-saddle">Your cut sheet</p>
      <dl className="space-y-1">
        <div className="flex gap-2">
          <dt className="text-muted flex-shrink-0">Fulfillment:</dt>
          <dd className="text-charcoal">{fulfillment || 'not set'}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted flex-shrink-0">Target window:</dt>
          <dd className="text-charcoal">{windowPref || 'flexible'}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted flex-shrink-0">Cut notes:</dt>
          <dd className="text-charcoal whitespace-pre-wrap">
            {cutNotes || `none — ${rancherFirst} uses their standard cut sheet`}
          </dd>
        </div>
      </dl>
      <p className="pt-1">
        <Link
          href={`/checkout/${deal.id}/preferences`}
          className="text-charcoal underline text-xs uppercase tracking-wider hover:text-saddle"
        >
          Change your cut sheet →
        </Link>
      </p>
      <p className="text-xs text-muted">
        Changes go straight to {rancherFirst}. Worth doing before your processing date.
      </p>
    </div>
  );
}

// Rancher contact, in EVERY active state. Before Wave 3 these lines lived
// only inside the `Intro Sent` branch — the buyer's rancher disappeared from
// their screen the moment they paid.
function RancherContactBlock({ deal }: { deal: MemberReferral }) {
  const hasContact = !!(deal.rancher_email || deal.rancher_phone);
  const isClosed = deal.status === 'Closed Won';
  return (
    <div className="mt-4 border border-dust bg-bone p-4 space-y-2 text-sm">
      <p className="text-xs uppercase tracking-widest text-saddle">Your rancher</p>
      <p className="font-semibold text-charcoal">
        {deal.rancher_name || 'Your rancher'}
        {deal.ranch_name && deal.ranch_name !== deal.rancher_name ? ` · ${deal.ranch_name}` : ''}
      </p>
      {deal.rancher_email && (
        <p className="text-saddle">
          <span className="text-muted">Email:</span>{' '}
          <a href={`mailto:${deal.rancher_email}`} className="text-charcoal underline break-all">
            {deal.rancher_email}
          </a>
        </p>
      )}
      {deal.rancher_phone && (
        <p className="text-saddle">
          <span className="text-muted">Phone:</span>{' '}
          <a href={`tel:${deal.rancher_phone}`} className="text-charcoal underline">
            {deal.rancher_phone}
          </a>
        </p>
      )}
      {!hasContact && (
        <p className="text-xs text-muted">
          We don&apos;t have direct contact details on file for them yet. Use the message thread
          below — it reaches them by email either way.
        </p>
      )}
      <div className="flex flex-wrap gap-2 pt-2">
        {!isClosed && (
          <Link
            href={`/checkout/${deal.id}/ask`}
            className="inline-block px-4 py-2 border border-charcoal text-charcoal hover:bg-bone-warm text-xs uppercase tracking-widest font-semibold"
          >
            Message your rancher →
          </Link>
        )}
        {deal.rancher_slug && (
          <Link
            href={`/ranchers/${deal.rancher_slug}`}
            className="inline-block px-4 py-2 border border-dust text-charcoal hover:bg-bone-warm text-xs uppercase tracking-widest font-semibold"
          >
            View their page →
          </Link>
        )}
      </div>
    </div>
  );
}

// "What happens next" — the deposit-success page's honest Today / This week /
// When ready block, made permanent and keyed off the CURRENT ladder step so it
// stays true as the deal moves.
function WhatHappensNext({ lines }: { lines: { when: string; text: string }[] }) {
  if (lines.length === 0) return null;
  return (
    <div className="mt-4 border border-dust bg-white p-4">
      <p className="text-xs uppercase tracking-widest text-saddle mb-3">What happens next</p>
      <ol className="space-y-3 text-sm">
        {lines.map((line) => (
          <li key={line.when} className="flex flex-col sm:flex-row sm:gap-3">
            <span className="text-saddle font-medium sm:flex-shrink-0 sm:w-40">{line.when}:</span>
            <span className="text-charcoal leading-relaxed">{line.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

// Matching preference toggle (2026-07-01 founder directive). ON =
// 'nationwide-ok' (if no local rancher is available, a vetted nationwide
// shipper can be matched), OFF = 'local-only' (wait for a local rancher).
// An unset field renders OFF-looking but is labeled as "not set" — matching
// treats unset as nationwide-allowed (pre-feature behavior), so we tell the
// buyer that honestly instead of pretending they opted out.
function MatchingPreferenceBlock({ initial }: { initial: string }) {
  const [on, setOn] = useState(initial === 'nationwide-ok');
  const [touched, setTouched] = useState(initial === 'nationwide-ok' || initial === 'local-only');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(false);

  const toggle = async () => {
    if (saving) return;
    const next = !on;
    // Optimistic flip; revert on failure.
    setOn(next);
    setTouched(true);
    setSaving(true);
    setSaved(false);
    setError(false);
    try {
      const res = await fetch('/api/member/preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nationwide: next }),
      });
      if (!res.ok) throw new Error('save failed');
      setSaved(true);
    } catch {
      setOn(!next);
      setError(true);
    }
    setSaving(false);
  };

  return (
    <div className="p-6 border border-dust bg-white space-y-3">
      <span className="text-xs uppercase tracking-widest text-saddle">Matching preference</span>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-serif text-xl text-charcoal">Open to nationwide shipping ranchers</h3>
          <p className="mt-1 text-sm text-saddle leading-relaxed">
            On — if no rancher is available in your state, we can match you with a vetted
            rancher who ships nationwide. Off — we&apos;ll only match you locally, even if
            that means waiting.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="Open to nationwide shipping ranchers"
          onClick={toggle}
          disabled={saving}
          className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors ${
            on ? 'bg-charcoal border-charcoal' : 'bg-dust/40 border-dust'
          } ${saving ? 'opacity-60' : ''}`}
        >
          <span
            className={`inline-block h-5 w-5 transform rounded-full bg-bone transition-transform ${
              on ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>
      <p className="text-xs text-muted">
        {saving
          ? 'Saving…'
          : error
            ? 'Couldn’t save — please try again.'
            : saved
              ? 'Saved.'
              : touched
                ? on
                  ? 'You’re open to nationwide shippers when no local rancher is available.'
                  : 'Local only — we’ll hold your spot for a rancher in your state.'
                : 'Not set — today we may match you nationwide if no local rancher is available. Flip the switch to make it your explicit choice.'}
      </p>
    </div>
  );
}

// Past orders + reorder card. Repeat customers are the easiest revenue capture
// in the platform — without this, a happy buyer goes direct to the rancher on
// their next order and we collect $0. This routes the reorder back through the
// platform via the matching engine's direct-page-lead code path.
function PastOrdersSection({
  orders,
  hasActiveOrder,
  memberEmail,
  rancherLookup,
}: {
  orders: MemberReferral[];
  hasActiveOrder: boolean;
  memberEmail: string;
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
        // tier_v2 + Connect-active rancher → straight to a 1-tap deposit
        // instead of waiting on a re-intro email (highest-intent path).
        if (data.depositUrl) {
          window.location.href = data.depositUrl;
          return;
        }
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
            message: data.error || 'Reorder failed. Try again in a moment.',
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
                    <p className="text-xs text-muted">
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
                  {/* Failure escape hatch — route to the support intake with
                      the member's email + this order prefilled; keep the
                      plain email as the secondary path. */}
                  {!result.ok && (
                    <>
                      {' '}
                      <Link
                        href={`/support?email=${encodeURIComponent(memberEmail)}&ref=${encodeURIComponent(order.id)}`}
                        className="underline"
                      >
                        Get help
                      </Link>
                      {' '}or email <a href="mailto:hello@buyhalfcow.com" className="underline">hello@buyhalfcow.com</a>.
                    </>
                  )}
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
function ReadyToBuyButton({ hasMatch, memberEmail }: { hasMatch: boolean; memberEmail: string }) {
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
        <p className="text-xs text-weathered">
          Couldn&apos;t send — try again in a moment,{' '}
          <Link href={`/support?email=${encodeURIComponent(memberEmail)}`} className="underline">get help</Link>, or
          email <a href="mailto:hello@buyhalfcow.com" className="underline">hello@buyhalfcow.com</a>.
        </p>
      )}
    </div>
  );
}

// Renders the price-tier buy buttons for a matched rancher.
// Always routes through the tracked redirect endpoint (/ranchers/[slug]/pay/[tier]),
// which forks server-side: Connect ranchers → on-site /access deposit (commission +
// ad-signal), legacy ranchers → their Payment Link. Tier visibility is driven by
// PRICE (not Payment Link existence) so Connect ranchers — who have no Payment Links —
// still show buy buttons instead of a dead "we're finalizing" message.
function BuyTierButtons({ rancher }: { rancher: Rancher }) {
  const slug = rancher.Slug;
  const onConnect = isRancherOnConnect(rancher as any);
  const tiers = [
    { key: 'quarter', label: 'Quarter Cow', price: rancher['Quarter Price'], lbs: rancher['Quarter lbs'], link: rancher['Quarter Payment Link'] },
    { key: 'half', label: 'Half Cow', price: rancher['Half Price'], lbs: rancher['Half lbs'], link: rancher['Half Payment Link'] },
    { key: 'whole', label: 'Whole Cow', price: rancher['Whole Price'], lbs: rancher['Whole lbs'], link: rancher['Whole Payment Link'] },
  ].filter(t => t.price && (onConnect ? !!slug : !!t.link));

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
          {t.lbs && <div className="text-xs text-muted group-hover:text-bone mt-0.5">{t.lbs} lbs</div>}
          <div className="mt-2 text-xs font-medium uppercase tracking-wider">Buy Now →</div>
        </a>
      ))}
    </div>
  );
}

// The conversion hero — lives at the top of the member dashboard when the
// member has an active referral and a matched rancher. Shows name, logo,
// processing-date urgency, and direct-buy buttons.
function YourMatchHero({ rancher, status, consumerId }: { rancher: Rancher; status: string; consumerId?: string }) {
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

  const onConnect = isRancherOnConnect(rancher as any);
  // Connect ranchers have no Payment Links — gate their buy UI on price + slug
  // (buttons route to the on-site deposit). Legacy ranchers still gate on link.
  const hasPricing = onConnect
    ? !!(rancher.Slug && (rancher['Quarter Price'] || rancher['Half Price'] || rancher['Whole Price']))
    : !!(rancher['Quarter Payment Link'] || rancher['Half Payment Link'] || rancher['Whole Payment Link']);

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
              consumerId={consumerId}
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
            consumerId={consumerId}
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

function RancherCard({ rancher, consumerId }: { rancher: Rancher; consumerId?: string }) {
  const rancherForContact = {
    id: rancher.id,
    ranch_name: rancher['Ranch Name'] || '',
    operator_name: rancher['Operator Name'] || '',
    email: rancher.Email || '',
    state: rancher.State || '',
  };
  const onConnect = isRancherOnConnect(rancher as any);
  // Connect ranchers have no Payment Links — gate their buy UI on price + slug
  // (buttons route to the on-site deposit). Legacy ranchers still gate on link.
  const hasPricing = onConnect
    ? !!(rancher.Slug && (rancher['Quarter Price'] || rancher['Half Price'] || rancher['Whole Price']))
    : !!(rancher['Quarter Payment Link'] || rancher['Half Payment Link'] || rancher['Whole Payment Link']);

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
            {rancher.Tagline && <p className="text-sm text-muted mt-1 italic">&ldquo;{rancher.Tagline}&rdquo;</p>}
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
        <ContactRancherButton rancher={rancherForContact} consumerId={consumerId} />
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
