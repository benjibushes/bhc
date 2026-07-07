'use client';

// /admin/sell — the OPERATOR SELL CONSOLE (Phase 9).
//
// Ben is on the phone with a buyer. One screen, one flow:
//   1. punch in the buyer's state + email (name optional)
//   2. LEFT column  — SHARES: deposit-capable ranchers serving that state
//      (in-state first, then nationwide shippers). tap a tier → mints the
//      1-tap deposit link (/r/d/<token>, the campaign-reserve rail).
//   3. RIGHT column — SMALLER TICKET: every sellable marketplace product
//      (all ship nationwide). tap → mints a Stripe checkout link via the
//      existing admin rail (POST /api/checkout/product).
//   4. result bar: the link + copy + a prefilled text in Ben's voice.
//
// Everything money-side is reused rails: campaign-reserve tokens (referral-
// scoped grant, never a member session) and the operator product checkout.
// This page is just the phone-call cockpit gluing them together.

import { useEffect, useState } from 'react';
import { US_STATES } from '@/lib/states';

interface Tier { cut: string; label: string; price: number; deposit: number }
interface SellRancher { slug: string; name: string; state: string; inState: boolean; nationwide: boolean; tiers: Tier[] }
interface SellProduct { id: string; name: string; rancher: string; price: number; depositStyle: boolean; priceRange: string; shelfStable: boolean }

interface SellResult {
  kind: 'deposit' | 'product';
  url: string;
  headline: string; // "half share — Foodstead · $600 deposit"
  sms: string;
}

const money = (n: number) => `$${n.toFixed(n % 1 === 0 ? 0 : 2)}`;

