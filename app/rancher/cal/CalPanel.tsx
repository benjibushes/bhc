'use client';

// Rancher dashboard Cal panel. Renders:
//   - Connection status badge (Connected / Expired / Disconnected / Error)
//   - Cal username (when connected)
//   - Upcoming bookings list (last 10, pulled from Cal API)
//   - Disconnect button (with confirm) → POST /api/rancher/cal/disconnect
//   - Connect / Re-authorize CTA → GET /api/auth/cal/start (302 to Cal)
//
// State refreshes on mount + every 60s while panel is visible. Disconnect
// optimistic-clears local state, server re-confirms.
//
// Surfaces below — Atoms-based components (AvailabilitySettings, etc) can
// be slotted in by importing them lazily inside CalAtomsProvider when the
// rancher is connected.

import { useEffect, useState, useCallback } from 'react';

type Status =
  | { state: 'connected'; expiresAt: string | null; username: string | null; calUserId: number | null }
  | { state: 'expired'; expiresAt: string | null }
  | { state: 'disconnected' }
  | { state: 'error'; reason: string }
  | { state: 'loading' };

interface Booking {
  id: number | string;
  title?: string;
  startTime?: string;
  endTime?: string;
  attendees?: Array<{ name?: string; email?: string }>;
  status?: string;
  meetingUrl?: string;
}

