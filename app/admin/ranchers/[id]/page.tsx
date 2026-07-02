'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Container from '../../../components/Container';
import AdminAuthGuard from '../../../components/AdminAuthGuard';
import { normalizeState, normalizeStates, stringifyStates, US_STATES } from '@/lib/states';
import { isReadyToGoLive, goLiveBlockersView } from '@/lib/goLiveGates';
import { toast } from '@/lib/toast';

interface Testimonial {
  name: string;
  quote: string;
  location?: string;
  photo?: string;
}

interface CustomProduct {
  name: string;
  price: number | string;
  description: string;
  link: string;
}

export default function AdminRancherDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [rancher, setRancher] = useState<any>(null);
  const [error, setError] = useState('');
  const [regeocodingPin, setRegeocodingPin] = useState(false);
  const [regeocodeMsg, setRegeocodeMsg] = useState('');
  // Actions bar (ported from the orphaned /admin/today v1 drawer — Manifest #16):
  // per-action busy key so buttons don't all flicker together.
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  // Manifest #18: send-v2-upgrade tier picker is a select modal (house
  // pattern), not the old window.prompt() typing test. '' = free Legacy
  // Connect — same contract the API expects.
  const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
  const [upgradeTargetTier, setUpgradeTargetTier] = useState('pasture');

  // Form state
  const [form, setForm] = useState({
    zip: '',
    city: '',
    slug: '',
    tagline: '',
    about_text: '',
    logo_url: '',
    video_url: '',
    custom_notes: '',
    quarter_price: '',
    quarter_lbs: '',
    quarter_payment_link: '',
    half_price: '',
    half_lbs: '',
    half_payment_link: '',
    whole_price: '',
    whole_lbs: '',
    whole_payment_link: '',
    next_processing_date: '',
    reserve_link: '',
    google_reviews_url: '',
    facebook_url: '',
    instagram_url: '',
    processing_facility: '',
    verification_method: '',
    verification_status: '',
    verification_notes: '',
    page_live: false,
    ships_nationwide: false,
    states_served: '',
    routing_states: '',
    admin_approved_multi_state: false,
    slots_per_state: '5',
    onboarding_status: '',
    active_status: '',
  });

  const [testimonials, setTestimonials] = useState<Testimonial[]>([]);
  const [galleryPhotos, setGalleryPhotos] = useState<string[]>([]);
  const [customProducts, setCustomProducts] = useState<CustomProduct[]>([]);
  const [newTestimonial, setNewTestimonial] = useState<Testimonial>({ name: '', quote: '', location: '' });
  const [newPhotoUrl, setNewPhotoUrl] = useState('');
  const [newProduct, setNewProduct] = useState<CustomProduct>({ name: '', price: '', description: '', link: '' });

  useEffect(() => {
    fetchRancher();
  }, [id]);

  async function fetchRancher() {
    try {
      const res = await fetch(`/api/admin/ranchers?id=${id}`);
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      // The ranchers endpoint returns an array, find our rancher
      const r = Array.isArray(data) ? data.find((x: any) => x.id === id) : data;
      if (!r) throw new Error('Rancher not found');
      setRancher(r);

      // Populate form from rancher data
      setForm({
        zip: r.zip || '',
        city: r.city || '',
        slug: r.slug || '',
        tagline: r.tagline || '',
        about_text: r.about_text || '',
        logo_url: r.logo_url || '',
        video_url: r.video_url || '',
        custom_notes: r.custom_notes || '',
        quarter_price: r.quarter_price?.toString() || '',
        quarter_lbs: r.quarter_lbs || '',
        quarter_payment_link: r.quarter_payment_link || '',
        half_price: r.half_price?.toString() || '',
        half_lbs: r.half_lbs || '',
        half_payment_link: r.half_payment_link || '',
        whole_price: r.whole_price?.toString() || '',
        whole_lbs: r.whole_lbs || '',
        whole_payment_link: r.whole_payment_link || '',
        next_processing_date: r.next_processing_date || '',
        reserve_link: r.reserve_link || '',
        google_reviews_url: r.google_reviews_url || '',
        facebook_url: r.facebook_url || '',
        instagram_url: r.instagram_url || '',
        processing_facility: r.processing_facility || '',
        verification_method: r.verification_method || '',
        verification_status: r.verification_status || '',
        verification_notes: r.verification_notes || '',
        page_live: r.page_live || false,
        ships_nationwide: r.ships_nationwide || false,
        states_served: r.states_served || '',
        routing_states: r.routing_states || '',
        admin_approved_multi_state: r.admin_approved_multi_state || false,
        slots_per_state: '5',
        onboarding_status: r.onboarding_status || '',
        active_status: r.active_status || '',
      });

      // Parse testimonials
      try {
        setTestimonials(r.testimonials ? JSON.parse(r.testimonials) : []);
      } catch { setTestimonials([]); }

      // Parse gallery
      try {
        setGalleryPhotos(r.gallery_photos ? JSON.parse(r.gallery_photos) : []);
      } catch { setGalleryPhotos([]); }

      // Parse custom products
      try {
        setCustomProducts(r.custom_products ? JSON.parse(r.custom_products) : []);
      } catch { setCustomProducts([]); }

    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    try {
      // Multi-state flip: normalize the routing states + auto-size the per-state
      // cap. Without an override, the matcher splits the global cap across the N
      // routed states (floor(max/N)) — so a wide enumeration silently floors to 0
      // and rejects every cold lead. Writing State Capacity Override = {ST: slots}
      // per routed state guarantees each state gets its slots regardless of N.
      //
      // PRE-FLIP GUARD (finding 2, 2026-07-01): the override map must include
      // the HOME state. The matcher's served set is home ∪ Routing States, so
      // an override keyed only on Routing States left the home state on the
      // floor(max/N) fallback — which could be 0 — silently zeroing the
      // rancher's OWN state the moment multi-state flipped on. Home is now
      // always in the map with the same per-state slots. The override is also
      // written whenever the served set is >1 state (was: only when Routing
      // States alone was >1), matching exactly when the matcher's sub-cap
      // activates. (The matcher-side equal split additionally floors at 1 —
      // lib/stateSubCap — so even a missing override can't zero a state.)
      const routedCodes = form.admin_approved_multi_state ? normalizeStates(form.routing_states) : [];
      const homeCode = normalizeState(rancher?.state || '');
      const servedCodes = Array.from(new Set([homeCode, ...routedCodes].filter(Boolean)));
      const perState = Math.max(1, parseInt(String(form.slots_per_state), 10) || 5);
      const stateCapacityOverride =
        form.admin_approved_multi_state && servedCodes.length > 1
          ? JSON.stringify(Object.fromEntries(servedCodes.map((c) => [c, perState])))
          : '';
      // slots_per_state is a UI-only helper; the PATCH endpoint has no mapping
      // for it, so it rides along in the payload harmlessly (unmapped = ignored).
      const payload = {
        ...form,
        routing_states: routedCodes.length ? stringifyStates(routedCodes) : form.routing_states,
        state_capacity_override: stateCapacityOverride,
        testimonials: JSON.stringify(testimonials),
        gallery_photos: JSON.stringify(galleryPhotos),
        custom_products: JSON.stringify(customProducts),
      };
      const res = await fetch(`/api/admin/ranchers/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('Failed to save');
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e: any) {
      alert('Save failed: ' + e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleRegeocodePin() {
    setRegeocodingPin(true);
    setRegeocodeMsg('');
    try {
      const res = await fetch(`/api/admin/ranchers/${id}/regeocode`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Regeocode failed');
      setRegeocodeMsg(data.message || 'Pin updated');
      setTimeout(() => setRegeocodeMsg(''), 4000);
    } catch (e: any) {
      setRegeocodeMsg('Error: ' + e.message);
    } finally {
      setRegeocodingPin(false);
    }
  }

  // ── Actions bar plumbing ──────────────────────────────────────────────────
  // Every button below wires to an EXISTING endpoint and surfaces the server's
  // error verbatim — no new go-live/pause logic lives client-side.
  async function postAction(
    key: string,
    path: string,
    opts?: { body?: any; failTitle?: string },
  ): Promise<any | null> {
    setActionBusy(key);
    try {
      const res = await fetch(`/api/admin/ranchers/${id}/${path}`, {
        method: 'POST',
        ...(opts?.body
          ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts.body) }
          : {}),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || payload?.error) {
        toast.error(opts?.failTitle || `${key} failed`, payload?.error || `HTTP ${res.status}`);
        return null;
      }
      return payload;
    } catch (e: any) {
      toast.error(opts?.failTitle || `${key} failed`, e?.message);
      return null;
    } finally {
      setActionBusy(null);
    }
  }

  const rancherName = () => rancher?.ranch_name || rancher?.operator_name || 'this rancher';

  // Go Live — rides the ONE rail (lib/goLiveRancher via POST /go-live).
  // Gated client-side by the same shared predicate the server enforces;
  // force=true is the operator escape hatch for mis-tagged records.
  async function handleGoLive(force: boolean) {
    const warning = force
      ? `FORCE go-live for "${rancherName()}"?\n\nThis OVERRIDES the gates (${goLiveBlockersView(rancher).join('; ') || 'none failing'}). An unsigned rancher silently receives zero buyers; a tier_v2 rancher without active Connect can't take deposits. Continue anyway?`
      : `Go live: publish "${rancherName()}" and email every waiting buyer in their state. This cannot be undone. Continue?`;
    if (!window.confirm(warning)) return;
    const payload = await postAction(force ? 'force-go-live' : 'go-live', 'go-live', {
      body: force ? { force: true } : undefined,
      failTitle: 'Go-Live failed',
    });
    if (payload) {
      toast.success(
        `${rancherName()} is live`,
        payload?.matched ? `Auto-matched ${payload.matched} waiting buyers` : undefined,
      );
      await fetchRancher();
    }
  }

  // Pause — matching engine stops routing leads (vacation / processing month).
  async function handlePause() {
    const reason = window.prompt(`Pause ${rancherName()} — no new leads until resumed. Reason (optional):`, '');
    if (reason === null) return; // cancelled
    const payload = await postAction('pause', 'pause', {
      body: reason.trim() ? { reason: reason.trim() } : {},
      failTitle: 'Pause failed',
    });
    if (payload) {
      toast.success(`${rancherName()} paused`, payload?.message || 'No new leads until resumed');
      await fetchRancher();
    }
  }

  // Resume — back to Active (or At Capacity if their slots are full).
  async function handleResume() {
    const payload = await postAction('resume', 'resume', { failTitle: 'Resume failed' });
    if (payload) {
      toast.success(`${rancherName()} resumed`, payload?.message || 'Accepting new leads again');
      await fetchRancher();
    }
  }

  // Resync Connect — live Stripe read → persist true Connect status. Fixes
  // "stuck at onboarding" ranchers whose account.updated webhook never landed.
  async function handleResyncConnect() {
    const payload = await postAction('resync-connect', 'resync-connect', {
      failTitle: 'Resync failed',
    });
    if (payload) {
      toast.success('Connect resynced', payload?.message);
      await fetchRancher();
    }
  }

  // Mark Legacy Connect — hybrid path: tier_v2 deposits at legacy 10%
  // commission, no subscription. Returns the Stripe onboarding URL to send.
  async function handleMarkLegacyConnect() {
    if (
      !window.confirm(
        `Flag ${rancherName()} as Legacy Connect? This flips Pricing Model to tier_v2 (deposits via Stripe Connect) at the legacy 10% commission with no subscription, and creates their Connect account if needed.`,
      )
    )
      return;
    const payload = await postAction('mark-legacy-connect', 'mark-legacy-connect', {
      failTitle: 'Mark Legacy Connect failed',
    });
    if (payload) {
      toast.success('Marked Legacy Connect', payload?.message);
      if (payload?.onboardingUrl) {
        window.prompt('Send this Stripe onboarding URL to the rancher (⌘C to copy):', payload.onboardingUrl);
      }
      await fetchRancher();
    }
  }

  // Send v2 upgrade invite — 5-min wizard: pick tier, Stripe Connect, deposits.
  // Target plan: a paid tier (pasture/ranch/operator) lands the rancher
  // PRE-SELECTED on that plan + sent straight to its checkout. '' = the
  // free Legacy Connect default. Same POST the old window.prompt() flow fired.
  async function handleSendV2Upgrade(targetTier: string) {
    setUpgradeModalOpen(false);
    const payload = await postAction('send-v2-upgrade', 'send-v2-upgrade', {
      body: { targetTier },
      failTitle: 'Upgrade invite failed',
    });
    if (payload) {
      toast.success('Upgrade invite sent', `Sent to ${rancher?.email || 'rancher'}`);
      await fetchRancher();
    }
  }

  // Resend setup email — fresh 60-day wizard link, stamps Docs Sent At.
  async function handleResendSetup() {
    if (
      !window.confirm(
        `Email ${rancherName()} a fresh setup-wizard link (valid 60 days)? Stamps Docs Sent At.`,
      )
    )
      return;
    const payload = await postAction('resend-setup', 'resend-setup', {
      failTitle: 'Resend setup failed',
    });
    if (payload) {
      toast.success('Setup link sent', payload?.sentTo ? `Sent to ${payload.sentTo}` : undefined);
      await fetchRancher();
    }
  }

  function addTestimonial() {
    if (!newTestimonial.name || !newTestimonial.quote) return;
    setTestimonials([...testimonials, { ...newTestimonial }]);
    setNewTestimonial({ name: '', quote: '', location: '' });
  }

  function removeTestimonial(idx: number) {
    setTestimonials(testimonials.filter((_, i) => i !== idx));
  }

  function addGalleryPhoto() {
    if (!newPhotoUrl) return;
    setGalleryPhotos([...galleryPhotos, newPhotoUrl]);
    setNewPhotoUrl('');
  }

  function removeGalleryPhoto(idx: number) {
    setGalleryPhotos(galleryPhotos.filter((_, i) => i !== idx));
  }

  function addCustomProduct() {
    if (!newProduct.name || !newProduct.price) return;
    setCustomProducts([...customProducts, { ...newProduct, price: parseFloat(String(newProduct.price)) || 0 }]);
    setNewProduct({ name: '', price: '', description: '', link: '' });
  }

  function removeCustomProduct(idx: number) {
    setCustomProducts(customProducts.filter((_, i) => i !== idx));
  }

  function updateForm(key: string, value: any) {
    setForm(prev => ({ ...prev, [key]: value }));
  }

  if (loading) return <AdminAuthGuard><div className="min-h-screen bg-bone flex items-center justify-center"><p>Loading...</p></div></AdminAuthGuard>;
  if (error) return <AdminAuthGuard><div className="min-h-screen bg-bone flex items-center justify-center"><p className="text-weathered">{error}</p></div></AdminAuthGuard>;

  const siteUrl = typeof window !== 'undefined' ? window.location.origin : '';

  return (
    <AdminAuthGuard>
      <main className="min-h-screen bg-bone text-charcoal py-10">
        <Container>
          <div className="max-w-4xl mx-auto space-y-8">
            {/* Header */}
            <div className="flex items-center justify-between">
              <div>
                <button onClick={() => router.push('/admin/ranchers')} className="text-sm text-saddle hover:underline mb-2 block">
                  &larr; Back to Ranchers
                </button>
                <h1 className="font-[family-name:var(--font-playfair)] text-3xl">
                  {rancher.ranch_name || rancher.operator_name}
                </h1>
                <p className="text-saddle">{rancher.operator_name} &middot; {rancher.email} &middot; {rancher.state}</p>
              </div>
              <div className="flex gap-2">
                {form.slug && (
                  <a href={`/ranchers/${form.slug}`} target="_blank" className="px-4 py-2 text-sm border border-dust hover:bg-white">
                    Preview Page &rarr;
                  </a>
                )}
                <button
                  onClick={async () => {
                    if (!confirm(`Open the rancher dashboard as ${rancher.operator_name || rancher.ranch_name}? You'll see exactly what they see (leads, earnings, settings). Audit alert fires to Telegram. 4h session.`)) return;
                    const res = await fetch(`/api/admin/ranchers/${id}/impersonate`, { method: 'POST' });
                    if (!res.ok) { alert('Impersonation failed — check console'); console.error(await res.text()); return; }
                    const data = await res.json();
                    window.open(data.redirectTo || '/rancher', '_blank');
                  }}
                  className="px-4 py-2 text-sm border border-charcoal bg-charcoal text-bone hover:bg-divider"
                  title="Opens /rancher in a new tab logged in as this rancher. Telegram alert fires."
                >
                  🕵️ View Dashboard as Rancher
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="px-6 py-2 text-sm bg-charcoal text-bone hover:bg-divider disabled:opacity-50"
                >
                  {saving ? 'Saving...' : saved ? 'Saved!' : 'Save All Changes'}
                </button>
              </div>
            </div>

            {/* Status bar */}
            <div className="flex flex-wrap gap-3 p-4 border border-dust bg-white">
              <div>
                <label className="text-xs text-dust block">Onboarding</label>
                <select value={form.onboarding_status} onChange={e => updateForm('onboarding_status', e.target.value)}
                  className="px-2 py-1 border border-dust text-sm bg-bone">
                  <option value="">Not Started</option>
                  <option value="Call Scheduled">Call Scheduled</option>
                  <option value="Call Complete">Call Complete</option>
                  <option value="Docs Sent">Docs Sent</option>
                  <option value="Agreement Signed">Agreement Signed</option>
                  <option value="Verification Pending">Verification Pending</option>
                  <option value="Verification Complete">Verification Complete</option>
                  <option value="Live">Live</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-dust block">Active Status</label>
                <select value={form.active_status} onChange={e => updateForm('active_status', e.target.value)}
                  className="px-2 py-1 border border-dust text-sm bg-bone">
                  <option value="">Pending</option>
                  <option value="Active">Active</option>
                  <option value="At Capacity">At Capacity</option>
                  <option value="Paused">Paused</option>
                  <option value="Inactive">Inactive</option>
                </select>
              </div>
              <div className="flex items-end gap-2">
                <label className="flex items-center gap-1 text-sm cursor-pointer">
                  <input type="checkbox" checked={form.page_live} onChange={e => updateForm('page_live', e.target.checked)} />
                  Page Live
                </label>
                <label className="flex items-center gap-1 text-sm cursor-pointer">
                  <input type="checkbox" checked={form.ships_nationwide} onChange={e => updateForm('ships_nationwide', e.target.checked)} />
                  Ships Nationwide
                </label>
              </div>
            </div>

            {/* ── Actions bar — every operational lever, one place ─────────────
                Ported from the orphaned /admin/today v1 drawer (Manifest #16).
                Each button hits its existing endpoint; server errors surface
                verbatim. Go Live is gated by the SAME predicate the server
                enforces (lib/goLiveGates) — force is the explicit override. */}
            <section className="p-4 border border-charcoal bg-white space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="font-[family-name:var(--font-playfair)] text-xl">Actions</h2>
                {rancher.onboarding_status === 'Live' ? (
                  <span className="px-2 py-0.5 text-xs border border-sage/40 bg-sage/15 text-sage-dark">
                    ● Live{rancher.active_status && rancher.active_status !== 'Active' ? ` · ${rancher.active_status}` : ''}
                  </span>
                ) : isReadyToGoLive(rancher) ? (
                  <span className="px-2 py-0.5 text-xs border border-sage/40 bg-sage/15 text-sage-dark">
                    ⚡ ready to go live
                  </span>
                ) : (
                  <span
                    className="px-2 py-0.5 text-xs border border-amber-dark text-amber-dark"
                    title={goLiveBlockersView(rancher).join('; ')}
                  >
                    blocked: {goLiveBlockersView(rancher).join('; ')}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {/* Go Live — only offered when the rail would accept the click */}
                {rancher.onboarding_status !== 'Live' && isReadyToGoLive(rancher) && (
                  <button
                    onClick={() => handleGoLive(false)}
                    disabled={actionBusy === 'go-live'}
                    className="px-4 py-2 text-sm bg-sage-dark text-white hover:opacity-90 disabled:opacity-50"
                    title="One click: publishes the page, flips routing on, emails the rancher, warmup-blasts + auto-matches waiting buyers in their state."
                  >
                    {actionBusy === 'go-live' ? '…' : '🚀 Go Live'}
                  </button>
                )}
                {rancher.onboarding_status !== 'Live' && !isReadyToGoLive(rancher) && (
                  <button
                    onClick={() => handleGoLive(true)}
                    disabled={actionBusy === 'force-go-live'}
                    className="px-4 py-2 text-sm border border-rust text-rust-dark hover:bg-rust/10 disabled:opacity-50"
                    title={`Gates failing: ${goLiveBlockersView(rancher).join('; ')}. Force overrides ALL gates — escape hatch for mis-tagged records only.`}
                  >
                    {actionBusy === 'force-go-live' ? '…' : '⚠️ Force Go Live'}
                  </button>
                )}
                {/* Pause / Resume — routing on/off switch */}
                {rancher.active_status === 'Paused' ? (
                  <button
                    onClick={handleResume}
                    disabled={actionBusy === 'resume'}
                    className="px-4 py-2 text-sm border border-sage text-sage-dark hover:bg-sage/10 disabled:opacity-50"
                    title="Re-open this rancher to new leads (Active, or At Capacity if slots are full)"
                  >
                    {actionBusy === 'resume' ? '…' : '▶ Resume'}
                  </button>
                ) : (
                  <button
                    onClick={handlePause}
                    disabled={actionBusy === 'pause'}
                    className="px-4 py-2 text-sm border border-amber-dark text-amber-dark hover:bg-amber/10 disabled:opacity-50"
                    title="Stop this rancher from receiving new leads (vacation, processing month, sickness)"
                  >
                    {actionBusy === 'pause' ? '…' : '⏸ Pause'}
                  </button>
                )}
                {/* Resync Connect — live Stripe read, unsticks the deposit gate */}
                <button
                  onClick={handleResyncConnect}
                  disabled={actionBusy === 'resync-connect'}
                  className="px-4 py-2 text-sm border border-saddle text-saddle hover:bg-saddle/10 disabled:opacity-50"
                  title="Re-pull Stripe Connect account status live from Stripe and persist it. Fixes ranchers stuck at 'onboarding' when the webhook never landed."
                >
                  {actionBusy === 'resync-connect' ? '…' : '↻ Resync Connect'}
                </button>
                {String(rancher.pricing_model || '').toLowerCase() !== 'tier_v2' && (
                  <>
                    {/* Mark Legacy Connect — hybrid: Connect deposits, 10%, no subscription */}
                    <button
                      onClick={handleMarkLegacyConnect}
                      disabled={actionBusy === 'mark-legacy-connect'}
                      className="px-4 py-2 text-sm border border-dust hover:bg-bone disabled:opacity-50"
                      title="Flip to the hybrid path: platform deposits via Stripe Connect at the legacy 10% commission, no monthly subscription. Creates the Connect account + returns the onboarding link."
                    >
                      {actionBusy === 'mark-legacy-connect' ? '…' : '🪢 Mark Legacy Connect'}
                    </button>
                    {/* Send v2 upgrade — subscription tier + Connect wizard */}
                    <button
                      onClick={() => setUpgradeModalOpen(true)}
                      disabled={actionBusy === 'send-v2-upgrade'}
                      className="px-4 py-2 text-sm border border-amber-dark bg-amber/15 text-charcoal hover:bg-amber/30 disabled:opacity-50"
                      title="Sends the rancher a 5-min wizard link to pick a tier, complete Stripe Connect, and start collecting deposits via the platform. Shows because Pricing Model is not tier_v2."
                    >
                      {actionBusy === 'send-v2-upgrade' ? '…' : '🚀 Send V2 Upgrade Invite'}
                    </button>
                  </>
                )}
                {/* Resend setup email — fresh 60-day wizard link */}
                <button
                  onClick={handleResendSetup}
                  disabled={actionBusy === 'resend-setup'}
                  className="px-4 py-2 text-sm border border-dust hover:bg-bone disabled:opacity-50"
                  title="Emails the rancher a fresh 60-day setup-wizard link and stamps Docs Sent At."
                >
                  {actionBusy === 'resend-setup' ? '…' : '📨 Resend Setup Email'}
                </button>
              </div>
            </section>

            {/* Location / Map Pin */}
            <section className="p-6 border border-dust bg-white space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="font-[family-name:var(--font-playfair)] text-xl">Location &amp; Map Pin</h2>
                <div className="flex items-center gap-3">
                  {regeocodeMsg && (
                    <span className="text-xs text-saddle">{regeocodeMsg}</span>
                  )}
                  <button
                    onClick={handleRegeocodePin}
                    disabled={regeocodingPin}
                    className="px-4 py-2 text-sm border border-dust bg-bone hover:bg-white disabled:opacity-50"
                    title="Re-geocodes using current Zip / City / State and writes fresh Latitude + Longitude. Save the location fields first."
                  >
                    {regeocodingPin ? 'Updating pin…' : '↻ Regeocode pin'}
                  </button>
                </div>
              </div>
              <div className="grid md:grid-cols-3 gap-4">
                <div>
                  <label className="text-xs text-dust block mb-1">ZIP Code</label>
                  <input
                    value={form.zip}
                    onChange={e => updateForm('zip', e.target.value)}
                    className="w-full px-3 py-2 border border-dust text-sm bg-bone"
                    placeholder="80203"
                    maxLength={10}
                  />
                </div>
                <div>
                  <label className="text-xs text-dust block mb-1">City</label>
                  <input
                    value={form.city}
                    onChange={e => updateForm('city', e.target.value)}
                    className="w-full px-3 py-2 border border-dust text-sm bg-bone"
                    placeholder="Denver"
                  />
                </div>
                <div>
                  <label className="text-xs text-dust block mb-1">State (read-only here)</label>
                  <input
                    value={rancher?.state || ''}
                    readOnly
                    className="w-full px-3 py-2 border border-dust text-sm bg-bone opacity-60 cursor-not-allowed"
                    title="Edit State in the main admin panel"
                  />
                </div>
              </div>
              <p className="text-xs text-dust">Save changes first, then click ↻ Regeocode pin to push a fresh map pin. ZIP gives ~3–5 mi precision; city falls back if ZIP lookup fails.</p>
            </section>

            {/* Page Identity */}
            <section className="p-6 border border-dust bg-white space-y-4">
              <h2 className="font-[family-name:var(--font-playfair)] text-xl">Page Identity</h2>
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs text-dust block mb-1">Slug (URL path)</label>
                  <div className="flex items-center gap-1">
                    <span className="text-sm text-dust">/ranchers/</span>
                    <input value={form.slug} onChange={e => updateForm('slug', e.target.value)}
                      className="flex-1 px-3 py-2 border border-dust text-sm bg-bone" placeholder="ranch-name" />
                  </div>
                </div>
                <div>
                  <label className="text-xs text-dust block mb-1">Tagline</label>
                  <input value={form.tagline} onChange={e => updateForm('tagline', e.target.value)}
                    className="w-full px-3 py-2 border border-dust text-sm bg-bone" placeholder="Premium grass-fed beef..." />
                </div>
                <div>
                  <label className="text-xs text-dust block mb-1">Logo URL</label>
                  <input value={form.logo_url} onChange={e => updateForm('logo_url', e.target.value)}
                    className="w-full px-3 py-2 border border-dust text-sm bg-bone" placeholder="https://..." />
                </div>
                <div>
                  <label className="text-xs text-dust block mb-1">Video URL (YouTube/Vimeo)</label>
                  <input value={form.video_url} onChange={e => updateForm('video_url', e.target.value)}
                    className="w-full px-3 py-2 border border-dust text-sm bg-bone" placeholder="https://youtube.com/..." />
                </div>
                <div>
                  <label className="text-xs text-dust block mb-1">States Served</label>
                  <input value={form.states_served} onChange={e => updateForm('states_served', e.target.value)}
                    className="w-full px-3 py-2 border border-dust text-sm bg-bone" placeholder="CO, WY, MT" />
                </div>
              </div>

              {/* ── Deposit-collection readiness — can this rancher collect NOW? ── */}
              {rancher && (
                <div style={{
                  padding: '10px 12px',
                  border: `1px solid ${rancher.collect_ready ? '#2E7D32' : '#B45309'}`,
                  background: rancher.collect_ready ? '#E8F5E9' : '#FEF3C7',
                  fontSize: '13px',
                }}>
                  {rancher.collect_ready
                    ? '✅ Ready to collect deposits — tier_v2 · Connect active · priced. Flip the states below and demand routes + collects.'
                    : `🔴 Can't collect deposits yet: ${(rancher.collect_blockers || []).join(' · ')}`}
                </div>
              )}

              {/* ── Multi-State Routing — the "serve these states" flip ── */}
              <div className="border border-dust p-3 bg-bone">
                <label className="flex items-center gap-2 text-sm font-medium mb-1">
                  <input
                    type="checkbox"
                    checked={form.admin_approved_multi_state}
                    onChange={e => updateForm('admin_approved_multi_state', e.target.checked)}
                  />
                  Multi-State Routing — route buyers from other states to this rancher
                </label>
                <p className="text-xs text-dust mb-2">
                  Routing States only take effect when this is ON. Home state always routes regardless. Click states to toggle.
                </p>
                <div className="flex flex-wrap gap-1 mb-2">
                  {US_STATES.map((s) => {
                    const selected = normalizeStates(form.routing_states).includes(s.code);
                    return (
                      <button
                        key={s.code}
                        type="button"
                        title={s.name}
                        onClick={() => {
                          const cur = new Set(normalizeStates(form.routing_states));
                          if (cur.has(s.code)) cur.delete(s.code);
                          else cur.add(s.code);
                          updateForm('routing_states', stringifyStates([...cur]));
                        }}
                        style={{
                          fontSize: '11px',
                          padding: '3px 7px',
                          border: `1px solid ${selected ? '#0E0E0E' : '#A7A29A'}`,
                          background: selected ? '#0E0E0E' : 'transparent',
                          color: selected ? '#F4F1EC' : '#6B6B6B',
                          cursor: 'pointer',
                        }}
                      >
                        {s.code}
                      </button>
                    );
                  })}
                </div>
                <div className="flex items-end gap-4 flex-wrap">
                  <div>
                    <label className="text-xs text-dust block mb-1">Slots / state</label>
                    <input
                      type="number"
                      min={1}
                      value={form.slots_per_state}
                      onChange={e => updateForm('slots_per_state', e.target.value)}
                      className="w-24 px-3 py-2 border border-dust text-sm bg-bone"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => updateForm('routing_states', form.states_served)}
                    className="text-xs underline text-dust"
                  >
                    copy from States Served
                  </button>
                  <button
                    type="button"
                    onClick={() => updateForm('routing_states', '')}
                    className="text-xs underline text-dust"
                  >
                    clear all
                  </button>
                </div>
                <p className="text-xs mt-2 text-dust">
                  {(() => {
                    const codes = normalizeStates(form.routing_states);
                    if (!form.admin_approved_multi_state) return '⚠️ Toggle Multi-State ON for these states to actually route.';
                    if (codes.length === 0) return 'No states selected yet.';
                    const per = Math.max(1, parseInt(String(form.slots_per_state), 10) || 5);
                    // Home state is ALWAYS in the served set (finding 2) — show
                    // it so the operator sees exactly what the matcher will do.
                    const home = normalizeState(rancher?.state || '');
                    const served = Array.from(new Set([home, ...codes].filter(Boolean)));
                    return `✅ Will route ${served.length} state${served.length === 1 ? '' : 's'}: ${served.join(', ')}${home ? ` (home ${home} always served)` : ''} · ${per} slots each. (To COLLECT, confirm the readiness banner above is green.)`;
                  })()}
                </p>
              </div>

              <div>
                <label className="text-xs text-dust block mb-1">About Text</label>
                <textarea value={form.about_text} onChange={e => updateForm('about_text', e.target.value)}
                  rows={5} className="w-full px-3 py-2 border border-dust text-sm bg-bone" placeholder="Tell the ranch's story..." />
              </div>
              <div>
                <label className="text-xs text-dust block mb-1">Custom Notes (displayed on page)</label>
                <textarea value={form.custom_notes} onChange={e => updateForm('custom_notes', e.target.value)}
                  rows={3} className="w-full px-3 py-2 border border-dust text-sm bg-bone" placeholder="Special notes for buyers..." />
              </div>
            </section>

            {/* Pricing */}
            <section className="p-6 border border-dust bg-white space-y-4">
              <h2 className="font-[family-name:var(--font-playfair)] text-xl">Pricing & Payment Links</h2>
              {['quarter', 'half', 'whole'].map(tier => (
                <div key={tier} className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="text-xs text-dust block mb-1">{tier.charAt(0).toUpperCase() + tier.slice(1)} Price ($)</label>
                    <input value={(form as any)[`${tier}_price`]} onChange={e => updateForm(`${tier}_price`, e.target.value)}
                      type="number" className="w-full px-3 py-2 border border-dust text-sm bg-bone" placeholder="0" />
                  </div>
                  <div>
                    <label className="text-xs text-dust block mb-1">{tier.charAt(0).toUpperCase() + tier.slice(1)} lbs</label>
                    <input value={(form as any)[`${tier}_lbs`]} onChange={e => updateForm(`${tier}_lbs`, e.target.value)}
                      className="w-full px-3 py-2 border border-dust text-sm bg-bone" placeholder="100-120 lbs" />
                  </div>
                  <div>
                    <label className="text-xs text-dust block mb-1">{tier.charAt(0).toUpperCase() + tier.slice(1)} Payment Link</label>
                    <input value={(form as any)[`${tier}_payment_link`]} onChange={e => updateForm(`${tier}_payment_link`, e.target.value)}
                      className="w-full px-3 py-2 border border-dust text-sm bg-bone" placeholder="https://..." />
                  </div>
                </div>
              ))}
              <div className="grid md:grid-cols-2 gap-3 pt-2 border-t border-dust/30">
                <div>
                  <label className="text-xs text-dust block mb-1">Next Processing Date</label>
                  <input value={form.next_processing_date} onChange={e => updateForm('next_processing_date', e.target.value)}
                    type="date" className="w-full px-3 py-2 border border-dust text-sm bg-bone" />
                </div>
                <div>
                  <label className="text-xs text-dust block mb-1">Reserve Link</label>
                  <input value={form.reserve_link} onChange={e => updateForm('reserve_link', e.target.value)}
                    className="w-full px-3 py-2 border border-dust text-sm bg-bone" placeholder="https://..." />
                </div>
              </div>
            </section>

            {/* Testimonials */}
            <section className="p-6 border border-dust bg-white space-y-4">
              <h2 className="font-[family-name:var(--font-playfair)] text-xl">Customer Testimonials ({testimonials.length})</h2>
              {testimonials.map((t, i) => (
                <div key={i} className="p-3 border border-dust/50 flex justify-between items-start">
                  <div>
                    <p className="text-sm italic">&ldquo;{t.quote}&rdquo;</p>
                    <p className="text-xs text-saddle mt-1">— {t.name}{t.location ? `, ${t.location}` : ''}</p>
                  </div>
                  <button onClick={() => removeTestimonial(i)} className="text-weathered text-xs hover:underline ml-2">Remove</button>
                </div>
              ))}
              <div className="grid md:grid-cols-3 gap-2">
                <input value={newTestimonial.name} onChange={e => setNewTestimonial({ ...newTestimonial, name: e.target.value })}
                  className="px-3 py-2 border border-dust text-sm bg-bone" placeholder="Customer name" />
                <input value={newTestimonial.location || ''} onChange={e => setNewTestimonial({ ...newTestimonial, location: e.target.value })}
                  className="px-3 py-2 border border-dust text-sm bg-bone" placeholder="Location (optional)" />
                <button onClick={addTestimonial} className="px-3 py-2 text-sm bg-charcoal text-bone hover:bg-divider">
                  + Add
                </button>
              </div>
              <textarea value={newTestimonial.quote} onChange={e => setNewTestimonial({ ...newTestimonial, quote: e.target.value })}
                rows={2} className="w-full px-3 py-2 border border-dust text-sm bg-bone" placeholder="Their testimonial quote..." />
            </section>

            {/* Gallery Photos */}
            <section className="p-6 border border-dust bg-white space-y-4">
              <h2 className="font-[family-name:var(--font-playfair)] text-xl">Gallery Photos ({galleryPhotos.length})</h2>
              <div className="grid grid-cols-3 md:grid-cols-4 gap-2">
                {galleryPhotos.map((url, i) => (
                  <div key={i} className="relative group">
                    <img src={url} alt={`Photo ${i + 1}`} className="w-full aspect-square object-cover border border-dust" />
                    <button onClick={() => removeGalleryPhoto(i)}
                      className="absolute top-1 right-1 bg-weathered text-white text-xs px-1.5 py-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      X
                    </button>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <input value={newPhotoUrl} onChange={e => setNewPhotoUrl(e.target.value)}
                  className="flex-1 px-3 py-2 border border-dust text-sm bg-bone" placeholder="Image URL (https://...)" />
                <button onClick={addGalleryPhoto} className="px-4 py-2 text-sm bg-charcoal text-bone hover:bg-divider">
                  + Add Photo
                </button>
              </div>
            </section>

            {/* Custom Products */}
            <section className="p-6 border border-dust bg-white space-y-4">
              <h2 className="font-[family-name:var(--font-playfair)] text-xl">Custom Products ({customProducts.length})</h2>
              <p className="text-xs text-dust">Add additional products beyond quarter/half/whole beef (e.g. sampler boxes, jerky, bones).</p>
              {customProducts.map((p, i) => (
                <div key={i} className="p-3 border border-dust/50 flex justify-between items-start">
                  <div>
                    <p className="text-sm font-medium">{p.name} — ${p.price}</p>
                    {p.description && <p className="text-xs text-saddle mt-0.5">{p.description}</p>}
                    {p.link && <p className="text-xs text-dust mt-0.5 truncate max-w-md">{p.link}</p>}
                  </div>
                  <button onClick={() => removeCustomProduct(i)} className="text-weathered text-xs hover:underline ml-2">Remove</button>
                </div>
              ))}
              <div className="grid md:grid-cols-2 gap-2">
                <input value={newProduct.name} onChange={e => setNewProduct({ ...newProduct, name: e.target.value })}
                  className="px-3 py-2 border border-dust text-sm bg-bone" placeholder="Product name" />
                <input value={newProduct.price} onChange={e => setNewProduct({ ...newProduct, price: e.target.value })}
                  type="number" className="px-3 py-2 border border-dust text-sm bg-bone" placeholder="Price ($)" />
              </div>
              <input value={newProduct.description} onChange={e => setNewProduct({ ...newProduct, description: e.target.value })}
                className="w-full px-3 py-2 border border-dust text-sm bg-bone" placeholder="Short description (e.g. 10 lbs of mixed cuts)" />
              <div className="flex gap-2">
                <input value={newProduct.link} onChange={e => setNewProduct({ ...newProduct, link: e.target.value })}
                  className="flex-1 px-3 py-2 border border-dust text-sm bg-bone" placeholder="Payment link (https://...)" />
                <button onClick={addCustomProduct} className="px-4 py-2 text-sm bg-charcoal text-bone hover:bg-divider">
                  + Add Product
                </button>
              </div>
            </section>

            {/* Social & Verification */}
            <section className="p-6 border border-dust bg-white space-y-4">
              <h2 className="font-[family-name:var(--font-playfair)] text-xl">Social Proof & Verification</h2>
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs text-dust block mb-1">Google Reviews URL</label>
                  <input value={form.google_reviews_url} onChange={e => updateForm('google_reviews_url', e.target.value)}
                    className="w-full px-3 py-2 border border-dust text-sm bg-bone" placeholder="https://..." />
                </div>
                <div>
                  <label className="text-xs text-dust block mb-1">Facebook URL</label>
                  <input value={form.facebook_url} onChange={e => updateForm('facebook_url', e.target.value)}
                    className="w-full px-3 py-2 border border-dust text-sm bg-bone" placeholder="https://facebook.com/..." />
                </div>
                <div>
                  <label className="text-xs text-dust block mb-1">Instagram URL</label>
                  <input value={form.instagram_url} onChange={e => updateForm('instagram_url', e.target.value)}
                    className="w-full px-3 py-2 border border-dust text-sm bg-bone" placeholder="https://instagram.com/..." />
                </div>
                <div>
                  <label className="text-xs text-dust block mb-1">Processing Facility (USDA)</label>
                  <input value={form.processing_facility} onChange={e => updateForm('processing_facility', e.target.value)}
                    className="w-full px-3 py-2 border border-dust text-sm bg-bone" placeholder="Facility name" />
                </div>
              </div>
              <div className="grid md:grid-cols-3 gap-4 pt-4 border-t border-dust/30">
                <div>
                  <label className="text-xs text-dust block mb-1">Verification Method</label>
                  <input value={form.verification_method} onChange={e => updateForm('verification_method', e.target.value)}
                    className="w-full px-3 py-2 border border-dust text-sm bg-bone" placeholder="e.g. Testimonials, Photos" />
                </div>
                <div>
                  <label className="text-xs text-dust block mb-1">Verification Status</label>
                  <select value={form.verification_status} onChange={e => updateForm('verification_status', e.target.value)}
                    className="w-full px-3 py-2 border border-dust text-sm bg-bone">
                    <option value="">Not Started</option>
                    <option value="Pending">Pending</option>
                    <option value="Verified">Verified</option>
                    <option value="Needs More Info">Needs More Info</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-dust block mb-1">Verification Notes</label>
                  <input value={form.verification_notes} onChange={e => updateForm('verification_notes', e.target.value)}
                    className="w-full px-3 py-2 border border-dust text-sm bg-bone" placeholder="Internal notes..." />
                </div>
              </div>
            </section>

            {/* Send V2 Upgrade — tier picker modal (Manifest #18: replaced the
                window.prompt() typing test; same POST + targetTier contract). */}
            {upgradeModalOpen && (
              <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
                <div className="bg-white max-w-lg w-full p-6 space-y-4">
                  <h3 className="font-[family-name:var(--font-playfair)] text-xl">
                    Send V2 Upgrade Invite
                  </h3>
                  <p className="text-sm text-saddle">
                    Emails <strong>{rancherName()}</strong> ({rancher?.email || 'no email on file'}) the
                    deposit-standardization explainer + a 60-day wizard link for tier subscription +
                    Stripe Connect. A paid target plan lands them pre-selected on that plan and straight
                    into its checkout.
                  </p>
                  <div className="space-y-2">
                    <label className="block text-sm font-medium" htmlFor="upgrade-target-tier">
                      Target plan
                    </label>
                    <select
                      id="upgrade-target-tier"
                      value={upgradeTargetTier}
                      onChange={(e) => setUpgradeTargetTier(e.target.value)}
                      className="w-full px-4 py-3 border border-dust bg-bone text-sm"
                    >
                      <option value="pasture">Pasture — $150/mo (paid)</option>
                      <option value="ranch">Ranch — $350/mo (paid)</option>
                      <option value="operator">Operator — $500/mo (paid)</option>
                      <option value="">Legacy Connect — free, no subscription</option>
                    </select>
                  </div>
                  <div className="flex gap-2 pt-2">
                    <button
                      onClick={() => handleSendV2Upgrade(upgradeTargetTier)}
                      disabled={actionBusy === 'send-v2-upgrade'}
                      className="flex-1 px-4 py-3 bg-charcoal text-bone text-sm font-medium hover:bg-divider disabled:opacity-50"
                    >
                      {actionBusy === 'send-v2-upgrade' ? 'Sending…' : 'Send Invite'}
                    </button>
                    <button
                      onClick={() => setUpgradeModalOpen(false)}
                      className="flex-1 px-4 py-3 border border-dust text-sm hover:bg-dust"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Bottom save */}
            <div className="flex justify-between items-center pt-4">
              <button onClick={() => router.push('/admin/ranchers')} className="text-sm text-saddle hover:underline">
                &larr; Back to Ranchers
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-8 py-3 bg-charcoal text-bone hover:bg-divider disabled:opacity-50"
              >
                {saving ? 'Saving...' : saved ? 'Saved!' : 'Save All Changes'}
              </button>
            </div>
          </div>
        </Container>
      </main>
    </AdminAuthGuard>
  );
}
