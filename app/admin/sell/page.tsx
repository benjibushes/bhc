'use client';

// /admin/sell — the OPERATOR SELL CONSOLE (Phase 9).
//
// Ben is on the phone with a buyer. One screen, one flow:
//   1. punch in the buyer's state + email (name optional)
//   2. LEFT column  — SHARES: deposit-capable ranchers serving that state
//      (in-state first, then nationwide shippers). tap a tier → mints the
//      1-tap deposit link (/r/d/<token>, the campaign-reserve rail).
//      Underneath, a SEPARATE, differently-labeled group: REPRESENTED ranches
//      (the broker rail) → mints /r/b/<token>. See the money note below.
//   3. RIGHT column — SMALLER TICKET: every sellable marketplace product
//      (all ship nationwide). tap → mints a Stripe checkout link via the
//      existing admin rail (POST /api/checkout/product).
//   4. result bar: the link + copy + a prefilled text in Ben's voice.
//
// THREE MONEY MODELS, NEVER BLURRED (docs/BUSINESS-MODEL.md)
// ----------------------------------------------------------
// The two share groups are rendered apart, labeled apart, and post DIFFERENT
// parameters, because they pay out differently:
//   • CONNECT ("shares")     — posts `rancherSlug`. The buyer pays the deposit
//     plus BHC's fee ON TOP; the rancher keeps 100% of the price.
//   • BROKER ("represented") — posts `rancherId` (a represented ranch has no
//     slug by design). The buyer's deposit goes 100% to BHC and IS the whole
//     commission; the ranch collects price − deposit direct.
// The mint endpoint refuses both parameters at once rather than guessing, so
// the operator's rail choice here must always be an explicit tap, never
// inferred. The per-cut "you keep / ranch collects" lines come straight from
// the rail's own quote (lib/brokerRail via /api/admin/sell-options) — nothing
// on this page re-derives money.
//
// Everything money-side is reused rails: campaign/broker reserve tokens
// (referral-scoped grant, never a member session) and the operator product
// checkout. This page is just the phone-call cockpit gluing them together.

import { useEffect, useState } from 'react';
import { US_STATES } from '@/lib/states';

interface Tier { cut: string; label: string; price: number; deposit: number }
interface SellRancher { slug: string; name: string; state: string; inState: boolean; nationwide: boolean; tiers: Tier[] }
interface SellProduct { id: string; name: string; rancher: string; price: number; depositStyle: boolean; priceRange: string; shelfStable: boolean }

// BROKER rail. `sellable:false` cuts are rendered DISABLED with `reason` —
// never a button that 400s. The deposit is never derived on this rail, so a
// cut missing a price OR a deposit simply is not sellable yet.
interface BrokerCut {
  cut: string;
  label: string;
  sellable: boolean;
  price: number;
  deposit: number;
  bhcKeeps: number;
  ranchCollects: number;
  reason: string;
}
interface BrokerRancher { id: string; name: string; state: string; inState: boolean; cuts: BrokerCut[] }

interface SellResult {
  kind: 'deposit' | 'broker' | 'product';
  url: string;
  headline: string; // "half share — Foodstead · $600 deposit"
  sms: string;
}

// Phase 10 — buyer omniscience: the whole relationship across all three
// systems (demand / rancher deals / marketplace) the moment Ben types an email.
interface BuyerContext {
  found: boolean;
  consumer: { name: string; state: string; stage: string; smsOptIn: boolean } | null;
  referrals: { status: string; rancher: string; depositPaidAt: string }[];
  orders: { product: string; paid: number; status: string; deposit: boolean }[];
}

const money = (n: number) => `$${n.toFixed(n % 1 === 0 ? 0 : 2)}`;

