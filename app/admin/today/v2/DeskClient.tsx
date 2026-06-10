'use client';

// Sales-floor desk v3 — closed-loop sales console.
//
// Renders:
//  - Hero pipeline cards (quiz-complete count, deposit-pending $, locked $, closed today $)
//  - Cal bookings (next 7 days) inline w/ Join + Send Invoice + quiz-score chip
//  - Quiz-complete awaiting outreach
//  - Deposit pending — w/ "Open buyer flow" inline
//  - Closed today celebration tape
//  - Waitlisted-by-state
//  - Inline SendDepositModal for closing a buyer post-call

import { useEffect, useState, useCallback } from 'react';
import SendDepositModal from './SendDepositModal';

interface CalBooking {
  id: string;
  uid: string;
  title: string;
  startTime: string;
  endTime: string;
  duration: number;
  status: string;
  attendeeName: string;
  attendeeEmail: string;
  meetingUrl: string;
}

interface DeskBuyer {
  id: string;
  name: string;
  email: string;
  state: string;
  quizScore: number;
  intentScore: number;
  qualifiedAt: string;
  leadScore: number;
  leadReasons: string[];
  emailOpens?: number;
  emailClicks?: number;
  lastOpenedAt?: string;
  lastClickedAt?: string;
}

interface DeskReferral {
  id: string;
  buyerEmail: string;
  rancherName: string;
  saleAmount: number;
  depositAmount: number;
  state: string;
  closedAt: string;
  status?: string;
  daysSinceActivity?: number | null;
}

interface NBAItem {
  priority: 1 | 2 | 3;
  type: 'call' | 'chase' | 'send' | 'recruit';
  subject: string;
  reason: string;
  action: string;
  entityType: 'consumer' | 'referral' | 'rancher' | 'cal';
  entityId?: string;
}

interface DeskData {
  calls: any[];
  quizComplete: DeskBuyer[];
  depositPending: DeskReferral[];
  slotsLocked: DeskReferral[];
  closedToday: DeskReferral[];
  waitlisted: { state: string; count: number }[];
  ranchersActive: number;
  pipeline: {
    quizPotential: number;
    pendingValueCents: number;
    lockedValueCents: number;
    closedTodayValueCents: number;
  };
  nba?: NBAItem[];
}

interface ModalState {
  open: boolean;
  buyerEmail: string;
  buyerName: string;
  buyerState: string;
}

interface FunnelData {
  since: string;
  totals: { signup: number; qualified: number; booked: number; invoiced: number; locked: number; closed: number };
  conv: {
    signup_to_qualified: number;
    qualified_to_booked: number;
    booked_to_invoiced: number;
    invoiced_to_locked: number;
    locked_to_closed: number;
    signup_to_closed: number;
  };
  bySource: Array<{
    source: string;
    signup: number;
    qualified: number;
    booked: number;
    invoiced: number;
    locked: number;
    closed: number;
    conv: { signup_to_closed: number };
  }>;
}

