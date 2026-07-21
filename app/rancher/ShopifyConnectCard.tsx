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
}

export default function ShopifyConnectCard() {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [shop, setShop] = useState('');
  const [token, setToken] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [mode, setMode] = useState<'sync' | 'manual'>('sync');
  const [submitting, setSubmitting] = useState(false);
  const [report, setReport] = useState<string[] | null>(null);
  const [error, setError] = useState('');

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
        body: JSON.stringify({ shop, mode }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.authorizeUrl) {
        window.location.href = data.authorizeUrl;
        return;
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
        body: JSON.stringify({ shop, token, apiSecret, mode }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok && !data?.report) {
        setError(String(data?.error || 'Connection failed — check the details and try again.'));
      } else if (data?.ok) {
        setReport(data.report || ['Connected.']);
        setStatus({ connected: true, shop: shop.toLowerCase().trim(), mode });
        setToken('');
        setApiSecret('');
        setOpen(false);
      } else {
        setError((data?.report || ['Connection failed.']).join(' '));
      }
    } catch {
      setError('Network error — try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (status === null) return null;

  if (status.connected) {
    return (
      <div className="border border-sage/40 bg-bone-warm px-4 py-3 text-sm">
        <span className="text-sage font-medium">🔌 Shopify connected</span>
        <span className="text-saddle"> — {status.shop} · {status.mode === 'sync' ? 'catalog sync' : 'manual SKUs'}. Paid orders land in your store automatically; ship them like any other order.</span>
        {report && (
          <ul className="mt-2 text-xs text-saddle list-disc pl-5">
            {report.map((l, i) => (<li key={i}>{l}</li>))}
          </ul>
        )}
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
          {error && <p className="text-sm text-weathered border border-weathered/40 px-3 py-2">{error}</p>}
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
          {error && <p className="text-sm text-weathered border border-weathered/40 px-3 py-2">{error}</p>}
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
