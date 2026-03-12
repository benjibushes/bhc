'use client';

import { useState } from 'react';

const US_STATES = [
  'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut',
  'Delaware', 'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa',
  'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan',
  'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire',
  'New Jersey', 'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio',
  'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota',
  'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 'Washington', 'West Virginia',
  'Wisconsin', 'Wyoming',
];

const ORDER_TYPE_MAP: Record<string, string> = {
  quarter: 'Quarter Cow',
  half: 'Half Cow',
  whole: 'Whole Cow',
};

interface TierData {
  price: number;
  lbs: string;
  hasLink: boolean;
}

interface Props {
  slug: string;
  rancherName: string;
  quarter?: TierData;
  half?: TierData;
  whole?: TierData;
}

export default function RancherLeadModal({ slug, rancherName, quarter, half, whole }: Props) {
  const [selectedTier, setSelectedTier] = useState<'quarter' | 'half' | 'whole' | null>(null);
  const [form, setForm] = useState({ fullName: '', email: '', phone: '', state: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleBuyClick = (tier: 'quarter' | 'half' | 'whole', hasLink: boolean) => {
    if (!hasLink) {
      window.location.href = '/access';
      return;
    }
    setSelectedTier(tier);
    setError('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTier) return;
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/consumers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: form.fullName,
          email: form.email,
          phone: form.phone,
          state: form.state,
          segment: 'Beef Buyer',
          orderType: ORDER_TYPE_MAP[selectedTier],
          source: 'rancher-page',
          campaign: `rancher-${slug}`,
          interestBeef: true,
          intentScore: 85,
          intentClassification: 'High',
        }),
      });

      // 409 = already a member — still send them through
      if (res.ok || res.status === 409) {
        window.location.href = `/ranchers/${slug}/pay/${selectedTier}`;
        return;
      }

      const data = await res.json();
      setError(data.error || 'Something went wrong. Please try again.');
    } catch {
      setError('Something went wrong. Please try again.');
    }

    setLoading(false);
  };

  const tierLabel = selectedTier
    ? selectedTier.charAt(0).toUpperCase() + selectedTier.slice(1)
    : '';

  return (
    <>
      {/* Pricing Cards */}
      <div className="grid md:grid-cols-3 gap-4">
        {quarter && (
          <PricingCard
            label="Quarter"
            lbs={quarter.lbs}
            price={quarter.price}
            highlighted={false}
            onClick={() => handleBuyClick('quarter', quarter.hasLink)}
          />
        )}
        {half && (
          <PricingCard
            label="Half"
            lbs={half.lbs}
            price={half.price}
            highlighted
            onClick={() => handleBuyClick('half', half.hasLink)}
          />
        )}
        {whole && (
          <PricingCard
            label="Whole"
            lbs={whole.lbs}
            price={whole.price}
            highlighted={false}
            onClick={() => handleBuyClick('whole', whole.hasLink)}
          />
        )}
      </div>

      {/* Lead Capture Modal */}
      {selectedTier && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-[#F4F1EC] max-w-md w-full p-8 space-y-6">
            <div>
              <p className="text-xs uppercase tracking-widest text-[#6B4F3F] mb-2">
                {rancherName} — {tierLabel} Share
              </p>
              <h2 className="font-[family-name:var(--font-playfair)] text-2xl">
                Almost There
              </h2>
              <p className="text-sm text-[#6B4F3F] mt-1">
                Enter your details and we&apos;ll connect you with {rancherName} to complete your order.
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <input
                type="text"
                placeholder="Full Name"
                required
                value={form.fullName}
                onChange={e => setForm(f => ({ ...f, fullName: e.target.value }))}
                className="w-full px-4 py-3 border border-[#A7A29A] bg-white text-sm"
              />
              <input
                type="email"
                placeholder="Email Address"
                required
                value={form.email}
                onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                className="w-full px-4 py-3 border border-[#A7A29A] bg-white text-sm"
              />
              <input
                type="tel"
                placeholder="Phone (optional)"
                value={form.phone}
                onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                className="w-full px-4 py-3 border border-[#A7A29A] bg-white text-sm"
              />
              <select
                required
                value={form.state}
                onChange={e => setForm(f => ({ ...f, state: e.target.value }))}
                className="w-full px-4 py-3 border border-[#A7A29A] bg-white text-sm"
              >
                <option value="">Select Your State</option>
                {US_STATES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>

              {error && (
                <p className="text-sm text-[#8C2F2F]">{error}</p>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full py-4 bg-[#0E0E0E] text-[#F4F1EC] text-sm font-medium tracking-wide hover:bg-[#6B4F3F] transition-colors disabled:opacity-50"
              >
                {loading ? 'Connecting...' : 'Continue to Payment →'}
              </button>
              <button
                type="button"
                onClick={() => setSelectedTier(null)}
                className="w-full text-center text-xs text-[#A7A29A] hover:text-[#0E0E0E]"
              >
                Cancel
              </button>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

function PricingCard({
  label,
  lbs,
  price,
  highlighted,
  onClick,
}: {
  label: string;
  lbs: string;
  price: number;
  highlighted: boolean;
  onClick: () => void;
}) {
  return (
    <div
      className={`flex flex-col p-6 border ${
        highlighted
          ? 'border-[#6B4F3F] bg-[#6B4F3F] text-[#F4F1EC]'
          : 'border-[#A7A29A] bg-white text-[#0E0E0E]'
      }`}
    >
      <p className={`text-xs uppercase tracking-widest mb-3 ${highlighted ? 'text-[#F4F1EC]/70' : 'text-[#A7A29A]'}`}>
        {label}
      </p>
      <p className="font-[family-name:var(--font-playfair)] text-4xl font-bold mb-1">
        ${price.toLocaleString()}
      </p>
      {lbs && (
        <p className={`text-sm mb-6 ${highlighted ? 'text-[#F4F1EC]/80' : 'text-[#A7A29A]'}`}>
          {lbs} of beef
        </p>
      )}
      <div className="mt-auto">
        <button
          onClick={onClick}
          className={`block w-full text-center py-3 text-sm font-medium tracking-wide transition-colors ${
            highlighted
              ? 'bg-[#F4F1EC] text-[#6B4F3F] hover:bg-white'
              : 'bg-[#0E0E0E] text-[#F4F1EC] hover:bg-[#6B4F3F]'
          }`}
        >
          Buy {label} →
        </button>
      </div>
    </div>
  );
}
