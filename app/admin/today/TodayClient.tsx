'use client';

// Wave 1B — THE cockpit client. Phone-first (375px, 44px tap targets,
// tabular-nums on money), everything else behind a collapsed "More" of plain
// links to the existing admin pages.
//
// CRM-parity (docs/ADAPTIVE-MARKETING-DESIGN.md §3.5, 2026-08-10):
//   • THE QUEUE is the TOP band — the fused dial list (buyers + stuck
//     ranchers + promised follow-ups + open deals + NBA one-liners) with C1
//     outcome buttons on every dialable row. The tap after each call is what
//     keeps tomorrow's list honest (docs/OPERATOR-LOOP.md, the daily 15 min).
//   • REPLIES WAITING renders the staged/escalated Conversations rows with a
//     one-tap Send that rides the Telegram bsend rail (shared lib).
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

interface WaitingReply {
  id: string;
  from: string;
  senderType: string;
  subject: string;
  aiSummary: string;
  stagedPreview: string;
  replyStatus: string;
  sendable: boolean;
  ageHours: number | null;
}

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
  replies: WaitingReply[] | null;
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

const KIND_BADGE: Partial<Record<CockpitDialRow['kind'], string>> = {
  rancher: 'rancher',
  promise: 'promise',
  deal: 'deal',
  action: 'now',
};

