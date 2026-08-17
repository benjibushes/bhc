'use client';

// /admin/products — the operator link tool. Pick a low-ticket product + a
// buyer, get a Stripe checkout link to text a share-balker. The fastest-money
// surface: turns the 826 Closed Lost + cold leads into a nationwide push
// channel. Money flows through the verified /api/checkout/product rail.
//
// SEND, NOT JUST MINT (2026-08-17): the same server-side delivery the sell
// console got. TWO LINKS, deliberately different:
//   • the Stripe checkout URL below — for Ben to read out or paste on a live
//     call. Fastest path to paid, and it expires in about a day.
//   • /shop/<id>, the durable product page — what the PLATFORM emails. Repo
//     hard rule: never email a raw Stripe checkout URL, because a buyer who
//     opens the mail tomorrow hits Stripe's expired-session page.
// The send endpoint enforces that itself (lib/operatorSend.resolveSendTarget
// refuses a Stripe host outright), so this is belt and suspenders, not trust.

import { useState, useEffect } from 'react';
import SendItButton from '../components/SendItButton';

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
  depositStyle?: boolean;
  priceRange?: string;
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
    ? selected.depositStyle
      ? `Hey${buyerName ? ' ' + buyerName.split(' ')[0] : ''} — it's Ben from BuyHalfCow. Here's the ${selected.name} from ${selected.rancher}: ${result.url} — ${money(selected.displayPrice)} reserves it, they confirm your size + the balance before it ships.`
      : `Hey${buyerName ? ' ' + buyerName.split(' ')[0] : ''} — it's Ben from BuyHalfCow. Not ready for a whole share yet? Try ${selected.rancher}'s beef first — here's your link: ${result.url}`
    : '';

  return (
    <div className="max-w-[720px] mx-auto px-5 py-8 text-charcoal">
      <h1 className="font-serif text-3xl mb-1">Product Links</h1>
      <p className="text-saddle text-sm mb-6">
        Generate a checkout link for a low-ticket product and text it to a share-balker. Buyer pays the all-in price; your margin is skimmed automatically; the rancher ships.
      </p>

      {loading && <p className="text-saddle">loading products…</p>}
      {loadErr && <p className="text-weathered">{loadErr}</p>}

      {!loading && !loadErr && (
        <div className="flex flex-col gap-4">
          <label className="block">
            <span className="block text-xs uppercase tracking-wider text-saddle mb-1.5">Product</span>
            <select
              value={productId}
              onChange={(e) => { setProductId(e.target.value); setResult(null); }}
              className="w-full p-3 border border-dust bg-bone text-[15px]"
            >
              <option value="">— pick a product —</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.depositStyle
                    ? `${money(p.displayPrice)} DEPOSIT (${p.priceRange || 'range'})`
                    : money(p.displayPrice)}{' '}
                  · {p.name} — {p.rancher} {p.shelfStable ? '(ships anywhere)' : ''}
                </option>
              ))}
            </select>
          </label>

          {selected && (
            <div className="bg-bone-warm border-l-2 border-l-sage px-3.5 py-2.5 text-[13px] text-charcoal/85">
              {selected.depositStyle ? (
                <>
                  <strong>deposit-style:</strong> buyer pays a <strong>{money(selected.displayPrice)} deposit</strong> toward a {selected.priceRange || 'range'} total — the rancher confirms size + balance before shipping. you keep {money(selected.margin)} of the deposit · rancher nets {money(selected.rancherBase)}
                </>
              ) : (
                <>
                  buyer pays <strong>{money(selected.displayPrice)}</strong> · rancher nets {money(selected.rancherBase)} · <strong>you keep {money(selected.margin)}</strong>
                </>
              )}
            </div>
          )}

          <div className="flex gap-3 flex-wrap">
            <label className="flex-1 min-w-[220px]">
              <span className="block text-xs uppercase tracking-wider text-saddle mb-1.5">Buyer email</span>
              <input type="email" value={buyerEmail} onChange={(e) => setBuyerEmail(e.target.value)} placeholder="buyer@email.com"
                className="w-full p-3 border border-dust bg-bone text-[15px]" />
            </label>
            <label className="flex-1 min-w-[180px]">
              <span className="block text-xs uppercase tracking-wider text-saddle mb-1.5">Buyer name (optional)</span>
              <input type="text" value={buyerName} onChange={(e) => setBuyerName(e.target.value)} placeholder="First Last"
                className="w-full p-3 border border-dust bg-bone text-[15px]" />
            </label>
          </div>

          <button onClick={generate} disabled={generating}
            className={`p-3.5 bg-charcoal text-bone border-0 text-[15px] font-semibold transition-base ${generating ? 'opacity-60 cursor-default' : 'cursor-pointer hover:bg-divider'}`}>
            {generating ? 'generating…' : 'Generate checkout link'}
          </button>

          {genErr && <p className="text-weathered m-0">{genErr}</p>}

          {result && (
            <div className="border-2 border-sage bg-bone-warm p-4 flex flex-col gap-3">
              <div className="text-[13px] text-charcoal/85">
                <strong>{result.product}</strong> — buyer pays {money(result.buyerPays)}, you keep {money(result.yourMargin)}.
              </div>
              <div className="break-all text-xs font-mono bg-bone border border-dust p-2.5">
                {result.url}
              </div>

              {/* Server-side delivery. Sends the DURABLE product page, never
                  the expiring Stripe session shown above. The copy / text-it
                  fallbacks below stay exactly where they were. */}
              {selected && (
                <SendItButton
                  sendUrl={`${window.location.origin}/shop/${selected.id}`}
                  buyerEmail={buyerEmail}
                  buyerName={buyerName}
                  itemLabel={selected.name}
                  sellerName={selected.rancher}
                  amount={selected.displayPrice}
                  resetKey={result.url}
                />
              )}

              <div className="flex gap-2 flex-wrap">
                <button onClick={copyLink} className="px-4 py-2.5 border border-charcoal bg-transparent text-[13px] cursor-pointer transition-base hover:bg-charcoal hover:text-bone">
                  {copied ? 'copied ✓' : 'copy link'}
                </button>
                <a href={`sms:?&body=${encodeURIComponent(smsText)}`} className="px-4 py-2.5 bg-sage text-bone no-underline text-[13px]">
                  text it
                </a>
              </div>
              <p className="text-xs text-saddle m-0">
                Buyer completes checkout on Stripe → you get a “SOLD” alert, the order lands in the rancher's queue, the buyer gets a receipt.
              </p>
              <p className="text-xs text-saddle m-0">
                The link above is a Stripe checkout and expires in about a day, so it is for this
                call. <strong>send it</strong> mails the durable product page instead.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
