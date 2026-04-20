'use client';

import { useEffect, useState, useMemo } from 'react';
import Container from '../components/Container';
import Divider from '../components/Divider';
import Link from 'next/link';

interface LandDeal {
  id: string;
  sellerName: string;
  propertyType: string;
  acreage: number;
  state: string;
  county?: string;
  propertyLocation: string;
  askingPrice: string;
  description: string;
  zoning?: string;
  utilities?: string;
}

export default function LandDealsPage() {
  const [deals, setDeals] = useState<LandDeal[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterState, setFilterState] = useState('');
  const [inquireFor, setInquireFor] = useState<LandDeal | null>(null);

  useEffect(() => {
    fetch('/api/public/land')
      .then((r) => r.json())
      .then((d) => setDeals(d.deals || []))
      .catch(() => setDeals([]))
      .finally(() => setLoading(false));
  }, []);

  const states = useMemo(() => {
    const set = new Set<string>();
    deals.forEach((d) => d.state && set.add(d.state.toUpperCase()));
    return Array.from(set).sort();
  }, [deals]);

  const filtered = useMemo(() => {
    if (!filterState) return deals;
    return deals.filter((d) => (d.state || '').toUpperCase() === filterState);
  }, [deals, filterState]);

  return (
    <main className="min-h-screen py-12 bg-bone text-charcoal">
      <Container>
        <div className="space-y-8">
          {/* Header */}
          <div className="text-center max-w-2xl mx-auto space-y-4">
            <h1 className="font-serif text-4xl md:text-5xl">Land Deals</h1>
            <p className="text-saddle">
              Off-market ranch property, hunting land, and acreage from BHC partners. Privately listed — no Zillow, no agents, no public spam.
            </p>
            <Divider />
          </div>

          {/* Filter bar */}
          {deals.length > 0 && (
            <div className="flex flex-col sm:flex-row gap-3 sm:items-center justify-between">
              <p className="text-sm text-dust">
                {filtered.length} listing{filtered.length === 1 ? '' : 's'}
                {filterState ? ` in ${filterState}` : ' available'}
              </p>
              <div className="flex gap-2 flex-wrap">
                <button
                  onClick={() => setFilterState('')}
                  className={`px-3 py-1 text-xs uppercase tracking-wider transition-colors ${
                    !filterState ? 'bg-charcoal text-bone' : 'border border-dust hover:border-charcoal'
                  }`}
                >
                  All states
                </button>
                {states.map((s) => (
                  <button
                    key={s}
                    onClick={() => setFilterState(s)}
                    className={`px-3 py-1 text-xs font-mono uppercase tracking-wider transition-colors ${
                      filterState === s ? 'bg-charcoal text-bone' : 'border border-dust hover:border-charcoal'
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Listings */}
          {loading ? (
            <div className="text-center py-16">
              <div className="inline-block w-8 h-8 border-4 border-charcoal border-t-transparent rounded-full animate-spin" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-8 border border-dust text-center bg-white space-y-4">
              <p className="text-saddle">
                {deals.length === 0
                  ? "No active land listings right now. New deals come through the network regularly — check back or join to get notified."
                  : `No active listings in ${filterState} right now.`}
              </p>
              <Link
                href="/access"
                className="inline-block px-6 py-3 bg-charcoal text-bone hover:bg-saddle transition-colors uppercase tracking-wider text-sm font-medium"
              >
                Join to Get Notified
              </Link>
            </div>
          ) : (
            <div className="grid gap-6 md:grid-cols-2">
              {filtered.map((deal) => (
                <article key={deal.id} className="p-6 border border-dust bg-white space-y-4">
                  <div>
                    <p className="text-xs uppercase tracking-wider text-saddle">{deal.propertyType}</p>
                    <h2 className="font-serif text-2xl mt-1">
                      {deal.acreage.toLocaleString()} Acres — {deal.propertyLocation || deal.state}
                    </h2>
                    <p className="font-serif text-xl mt-1 text-charcoal">{deal.askingPrice || 'Inquire for price'}</p>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div><span className="text-saddle">State:</span> <span className="font-mono">{deal.state}</span></div>
                    {deal.county && <div><span className="text-saddle">County:</span> {deal.county}</div>}
                    {deal.zoning && <div className="col-span-2"><span className="text-saddle">Zoning:</span> {deal.zoning}</div>}
                    {deal.utilities && <div className="col-span-2"><span className="text-saddle">Utilities:</span> {deal.utilities}</div>}
                  </div>

                  {deal.description && (
                    <p className="text-sm leading-relaxed text-charcoal">{deal.description}</p>
                  )}

                  <button
                    onClick={() => setInquireFor(deal)}
                    className="w-full px-4 py-3 bg-charcoal text-bone hover:bg-saddle transition-colors font-medium uppercase tracking-wider text-sm"
                  >
                    Inquire About This Property
                  </button>
                </article>
              ))}
            </div>
          )}

          {/* Sell-your-own CTA */}
          <Divider />
          <div className="text-center max-w-xl mx-auto space-y-4">
            <h2 className="font-serif text-2xl">Selling Land?</h2>
            <p className="text-saddle text-sm">
              List off-market with us. Verified buyers only. No agents, no commissions to BHC unless we close the sale (1% on close).
            </p>
            <Link
              href="/partner"
              className="inline-block px-6 py-3 border border-charcoal hover:bg-charcoal hover:text-bone transition-colors uppercase tracking-wider text-sm font-medium"
            >
              List Your Land →
            </Link>
          </div>

          <div className="text-center pt-4">
            <Link href="/" className="text-sm text-saddle hover:text-charcoal transition-colors">
              ← Back to home
            </Link>
          </div>
        </div>
      </Container>

      {/* Inquiry Modal */}
      {inquireFor && (
        <InquiryModal deal={inquireFor} onClose={() => setInquireFor(null)} />
      )}
    </main>
  );
}

function InquiryModal({ deal, onClose }: { deal: LandDeal; onClose: () => void }) {
  const [form, setForm] = useState({ name: '', email: '', phone: '', message: '' });
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setState('sending');
    setErrorMsg('');
    try {
      const res = await fetch(`/api/land/${deal.id}/inquire`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setState('sent');
      } else {
        setErrorMsg(data.error || 'Something went wrong');
        setState('error');
      }
    } catch {
      setErrorMsg('Network error');
      setState('error');
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-bone p-8 max-w-lg w-full max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-start mb-4">
          <h2 className="font-serif text-2xl">
            Inquire — {deal.acreage.toLocaleString()} Acres
          </h2>
          <button onClick={onClose} className="text-2xl leading-none hover:text-saddle">×</button>
        </div>

        {state === 'sent' ? (
          <div className="space-y-4 text-center">
            <p className="font-serif text-xl text-green-800">Inquiry sent.</p>
            <p className="text-sm text-saddle">
              We forwarded your message to {deal.sellerName}. They typically respond within 1-3 business days. Check your inbox for a confirmation.
            </p>
            <button
              onClick={onClose}
              className="px-6 py-3 bg-charcoal text-bone hover:bg-saddle transition-colors uppercase tracking-wider text-sm font-medium"
            >
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <p className="text-sm text-saddle">
              {deal.propertyLocation || deal.state} · {deal.askingPrice || 'Inquire for price'}
            </p>

            <div>
              <label className="block text-sm font-medium mb-1">Your Name *</label>
              <input
                type="text"
                required
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                className="w-full px-3 py-2 border border-dust bg-white focus:outline-none focus:border-charcoal"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Email *</label>
              <input
                type="email"
                required
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                className="w-full px-3 py-2 border border-dust bg-white focus:outline-none focus:border-charcoal"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Phone</label>
              <input
                type="tel"
                value={form.phone}
                onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                className="w-full px-3 py-2 border border-dust bg-white focus:outline-none focus:border-charcoal"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Message *</label>
              <textarea
                required
                rows={5}
                value={form.message}
                onChange={(e) => setForm((f) => ({ ...f, message: e.target.value }))}
                placeholder="Tell the seller what you'd like to know — pricing flexibility, mineral rights, water access, intended use..."
                className="w-full px-3 py-2 border border-dust bg-white focus:outline-none focus:border-charcoal"
              />
            </div>

            {state === 'error' && errorMsg && (
              <div className="p-3 border border-[#8C2F2F] text-[#8C2F2F] text-sm">{errorMsg}</div>
            )}

            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                disabled={state === 'sending'}
                className="flex-1 px-4 py-3 border border-charcoal hover:bg-charcoal hover:text-bone transition-colors uppercase tracking-wider text-sm font-medium disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={state === 'sending'}
                className="flex-1 px-4 py-3 bg-charcoal text-bone hover:bg-saddle transition-colors uppercase tracking-wider text-sm font-medium disabled:opacity-50"
              >
                {state === 'sending' ? 'Sending...' : 'Send Inquiry'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
