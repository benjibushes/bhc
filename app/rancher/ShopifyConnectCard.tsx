'use client';

// "Connect your Shopify store" — rancher self-serve fulfillment integration
// (PR-F). Bigger producers link their existing store in one form: BHC brings
// the buyer + takes payment, their store receives the paid order and their
// normal fulfillment stack ships it. Two modes: sync the whole catalog onto
// the marketplace (BHC approves each product before display) or manual SKUs.
//
// The token walkthrough is inline because "go make a custom app" is the only
// step a store owner can fumble — spell it out, keep them out of support.

import { useEffect, useState } from 'react';

interface ConnectionStatus {
  connected: boolean;
  publicApp?: boolean;
  shop?: string;
  mode?: 'sync' | 'manual';
  markupPercent?: number | null;
  installSource?: 'oauth' | 'token-paste' | null;
  /** Sales-channel checklist 5.7.8/5.7.15 — synced listings awaiting the
   *  BuyHalfCow approval call ('Marketplace Approved'). null = count failed. */
  pendingApproval?: number | null;
  approvedProducts?: number | null;
}

export default function ShopifyConnectCard({ payoutsReady = true }: { payoutsReady?: boolean }) {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [shop, setShop] = useState('');
  const [token, setToken] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [mode, setMode] = useState<'sync' | 'manual'>('sync');
  // Marketplace margin (2026-07-24). The API has always accepted markupPercent
  // (clamped 0–300 server-side) but the card never sent it — so every synced
  // catalog listed at the rancher's own price and BHC earned NOTHING on those
  // orders (computeDisplayPrice with a null markup falls back to base). The
  // input closes that leak at the source; lib/onboardingPaths refuses to call
  // the store path go-live-ready until this is a positive number.
  const [markup, setMarkup] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Digits + at most ONE dot — '1.2.3' / '15.' would Number()→NaN, which
  // JSON.stringify sends as null and both routes read as "no margin".
  function onMarkupChange(v: string) {
    const cleaned = v.replace(/[^0-9.]/g, '');
    const dot = cleaned.indexOf('.');
    setMarkup(dot === -1 ? cleaned : cleaned.slice(0, dot + 1) + cleaned.slice(dot + 1).replace(/\./g, ''));
  }
  // The numeric markup to send + persist, or null when blank/invalid.
  function markupValue(): number | null {
    if (markup.trim() === '') return null;
    const n = Number(markup);
    return Number.isFinite(n) ? n : null;
  }
  const [report, setReport] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [disconnecting, setDisconnecting] = useState(false);

  // Self-serve disconnect (sales-channel checklist 5.7.12) — no support
  // ticket, no texting Ben. The endpoint unhooks webhooks + channel, pulls
  // synced listings off the marketplace, and clears the connection.
  async function disconnect() {
    if (
      !window.confirm(
        'Disconnect your Shopify store? Your synced products come off the marketplace and paid orders stop flowing into your store. You can reconnect any time.',
      )
    )
      return;
    setDisconnecting(true);
    setError('');
    try {
      const res = await fetch('/api/rancher/integrations/shopify', { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.ok) {
        setReport(null);
        setStatus((s) => ({ connected: false, publicApp: s?.publicApp }));
      } else {
        setError(String(data?.error || 'Could not disconnect — try again or text Ben.'));
      }
    } catch {
      setError('Network error — try again.');
    } finally {
      setDisconnecting(false);
    }
  }

  useEffect(() => {
    fetch('/api/rancher/integrations/shopify')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setStatus(d && typeof d.connected === 'boolean' ? d : { connected: false }))
      .catch(() => setStatus({ connected: false }));
  }, []);

  // ONE-CLICK path (public app live): shop + mode only — we redirect straight
  // to Shopify's consent screen. No tokens ever touch the rancher.
  async function submitOneClick() {
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/rancher/integrations/shopify/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shop,
          mode,
          markupPercent: markupValue() ?? undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.authorizeUrl) {
        window.location.href = data.authorizeUrl;
        return;
      }
      if (res.status === 503) {
        // One-click creds were pulled after page load — swap to the token
        // layout so the rancher isn't told about a form that isn't rendered.
        setStatus((s) => (s ? { ...s, publicApp: false } : s));
      }
      setError(String(data?.error || 'Could not start the connection — try again.'));
    } catch {
      setError('Network error — try again.');
    } finally {
      setSubmitting(false);
    }
  }

  async function submit() {
    setSubmitting(true);
    setError('');
    setReport(null);
    try {
      const res = await fetch('/api/rancher/integrations/shopify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shop,
          token,
          apiSecret,
          mode,
          markupPercent: markupValue() ?? undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok && !data?.report) {
        setError(String(data?.error || 'Connection failed — check the details and try again.'));
      } else if (data?.ok) {
        setReport(data.report || ['Connected.']);
        // Carry the just-saved margin into status so the connected card
        // doesn't flash "No marketplace margin is set yet" right after a
        // rancher connected WITH one (prefer the server's echo when present).
        setStatus({
          connected: true,
          shop: shop.toLowerCase().trim(),
          mode,
          markupPercent: typeof data.markupPercent === 'number' ? data.markupPercent : markupValue(),
        });
        setToken('');
        setApiSecret('');
        setOpen(false);
      } else {
        // One line per check — joined into a paragraph this read as a wall of
        // text instead of "which field is wrong" (2026-07-28 listing audit).
        setError((data?.report || ['Connection failed.']).join('\n'));
      }
    } catch {
      setError('Network error — try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (status === null) return null;

  if (status.connected) {
    const pending = typeof status.pendingApproval === 'number' ? status.pendingApproval : 0;
    const approved = typeof status.approvedProducts === 'number' ? status.approvedProducts : 0;
    return (
      <div className="border border-sage/40 bg-bone-warm px-4 py-3 text-sm">
        {/* 5.7.13: account section always visible, labelled with the channel name */}
        <p className="text-[10px] uppercase tracking-[0.2em] text-muted mb-1">
          BuyHalfCow sales channel · account connection
        </p>
        <span className="text-sage font-medium">🔌 Shopify connected</span>
        <span className="text-saddle">
          {' '}— {status.shop} · {status.mode === 'sync' ? 'catalog sync' : 'manual SKUs'}
          {typeof status.markupPercent === 'number' && status.markupPercent > 0
            ? ` · ${status.markupPercent}% marketplace margin`
            : ''}
          . Paid orders land in your store automatically; ship them like any other order.
        </span>
        {/* 5.7.8 / 5.7.15: approval state — pending listings stay off the
            marketplace until the BuyHalfCow review approves them. */}
        {pending > 0 && (
          <p className="mt-2 text-xs text-charcoal border border-dust bg-bone px-3 py-2">
            ⏳ {pending} product{pending === 1 ? '' : 's'} pending BuyHalfCow approval — each listing
            is reviewed before it appears on the marketplace. Nothing to do; we&rsquo;ll take it from
            here.
          </p>
        )}
        {pending === 0 && approved > 0 && (
          <p className="mt-2 text-xs text-sage border border-sage/40 px-3 py-2">
            ✓ {approved} product{approved === 1 ? '' : 's'} approved and live on the marketplace.
          </p>
        )}
        {/* 5.7.6: commission, stated plainly. */}
        <p className="mt-2 text-xs text-saddle">
          <span className="text-charcoal font-medium">Our commission:</span> buyers pay our
          marketplace fee on top of your price — you keep 100% of the price you set. On product
          orders you net your base price + shipping.
        </p>
        {!(typeof status.markupPercent === 'number' && status.markupPercent > 0) && (
          <p className="mt-2 text-xs text-weathered">
            No marketplace margin is set yet — synced products list at your own price until one is.
            Text Ben the margin you agreed and he&rsquo;ll set it.
          </p>
        )}
        {report && (
          <ul className="mt-2 text-xs text-saddle list-disc pl-5">
            {report.map((l, i) => (<li key={i}>{l}</li>))}
          </ul>
        )}
        {!payoutsReady && (
          <p className="mt-2 text-xs text-weathered">
            One more thing before products can sell: finish your payout setup (Stripe) in the Money
            tab — that&rsquo;s the account your sales land in.
          </p>
        )}
        {error && (
          <p className="mt-2 text-xs text-weathered border border-weathered/40 px-3 py-2">{error}</p>
        )}
        {/* 5.7.5 marketplace link · 5.7.7 T&C in a new window · 5.7.12 self-serve disconnect */}
        <p className="mt-3 text-xs text-saddle flex flex-wrap gap-x-4 gap-y-1 items-center">
          <a
            href="/shop"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4 hover:text-charcoal transition-colors"
          >
            See your products on the marketplace
          </a>
          <a
            href="/terms"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4 hover:text-charcoal transition-colors"
          >
            Terms &amp; Conditions
          </a>
          <button
            onClick={disconnect}
            disabled={disconnecting}
            className="underline underline-offset-4 text-weathered hover:text-charcoal transition-colors disabled:opacity-40"
          >
            {disconnecting ? 'Disconnecting…' : 'Disconnect store'}
          </button>
        </p>
      </div>
    );
  }

  return (
    <div className="border border-dust bg-bone-warm px-4 py-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Already selling on Shopify?</p>
          <p className="text-xs text-saddle mt-0.5 max-w-lg">
            Connect your store — we bring the buyer and take payment, the paid order appears in
            your Shopify like any other, and you fulfill exactly how you already do.
            {!payoutsReady && (
              <span className="block mt-1 text-charcoal/60">
                (You&rsquo;ll also finish payout setup in the Money tab before sales go live.)
              </span>
            )}
          </p>
        </div>
        {!open && (
          <button
            onClick={() => setOpen(true)}
            className="px-4 py-2 border border-charcoal text-sm uppercase tracking-wider hover:bg-charcoal hover:text-bone transition-colors whitespace-nowrap"
          >
            Connect Shopify
          </button>
        )}
      </div>

      {open && status.publicApp && (
        <div className="mt-4 space-y-3 max-w-xl">
          <div>
            <span className="block text-xs uppercase tracking-wider text-saddle mb-1.5">Store address</span>
            <input
              value={shop}
              onChange={(e) => setShop(e.target.value)}
              placeholder="your-store.myshopify.com"
              className="w-full border border-dust bg-bone px-3 py-2 text-sm"
            />
          </div>
          <div className="space-y-2 text-sm pt-1">
            <label className="flex items-start gap-2 cursor-pointer">
              <input type="radio" className="mt-1" checked={mode === 'sync'} onChange={() => setMode('sync')} />
              <span>
                Sync my catalog
                <span className="block text-xs text-saddle">
                  we import your products automatically; BuyHalfCow approves each one before it displays
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 cursor-pointer">
              <input type="radio" className="mt-1" checked={mode === 'manual'} onChange={() => setMode('manual')} />
              <span>
                Manual SKUs
                <span className="block text-xs text-saddle">you list products by hand and we match them by SKU</span>
              </span>
            </label>
          </div>
          <div>
            <span className="block text-xs uppercase tracking-wider text-saddle mb-1.5">
              Marketplace margin (%)
            </span>
            <input
              value={markup}
              onChange={(e) => onMarkupChange(e.target.value)}
              inputMode="decimal"
              placeholder="15"
              className="w-32 border border-dust bg-bone px-3 py-2 text-sm"
            />
            <span className="block text-xs text-saddle mt-1">
              We list your products at your price plus this margin. The margin is our cut — your payout stays your full price.
            </span>
          </div>
          {error && <p className="text-sm text-weathered border border-weathered/40 px-3 py-2 whitespace-pre-line">{error}</p>}
          <div className="flex gap-3 items-center">
            <button
              onClick={submitOneClick}
              disabled={submitting || !shop}
              className="px-5 py-2 bg-charcoal text-bone text-sm uppercase tracking-wider hover:bg-saddle transition-colors disabled:opacity-40"
            >
              {submitting ? 'Starting…' : 'Connect store'}
            </button>
            <button onClick={() => { setOpen(false); setError(''); }} className="text-sm text-saddle underline underline-offset-4">
              cancel
            </button>
          </div>
          <p className="text-xs text-dust">
            You’ll approve the connection on Shopify’s screen — takes about 20 seconds. No passwords, no tokens.
          </p>
        </div>
      )}

      {open && !status.publicApp && (
        <div className="mt-4 space-y-3 max-w-xl">
          <ol className="text-xs text-saddle list-decimal pl-5 space-y-1">
            <li>In your Shopify admin: <strong>Settings → Apps and sales channels → Develop apps → Create an app</strong> (name it “BuyHalfCow”).</li>
            <li>Configure Admin API scopes: <code>write_orders</code>, <code>read_orders</code>, <code>read_products</code> — then <strong>Install app</strong>.</li>
            <li>Copy the <strong>Admin API access token</strong> (starts with shpat_) and the <strong>API secret key</strong> below. Takes about 5 minutes.</li>
          </ol>
          <div>
            <span className="block text-xs uppercase tracking-wider text-saddle mb-1.5">Store address</span>
            <input
              value={shop}
              onChange={(e) => setShop(e.target.value)}
              placeholder="your-store.myshopify.com"
              className="w-full border border-dust bg-bone px-3 py-2 text-sm"
            />
          </div>
          <div>
            <span className="block text-xs uppercase tracking-wider text-saddle mb-1.5">Admin API access token</span>
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="shpat_…"
              type="password"
              autoComplete="off"
              className="w-full border border-dust bg-bone px-3 py-2 text-sm"
            />
          </div>
          <div>
            <span className="block text-xs uppercase tracking-wider text-saddle mb-1.5">API secret key</span>
            <input
              value={apiSecret}
              onChange={(e) => setApiSecret(e.target.value)}
              placeholder="shpss_… or hex string"
              type="password"
              autoComplete="off"
              className="w-full border border-dust bg-bone px-3 py-2 text-sm"
            />
          </div>
          <div className="space-y-2 text-sm pt-1">
            <label className="flex items-start gap-2 cursor-pointer">
              <input type="radio" className="mt-1" checked={mode === 'sync'} onChange={() => setMode('sync')} />
              <span>
                Sync my catalog
                <span className="block text-xs text-saddle">
                  we import your products automatically; BuyHalfCow approves each one before it displays
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 cursor-pointer">
              <input type="radio" className="mt-1" checked={mode === 'manual'} onChange={() => setMode('manual')} />
              <span>
                Manual SKUs
                <span className="block text-xs text-saddle">you list products by hand and we match them by SKU</span>
              </span>
            </label>
          </div>
          <div>
            <span className="block text-xs uppercase tracking-wider text-saddle mb-1.5">
              Marketplace margin (%)
            </span>
            <input
              value={markup}
              onChange={(e) => onMarkupChange(e.target.value)}
              inputMode="decimal"
              placeholder="15"
              className="w-32 border border-dust bg-bone px-3 py-2 text-sm"
            />
            <span className="block text-xs text-saddle mt-1">
              We list your products at your price plus this margin. The margin is our cut — your payout stays your full price.
            </span>
          </div>
          {error && <p className="text-sm text-weathered border border-weathered/40 px-3 py-2 whitespace-pre-line">{error}</p>}
          <div className="flex gap-3">
            <button
              onClick={submit}
              disabled={submitting || !shop || !token || !apiSecret}
              className="px-5 py-2 bg-charcoal text-bone text-sm uppercase tracking-wider hover:bg-saddle transition-colors disabled:opacity-40"
            >
              {submitting ? 'Connecting…' : 'Connect store'}
            </button>
            <button onClick={() => { setOpen(false); setError(''); }} className="text-sm text-saddle underline underline-offset-4">
              cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
