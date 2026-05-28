'use client';

import { useEffect, useState } from 'react';

interface FunnelData {
  sinceDays: number;
  events: number;
  byStage: Record<string, number>;
  rates: {
    signupToEngaged: number;
    engagedToMatched: number;
    matchedToClosedWon: number;
    overallSignupToWon: number;
  };
  revenueCents: number;
  summary?: {
    signups: number;
    engaged: number;
    matched: number;
    closedWon: number;
    closedLost: number;
    depositPaid: number;
  };
  error?: string;
}

export default function FunnelPage() {
  const [data, setData] = useState<FunnelData | null>(null);
  const [days, setDays] = useState<number>(30);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/admin/funnel?sinceDays=${days}`, { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => {
        setData(j);
        setLoading(false);
      })
      .catch((e) => {
        setData({ error: e?.message || 'Load failed' } as any);
        setLoading(false);
      });
  }, [days]);

  if (loading) return <div className="p-8 bg-bone min-h-screen text-charcoal">Loading…</div>;
  if (!data) return <div className="p-8 bg-bone min-h-screen text-charcoal">No data.</div>;
  if (data.error) {
    return (
      <div className="p-8 bg-bone min-h-screen text-charcoal">
        <h1 className="text-3xl font-serif mb-4">Funnel</h1>
        <div className="border border-saddle bg-bone p-4 text-saddle">⚠️ {data.error}</div>
      </div>
    );
  }

  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

  return (
    <div className="p-8 bg-bone min-h-screen text-charcoal">
      <h1 className="text-3xl font-serif mb-6">Funnel — last {days}d</h1>

      <div className="mb-6 flex items-center gap-3">
        <label className="text-sm text-saddle">Window:</label>
        <select
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          className="border border-dust px-2 py-1 bg-bone text-charcoal"
        >
          <option value={7}>7 days</option>
          <option value={30}>30 days</option>
          <option value={90}>90 days</option>
        </select>
        <span className="text-saddle text-sm">·  {data.events} events captured</span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <Card label="Signup → Engaged" value={pct(data.rates.signupToEngaged)} />
        <Card label="Engaged → Matched" value={pct(data.rates.engagedToMatched)} />
        <Card label="Matched → Closed Won" value={pct(data.rates.matchedToClosedWon)} />
        <Card label="Overall Signup → Won" value={pct(data.rates.overallSignupToWon)} />
      </div>

      {data.summary && (
        <div className="grid grid-cols-3 md:grid-cols-6 gap-3 mb-8">
          <Stat label="Signups" value={data.summary.signups} />
          <Stat label="Engaged" value={data.summary.engaged} />
          <Stat label="Matched" value={data.summary.matched} />
          <Stat label="Closed Won" value={data.summary.closedWon} />
          <Stat label="Closed Lost" value={data.summary.closedLost} />
          <Stat label="Deposit Paid" value={data.summary.depositPaid} />
        </div>
      )}

      <h2 className="text-xl font-serif mb-2">Stages (all)</h2>
      <table className="w-full border border-dust">
        <thead className="bg-bone">
          <tr>
            <th className="p-2 text-left text-saddle text-sm uppercase tracking-wide">Stage</th>
            <th className="p-2 text-right text-saddle text-sm uppercase tracking-wide">Events</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(data.byStage).sort((a, b) => b[1] - a[1]).map(([stage, count]) => (
            <tr key={stage} className="border-t border-divider">
              <td className="p-2 text-charcoal font-mono text-sm">{stage}</td>
              <td className="p-2 text-right text-charcoal">{count}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-6 text-saddle text-sm">
        Total revenue (Closed Won, last {days}d):{' '}
        <strong className="text-charcoal">${(data.revenueCents / 100).toLocaleString()}</strong>
      </div>
    </div>
  );
}

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-dust p-4 bg-bone">
      <div className="text-saddle text-xs uppercase tracking-wide">{label}</div>
      <div className="text-3xl font-serif mt-1 text-charcoal">{value}</div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="border border-dust p-3 bg-bone text-center">
      <div className="text-saddle text-xs uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-serif mt-1 text-charcoal">{value}</div>
    </div>
  );
}