export default function AdminSellPage() {
  const [buyerState, setBuyerState] = useState('');
  const [buyerEmail, setBuyerEmail] = useState('');
  const [buyerName, setBuyerName] = useState('');

  const [ranchers, setRanchers] = useState<SellRancher[]>([]);
  const [products, setProducts] = useState<SellProduct[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState('');

  const [minting, setMinting] = useState(''); // key of the button in flight
  const [result, setResult] = useState<SellResult | null>(null);
  const [genErr, setGenErr] = useState('');
  const [copied, setCopied] = useState(false);

  const ready = buyerEmail.includes('@');
  const first = buyerName.trim().split(' ')[0] || '';

  // Load the menu whenever the state changes (also loads with no state —
  // products are always sellable; ranchers just lose the in-state sort).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadErr('');
      try {
        const res = await fetch(`/api/admin/sell-options?state=${encodeURIComponent(buyerState)}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || `load failed (${res.status})`);
        if (cancelled) return;
        setRanchers(data.ranchers || []);
        setProducts(data.products || []);
      } catch (e: any) {
        if (!cancelled) setLoadErr(e?.message || 'could not load options');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [buyerState]);

  async function sendDeposit(r: SellRancher, t: Tier) {
    if (!ready) { setGenErr('enter the buyer email first.'); return; }
    const key = `${r.slug}-${t.cut}`;
    setMinting(key);
    setGenErr('');
    setCopied(false);
    try {
      const res = await fetch('/api/admin/sell-links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rancherSlug: r.slug,
          cut: t.cut,
          buyerEmail: buyerEmail.trim(),
          buyerName: buyerName.trim(),
          buyerState,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `failed (${res.status})`);
      setResult({
        kind: 'deposit',
        url: data.url,
        headline: `${data.cutLabel} — ${data.rancher} · ${money(data.deposit)} deposit holds it`,
        sms: `Hey${first ? ' ' + first : ''} — Ben from BuyHalfCow. Here's your link to lock in the ${data.cutLabel} from ${data.rancher}: ${data.url} — the ${money(data.deposit)} deposit holds your spot, fully refundable until they accept.`,
      });
    } catch (e: any) {
      setGenErr(e?.message || 'could not mint the deposit link');
    } finally {
      setMinting('');
    }
  }

  async function sendProduct(p: SellProduct) {
    if (!ready) { setGenErr('enter the buyer email first.'); return; }
    setMinting(p.id);
    setGenErr('');
    setCopied(false);
    try {
      const res = await fetch('/api/checkout/product', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: p.id, buyerEmail: buyerEmail.trim(), buyerName: buyerName.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `failed (${res.status})`);
      setResult({
        kind: 'product',
        url: data.url,
        headline: p.depositStyle
          ? `${p.name} — ${p.priceRange || money(p.price)} · ${money(p.price)} deposit`
          : `${p.name} — ${money(p.price)}, shipping included`,
        sms: p.depositStyle
          ? `Hey${first ? ' ' + first : ''} — Ben from BuyHalfCow. Here's the ${p.name} from ${p.rancher}: ${data.url} — ${money(p.price)} reserves it, they confirm your size + the balance before it ships.`
          : `Hey${first ? ' ' + first : ''} — Ben from BuyHalfCow. Not ready for a whole share yet? Try ${p.rancher}'s beef first — ${money(p.price)}, shipping included: ${data.url}`,
      });
    } catch (e: any) {
      setGenErr(e?.message || 'could not generate the checkout link');
    } finally {
      setMinting('');
    }
  }

  function copyLink() {
    if (!result?.url) return;
    navigator.clipboard?.writeText(result.url).then(() => setCopied(true), () => setCopied(false));
  }

  const inState = ranchers.filter((r) => r.inState);
  const shipsAnyway = ranchers.filter((r) => !r.inState && r.nationwide);
  const rest = ranchers.filter((r) => !r.inState && !r.nationwide);

  return (
    <div className="max-w-[1100px] mx-auto px-5 py-8 text-charcoal">
      <h1 className="font-serif text-3xl mb-1">Sell Console</h1>
      <p className="text-saddle text-sm mb-6 max-w-2xl">
        On the phone? Enter their state + email, tap what they want, text them the link. Deposit
        links go straight to the share checkout; product links go straight to Stripe. Everything is
        fulfillable — in-state ranchers first, nationwide shippers labeled.
      </p>

      {/* ── Buyer bar ── */}
      <div className="flex gap-3 flex-wrap items-end border border-dust bg-bone-warm p-4 mb-6">
        <label className="min-w-[140px]">
          <span className="block text-xs uppercase tracking-wider text-saddle mb-1.5">Their state</span>
          <select
            value={buyerState}
            onChange={(e) => setBuyerState(e.target.value)}
            className="w-full p-3 border border-dust bg-bone text-[15px]"
          >
            <option value="">— state —</option>
            {US_STATES.map((s) => (
              <option key={s.code} value={s.code}>{s.code} — {s.name}</option>
            ))}
          </select>
        </label>
        <label className="flex-1 min-w-[220px]">
          <span className="block text-xs uppercase tracking-wider text-saddle mb-1.5">Buyer email (required)</span>
          <input type="email" value={buyerEmail} onChange={(e) => setBuyerEmail(e.target.value)} placeholder="buyer@email.com"
            className="w-full p-3 border border-dust bg-bone text-[15px]" />
        </label>
        <label className="flex-1 min-w-[160px]">
          <span className="block text-xs uppercase tracking-wider text-saddle mb-1.5">Name (optional)</span>
          <input type="text" value={buyerName} onChange={(e) => setBuyerName(e.target.value)} placeholder="First Last"
            className="w-full p-3 border border-dust bg-bone text-[15px]" />
        </label>
      </div>

      {/* ── Result bar — pinned above the columns so it's always visible ── */}
      {genErr && <p className="text-weathered text-sm mb-4">{genErr}</p>}
      {result && (
        <div className="border-2 border-sage bg-bone-warm p-4 mb-6 flex flex-col gap-3">
          <div className="text-sm"><strong>{result.headline}</strong></div>
          <div className="break-all text-xs font-mono bg-bone border border-dust p-2.5">{result.url}</div>
          <div className="flex gap-2 flex-wrap">
            <button onClick={copyLink} className="px-4 py-2.5 border border-charcoal bg-transparent text-[13px] cursor-pointer transition-base hover:bg-charcoal hover:text-bone">
              {copied ? 'copied ✓' : 'copy link'}
            </button>
            <a href={`sms:?&body=${encodeURIComponent(result.sms)}`} className="px-4 py-2.5 bg-sage text-bone no-underline text-[13px]">
              text it
            </a>
          </div>
          <p className="text-xs text-saddle m-0">{result.sms}</p>
        </div>
      )}

      {loading && <p className="text-saddle text-sm">loading options…</p>}
      {loadErr && <p className="text-weathered text-sm">{loadErr}</p>}

      {!loading && !loadErr && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* ── SHARES ── */}
          <section>
            <h2 className="font-serif text-xl border-b border-dust pb-2 mb-3">
              shares — deposit links{buyerState ? ` · ${buyerState}` : ''}
            </h2>
            {[
              { label: buyerState ? `serving ${buyerState}` : 'all deposit-capable', list: inState.length ? inState : [] },
              { label: 'ships nationwide anyway', list: shipsAnyway },
              { label: 'other deposit-capable', list: rest },
            ].map(({ label, list }) =>
              list.length === 0 ? null : (
                <div key={label} className="mb-4">
                  <p className="text-[11px] uppercase tracking-widest text-saddle mb-2">{label}</p>
                  <div className="space-y-2">
                    {list.map((r) => (
                      <div key={r.slug} className="border border-dust bg-bone p-3">
                        <div className="flex items-baseline gap-2 mb-2">
                          <span className="font-serif text-[15px]">{r.name}</span>
                          <span className="text-xs text-saddle">{r.state}</span>
                          {r.nationwide && <span className="text-[10px] uppercase tracking-wider text-sage">ships nationwide</span>}
                        </div>
                        <div className="flex gap-2 flex-wrap">
                          {r.tiers.map((t) => (
                            <button
                              key={t.cut}
                              onClick={() => sendDeposit(r, t)}
                              disabled={!ready || minting === `${r.slug}-${t.cut}`}
                              title={ready ? '' : 'enter buyer email first'}
                              className="px-3 py-2 border border-charcoal text-xs cursor-pointer transition-base hover:bg-charcoal hover:text-bone disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              {minting === `${r.slug}-${t.cut}` ? 'minting…' : (
                                <>{t.label} · {money(t.price)} → <strong>{money(t.deposit)} dep</strong></>
                              )}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ),
            )}
            {ranchers.length === 0 && <p className="text-sm text-saddle">no deposit-capable ranchers found.</p>}
          </section>

          {/* ── SMALLER TICKET ── */}
          <section>
            <h2 className="font-serif text-xl border-b border-dust pb-2 mb-3">
              smaller ticket — ships anywhere
            </h2>
            <div className="space-y-2">
              {products.map((p) => (
                <div key={p.id} className="border border-dust bg-bone p-3 flex items-center gap-3 flex-wrap">
                  <div className="flex-1 min-w-[180px]">
                    <div className="font-serif text-[15px] leading-tight">{p.name}</div>
                    <div className="text-xs text-saddle">
                      {p.rancher} ·{' '}
                      {p.depositStyle
                        ? <>from {p.priceRange || money(p.price)} · {money(p.price)} deposit</>
                        : <>{money(p.price)}{p.shelfStable ? ' · shelf-stable' : ' · ships frozen'}</>}
                    </div>
                  </div>
                  <button
                    onClick={() => sendProduct(p)}
                    disabled={!ready || minting === p.id}
                    title={ready ? '' : 'enter buyer email first'}
                    className="px-3.5 py-2 bg-charcoal text-bone text-xs uppercase tracking-wider cursor-pointer transition-base hover:bg-saddle disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {minting === p.id ? 'minting…' : p.depositStyle ? 'reserve link →' : 'checkout link →'}
                  </button>
                </div>
              ))}
              {products.length === 0 && <p className="text-sm text-saddle">no sellable products found.</p>}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