export default function CalPanel() {
  const [status, setStatus] = useState<Status>({ state: 'loading' });
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [bookingsLoading, setBookingsLoading] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [settingUp, setSettingUp] = useState(false);
  const [error, setError] = useState('');

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/rancher/cal/status', { cache: 'no-store' });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      setStatus(data);
    } catch (e: any) {
      setStatus({ state: 'error', reason: e?.message || 'fetch failed' });
    }
  }, []);

  const fetchBookings = useCallback(async () => {
    setBookingsLoading(true);
    try {
      const res = await fetch('/api/rancher/cal/bookings?status=upcoming&take=10', {
        cache: 'no-store',
      });
      if (res.ok) {
        const data = await res.json();
        setBookings(Array.isArray(data.bookings) ? data.bookings : []);
      }
    } catch {
      /* non-fatal — show 0 bookings */
    } finally {
      setBookingsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, 60_000);
    return () => clearInterval(id);
  }, [fetchStatus]);

  useEffect(() => {
    if (status.state === 'connected') fetchBookings();
  }, [status.state, fetchBookings]);

  async function handleDisconnect() {
    if (!confirm('Disconnect Cal? Buyers will no longer be able to self-book through BHC until you reconnect.')) {
      return;
    }
    setDisconnecting(true);
    setError('');
    try {
      const res = await fetch('/api/rancher/cal/disconnect', { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `disconnect ${res.status}`);
      }
      setStatus({ state: 'disconnected' });
      setBookings([]);
    } catch (e: any) {
      setError(e?.message || 'Could not disconnect');
    } finally {
      setDisconnecting(false);
    }
  }

  async function handleSetupEventTypes() {
    setSettingUp(true);
    setError('');
    try {
      const res = await fetch('/api/rancher/cal/setup-event-types', { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 207) {
        throw new Error(body.error || `setup ${res.status}`);
      }
      if (body.errors?.length) {
        setError(`Partial: ${body.errors.join(', ')}`);
      }
      fetchStatus();
    } catch (e: any) {
      setError(e?.message || 'Setup failed');
    } finally {
      setSettingUp(false);
    }
  }

  return (
    <section className="border border-dust bg-bone p-6 space-y-4">
      <header className="flex items-center justify-between">
        <h3 className="font-serif text-xl text-charcoal">Cal.com booking</h3>
        <StatusBadge status={status} />
      </header>

      {status.state === 'loading' && (
        <p className="text-sm text-saddle">Checking connection…</p>
      )}

      {status.state === 'disconnected' && (
        <div className="space-y-3">
          <p className="text-sm text-saddle">
            Connect your Cal account so buyers can self-book intro calls without leaving BuyHalfCow. Takes 30 sec.
          </p>
          <a
            href="/api/auth/cal/start"
            className="inline-block px-5 py-2.5 bg-charcoal text-bone text-xs font-medium tracking-widest uppercase hover:bg-divider"
          >
            Connect Cal →
          </a>
        </div>
      )}

      {status.state === 'expired' && (
        <div className="space-y-3">
          <p className="text-sm text-saddle">
            Your Cal connection expired{status.expiresAt ? ` on ${new Date(status.expiresAt).toLocaleDateString()}` : ''}. Re-authorize to keep buyer self-booking active.
          </p>
          <a
            href="/api/auth/cal/start"
            className="inline-block px-5 py-2.5 bg-charcoal text-bone text-xs font-medium tracking-widest uppercase hover:bg-divider"
          >
            Re-authorize Cal →
          </a>
        </div>
      )}

      {status.state === 'error' && (
        <div className="space-y-3">
          <p className="text-sm text-rust">Connection error: {status.reason}</p>
          <a
            href="/api/auth/cal/start"
            className="inline-block px-5 py-2.5 bg-charcoal text-bone text-xs font-medium tracking-widest uppercase hover:bg-divider"
          >
            Reconnect Cal →
          </a>
        </div>
      )}

      {status.state === 'connected' && (
        <div className="space-y-4">
          {status.username && (
            <p className="text-sm text-saddle">
              Connected as <strong className="text-charcoal">@{status.username}</strong>
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleSetupEventTypes}
              disabled={settingUp}
              className="px-4 py-2 text-xs uppercase tracking-widest border border-charcoal text-charcoal hover:bg-charcoal hover:text-bone disabled:opacity-50"
            >
              {settingUp ? 'Setting up…' : 'Sync event types + webhook'}
            </button>
            <button
              type="button"
              onClick={handleDisconnect}
              disabled={disconnecting}
              className="px-4 py-2 text-xs uppercase tracking-widest border border-rust text-rust hover:bg-rust hover:text-bone disabled:opacity-50"
            >
              {disconnecting ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </div>

          <div>
            <p className="text-xs uppercase tracking-widest text-saddle mb-2">
              Upcoming bookings {bookingsLoading ? '(loading…)' : `(${bookings.length})`}
            </p>
            {bookings.length === 0 ? (
              <p className="text-sm text-saddle italic">
                No upcoming bookings yet. Share your public BHC page — buyers can self-book intros once we've routed them your way.
              </p>
            ) : (
              <ul className="space-y-2">
                {bookings.map((b) => (
                  <li
                    key={String(b.id)}
                    className="border border-dust p-3 text-sm text-charcoal"
                  >
                    <div className="flex justify-between items-start gap-2">
                      <div>
                        <p className="font-semibold">{b.title || 'Buyer call'}</p>
                        <p className="text-xs text-saddle">
                          {b.startTime
                            ? new Date(b.startTime).toLocaleString('en-US', {
                                weekday: 'short',
                                month: 'short',
                                day: 'numeric',
                                hour: 'numeric',
                                minute: '2-digit',
                                timeZone: 'America/Denver',
                              })
                            : 'TBD'}{' '}
                          MT
                        </p>
                        {b.attendees?.[0] && (
                          <p className="text-xs text-saddle">
                            With: {b.attendees[0].name || b.attendees[0].email}
                          </p>
                        )}
                      </div>
                      {b.meetingUrl && (
                        <a
                          href={b.meetingUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs underline underline-offset-2 text-charcoal hover:text-saddle whitespace-nowrap"
                        >
                          Join →
                        </a>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {error && (
        <p className="text-xs text-rust border border-rust bg-rust/5 p-2">{error}</p>
      )}
    </section>
  );
}

function StatusBadge({ status }: { status: Status }) {
  const map = {
    loading: { label: 'Checking', cls: 'bg-bone-warm text-saddle border-saddle' },
    connected: { label: 'Connected', cls: 'bg-sage text-bone border-sage' },
    expired: { label: 'Expired', cls: 'bg-rust/10 text-rust border-rust' },
    disconnected: { label: 'Not connected', cls: 'bg-bone-warm text-saddle border-dust' },
    error: { label: 'Error', cls: 'bg-rust text-bone border-rust' },
  } as const;
  const m = map[status.state];
  return (
    <span className={`inline-block px-2 py-1 text-[10px] uppercase tracking-widest font-bold border ${m.cls}`}>
      {m.label}
    </span>
  );
}
