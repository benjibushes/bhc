'use client';

// Storefront Buy button. One tap → POST the public buy endpoint → redirect to
// Stripe Checkout (which collects email + address + card). Disables itself on
// click so a double-tap can't fire two sessions.

import { useState } from 'react';

export default function BuyButton({ productId, price }: { productId: string; price: number }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function buy() {
    setErr('');
    setBusy(true);
    try {
      const res = await fetch('/api/checkout/product/buy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId }),
      });
      const data = await res.json();
      if (!res.ok || !data?.url) throw new Error(data?.error || 'could not start checkout');
      window.location.href = data.url;
    } catch (e: any) {
      setErr(e?.message || 'something went wrong');
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        onClick={buy}
        disabled={busy}
        style={{
          width: '100%', padding: '12px', background: '#17130E', color: '#F4F1EC',
          border: 'none', fontSize: 15, fontWeight: 600, cursor: busy ? 'default' : 'pointer',
          opacity: busy ? 0.6 : 1,
        }}
      >
        {busy ? 'taking you to checkout…' : `buy — $${price.toFixed(0)}`}
      </button>
      {err && <p style={{ color: '#8C3A2B', fontSize: 12, margin: '6px 0 0' }}>{err}</p>}
    </div>
  );
}
