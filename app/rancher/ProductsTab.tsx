'use client';

// Products tab — rancher self-serve marketplace products (journey overhaul
// Phase 6, the supply loop). A Connect-active rancher lists a low-ticket
// product here and it auto-appears on the public /shop marketplace within
// seconds (the API revalidates /shop on create/edit).
//
// Pricing model is transparent: the rancher types the RETAIL price the buyer
// pays; the form live-shows "you net $X · buyhalfcow's cut $Y" from the same
// pure margin math the API uses (lib/rancherProductInput), so there's never a
// surprise at payout time. The cut is skimmed automatically at checkout as
// the Stripe application fee — the rancher never invoices BHC or vice versa.
//
// Non-Connect ranchers see a setup nudge instead of a form they can't submit
// (mirrors the go-live gate pattern).

import { useEffect, useState } from 'react';
import Link from 'next/link';
import ShopifyConnectCard from './ShopifyConnectCard';
import {
  PRODUCT_CATEGORIES,
  deriveProductPricing,
  MIN_PRODUCT_PRICE_CENTS,
} from '@/lib/rancherProductInput';
import { absorptionPreview } from '@/lib/feeMath';
import { decideSyncManagedRow } from '@/lib/syncManagedProductFence';
// Pure + import-clean (no Airtable, no env, no next/server) — safe in a
// client component. Same helper the SHARE rail's member order card uses.
import { carrierTrackingUrl } from '@/lib/trackingLink';

interface RancherOrder {
  id: string;
  ref: string;
  productName: string;
  buyerName: string;
  buyerEmail: string;
  shipTo: string;
  buyerPaid: number;
  payout: number;
  status: string;
  orderedAt: string;
  shippedAt: string;
  trackingNumber: string;
  /** Shop-chain audit 2026-08-01 — turns the number into a clickable link. */
  carrier?: string;
  depositStyle: boolean;
  // Wave C (2026-07-14): pickup orders ('PICKUP — ' Order Ref marker) get
  // "mark picked up" with no tracking input — the buyer drives out, nothing
  // ships. Optional-safe read below so stale caches can't crash the tab.
  pickup?: boolean;
}

interface RancherProduct {
  id: string;
  name: string;
  price: number;
  base: number;
  category: string;
  weight: string;
  description: string;
  image: string;
  shipsNationwide: boolean;
  externalCheckoutUrl: string;
  shelfStable: boolean;
  active: boolean;
  live: boolean;
  // Deposit-style (price-range) rows are ops-managed: the price shown is the
  // DEPOSIT, Base is hand-set, and content edits go through Ben (the API
  // fences them). Hide/show still works.
  depositStyle?: boolean;
  // Sync-managed (Shopify catalog) rows are owned by the 6h catalog cron —
  // it recomputes Active/name/price/stock and resurrects deletes by SKU, so
  // the tab fences edit/duplicate/delete/show and shows a "managed from your
  // Shopify" affordance. 'Marketplace Approved' is BHC's curation gate: until
  // it's checked, a synced row is "pending review", not a rancher-hidden row.
  syncManaged?: boolean;
  marketplaceApproved?: boolean;
  priceRange?: string;
  ordersLeft?: number | null;
  whatsIncluded?: string;
  shipsInDays?: number | null;
  packaging?: string;
  feeds?: string;
  shippingCost?: number | null;
  /** 'included' | 'charged' | '' — '' = predates the question, must be asked. */
  shippingChoice?: string;
  localOnly?: boolean;
}

const money = (n: number) => `$${n.toFixed(2)}`;

const EMPTY_FORM = {
  name: '',
  displayPrice: '',
  category: '' as string,
  weight: '',
  description: '',
  imageUrl: '',
  shipsNationwide: true,
  externalCheckoutUrl: '',
  shelfStable: false,
  ordersLeft: '' as string, // blank = unlimited
  whatsIncluded: '',
  shipsInDays: '' as string,
  packaging: '',
  feeds: '',
  shippingCost: '' as string,
  // Shop-chain audit 2026-08-01: '' means UNANSWERED and the API refuses it
  // on a nationwide product — the whole point is that nobody drifts into
  // eating cold-chain costs by leaving a field blank.
  shippingChoice: '' as string,
};

