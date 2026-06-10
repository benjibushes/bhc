'use client';

// Inline Send Deposit Invoice modal. Opened from a desk Cal row or
// pipeline tile. Picks rancher (filtered to tier_v2 + Active + state
// match if buyer's state known) + cut tier, fires POST
// /api/admin/send-deposit-invoice on submit.

import { useEffect, useState } from 'react';

interface RancherOption {
  id: string;
  name: string;
  state: string;
  tier: string;
  connectStatus: string;
  quarterPrice: number;
  halfPrice: number;
  wholePrice: number;
  quarterDeposit: number;
  halfDeposit: number;
  wholeDeposit: number;
}

interface Props {
  open: boolean;
  buyerEmail: string;
  buyerName: string;
  buyerState: string;
  onClose: () => void;
  onSuccess: (info: { referralId: string; checkoutUrl: string }) => void;
}

export default function SendDepositModal(props: Props) {
  const [ranchers, setRanchers] = useState<RancherOption[]>([]);
  const [rancherId, setRancherId] = useState('');
  const [cutTier, setCutTier] = useState<'Quarter' | 'Half' | 'Whole'>('Half');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!props.open) return;
    setLoading(true);
    setError('');
    fetch(`/api/admin/ranchers-tier-v2?state=${encodeURIComponent(props.buyerState)}`, {
      credentials: 'include',
    })
      .then((r) => r.json())
      .then((d) => {
        setRanchers(d.ranchers || []);
        if (d.ranchers?.[0]?.id) setRancherId(d.ranchers[0].id);
        setLoading(false);
      })
      .catch((e) => {
        setError(e?.message || 'load failed');
        setLoading(false);
      });
  }, [props.open, props.buyerState]);

  const selected = ranchers.find((r) => r.id === rancherId);
  const depositCents = selected
    ? (cutTier === 'Quarter' ? selected.quarterDeposit
        : cutTier === 'Half' ? selected.halfDeposit
        : selected.wholeDeposit) * 100
    : 0;
  const fullCents = selected
    ? (cutTier === 'Quarter' ? selected.quarterPrice
        : cutTier === 'Half' ? selected.halfPrice
        : selected.wholePrice) * 100
    : 0;

  const submit = async () => {
    if (!rancherId) return;
    setSubmitting(true);
    setError('');
    try {
      const r = await fetch('/api/admin/send-deposit-invoice', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          buyerEmail: props.buyerEmail,
          rancherId,
          cutTier,
        }),
      });
      const d = await r.json();
      if (!r.ok) {
        setError(d?.error || `${r.status}`);
        setSubmitting(false);
        return;
      }
      props.onSuccess({ referralId: d.referralId, checkoutUrl: d.checkoutUrl });
    } catch (e: any) {
      setError(e?.message || 'fire failed');
      setSubmitting(false);
    }
  };

  if (!props.open) return null;

  return (
    <div
      className="fixed inset-0 bg-charcoal/60 z-50 flex items-center justify-center p-4"
      onClick={props.onClose}
    >
      <div
        className="bg-bone border border-charcoal w-full max-w-lg p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="border-b border-divider pb-3 mb-4">
          <h2 className="font-serif text-xl text-charcoal">Send deposit invoice</h2>
          <p className="text-xs text-saddle mt-1">
            {props.buyerName} · {props.buyerEmail} · {props.buyerState || '?'}
          </p>
        </header>

        {loading ? (
          <p className="text-sm text-saddle">Loading tier_v2 ranchers…</p>
        ) : (
          <>
            <label className="block text-[11px] uppercase tracking-widest text-saddle mb-1">
              Rancher
            </label>
            <select
              value={rancherId}
              onChange={(e) => setRancherId(e.target.value)}
              className="w-full border border-divider bg-white p-2 mb-4 text-sm"
              disabled={ranchers.length === 0}
            >
              {ranchers.length === 0 && <option value="">No tier_v2 ranchers</option>}
              {ranchers.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} · {r.state} · {r.tier} · Connect {r.connectStatus}
                </option>
              ))}
            </select>

            <label className="block text-[11px] uppercase tracking-widest text-saddle mb-1">
              Cut tier
            </label>
            <div className="flex gap-2 mb-4">
              {(['Quarter', 'Half', 'Whole'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setCutTier(t)}
                  className={`flex-1 border p-2 text-sm transition-base ${
                    cutTier === t
                      ? 'bg-charcoal text-bone border-charcoal'
                      : 'border-divider bg-white text-charcoal hover:border-charcoal'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>

            {selected && (
              <div className="border border-divider bg-bone-warm p-3 text-sm mb-4">
                <div className="flex justify-between mb-1">
                  <span className="text-saddle">Deposit today:</span>
                  <strong>${(depositCents / 100).toFixed(0)}</strong>
                </div>
                <div className="flex justify-between">
                  <span className="text-saddle">Full sale price:</span>
                  <strong>${(fullCents / 100).toFixed(0)}</strong>
                </div>
              </div>
            )}

            {error && (
              <div className="border border-rust text-rust p-2 text-xs mb-3">{error}</div>
            )}

            <div className="flex gap-2 pt-2 border-t border-divider">
              <button
                type="button"
                onClick={submit}
                disabled={submitting || !rancherId || depositCents <= 0}
                className="flex-1 px-5 py-3 bg-charcoal text-bone text-[11px] uppercase tracking-widest hover:bg-divider transition-base disabled:opacity-50"
              >
                {submitting ? 'Sending…' : 'Send invoice'}
              </button>
              <button
                type="button"
                onClick={props.onClose}
                className="px-4 py-3 border border-divider text-saddle text-[11px] uppercase tracking-widest hover:bg-bone-warm transition-base"
              >
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