export default function AdminSellPage() {
  const [buyerState, setBuyerState] = useState('');
  const [buyerEmail, setBuyerEmail] = useState('');
  const [buyerName, setBuyerName] = useState('');

  const [ranchers, setRanchers] = useState<SellRancher[]>([]);
  const [brokerRanchers, setBrokerRanchers] = useState<BrokerRancher[]>([]);
  const [products, setProducts] = useState<SellProduct[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState('');

  const [minting, setMinting] = useState(''); // key of the button in flight
  const [result, setResult] = useState<SellResult | null>(null);
  const [genErr, setGenErr] = useState('');
  const [copied, setCopied] = useState(false);
  const [ctx, setCtx] = useState<BuyerContext | null>(null);

  const ready = buyerEmail.includes('@');
  const first = buyerName.trim().split(' ')[0] || '';

  // Buyer context on email entry (debounced) — who am I talking to?
  useEffect(() => {
    setCtx(null);
    if (!buyerEmail.includes('@')) return;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/admin/buyer-context?email=${encodeURIComponent(buyerEmail.trim())}`);
        const data = await res.json().catch(() => null);
        if (res.ok && data) {
          setCtx(data);
          // Auto-fill what we know — fewer keystrokes on a live call.
          if (data.consumer?.name && !buyerName.trim()) setBuyerName(data.consumer.name);
          if (data.consumer?.state && !buyerState) setBuyerState(data.consumer.state);
        }
      } catch {
        /* lookup is a bonus, never a blocker */
      }
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buyerEmail]);

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
        setBrokerRanchers(data.brokerRanchers || []);
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

  // BROKER rail mint. Posts `rancherId` and NEVER `rancherSlug` — a represented
  // ranch has no slug, and the two parameters select different money models
  // (the endpoint refuses both at once rather than guessing).
  async function sendBrokerDeposit(r: BrokerRancher, c: BrokerCut) {
    if (!ready) { setGenErr('enter the buyer email first.'); return; }
    const key = `broker-${r.id}-${c.cut}`;
    setMinting(key);
    setGenErr('');
    setCopied(false);
    try {
      const res = await fetch('/api/admin/sell-links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rancherId: r.id,
          cut: c.cut,
          buyerEmail: buyerEmail.trim(),
          buyerName: buyerName.trim(),
          buyerState,
        }),
      });
      const data = await res.json().catch(() => ({}));
      // Surface the API's refusal VERBATIM — it names the ranch and the exact
      // missing number, which is what the operator needs to go fix.
      if (!res.ok) throw new Error(data?.error || `failed (${res.status})`);
      setResult({
        kind: 'broker',
        url: data.url,
        // Operator money truth, straight off the response — the deposit IS the
        // commission on this rail, so `bhcTake` and `rancherNets` are stated
        // rather than re-derived here.
        headline: `${data.cutLabel} — ${data.rancher} (represented) · ${money(data.deposit)} deposit · you keep ${money(data.bhcTake ?? data.deposit)} · ranch collects ${money(data.rancherNets ?? data.tierPrice - data.deposit)}`,
        // Buyer-facing copy: the deposit is theirs toward the share and the
        // balance is settled with the ranch. Their TOTAL is the same either
        // way, so how BHC and the ranch split it is not stated to them.
        sms: `Hey${first ? ' ' + first : ''} — Ben from BuyHalfCow. Here's your link for the ${data.cutLabel} from ${data.rancher}: ${data.url} — ${money(data.deposit)} today holds your share (${money(data.tierPrice)} total), and you settle the ${money(data.tierPrice - data.deposit)} balance directly with the ranch.`,
      });
    } catch (e: any) {
      setGenErr(e?.message || 'could not mint the represented-ranch link');
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

  // ── Demand heatmap (the rancher-recruiting weapon, backlog #114) ──
  const [heat, setHeat] = useState<{ state: string; waitingBuyers: number; activeRanchers: number; pitch: string }[] | null>(null);
  const [heatBusy, setHeatBusy] = useState(false);
  const [pitchCopied, setPitchCopied] = useState('');

  async function loadHeatmap() {
    setHeatBusy(true);
    try {
      const res = await fetch('/api/admin/demand-heatmap');
      const data = await res.json().catch(() => ({}));
      if (res.ok) setHeat(data.rows || []);
    } finally {
      setHeatBusy(false);
    }
  }

  function copyPitch(state: string, pitch: string) {
    navigator.clipboard?.writeText(pitch).then(
      () => setPitchCopied(state),
      () => setPitchCopied(''),
    );
  }

  // ── Shop-drop campaign (the waitlist monetizer) ──
  const [dropBusy, setDropBusy] = useState(false);
  const [dropStatus, setDropStatus] = useState('');

  async function fireDrop(mode: 'dry-run' | 'live') {
    if (mode === 'live' && !window.confirm('send the shop announcement to the next 100 waitlist buyers?')) return;
    setDropBusy(true);
    setDropStatus('');
    try {
      const res = await fetch('/api/admin/campaigns/shop-drop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `failed (${res.status})`);
      setDropStatus(
        mode === 'dry-run'
          ? `pool: ${data.pool} waitlist buyers never told about the shop · next batch would send ${data.wouldSend} · featuring: ${(data.picks || []).join(' · ')}`
          : `sent ${data.sent} (${data.suppressed} skipped by frequency cap) · ${data.remaining} remaining — fire again to continue`,
      );
    } catch (e: any) {
      setDropStatus(e?.message || 'failed');
    } finally {
      setDropBusy(false);
    }
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

      {/* ── Buyer context strip — who you're talking to, across all 3 systems ── */}
      {ctx && ctx.found && (
        <div className="border border-dust bg-bone px-4 py-3 mb-6 text-[13px] flex flex-wrap gap-x-4 gap-y-1 items-baseline">
          <span className="font-serif text-[15px]">
            {ctx.consumer?.name || buyerEmail}
          </span>
          {ctx.consumer?.state && <span className="text-saddle">{ctx.consumer.state}</span>}
          {ctx.consumer?.stage && (
            <span className="text-[10px] uppercase tracking-wider border border-dust px-1.5 py-0.5 text-saddle">
              {ctx.consumer.stage}
            </span>
          )}
          {ctx.consumer?.smsOptIn && <span className="text-[11px] text-sage">sms ok</span>}
          {ctx.referrals.map((r, i) => (
            <span key={`r${i}`} className="text-saddle">
              share: {r.rancher || 'unassigned'} · {r.status}
              {r.depositPaidAt ? ' · deposit paid ✓' : ''}
            </span>
          ))}
          {ctx.orders.map((o, i) => (
            <span key={`o${i}`} className="text-saddle">
              bought: {o.product} ${o.paid.toFixed(0)}{o.deposit ? ' (deposit)' : ''} · {o.status}
            </span>
          ))}
          {ctx.referrals.length === 0 && ctx.orders.length === 0 && (
            <span className="text-saddle">in the system — no purchases yet</span>
          )}
        </div>
      )}
      {ctx && !ctx.found && ready && (
        <p className="text-xs text-saddle mb-6">new lead — first touch. the link you send creates their record.</p>
      )}

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

            {/* ── REPRESENTED RANCHES (broker rail) ──────────────────────────
                A DIFFERENT money model, so a visually separate group with its
                own heading, its own badge and its own money lines. These
                ranches are not on Connect, have no public page and no slug —
                they are deliberately invisible to the marketplace, the map and
                routing, which is why they cannot appear in the list above. The
                operator sells them by phone; this is the only place to do it. */}
            {brokerRanchers.length > 0 && (
              <div className="mt-8 border-l-4 border-tallow pl-4">
                <h3 className="font-serif text-lg mb-1">represented ranches — broker links</h3>
                <p className="text-[12px] text-saddle mb-3 max-w-md">
                  different rail: the deposit is <strong>yours in full</strong> (it is the whole
                  commission), and the ranch collects the rest directly from the buyer. the
                  buyer&rsquo;s total is the same either way. deposits are never derived here — a
                  cut with no price or no deposit set is not sellable yet.
                </p>
                <div className="space-y-2">
                  {brokerRanchers.map((r) => (
                    <div key={r.id} className="border border-tallow bg-bone p-3">
                      <div className="flex items-baseline gap-2 mb-2 flex-wrap">
                        <span className="font-serif text-[15px]">{r.name}</span>
                        {r.state && <span className="text-xs text-saddle">{r.state}</span>}
                        <span className="text-[10px] uppercase tracking-wider border border-tallow text-saddle px-1.5 py-0.5">
                          represented ranch
                        </span>
                        {r.inState && <span className="text-[10px] uppercase tracking-wider text-sage">in their state</span>}
                      </div>
                      <div className="space-y-1.5">
                        {r.cuts.map((c) =>
                          c.sellable ? (
                            <div key={c.cut} className="flex items-center gap-3 flex-wrap border-t border-dust pt-1.5">
                              <div className="flex-1 min-w-[170px]">
                                <div className="text-[13px]">
                                  {c.label} · {money(c.price)} · <strong>{money(c.deposit)} deposit</strong>
                                </div>
                                <div className="text-[11.5px] text-saddle tabular-nums">
                                  you keep {money(c.bhcKeeps)} · ranch collects {money(c.ranchCollects)}
                                </div>
                              </div>
                              <button
                                onClick={() => sendBrokerDeposit(r, c)}
                                disabled={!ready || minting === `broker-${r.id}-${c.cut}`}
                                title={ready ? '' : 'enter buyer email first'}
                                className="px-3 py-2 border border-charcoal text-xs cursor-pointer transition-base hover:bg-charcoal hover:text-bone disabled:opacity-40 disabled:cursor-not-allowed"
                              >
                                {minting === `broker-${r.id}-${c.cut}` ? 'minting…' : 'broker link →'}
                              </button>
                            </div>
                          ) : (
                            <div key={c.cut} className="flex items-center gap-3 flex-wrap border-t border-dust pt-1.5 opacity-70">
                              <div className="flex-1 min-w-[170px]">
                                <div className="text-[13px] text-saddle">{c.label}</div>
                                <div className="text-[11.5px] text-weathered">{c.reason}</div>
                              </div>
                              <button
                                disabled
                                className="px-3 py-2 border border-dust text-xs text-saddle cursor-not-allowed"
                              >
                                not sellable
                              </button>
                            </div>
                          ),
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
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

      {/* ── Demand heatmap — the rancher-recruiting weapon. Supply is the
             platform's one real constraint; this is the pitch that fills it:
             per-state waiting-buyer counts vs covering ranchers, gap-sorted,
             with the recruiting line ready to paste into any DM. ── */}
      <section className="mt-12 border-t border-dust pt-6">
        <h2 className="font-serif text-xl mb-1">supply gaps — where to recruit ranchers</h2>
        <p className="text-saddle text-[13px] mb-3 max-w-2xl">
          qualified WAITING buyers per state vs. deposit-capable ranchers covering it. the copy
          button gives you the exact recruiting line: <em>&ldquo;N buyers are waiting in your
          radius — you fill them, we already found them.&rdquo;</em>
        </p>
        {!heat ? (
          <button
            onClick={loadHeatmap}
            disabled={heatBusy}
            className="px-4 py-2.5 border border-charcoal text-[13px] cursor-pointer transition-base hover:bg-charcoal hover:text-bone disabled:opacity-50"
          >
            {heatBusy ? 'crunching…' : 'load the board'}
          </button>
        ) : heat.length === 0 ? (
          <p className="text-sm text-saddle">no state-tagged waiting demand found.</p>
        ) : (
          <div className="space-y-1.5 max-w-2xl">
            {heat.slice(0, 15).map((r) => (
              <div key={r.state} className="flex items-center gap-3 border border-dust bg-bone px-3 py-2">
                <span className="font-serif text-lg w-10">{r.state}</span>
                <span className="text-[13px] text-charcoal tabular-nums">
                  <strong>{r.waitingBuyers}</strong> waiting
                </span>
                <span className={`text-[13px] tabular-nums ${r.activeRanchers === 0 ? 'text-weathered font-semibold' : 'text-sage'}`}>
                  {r.activeRanchers} rancher{r.activeRanchers === 1 ? '' : 's'} covering
                </span>
                <button
                  onClick={() => copyPitch(r.state, r.pitch)}
                  className="ml-auto px-3 py-1.5 border border-dust text-[11.5px] uppercase tracking-wider cursor-pointer transition-base hover:bg-charcoal hover:text-bone"
                >
                  {pitchCopied === r.state ? 'copied ✓' : 'copy pitch'}
                </button>
              </div>
            ))}
            {heat.length > 15 && (
              <p className="text-xs text-saddle">+ {heat.length - 15} more states with demand</p>
            )}
          </div>
        )}
      </section>

      {/* ── Campaigns — the waitlist shop drop (money-map lever #1). One-time
             "the shop is open" announcement to WAITING buyers, batched, once
             ever per buyer, frequency-capped. Dry run first, always. ── */}
      <section className="mt-12 border-t border-dust pt-6">
        <h2 className="font-serif text-xl mb-1">campaigns</h2>
        <p className="text-saddle text-[13px] mb-3 max-w-2xl">
          <strong>shop drop</strong> — tell the waitlist the shop exists. WAITING buyers are
          share-intent demand you couldn&rsquo;t serve locally; the marketplace ships to all of
          them. once ever per buyer, 100 per batch, frequency-capped. dry run shows the pool.
        </p>
        <div className="flex gap-2 flex-wrap items-center">
          <button
            onClick={() => fireDrop('dry-run')}
            disabled={dropBusy}
            className="px-4 py-2.5 border border-charcoal text-[13px] cursor-pointer transition-base hover:bg-charcoal hover:text-bone disabled:opacity-50"
          >
            {dropBusy ? 'working…' : 'dry run (counts only)'}
          </button>
          <button
            onClick={() => fireDrop('live')}
            disabled={dropBusy}
            className="px-4 py-2.5 bg-charcoal text-bone text-[13px] cursor-pointer transition-base hover:bg-saddle disabled:opacity-50"
          >
            send next batch of 100 →
          </button>
        </div>
        {dropStatus && <p className="text-[13px] text-charcoal/85 mt-3 max-w-2xl">{dropStatus}</p>}
      </section>
    </div>
  );
}
