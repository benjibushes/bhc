'use client';

// Wave 1B — THE cockpit client. Five bands above the fold, phone-first
// (375px, 44px tap targets, tabular-nums on money), everything else behind a
// collapsed "More" of plain links to the existing admin pages.
//
// Polling: every 120s (HARD FLOOR — the backing route rides the shared
// 3-min admin snapshot, and the Airtable org limit is 5 req/s across 63
// crons; do not lower this) + a manual refresh button.

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ADMIN_NAV } from '../nav';
import type { CockpitDialRow } from '@/lib/cockpitDialList';
import MarketingScoreboard from './MarketingScoreboard';

const POLL_MS = 120_000;

interface TodayData {
  generatedAt: string;
  operatorDay: string;
  money: {
    earnedTodayCents: number;
    earnedMtdCents: number;
    owedCents: number;
    owedCount: number;
    stuckCents: number;
    stuckCount: number;
    stuckOldestHours: number | null;
  } | null;
  health: {
    healthy: boolean;
    reds: Array<{ name: string; detail: string; fix?: string }>;
  } | null;
  dial: CockpitDialRow[] | null;
  oneMove: string | null;
  supply: {
    payable: number;
    signedStuck: number;
    inOnboarding: number;
    coveredStates: string[];
  } | null;
}

