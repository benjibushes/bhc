'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Container from '../components/Container';
import Divider from '../components/Divider';
import StateMultiSelect from '../components/StateMultiSelect';
import ImageUploader from '../components/ImageUploader';
import Link from 'next/link';

interface RancherInfo {
  id: string;
  name: string;
  ranchName: string;
  state: string;
  activeStatus: string;
  onboardingStatus: string;
  agreementSigned: boolean;
  commissionRate?: number;
  currentActiveReferrals: number;
  maxActiveReferrals: number;
  monthlyCapacity: number;
  beefTypes: string;
  statesServed: string;
  preferredStates?: string;
  routingStates?: string;
  shipsNationwide: boolean;
  certifications: string;
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
  // Optional optimization-checklist fields (JSON-encoded strings on
  // the Airtable side; parsed lazily where used).
  galleryPhotos?: string;
  testimonials?: string;
  // Stage-3 tier subscription + Connect status (Task 11C banner cascade).
  // Pricing Model gates which banners render: 'legacy' = old commission
  // model, no tier banners; 'tier_v2' = subscription required.
  pricingModel?: string;
  tier?: string | null;
  subscriptionStatus?: string;
  connectStatus?: string;
  // P1-4 — Tier Specialty drives the no-pricing alarm card. If the
  // specialty includes 'Half' but Half Price is missing, /api/checkout/deposit
  // 409s the buyer; rancher never finds out unless we surface it here.
  tierSpecialty?: string[];
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
  last_rancher_activity_at?: string;
  last_buyer_activity_at?: string;
  rancher_engaged_flag?: boolean;
  stripe_invoice_url?: string;
  // Stage-3 Audit B4 — present (ISO timestamp) when rancher has confirmed
  // the buyer received their beef. Drives the Closed Deals card green pill
  // and gates the "Mark beef delivered" CTA visibility.
  fulfillment_confirmed_at?: string;
  // Deposit + final invoice tracking (tier_v2 Stripe Connect flow).
  // Drives the "Send Final Invoice" button visibility on Awaiting Payment
  // referrals. deposit_paid_at present = buyer already paid deposit, rancher
  // can now invoice the balance for fulfillment. final_invoice_sent_at
  // present = invoice already created (don't re-send unless explicit).
  deposit_paid_at?: string;
  deposit_amount?: number;
  final_invoice_url?: string;
  final_invoice_sent_at?: string;
  final_invoice_amount?: number;
  final_paid_at?: string;
  total_sale_amount?: number;
  processing_date?: string;
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

type Tab = 'overview' | 'referrals' | 'marketing' | 'earnings' | 'benefits' | 'my_page';

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
  const [closeForm, setCloseForm] = useState({ status: 'Closed Won', saleAmount: '', notes: '', confirmed: false });
  // My Buyers tab — filter + sort. Helps ranchers triage when they have 20+
  // active leads. Defaults to all + newest-first so the latest intros surface.
  const [buyerFilter, setBuyerFilter] = useState<'all' | 'Intro Sent' | 'Rancher Contacted' | 'Negotiation' | 'stale'>('all');
  const [buyerSort, setBuyerSort] = useState<'newest' | 'oldest' | 'stalest'>('newest');
  const [updating, setUpdating] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState('');
  // Pass-on-Lead modal — separate from "close deal" because it carries a
  // structured reason and triggers auto-rematch with this rancher excluded.
  const [passModal, setPassModal] = useState<Referral | null>(null);
  const [passReason, setPassReason] = useState<'out_of_area' | 'at_capacity' | 'not_a_fit' | 'no_response'>('not_a_fit');
  const [passSubmitting, setPassSubmitting] = useState(false);
  const [passResult, setPassResult] = useState<{ rematchOutcome: string; newRancherName: string | null } | null>(null);
  // Mark-Lost modal — audit #17 (2026-05-28) replaces window.prompt picker.
  // Mobile Safari renders window.prompt as a tiny native popup that ranchers
  // abandoned. Branded modal matches close + pass UX.
  const [lostModal, setLostModal] = useState<Referral | null>(null);
  const [lostReasonCode, setLostReasonCode] = useState<'no_response' | 'price' | 'not_a_fit' | 'other'>('no_response');
  const [lostFreeText, setLostFreeText] = useState('');
  // FINAL INVOICE modal (FINAL-5 2026-05-31): sent by rancher after deposit
  // lands + processing date is locked. Stripe Connect direct charge, app_fee=0,
  // 100% to rancher. Posts to /api/rancher/referrals/[id]/send-final-invoice.
  const [finalInvoiceModal, setFinalInvoiceModal] = useState<Referral | null>(null);
  const [finalInvoiceTotalSale, setFinalInvoiceTotalSale] = useState('');
  const [finalInvoiceProcessingDate, setFinalInvoiceProcessingDate] = useState('');
  const [finalInvoiceNotes, setFinalInvoiceNotes] = useState('');
  const [finalInvoiceSubmitting, setFinalInvoiceSubmitting] = useState(false);
  const [finalInvoiceResult, setFinalInvoiceResult] = useState<{ url: string; balanceAmount: number } | null>(null);
  const [pageForm, setPageForm] = useState<Record<string, string>>({});
  const [pageSaving, setPageSaving] = useState(false);
  const [pageSaved, setPageSaved] = useState(false);
  const [pageError, setPageError] = useState('');
  // Custom products
  const [customProducts, setCustomProducts] = useState<{ name: string; price: number | string; description: string; link: string }[]>([]);
  const [galleryPhotos, setGalleryPhotos] = useState<string[]>([]);
  const [newProduct, setNewProduct] = useState({ name: '', price: '', description: '', link: '' });
  // Capacity editor
  const [editingCapacity, setEditingCapacity] = useState(false);
  const [capacityValue, setCapacityValue] = useState('');
  const [capacitySaving, setCapacitySaving] = useState(false);
  // Go-live request
  const [goLiveRequested, setGoLiveRequested] = useState(false);
  const [goLiveLoading, setGoLiveLoading] = useState(false);
  // Verification
  const [verificationRefs, setVerificationRefs] = useState('');
  const [verificationReviewsLink, setVerificationReviewsLink] = useState('');
  const [verificationSocial, setVerificationSocial] = useState('');
  const [verificationProcessor, setVerificationProcessor] = useState('');
  const [verificationCerts, setVerificationCerts] = useState('');
  const [verificationMethod, setVerificationMethod] = useState<'sample' | 'visit' | 'digital'>('digital');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [verificationSubmitting, setVerificationSubmitting] = useState(false);
  const [verificationSubmitted, setVerificationSubmitted] = useState(false);
  const [verificationError, setVerificationError] = useState('');

  useEffect(() => {
    fetchDashboard();
  }, []);

  const [isAdminImpersonating, setIsAdminImpersonating] = useState(false);

  const fetchDashboard = async () => {
    try {
      const sessionRes = await fetch('/api/auth/rancher/session');
      if (!sessionRes.ok) {
        router.push('/rancher/login');
        return;
      }
      try {
        const s = await sessionRes.clone().json();
        if (s?.impersonatedBy === 'admin') setIsAdminImpersonating(true);
      } catch {}

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
        'States Served': r.statesServed || '',
        'Preferred States': r.preferredStates || r.statesServed || '',
        'Ships Nationwide': r.shipsNationwide ? 'true' : '',
        'Beef Types': r.beefTypes || '',
        'Certifications': r.certifications || '',
        'Team Emails': (r as any).teamEmails || '',
      });
      // Parse custom products
      try {
        setCustomProducts(r.customProducts ? JSON.parse(r.customProducts) : []);
      } catch { setCustomProducts([]); }
      // Parse gallery photos — stored as JSON array of URL strings.
      try {
        const raw = (r as any).galleryPhotos;
        const parsed = raw ? JSON.parse(raw) : [];
        setGalleryPhotos(Array.isArray(parsed) ? parsed.filter((s: any) => typeof s === 'string') : []);
      } catch { setGalleryPhotos([]); }
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

