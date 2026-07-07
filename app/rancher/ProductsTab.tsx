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
import {
  PRODUCT_CATEGORIES,
  deriveProductPricing,
  MIN_PRODUCT_PRICE_CENTS,
} from '@/lib/rancherProductInput';

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
  shelfStable: boolean;
  active: boolean;
  live: boolean;
  // Deposit-style (price-range) rows are ops-managed: the price shown is the
  // DEPOSIT, Base is hand-set, and content edits go through Ben (the API
  // fences them). Hide/show still works.
  depositStyle?: boolean;
  priceRange?: string;
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
  shelfStable: false,
};

export default function ProductsTab({
  connectActive,
  onGoToMyPage,
}: {
  connectActive: boolean;
  onGoToMyPage: () => void;
}) {
  const [products, setProducts] = useState<RancherProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');

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
  }, []);

  // Live net preview from the SAME pure math the API applies — no drift.
  const priceNum = Number(form.displayPrice);
  const priceCents = Number.isFinite(priceNum) ? Math.round(priceNum * 100) : 0;
  const preview =
    priceCents >= MIN_PRODUCT_PRICE_CENTS && form.category
      ? deriveProductPricing({ displayCents: priceCents, category: form.category })
      : null;

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
      shelfStable: p.shelfStable,
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
        shelfStable: form.shelfStable,
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
        setProducts((list) => [data.product, ...list]);
        setSavedNote(
          data.pendingApproval
            ? 'saved — held for a quick review before it lists.'
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

  async function toggleActive(p: RancherProduct) {
    setTogglingId(p.id);
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
    } catch {
      /* leave list as-is; next load reconciles */
    } finally {
      setTogglingId(null);
    }
  }

  // ── Connect gate — a form they can't submit is worse than a clear next step.
  if (!connectActive) {
    return (
      <div className="space-y-4">
        <h2 className="font-serif text-2xl">Products</h2>
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
      </div>
    );
  }

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
        {!showForm && (
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

      {/* ── Add / edit form ── */}
      {showForm && (
        <div className="border border-dust bg-bone-warm p-5 space-y-4 max-w-2xl">
          <div className="font-serif text-lg">{editingId ? 'edit product' : 'add a product'}</div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="block">
              <span className="block text-xs uppercase tracking-wider text-saddle mb-1.5">
                product name
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
                category
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

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="block">
              <span className="block text-xs uppercase tracking-wider text-saddle mb-1.5">
                retail price (what the buyer pays, shipping included)
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

          {/* Transparent margin math — the same numbers the API will write. */}
          {preview && (
            <div className="bg-bone border-l-2 border-l-sage px-3.5 py-2.5 text-[13px]">
              buyer pays <strong>{money(preview.displayCents / 100)}</strong> · you net{' '}
              <strong>{money(preview.baseCents / 100)}</strong> · buyhalfcow&rsquo;s cut{' '}
              {money(preview.marginCents / 100)} ({Math.round(preview.marginRate * 100)}%) — skimmed
              automatically at checkout, your payout needs nothing from you.
            </div>
          )}

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

          <div className="flex flex-wrap gap-5 text-sm">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.shipsNationwide}
                onChange={(e) => setForm((f) => ({ ...f, shipsNationwide: e.target.checked }))}
              />
              ships nationwide
            </label>
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

      {/* ── My products ── */}
      {loading && <p className="text-saddle text-sm">loading your products…</p>}
      {loadErr && <p className="text-weathered text-sm">{loadErr}</p>}
      {!loading && !loadErr && products.length === 0 && !showForm && (
        <p className="text-sm text-saddle">
          no products yet — jerky and snack sticks are the easiest first listing (shelf-stable, ships
          anywhere).
        </p>
      )}

      {products.length > 0 && (
        <div className="space-y-2">
          {products.map((p) => (
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
                </div>
              </div>
              <span
                className={`text-[11px] uppercase tracking-wider px-2 py-1 ${
                  p.live
                    ? 'bg-sage text-bone'
                    : 'border border-dust text-saddle'
                }`}
              >
                {p.live ? 'live on the marketplace' : p.active ? 'not listed' : 'hidden'}
              </span>
              <div className="flex gap-2">
                {p.live && (
                  <a
                    href={`/shop/${p.id}`}
                    target="_blank"
                    className="text-xs underline text-saddle hover:text-charcoal px-1 py-2"
                  >
                    view
                  </a>
                )}
                <button
                  onClick={() => startEdit(p)}
                  disabled={p.depositStyle}
                  title={p.depositStyle ? 'deposit-style product — text ben to change details or pricing' : ''}
                  className="text-xs uppercase tracking-wider border border-dust px-3 py-2 hover:bg-charcoal hover:text-bone transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  edit
                </button>
                <button
                  onClick={() => toggleActive(p)}
                  disabled={togglingId === p.id}
                  className="text-xs uppercase tracking-wider border border-dust px-3 py-2 hover:bg-charcoal hover:text-bone transition-colors disabled:opacity-50"
                >
                  {togglingId === p.id ? '…' : p.active ? 'hide' : 'show'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Cross-link: shares live in My Page — one mental model, two revenue
          rails (Task 6.4). */}
      <p className="text-sm text-saddle border-t border-dust pt-4">
        selling a whole or half share?{' '}
        <button onClick={onGoToMyPage} className="underline hover:text-charcoal">
          set your share pricing in my page &rarr;
        </button>
      </p>
    </div>
  );
}