function fmtUsd(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString('en-US')}`;
}

/** tel:/sms:-safe number — digits and a leading + only. */
function dialable(phone: string): string {
  return String(phone || '').replace(/[^+\d]/g, '');
}

export default function TodayClient() {
  const [data, setData] = useState<TodayData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const lastFetchRef = useRef(0);

  const load = useCallback(async () => {
    // Hard floor between fetches, even across focus/refresh clicks.
    if (Date.now() - lastFetchRef.current < POLL_MS - 5_000) return;
    lastFetchRef.current = Date.now();
    try {
      const res = await fetch('/api/admin/today');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    lastFetchRef.current = 0; // first load fires immediately
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bone">
        <div className="w-8 h-8 border-4 border-charcoal border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <main className="max-w-xl mx-auto px-4 py-5 space-y-5 text-charcoal">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="font-[family-name:var(--font-serif)] text-2xl">Today</h1>
          {data?.generatedAt && (
            <p className="text-xs text-saddle">
              as of{' '}
              {new Date(data.generatedAt).toLocaleTimeString('en-US', {
                hour: 'numeric',
                minute: '2-digit',
              })}
            </p>
          )}
        </div>
        <button
          onClick={() => {
            lastFetchRef.current = 0;
            load();
          }}
          className="min-h-11 min-w-11 px-3 border border-dust bg-white text-sm rounded-sm"
        >
          Refresh
        </button>
      </header>

      {error && (
        <div className="p-3 border border-weathered text-weathered text-sm">
          Couldn’t load: {error}. Showing {data ? 'last good data' : 'nothing yet'}.
        </div>
      )}

      {/* BAND 1 — MONEY */}
      <section aria-label="Money" className="space-y-2">
        <h2 className="text-xs font-semibold tracking-widest text-muted">MONEY</h2>
        <div className="grid grid-cols-2 gap-2">
          <MoneyTile label="Earned today" cents={data?.money?.earnedTodayCents} />
          <MoneyTile label="Earned MTD" cents={data?.money?.earnedMtdCents} />
          <MoneyTile
            label="Owed to me"
            cents={data?.money?.owedCents}
            sub={data?.money ? `${data.money.owedCount} open` : undefined}
          />
          <MoneyTile
            label="Stuck"
            cents={data?.money?.stuckCents}
            sub={
              data?.money
                ? data.money.stuckCount > 0
                  ? `${data.money.stuckCount} paid, no accept${
                      data.money.stuckOldestHours != null
                        ? ` · oldest ${data.money.stuckOldestHours}h`
                        : ''
                    }`
                  : 'nothing frozen'
                : undefined
            }
            alert={(data?.money?.stuckCount ?? 0) > 0}
          />
        </div>
      </section>

      {/* BAND 2 — WHAT BROKE */}
      <section aria-label="What broke" className="space-y-2">
        <h2 className="text-xs font-semibold tracking-widest text-muted">WHAT BROKE</h2>
        {data?.health == null ? (
          <p className="text-sm text-saddle">Health check unavailable.</p>
        ) : data.health.healthy ? (
          <p className="text-sm py-2 px-3 bg-white border border-dust rounded-sm">
            ✓ Nothing broke — probes green, crons clean.
          </p>
        ) : (
          <ul className="space-y-1">
            {data.health.reds.map((r) => (
              <li
                key={r.name}
                className="text-sm py-2 px-3 bg-white border border-dust border-l-4 border-l-weathered rounded-sm"
              >
                <span className="font-semibold">{r.name}:</span> {r.detail}
                {r.fix && <span className="block text-xs text-saddle mt-0.5">Fix: {r.fix}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* BAND 3 — DIAL LIST */}
      <section aria-label="Dial list" className="space-y-2">
        <h2 className="text-xs font-semibold tracking-widest text-muted">WHO TO CALL</h2>
        {data?.dial == null ? (
          <p className="text-sm text-saddle">Dial list unavailable.</p>
        ) : data.dial.length === 0 ? (
          <p className="text-sm text-saddle">Nobody to dial. Rare. Enjoy it.</p>
        ) : (
          <ul className="space-y-2">
            {data.dial.map((row) => (
              <li
                key={row.id}
                className={`bg-white border border-dust rounded-sm p-3 ${
                  row.kind === 'recruit' ? 'border-l-4 border-l-tallow' : ''
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium truncate">
                      {row.name}
                      {row.state && row.kind !== 'recruit' && (
                        <span className="ml-2 text-xs text-saddle">{row.state}</span>
                      )}
                      {row.kind === 'rancher' && (
                        <span className="ml-2 text-[11px] uppercase tracking-wide text-saddle border border-dust px-1">
                          rancher
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-saddle mt-0.5">{row.why}</p>
                    {row.nextStep && (
                      <p className="text-xs text-charcoal mt-0.5">Say: {row.nextStep}</p>
                    )}
                  </div>
                  {row.phone && dialable(row.phone) && (
                    <div className="flex gap-1 shrink-0">
                      <a
                        href={`tel:${dialable(row.phone)}`}
                        className="min-h-11 min-w-11 flex items-center justify-center px-3 bg-charcoal text-bone text-sm rounded-sm"
                      >
                        Call
                      </a>
                      <a
                        href={`sms:${dialable(row.phone)}`}
                        className="min-h-11 min-w-11 flex items-center justify-center px-3 border border-charcoal text-sm rounded-sm"
                      >
                        Text
                      </a>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* BAND 4 — THE ONE MOVE */}
      <section aria-label="The one move">
        <div className="bg-charcoal text-bone rounded-sm p-4">
          <p className="text-[11px] font-semibold tracking-widest text-tallow mb-1">
            THE ONE MOVE
          </p>
          <p className="text-sm leading-snug">
            {data?.oneMove ?? 'Unavailable — reload in a minute.'}
          </p>
        </div>
      </section>

      {/* BAND 5 — SUPPLY */}
      <section aria-label="Supply">
        <h2 className="text-xs font-semibold tracking-widest text-muted mb-2">SUPPLY</h2>
        {data?.supply == null ? (
          <p className="text-sm text-saddle">Supply counts unavailable.</p>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            <StatTile label="Payable" value={data.supply.payable} />
            <StatTile label="Signed, stuck" value={data.supply.signedStuck} />
            <StatTile label="In onboarding" value={data.supply.inOnboarding} />
          </div>
        )}
        {data?.supply && (
          <p className="text-xs text-saddle mt-1">
            Covered states ({data.supply.coveredStates.length}):{' '}
            {data.supply.coveredStates.join(' ') || 'none'}
          </p>
        )}
      </section>

      {/* P6′ — per-lane marketing scoreboard (self-contained block) */}
      <MarketingScoreboard />

      {/* Everything else — plain links, no data re-rendered */}
      <details className="pt-2">
        <summary className="min-h-11 flex items-center cursor-pointer text-sm font-medium text-saddle select-none">
          More
        </summary>
        <ul className="mt-1 divide-y divide-dust border border-dust bg-white rounded-sm">
          {ADMIN_NAV.filter((n) => n.href !== '/admin/today').map((n) => (
            <li key={n.href}>
              <Link href={n.href} className="min-h-11 flex items-center gap-2 px-3 py-2 text-sm">
                <span className="w-5 text-center">{n.icon}</span>
                <span>{n.label}</span>
              </Link>
            </li>
          ))}
        </ul>
      </details>
    </main>
  );
}

function MoneyTile({
  label,
  cents,
  sub,
  alert,
}: {
  label: string;
  cents: number | undefined;
  sub?: string;
  alert?: boolean;
}) {
  return (
    <div
      className={`bg-white border border-dust rounded-sm p-3 ${
        alert ? 'border-l-4 border-l-weathered' : ''
      }`}
    >
      <p className="text-[11px] font-semibold tracking-widest text-muted">{label.toUpperCase()}</p>
      <p className="text-2xl tabular-nums mt-0.5">{cents == null ? '—' : fmtUsd(cents)}</p>
      {sub && <p className="text-xs text-saddle tabular-nums">{sub}</p>}
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-white border border-dust rounded-sm p-3 text-center">
      <p className="text-2xl tabular-nums">{value}</p>
      <p className="text-[11px] font-semibold tracking-widest text-muted">{label.toUpperCase()}</p>
    </div>
  );
}
