'use client';

// /admin/today v2 — Ben's daily sales desk.
// Auto-refreshes every 30s. One-click deposit invoice on each Cal call row.

import { useEffect, useState } from 'react';

interface DeskCall {
  id: string;
  startTime: string;
  buyerName: string;
  buyerEmail: string;
  rancherName: string;
  state: string;
  quizScore: number | null;
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
  calls: DeskCall[];
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

export default function DeskClient() {
  const [data, setData] = useState<DeskData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch('/api/admin/desk', { credentials: 'include' });
        if (cancelled) return;
        if (!r.ok) {
          setError(`Desk endpoint ${r.status}`);
          setLoading(false);
          return;
        }
        const d = (await r.json()) as DeskData;
        if (cancelled) return;
        setData(d);
        setError('');
        setLoading(false);
      } catch (e: any) {
        if (cancelled) return;
        setError(e?.message || 'fetch failed');
        setLoading(false);
      }
    };
    tick();
    const id = setInterval(tick, 30000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (loading) {
    return <main className="min-h-screen bg-bone p-8">Loading desk…</main>;
  }
  if (error || !data) {
    return (
      <main className="min-h-screen bg-bone p-8">
        <p className="text-rust">Desk error: {error || 'no data'}</p>
        <p className="text-sm text-saddle mt-2">
          Likely admin cookie expired. <a className="underline" href="/admin/login?next=/admin/today/v2">Re-login</a>.
        </p>
      </main>
    );
  }

  const fmtUsd = (cents: number) =>
    `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

  return (
    <main className="min-h-screen bg-bone">
      <div className="max-w-6xl mx-auto p-6 md:p-8">
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
            href="https://cal.com/ben-beauchman-1itnsg/sales"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs uppercase tracking-widest text-charcoal underline underline-offset-4"
          >
            Open your Cal →
          </a>
        </header>

        {/* Pipeline cards */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
          <PipelineCard
            label="Quiz-complete"
            value={`${data.quizComplete.length}`}
            sub={`$${data.pipeline.quizPotential.toLocaleString()} potential`}
          />
          <PipelineCard
            label="Deposit pending"
            value={`${data.depositPending.length}`}
            sub={`${fmtUsd(data.pipeline.pendingValueCents)} held`}
          />
          <PipelineCard
            label="Slots locked"
            value={`${data.slotsLocked.length}`}
            sub={`${fmtUsd(data.pipeline.lockedValueCents)} in flight`}
          />
          <PipelineCard
            label="Closed today"
            value={fmtUsd(data.pipeline.closedTodayValueCents)}
            sub={`${data.closedToday.length} sales`}
          />
        </section>

        {/* Calls today */}
        <section className="mb-8">
          <h2 className="font-serif text-xl text-charcoal mb-3">
            Calls today ({data.calls.length})
          </h2>
          {data.calls.length === 0 ? (
            <div className="border border-divider bg-white p-5 text-sm text-saddle">
              No calls scheduled. Buyers w/ Cal-invite-fired but not booked will surface in
              the quiz-complete list below. Share your link:{' '}
              <a
                href="https://cal.com/ben-beauchman-1itnsg/sales"
                target="_blank"
                rel="noopener noreferrer"
                className="text-charcoal underline"
              >
                cal.com/ben-beauchman-1itnsg/sales
              </a>
            </div>
          ) : (
            <ul className="space-y-2">
              {data.calls.map((c) => (
                <li
                  key={c.id}
                  className="border border-divider bg-white p-4 flex flex-col md:flex-row md:items-center md:justify-between gap-3"
                >
                  <div>
                    <div className="font-medium text-charcoal">
                      {c.buyerName} · {c.state || '?'} · score {c.quizScore ?? '?'}
                    </div>
                    <div className="text-sm text-saddle">
                      {c.startTime
                        ? new Date(c.startTime).toLocaleString(undefined, {
                            hour: 'numeric',
                            minute: '2-digit',
                          })
                        : 'TBD'}{' '}
                      · {c.buyerEmail}
                    </div>
                  </div>
                  <SendDepositButton
                    buyerEmail={c.buyerEmail}
                    buyerName={c.buyerName}
                    state={c.state}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Quiz-complete awaiting outreach */}
        <section className="mb-8">
          <h2 className="font-serif text-xl text-charcoal mb-3">
            Quiz-complete awaiting Cal book ({data.quizComplete.length})
          </h2>
          {data.quizComplete.length === 0 ? (
            <p className="text-saddle text-sm">No buyers waiting.</p>
          ) : (
            <ul className="space-y-1">
              {data.quizComplete.slice(0, 25).map((b) => (
                <li
                  key={b.id}
                  className="border border-divider bg-white p-3 flex justify-between text-sm"
                >
                  <span className="text-charcoal">
                    <strong>{b.name}</strong> · {b.state || '?'} · quiz {b.quizScore} / intent {b.intentScore}
                  </span>
                  <span className="text-saddle">
                    {b.qualifiedAt ? new Date(b.qualifiedAt).toLocaleDateString() : '?'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Waitlisted by state */}
        {data.waitlisted.length > 0 && (
          <section className="mb-8">
            <h2 className="font-serif text-xl text-charcoal mb-3">
              On the waitlist — no rancher in state
            </h2>
            <ul className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {data.waitlisted.map((w) => (
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

        {/* Rancher pulse */}
        <section className="border-t border-divider pt-4 text-sm text-saddle">
          {data.ranchersActive} active ranchers
        </section>
      </div>
    </main>
  );
}

function PipelineCard({
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

function SendDepositButton({
  buyerEmail,
  buyerName,
  state,
}: {
  buyerEmail: string;
  buyerName: string;
  state: string;
}) {
  const [status, setStatus] = useState<'idle' | 'opening' | 'done'>('idle');
  const handle = () => {
    setStatus('opening');
    // MVP: open a new tab to the existing admin deposit-invoice tool.
    // Full inline modal lands in Phase 1.5 — for now we use a query-pre-filled
    // jump to the same endpoint Ben uses today.
    const url = `/admin/send-deposit?buyer=${encodeURIComponent(buyerEmail)}&state=${encodeURIComponent(state)}`;
    window.open(url, '_blank', 'noopener');
    setStatus('done');
  };
  return (
    <button
      type="button"
      onClick={handle}
      disabled={status === 'opening'}
      className="px-4 py-2 bg-charcoal text-bone text-[11px] uppercase tracking-widest hover:bg-divider transition-base disabled:opacity-50"
    >
      {status === 'done' ? 'Opened ↗' : 'Send Deposit Invoice'}
    </button>
  );
}
