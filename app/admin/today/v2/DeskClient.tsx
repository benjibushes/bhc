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
}

interface DeskReferral {
  id: string;
  buyerEmail: string;
  rancherName: string;
  saleAmount: number;
  depositAmount: number;
  state: string;
  closedAt: string;
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
}

interface ModalState {
  open: boolean;
  buyerEmail: string;
  buyerName: string;
  buyerState: string;
}

export default function DeskClient() {
  const [desk, setDesk] = useState<DeskData | null>(null);
  const [bookings, setBookings] = useState<CalBooking[]>([]);
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
      const [deskRes, calRes] = await Promise.all([
        fetch('/api/admin/desk', { credentials: 'include' }),
        fetch('/api/admin/cal/bookings', { credentials: 'include' }),
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
                    <strong>{b.name}</strong> · {b.state || '?'} · quiz {b.quizScore} / intent{' '}
                    {b.intentScore}
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
                  className="border border-divider bg-bone-warm p-3 flex justify-between text-sm"
                >
                  <span className="text-charcoal">
                    {r.buyerEmail} → <strong>{r.rancherName}</strong> · {r.state}
                  </span>
                  <span className="text-saddle">{fmtUsd(r.depositAmount)}</span>
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