export default function TodayClient() {
  const [data, setData] = useState<TodayData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const lastFetchRef = useRef(0);
  // C1 — rows resolved this session (outcome stamped server-side); hidden
  // locally so the list reflects the tap before the next poll.
  const [resolvedRows, setResolvedRows] = useState<Record<string, string>>({});
  const [sentReplies, setSentReplies] = useState<Record<string, boolean>>({});

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

  const markResolved = useCallback((rowId: string, label: string) => {
    setResolvedRows((prev) => ({ ...prev, [rowId]: label }));
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bone">
        <div className="w-8 h-8 border-4 border-charcoal border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const visibleDial = (data?.dial ?? []).filter((r) => !resolvedRows[r.id]);
  const resolvedCount = (data?.dial ?? []).length - visibleDial.length;

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

      {/* TOP BAND — THE QUEUE (C2 fusion: dials + promises + deals + NBA) */}
      <section aria-label="The queue" className="space-y-2">
        <h2 className="text-xs font-semibold tracking-widest text-muted">THE QUEUE</h2>
        {data?.dial == null ? (
          <p className="text-sm text-saddle">Queue unavailable.</p>
        ) : visibleDial.length === 0 ? (
          <p className="text-sm text-saddle">
            {resolvedCount > 0
              ? `All ${resolvedCount} worked — done for today.`
              : 'Nothing in the queue. Rare. Enjoy it.'}
          </p>
        ) : (
          <ul className="space-y-2">
            {visibleDial.map((row) => (
              <QueueRow key={row.id} row={row} onResolved={markResolved} />
            ))}
          </ul>
        )}
        {resolvedCount > 0 && visibleDial.length > 0 && (
          <p className="text-xs text-saddle">
            {resolvedCount} row{resolvedCount === 1 ? '' : 's'} worked this session.
          </p>
        )}
      </section>

      {/* REPLIES WAITING (C3) */}
      <section aria-label="Replies waiting" className="space-y-2">
        <h2 className="text-xs font-semibold tracking-widest text-muted">REPLIES WAITING</h2>
        {data?.replies == null ? (
          <p className="text-sm text-saddle">Replies band unavailable.</p>
        ) : data.replies.length === 0 ? (
          <p className="text-sm text-saddle">No replies waiting on you.</p>
        ) : (
          <ul className="space-y-2">
            {data.replies.map((r) => (
              <ReplyRow
                key={r.id}
                reply={r}
                sent={!!sentReplies[r.id]}
                onSent={() => setSentReplies((prev) => ({ ...prev, [r.id]: true }))}
              />
            ))}
          </ul>
        )}
      </section>

      {/* MONEY */}
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

      {/* WHAT BROKE */}
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

      {/* THE ONE MOVE */}
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

      {/* SUPPLY */}
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

// ── THE QUEUE row: dial actions + C1 outcome buttons ────────────────────────

function QueueRow({
  row,
  onResolved,
}: {
  row: CockpitDialRow;
  onResolved: (rowId: string, label: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');
  // 'talked' opens a second-tap choice: no follow-up / +3d / +7d.
  const [talkedOpen, setTalkedOpen] = useState(false);

  const badge = KIND_BADGE[row.kind];

  const postOutcome = async (
    outcome: 'no-answer' | 'talked' | 'skip',
    followUpDays?: number,
  ) => {
    if (!row.outcomeKind || busy) return;
    setBusy(true);
    setFailed('');
    try {
      const res = await fetch('/api/admin/dial-outcome', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: row.outcomeKind,
          id: row.id,
          outcome,
          ...(followUpDays ? { followUpDays } : {}),
          ...(row.referralId ? { referralId: row.referralId } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body?.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      onResolved(row.id, outcome);
    } catch (e) {
      setFailed(e instanceof Error ? e.message : 'write failed');
      setBusy(false);
    }
  };

  return (
    <li
      className={`bg-white border border-dust rounded-sm p-3 ${
        row.kind === 'recruit' ? 'border-l-4 border-l-tallow' : ''
      }${row.kind === 'action' ? ' border-l-4 border-l-charcoal' : ''}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium truncate">
            {row.name}
            {row.state && row.kind !== 'recruit' && (
              <span className="ml-2 text-xs text-saddle">{row.state}</span>
            )}
            {badge && (
              <span className="ml-2 text-[11px] uppercase tracking-wide text-saddle border border-dust px-1">
                {badge}
              </span>
            )}
            {row.slaLabel && (
              <span className="ml-2 text-[11px] tracking-wide text-charcoal border border-dust px-1 whitespace-nowrap">
                {row.slaLabel}
              </span>
            )}
          </p>
          <p className="text-xs text-saddle mt-0.5">{row.why}</p>
          {row.nba && <p className="text-xs text-charcoal mt-0.5">Do: {row.nba}</p>}
          {row.nextStep && <p className="text-xs text-charcoal mt-0.5">Say: {row.nextStep}</p>}
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

      {/* C1 — outcome buttons. The tap is what re-ranks tomorrow's queue. */}
      {row.outcomeKind && (
        <div className="mt-2 pt-2 border-t border-dust">
          {talkedOpen ? (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-xs text-saddle mr-1">Follow up?</span>
              <OutcomeBtn disabled={busy} onClick={() => postOutcome('talked')}>
                No follow-up
              </OutcomeBtn>
              <OutcomeBtn disabled={busy} onClick={() => postOutcome('talked', 3)}>
                In 3d
              </OutcomeBtn>
              <OutcomeBtn disabled={busy} onClick={() => postOutcome('talked', 7)}>
                In 7d
              </OutcomeBtn>
              <OutcomeBtn disabled={busy} onClick={() => setTalkedOpen(false)} subtle>
                Back
              </OutcomeBtn>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-1">
              <OutcomeBtn disabled={busy} onClick={() => postOutcome('no-answer')}>
                No answer
              </OutcomeBtn>
              <OutcomeBtn disabled={busy} onClick={() => setTalkedOpen(true)}>
                Talked
              </OutcomeBtn>
              <OutcomeBtn disabled={busy} onClick={() => postOutcome('skip')} subtle>
                Skip
              </OutcomeBtn>
            </div>
          )}
          {failed && <p className="text-xs text-weathered mt-1">Couldn’t save: {failed}</p>}
        </div>
      )}
    </li>
  );
}

function OutcomeBtn({
  onClick,
  disabled,
  subtle,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  subtle?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`min-h-11 px-3 text-sm rounded-sm disabled:opacity-50 ${
        subtle ? 'border border-dust text-saddle' : 'border border-charcoal'
      }`}
    >
      {children}
    </button>
  );
}

// ── REPLIES WAITING row (C3) ────────────────────────────────────────────────

function ReplyRow({
  reply,
  sent,
  onSent,
}: {
  reply: WaitingReply;
  sent: boolean;
  onSent: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');

  const send = async () => {
    if (busy || sent) return;
    setBusy(true);
    setFailed('');
    try {
      const res = await fetch(`/api/admin/replies/${reply.id}/send`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body?.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      onSent();
    } catch (e) {
      setFailed(e instanceof Error ? e.message : 'send failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="bg-white border border-dust rounded-sm p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium truncate">
            {reply.from || '(unknown sender)'}
            {reply.ageHours != null && (
              <span className="ml-2 text-xs text-saddle">{reply.ageHours}h ago</span>
            )}
          </p>
          {reply.subject && <p className="text-xs text-saddle mt-0.5 truncate">{reply.subject}</p>}
          {reply.aiSummary && <p className="text-xs text-charcoal mt-0.5">{reply.aiSummary}</p>}
          {reply.stagedPreview && (
            <p className="text-xs text-saddle mt-1 border-l-2 border-dust pl-2 line-clamp-3">
              {reply.stagedPreview}
            </p>
          )}
          {!reply.sendable && (
            <p className="text-xs text-weathered mt-1">
              Needs your own words — reply from your inbox.
            </p>
          )}
        </div>
        {reply.sendable && (
          <button
            onClick={send}
            disabled={busy || sent}
            className={`min-h-11 shrink-0 px-3 text-sm rounded-sm disabled:opacity-60 ${
              sent ? 'border border-dust text-saddle' : 'bg-charcoal text-bone'
            }`}
          >
            {sent ? 'Sent ✓' : busy ? 'Sending…' : 'Send reply'}
          </button>
        )}
      </div>
      {failed && <p className="text-xs text-weathered mt-1">Couldn’t send: {failed}</p>}
    </li>
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