export default function DeskClient() {
  const [desk, setDesk] = useState<DeskData | null>(null);
  const [bookings, setBookings] = useState<CalBooking[]>([]);
  const [funnel, setFunnel] = useState<FunnelData | null>(null);
  const [calError, setCalError] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<ModalState>({
    open: false,
    buyerEmail: '',
    buyerName: '',
    buyerState: '',
  });
  const [flash, setFlash] = useState<string | null>(null);

  const tick = useCallback(async () => {
    try {
      const [deskRes, calRes, funnelRes] = await Promise.all([
        fetch('/api/admin/desk', { credentials: 'include' }),
        fetch('/api/admin/cal/bookings', { credentials: 'include' }),
        fetch('/api/admin/funnel-conversion?since=30d', { credentials: 'include' }),
      ]);
      if (deskRes.ok) {
        const d = (await deskRes.json()) as DeskData;
        setDesk(d);
        setError('');
      } else {
        setError(`Desk ${deskRes.status}`);
      }
      if (calRes.ok) {
        const c = await calRes.json();
        setBookings(c.bookings || []);
        setCalError(c.error || '');
      } else {
        setCalError(`Cal ${calRes.status}`);
      }
      if (funnelRes.ok) {
        const f = (await funnelRes.json()) as FunnelData;
        setFunnel(f);
      }
    } catch (e: any) {
      setError(e?.message || 'fetch failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    tick();
    const id = setInterval(tick, 30000);
    return () => clearInterval(id);
  }, [tick]);

  const openModal = (buyerEmail: string, buyerName: string, buyerState: string) => {
    setModal({ open: true, buyerEmail, buyerName, buyerState });
  };

  const onModalSuccess = (info: { referralId: string; checkoutUrl: string }) => {
    setModal({ open: false, buyerEmail: '', buyerName: '', buyerState: '' });
    setFlash(`Deposit invoice sent. Checkout URL: ${info.checkoutUrl}`);
    setTimeout(() => setFlash(null), 8000);
    tick();
  };

  if (loading) {
    return <main className="min-h-screen bg-bone p-8 text-saddle">Loading desk…</main>;
  }
  if (!desk) {
    return (
      <main className="min-h-screen bg-bone p-8">
        <p className="text-rust">Desk error: {error || 'no data'}</p>
        <p className="text-sm text-saddle mt-2">
          Likely admin cookie expired.{' '}
          <a className="underline" href="/admin/login?next=/admin/today/v2">
            Re-login
          </a>
        </p>
      </main>
    );
  }

  const fmtUsd = (cents: number) =>
    `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  const fmtTimeUntil = (iso: string) => {
    if (!iso) return '?';
    const ms = new Date(iso).getTime() - Date.now();
    if (ms < 0) {
      const mAgo = Math.abs(Math.round(ms / 60000));
      return mAgo < 60 ? `${mAgo}m ago` : `${Math.round(mAgo / 60)}h ago`;
    }
    const min = Math.round(ms / 60000);
    if (min < 60) return `in ${min}m`;
    const hrs = Math.round(min / 60);
    if (hrs < 24) return `in ${hrs}h`;
    return `in ${Math.round(hrs / 24)}d`;
  };

  return (
    <main className="min-h-screen bg-bone">
      <div className="max-w-6xl mx-auto p-6 md:p-8">
        {/* Header */}
        <header className="flex flex-col md:flex-row md:items-end justify-between mb-6 gap-2">
          <div>
            <h1 className="font-serif text-3xl md:text-4xl text-charcoal">Today</h1>
            <p className="text-sm text-saddle">
              {new Date().toLocaleDateString(undefined, {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
              })}{' '}
              · auto-refresh 30s
            </p>
          </div>
          <a
            href={process.env.NEXT_PUBLIC_BHC_OPERATOR_CAL_URL || 'https://cal.com/ben-beauchman-1itnsg/sales'}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs uppercase tracking-widest text-charcoal underline underline-offset-4"
          >
            Manage your Cal →
          </a>
        </header>

        {flash && (
          <div className="border border-sage bg-bone-warm p-3 mb-4 text-sm text-sage-dark">
            ✓ {flash}
          </div>
        )}

        {/* F6 — Next Best Action */}
        {desk.nba && desk.nba.length > 0 && (
          <section className="mb-5 border-l-4 border-charcoal bg-bone-warm p-4 md:p-5">
            <h2 className="font-serif text-lg text-charcoal mb-2">
              Next Best Action
              <span className="text-xs text-saddle ml-2">({desk.nba.length})</span>
            </h2>
            <ol className="space-y-1.5">
              {desk.nba.map((n, i) => (
                <li key={i} className="flex items-start gap-3 text-sm">
                  <span
                    className={`inline-block w-5 h-5 text-center text-[10px] leading-5 font-bold ${
                      n.priority === 1
                        ? 'bg-charcoal text-bone'
                        : n.priority === 2
                          ? 'bg-saddle text-bone'
                          : 'bg-divider text-charcoal'
                    }`}
                  >
                    {n.priority}
                  </span>
                  <span className="flex-1">
                    <strong className="text-charcoal">{n.subject}</strong>
                    <span className="text-saddle"> — {n.reason}</span>
                    <span className="block text-xs text-charcoal mt-0.5">→ {n.action}</span>
                  </span>
                  <span className="text-[10px] uppercase tracking-widest text-saddle">
                    {n.type}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}

        {/* HERO closed-today number */}
        <section className="border border-charcoal bg-charcoal text-bone p-5 md:p-7 mb-5">
          <p className="text-[11px] uppercase tracking-widest opacity-70">Closed today</p>
          <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-2">
            <p className="font-serif text-4xl md:text-6xl">
              {fmtUsd(desk.pipeline.closedTodayValueCents)}
            </p>
            <p className="text-sm opacity-80">
              {desk.closedToday.length} sale{desk.closedToday.length !== 1 ? 's' : ''} · {desk.depositPending.length} deposit
              {desk.depositPending.length !== 1 ? 's' : ''} pending ({fmtUsd(desk.pipeline.pendingValueCents)}) · {desk.slotsLocked.length} slot
              {desk.slotsLocked.length !== 1 ? 's' : ''} locked ({fmtUsd(desk.pipeline.lockedValueCents)})
            </p>
          </div>
        </section>

        {/* Pipeline sub-cards */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
          <Tile
            label="Quiz complete"
            value={`${desk.quizComplete.length}`}
            sub={`$${desk.pipeline.quizPotential.toLocaleString()} potential`}
          />
          <Tile
            label="Calls (7d)"
            value={`${bookings.length}`}
            sub={bookings.length > 0 ? 'See list below' : 'Share your Cal link'}
          />
          <Tile
            label="Waitlisted"
            value={`${desk.waitlisted.reduce((s, w) => s + w.count, 0)}`}
            sub={
              desk.waitlisted[0]
                ? `Top: ${desk.waitlisted[0].state} (${desk.waitlisted[0].count})`
                : 'None'
            }
          />
          <Tile
            label="Ranchers live"
            value={`${desk.ranchersActive}`}
            sub="Active + signed"
          />
        </section>

        {/* CAL BOOKINGS */}
        <section className="mb-8">
          <h2 className="font-serif text-xl text-charcoal mb-3">
            Cal bookings · next 7 days{' '}
            <span className="text-xs text-saddle">({bookings.length})</span>
          </h2>
          {calError && (
            <div className="border border-dust bg-bone-warm p-3 mb-2 text-xs text-saddle">
              Cal API: {calError}
            </div>
          )}
          {bookings.length === 0 ? (
            <div className="border border-divider bg-white p-5 text-sm text-saddle">
              No calls in next 7 days. Share your Cal link in upgrade emails to ranchers + buyer
              follow-ups.
            </div>
          ) : (
            <ul className="space-y-2">
              {bookings.map((b) => (
                <li
                  key={b.id || b.uid}
                  className="border border-divider bg-white p-4 flex flex-col md:flex-row md:items-center md:justify-between gap-3"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <strong className="text-charcoal text-sm">{b.attendeeName || 'Unknown'}</strong>
                      <span className="text-[10px] uppercase tracking-widest text-saddle">
                        {fmtTimeUntil(b.startTime)}
                      </span>
                    </div>
                    <div className="text-xs text-saddle truncate">
                      {b.attendeeEmail} · {b.title} ·{' '}
                      {b.startTime
                        ? new Date(b.startTime).toLocaleString(undefined, {
                            month: 'short',
                            day: 'numeric',
                            hour: 'numeric',
                            minute: '2-digit',
                          })
                        : 'TBD'}
                    </div>
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    {b.meetingUrl && (
                      <a
                        href={b.meetingUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="px-3 py-2 border border-charcoal text-charcoal text-[11px] uppercase tracking-widest hover:bg-charcoal hover:text-bone transition-base"
                      >
                        Join →
                      </a>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        openModal(b.attendeeEmail.toLowerCase(), b.attendeeName, '')
                      }
                      className="px-3 py-2 bg-charcoal text-bone text-[11px] uppercase tracking-widest hover:bg-divider transition-base"
                    >
                      Send Invoice
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* QUIZ-COMPLETE AWAITING BOOK */}
        <section className="mb-8">
          <h2 className="font-serif text-xl text-charcoal mb-3">
            Quiz complete · awaiting Cal book{' '}
            <span className="text-xs text-saddle">({desk.quizComplete.length})</span>
          </h2>
          {desk.quizComplete.length === 0 ? (
            <p className="text-saddle text-sm">No buyers waiting.</p>
          ) : (
            <ul className="space-y-1">
              {desk.quizComplete.slice(0, 25).map((b) => (
                <li
                  key={b.id}
                  className="border border-divider bg-white p-3 flex justify-between text-sm gap-3"
                >
                  <span className="text-charcoal min-w-0 flex-1 truncate">
                    <span
                      className={`inline-block w-10 text-center font-mono text-xs mr-2 px-1 py-0.5 ${
                        b.leadScore >= 70
                          ? 'bg-charcoal text-bone'
                          : b.leadScore >= 40
                            ? 'bg-bone-warm text-charcoal border border-charcoal'
                            : 'bg-bone text-saddle border border-divider'
                      }`}
                      title={b.leadReasons?.join(' · ') || ''}
                    >
                      {b.leadScore}
                    </span>
                    <strong>{b.name}</strong> · {b.state || '?'} · q{b.quizScore}/i{b.intentScore}
                    {b.leadReasons?.length ? (
                      <span className="text-xs text-saddle ml-2">[{b.leadReasons.join(' ')}]</span>
                    ) : null}
                    <EmailEngageBadge
                      opens={b.emailOpens || 0}
                      clicks={b.emailClicks || 0}
                      lastOpenedAt={b.lastOpenedAt}
                      lastClickedAt={b.lastClickedAt}
                    />
                  </span>
                  <button
                    type="button"
                    onClick={() => openModal(b.email.toLowerCase(), b.name, b.state)}
                    className="text-[11px] uppercase tracking-widest text-charcoal underline underline-offset-2 whitespace-nowrap"
                  >
                    Send Invoice
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* DEPOSITS PENDING — RANCHER ACCEPT WATCH */}
        {desk.depositPending.length > 0 && (
          <section className="mb-8">
            <h2 className="font-serif text-xl text-charcoal mb-3">
              Awaiting rancher accept ({desk.depositPending.length})
            </h2>
            <ul className="space-y-1">
              {desk.depositPending.map((r) => (
                <li
                  key={r.id}
                  className="border border-divider bg-bone-warm p-3 flex justify-between text-sm gap-3"
                >
                  <span className="text-charcoal min-w-0 flex-1 truncate">
                    <RotBadge days={r.daysSinceActivity ?? null} />
                    {r.buyerEmail} → <strong>{r.rancherName}</strong> · {r.state}
                  </span>
                  <span className="text-saddle whitespace-nowrap">{fmtUsd(r.depositAmount)}</span>
                  <AdvanceStageButton id={r.id} from="Awaiting Payment" onSuccess={tick} />
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* CLOSED TODAY CELEBRATION TAPE */}
        {desk.closedToday.length > 0 && (
          <section className="mb-8">
            <h2 className="font-serif text-xl text-charcoal mb-3">Closed today</h2>
            <ul className="space-y-1">
              {desk.closedToday.map((r) => (
                <li
                  key={r.id}
                  className="border border-sage bg-bone-warm p-3 flex justify-between text-sm"
                >
                  <span className="text-charcoal">
                    {r.buyerEmail} · <strong>{r.rancherName}</strong>
                  </span>
                  <span className="text-sage-dark font-semibold">
                    ${Number(r.saleAmount || 0).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* WAITLISTED BY STATE */}
        {desk.waitlisted.length > 0 && (
          <section className="mb-8">
            <h2 className="font-serif text-xl text-charcoal mb-3">
              Waitlist · no rancher in state
            </h2>
            <ul className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {desk.waitlisted.map((w) => (
                <li
                  key={w.state}
                  className="border border-divider bg-white p-3 text-sm text-charcoal"
                >
                  <strong>{w.state}</strong>: {w.count} {w.count === 1 ? 'buyer' : 'buyers'}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* FUNNEL · F3 */}
        {funnel && (
          <section className="mb-8">
            <h2 className="font-serif text-xl text-charcoal mb-3">
              Funnel · last 30d
            </h2>
            <div className="grid grid-cols-3 md:grid-cols-6 gap-2 mb-3">
              {(['signup', 'qualified', 'booked', 'invoiced', 'locked', 'closed'] as const).map((stage) => (
                <div key={stage} className="border border-divider bg-white p-3 text-sm">
                  <div className="text-xs uppercase tracking-wide text-saddle">{stage}</div>
                  <div className="text-2xl font-serif text-charcoal">{funnel.totals[stage]}</div>
                </div>
              ))}
            </div>
            <div className="text-xs text-saddle mb-3">
              signup→qualified {funnel.conv.signup_to_qualified}% · qualified→booked {funnel.conv.qualified_to_booked}% · booked→invoiced {funnel.conv.booked_to_invoiced}% · invoiced→locked {funnel.conv.invoiced_to_locked}% · locked→closed {funnel.conv.locked_to_closed}% · <strong>signup→closed {funnel.conv.signup_to_closed}%</strong>
            </div>
            {funnel.bySource.length > 0 && (
              <div className="border border-divider bg-white">
                <table className="w-full text-xs">
                  <thead className="bg-bone">
                    <tr>
                      <th className="text-left p-2">source</th>
                      <th className="text-right p-2">signup</th>
                      <th className="text-right p-2">qual</th>
                      <th className="text-right p-2">booked</th>
                      <th className="text-right p-2">inv</th>
                      <th className="text-right p-2">locked</th>
                      <th className="text-right p-2">closed</th>
                      <th className="text-right p-2">s→c %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {funnel.bySource.slice(0, 10).map((s) => (
                      <tr key={s.source} className="border-t border-divider">
                        <td className="p-2 font-mono">{s.source}</td>
                        <td className="text-right p-2">{s.signup}</td>
                        <td className="text-right p-2">{s.qualified}</td>
                        <td className="text-right p-2">{s.booked}</td>
                        <td className="text-right p-2">{s.invoiced}</td>
                        <td className="text-right p-2">{s.locked}</td>
                        <td className="text-right p-2">{s.closed}</td>
                        <td className="text-right p-2">{s.conv.signup_to_closed}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        <section className="border-t border-divider pt-4 text-sm text-saddle">
          {desk.ranchersActive} active ranchers
        </section>
      </div>

      <SendDepositModal
        open={modal.open}
        buyerEmail={modal.buyerEmail}
        buyerName={modal.buyerName}
        buyerState={modal.buyerState}
        onClose={() => setModal({ ...modal, open: false })}
        onSuccess={onModalSuccess}
      />
    </main>
  );
}

function Tile({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="border border-divider bg-white p-4">
      <div className="text-[11px] uppercase tracking-widest text-saddle">{label}</div>
      <div className="font-serif text-2xl text-charcoal mt-1">{value}</div>
      <div className="text-xs text-saddle mt-1">{sub}</div>
    </div>
  );
}

// F12 — Deal-rot badge. Compact age tag inline on pipeline cards.
function RotBadge({ days }: { days: number | null }) {
  if (days === null || days === undefined) return null;
  const tier =
    days >= 7
      ? 'bg-red-700 text-white'
      : days >= 3
        ? 'bg-saddle text-bone'
        : 'bg-divider text-charcoal';
  const label = days === 0 ? 'today' : days === 1 ? '1d' : `${days}d`;
  return (
    <span
      title={`Last activity ${days} day${days === 1 ? '' : 's'} ago`}
      className={`inline-block text-[10px] font-mono px-1 py-0.5 mr-2 ${tier}`}
    >
      {label}
    </span>
  );
}

// F13 — Email engagement badge. Inline next to lead score on buyer cards.
function EmailEngageBadge({
  opens,
  clicks,
  lastOpenedAt,
  lastClickedAt,
}: {
  opens: number;
  clicks: number;
  lastOpenedAt?: string;
  lastClickedAt?: string;
}) {
  if (!opens && !clicks) return null;
  function fmtAge(iso?: string) {
    if (!iso) return '';
    const ms = Date.now() - new Date(iso).getTime();
    if (isNaN(ms) || ms < 0) return '';
    const hrs = Math.floor(ms / (1000 * 60 * 60));
    if (hrs < 1) return 'just now';
    if (hrs < 24) return `${hrs}h`;
    return `${Math.floor(hrs / 24)}d`;
  }
  const title = [
    opens ? `${opens} open${opens === 1 ? '' : 's'}, last ${fmtAge(lastOpenedAt)} ago` : '',
    clicks ? `${clicks} click${clicks === 1 ? '' : 's'}, last ${fmtAge(lastClickedAt)} ago` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const hot = clicks > 0;
  return (
    <span
      title={title}
      className={`inline-block ml-2 text-[10px] font-mono px-1 ${
        hot ? 'bg-sage text-charcoal' : 'bg-bone-warm text-saddle'
      }`}
    >
      📧 {opens}o/{clicks}c
    </span>
  );
}

// F12 — Inline stage-advance button. Validated server-side.
function AdvanceStageButton({
  id,
  from,
  onSuccess,
}: {
  id: string;
  from: string;
  onSuccess: () => void;
}) {
  const [busy, setBusy] = useState(false);
  // Next-step map mirrors the server-side ALLOWED transitions.
  const NEXT: Record<string, string> = {
    'Intro Sent': 'Awaiting Payment',
    'Awaiting Payment': 'Slot Locked',
    'Slot Locked': 'Closed Won',
  };
  const target = NEXT[from];
  if (!target) return null;
  async function advance() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/referrals/${id}/stage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status: target }),
      });
      if (res.ok) onSuccess();
      else {
        const j = await res.json().catch(() => ({}));
        alert(`Advance failed: ${j.error || res.status}`);
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      type="button"
      onClick={advance}
      disabled={busy}
      title={`Advance to ${target}`}
      className="text-[10px] uppercase tracking-widest text-charcoal underline underline-offset-2 whitespace-nowrap disabled:opacity-30"
    >
      {busy ? '…' : `→ ${target.split(' ').slice(-1)}`}
    </button>
  );
}