export default function ProductsTab({
  connectActive,
  connectStatus = '',
  onGoToMyPage,
  onOrdersChanged,
}: {
  connectActive: boolean;
  // Wave 2 rancher-UX: the cached Connect status string ('restricted',
  // 'onboarding', …). A rancher who ALREADY finished Stripe and later went
  // restricted (routine re-KYC, bank removed) used to read "finish your
  // Stripe setup first — takes a few minutes" — blaming them for a setup
  // they completed. Restricted gets its own copy + the restricted-resolution
  // flow instead of the generic billing link.
  connectStatus?: string;
  onGoToMyPage: () => void;
  // Wave C — lets the dashboard shell keep its "N to ship" spine badge + Home
  // card in sync when orders load here or one gets marked shipped. Optional
  // so the component stays drop-in anywhere else.
  onOrdersChanged?: (orders: RancherOrder[]) => void;
}) {
  const [products, setProducts] = useState<RancherProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');

  // Orders loop (Phase 10): the rancher's marketplace orders live HERE, next
  // to the products that generate them — see it, ship it, paste tracking.
  const [orders, setOrders] = useState<RancherOrder[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [ordersErr, setOrdersErr] = useState('');
  const [shippingId, setShippingId] = useState<string | null>(null);
  const [trackingDraft, setTrackingDraft] = useState<Record<string, string>>({});
  const [carrierDraft, setCarrierDraft] = useState<Record<string, string>>({});
  // Cancel + refund (shop-chain audit 2026-08-01). Two-step by design: the
  // first click only ARMS the confirm — no single click ever moves money.
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  // Stock-only inline editor for deposit-style rows (full edit is ops-fenced,
  // but stock must stay rancher-updatable — the monthly check-in depends on it).
  const [stockDraft, setStockDraft] = useState<Record<string, string>>({});
  const [stockSavingId, setStockSavingId] = useState<string | null>(null);

  // Restricted-resolution flow (Wave 2 rancher-UX) — mirrors the dashboard
  // banner's resolveRestricted: live status read → fresh onboarding link when
  // Stripe says the restriction is resumable, billing portal otherwise.
  // Same-tab navigation on purpose (window.open after an await is silently
  // popup-blocked on mobile).
  const [restrictedBusy, setRestrictedBusy] = useState(false);
  const [restrictedErr, setRestrictedErr] = useState('');
  async function resolveRestrictedFromProducts() {
    setRestrictedErr('');
    setRestrictedBusy(true);
    try {
      const statusRes = await fetch('/api/rancher/connect/status', { credentials: 'include' });
      const statusData = await statusRes.json().catch(() => ({} as any));
      const canResume = statusRes.ok && statusData?.canResumeOnboarding === true;
      if (canResume) {
        const res = await fetch('/api/rancher/connect/start', { method: 'POST', credentials: 'include' });
        const data = await res.json().catch(() => ({} as any));
        if (res.ok && data?.url) {
          window.location.href = data.url;
          return;
        }
        setRestrictedErr(data?.error || 'could not open Stripe onboarding — try again in a moment.');
        return;
      }
      const portalRes = await fetch('/api/rancher/tier/portal', { credentials: 'include' });
      const portalData = await portalRes.json().catch(() => ({} as any));
      if (portalRes.ok && portalData?.url) {
        window.location.href = portalData.url;
        return;
      }
      setRestrictedErr(portalData?.error || 'could not open the Stripe portal — try again in a moment.');
    } catch {
      setRestrictedErr('network error — try again in a moment.');
    } finally {
      setRestrictedBusy(false);
    }
  }

  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState('');
  const [savedNote, setSavedNote] = useState('');
  const [uploading, setUploading] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/rancher/products');
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || `load failed (${res.status})`);
        setProducts(data.products || []);
      } catch (e: any) {
        setLoadErr(e?.message || 'could not load your products');
      } finally {
        setLoading(false);
      }
    })();
    loadOrders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // FALSE-EMPTY FIX (Wave A 2026-07-14, same class as the inbox 401 bug in
  // #374): a non-OK /api/rancher/orders used to be swallowed by an empty
  // catch, so a 500 or expired session rendered exactly like "no orders" —
  // a rancher clicking through the SLA nudge during a blip concluded there
  // was nothing to ship. Now: 401/403 → login redirect (like inbox), any
  // other failure → visible error card with a retry button.
  async function loadOrders() {
    setOrdersLoading(true);
    setOrdersErr('');
    try {
      const res = await fetch('/api/rancher/orders');
      if (res.status === 401 || res.status === 403) {
        window.location.href = '/rancher/login';
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `could not load your orders (${res.status})`);
      setOrders(data.orders || []);
      onOrdersChanged?.(data.orders || []);
    } catch (e: any) {
      setOrdersErr(e?.message || 'could not load your orders — refresh in a minute.');
    } finally {
      setOrdersLoading(false);
    }
  }

  async function markShipped(o: RancherOrder) {
    setShippingId(o.id);
    setSaveErr('');
    try {
      const res = await fetch('/api/rancher/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Pickup orders carry no tracking — the server ignores it anyway.
        body: JSON.stringify({
          orderId: o.id,
          trackingNumber: o.pickup ? '' : (trackingDraft[o.id] || '').trim(),
          // Carrier makes the buyer's tracking number a real link instead of
          // a number they have to go paste somewhere themselves.
          carrier: o.pickup ? '' : (carrierDraft[o.id] || '').trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'update failed');
      const next = orders.map((x) =>
        x.id === o.id
          ? data.order?.productName
            ? (data.order as RancherOrder)
            : { ...x, status: 'Shipped' }
          : x,
      );
      setOrders(next);
      // Wave C — keep the dashboard shell's "N to ship" badge honest.
      onOrdersChanged?.(next);
      // Honest copy: never claim "the buyer just got the tracking email" —
      // that's false whenever the send fails or the buyer email is blank.
      setSavedNote(o.pickup ? 'marked complete.' : 'marked shipped.');
    } catch (e: any) {
      setSaveErr(e?.message || 'could not mark shipped');
    } finally {
      setShippingId(null);
    }
  }

  // CANCEL + REFUND (shop-chain audit 2026-08-01). Before this there was no
  // refund or cancel path at all for a rancher OR an admin on a product order
  // — it took the Stripe dashboard, and the order row stayed shippable until
  // the webhook caught up. The server does the real guarding (pure decision in
  // lib/productOrderTermination + a fail-closed status flip BEFORE the money
  // moves); this is just the two-step affordance in front of it.
  async function cancelOrder(o: RancherOrder) {
    setCancellingId(o.id);
    setSaveErr('');
    try {
      const res = await fetch('/api/rancher/orders/refund', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: o.id, action: 'cancel', confirm: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `could not cancel this order (${res.status})`);
      const next = orders.map((x) => (x.id === o.id ? { ...x, status: data?.status || 'Cancelled' } : x));
      setOrders(next);
      onOrdersChanged?.(next);
      setSavedNote('cancelled — the buyer has been refunded and emailed.');
      setConfirmCancelId(null);
    } catch (e: any) {
      setSaveErr(e?.message || 'could not cancel this order');
    } finally {
      setCancellingId(null);
    }
  }

  // Live net preview from the SAME pure math the API applies — no drift.
  const priceNum = Number(form.displayPrice);
  const priceCents = Number.isFinite(priceNum) ? Math.round(priceNum * 100) : 0;
  const preview =
    priceCents >= MIN_PRODUCT_PRICE_CENTS && form.category
      ? deriveProductPricing({ displayCents: priceCents, category: form.category })
      : null;
  // Walkthrough 2026-07-15: below the $5 floor (or with no category) the
  // preview silently vanished — the rancher had no idea why. Say why.
  const previewHint =
    priceCents > 0 && priceCents < MIN_PRODUCT_PRICE_CENTS
      ? `minimum price is $${(MIN_PRODUCT_PRICE_CENTS / 100).toFixed(0)}`
      : priceCents >= MIN_PRODUCT_PRICE_CENTS && !form.category
        ? 'pick a category to see your net'
        : '';

  function startAdd() {
    setForm({ ...EMPTY_FORM });
    setEditingId(null);
    setSaveErr('');
    setSavedNote('');
    setShowForm(true);
  }

  function startEdit(p: RancherProduct) {
    setForm({
      name: p.name,
      displayPrice: String(p.price || ''),
      category: p.category,
      weight: p.weight,
      description: p.description,
      imageUrl: p.image,
      shipsNationwide: p.shipsNationwide,
      externalCheckoutUrl: p.externalCheckoutUrl || '',
      shelfStable: p.shelfStable,
      ordersLeft: p.ordersLeft == null ? '' : String(p.ordersLeft),
      whatsIncluded: p.whatsIncluded || '',
      shipsInDays: p.shipsInDays == null ? '' : String(p.shipsInDays),
      packaging: p.packaging || '',
      feeds: p.feeds || '',
      shippingCost: p.shippingCost == null ? '' : String(p.shippingCost),
      // Pre-fills from the recorded answer; a listing that predates the
      // question comes back '' and the rancher is asked once.
      shippingChoice: p.shippingChoice || '',
    });
    setEditingId(p.id);
    setSaveErr('');
    setSavedNote('');
    setShowForm(true);
  }

  async function uploadPhoto(file: File) {
    setUploading(true);
    setSaveErr('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/rancher/upload', { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.url) throw new Error(data?.error || 'upload failed');
      setForm((f) => ({ ...f, imageUrl: data.url }));
    } catch (e: any) {
      setSaveErr(e?.message || 'photo upload failed — try a smaller image');
    } finally {
      setUploading(false);
    }
  }

  async function save() {
    setSaveErr('');
    setSavedNote('');
    setSaving(true);
    try {
      const payload = {
        name: form.name,
        displayPrice: Number(form.displayPrice),
        category: form.category,
        weight: form.weight,
        description: form.description,
        imageUrl: form.imageUrl,
        shipsNationwide: form.shipsNationwide,
        externalCheckoutUrl: form.externalCheckoutUrl.trim(),
        shelfStable: form.shelfStable,
        ordersLeft: form.ordersLeft.trim() === '' ? '' : Number(form.ordersLeft),
        whatsIncluded: form.whatsIncluded,
        shipsInDays: form.shipsInDays.trim() === '' ? '' : Number(form.shipsInDays),
        packaging: form.packaging,
        feeds: form.feeds,
        shippingCost: form.shippingCost.trim() === '' ? '' : Number(form.shippingCost),
        shippingChoice: form.shippingChoice,
      };
      const res = await fetch('/api/rancher/products', {
        method: editingId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editingId ? { productId: editingId, ...payload } : payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `save failed (${res.status})`);

      if (editingId) {
        // Same blank-row guard as toggleActive.
        if (data.product?.name) {
          setProducts((list) => list.map((p) => (p.id === editingId ? data.product : p)));
        }
        setSavedNote('saved — the marketplace updates in a few seconds.');
      } else {
        // Blank-row guard (same as toggle/edit): the route's post-create
        // re-fetch can blip and return only {id} — rendering that stub crashed
        // the tab right after a SUCCESSFUL first save (error boundary + a
        // duplicate-resubmit trap). Render a minimal row from the form instead.
        const createdRow: RancherProduct = data.product?.name
          ? data.product
          : {
              id: String(data.product?.id || ''),
              name: form.name,
              price: Number(form.displayPrice) || 0,
              base: 0,
              category: form.category,
              weight: form.weight,
              description: form.description,
              image: form.imageUrl,
              shipsNationwide: form.shipsNationwide,
              externalCheckoutUrl: form.externalCheckoutUrl.trim(),
              shelfStable: form.shelfStable,
              active: true,
              live: false, // next load reconciles the real state
            };
        if (createdRow.id) setProducts((list) => [createdRow, ...list]);
        // Share nudge points at THEIR product page when it's actually live
        // (a non-sellable row's PDP 404s — never hand out a dead link).
        setSavedNote(
          data.pendingApproval
            ? 'saved — held for a quick review before it lists.'
            : data.product?.live && data.product?.id
              ? `live on the marketplace in a few seconds. share it: buyhalfcow.com/shop/${data.product.id}`
              : 'live on the marketplace in a few seconds. share it: buyhalfcow.com/shop',
        );
      }
      setShowForm(false);
      setEditingId(null);
      setForm({ ...EMPTY_FORM });
    } catch (e: any) {
      setSaveErr(e?.message || 'could not save — try again');
    } finally {
      setSaving(false);
    }
  }

  async function saveStock(p: RancherProduct) {
    setStockSavingId(p.id);
    setSaveErr('');
    try {
      const raw = (stockDraft[p.id] ?? '').trim();
      const res = await fetch('/api/rancher/products', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: p.id, ordersLeft: raw === '' ? '' : Number(raw) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'stock update failed');
      if (data.product?.name) {
        setProducts((list) => list.map((x) => (x.id === p.id ? data.product : x)));
      }
      setSavedNote('stock updated — the marketplace reflects it in a few seconds.');
      setStockDraft((d) => ({ ...d, [p.id]: '' }));
    } catch (e: any) {
      setSaveErr(e?.message || 'could not update stock');
    } finally {
      setStockSavingId(null);
    }
  }

  async function toggleActive(p: RancherProduct) {
    setTogglingId(p.id);
    setSaveErr('');
    try {
      const res = await fetch('/api/rancher/products', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: p.id, active: !p.active }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'update failed');
      // Blank-row guard: the route's fresh re-fetch can fail and return only
      // {id} — never swap a full row for a stub; keep the old row instead.
      if (data.product?.name) {
        setProducts((list) => list.map((x) => (x.id === p.id ? data.product : x)));
      }
      if (data.pendingApproval) {
        setSavedNote('sent for a quick review — it lists as soon as ben approves it.');
      }
    } catch (e: any) {
      // Audit fix: hide/show failures were fully silent — click, nothing
      // happens, no message (expired session, Airtable blip, Connect gate).
      setSaveErr(e?.message || 'could not update — refresh and try again');
    } finally {
      setTogglingId(null);
    }
  }

  async function deleteProduct(p: RancherProduct) {
    if (!window.confirm(`delete "${p.name}" for good? this can't be undone.`)) return;
    setTogglingId(p.id);
    setSaveErr('');
    try {
      const res = await fetch('/api/rancher/products', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: p.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'delete failed');
      setProducts((list) => list.filter((x) => x.id !== p.id));
      setSavedNote('deleted.');
    } catch (e: any) {
      setSaveErr(e?.message || 'could not delete — refresh and try again');
    } finally {
      setTogglingId(null);
    }
  }

  // Duplicate: prefill the add form from an existing row (photo URL carries
  // over — no re-upload). Deposit-style rows are ops-managed and excluded.
  function startDuplicate(p: RancherProduct) {
    setForm({
      name: `${p.name} (copy)`,
      displayPrice: String(p.price || ''),
      category: p.category,
      weight: p.weight,
      description: p.description,
      imageUrl: p.image,
      shipsNationwide: p.shipsNationwide,
      externalCheckoutUrl: p.externalCheckoutUrl || '',
      shelfStable: p.shelfStable,
      ordersLeft: p.ordersLeft == null ? '' : String(p.ordersLeft),
      whatsIncluded: p.whatsIncluded || '',
      shipsInDays: p.shipsInDays == null ? '' : String(p.shipsInDays),
      packaging: p.packaging || '',
      feeds: p.feeds || '',
      shippingCost: p.shippingCost == null ? '' : String(p.shippingCost),
      shippingChoice: p.shippingChoice || '',
    });
    setEditingId(null); // POST, not PATCH — creates a new row
    setSaveErr('');
    setSavedNote('');
    setShowForm(true);
  }

  // ── Connect gate (Wave A 2026-07-14: SCOPED to product management only).
  // This used to be a whole-tab early return — a Connect downgrade
  // (active→restricted, routine Stripe re-KYC) removed the entire ship UI,
  // hiding PAID unshipped orders behind the "finish stripe setup" card while
  // 48h chargeback escalations fired. Orders (below) now render
  // unconditionally — mark-shipped has no Connect gate server-side either —
  // and only the add/edit form + product list sit behind the nudge.
  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <h2 className="font-serif text-2xl">Products</h2>
          <p className="text-sm text-saddle mt-1 max-w-xl">
            list a product once — it goes live on{' '}
            <a href="/shop" target="_blank" className="underline hover:text-charcoal">
              the marketplace
            </a>{' '}
            in seconds. buyers pay online, you ship, your payout lands automatically.
          </p>
        </div>
        {connectActive && !showForm && (
          <button
            onClick={startAdd}
            className="px-5 py-3 bg-charcoal text-bone text-sm font-medium uppercase tracking-wider hover:bg-saddle transition-colors whitespace-nowrap"
          >
            + add a product
          </button>
        )}
      </div>

      {savedNote && (
        <p className="text-sm text-sage border border-sage/40 bg-bone-warm px-4 py-3">{savedNote}</p>
      )}
      {/* Errors from mark-shipped / stock updates fire while the form is
          CLOSED — rendering saveErr only inside the form made those failures
          invisible (rancher clicks, nothing happens, order stays unshipped). */}
      {!showForm && saveErr && (
        <p className="text-sm text-weathered border border-weathered/40 bg-bone-warm px-4 py-3">{saveErr}</p>
      )}

      {/* ── Add / edit form ── */}
      {connectActive && showForm && (
        <div className="border border-dust bg-bone-warm p-5 space-y-4 max-w-2xl">
          <div className="font-serif text-lg">{editingId ? 'edit product' : 'add a product'}</div>
          {/* The header must match lib/rancherProductInput.ts truth: a
              SHIPPABLE product also 400s without a shipping choice and
              ships-in days — "only name, category, and price" was a lie the
              rancher discovered at save time. */}
          <p className="text-xs text-saddle">
            {form.shipsNationwide
              ? <>Required <span className="text-weathered">*</span>: name, category, price, your shipping choice, and ships-in days — everything else is optional.</>
              : <>Only <span className="text-weathered">*</span> name, category, and price are required — everything else is optional.</>}
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="block">
              <span className="block text-xs uppercase tracking-wider text-saddle mb-1.5">
                product name <span className="text-weathered">*</span>
              </span>
              <input
                type="text"
                value={form.name}
                maxLength={80}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Peppered Beef Jerky — 3 oz"
                className="w-full p-3 border border-dust bg-bone text-[15px]"
              />
            </label>
            <label className="block">
              <span className="block text-xs uppercase tracking-wider text-saddle mb-1.5">
                category <span className="text-weathered">*</span>
              </span>
              <select
                value={form.category}
                onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                className="w-full p-3 border border-dust bg-bone text-[15px]"
              >
                <option value="">— pick one —</option>
                {PRODUCT_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <label className="block">
              <span className="block text-xs uppercase tracking-wider text-saddle mb-1.5">
                retail price (what the buyer pays) <span className="text-weathered">*</span>
              </span>
              <input
                type="number"
                min="5"
                step="0.01"
                value={form.displayPrice}
                onChange={(e) => setForm((f) => ({ ...f, displayPrice: e.target.value }))}
                placeholder="19.99"
                className="w-full p-3 border border-dust bg-bone text-[15px]"
              />
            </label>
            {/* SHIPPING IS A DELIBERATE CHOICE (shop-chain audit 2026-08-01).
                The old field was "shipping charge (optional)" beside a
                nationwide checkbox that defaults ON — so the default outcome
                was blank shipping and a rancher silently eating the cold-chain
                cost on every order. Now they pick, and the pick is persisted
                (Shipping Cost 0 = "my price covers it"). */}
            <label className="block">
              <span className="block text-xs uppercase tracking-wider text-saddle mb-1.5">
                shipping {form.shipsNationwide && <span className="text-weathered">*</span>}
              </span>
              <select
                value={form.shippingChoice}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    shippingChoice: e.target.value,
                    // Switching to "included" clears any stale amount so the
                    // buyer is never charged for shipping you said you cover.
                    shippingCost: e.target.value === 'included' ? '' : f.shippingCost,
                  }))
                }
                disabled={!form.shipsNationwide}
                className="w-full p-3 border border-dust bg-bone text-[15px] disabled:opacity-40"
              >
                <option value="">— pick one —</option>
                <option value="included">my price already includes shipping</option>
                <option value="charged">the buyer pays shipping on top</option>
              </select>
              {form.shipsNationwide && form.shippingChoice === 'charged' && (
                <input
                  type="number"
                  min="0.01"
                  max="200"
                  step="0.01"
                  value={form.shippingCost}
                  onChange={(e) => setForm((f) => ({ ...f, shippingCost: e.target.value }))}
                  placeholder="e.g. 65.00"
                  className="w-full mt-2 p-3 border border-dust bg-bone text-[15px]"
                />
              )}
              <span className="block text-[11px] text-saddle mt-1">
                {!form.shipsNationwide ? (
                  <>local pickup &mdash; no shipping is ever charged on this product.</>
                ) : (
                  <>
                    shipping frozen beef cross-country usually runs <strong>$40 to $90</strong> a box.
                    if your price doesn&rsquo;t cover that, you&rsquo;re paying it out of your own cut
                    on every order. whatever the buyer pays for shipping, 100% of it comes to you.
                    pack frozen with dry ice in an insulated liner — 2-day shipping or faster.
                  </>
                )}
              </span>
            </label>
            <label className="block">
              <span className="block text-xs uppercase tracking-wider text-saddle mb-1.5">
                weight / size (optional)
              </span>
              <input
                type="text"
                value={form.weight}
                maxLength={60}
                onChange={(e) => setForm((f) => ({ ...f, weight: e.target.value }))}
                placeholder="3 oz · 10 sticks · ~12 lbs"
                className="w-full p-3 border border-dust bg-bone text-[15px]"
              />
            </label>
          </div>

          {/* THE INFORMATION GAP (Phase 12): buyers buy what they understand.
              These four fields are what make a listing actually sell. */}
          <label className="block">
            <span className="block text-xs uppercase tracking-wider text-saddle mb-1.5">
              what&rsquo;s in the box — one item per line (this is what sells it)
            </span>
            <textarea
              value={form.whatsIncluded}
              maxLength={1000}
              rows={4}
              onChange={(e) => setForm((f) => ({ ...f, whatsIncluded: e.target.value }))}
              placeholder={'8 lbs ground beef\n3 lbs stew meat\n9 lbs mixed roasts (chuck, arm, rump)'}
              className="w-full p-3 border border-dust bg-bone text-[15px] leading-relaxed"
            />
            <span className="block text-[11px] text-saddle mt-1">
              buyers see this as &ldquo;what you get&rdquo; on your product page — be exact, it&rsquo;s the #1 thing they check before paying.
            </span>
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="block">
              <span className="block text-xs uppercase tracking-wider text-saddle mb-1.5">
                ships within (days) {form.shipsNationwide && <span className="text-weathered">*</span>}
              </span>
              <input
                type="number"
                min="1"
                max="60"
                step="1"
                value={form.shipsInDays}
                onChange={(e) => setForm((f) => ({ ...f, shipsInDays: e.target.value }))}
                placeholder="e.g. 3"
                className="w-full p-3 border border-dust bg-bone text-[15px]"
              />
              {form.shipsNationwide && (
                <span className="block text-[11px] text-saddle mt-1">
                  buyers see this at checkout, and it&rsquo;s what we hold the order to &mdash; a
                  number you can actually hit beats an optimistic one.
                </span>
              )}
            </label>
            <label className="block">
              <span className="block text-xs uppercase tracking-wider text-saddle mb-1.5">
                how it arrives
              </span>
              <input
                type="text"
                value={form.packaging}
                maxLength={200}
                onChange={(e) => setForm((f) => ({ ...f, packaging: e.target.value }))}
                placeholder="vacuum-sealed, shipped frozen with dry ice"
                className="w-full p-3 border border-dust bg-bone text-[15px]"
              />
            </label>
            <label className="block">
              <span className="block text-xs uppercase tracking-wider text-saddle mb-1.5">
                feeds (plain words)
              </span>
              <input
                type="text"
                value={form.feeds}
                maxLength={200}
                onChange={(e) => setForm((f) => ({ ...f, feeds: e.target.value }))}
                placeholder="~80 servings — a month of dinners"
                className="w-full p-3 border border-dust bg-bone text-[15px]"
              />
            </label>
          </div>

          <label className="block sm:max-w-[260px]">
            <span className="block text-xs uppercase tracking-wider text-saddle mb-1.5">
              orders available (blank = unlimited)
            </span>
            <input
              type="number"
              min="0"
              step="1"
              value={form.ordersLeft}
              onChange={(e) => setForm((f) => ({ ...f, ordersLeft: e.target.value }))}
              placeholder="e.g. 25"
              className="w-full p-3 border border-dust bg-bone text-[15px]"
            />
            <span className="block text-[11px] text-saddle mt-1">
              counts down as orders come in — at 0 the product auto-hides so you never oversell.
            </span>
          </label>

          {/* Transparent margin math — the same numbers the API will write.
              Shipping is a pure passthrough: never part of buyhalfcow's cut.
              Card-fee copy is TRUTHFUL per price point: absorbStripeFee floors
              BHC's fee at max($1, 2% of charge), so a thin-margin/cheap item
              gets partial or zero absorption — the shortfall comes out of the
              rancher. absorptionPreview (lib/feeMath, same math as checkout's
              computeProductCharge at qty 1) decides which sentence renders. */}
          {!preview && previewHint && (
            <p className="text-[12px] text-saddle bg-bone border-l-2 border-l-dust px-3.5 py-2">
              {previewHint}
            </p>
          )}
          {preview && (() => {
            const shipNum = Number(form.shippingCost);
            const ship = Number.isFinite(shipNum) && shipNum > 0 ? shipNum : 0;
            const shipCents = Math.round(ship * 100);
            const fees = absorptionPreview({
              displayCents: preview.displayCents,
              baseCents: preview.baseCents,
              shippingCents: shipCents,
            });
            return (
              <div className="bg-bone border-l-2 border-l-sage px-3.5 py-2.5 text-[13px]">
                buyer pays <strong>{money(preview.displayCents / 100 + ship)}</strong>
                {ship > 0 ? <> ({money(preview.displayCents / 100)} + {money(ship)} shipping)</> : null} · you net{' '}
                <strong>{money(preview.baseCents / 100 + ship)}</strong>
                {ship > 0 ? ' (shipping comes to you in full)' : ''} · buyhalfcow&rsquo;s cut{' '}
                {money(preview.marginCents / 100)} ({Math.round(preview.marginRate * 100)}%) — skimmed
                automatically at checkout, your payout needs nothing from you.{' '}
                {fees.shortfallCents === 0 ? (
                  <>card processing is on us — the net you see is the net you get.</>
                ) : (
                  <>
                    card fees: we cover {money(fees.absorbedCents / 100)} of the ~
                    {money(fees.estCents / 100)} card fee — about {money(fees.shortfallCents / 100)}{' '}
                    comes out of your payout at this price. you&rsquo;ll actually net about{' '}
                    <strong>{money((preview.baseCents + shipCents - fees.shortfallCents) / 100)}</strong>.
                  </>
                )}
              </div>
            );
          })()}

          <label className="block">
            <span className="block text-xs uppercase tracking-wider text-saddle mb-1.5">
              description
            </span>
            <textarea
              value={form.description}
              maxLength={1000}
              rows={3}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="what's in it, how it eats, why folks reorder it"
              className="w-full p-3 border border-dust bg-bone text-[15px]"
            />
          </label>

          <div className="flex flex-wrap items-center gap-4">
            <label className="block">
              <span className="block text-xs uppercase tracking-wider text-saddle mb-1.5">
                photo
              </span>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                disabled={uploading}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) uploadPhoto(f);
                }}
                className="text-sm"
              />
              {uploading && <span className="text-xs text-saddle">uploading…</span>}
            </label>
            {form.imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={form.imageUrl}
                alt="product"
                className="w-16 h-16 object-cover border border-dust bg-bone-deep"
              />
            )}
          </div>

          {/* FULFILLMENT (2026-07-07): explicit choice, zero ambiguity. Ships
              nationwide → listed on /shop + your page, buyer pays shipping if
              set. Local pickup → your ranch page ONLY, clearly labeled, no
              shipping charged, order emails say "coordinate pickup". */}
          <div className="space-y-1.5">
            <span className="block text-xs uppercase tracking-wider text-saddle">
              how does the buyer get it?
            </span>
            <div className="flex flex-wrap gap-5 text-sm">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="fulfillmentMode"
                  checked={form.shipsNationwide}
                  onChange={() => setForm((f) => ({ ...f, shipsNationwide: true }))}
                />
                ships nationwide
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="fulfillmentMode"
                  checked={!form.shipsNationwide}
                  onChange={() => setForm((f) => ({ ...f, shipsNationwide: false }))}
                />
                local pickup only
              </label>
            </div>
            {/* DISTRIBUTION PREVIEW — say exactly where the product will
                appear so the toggle's consequence is never a surprise. */}
            <span className="block text-[11px] text-saddle">
              {form.shipsNationwide
                ? 'where it sells: ✓ the nationwide shop · ✓ your ranch page. buyers anywhere order it shipped; you pack + ship it.'
                : 'where it sells: ✓ your ranch page · ✓ the shop’s local "farmers market" for buyers in your state. buyers pay online, no shipping charged — you coordinate the pickup.'}
            </span>
          </div>

          {/* BYOC (2026-07-08): rancher already sells this on their own
              store → their link wins on THEIR page (routed via /go for
              attribution). Optional; blank = BHC checkout everywhere. */}
          <div className="space-y-1">
            <label className="block text-xs uppercase tracking-wider text-saddle" htmlFor="externalCheckoutUrl">
              already sell this on your own store? (optional)
            </label>
            <input
              id="externalCheckoutUrl"
              type="url"
              value={form.externalCheckoutUrl}
              onChange={(e) => setForm((f) => ({ ...f, externalCheckoutUrl: e.target.value }))}
              placeholder="https://your-store.com/products/..."
              className="w-full border border-dust bg-bone px-3 py-2 text-sm focus:outline-none focus:border-charcoal"
            />
            <span className="block text-[11px] text-saddle">
              paste your Shopify/Square/website checkout link — on your ranch page the buy
              button sends buyers to YOUR store instead of ours. leave blank to use
              buyhalfcow checkout (deposits, zero card fees on your side).
            </span>
          </div>
          <div className="flex flex-wrap gap-5 text-sm">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.shelfStable}
                onChange={(e) => setForm((f) => ({ ...f, shelfStable: e.target.checked }))}
              />
              shelf-stable (no freezer needed)
            </label>
          </div>

          {saveErr && <p className="text-sm text-weathered">{saveErr}</p>}

          <div className="flex gap-3">
            <button
              onClick={save}
              disabled={saving || uploading}
              className="px-5 py-3 bg-charcoal text-bone text-sm font-medium uppercase tracking-wider hover:bg-saddle transition-colors disabled:opacity-50"
            >
              {saving ? 'saving…' : editingId ? 'save changes' : 'list it'}
            </button>
            <button
              onClick={() => {
                setShowForm(false);
                setEditingId(null);
                setSaveErr('');
              }}
              className="px-5 py-3 border border-dust text-sm uppercase tracking-wider hover:bg-charcoal hover:text-bone transition-colors"
            >
              cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Orders (Phase 10 — the loop that was missing: an order used to be
             one email, then gone. Now: see it, ship it, paste tracking, buyer
             gets the email automatically.) Rendered UNCONDITIONALLY — a
             Connect downgrade must never hide paid unshipped orders. ── */}
      {ordersErr && (
        <div className="border border-weathered/40 bg-bone-warm p-4 space-y-2">
          <p className="text-sm text-weathered">{ordersErr}</p>
          <button
            onClick={loadOrders}
            disabled={ordersLoading}
            className="px-4 py-2 border border-dust text-xs uppercase tracking-wider hover:bg-charcoal hover:text-bone transition-colors disabled:opacity-50"
          >
            {ordersLoading ? 'retrying…' : 'retry loading orders'}
          </button>
        </div>
      )}
      {!ordersLoading && !ordersErr && orders.length > 0 && (
        <div className="space-y-2">
          <h3 className="font-serif text-lg border-b border-dust pb-1.5">
            orders{orders.filter((o) => o.status === 'New').length > 0
              ? ` — ${orders.filter((o) => o.status === 'New').length} to handle`
              : ''}
          </h3>
          {orders.map((o) => (
            <div key={o.id} className="border border-dust bg-bone p-3 space-y-2">
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="font-serif text-[15px]">{o.productName}</span>
                {o.depositStyle && (
                  <span className="text-[10px] uppercase tracking-wider bg-rust text-bone px-1.5 py-0.5">
                    deposit — confirm size + balance first
                  </span>
                )}
                {o.pickup && (
                  <span className="text-[10px] uppercase tracking-wider bg-saddle text-bone px-1.5 py-0.5">
                    pickup
                  </span>
                )}
                <span
                  className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 ${
                    o.status === 'Shipped'
                      ? 'bg-sage text-bone'
                      : o.status === 'Refunded' || o.status === 'Cancelled'
                        ? 'border border-dust text-saddle'
                        : 'bg-charcoal text-bone'
                  }`}
                >
                  {/* A pickup order never "ships" — the Airtable status enum
                      stays 'Shipped', but the badge tells the truth. */}
                  {o.pickup && o.status === 'Shipped' ? 'picked up' : o.status}
                </span>
                <span className="text-xs text-saddle ml-auto">
                  {o.orderedAt ? new Date(o.orderedAt).toLocaleDateString() : ''}
                </span>
              </div>
              <div className="text-xs text-saddle">
                {o.buyerName || o.buyerEmail} · paid {money(o.buyerPaid)} · you net {money(o.payout)}
              </div>
              {o.shipTo && (
                <div className="text-xs text-charcoal/80 whitespace-pre-line bg-bone-warm border border-dust p-2">
                  {o.shipTo}
                </div>
              )}
              {o.status === 'New' && (
                <div className="space-y-2">
                  <div className="flex gap-2 flex-wrap items-center">
                    {/* Pickup orders: no tracking input — nothing ships. The
                        settle email promised a "mark complete" affordance;
                        this is it. */}
                    {!o.pickup && (
                      <>
                        <input
                          type="text"
                          placeholder="carrier (UPS, FedEx, USPS…)"
                          value={carrierDraft[o.id] || ''}
                          onChange={(e) => setCarrierDraft((d) => ({ ...d, [o.id]: e.target.value }))}
                          maxLength={60}
                          className="w-[170px] p-2.5 border border-dust bg-bone-warm text-sm"
                        />
                        <input
                          type="text"
                          placeholder="tracking number"
                          value={trackingDraft[o.id] || ''}
                          onChange={(e) => setTrackingDraft((d) => ({ ...d, [o.id]: e.target.value }))}
                          className="flex-1 min-w-[160px] p-2.5 border border-dust bg-bone-warm text-sm"
                        />
                      </>
                    )}
                    <button
                      onClick={() => markShipped(o)}
                      disabled={shippingId === o.id}
                      className="px-4 py-2.5 bg-charcoal text-bone text-xs uppercase tracking-wider hover:bg-saddle transition-colors disabled:opacity-50"
                    >
                      {shippingId === o.id ? 'saving…' : o.pickup ? 'mark picked up →' : 'mark shipped →'}
                    </button>
                  </div>
                  {!o.pickup && (
                    <p className="text-[11px] text-saddle">
                      add the carrier and the buyer gets a tracking link they can actually click.
                    </p>
                  )}
                  {/* CANCEL + REFUND — two-step, never a single click. */}
                  {confirmCancelId === o.id ? (
                    <div className="flex gap-2 flex-wrap items-center border border-weathered/40 bg-bone-warm p-2.5">
                      <span className="text-xs text-charcoal flex-1 min-w-[200px]">
                        refund {money(o.buyerPaid)} to {o.buyerName || 'the buyer'} and cancel this
                        order? this can&rsquo;t be undone.
                      </span>
                      <button
                        onClick={() => cancelOrder(o)}
                        disabled={cancellingId === o.id}
                        className="px-4 py-2 bg-weathered text-bone text-xs uppercase tracking-wider hover:bg-charcoal transition-colors disabled:opacity-50"
                      >
                        {cancellingId === o.id ? 'refunding…' : 'yes, refund + cancel'}
                      </button>
                      <button
                        onClick={() => setConfirmCancelId(null)}
                        disabled={cancellingId === o.id}
                        className="px-3 py-2 border border-dust text-xs uppercase tracking-wider hover:bg-charcoal hover:text-bone transition-colors disabled:opacity-50"
                      >
                        keep it
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmCancelId(o.id)}
                      className="text-[11px] text-saddle underline hover:text-charcoal transition-colors"
                    >
                      can&rsquo;t fill this one? cancel &amp; refund the buyer
                    </button>
                  )}
                </div>
              )}
              {o.status === 'Shipped' && o.trackingNumber && (
                <div className="text-xs text-sage">
                  tracking:{' '}
                  {carrierTrackingUrl(o.carrier || '', o.trackingNumber) ? (
                    <a
                      href={carrierTrackingUrl(o.carrier || '', o.trackingNumber) as string}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline break-all"
                    >
                      {o.carrier ? `${o.carrier} · ` : ''}
                      {o.trackingNumber}
                    </a>
                  ) : (
                    <span className="break-all">
                      {o.carrier ? `${o.carrier} · ` : ''}
                      {o.trackingNumber}
                    </span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── Product management — Connect-gated (a form they can't submit is
             worse than a clear next step). ──
          Wave 2 rancher-UX: 'restricted' is NOT "you never finished setup" —
          it's a rancher who DID finish and whose account later got flagged
          (routine re-KYC, bank removed). They get honest no-blame copy and
          the same resolve flow the dashboard's red banner runs (live status
          read → fresh onboarding link when resumable, billing portal
          otherwise) instead of a generic billing link. */}
      {!connectActive && connectStatus === 'restricted' && (
        <div className="border border-dust bg-bone-warm p-6 max-w-xl">
          <p className="text-sm leading-relaxed mb-4">
            your product listings are paused — <strong>not because of anything you did</strong>. Stripe
            has re-flagged your account and needs a few things confirmed (usually bank details or
            re-accepting their terms) before payouts can flow again.
          </p>
          {restrictedErr && <p className="text-sm text-weathered mb-3">{restrictedErr}</p>}
          <button
            type="button"
            onClick={resolveRestrictedFromProducts}
            disabled={restrictedBusy}
            className="inline-block px-5 py-3 min-h-[44px] bg-charcoal text-bone text-sm font-medium uppercase tracking-wider hover:bg-saddle transition-colors disabled:opacity-60"
          >
            {restrictedBusy ? 'checking…' : 'sort it out with Stripe →'}
          </button>
        </div>
      )}
      {!connectActive && connectStatus !== 'restricted' && (
        <div className="border border-dust bg-bone-warm p-6 max-w-xl">
          <p className="text-sm leading-relaxed mb-4">
            list jerky, boxes and bundles on the buyhalfcow marketplace — buyers pay online, you
            ship, the payout lands in your Stripe account automatically.
          </p>
          <p className="text-sm text-saddle mb-4">
            finish your Stripe setup first so there&rsquo;s an account to pay you on — takes a few
            minutes.
          </p>
          <Link
            href="/rancher/billing"
            className="inline-block px-5 py-3 bg-charcoal text-bone text-sm font-medium uppercase tracking-wider hover:bg-saddle transition-colors"
          >
            finish stripe setup &rarr;
          </Link>
        </div>
      )}

      <ShopifyConnectCard payoutsReady={connectActive} />

      {/* ── My products ── */}
      {connectActive && loading && <p className="text-saddle text-sm">loading your products…</p>}
      {connectActive && loadErr && <p className="text-weathered text-sm">{loadErr}</p>}
      {connectActive && !loading && !loadErr && products.length === 0 && !showForm && (
        <p className="text-sm text-saddle">
          no products yet — jerky and snack sticks are the easiest first listing (shelf-stable, ships
          anywhere).
        </p>
      )}

      {connectActive && products.length > 0 && (
        <div className="space-y-2">
          {products.map((p) => {
            // Sync-managed (Shopify) rows: the 6h catalog cron owns their
            // Active/name/price/stock and re-derives listing from BHC's
            // 'Marketplace Approved' gate — so the tab fences mutations and
            // shows a distinct "pending review" state instead of a fake hidden.
            const sync = decideSyncManagedRow({
              syncManaged: p.syncManaged,
              marketplaceApproved: p.marketplaceApproved,
            });
            return (
            <div
              key={p.id}
              className="border border-dust bg-bone p-3 flex items-center gap-3 flex-wrap"
            >
              <div className="w-12 h-12 shrink-0 overflow-hidden bg-bone-deep border border-dust">
                {p.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.image} alt={p.name} className="w-full h-full object-cover" />
                ) : null}
              </div>
              <div className="flex-1 min-w-[180px]">
                <div className="font-serif text-[15px] leading-tight">{p.name}</div>
                <div className="text-xs text-saddle mt-0.5">
                  {p.depositStyle
                    ? <>from {p.priceRange || money(p.price)} · {money(p.price)} deposit · buyer confirms size + balance with you</>
                    : <>{money(p.price)} · you net {money(p.base)}</>}
                  {p.category ? ` · ${p.category}` : ''}
                  {p.ordersLeft != null && (
                    <> · {p.ordersLeft > 0 ? `${p.ordersLeft} left` : 'SOLD OUT'}</>
                  )}
                </div>
              </div>
              {sync.badge === 'pending-review' ? (
                // Synced-but-unapproved: NOT a rancher-hidden row — it's waiting
                // on BHC's curation gate. Distinct wheat-gold badge, never the
                // generic 'hidden'/'show' pair (a 'show' here can't publish it).
                <span
                  className="text-[11px] uppercase tracking-wider px-2 py-1 bg-tallow text-charcoal"
                  title="synced from your Shopify — buyhalfcow reviews it before it lists on the marketplace"
                >
                  pending buyhalfcow review
                </span>
              ) : (
                <span
                  className={`text-[11px] uppercase tracking-wider px-2 py-1 ${
                    p.live
                      ? 'bg-sage text-bone'
                      : 'border border-dust text-saddle'
                  }`}
                >
                  {p.live
                    ? p.localOnly
                      ? 'live — local pickup, your page only'
                      : 'live on the marketplace'
                    : p.active
                      ? 'not listed'
                      : 'hidden'}
                </span>
              )}
              <div className="flex gap-2 items-center flex-wrap">
                {p.live && (
                  <a
                    href={`/shop/${p.id}`}
                    target="_blank"
                    className="text-xs underline text-saddle hover:text-charcoal px-1 py-2"
                  >
                    view
                  </a>
                )}
                {sync.managed ? (
                  // Shopify-synced row: the 6h catalog cron owns every field,
                  // so edit/duplicate/delete/hide-show would be silently
                  // reverted (and a fake 'show' would flash an unapproved row
                  // onto /shop). Replace them all with an honest "manage it in
                  // Shopify" note — mirrors the deposit-style ops fence.
                  // canShow / canEdit / canDelete are all false here (see
                  // decideSyncManagedRow); the server 409s these too.
                  <span
                    className="text-[11px] text-saddle italic px-1 py-2 max-w-[240px] leading-snug"
                    title="this product syncs from your Shopify store — edit its price, stock, photos or availability there and the change flows to buyhalfcow automatically"
                  >
                    managed from your Shopify — edit it there, changes sync automatically
                  </span>
                ) : (
                  <>
                {/* Stock quick-set on EVERY row (audit fix) — inventory is the
                    highest-frequency edit; it was buried in the full edit form
                    for regular products (only deposit-style had the box). */}
                <span className="flex items-center gap-1">
                  <input
                    type="number"
                    min="0"
                    step="1"
                    placeholder={p.ordersLeft == null ? 'stock' : String(p.ordersLeft)}
                    value={stockDraft[p.id] ?? ''}
                    onChange={(e) => setStockDraft((d) => ({ ...d, [p.id]: e.target.value }))}
                    className="w-[70px] p-2 border border-dust bg-bone-warm text-xs"
                  />
                  <button
                    onClick={() => saveStock(p)}
                    disabled={stockSavingId === p.id || (stockDraft[p.id] ?? '') === ''}
                    className="text-xs uppercase tracking-wider border border-dust px-2 py-2 hover:bg-charcoal hover:text-bone transition-colors disabled:opacity-40"
                  >
                    {stockSavingId === p.id ? '…' : 'set'}
                  </button>
                </span>
                <button
                  onClick={() => startEdit(p)}
                  disabled={p.depositStyle}
                  title={p.depositStyle ? 'deposit-style product — text ben to change details or pricing; update stock with the box to the left' : ''}
                  className="text-xs uppercase tracking-wider border border-dust px-3 py-2 hover:bg-charcoal hover:text-bone transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  edit
                </button>
                {p.depositStyle && (
                  // Visible on touch too — the title-only tooltip was the sole
                  // explanation for the disabled button (listing audit 2026-07-28).
                  <span className="text-[11px] text-saddle self-center">
                    deposit-style — text Ben for detail/price changes; stock updates in the box to the left
                  </span>
                )}
                {!p.depositStyle && (
                  <button
                    onClick={() => startDuplicate(p)}
                    title="start a new product prefilled from this one (photo carries over)"
                    className="text-xs uppercase tracking-wider border border-dust px-3 py-2 hover:bg-charcoal hover:text-bone transition-colors"
                  >
                    duplicate
                  </button>
                )}
                <button
                  onClick={() => toggleActive(p)}
                  disabled={togglingId === p.id}
                  title={p.active ? 'hide from the marketplace and your ranch page (buyers can\'t see or buy it)' : ''}
                  className="text-xs uppercase tracking-wider border border-dust px-3 py-2 hover:bg-charcoal hover:text-bone transition-colors disabled:opacity-50"
                >
                  {togglingId === p.id ? '…' : p.active ? 'hide' : 'show'}
                </button>
                {!p.depositStyle && (
                  <button
                    onClick={() => deleteProduct(p)}
                    disabled={togglingId === p.id}
                    title="delete for good (a hidden product keeps its info — delete can't be undone)"
                    className="text-xs uppercase tracking-wider border border-weathered/40 text-weathered px-3 py-2 hover:bg-weathered hover:text-bone transition-colors disabled:opacity-50"
                  >
                    delete
                  </button>
                )}
                  </>
                )}
              </div>
            </div>
            );
          })}
        </div>
      )}

      {/* Cross-link: shares live in My Page — one mental model, two revenue
          rails (Task 6.4). */}
      {connectActive && (
        <p className="text-sm text-saddle border-t border-dust pt-4">
          selling a whole or half share?{' '}
          <button onClick={onGoToMyPage} className="underline hover:text-charcoal">
            set your share pricing in my page &rarr;
          </button>
        </p>
      )}
    </div>
  );
}