  // Mark Lost — clean close path, no rerouting. Different from "Pass" which
  // signals "buyer's not for me, give to someone else" — Mark Lost signals
  // "they're out (price/timing/etc), no one's going to convert them."
  // Confirms before writing to avoid accidental closes.
  // Admin-only: revive a Closed Lost referral back to an actionable status.
  // Shows up only when impersonatedBy === 'admin' (session flag). Server-side
  // endpoint also enforces admin auth, so a normal rancher can't call this
  // even if they craft the request.
  const handleReviveLead = async (referral: Referral) => {
    const target = window.prompt(
      `Revive "${referral.buyer_name}" — pick target status:\n\n` +
      `  1 = Pending Approval (re-route via cron)\n` +
      `  2 = Intro Sent (drop back at intro)\n` +
      `  3 = Rancher Contacted\n` +
      `  4 = Negotiation\n\n` +
      `Enter number:`,
      '1'
    );
    if (target === null) return;
    const map: Record<string, string> = {
      '1': 'Pending Approval',
      '2': 'Intro Sent',
      '3': 'Rancher Contacted',
      '4': 'Negotiation',
    };
    const toStatus = map[target.trim()];
    if (!toStatus) { setUpdateError('Invalid choice'); return; }
    setUpdating(referral.id);
    setUpdateError('');
    try {
      const res = await fetch(`/api/admin/referrals/${referral.id}/revive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toStatus }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setUpdateError(data.error || 'Failed to revive — admin auth required.');
      }
      await fetchDashboard();
    } catch {
      setUpdateError('Network error.');
    } finally {
      setUpdating(null);
    }
  };

  // Audit #17 (2026-05-28): open branded modal instead of window.prompt.
  // Real submit happens in submitMarkLost — invoked from the modal's CTA.
  const handleMarkLost = (referral: Referral) => {
    setLostReasonCode('no_response');
    setLostFreeText('');
    setUpdateError('');
    setLostModal(referral);
  };

  const submitMarkLost = async () => {
    if (!lostModal) return;
    const reasonMap: Record<string, string> = {
      no_response: 'Buyer ghosted',
      price: 'Price / budget mismatch',
      not_a_fit: 'Not a fit',
      other: 'Other',
    };
    const label = reasonMap[lostReasonCode];
    const freeText = lostReasonCode === 'other' ? lostFreeText.trim() : '';
    if (lostReasonCode === 'other' && !freeText) {
      setUpdateError('Please add a quick reason — "Other" needs a note.');
      return;
    }
    setUpdating(lostModal.id);
    setUpdateError('');
    try {
      const res = await fetch(`/api/rancher/referrals/${lostModal.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'Closed Lost',
          closeReason: lostReasonCode,
          notes: `[CLOSED LOST · ${label}]${freeText ? ` ${freeText}` : ''}`,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setUpdateError(data.error || 'Failed to mark lost. Please try again.');
        setUpdating(null);
        return;
      }
      setLostModal(null);
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
      setCloseForm({ status: 'Closed Won', saleAmount: '', notes: '', confirmed: false });
      await fetchDashboard();
    } catch {
      setUpdateError('Network error. Please check your connection.');
    } finally {
      setUpdating(null);
    }
  };

  const handlePassOnLead = async () => {
    if (!passModal) return;
    setPassSubmitting(true);
    setUpdateError('');
    setPassResult(null);
    try {
      const res = await fetch(`/api/rancher/referrals/${passModal.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ _action: 'pass', passReason }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setUpdateError(data.error || 'Failed to pass on lead.');
        return;
      }
      setPassResult({
        rematchOutcome: data.rematchOutcome || 'unknown',
        newRancherName: data.newRancherName,
      });
      await fetchDashboard();
    } catch {
      setUpdateError('Network error. Please try again.');
    } finally {
      setPassSubmitting(false);
    }
  };

  const closePassModal = () => {
    setPassModal(null);
    setPassReason('not_a_fit');
    setPassResult(null);
  };

  // FINAL-5 (2026-05-31): open final invoice modal for a referral. Prefills
  // total sale from referral.total_sale_amount when already set (re-send case),
  // otherwise empty so rancher must enter explicit total before submit.
  const openFinalInvoiceModal = (referral: Referral) => {
    setFinalInvoiceModal(referral);
    setFinalInvoiceTotalSale(
      referral.total_sale_amount && referral.total_sale_amount > 0
        ? String(referral.total_sale_amount)
        : '',
    );
    setFinalInvoiceProcessingDate(referral.processing_date || '');
    setFinalInvoiceNotes('');
    setFinalInvoiceResult(null);
    setUpdateError('');
  };

  const closeFinalInvoiceModal = () => {
    setFinalInvoiceModal(null);
    setFinalInvoiceTotalSale('');
    setFinalInvoiceProcessingDate('');
    setFinalInvoiceNotes('');
    setFinalInvoiceResult(null);
  };

  const submitFinalInvoice = async (resend = false) => {
    if (!finalInvoiceModal) return;
    const total = parseFloat(finalInvoiceTotalSale);
    if (!isFinite(total) || total <= 0) {
      setUpdateError('Enter the total final sale price (e.g. 2000).');
      return;
    }
    const deposit = finalInvoiceModal.deposit_amount || 0;
    if (deposit <= 0) {
      setUpdateError('No deposit recorded on this referral. Cannot compute balance.');
      return;
    }
    if (total <= deposit) {
      setUpdateError(`Total sale ($${total}) must exceed deposit ($${deposit}). Balance must be > $0.`);
      return;
    }
    setFinalInvoiceSubmitting(true);
    setUpdateError('');
    try {
      const url = `/api/rancher/referrals/${finalInvoiceModal.id}/send-final-invoice${resend ? '?resend=true' : ''}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          totalSaleAmount: total,
          processingDate: finalInvoiceProcessingDate.trim() || undefined,
          notes: finalInvoiceNotes.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setUpdateError(data.error || 'Failed to send final invoice.');
        return;
      }
      setFinalInvoiceResult({
        url: data.url,
        balanceAmount: data.balanceAmount || total - deposit,
      });
      // Refresh dashboard so the row reflects Awaiting Payment status + invoice URL
      await fetchDashboard();
    } catch {
      setUpdateError('Network error. Please try again.');
    } finally {
      setFinalInvoiceSubmitting(false);
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
      // Include custom products as JSON
      body['Custom Products'] = JSON.stringify(customProducts);
      body['Gallery Photos'] = JSON.stringify(galleryPhotos);
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
    setUpdateError('');
    try {
      const res = await fetch('/api/rancher/landing-page', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ _action: 'request-go-live' }),
      });
      if (res.ok) {
        setGoLiveRequested(true);
      } else {
        const data = await res.json().catch(() => ({}));
        setUpdateError(data.error || 'Go-live request failed. Try again or email support@buyhalfcow.com.');
      }
    } catch {
      setUpdateError('Network error — check your connection and try again.');
    } finally {
      setGoLiveLoading(false);
    }
  };

  if (loading) {
    return (
      <main className="min-h-screen py-24 bg-bone text-charcoal flex items-center justify-center">
        <Container>
          <div className="text-center">
            <div className="inline-block w-8 h-8 border-4 border-charcoal border-t-transparent rounded-full animate-spin" />
            <p className="mt-4 text-saddle">Loading your dashboard...</p>
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
    { key: 'referrals', label: `My Buyers (${activeRefs.length})` },
    { key: 'marketing', label: 'Marketing' },
    { key: 'earnings', label: 'Earnings' },
    { key: 'benefits', label: `Network Benefits${benefits.length > 0 ? ` (${benefits.length})` : ''}` },
    { key: 'my_page', label: 'My Page' },
  ];

  return (
    <main className="min-h-screen py-12 bg-bone text-charcoal">
      <Container>
        <div className="space-y-8">
          {/* Header */}
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
            <div>
              <h1 className="font-serif text-3xl md:text-4xl">{rancherInfo.ranchName}</h1>
              <p className="text-saddle mt-1">{rancherInfo.name} &middot; {rancherInfo.state}</p>
            </div>
            <div className="flex items-center gap-4 flex-wrap">
              <span className={`px-3 py-1 text-xs font-medium uppercase tracking-wider ${
                rancherInfo.activeStatus === 'Active' ? 'bg-green-100 text-green-800' :
                rancherInfo.activeStatus === 'At Capacity' ? 'bg-yellow-100 text-yellow-800' :
                'bg-gray-100 text-gray-600'
              }`}>
                {rancherInfo.activeStatus || 'Pending'}
              </span>
              {rancherInfo.slug && rancherInfo.pageLive && (
                <a
                  href={`/ranchers/${rancherInfo.slug}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-saddle hover:text-charcoal underline underline-offset-2"
                >
                  View public page →
                </a>
              )}
              <button onClick={handleLogout} className="text-sm text-dust hover:text-charcoal transition-colors">
                Log out
              </button>
            </div>
          </div>

          <Divider />

          {/* P1-4 — No-pricing alarm. If the rancher's Tier Specialty includes
              a cut size but the corresponding price field is empty/zero, the
              /api/checkout/deposit endpoint 409s any buyer who picks that
              size. The rancher never learns about the bounce. This card
              names the missing cuts + links to the My Page pricing editor. */}
          {(() => {
            const missingCuts: string[] = [];
            const specialty = (rancherInfo.tierSpecialty || []) as string[];
            const priceMissing = (v: string | number | undefined): boolean => {
              if (v === undefined || v === null || v === '') return true;
              const n = Number(v);
              return !isFinite(n) || n <= 0;
            };
            if (specialty.includes('Quarter') && priceMissing(rancherInfo.quarterPrice)) {
              missingCuts.push('Quarter');
            }
            if (specialty.includes('Half') && priceMissing(rancherInfo.halfPrice)) {
              missingCuts.push('Half');
            }
            if (specialty.includes('Whole') && priceMissing(rancherInfo.wholePrice)) {
              missingCuts.push('Whole');
            }
            if (missingCuts.length === 0) return null;
            return (
              <div className="border-l-4 border-rust bg-rust/10 px-4 py-3 mb-4">
                <p className="font-semibold text-rust text-xs uppercase tracking-widest">
                  pricing missing
                </p>
                <p className="text-saddle text-sm mt-1">
                  Buyers picking <strong>{missingCuts.join(' or ')}</strong> can&apos;t
                  check out today — the deposit page 409s until you set a
                  price.{' '}
                  <button
                    type="button"
                    onClick={() => setActiveTab('my_page')}
                    className="underline underline-offset-2 hover:text-charcoal"
                  >
                    set prices in my page →
                  </button>
                </p>
              </div>
            );
          })()}

          {/* Stage-3 Task 11C — Banner cascade for tier_v2 ranchers.
              Shows ALL applicable banners stacked. Priority (top → bottom):
                1. No tier picked yet (blue) → /partner
                2. Connect not_connected (amber) → /api/rancher/connect/start
                3. Connect onboarding (amber) → resume same link
                4. Connect restricted (red) → billing portal
                5. Subscription past_due (red) → billing portal
              Legacy ranchers (Pricing Model !== 'tier_v2') see nothing here. */}
          {rancherInfo.pricingModel === 'tier_v2' && (
            <DashboardBannerCascade rancher={rancherInfo} />
          )}

          {/* Legacy → tier_v2 upgrade banner.
              Two states:
                - Discovery: legacy w/ no tier yet → CTA to /partner
                - Ready: legacy + tier subscription paying + Connect active → one-click POST /api/rancher/legacy-upgrade flips Pricing Model */}
          {rancherInfo.pricingModel === 'legacy' && (
            <LegacyUpgradeBanner rancher={rancherInfo} />
          )}

          {/* Onboarding Banner */}
          {rancherInfo.onboardingStatus && rancherInfo.onboardingStatus !== 'Live' && (() => {
            const status = rancherInfo.onboardingStatus;
            const agreementDone = rancherInfo.agreementSigned || ['Agreement Signed', 'Verification Pending', 'Verification Complete'].includes(status);
            const verifiedDone = status === 'Verification Complete';
            const pageReady = !!rancherInfo.slug && !!rancherInfo.halfPrice;
            const steps: Array<{ label: string; state: 'done' | 'current' | 'pending'; cta?: React.ReactNode }> = [
              { label: 'Application received', state: 'done' },
              {
                label: 'Sign the Rancher Agreement',
                state: agreementDone ? 'done' : 'current',
                cta: !agreementDone ? (
                  <span className="text-xs text-saddle">Check your email — we sent the agreement to {rancherInfo.name}&rsquo;s inbox right after signup. Not there? <a href="mailto:ben@buyhalfcow.com?subject=Resend agreement" className="underline">Ask us to resend</a>.</span>
                ) : undefined,
              },
              {
                label: 'Verification',
                state: verifiedDone ? 'done' : agreementDone ? 'current' : 'pending',
                cta: agreementDone && !verifiedDone ? (
                  <span className="text-xs text-saddle">Submit verification info below &darr;</span>
                ) : undefined,
              },
              {
                label: 'Set up your ranch page',
                state: verifiedDone && pageReady ? 'done' : verifiedDone ? 'current' : 'pending',
                cta: verifiedDone && !pageReady ? (
                  <Link href="#my_page" onClick={() => setActiveTab('my_page')} className="text-xs text-saddle underline">Open &ldquo;My Page&rdquo; tab</Link>
                ) : undefined,
              },
              { label: 'Go live — start receiving buyers', state: 'pending' },
            ];
            return (
            <div className="p-4 border-2 border-yellow-400 bg-yellow-50 space-y-3">
              <p className="font-medium">Your Onboarding Progress</p>
              <p className="text-sm text-saddle">
                {status === 'Docs Sent' && "Your agreement is in your email inbox. Sign it whenever you're ready — that's the one thing holding up your go-live."}
                {status === 'Verification Complete' && "You're verified! We're activating your profile. You'll receive an email when you're live."}
                {status === 'Verification Pending' && !verificationSubmitted && "Submit your verification info below to get approved and go live."}
                {status === 'Verification Pending' && verificationSubmitted && "Verification submitted. Review takes 24-48 hours — we'll email you the moment it's approved."}
                {status === 'Agreement Signed' && "Agreement signed! One step left: complete verification so we can get you live."}
                {!['Docs Sent', 'Agreement Signed', 'Verification Complete', 'Verification Pending'].includes(status) && "Complete the steps below to start receiving qualified buyer leads."}
              </p>
              <div className="pt-3 border-t border-yellow-300">
                <p className="text-xs font-medium text-saddle uppercase tracking-wider mb-3">Steps to go live</p>
                <ol className="space-y-3">
                  {steps.map((step, i) => (
                    <li key={i} className="flex items-start gap-3">
                      <span className={`flex-shrink-0 w-6 h-6 flex items-center justify-center text-xs font-bold ${
                        step.state === 'done' ? 'bg-green-600 text-white' :
                        step.state === 'current' ? 'bg-yellow-500 text-white' :
                        'bg-gray-200 text-gray-500'
                      }`} aria-hidden>
                        {step.state === 'done' ? '\u2713' : step.state === 'current' ? '!' : i + 1}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm ${
                          step.state === 'done' ? 'text-gray-500 line-through' :
                          step.state === 'current' ? 'font-medium text-charcoal' :
                          'text-gray-500'
                        }`}>{step.label}</p>
                        {step.cta && <div className="mt-1">{step.cta}</div>}
                      </div>
                    </li>
                  ))}
                </ol>
              </div>

              {/* Self-service verification form */}
              {['Agreement Signed', 'Verification Pending'].includes(rancherInfo.onboardingStatus) && !verificationSubmitted && (
                <div className="mt-3 pt-3 border-t border-yellow-300 space-y-3">
                  <p className="text-sm font-medium">Complete Verification</p>
                  <p className="text-xs text-saddle">Provide at least 2 of the following to get verified and go live. This helps us build trust with buyers.</p>

                  <div className="space-y-3">
                    <div>
                      <label className="text-xs font-medium block mb-1">Customer References (names &amp; contact info)</label>
                      <textarea
                        placeholder="e.g. John Smith, johnsmith@email.com — bought a half beef in March, very happy with the quality"
                        value={verificationRefs}
                        onChange={(e) => setVerificationRefs(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-dust min-h-[80px]"
                      />
                      <p className="text-xs text-gray-400 mt-1">We may reach out to confirm. 2-3 references recommended.</p>
                    </div>

                    <div>
                      <label className="text-xs font-medium block mb-1">Google Reviews or Facebook Reviews Link</label>
                      <input
                        type="url"
                        placeholder="https://g.page/your-ranch/review or Facebook page URL"
                        value={verificationReviewsLink}
                        onChange={(e) => setVerificationReviewsLink(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-dust"
                      />
                    </div>

                    <div>
                      <label className="text-xs font-medium block mb-1">Social Media (Instagram, Facebook, etc.)</label>
                      <input
                        type="url"
                        placeholder="https://instagram.com/your-ranch"
                        value={verificationSocial}
                        onChange={(e) => setVerificationSocial(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-dust"
                      />
                    </div>

                    <div>
                      <label className="text-xs font-medium block mb-1">USDA Processing Facility Name</label>
                      <input
                        type="text"
                        placeholder="Name of your USDA-inspected processor"
                        value={verificationProcessor}
                        onChange={(e) => setVerificationProcessor(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-dust"
                      />
                    </div>

                    <div>
                      <label className="text-xs font-medium block mb-1">Certifications (USDA, organic, grass-fed, etc.)</label>
                      <input
                        type="text"
                        placeholder="e.g. USDA Inspected, Certified Angus, Grass-Fed"
                        value={verificationCerts}
                        onChange={(e) => setVerificationCerts(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-dust"
                      />
                    </div>
                  </div>

                  {verificationError && (
                    <div className="p-3 border border-red-300 bg-red-50 text-red-700 text-sm">
                      {verificationError}
                    </div>
                  )}
                  <button
                    onClick={async () => {
                      const filled = [verificationRefs, verificationReviewsLink, verificationSocial, verificationProcessor, verificationCerts].filter(v => v.trim()).length;
                      if (filled < 2) {
                        setVerificationError('Please fill in at least 2 verification fields to submit. 3+ means we auto-approve.');
                        return;
                      }
                      setVerificationError('');
                      setVerificationSubmitting(true);
                      try {
                        const res = await fetch('/api/rancher/landing-page', {
                          method: 'PATCH',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            _action: 'request-verification',
                            verificationMethod: 'digital',
                            customerReferences: verificationRefs.trim(),
                            reviewsLink: verificationReviewsLink.trim(),
                            socialMedia: verificationSocial.trim(),
                            processorName: verificationProcessor.trim(),
                            certifications: verificationCerts.trim(),
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
                    className="w-full py-3 bg-charcoal text-bone text-sm font-medium uppercase tracking-wider hover:bg-saddle transition-colors disabled:opacity-50"
                  >
                    {verificationSubmitting ? 'Submitting...' : 'Submit Verification'}
                  </button>
                </div>
              )}
            </div>
            );
          })()}

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

          {/* Overview Tab */}
          {activeTab === 'overview' && (
            <div className="space-y-8">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <StatCard label="Active Leads" value={stats.activeReferrals} />
                <StatCard label="Deals Closed" value={stats.closedWon} />
                <StatCard label="Total Revenue" value={`$${stats.totalRevenue.toLocaleString()}`} />
                <StatCard label="Your Earnings" value={`$${stats.netEarnings.toLocaleString()}`} sub={`(after ${((rancherInfo.commissionRate ?? 0.10) * 100).toFixed(1)}% commission)`} />
              </div>

              {/* OPTIMIZATION CHECKLIST — drives ranchers to keep filling out
                  their page after onboarding. Pages with all 6 boxes checked
                  convert ~3× better. Only renders if they're missing at least
                  one item — disappears at 6/6 to reward completion. */}
              {(() => {
                const checklist = [
                  {
                    key: 'logo',
                    label: 'Add a ranch logo',
                    done: !!rancherInfo.logoUrl,
                    hint: 'Pages with logos look 10× more legit. PNG/JPG URL.',
                  },
                  {
                    key: 'tagline',
                    label: 'Write a tagline',
                    done: !!rancherInfo.tagline && rancherInfo.tagline.length > 10,
                    hint: 'One-sentence pitch. Goes under your name.',
                  },
                  {
                    key: 'about',
                    label: 'Add your story',
                    done: !!rancherInfo.aboutText && rancherInfo.aboutText.length > 100,
                    hint: 'A few paragraphs about your operation. The biggest conversion lever.',
                  },
                  {
                    key: 'pricing',
                    label: 'Set at least one share price',
                    done: !!(rancherInfo.quarterPrice || rancherInfo.halfPrice || rancherInfo.wholePrice),
                    hint: 'Pages with prices convert ~3× better than "contact for pricing".',
                  },
                  {
                    key: 'gallery',
                    label: 'Add gallery photos',
                    done: (() => {
                      try {
                        const arr = rancherInfo.galleryPhotos
                          ? JSON.parse(rancherInfo.galleryPhotos)
                          : [];
                        return Array.isArray(arr) && arr.length >= 3;
                      } catch {
                        return false;
                      }
                    })(),
                    hint: '3+ photos of your ranch, cattle, or family.',
                  },
                  {
                    key: 'testimonials',
                    label: 'Add a customer testimonial',
                    done: (() => {
                      try {
                        const arr = rancherInfo.testimonials
                          ? JSON.parse(rancherInfo.testimonials)
                          : [];
                        return Array.isArray(arr) && arr.length >= 1;
                      } catch {
                        return false;
                      }
                    })(),
                    hint: 'One quote from a real customer = massive trust boost.',
                  },
                ];
                const doneCount = checklist.filter((c) => c.done).length;
                if (doneCount === checklist.length) return null; // hide at 100%
                return (
                  <div className="border border-dust bg-bone-warm p-5 md:p-6 space-y-4">
                    <div className="flex items-baseline justify-between flex-wrap gap-2">
                      <div>
                        <p className="text-[11px] uppercase tracking-widest text-saddle font-semibold">
                          Optimize your page
                        </p>
                        <h3 className="font-serif text-xl text-charcoal mt-1">
                          {doneCount}/{checklist.length} complete · pages with all 6 convert ~3× better
                        </h3>
                      </div>
                      <button
                        onClick={() => setActiveTab('my_page')}
                        className="text-xs uppercase tracking-widest font-semibold text-charcoal underline underline-offset-2 hover:text-saddle"
                      >
                        Open page editor →
                      </button>
                    </div>
                    {/* Progress bar */}
                    <div className="w-full bg-bone h-2 border border-dust">
                      <div
                        className="h-full bg-sage transition-all"
                        style={{ width: `${(doneCount / checklist.length) * 100}%` }}
                      />
                    </div>
                    <ul className="space-y-2">
                      {checklist.map((item) => (
                        <li key={item.key} className="flex items-start gap-3">
                          <span
                            className={`inline-flex items-center justify-center w-5 h-5 text-[11px] font-bold shrink-0 mt-0.5 ${
                              item.done
                                ? 'bg-sage text-bone'
                                : 'bg-bone border border-dust text-saddle'
                            }`}
                          >
                            {item.done ? '✓' : ''}
                          </span>
                          <div className="flex-1">
                            <p
                              className={`text-sm ${
                                item.done ? 'text-saddle line-through' : 'text-charcoal font-medium'
                              }`}
                            >
                              {item.label}
                            </p>
                            {!item.done && (
                              <p className="text-xs text-saddle mt-0.5 leading-relaxed">
                                {item.hint}
                              </p>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })()}

              <Divider />

              <div className="grid md:grid-cols-2 gap-6">
                <div className="p-6 border border-dust bg-white">
                  <div className="flex justify-between items-center mb-4">
                    <h3 className="font-serif text-xl">Capacity</h3>
                    {!editingCapacity && (
                      <button
                        onClick={() => { setEditingCapacity(true); setCapacityValue(String(rancherInfo.maxActiveReferrals)); }}
                        className="text-xs text-saddle hover:text-charcoal transition-colors"
                      >
                        Edit Max
                      </button>
                    )}
                  </div>
                  <div className="space-y-3">
                    <div className="flex justify-between text-sm">
                      <span className="text-saddle">Active Referrals</span>
                      <span className="font-medium">{rancherInfo.currentActiveReferrals} / {rancherInfo.maxActiveReferrals}</span>
                    </div>
                    <div className="w-full bg-gray-200 h-2">
                      <div
                        className={`h-2 transition-all ${rancherInfo.currentActiveReferrals >= rancherInfo.maxActiveReferrals ? 'bg-weathered' : 'bg-charcoal'}`}
                        style={{ width: `${Math.min(100, (rancherInfo.currentActiveReferrals / rancherInfo.maxActiveReferrals) * 100)}%` }}
                      />
                    </div>
                    <p className="text-xs text-dust">
                      {rancherInfo.currentActiveReferrals >= rancherInfo.maxActiveReferrals
                        ? 'At capacity — new leads paused until a deal closes'
                        : `${rancherInfo.maxActiveReferrals - rancherInfo.currentActiveReferrals} more leads available`}
                    </p>
                    {editingCapacity && (
                      <div className="pt-2 border-t border-dust space-y-2">
                        <label className="text-xs text-saddle">Max active leads at a time</label>
                        <div className="flex gap-2">
                          <input
                            type="number"
                            min="1"
                            max="50"
                            value={capacityValue}
                            onChange={e => setCapacityValue(e.target.value)}
                            className="flex-1 px-3 py-2 border border-dust bg-bone text-sm focus:outline-none focus:border-charcoal"
                          />
                          <button
                            onClick={handleUpdateCapacity}
                            disabled={capacitySaving}
                            className="px-4 py-2 text-xs bg-charcoal text-bone hover:bg-saddle transition-colors disabled:opacity-50"
                          >
                            {capacitySaving ? '...' : 'Save'}
                          </button>
                          <button
                            onClick={() => setEditingCapacity(false)}
                            className="px-3 py-2 text-xs border border-dust hover:bg-dust hover:text-bone transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                        <p className="text-xs text-dust">Set how many buyer leads you can handle at once. We&apos;ll pause new leads when you hit this limit.</p>
                      </div>
                    )}
                  </div>
                </div>

                <div className="p-6 border border-dust bg-white">
                  <h3 className="font-serif text-xl mb-4">Your Operation</h3>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-saddle">State</span>
                      <span>{rancherInfo.state}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-saddle">Beef Types</span>
                      <span>{rancherInfo.beefTypes || 'Not set'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-saddle">Delivers To</span>
                      <span>{rancherInfo.shipsNationwide ? 'Nationwide' : (rancherInfo.statesServed || rancherInfo.state || 'Not set')}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-saddle">Monthly Capacity</span>
                      <span>{rancherInfo.monthlyCapacity} head</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-saddle">Agreement</span>
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
                      <ReferralRow
                        key={ref.id}
                        referral={ref}
                        onUpdate={updateReferralStatus}
                        onClose={() => setCloseModal(ref)}
                        onPass={() => setPassModal(ref)}
                        onLost={() => handleMarkLost(ref)}
                        onSendFinal={() => openFinalInvoiceModal(ref)}
                        updating={updating}
                      />
                    ))}
                    {activeRefs.length > 3 && (
                      <button onClick={() => setActiveTab('referrals')} className="text-sm text-saddle hover:text-charcoal transition-colors">
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
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <h2 className="font-serif text-2xl">Active Leads</h2>
                {activeRefs.length > 3 && (
                  <div className="flex flex-wrap gap-2 text-sm">
                    <select
                      value={buyerFilter}
                      onChange={(e) => setBuyerFilter(e.target.value as any)}
                      className="px-3 py-1.5 border border-dust bg-bone text-charcoal text-xs uppercase tracking-wide focus:outline-none focus:border-charcoal"
                    >
                      <option value="all">All ({activeRefs.length})</option>
                      <option value="Intro Sent">Intro Sent ({activeRefs.filter(r => r.status === 'Intro Sent').length})</option>
                      <option value="Rancher Contacted">Contacted ({activeRefs.filter(r => r.status === 'Rancher Contacted').length})</option>
                      <option value="Negotiation">Negotiation ({activeRefs.filter(r => r.status === 'Negotiation').length})</option>
                      <option value="stale">Stale 14d+ (needs follow-up)</option>
                    </select>
                    <select
                      value={buyerSort}
                      onChange={(e) => setBuyerSort(e.target.value as any)}
                      className="px-3 py-1.5 border border-dust bg-bone text-charcoal text-xs uppercase tracking-wide focus:outline-none focus:border-charcoal"
                    >
                      <option value="newest">Newest first</option>
                      <option value="oldest">Oldest first</option>
                      <option value="stalest">Stalest activity</option>
                    </select>
                  </div>
                )}
              </div>
              {(() => {
                // Apply filter + sort. Pure-function — no side effects.
                let filtered = [...activeRefs];
                if (buyerFilter === 'stale') {
                  const now = Date.now();
                  const FOURTEEN_D_MS = 14 * 86_400_000;
                  filtered = filtered.filter((r) => {
                    const last = r.last_rancher_activity_at || r.intro_sent_at || r.created_at;
                    if (!last) return false;
                    return now - new Date(last).getTime() >= FOURTEEN_D_MS;
                  });
                } else if (buyerFilter !== 'all') {
                  filtered = filtered.filter((r) => r.status === buyerFilter);
                }
                if (buyerSort === 'newest') {
                  filtered.sort((a, b) =>
                    new Date(b.intro_sent_at || b.created_at).getTime() -
                    new Date(a.intro_sent_at || a.created_at).getTime()
                  );
                } else if (buyerSort === 'oldest') {
                  filtered.sort((a, b) =>
                    new Date(a.intro_sent_at || a.created_at).getTime() -
                    new Date(b.intro_sent_at || b.created_at).getTime()
                  );
                } else if (buyerSort === 'stalest') {
                  filtered.sort((a, b) => {
                    const aLast = new Date(a.last_rancher_activity_at || a.intro_sent_at || a.created_at).getTime();
                    const bLast = new Date(b.last_rancher_activity_at || b.intro_sent_at || b.created_at).getTime();
                    return aLast - bLast;
                  });
                }
                return filtered.length > 0 ? (
                  <div className="space-y-4">
                    {filtered.map((ref) => (
                      <ReferralCard
                        key={ref.id}
                        referral={ref}
                        onUpdate={updateReferralStatus}
                        onClose={() => setCloseModal(ref)}
                        onPass={() => setPassModal(ref)}
                        onLost={() => handleMarkLost(ref)}
                        onSendFinal={() => openFinalInvoiceModal(ref)}
                        updating={updating}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="p-8 border border-dust text-center bg-white">
                    <p className="text-saddle">No leads match the current filter.</p>
                  </div>
                );
              })()}
              {/* Legacy empty state — shown when zero active leads total */}
              {activeRefs.length === 0 && (
                <div className="p-8 border border-dust text-center bg-white">
                  <p className="text-saddle">No active leads right now. New buyer introductions will appear here.</p>
                </div>
              )}

              {closedRefs.length > 0 && (
                <>
                  <Divider />
                  <h2 className="font-serif text-2xl">Closed Deals</h2>
                  <div className="space-y-4">
                    {closedRefs.map((ref) => (
                      <div key={ref.id} className="border border-dust bg-white">
                        <div className="p-4 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                          <div>
                            <span className={`inline-block px-2 py-0.5 text-xs font-medium ${statusStyles[ref.status] || 'bg-gray-100 text-gray-600'}`}>
                              {ref.status}
                            </span>
                            <p className="font-medium mt-1">{ref.buyer_name}</p>
                            <p className="text-xs text-dust">{ref.closed_at ? new Date(ref.closed_at).toLocaleDateString() : ''}</p>
                          </div>
                          <div className="flex items-center gap-3">
                            {ref.status === 'Closed Won' && (
                              <div className="text-right">
                                <p className="font-serif text-lg">${ref.sale_amount.toLocaleString()}</p>
                                <p className="text-xs text-dust">Commission: ${ref.commission_due.toLocaleString()}</p>
                              </div>
                            )}
                            {isAdminImpersonating && ref.status === 'Closed Lost' && (
                              <button
                                onClick={() => handleReviveLead(ref)}
                                disabled={updating === ref.id}
                                className="px-3 py-1.5 text-xs border border-charcoal bg-charcoal text-bone hover:bg-saddle disabled:opacity-50"
                                title="Admin only: flip this Closed Lost back to an actionable status. Audit fires to Telegram."
                              >
                                ♻️ Revive Lead
                              </button>
                            )}
                          </div>
                        </div>
                        {/* Stage-3 Audit B4 — fulfillment confirm row. Gated on tier_v2 + Closed Won.
                            Legacy ranchers use the post-close commission invoice flow, not fulfillment confirm. */}
                        {ref.status === 'Closed Won' && rancherInfo.pricingModel === 'tier_v2' && (
                          <FulfillmentConfirmRow
                            referral={ref}
                            onConfirmed={(when) => {
                              // Optimistic update — flip just this referral's fulfillment_confirmed_at
                              // so the pill renders without a full dashboard refetch latency hit.
                              setReferrals((prev) =>
                                prev.map((r) =>
                                  r.id === ref.id ? { ...r, fulfillment_confirmed_at: when } : r,
                                ),
                              );
                            }}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Marketing Tab — BUILD-6 (2026-05-29) ──────────────────────────
              Surfaces what BHC actively runs FOR the rancher. Static cards
              w/ real links + counts where available; placeholder text for
              data not yet wired (paid ad spend, impressions, etc).
              Goal: rancher sees the value being generated on their behalf,
              not just the leads. */}
          {activeTab === 'marketing' && (
            <div className="space-y-6">
              <div>
                <h2 className="font-serif text-2xl text-charcoal">Marketing engine</h2>
                <p className="text-sm text-saddle mt-1">
                  What BHC is running on your behalf right now. We bring the buyers
                  to your state — you close them.
                </p>
              </div>

              {/* Traffic + reach */}
              <div className="bg-bone-warm border border-dust p-5 md:p-6 space-y-4">
                <p className="text-xs uppercase tracking-widest text-saddle font-semibold">
                  Traffic &amp; reach in {rancherInfo.state || 'your state'}
                </p>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="bg-bone border border-dust p-4">
                    <p className="text-[11px] uppercase tracking-widest text-saddle">
                      State landing page
                    </p>
                    <p className="font-serif text-base text-charcoal mt-1.5 mb-2">
                      /access/{(rancherInfo.state || 'mt').toLowerCase()}
                    </p>
                    <a
                      href={`/access/${(rancherInfo.state || 'mt').toLowerCase()}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-saddle underline underline-offset-2 hover:text-charcoal"
                    >
                      Preview page →
                    </a>
                  </div>
                  <div className="bg-bone border border-dust p-4">
                    <p className="text-[11px] uppercase tracking-widest text-saddle">
                      Public map listing
                    </p>
                    <p className="font-serif text-base text-charcoal mt-1.5 mb-2">
                      Pinned in {rancherInfo.state || 'your state'}
                    </p>
                    <a
                      href="/map"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-saddle underline underline-offset-2 hover:text-charcoal"
                    >
                      View map →
                    </a>
                  </div>
                  <div className="bg-bone border border-dust p-4">
                    <p className="text-[11px] uppercase tracking-widest text-saddle">
                      Paid ads (Meta + Google)
                    </p>
                    <p className="font-serif text-base text-charcoal mt-1.5 mb-2">
                      Always-on in your state
                    </p>
                    <p className="text-xs text-saddle italic">
                      Live spend dashboard coming soon
                    </p>
                  </div>
                </div>
              </div>

              {/* Conversion engine */}
              <div className="bg-bone-warm border border-dust p-5 md:p-6 space-y-4">
                <p className="text-xs uppercase tracking-widest text-saddle font-semibold">
                  Conversion engine running for you
                </p>
                <ul className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 text-sm text-charcoal/90 leading-snug">
                  <li>✓ Auto-routing — buyers in your state matched + emailed within minutes</li>
                  <li>✓ Launch warmup — waitlist gets YES-button email when you go live</li>
                  <li>✓ Ready-to-buy sequence — pre-engagement emails before match</li>
                  <li>✓ Hot-lead bypass — engaged buyers route around capacity caps</li>
                  <li>✓ Re-warm cohort — dormant buyers re-engaged automatically</li>
                  <li>✓ Multi-state routing — if your routing states are approved</li>
                </ul>
              </div>

              {/* Lead management */}
              <div className="bg-bone-warm border border-dust p-5 md:p-6 space-y-4">
                <p className="text-xs uppercase tracking-widest text-saddle font-semibold">
                  Lead management
                </p>
                <ul className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 text-sm text-charcoal/90 leading-snug">
                  <li>✓ Real-time Telegram alerts on every new lead</li>
                  <li>✓ One-click email buttons (Won / Lost / Pass) — no login needed</li>
                  <li>✓ AI reply triage — classifies inbound buyer responses</li>
                  <li>✓ Auto-responses for ghosting + scheduling Qs</li>
                  <li>✓ Capacity guard — never over-route past your max</li>
                  <li>✓ Buyer health tracking — flags time-wasters cross-rancher</li>
                </ul>
              </div>

              {/* Cross-promo + exposure */}
              <div className="bg-bone-warm border border-dust p-5 md:p-6 space-y-4">
                <p className="text-xs uppercase tracking-widest text-saddle font-semibold">
                  Brand exposure on BHC properties
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="bg-bone border border-dust p-4 space-y-1.5">
                    <p className="text-[11px] uppercase tracking-widest text-saddle">
                      Founders campaign
                    </p>
                    <p className="text-sm text-charcoal leading-snug">
                      Every backer email + the /founders wall mentions verified ranchers
                    </p>
                  </div>
                  <div className="bg-bone border border-dust p-4 space-y-1.5">
                    <p className="text-[11px] uppercase tracking-widest text-saddle">
                      Brand partners
                    </p>
                    <p className="text-sm text-charcoal leading-snug">
                      Partner pages (knife makers, etc) cross-link verified ranchers
                    </p>
                  </div>
                  <div className="bg-bone border border-dust p-4 space-y-1.5">
                    <p className="text-[11px] uppercase tracking-widest text-saddle">
                      Affiliate engine
                    </p>
                    <p className="text-sm text-charcoal leading-snug">
                      Your Closed Won buyers auto-enroll as affiliates — refer-a-rancher
                    </p>
                  </div>
                  <div className="bg-bone border border-dust p-4 space-y-1.5">
                    <p className="text-[11px] uppercase tracking-widest text-saddle">
                      Wholesale funnel
                    </p>
                    <p className="text-sm text-charcoal leading-snug">
                      Restaurants + butchers route through /wholesale — your state surfaces
                    </p>
                  </div>
                </div>
              </div>

              {/* Compliance + ops */}
              <div className="border border-dust p-5 md:p-6 space-y-3">
                <p className="text-xs uppercase tracking-widest text-saddle font-semibold">
                  Handled for you in the background
                </p>
                <p className="text-sm text-charcoal/85 leading-relaxed">
                  TCPA-compliant SMS opt-in · suppression list (bounces + complaints auto-honored)
                  · cron observability + operator escalation · JWT rotation + Redis fail-open
                  · audit logs on every approve/reject/close action · capacity drift recovery
                  · Stripe webhook signing · payment dispute monitoring.
                </p>
              </div>

              {/* Want more */}
              <div className="bg-charcoal text-bone p-5 md:p-6 space-y-3">
                <p className="text-xs uppercase tracking-widest text-bone/70 font-semibold">
                  Want even more visibility?
                </p>
                <p className="text-sm leading-relaxed">
                  Upgrade to tier_v2 unlocks: priority placement, featured ranch
                  badge, homepage rotation slot. Top tier adds 0% commission + a
                  dedicated brand strategist running monthly content + social
                  cadence for you.
                </p>
                <a
                  href="/rancher/billing"
                  className="inline-flex items-center gap-2 px-5 py-2.5 bg-bone text-charcoal text-xs font-medium tracking-wide uppercase hover:bg-bone-warm transition-base"
                >
                  See tier options →
                </a>
              </div>
            </div>
          )}

          {/* Earnings Tab */}
          {activeTab === 'earnings' && (
            <div className="space-y-8">
              <h2 className="font-serif text-2xl">Earnings Summary</h2>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <StatCard label="Total Revenue" value={`$${stats.totalRevenue.toLocaleString()}`} />
                <StatCard label={`Commission (${((rancherInfo.commissionRate ?? 0.10) * 100).toFixed(1)}%)`} value={`$${stats.totalCommission.toLocaleString()}`} />
                <StatCard label="Your Net" value={`$${stats.netEarnings.toLocaleString()}`} />
                <StatCard label="Unpaid Commission" value={`$${stats.unpaidCommission.toLocaleString()}`} sub={stats.unpaidCommission > 0 ? 'Invoice pending' : ''} />
              </div>

              <Divider />

              <h3 className="font-serif text-xl">Completed Sales</h3>
              {referrals.filter(r => r.status === 'Closed Won').length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-dust text-left">
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
                            {!ref.commission_paid && ref.stripe_invoice_url && (
                              <a
                                href={ref.stripe_invoice_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="ml-2 text-xs text-saddle hover:text-charcoal underline underline-offset-2"
                              >
                                Pay now →
                              </a>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="p-8 border border-dust text-center bg-white">
                  <p className="text-saddle">No completed sales yet. Close your first deal to see earnings here.</p>
                </div>
              )}
            </div>
          )}

          {/* Network Benefits Tab */}
          {activeTab === 'benefits' && (
            <div className="space-y-6">
              <div>
                <h2 className="font-serif text-2xl">Network Benefits</h2>
                <p className="text-sm text-saddle mt-1">
                  Exclusive deals and partnerships available to BuyHalfCow ranchers.
                </p>
              </div>

              {benefits.length > 0 ? (
                <div className="grid gap-4 md:grid-cols-2">
                  {benefits.map((benefit) => (
                    <div key={benefit.id} className="p-6 border border-dust bg-white space-y-3">
                      <div className="flex items-start justify-between">
                        <h3 className="font-serif text-lg">{benefit.brand_name}</h3>
                        {benefit.discount_offered > 0 && (
                          <span className="px-2 py-1 text-xs font-bold bg-green-100 text-green-800">
                            {benefit.discount_offered}% OFF
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-saddle">{benefit.product_type}</p>
                      {benefit.description && (
                        <p className="text-sm">{benefit.description}</p>
                      )}
                      <div className="flex gap-3 pt-2">
                        {benefit.website && (
                          <a
                            href={benefit.website.startsWith('http') ? benefit.website : `https://${benefit.website}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="px-4 py-2 text-xs border border-charcoal hover:bg-charcoal hover:text-bone transition-colors"
                          >
                            Visit Website
                          </a>
                        )}
                        {benefit.contact_email && (
                          <a
                            href={`mailto:${benefit.contact_email}`}
                            className="px-4 py-2 text-xs border border-dust hover:bg-dust hover:text-bone transition-colors"
                          >
                            Contact
                          </a>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-8 border border-dust text-center bg-white">
                  <p className="text-saddle">Partner benefits are being finalized. Check back soon for exclusive deals on insurance, equipment, and more.</p>
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
                  <p className="text-sm text-saddle mt-1">
                    Fill this out to publish your public ranch page on BuyHalfCow.
                  </p>
                </div>
                {rancherInfo.slug && (
                  <a
                    href={`/ranchers/${rancherInfo.slug}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm px-4 py-2 border border-charcoal hover:bg-charcoal hover:text-bone transition-colors"
                  >
                    Preview Page →
                  </a>
                )}
              </div>

              {!rancherInfo.pageLive && (
                <div className="p-4 bg-yellow-50 border border-yellow-400 text-sm text-saddle flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                  <p>Your page is not live yet. Fill out the fields below and request to go live when you&apos;re ready.</p>
                  {goLiveRequested ? (
                    <span className="text-xs bg-green-100 text-green-800 px-3 py-1.5 whitespace-nowrap">Request sent!</span>
                  ) : (
                    <button
                      onClick={handleRequestGoLive}
                      disabled={goLiveLoading || !rancherInfo.slug}
                      className="px-4 py-2 text-xs bg-charcoal text-bone hover:bg-saddle transition-colors whitespace-nowrap disabled:opacity-50"
                    >
                      {goLiveLoading ? 'Requesting...' : 'Request Go Live'}
                    </button>
                  )}
                </div>
              )}

              {/* Page Click Stats */}
              {rancherInfo.pageLive && (rancherInfo.quarterClicks > 0 || rancherInfo.halfClicks > 0 || rancherInfo.wholeClicks > 0) && (
                <div className="grid grid-cols-3 gap-4">
                  <div className="p-4 border border-dust bg-white text-center">
                    <div className="font-serif text-2xl">{rancherInfo.quarterClicks}</div>
                    <p className="text-xs text-saddle mt-1 uppercase tracking-wider">Quarter Clicks</p>
                  </div>
                  <div className="p-4 border border-dust bg-white text-center">
                    <div className="font-serif text-2xl">{rancherInfo.halfClicks}</div>
                    <p className="text-xs text-saddle mt-1 uppercase tracking-wider">Half Clicks</p>
                  </div>
                  <div className="p-4 border border-dust bg-white text-center">
                    <div className="font-serif text-2xl">{rancherInfo.wholeClicks}</div>
                    <p className="text-xs text-saddle mt-1 uppercase tracking-wider">Whole Clicks</p>
                  </div>
                </div>
              )}

              <div className="grid md:grid-cols-2 gap-8">

                {/* Left column: Brand & Story */}
                <div className="space-y-5">
                  <h3 className="font-serif text-lg border-b border-dust pb-2">Brand &amp; Story</h3>

                  <div className="space-y-1">
                    <label className="block text-sm font-medium">Page URL Slug <span className="text-dust font-normal">(e.g. rocking-r-ranch)</span></label>
                    <input
                      type="text"
                      value={pageForm['Slug'] || ''}
                      onChange={e => setPageForm(p => ({ ...p, 'Slug': e.target.value }))}
                      placeholder="your-ranch-name"
                      className="w-full px-4 py-3 border border-dust bg-bone focus:outline-none focus:border-charcoal text-sm"
                    />
                    {pageForm['Slug'] && (
                      <p className="text-xs text-dust">buyhalfcow.com/ranchers/{pageForm['Slug'].toLowerCase().replace(/[^a-z0-9-]/g, '-')}</p>
                    )}
                  </div>

                  <ImageUploader
                    label="Logo"
                    hint="(your ranch logo — shows on your public page)"
                    value={pageForm['Logo URL'] || ''}
                    onChange={(url) => setPageForm(p => ({ ...p, 'Logo URL': url }))}
                  />

                  <div className="space-y-3">
                    <label className="block text-sm font-medium">Gallery Photos <span className="text-dust font-normal">(up to 8 — cattle, the operation, your family, what makes your ranch yours)</span></label>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      {galleryPhotos.map((url, i) => (
                        <div key={`${url}-${i}`} className="relative group">
                          <img
                            src={url}
                            alt={`Gallery ${i + 1}`}
                            className="w-full aspect-square object-cover border border-dust"
                            onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0.3'; }}
                          />
                          <button
                            type="button"
                            onClick={() => setGalleryPhotos(galleryPhotos.filter((_, idx) => idx !== i))}
                            className="absolute top-1 right-1 px-2 py-0.5 bg-charcoal text-bone text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                            title="Remove"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                    {galleryPhotos.length < 8 ? (
                      <ImageUploader
                        label=""
                        hint={`Add photo ${galleryPhotos.length + 1} of 8`}
                        value=""
                        onChange={(url) => {
                          if (url) setGalleryPhotos([...galleryPhotos, url]);
                        }}
                      />
                    ) : (
                      <p className="text-xs text-dust">Max 8 photos. Remove one to add another.</p>
                    )}
                  </div>

                  <div className="space-y-1">
                    <label className="block text-sm font-medium">Tagline <span className="text-dust font-normal">(one sentence)</span></label>
                    <input
                      type="text"
                      value={pageForm['Tagline'] || ''}
                      onChange={e => setPageForm(p => ({ ...p, 'Tagline': e.target.value }))}
                      placeholder="Grass-fed Angus raised on open pasture in Montana"
                      className="w-full px-4 py-3 border border-dust bg-bone focus:outline-none focus:border-charcoal text-sm"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="block text-sm font-medium">About Your Ranch</label>
                    <textarea
                      rows={6}
                      value={pageForm['About Text'] || ''}
                      onChange={e => setPageForm(p => ({ ...p, 'About Text': e.target.value }))}
                      placeholder="Tell buyers your story — how long you've been ranching, your practices, what makes you different..."
                      className="w-full px-4 py-3 border border-dust bg-bone focus:outline-none focus:border-charcoal text-sm"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="block text-sm font-medium">Interview Video URL <span className="text-dust font-normal">(YouTube link)</span></label>
                    <input
                      type="url"
                      value={pageForm['Video URL'] || ''}
                      onChange={e => setPageForm(p => ({ ...p, 'Video URL': e.target.value }))}
                      placeholder="https://youtube.com/watch?v=..."
                      className="w-full px-4 py-3 border border-dust bg-bone focus:outline-none focus:border-charcoal text-sm"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="block text-sm font-medium">Custom Notes <span className="text-dust font-normal">(optional — anything extra buyers should know)</span></label>
                    <textarea
                      rows={3}
                      value={pageForm['Custom Notes'] || ''}
                      onChange={e => setPageForm(p => ({ ...p, 'Custom Notes': e.target.value }))}
                      placeholder="e.g. We do on-farm pickup only. Delivery available within 50 miles..."
                      className="w-full px-4 py-3 border border-dust bg-bone focus:outline-none focus:border-charcoal text-sm"
                    />
                  </div>

                  <h3 className="font-serif text-lg border-b border-dust pb-2 pt-4">Delivery &amp; Details</h3>

                  <div className="space-y-1">
                    <label className="block text-sm font-medium">Beef Types <span className="text-dust font-normal">(e.g. Angus, Hereford, Wagyu)</span></label>
                    <input
                      type="text"
                      value={pageForm['Beef Types'] || ''}
                      onChange={e => setPageForm(p => ({ ...p, 'Beef Types': e.target.value }))}
                      placeholder="Angus, Hereford"
                      className="w-full px-4 py-3 border border-dust bg-bone focus:outline-none focus:border-charcoal text-sm"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="block text-sm font-medium">Certifications <span className="text-dust font-normal">(e.g. USDA, Grass-Fed, Organic)</span></label>
                    <input
                      type="text"
                      value={pageForm['Certifications'] || ''}
                      onChange={e => setPageForm(p => ({ ...p, 'Certifications': e.target.value }))}
                      placeholder="USDA Inspected, Grass-Fed, No Hormones"
                      className="w-full px-4 py-3 border border-dust bg-bone focus:outline-none focus:border-charcoal text-sm"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="block text-sm font-medium">Team Emails <span className="text-dust font-normal">(extra logins for spouse, hired help, etc.)</span></label>
                    <textarea
                      value={pageForm['Team Emails'] || ''}
                      onChange={e => setPageForm(p => ({ ...p, 'Team Emails': e.target.value }))}
                      placeholder="spouse@ranch.com&#10;ranchhand@ranch.com"
                      rows={2}
                      className="w-full px-4 py-3 border border-dust bg-bone focus:outline-none focus:border-charcoal text-sm font-mono"
                    />
                    <p className="text-xs text-dust">
                      One email per line. Anyone listed here can request a login link at /rancher/login and access this dashboard. Primary email always works regardless.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <label className="block text-sm font-medium">States You Want To Serve</label>
                    <p className="text-xs text-dust">
                      Tap the states you&apos;d like buyers from. We review your request and turn on
                      routing once your capacity and verification check out.
                      <strong className="text-charcoal"> Your home state is always included.</strong>
                    </p>
                    <StateMultiSelect
                      value={pageForm['Preferred States'] || ''}
                      onChange={(v) => setPageForm(p => ({ ...p, 'Preferred States': v }))}
                    />
                    {(() => {
                      const preferred = new Set(
                        (pageForm['Preferred States'] || '')
                          .split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
                      );
                      const routing = new Set(
                        (rancherInfo.routingStates || '')
                          .split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
                      );
                      const live = Array.from(preferred).filter(s => routing.has(s));
                      const pending = Array.from(preferred).filter(s => !routing.has(s));
                      const muted = Array.from(routing).filter(s => !preferred.has(s));
                      return (
                        <div className="mt-3 space-y-2 text-xs">
                          {live.length > 0 && (
                            <div className="flex items-start gap-2">
                              <span className="font-bold text-green-700 shrink-0">✓ Routing live:</span>
                              <span className="font-mono text-charcoal">{live.join(', ')}</span>
                            </div>
                          )}
                          {pending.length > 0 && (
                            <div className="flex items-start gap-2">
                              <span className="font-bold text-amber-700 shrink-0">⏳ Pending review:</span>
                              <span className="font-mono text-charcoal">{pending.join(', ')}</span>
                            </div>
                          )}
                          {muted.length > 0 && (
                            <div className="flex items-start gap-2">
                              <span className="font-bold text-dust shrink-0">— Removed by you:</span>
                              <span className="font-mono text-dust">{muted.join(', ')}</span>
                            </div>
                          )}
                          {preferred.size === 0 && routing.size === 0 && (
                            <p className="text-dust italic">No states selected yet — pick the states you can deliver to above.</p>
                          )}
                        </div>
                      );
                    })()}
                  </div>

                  <div className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      id="shipsNationwide"
                      checked={pageForm['Ships Nationwide'] === 'true'}
                      onChange={e => setPageForm(p => ({ ...p, 'Ships Nationwide': e.target.checked ? 'true' : '' }))}
                      className="w-4 h-4"
                    />
                    <label htmlFor="shipsNationwide" className="text-sm">We ship nationwide</label>
                  </div>
                </div>

                {/* Right column: Pricing */}
                <div className="space-y-5">
                  <h3 className="font-serif text-lg border-b border-dust pb-2">Pricing &amp; Payment</h3>
                  <p className="text-xs text-dust">Leave a section blank if you don't offer that cut size. Payment links go to your Square, PayPal, or Stripe checkout.</p>

                  {/* Quarter */}
                  <div className="p-4 border border-dust bg-white space-y-3">
                    <p className="text-sm font-medium uppercase tracking-wider">Quarter</p>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-xs text-dust">Price ($)</label>
                        <input
                          type="number"
                          value={pageForm['Quarter Price'] || ''}
                          onChange={e => setPageForm(p => ({ ...p, 'Quarter Price': e.target.value }))}
                          placeholder="450"
                          className="w-full px-3 py-2 border border-dust bg-bone focus:outline-none focus:border-charcoal text-sm"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-dust">Approx. lbs</label>
                        <input
                          type="text"
                          value={pageForm['Quarter lbs'] || ''}
                          onChange={e => setPageForm(p => ({ ...p, 'Quarter lbs': e.target.value }))}
                          placeholder="~85 lbs"
                          className="w-full px-3 py-2 border border-dust bg-bone focus:outline-none focus:border-charcoal text-sm"
                        />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-dust">Payment Link</label>
                      <input
                        type="url"
                        value={pageForm['Quarter Payment Link'] || ''}
                        onChange={e => setPageForm(p => ({ ...p, 'Quarter Payment Link': e.target.value }))}
                        placeholder="https://square.com/pay/..."
                        className="w-full px-3 py-2 border border-dust bg-bone focus:outline-none focus:border-charcoal text-sm"
                      />
                    </div>
                  </div>

                  {/* Half */}
                  <div className="p-4 border-2 border-saddle bg-white space-y-3">
                    <p className="text-sm font-medium uppercase tracking-wider text-saddle">Half <span className="text-xs font-normal normal-case text-dust">(most popular)</span></p>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-xs text-dust">Price ($)</label>
                        <input
                          type="number"
                          value={pageForm['Half Price'] || ''}
                          onChange={e => setPageForm(p => ({ ...p, 'Half Price': e.target.value }))}
                          placeholder="875"
                          className="w-full px-3 py-2 border border-dust bg-bone focus:outline-none focus:border-charcoal text-sm"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-dust">Approx. lbs</label>
                        <input
                          type="text"
                          value={pageForm['Half lbs'] || ''}
                          onChange={e => setPageForm(p => ({ ...p, 'Half lbs': e.target.value }))}
                          placeholder="~170 lbs"
                          className="w-full px-3 py-2 border border-dust bg-bone focus:outline-none focus:border-charcoal text-sm"
                        />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-dust">Payment Link</label>
                      <input
                        type="url"
                        value={pageForm['Half Payment Link'] || ''}
                        onChange={e => setPageForm(p => ({ ...p, 'Half Payment Link': e.target.value }))}
                        placeholder="https://square.com/pay/..."
                        className="w-full px-3 py-2 border border-dust bg-bone focus:outline-none focus:border-charcoal text-sm"
                      />
                    </div>
                  </div>

                  {/* Whole */}
                  <div className="p-4 border border-dust bg-white space-y-3">
                    <p className="text-sm font-medium uppercase tracking-wider">Whole</p>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-xs text-dust">Price ($)</label>
                        <input
                          type="number"
                          value={pageForm['Whole Price'] || ''}
                          onChange={e => setPageForm(p => ({ ...p, 'Whole Price': e.target.value }))}
                          placeholder="1600"
                          className="w-full px-3 py-2 border border-dust bg-bone focus:outline-none focus:border-charcoal text-sm"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-dust">Approx. lbs</label>
                        <input
                          type="text"
                          value={pageForm['Whole lbs'] || ''}
                          onChange={e => setPageForm(p => ({ ...p, 'Whole lbs': e.target.value }))}
                          placeholder="~340 lbs"
                          className="w-full px-3 py-2 border border-dust bg-bone focus:outline-none focus:border-charcoal text-sm"
                        />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-dust">Payment Link</label>
                      <input
                        type="url"
                        value={pageForm['Whole Payment Link'] || ''}
                        onChange={e => setPageForm(p => ({ ...p, 'Whole Payment Link': e.target.value }))}
                        placeholder="https://square.com/pay/..."
                        className="w-full px-3 py-2 border border-dust bg-bone focus:outline-none focus:border-charcoal text-sm"
                      />
                    </div>
                  </div>

                  <Divider />

                  {/* Reservation */}
                  <div className="space-y-3">
                    <p className="text-sm font-medium">Reservation / Deposit</p>
                    <div className="space-y-1">
                      <label className="text-xs text-dust">Next Processing Date</label>
                      <input
                        type="date"
                        value={pageForm['Next Processing Date'] || ''}
                        onChange={e => setPageForm(p => ({ ...p, 'Next Processing Date': e.target.value }))}
                        className="w-full px-3 py-2 border border-dust bg-bone focus:outline-none focus:border-charcoal text-sm"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-dust">Reserve Link <span className="text-dust">(deposit / waitlist link)</span></label>
                      <input
                        type="url"
                        value={pageForm['Reserve Link'] || ''}
                        onChange={e => setPageForm(p => ({ ...p, 'Reserve Link': e.target.value }))}
                        placeholder="https://..."
                        className="w-full px-3 py-2 border border-dust bg-bone focus:outline-none focus:border-charcoal text-sm"
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Custom Products */}
              <div className="space-y-4">
                <h3 className="font-serif text-lg border-b border-dust pb-2">Additional Products</h3>
                <p className="text-xs text-dust">List extra products beyond quarter/half/whole beef (sampler boxes, jerky, bones, etc.).</p>
                {customProducts.map((p, i) => (
                  <div key={i} className="p-3 border border-dust bg-white flex justify-between items-start">
                    <div>
                      <p className="text-sm font-medium">{p.name} — ${p.price}</p>
                      {p.description && <p className="text-xs text-saddle mt-0.5">{p.description}</p>}
                      {p.link && <p className="text-xs text-dust mt-0.5 truncate max-w-xs">{p.link}</p>}
                    </div>
                    <button onClick={() => setCustomProducts(customProducts.filter((_, idx) => idx !== i))} className="text-red-500 text-xs hover:underline ml-2">Remove</button>
                  </div>
                ))}
                <div className="grid grid-cols-2 gap-2">
                  <input value={newProduct.name} onChange={e => setNewProduct({ ...newProduct, name: e.target.value })}
                    className="px-3 py-2 border border-dust bg-bone text-sm focus:outline-none focus:border-charcoal" placeholder="Product name" />
                  <input value={newProduct.price} onChange={e => setNewProduct({ ...newProduct, price: e.target.value })}
                    type="number" className="px-3 py-2 border border-dust bg-bone text-sm focus:outline-none focus:border-charcoal" placeholder="Price ($)" />
                </div>
                <input value={newProduct.description} onChange={e => setNewProduct({ ...newProduct, description: e.target.value })}
                  className="w-full px-3 py-2 border border-dust bg-bone text-sm focus:outline-none focus:border-charcoal" placeholder="Short description (e.g. 10 lbs of mixed cuts)" />
                <div className="flex gap-2">
                  <input value={newProduct.link} onChange={e => setNewProduct({ ...newProduct, link: e.target.value })}
                    className="flex-1 px-3 py-2 border border-dust bg-bone text-sm focus:outline-none focus:border-charcoal" placeholder="Payment link (https://...)" />
                  <button
                    onClick={() => {
                      if (!newProduct.name || !newProduct.price) return;
                      setCustomProducts([...customProducts, { ...newProduct, price: parseFloat(newProduct.price) || 0 }]);
                      setNewProduct({ name: '', price: '', description: '', link: '' });
                    }}
                    className="px-4 py-2 text-sm bg-charcoal text-bone hover:bg-saddle transition-colors"
                  >
                    + Add
                  </button>
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
                  className="px-8 py-3 bg-charcoal text-bone hover:bg-saddle transition-colors font-medium uppercase text-sm tracking-wider disabled:opacity-50"
                >
                  {pageSaving ? 'Saving...' : 'Save Page'}
                </button>
                {!rancherInfo.pageLive && rancherInfo.slug && (
                  <p className="text-xs text-dust">
                    After saving, click &quot;Request Go Live&quot; above to notify us.
                  </p>
                )}
              </div>
            </div>
          )}

          <Divider />

          <div className="text-center text-sm text-dust space-y-2">
            <p>Questions? Email <a href="mailto:support@buyhalfcow.com" className="text-charcoal hover:text-saddle transition-colors">support@buyhalfcow.com</a></p>
            <Link href="/" className="text-saddle hover:text-charcoal transition-colors">
              &larr; Back to home
            </Link>
          </div>
        </div>
      </Container>

      {/* Mark Lost Modal — Audit #17 (2026-05-28) replaces window.prompt */}
      {lostModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-bone p-8 max-w-md w-full space-y-6">
            <div className="flex justify-between items-start">
              <h2 className="font-serif text-2xl">Mark Closed Lost</h2>
              <button onClick={() => { setLostModal(null); setUpdateError(''); }} className="text-2xl leading-none hover:text-saddle">×</button>
            </div>
            <p className="text-sm text-saddle">Buyer: <strong className="text-charcoal">{lostModal.buyer_name}</strong></p>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-2">Reason</label>
                <select
                  value={lostReasonCode}
                  onChange={(e) => setLostReasonCode(e.target.value as typeof lostReasonCode)}
                  className="w-full px-4 py-3 border border-dust bg-bone focus:outline-none focus:border-charcoal"
                >
                  <option value="no_response">Buyer ghosted / never responded</option>
                  <option value="price">Price / budget mismatch</option>
                  <option value="not_a_fit">Not a fit</option>
                  <option value="other">Other</option>
                </select>
                <p className="text-xs text-saddle mt-2">
                  "Buyer ghosted" flags the buyer as Non-Responsive after 2 such marks across ranchers — helps us reroute future leads away from time-wasters.
                </p>
              </div>

              {lostReasonCode === 'other' && (
                <div>
                  <label className="block text-sm font-medium mb-2">Tell us why</label>
                  <textarea
                    value={lostFreeText}
                    onChange={(e) => setLostFreeText(e.target.value)}
                    rows={3}
                    placeholder="What happened?"
                    className="w-full px-4 py-3 border border-dust bg-bone focus:outline-none focus:border-charcoal"
                  />
                </div>
              )}
            </div>

            {updateError && (
              <div className="p-3 border border-[#8C2F2F] text-[#8C2F2F] text-sm">
                {updateError}
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={() => { setLostModal(null); setUpdateError(''); }}
                className="flex-1 px-4 py-3 border border-charcoal text-charcoal hover:bg-charcoal hover:text-bone transition-colors font-medium uppercase text-sm tracking-wider"
              >
                Cancel
              </button>
              <button
                onClick={submitMarkLost}
                disabled={!!updating || (lostReasonCode === 'other' && !lostFreeText.trim())}
                className="flex-1 px-4 py-3 bg-charcoal text-bone hover:bg-saddle transition-colors font-medium uppercase text-sm tracking-wider disabled:opacity-50"
              >
                {updating ? 'Saving...' : 'Confirm Closed Lost'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Final Invoice Modal — FINAL-5 (2026-05-31). For tier_v2 Stripe Connect
          ranchers — after the buyer's deposit lands + processing date is set,
          rancher sends the final balance invoice via Stripe Connect direct
          charge with application_fee=0 (100% to rancher, BHC takes nothing
          since commission was already collected at deposit time). */}
      {finalInvoiceModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-bone p-8 max-w-md w-full space-y-6">
            <div className="flex justify-between items-start">
              <h2 className="font-serif text-2xl">Send Final Invoice</h2>
              <button onClick={closeFinalInvoiceModal} className="text-2xl leading-none hover:text-saddle">×</button>
            </div>
            <p className="text-sm text-saddle">
              Buyer: <strong className="text-charcoal">{finalInvoiceModal.buyer_name}</strong>
              {finalInvoiceModal.deposit_amount && finalInvoiceModal.deposit_amount > 0 ? (
                <> · Deposit paid: <strong className="text-charcoal">${finalInvoiceModal.deposit_amount.toFixed(2)}</strong></>
              ) : null}
            </p>

            {finalInvoiceResult ? (
              <div className="border border-green-600 bg-green-50 p-4 space-y-3">
                <p className="text-sm text-green-900">
                  <strong>Invoice sent.</strong> Buyer received an email with the Stripe payment link for <strong>${finalInvoiceResult.balanceAmount.toFixed(2)}</strong>. 100% to your account when they pay — BHC takes nothing on the final balance.
                </p>
                <p className="text-xs text-green-800">
                  Payment link:{' '}
                  <a href={finalInvoiceResult.url} target="_blank" rel="noopener noreferrer" className="underline break-all">
                    {finalInvoiceResult.url}
                  </a>
                </p>
                <button
                  type="button"
                  onClick={closeFinalInvoiceModal}
                  className="px-4 py-2 text-xs uppercase tracking-wider bg-green-700 text-white hover:bg-green-800"
                >
                  Done
                </button>
              </div>
            ) : (
              <>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium mb-2">Total final sale price ($)</label>
                    <input
                      type="number"
                      value={finalInvoiceTotalSale}
                      onChange={(e) => setFinalInvoiceTotalSale(e.target.value)}
                      placeholder="e.g. 2000"
                      min="50"
                      max="25000"
                      step="0.01"
                      className="w-full px-4 py-3 border border-dust bg-bone focus:outline-none focus:border-charcoal"
                    />
                    {finalInvoiceTotalSale && parseFloat(finalInvoiceTotalSale) > 0 && finalInvoiceModal.deposit_amount && finalInvoiceModal.deposit_amount > 0 && (
                      <p className="text-xs text-saddle mt-1">
                        Balance owed: <strong>${Math.max(0, parseFloat(finalInvoiceTotalSale) - finalInvoiceModal.deposit_amount).toFixed(2)}</strong> (= ${parseFloat(finalInvoiceTotalSale).toFixed(2)} total &minus; ${finalInvoiceModal.deposit_amount.toFixed(2)} deposit)
                      </p>
                    )}
                  </div>

                  <div>
                    <label className="block text-sm font-medium mb-2">Processing / pickup date (optional)</label>
                    <input
                      type="text"
                      value={finalInvoiceProcessingDate}
                      onChange={(e) => setFinalInvoiceProcessingDate(e.target.value)}
                      placeholder="e.g. Wednesday, June 15"
                      className="w-full px-4 py-3 border border-dust bg-bone focus:outline-none focus:border-charcoal"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium mb-2">Note to buyer (optional)</label>
                    <textarea
                      value={finalInvoiceNotes}
                      onChange={(e) => setFinalInvoiceNotes(e.target.value)}
                      rows={3}
                      placeholder="Cut sheet notes, pickup logistics, anything else they need to know."
                      className="w-full px-4 py-3 border border-dust bg-bone focus:outline-none focus:border-charcoal"
                    />
                  </div>

                  <div className="bg-bone-warm border border-dust p-4 text-xs text-charcoal/85 leading-relaxed">
                    <strong>How this works:</strong> buyer gets an email with a Stripe payment link. They pay the balance, money lands in your Stripe account, BHC takes <strong>$0</strong> on this invoice (our commission was already collected at deposit). When they pay, the referral auto-marks Closed Won.
                  </div>
                </div>

                {updateError && (
                  <div className="p-3 border border-[#8C2F2F] text-[#8C2F2F] text-sm">{updateError}</div>
                )}

                <div className="flex gap-3">
                  <button
                    onClick={closeFinalInvoiceModal}
                    className="flex-1 px-4 py-3 border border-charcoal text-charcoal hover:bg-charcoal hover:text-bone transition-colors font-medium uppercase text-sm tracking-wider"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => submitFinalInvoice(!!finalInvoiceModal.final_invoice_url)}
                    disabled={
                      finalInvoiceSubmitting ||
                      !finalInvoiceTotalSale ||
                      parseFloat(finalInvoiceTotalSale) <= 0
                    }
                    className="flex-1 px-4 py-3 bg-charcoal text-bone hover:bg-saddle transition-colors font-medium uppercase text-sm tracking-wider disabled:opacity-50"
                  >
                    {finalInvoiceSubmitting
                      ? 'Sending…'
                      : finalInvoiceModal.final_invoice_url
                        ? 'Re-send invoice'
                        : 'Send invoice'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Close Deal Modal */}
      {closeModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-bone p-8 max-w-md w-full space-y-6">
            <div className="flex justify-between items-start">
              <h2 className="font-serif text-2xl">Close Deal</h2>
              <button onClick={() => setCloseModal(null)} className="text-2xl leading-none hover:text-saddle">×</button>
            </div>
            <p className="text-sm text-saddle">Buyer: <strong className="text-charcoal">{closeModal.buyer_name}</strong></p>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-2">Outcome</label>
                <select
                  value={closeForm.status}
                  onChange={(e) => setCloseForm(prev => ({ ...prev, status: e.target.value }))}
                  className="w-full px-4 py-3 border border-dust bg-bone focus:outline-none focus:border-charcoal"
                >
                  <option value="Closed Won">Deal Closed (Sale Made)</option>
                  <option value="Closed Lost">No Sale (Lost)</option>
                </select>
              </div>

              {closeForm.status === 'Closed Won' && (
                <>
                  <div>
                    <label className="block text-sm font-medium mb-2">Final sale amount ($)</label>
                    <input
                      type="number"
                      value={closeForm.saleAmount}
                      onChange={(e) => setCloseForm(prev => ({ ...prev, saleAmount: e.target.value, confirmed: false }))}
                      placeholder="e.g. 2500"
                      min="50"
                      max="25000"
                      step="0.01"
                      className="w-full px-4 py-3 border border-dust bg-bone focus:outline-none focus:border-charcoal"
                    />
                    {closeForm.saleAmount && parseFloat(closeForm.saleAmount) > 0 && parseFloat(closeForm.saleAmount) <= 25000 && (
                      <p className="text-xs text-saddle mt-1">
                        Commission ({((rancherInfo.commissionRate ?? 0.10) * 100).toFixed(1)}%): ${(parseFloat(closeForm.saleAmount) * (rancherInfo.commissionRate ?? 0.10)).toFixed(2)} &middot; You keep: ${(parseFloat(closeForm.saleAmount) * (1 - (rancherInfo.commissionRate ?? 0.10))).toFixed(2)}
                      </p>
                    )}
                    {/* Audit #13 (2026-05-28): typo-million-dollar guard. Server-side
                        ceiling at $25k in lib/stripe-commission.ts; this UI warning
                        catches it before submit and disables the confirm button. */}
                    {closeForm.saleAmount && parseFloat(closeForm.saleAmount) > 25000 && (
                      <p className="text-xs text-[#8C2F2F] mt-1 font-medium">
                        Sale amount exceeds $25,000 ceiling. Likely typo — double-check the agreed price. If genuinely above $25k, contact support to manually create the invoice.
                      </p>
                    )}
                  </div>

                  {/* Confirmation + commission auto-invoice disclaimer.
                      Required by the rancher closing the deal so we don't
                      mint Stripe invoices on a typo or accidental click. */}
                  {closeForm.saleAmount && parseFloat(closeForm.saleAmount) > 0 && (
                    <div className="border border-saddle/40 bg-bone-warm p-4 space-y-3">
                      <p className="text-sm leading-relaxed text-charcoal">
                        <strong>Confirm before submitting:</strong> ${parseFloat(closeForm.saleAmount).toFixed(2)} is the final sale price the buyer agreed to.
                      </p>
                      <p className="text-xs leading-relaxed text-saddle">
                        Submitting auto-generates a Stripe invoice for <strong>${(parseFloat(closeForm.saleAmount) * (rancherInfo.commissionRate ?? 0.10)).toFixed(2)}</strong> ({((rancherInfo.commissionRate ?? 0.10) * 100).toFixed(1)}% commission), emailed to your account. Pay by card or ACH on the hosted invoice page within 30 days. The deal won&rsquo;t mark Commission Paid until Stripe confirms payment.
                      </p>
                      <label className="flex items-start gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={closeForm.confirmed}
                          onChange={(e) => setCloseForm(prev => ({ ...prev, confirmed: e.target.checked }))}
                          className="mt-1 cursor-pointer"
                        />
                        <span className="text-sm text-charcoal">
                          Yes, ${parseFloat(closeForm.saleAmount).toFixed(2)} is the final agreed price. Generate the commission invoice.
                        </span>
                      </label>
                    </div>
                  )}
                </>
              )}

              <div>
                <label className="block text-sm font-medium mb-2">Notes (optional)</label>
                <textarea
                  value={closeForm.notes}
                  onChange={(e) => setCloseForm(prev => ({ ...prev, notes: e.target.value }))}
                  rows={3}
                  placeholder="Any details about the deal..."
                  className="w-full px-4 py-3 border border-dust bg-bone focus:outline-none focus:border-charcoal"
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
                className="flex-1 px-4 py-3 border border-charcoal text-charcoal hover:bg-charcoal hover:text-bone transition-colors font-medium uppercase text-sm tracking-wider"
              >
                Cancel
              </button>
              <button
                onClick={handleCloseDeal}
                disabled={
                  !!updating ||
                  (closeForm.status === 'Closed Won' &&
                    (!closeForm.saleAmount || parseFloat(closeForm.saleAmount) <= 0 || parseFloat(closeForm.saleAmount) > 25000 || !closeForm.confirmed))
                }
                className="flex-1 px-4 py-3 bg-charcoal text-bone hover:bg-saddle transition-colors font-medium uppercase text-sm tracking-wider disabled:opacity-50"
              >
                {updating ? 'Saving...' : closeForm.status === 'Closed Won' ? 'Submit + Send Invoice' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pass on Lead Modal — captures structured reason + auto-rematches buyer */}
      {passModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-bone p-8 max-w-md w-full space-y-6">
            <div className="flex justify-between items-start">
              <h2 className="font-serif text-2xl">Pass on Lead</h2>
              <button onClick={closePassModal} className="text-2xl leading-none hover:text-saddle">×</button>
            </div>

            {!passResult && (
              <>
                <p className="text-sm text-saddle">
                  Buyer: <strong className="text-charcoal">{passModal.buyer_name}</strong> ({passModal.buyer_state})
                </p>
                <p className="text-sm text-saddle">
                  We&apos;ll close this lead and immediately try to match this buyer with another rancher in their state. You won&apos;t see this lead again.
                </p>

                <div>
                  <label className="block text-sm font-medium mb-2">Why are you passing?</label>
                  <div className="space-y-2">
                    {([
                      ['out_of_area', 'Out of my service area'],
                      ['at_capacity', "I'm at capacity right now"],
                      ['not_a_fit', 'Not a fit (price / timing / other)'],
                      ['no_response', "Buyer never responded — ghost"],
                    ] as const).map(([value, label]) => (
                      <label key={value} className="flex items-center gap-3 p-3 border border-dust bg-white cursor-pointer hover:border-charcoal">
                        <input
                          type="radio"
                          name="passReason"
                          value={value}
                          checked={passReason === value}
                          onChange={() => setPassReason(value)}
                          className="w-4 h-4"
                        />
                        <span className="text-sm">{label}</span>
                      </label>
                    ))}
                  </div>
                </div>

                {updateError && (
                  <div className="p-3 border border-[#8C2F2F] text-[#8C2F2F] text-sm">
                    {updateError}
                  </div>
                )}

                <div className="flex gap-3">
                  <button
                    onClick={closePassModal}
                    disabled={passSubmitting}
                    className="flex-1 px-4 py-3 border border-charcoal text-charcoal hover:bg-charcoal hover:text-bone transition-colors font-medium uppercase text-sm tracking-wider disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handlePassOnLead}
                    disabled={passSubmitting}
                    className="flex-1 px-4 py-3 bg-saddle text-bone hover:bg-charcoal transition-colors font-medium uppercase text-sm tracking-wider disabled:opacity-50"
                  >
                    {passSubmitting ? 'Passing...' : 'Confirm Pass'}
                  </button>
                </div>
              </>
            )}

            {passResult && (
              <div className="space-y-4">
                {passResult.rematchOutcome === 'rematched' && (
                  <div className="p-4 border border-green-700 bg-green-50 text-green-900 text-sm">
                    ✓ Lead reassigned to <strong>{passResult.newRancherName}</strong>. Buyer was notified.
                  </div>
                )}
                {passResult.rematchOutcome === 'waitlisted' && (
                  <div className="p-4 border border-yellow-600 bg-yellow-50 text-yellow-900 text-sm">
                    No other rancher available in {passModal.buyer_state} right now. Buyer was waitlisted and put back into nurture so they stay engaged until a rancher opens up.
                  </div>
                )}
                {passResult.rematchOutcome === 'error' && (
                  <div className="p-4 border border-[#8C2F2F] text-[#8C2F2F] text-sm">
                    Re-match failed — Benjamin was alerted and will reassign manually.
                  </div>
                )}
                <button
                  onClick={closePassModal}
                  className="w-full px-4 py-3 bg-charcoal text-bone hover:bg-saddle transition-colors font-medium uppercase text-sm tracking-wider"
                >
                  Done
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="p-4 border border-dust bg-white text-center">
      <div className="font-serif text-2xl">{value}</div>
      <p className="text-xs text-saddle mt-1 uppercase tracking-wider">{label}</p>
      {sub && <p className="text-xs text-dust mt-0.5">{sub}</p>}
    </div>
  );
}

// Compute hours remaining on the 48-hour respond-or-pass window. Drives the
// urgency badge that prompts ranchers to either contact the buyer or pass
// instead of letting the lead die silently.
function hoursLeftToRespond(introSentAt: string): number | null {
  if (!introSentAt) return null;
  const sent = new Date(introSentAt).getTime();
  if (!isFinite(sent)) return null;
  const deadline = sent + 48 * 60 * 60 * 1000;
  const remaining = (deadline - Date.now()) / (60 * 60 * 1000);
  return Math.round(remaining);
}

function ResponseDeadline({ referral }: { referral: Referral }) {
  // Only show the countdown for leads that haven't been progressed yet.
  if (referral.status !== 'Intro Sent') return null;
  const hrs = hoursLeftToRespond(referral.intro_sent_at);
  if (hrs === null) return null;
  if (hrs > 24) {
    return (
      <span className="inline-flex px-2 py-0.5 text-xs bg-blue-50 text-blue-700 border border-blue-200">
        {hrs}h to respond
      </span>
    );
  }
  if (hrs > 0) {
    return (
      <span className="inline-flex px-2 py-0.5 text-xs bg-yellow-50 text-yellow-800 border border-yellow-300 font-medium">
        ⏰ {hrs}h left to respond
      </span>
    );
  }
  return (
    <span className="inline-flex px-2 py-0.5 text-xs bg-red-50 text-red-700 border border-red-300 font-medium">
      🚨 Overdue — auto-reassigning soon
    </span>
  );
}

function ReferralRow({ referral, onUpdate, onClose, onPass, onLost, onSendFinal, updating }: { referral: Referral; onUpdate: (id: string, status: string) => void; onClose: () => void; onPass: () => void; onLost: () => void; onSendFinal?: () => void; updating: string | null }) {
  // FINAL-5 (2026-05-31): show "Send Final Invoice" when deposit landed +
  // referral isn't yet Closed Won / Closed Lost / fully paid. Re-send label
  // if invoice already sent (final_invoice_url present).
  const depositPaid = !!referral.deposit_paid_at && (referral.deposit_amount || 0) > 0;
  const finalSent = !!referral.final_invoice_url;
  const finalPaid = !!referral.final_paid_at;
  const isTerminal = referral.status === 'Closed Won' || referral.status === 'Closed Lost';
  const showFinalInvoice = !!onSendFinal && depositPaid && !finalPaid && !isTerminal;

  return (
    <div className="p-4 border border-dust bg-white flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
      <div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`inline-block px-2 py-0.5 text-xs font-medium ${statusStyles[referral.status] || 'bg-gray-100'}`}>
            {referral.status}
          </span>
          <FreshnessIndicator referral={referral} />
          <ResponseDeadline referral={referral} />
          {depositPaid && (
            <span className="inline-block px-2 py-0.5 text-xs font-medium bg-green-100 text-green-800" title={`Deposit of $${(referral.deposit_amount || 0).toFixed(2)} paid ${referral.deposit_paid_at || ''}`}>
              Deposit ${(referral.deposit_amount || 0).toFixed(0)} ✓
            </span>
          )}
          {finalSent && !finalPaid && (
            <span className="inline-block px-2 py-0.5 text-xs font-medium bg-yellow-100 text-yellow-800">Invoice sent</span>
          )}
        </div>
        <p className="font-medium mt-1">{referral.buyer_name}</p>
        <p className="text-xs text-dust">{referral.buyer_state} &middot; {referral.order_type}</p>
      </div>
      <div className="flex gap-2 flex-wrap">
        {referral.status === 'Intro Sent' && (
          <button
            onClick={() => onUpdate(referral.id, 'Rancher Contacted')}
            disabled={updating === referral.id}
            className="px-3 py-1.5 text-xs border border-charcoal hover:bg-charcoal hover:text-bone transition-colors disabled:opacity-50"
          >
            Contacted ✓
          </button>
        )}
        {showFinalInvoice && (
          <button
            onClick={onSendFinal}
            className="px-3 py-1.5 text-xs bg-green-700 text-white hover:bg-green-800 transition-colors"
            title="Send final balance invoice to buyer (100% to you, no BHC fee)"
          >
            {finalSent ? 'Re-send invoice' : 'Send Final Invoice'}
          </button>
        )}
        <button
          onClick={onClose}
          className="px-3 py-1.5 text-xs bg-charcoal text-bone hover:bg-saddle transition-colors"
        >
          Close as Won
        </button>
        <button
          onClick={onLost}
          className="px-3 py-1.5 text-xs border border-saddle text-saddle hover:bg-saddle hover:text-bone transition-colors"
          title="Mark Lost — closes deal without rerouting buyer"
        >
          Mark Lost
        </button>
        <button
          onClick={onPass}
          className="px-3 py-1.5 text-xs border border-dust text-dust hover:bg-dust hover:text-bone transition-colors"
          title="Pass — we auto-reassign buyer to another rancher"
        >
          Pass
        </button>
      </div>
    </div>
  );
}

// ── Freshness indicator: visualizes how recently rancher acted on this lead
// Green = active in last 7d. Yellow = 7-14d, nudge time. Red = 14d+, will
// trigger the rancher-prompt email cron unless rancher engages.
function FreshnessIndicator({ referral }: { referral: Referral }) {
  const last = referral.last_rancher_activity_at || referral.intro_sent_at || referral.created_at;
  if (!last) return null;
  const daysSince = (Date.now() - new Date(last).getTime()) / 86_400_000;
  const days = Math.floor(daysSince);
  const tone = days < 7 ? 'green' : days < 14 ? 'yellow' : 'red';
  const colors = {
    green: 'bg-green-100 text-green-800',
    yellow: 'bg-yellow-100 text-yellow-800',
    red: 'bg-red-100 text-red-800',
  };
  const label =
    days < 1 ? 'Active — today' :
    days < 7 ? `Active — ${days}d ago` :
    days < 14 ? `${days}d since activity — nudge or close` :
    `${days}d stale — auto-prompt incoming`;
  return (
    <span className={`inline-block px-2 py-0.5 text-xs font-medium ${colors[tone]}`}>
      {label}
    </span>
  );
}

function ReferralCard({
  referral,
  onUpdate,
  onClose,
  onPass,
  onLost,
  onSendFinal,
  updating,
}: {
  referral: Referral;
  onUpdate: (id: string, status: string) => void;
  onClose: () => void;
  onPass: () => void;
  onLost: () => void;
  onSendFinal?: () => void;
  updating: string | null;
}) {
  // FINAL-5 (2026-05-31): see ReferralRow for parity logic + button intent.
  const depositPaid = !!referral.deposit_paid_at && (referral.deposit_amount || 0) > 0;
  const finalSent = !!referral.final_invoice_url;
  const finalPaid = !!referral.final_paid_at;
  const isTerminal = referral.status === 'Closed Won' || referral.status === 'Closed Lost';
  const showFinalInvoice = !!onSendFinal && depositPaid && !finalPaid && !isTerminal;
  return (
    <div className="p-6 border border-dust bg-white space-y-4">
      <div className="flex flex-col sm:flex-row justify-between items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`inline-block px-2 py-0.5 text-xs font-medium ${statusStyles[referral.status] || 'bg-gray-100'}`}>
              {referral.status}
            </span>
            <FreshnessIndicator referral={referral} />
            <ResponseDeadline referral={referral} />
          </div>
          <h3 className="font-serif text-xl mt-2">{referral.buyer_name}</h3>
          <p className="text-sm text-dust">
            {referral.intro_sent_at ? `Introduced ${new Date(referral.intro_sent_at).toLocaleDateString()}` : ''}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 text-sm">
        <div><span className="text-saddle">Email:</span> <a href={`mailto:${referral.buyer_email}`} className="text-charcoal hover:underline">{referral.buyer_email}</a></div>
        <div><span className="text-saddle">Phone:</span> <a href={`tel:${referral.buyer_phone}`} className="text-charcoal hover:underline">{referral.buyer_phone}</a></div>
        <div><span className="text-saddle">State:</span> {referral.buyer_state}</div>
        <div><span className="text-saddle">Looking for:</span> {referral.order_type}</div>
        <div><span className="text-saddle">Budget:</span> {referral.budget_range}</div>
      </div>

      {referral.notes && (
        <p className="text-sm p-3 bg-bone border border-dust">
          <span className="text-saddle font-medium">Notes:</span> {referral.notes}
        </p>
      )}

      <div className="flex flex-wrap gap-2 pt-2">
        {referral.status === 'Intro Sent' && (
          <button
            onClick={() => onUpdate(referral.id, 'Rancher Contacted')}
            disabled={updating === referral.id}
            className="px-4 py-2 text-sm border border-charcoal hover:bg-charcoal hover:text-bone transition-colors disabled:opacity-50"
          >
            {updating === referral.id ? 'Updating...' : "I've Contacted This Buyer"}
          </button>
        )}
        {referral.status === 'Rancher Contacted' && (
          <button
            onClick={() => onUpdate(referral.id, 'Negotiation')}
            disabled={updating === referral.id}
            className="px-4 py-2 text-sm border border-charcoal hover:bg-charcoal hover:text-bone transition-colors disabled:opacity-50"
          >
            {updating === referral.id ? 'Updating...' : 'In Negotiation'}
          </button>
        )}
        {showFinalInvoice && (
          <button
            onClick={onSendFinal}
            className="px-4 py-2 text-sm bg-green-700 text-white hover:bg-green-800 transition-colors"
            title="Send final balance invoice to buyer (100% to you, no BHC fee)"
          >
            {finalSent ? 'Re-send Final Invoice' : 'Send Final Invoice'}
          </button>
        )}
        <button
          onClick={onClose}
          className="px-4 py-2 text-sm bg-charcoal text-bone hover:bg-saddle transition-colors"
        >
          Close as Won
        </button>
        <button
          onClick={onLost}
          className="px-4 py-2 text-sm border border-saddle text-saddle hover:bg-saddle hover:text-bone transition-colors"
          title="Mark this lead as closed lost — they're out (price/timing/etc). Won't re-route."
        >
          Mark Lost
        </button>
        <button
          onClick={onPass}
          className="px-4 py-2 text-sm border border-dust text-dust hover:bg-dust hover:text-bone transition-colors"
          title="Pass on this lead — we'll auto-reassign the buyer to another rancher"
        >
          Pass on Lead
        </button>
      </div>
    </div>
  );
}

// ── Stage-3 Audit B4 — Fulfillment confirm row ───────────────────────────
// Renders under each Closed Won card for tier_v2 ranchers. Two-step disclosure:
//   click 1 → expand textarea + reveal "Send confirmation"
//   click 2 → POST /api/rancher/fulfillment/confirm { referralId, note }
// On 200: parent flips the local referral row to show the green pill.
// On error: inline red error text; the button stays clickable for retry.
function FulfillmentConfirmRow({
  referral,
  onConfirmed,
}: {
  referral: Referral;
  onConfirmed: (when: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Already-confirmed → render the green pill, no button.
  if (referral.fulfillment_confirmed_at) {
    const when = new Date(referral.fulfillment_confirmed_at).toLocaleDateString();
    return (
      <div className="px-4 py-3 border-t border-dust bg-bone">
        <span
          role="status"
          aria-label={`Beef delivered ${when}`}
          className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium bg-green-100 text-green-800"
        >
          <span aria-hidden="true">✓</span> Beef delivered {when}
        </span>
      </div>
    );
  }

  async function submit() {
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/rancher/fulfillment/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ referralId: referral.id, note: note.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const errMsg = typeof data?.error === 'string' ? data.error : 'Could not confirm fulfillment. Please try again.';
        setError(errMsg);
        return;
      }
      onConfirmed(String(data?.fulfillmentConfirmedAt || new Date().toISOString()));
    } catch {
      setError('Network error — try again in a moment.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="px-4 py-3 border-t border-dust bg-bone space-y-2">
      {!expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="bg-charcoal text-white px-4 py-2 text-xs font-semibold uppercase tracking-widest hover:bg-saddle transition-colors"
        >
          Mark beef delivered →
        </button>
      ) : (
        <>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, 500))}
            placeholder="Optional — any handoff details to share with the buyer"
            aria-label="Handoff note for buyer (optional)"
            rows={2}
            maxLength={500}
            className="w-full px-3 py-2 text-sm border border-dust bg-white text-charcoal focus:outline-none focus:border-charcoal"
          />
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={submit}
              disabled={submitting}
              className="bg-charcoal text-white px-4 py-2 text-xs font-semibold uppercase tracking-widest hover:bg-saddle transition-colors disabled:opacity-50"
            >
              {submitting ? 'Sending…' : 'Send confirmation'}
            </button>
            <button
              type="button"
              onClick={() => { setExpanded(false); setNote(''); setError(''); }}
              disabled={submitting}
              className="px-4 py-2 text-xs font-semibold uppercase tracking-widest border border-dust text-saddle hover:bg-dust hover:text-bone transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <span className="text-xs text-dust ml-auto">{note.length}/500</span>
          </div>
        </>
      )}
      {error && <p className="text-xs text-red-700">{error}</p>}
    </div>
  );
}

// ── Stage-3 Task 11C — Dashboard banner cascade ───────────────────────────
// Five states, ALL stacked when applicable (no priority short-circuit).
// State → color → CTA:
//   1. No tier picked  → blue   → /partner
//   2. Connect not_connected  → amber  → POST /api/rancher/connect/start
//   3. Connect onboarding     → amber  → same as #2 (resume)
//   4. Connect restricted     → red    → GET /api/rancher/tier/portal
//   5. Subscription past_due  → red    → GET /api/rancher/tier/portal
//
// Gated by Pricing Model === 'tier_v2' at the caller — legacy ranchers
// never see this section. Each banner opens its target in a new tab so the
// dashboard state stays around for refresh-based feedback.
function DashboardBannerCascade({ rancher }: { rancher: RancherInfo }) {
  const noTier = !rancher.tier;
  const status = rancher.subscriptionStatus || '';
  // Treat trialing as "subscription is paying-or-pre-paying" — consistent with
  // wizard TierPickStep which unlocks on either active OR trialing. A trialing
  // rancher will still need a connected bank when their trial converts.
  const subPaying = status === 'active' || status === 'trialing';
  // Broken-subscription states. past_due is the canonical needs-card-update,
  // but incomplete/incomplete_expired/unpaid/canceled all mean the subscription
  // is not paying us and the rancher can't receive new leads. Group them
  // under one banner so no state falls through silently.
  const subBroken = status === 'past_due' || status === 'unpaid'
    || status === 'incomplete' || status === 'incomplete_expired'
    || status === 'canceled';
  const connect = rancher.connectStatus || 'not_connected';

  // Banner gates follow the spec literal — only #2 (Connect not_connected)
  // requires the rancher to have a paying subscription first, so we don't
  // ask them to connect a bank before they've picked a plan. States 3/4
  // fire on the singular Connect field. State 5 catches any broken sub.
  const showConnectNotConnected = !noTier && subPaying && connect === 'not_connected';
  const showConnectOnboarding = connect === 'onboarding';
  const showConnectRestricted = connect === 'restricted';
  const showSubBroken = !noTier && subBroken;

  const anyBanner =
    noTier || showConnectNotConnected || showConnectOnboarding || showConnectRestricted || showSubBroken;
  if (!anyBanner) return null;

  // Opens Stripe Connect onboarding link from /api/rancher/connect/start in
  // a new tab. Same handler powers #2 + #3 (start auto-resumes existing
  // onboarding when account already exists).
  async function openConnectOnboarding() {
    try {
      const res = await fetch('/api/rancher/connect/start', { method: 'POST', credentials: 'include' });
      const data = await res.json();
      if (res.ok && data?.url) window.open(data.url, '_blank', 'noopener,noreferrer');
      else alert(data?.error || 'Could not start Stripe Connect onboarding.');
    } catch {
      alert('Network error — try again in a moment.');
    }
  }

  // Opens Stripe Customer Portal (used for billing past_due + restricted
  // Connect cases where the portal lets the rancher fix payment method or
  // resolve the dispute that flagged them).
  async function openBillingPortal() {
    try {
      const res = await fetch('/api/rancher/tier/portal', { credentials: 'include' });
      const data = await res.json();
      if (res.ok && data?.url) window.open(data.url, '_blank', 'noopener,noreferrer');
      else alert(data?.error || 'Could not open billing portal.');
    } catch {
      alert('Network error — try again in a moment.');
    }
  }

  return (
    <div className="space-y-3">
      {noTier && (
        <div className="p-4 border-l-4 border-blue-500 bg-blue-50 flex items-center justify-between gap-4 flex-wrap">
          <p className="text-sm text-blue-900">
            <strong>Pick your plan to start receiving buyers.</strong>{' '}
            Choose Pasture, Ranch, or Operator on /partner.
          </p>
          <a
            href="/partner"
            className="inline-flex items-center gap-1 px-4 py-2 text-xs font-semibold uppercase tracking-widest bg-blue-700 text-white hover:bg-blue-800 transition-colors"
          >
            See plans →
          </a>
        </div>
      )}

      {showConnectNotConnected && (
        <div className="p-4 border-l-4 border-yellow-500 bg-yellow-50 flex items-center justify-between gap-4 flex-wrap">
          <p className="text-sm text-yellow-900">
            <strong>Connect your bank account so we can pay you.</strong>{' '}
            Stripe Connect onboarding takes ~5 minutes.
          </p>
          <button
            type="button"
            onClick={openConnectOnboarding}
            className="inline-flex items-center gap-1 px-4 py-2 text-xs font-semibold uppercase tracking-widest bg-yellow-600 text-white hover:bg-yellow-700 transition-colors"
          >
            Connect bank →
          </button>
        </div>
      )}

      {showConnectOnboarding && (
        <div className="p-4 border-l-4 border-yellow-500 bg-yellow-50 flex items-center justify-between gap-4 flex-wrap">
          <p className="text-sm text-yellow-900">
            <strong>Finish identity verification with Stripe.</strong>{' '}
            Resume where you left off — Stripe will pick up at the next required step.
          </p>
          <button
            type="button"
            onClick={openConnectOnboarding}
            className="inline-flex items-center gap-1 px-4 py-2 text-xs font-semibold uppercase tracking-widest bg-yellow-600 text-white hover:bg-yellow-700 transition-colors"
          >
            Resume verification →
          </button>
        </div>
      )}

      {showConnectRestricted && (
        <div className="p-4 border-l-4 border-red-600 bg-red-50 flex items-center justify-between gap-4 flex-wrap">
          <p className="text-sm text-red-900">
            <strong>Stripe needs more info to keep payouts active.</strong>{' '}
            Your Connect account is restricted — open the portal to clear the flag.
          </p>
          <button
            type="button"
            onClick={openBillingPortal}
            className="inline-flex items-center gap-1 px-4 py-2 text-xs font-semibold uppercase tracking-widest bg-red-700 text-white hover:bg-red-800 transition-colors"
          >
            Open portal →
          </button>
        </div>
      )}

      {showSubBroken && (
        <div className="p-4 border-l-4 border-red-600 bg-red-50 flex items-center justify-between gap-4 flex-wrap">
          <p className="text-sm text-red-900">
            <strong>
              {status === 'canceled'
                ? 'Your tier subscription is canceled.'
                : status === 'past_due' || status === 'unpaid'
                ? 'Your tier payment failed — update your card.'
                : 'Your tier subscription needs attention.'}
            </strong>{' '}
            New leads pause until the subscription is current again.
          </p>
          <button
            type="button"
            onClick={openBillingPortal}
            className="inline-flex items-center gap-1 px-4 py-2 text-xs font-semibold uppercase tracking-widest bg-red-700 text-white hover:bg-red-800 transition-colors"
          >
            {status === 'canceled' ? 'Reactivate →' : 'Update card →'}
          </button>
        </div>
      )}
    </div>
  );
}

// Legacy → tier_v2 opt-in banner. Renders only when Pricing Model === 'legacy'.
// Two states:
//   1. Discovery — no tier yet. Pitches the upgrade + sends to /partner.
//   2. Ready — tier subscription paying + Connect active. One-click button
//      hits /api/rancher/legacy-upgrade to atomically flip Pricing Model.
function LegacyUpgradeBanner({ rancher }: { rancher: RancherInfo }) {
  const status = rancher.subscriptionStatus || '';
  const subPaying = status === 'active' || status === 'trialing';
  const connect = rancher.connectStatus || 'not_connected';
  const ready = subPaying && connect === 'active';

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function confirmUpgrade() {
    const ok = window.confirm(
      'Switch to tier_v2 pricing? This is one-way — your closed deals will run through Stripe Connect direct charges instead of post-close commission invoices.',
    );
    if (!ok) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/rancher/legacy-upgrade', {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json();
      if (res.ok) {
        // Reload the page so the cascade re-renders against the new Pricing Model.
        window.location.reload();
      } else {
        setError(data?.message || data?.error || 'Upgrade failed.');
      }
    } catch {
      setError('Network error — try again in a moment.');
    } finally {
      setSubmitting(false);
    }
  }

  if (ready) {
    return (
      <div className="p-4 border-l-4 border-green-600 bg-green-50 flex items-center justify-between gap-4 flex-wrap">
        <div className="text-sm text-green-900">
          <p>
            <strong>You&rsquo;re set up to switch to tier_v2.</strong>{' '}
            Subscription is paying, Stripe Connect is active. One click finishes the upgrade.
          </p>
          {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
        </div>
        <button
          type="button"
          onClick={confirmUpgrade}
          disabled={submitting}
          className="inline-flex items-center gap-1 px-4 py-2 text-xs font-semibold uppercase tracking-widest bg-green-700 text-white hover:bg-green-800 transition-colors disabled:opacity-50"
        >
          {submitting ? 'Switching…' : 'Switch to tier_v2 →'}
        </button>
      </div>
    );
  }

  // Discovery state — pitch the upgrade.
  return (
    <div className="p-4 border-l-4 border-blue-500 bg-blue-50 flex items-center justify-between gap-4 flex-wrap">
      <p className="text-sm text-blue-900">
        <strong>Skip the commission invoice. Get paid by Stripe direct.</strong>{' '}
        Pick a paid tier ($150/$350/$500/mo) → Stripe collects buyer deposits → BHC&rsquo;s cut comes off the top → the rest hits your bank automatically.
      </p>
      <a
        href="/partner"
        className="inline-flex items-center gap-1 px-4 py-2 text-xs font-semibold uppercase tracking-widest bg-blue-700 text-white hover:bg-blue-800 transition-colors"
      >
        See plans →
      </a>
    </div>
  );
}
