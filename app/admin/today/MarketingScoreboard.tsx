'use client';

// P6′ — the per-lane marketing scoreboard block on /admin/today
// (MARKETING-REVAMP-2026-08 §5 Convergence + §7). Self-contained: own fetch
// against /api/admin/marketing-scoreboard (route caches 60s; this client
// polls no faster than the cockpit's 120s floor), design-system tokens,
// table-lite rows, honest empty states. Counts only — no PII.

import { useCallback, useEffect, useRef, useState } from 'react';

const POLL_MS = 120_000;

interface ScoreboardData {
  generatedAt: string;
  lanes: {
    shareReady: number;
    national: number;
    customer: number;
    total: number | null;
    asOf: string | null;
  } | null;
  sendsByStream: {
    windowDays: number;
    marketing: number;
    transactional: number;
    total: number;
  } | null;
  depositFunnel: {
    windowDays: number;
    inviteSent: number;
    requested: number;
    paid: number;
    rates: {
      inviteToRequestPct: number | null;
      requestToPaidPct: number | null;
      inviteToPaidPct: number | null;
    };
  } | null;
  complaints: { count7d: number; threshold: number; alert: boolean } | null;
  digest: {
    asOf: string | null;
    status: string | null;
    note: string;
    parsed: {
      outsideWindow: boolean;
      dryRun: boolean;
      tier: number | null;
      tierSizes: number[] | null;
      eligible: number | null;
      selected: number | null;
      sent: number | null;
      thinMonth: boolean | null;
    } | null;
  } | null;
  closes: { windowDays: number; closedInWindow: number; missingClosedAt: number } | null;
  gates: Array<{
    phase: string;
    metric: string;
    current: number;
    target: number;
    reached: boolean;
    label: string;
  }>;
}

const pct = (v: number | null): string => (v == null ? '—' : `${v}%`);

function digestSummary(d: NonNullable<ScoreboardData['digest']>): string {
  const p = d.parsed;
  if (!p) return 'last run note unavailable (unparseable)';
  if (p.outsideWindow) return 'idle — outside days 1-4 send window';
  const bits: string[] = [];
  if (p.dryRun) bits.push('DRY-RUN');
  if (p.tier != null) bits.push(`tier ${p.tier}`);
  if (p.tierSizes) bits.push(`tiers [${p.tierSizes.join(', ')}]`);
  if (p.eligible != null) bits.push(`eligible ${p.eligible}`);
  if (p.sent != null) bits.push(`sent ${p.sent}`);
  else if (p.selected != null) bits.push(`would send ${p.selected}`);
  if (p.thinMonth != null) bits.push(p.thinMonth ? 'thin month' : 'stocked month');
  return bits.join(' · ') || 'last run note unavailable (unparseable)';
}

export default function MarketingScoreboard() {
  const [data, setData] = useState<ScoreboardData | null>(null);
  const [error, setError] = useState('');
  const lastFetchRef = useRef(0);

  const load = useCallback(async () => {
    if (Date.now() - lastFetchRef.current < POLL_MS - 5_000) return;
    lastFetchRef.current = Date.now();
    try {
      const res = await fetch('/api/admin/marketing-scoreboard');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load failed');
    }
  }, []);

  useEffect(() => {
    lastFetchRef.current = 0;
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const complaintAlert = data?.complaints?.alert ?? false;

  return (
    <section aria-label="Marketing scoreboard" className="space-y-2">
      <h2 className="text-xs font-semibold tracking-widest text-muted">
        marketing scoreboard
      </h2>
      {error && !data && (
        <p className="text-sm text-saddle">Scoreboard unavailable ({error}).</p>
      )}
      {data && (
        <div className="bg-white border border-dust rounded-sm divide-y divide-dust text-sm">
          <Row label="lanes">
            {data.lanes ? (
              <span className="tabular-nums">
                share-ready {data.lanes.shareReady} · national {data.lanes.national} ·
                customer {data.lanes.customer}
                {data.lanes.total != null && (
                  <span className="text-saddle"> / {data.lanes.total}</span>
                )}
              </span>
            ) : (
              <Empty>unavailable — no parseable reclassify run</Empty>
            )}
          </Row>

          <Row label="sends 7d">
            {data.sendsByStream ? (
              <span className="tabular-nums">
                marketing {data.sendsByStream.marketing} · transactional{' '}
                {data.sendsByStream.transactional}
              </span>
            ) : (
              <Empty>unavailable</Empty>
            )}
          </Row>

          <Row label="deposits 30d">
            {data.depositFunnel ? (
              <span className="tabular-nums">
                invite {data.depositFunnel.inviteSent} → request {data.depositFunnel.requested}{' '}
                <span className="text-saddle">({pct(data.depositFunnel.rates.inviteToRequestPct)})</span>{' '}
                → paid {data.depositFunnel.paid}{' '}
                <span className="text-saddle">({pct(data.depositFunnel.rates.requestToPaidPct)})</span>
              </span>
            ) : (
              <Empty>unavailable</Empty>
            )}
          </Row>

          <Row label="complaints 7d" alert={complaintAlert}>
            {data.complaints ? (
              <span className={`tabular-nums ${complaintAlert ? 'text-weathered font-semibold' : ''}`}>
                {data.complaints.count7d}
                <span className={complaintAlert ? '' : 'text-saddle'}>
                  {' '}
                  / alert at {data.complaints.threshold}+
                </span>
              </span>
            ) : (
              <Empty>unavailable</Empty>
            )}
          </Row>

          <Row label="digest">
            {data.digest ? (
              <span className="tabular-nums">{digestSummary(data.digest)}</span>
            ) : (
              <Empty>no digest run yet</Empty>
            )}
          </Row>

          <Row label="closes 7d">
            {data.closes ? (
              <span className="tabular-nums">
                {data.closes.closedInWindow}
                {data.closes.missingClosedAt > 0 && (
                  <span className="text-saddle">
                    {' '}
                    (+{data.closes.missingClosedAt} closed-won undated)
                  </span>
                )}
              </span>
            ) : (
              <Empty>unavailable</Empty>
            )}
          </Row>

          <Row label="gates">
            {data.gates.length > 0 ? (
              <span className="tabular-nums">
                {data.gates.map((g, i) => (
                  <span key={g.phase}>
                    {i > 0 && ' · '}
                    {g.metric} {g.label}{' '}
                    <span className="text-saddle">
                      {g.reached ? '— enough events to judge' : '— evaluating'}
                    </span>
                  </span>
                ))}
              </span>
            ) : (
              <Empty>no gate data yet</Empty>
            )}
          </Row>
        </div>
      )}
    </section>
  );
}

function Row({
  label,
  alert,
  children,
}: {
  label: string;
  alert?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`flex items-baseline gap-3 px-3 py-2 ${
        alert ? 'border-l-4 border-l-weathered' : ''
      }`}
    >
      <span className="w-28 shrink-0 text-[11px] font-semibold tracking-widest text-muted">
        {label}
      </span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <span className="text-saddle">{children}</span>;
}
