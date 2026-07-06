'use client';

// /admin/products — the operator link tool. Pick a low-ticket product + a
// buyer, get a Stripe checkout link to text a share-balker. The fastest-money
// surface: turns the 826 Closed Lost + cold leads into a nationwide push
// channel. Money flows through the verified /api/checkout/product rail.

import { useState, useEffect } from 'react';

interface Product {
  id: string;
  name: string;
  rancher: string;
  category: string;
  tier: string;
  displayPrice: number;
  rancherBase: number;
  margin: number;
  shelfStable: boolean;
}

const money = (n: number) => `$${n.toFixed(2)}`;

export default function AdminProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');

  const [productId, setProductId] = useState('');
  const [buyerEmail, setBuyerEmail] = useState('');
  const [buyerName, setBuyerName] = useState('');

  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<{ url: string; product: string; buyerPays: number; yourMargin: number } | null>(null);
  const [genErr, setGenErr] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/admin/products');
        if (!res.ok) throw new Error(`load failed (${res.status})`);
        const data = await res.json();
        setProducts(data.products || []);
      } catch (e: any) {
        setLoadErr(e?.message || 'could not load products');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const selected = products.find((p) => p.id === productId) || null;

  async function generate() {
    setGenErr('');
    setResult(null);
    setCopied(false);
    if (!productId || !buyerEmail.includes('@')) {
      setGenErr('Pick a product and enter a valid buyer email.');
      return;
    }
    setGenerating(true);
    try {
      const res = await fetch('/api/checkout/product', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId, buyerEmail: buyerEmail.trim(), buyerName: buyerName.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `failed (${res.status})`);
      setResult(data);
    } catch (e: any) {
      setGenErr(e?.message || 'could not generate link');
    } finally {
      setGenerating(false);
    }
  }

  function copyLink() {
    if (!result?.url) return;
    navigator.clipboard?.writeText(result.url).then(() => setCopied(true), () => setCopied(false));
  }

  const smsText = result && selected
    ? `Hey${buyerName ? ' ' + buyerName.split(' ')[0] : ''} — it's Ben from BuyHalfCow. Not ready for a whole share yet? Try ${selected.rancher}'s beef first — here's your link: ${result.url}`
    : '';

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '32px 20px', fontFamily: '-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif', color: '#17130E' }}>
      <h1 style={{ fontFamily: 'Georgia,serif', fontSize: 30, margin: '0 0 4px' }}>Product Links</h1>
      <p style={{ color: '#6B4F3F', margin: '0 0 24px', fontSize: 14 }}>
        Generate a checkout link for a low-ticket product and text it to a share-balker. Buyer pays the all-in price; your margin is skimmed automatically; the rancher ships.
      </p>

      {loading && <p style={{ color: '#6B4F3F' }}>loading products…</p>}
      {loadErr && <p style={{ color: '#8C3A2B' }}>{loadErr}</p>}

      {!loading && !loadErr && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <label style={{ display: 'block' }}>
            <span style={{ display: 'block', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, color: '#6B4F3F', marginBottom: 6 }}>Product</span>
            <select
              value={productId}
              onChange={(e) => { setProductId(e.target.value); setResult(null); }}
              style={{ width: '100%', padding: '12px', border: '1px solid #B7AE9F', background: '#F4F1EC', fontSize: 15 }}
            >
              <option value="">— pick a product —</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {money(p.displayPrice)} · {p.name} — {p.rancher} {p.shelfStable ? '(ships anywhere)' : ''}
                </option>
              ))}
            </select>
          </label>

          {selected && (
            <div style={{ background: '#E6E9DC', borderLeft: '3px solid #55603F', padding: '10px 14px', fontSize: 13, color: '#3D362D' }}>
              buyer pays <strong>{money(selected.displayPrice)}</strong> · rancher nets {money(selected.rancherBase)} · <strong>you keep {money(selected.margin)}</strong>
            </div>
          )}

          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <label style={{ flex: 1, minWidth: 220 }}>
              <span style={{ display: 'block', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, color: '#6B4F3F', marginBottom: 6 }}>Buyer email</span>
              <input type="email" value={buyerEmail} onChange={(e) => setBuyerEmail(e.target.value)} placeholder="buyer@email.com"
                style={{ width: '100%', padding: '12px', border: '1px solid #B7AE9F', background: '#F4F1EC', fontSize: 15 }} />
            </label>
            <label style={{ flex: 1, minWidth: 180 }}>
              <span style={{ display: 'block', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, color: '#6B4F3F', marginBottom: 6 }}>Buyer name (optional)</span>
              <input type="text" value={buyerName} onChange={(e) => setBuyerName(e.target.value)} placeholder="First Last"
                style={{ width: '100%', padding: '12px', border: '1px solid #B7AE9F', background: '#F4F1EC', fontSize: 15 }} />
            </label>
          </div>

          <button onClick={generate} disabled={generating}
            style={{ padding: '14px', background: '#17130E', color: '#F4F1EC', border: 'none', fontSize: 15, fontWeight: 600, cursor: generating ? 'default' : 'pointer', opacity: generating ? 0.6 : 1 }}>
            {generating ? 'generating…' : 'Generate checkout link'}
          </button>

          {genErr && <p style={{ color: '#8C3A2B', margin: 0 }}>{genErr}</p>}

          {result && (
            <div style={{ border: '1.5px solid #55603F', background: '#fbf9f5', padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ fontSize: 13, color: '#3D362D' }}>
                <strong>{result.product}</strong> — buyer pays {money(result.buyerPays)}, you keep {money(result.yourMargin)}.
              </div>
              <div style={{ wordBreak: 'break-all', fontSize: 12, fontFamily: 'ui-monospace,Menlo,monospace', background: '#fff', border: '1px solid #D8D0C2', padding: 10 }}>
                {result.url}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button onClick={copyLink} style={{ padding: '10px 16px', border: '1px solid #17130E', background: 'transparent', fontSize: 13, cursor: 'pointer' }}>
                  {copied ? 'copied ✓' : 'copy link'}
                </button>
                <a href={`sms:?&body=${encodeURIComponent(smsText)}`} style={{ padding: '10px 16px', background: '#55603F', color: '#F4F1EC', textDecoration: 'none', fontSize: 13 }}>
                  text it
                </a>
              </div>
              <p style={{ fontSize: 12, color: '#6B4F3F', margin: 0 }}>
                Buyer completes checkout on Stripe → you get a “SOLD” alert, the order lands in the rancher's queue, the buyer gets a receipt.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
