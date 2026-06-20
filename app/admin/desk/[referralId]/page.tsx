'use client';

import { useState, useEffect } from 'react';
import { use as usePromise } from 'react';
import Link from 'next/link';
import AdminAuthGuard from '../../../components/AdminAuthGuard';

interface JourneyEvent {
  at: string;
  type: string;
  actor: string;
  summary: string;
  source: string;
}
interface Journey {
  referral: {
    id: string; status: string; buyerName: string; buyerEmail: string; buyerState: string;
    orderType: string; saleAmount: number; commissionDue: number; depositPaidAt: string;
    finalPaidAt: string; intentScore: number | null;
  };
  rancher: { id: string; name: string; state: string; email: string; phone: string } | null;
  responded: boolean;
  lastInbound: { at: string; from: string; summary: string } | null;
  nextAction: string;
  events: JourneyEvent[];
}

const ACTOR_DOT: Record<string, string> = {
  buyer: 'bg-rust', rancher: 'bg-sage-dark', admin: 'bg-charcoal',
  cron: 'bg-dust', system: 'bg-dust', stripe: 'bg-amber-dark', ai: 'bg-saddle',
};

function fmt(at: string) {
  const d = new Date(at);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function money(n: number) {
  return n ? `$${Number(n).toLocaleString()}` : '—';
}

export default function DealCockpitPage({ params }: { params: Promise<{ referralId: string }> }) {
  const { referralId } = usePromise(params);
  const [data, setData] = useState<Journey | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/admin/deal/${referralId}/journey`);
        if (!res.ok) {
          setErr((await res.json().catch(() => ({})))?.error || `Failed (${res.status})`);
        } else {
          setData(await res.json());
        }
      } catch {
        setErr('Could not load this deal.');
      }
      setLoading(false);
    })();
  }, [referralId]);

  return (
    <AdminAuthGuard>
      <main className="min-h-screen bg-bone text-charcoal pb-24">
        <div className="max-w-2xl mx-auto px-4 py-6">
          <Link href="/admin/referrals" className="text-sm text-saddle hover:text-charcoal">← All deals</Link>

          {loading && <p className="text-center text-saddle py-16">Loading deal…</p>}
          {err && !loading && <p className="text-center text-rust py-16">{err}</p>}

          {data && !loading && (
            <>
              {/* Header */}
              <div className="mt-3 p-5 border-2 border-charcoal bg-white">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h1 className="font-[family-name:var(--font-serif)] text-2xl">{data.referral.buyerName || 'Buyer'}</h1>
                    <p className="text-sm text-saddle">
                      {data.referral.buyerState || '—'} · {data.referral.orderType || 'order'}
                      {data.referral.intentScore != null && ` · intent ${data.referral.intentScore}`}
                    </p>
                    <p className="text-xs text-dust mt-1">{data.referral.buyerEmail}</p>
                  </div>
                  <span className="shrink-0 text-xs px-2 py-1 border border-dust bg-bone">{data.referral.status}</span>
                </div>

                <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm">
                  <div>
                    <span className="text-saddle">Rancher: </span>
                    {data.rancher
                      ? <span className="font-medium">{data.rancher.name} <span className="text-dust">({data.rancher.state})</span></span>
                      : <span className="text-rust font-medium">Unmatched</span>}
                  </div>
                  {!!data.referral.saleAmount && <div><span className="text-saddle">Sale: </span><span className="font-medium">{money(data.referral.saleAmount)}</span></div>}
                  {!!data.referral.commissionDue && <div><span className="text-saddle">Commission: </span><span className="font-medium">{money(data.referral.commissionDue)}</span></div>}
                </div>

                {/* Next action banner */}
                <div className="mt-4 p-3 bg-bone border-l-4 border-charcoal text-sm">
                  <span className="font-medium">Next: </span>{data.nextAction}
                  <span className={`ml-2 text-xs ${data.responded ? 'text-sage-dark' : 'text-saddle'}`}>
                    {data.responded ? '· buyer has replied' : '· no reply yet'}
                  </span>
                </div>

                <p className="mt-3 text-xs text-dust">Actions land here next — for now this is the full journey. Use the sales desk buttons to act.</p>
              </div>

              {/* Journey timeline */}
              <h2 className="font-[family-name:var(--font-serif)] text-lg mt-6 mb-3">Customer journey</h2>
              {data.events.length === 0 ? (
                <div className="p-6 border border-dust bg-white text-center text-saddle text-sm">No recorded events yet.</div>
              ) : (
                <div className="border border-dust bg-white">
                  {data.events.map((e, i) => (
                    <div key={i} className={`flex gap-3 p-3 ${i > 0 ? 'border-t border-dust' : ''}`}>
                      <div className="flex flex-col items-center pt-1">
                        <span className={`w-2.5 h-2.5 rounded-full ${ACTOR_DOT[e.actor] || 'bg-dust'}`} />
                        {i < data.events.length - 1 && <span className="w-px flex-1 bg-dust mt-1" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm">{e.summary}</div>
                        <div className="text-xs text-dust mt-0.5">{fmt(e.at)} · {e.actor}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </main>
    </AdminAuthGuard>
  );
}
