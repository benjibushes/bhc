'use client';

// /admin/timeline — per-buyer engagement timeline (read-only).
//
// The operator was blind to the touchpoint layer: email opens/clicks,
// inbound replies, SMS stamps, funnel transitions, and deal milestones
// lived in Airtable fields + Telegram scrollback. This page merges them
// into ONE chronological per-buyer view via /api/admin/buyer-timeline.
//
// Never false-empty: the API returns a per-source health map, so "no
// events" and "a source failed to load" render differently.

import { useState } from 'react';
import Link from 'next/link';
import Container from '../../components/Container';
import Divider from '../../components/Divider';
import AdminAuthGuard from '../../components/AdminAuthGuard';

interface TimelineEvent {
  ts: string;
  kind: string;
  summary: string;
  detail?: string;
}

interface TimelineResponse {
  buyer: { id: string; name: string; email: string; state: string; stage: string };
  events: TimelineEvent[];
  sources: Record<string, string>; // 'ok' | 'empty' | 'error: ...'
  error?: string;
}

// Calm house-palette badges per event kind.
const KIND_STYLE: Record<string, { label: string; className: string }> = {
  signup: { label: 'Signup', className: 'bg-charcoal text-bone' },
  email: { label: 'Email', className: 'bg-white border border-dust text-charcoal' },
  email_delivered: { label: 'Delivered', className: 'bg-white border border-dust text-saddle' },
  email_open: { label: 'Opened', className: 'bg-dust/60 text-charcoal' },
  email_click: { label: 'Clicked', className: 'bg-dust text-charcoal' },
  reply: { label: 'Reply', className: 'bg-charcoal/90 text-bone' },
  sms: { label: 'SMS', className: 'bg-saddle/15 text-saddle border border-saddle/30' },
  call: { label: 'Call', className: 'bg-saddle text-bone' },
  funnel: { label: 'Funnel', className: 'bg-white border border-saddle/40 text-saddle' },
  milestone: { label: 'Milestone', className: 'bg-bone border border-charcoal text-charcoal' },
};

const kindStyle = (kind: string) =>
  KIND_STYLE[kind] || { label: kind, className: 'bg-white border border-dust text-saddle' };

const SOURCE_LABELS: Record<string, string> = {
  consumer: 'Buyer record',
  emails: 'Email log',
  conversations: 'Replies & calls',
  funnel: 'Funnel events',
  referrals: 'Deal milestones',
};

function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export default function BuyerTimelinePage() {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState<TimelineResponse | null>(null);
  const [searched, setSearched] = useState(false);

  const lookup = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const q = query.trim();
    if (!q) return;
    setLoading(true);
    setError('');
    setData(null);
    setSearched(true);
    try {
      const param = q.includes('@')
        ? `email=${encodeURIComponent(q.toLowerCase())}`
        : `consumerId=${encodeURIComponent(q)}`;
      const res = await fetch(`/api/admin/buyer-timeline?${param}`);
      const json = await res.json();
      if (!res.ok) {
        setError(json?.error || `Lookup failed (${res.status})`);
      } else {
        setData(json);
      }
    } catch (err: any) {
      setError(err?.message || 'Network error');
    } finally {
      setLoading(false);
    }
  };

  // Group events by calendar day, newest day first, events within a day
  // in chronological order (the merged array arrives ascending).
  const dayGroups: { day: string; events: TimelineEvent[] }[] = [];
  if (data?.events?.length) {
    const byDay = new Map<string, TimelineEvent[]>();
    for (const ev of data.events) {
      const day = dayLabel(ev.ts);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day)!.push(ev);
    }
    for (const [day, events] of byDay) dayGroups.push({ day, events });
    dayGroups.reverse();
  }

  const failedSources = Object.entries(data?.sources || {}).filter(([, v]) => v.startsWith('error'));

  return (
    <AdminAuthGuard>
      <main className="min-h-screen py-24 bg-bone text-charcoal">
        <Container>
          <div className="space-y-8">
            {/* Header */}
            <div className="flex justify-between items-start">
              <div>
                <h1 className="font-[family-name:var(--font-serif)] text-4xl mb-2">
                  Lead Timeline
                </h1>
                <p className="text-saddle">
                  Every touchpoint for one buyer — emails, opens, replies, SMS, funnel, deal milestones.
                </p>
              </div>
              <Link
                href="/admin"
                className="px-4 py-2 border border-charcoal hover:bg-charcoal hover:text-bone transition-colors"
              >
                ← Back to Admin
              </Link>
            </div>

            {/* Search */}
            <form onSubmit={lookup} className="flex gap-2 max-w-xl">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buyer email (or consumer record id)"
                className="flex-1 px-4 py-2 border border-dust bg-white text-sm focus:outline-none focus:border-charcoal"
              />
              <button
                type="submit"
                disabled={loading || !query.trim()}
                className="px-6 py-2 bg-charcoal text-bone text-sm hover:bg-saddle transition-colors disabled:opacity-50"
              >
                {loading ? 'Loading…' : 'Look up'}
              </button>
            </form>

            <Divider />

            {/* States */}
            {loading && <p className="text-center text-saddle py-12">Assembling the timeline…</p>}

            {!loading && error && (
              <div className="p-6 border border-saddle/40 bg-white max-w-xl">
                <p className="text-saddle font-medium">Couldn&apos;t load timeline</p>
                <p className="text-sm mt-1">{error}</p>
              </div>
            )}

            {!loading && !error && !searched && (
              <p className="text-center text-saddle py-12">
                Search a buyer by email to see their full engagement history.
              </p>
            )}

            {!loading && !error && data && (
              <div className="space-y-8">
                {/* Buyer card */}
                <div className="p-6 border border-dust bg-white flex flex-wrap gap-x-10 gap-y-2 items-baseline">
                  <div>
                    <div className="text-sm text-saddle mb-1">Buyer</div>
                    <div className="text-2xl font-[family-name:var(--font-serif)]">
                      {data.buyer.name || '(no name)'}
                    </div>
                  </div>
                  <div>
                    <div className="text-sm text-saddle mb-1">Email</div>
                    <div>{data.buyer.email || '—'}</div>
                  </div>
                  <div>
                    <div className="text-sm text-saddle mb-1">State</div>
                    <div>{data.buyer.state || '—'}</div>
                  </div>
                  <div>
                    <div className="text-sm text-saddle mb-1">Stage</div>
                    <div>{data.buyer.stage || '—'}</div>
                  </div>
                </div>

                {/* Source health map — distinguishes "no events" from "source failed" */}
                <div className="flex flex-wrap gap-2">
                  {Object.entries(data.sources).map(([name, health]) => (
                    <span
                      key={name}
                      title={health.startsWith('error') ? health : undefined}
                      className={`px-3 py-1 text-xs border ${
                        health === 'ok'
                          ? 'border-dust bg-white text-charcoal'
                          : health === 'empty'
                            ? 'border-dust bg-bone text-saddle'
                            : 'border-saddle bg-saddle/10 text-saddle'
                      }`}
                    >
                      {SOURCE_LABELS[name] || name}
                      {health === 'ok' ? ' ✓' : health === 'empty' ? ' — none' : ' ⚠ failed'}
                    </span>
                  ))}
                </div>

                {failedSources.length > 0 && (
                  <div className="p-4 border border-saddle/40 bg-white text-sm text-saddle">
                    Partial timeline: {failedSources.map(([n]) => SOURCE_LABELS[n] || n).join(', ')}{' '}
                    failed to load — events from {failedSources.length > 1 ? 'those sources' : 'that source'} may be missing.
                  </div>
                )}

                {/* Timeline */}
                {dayGroups.length === 0 ? (
                  <p className="text-center text-saddle py-12">
                    {failedSources.length > 0
                      ? 'No events loaded — but some sources failed, so this buyer may not actually be silent.'
                      : 'No recorded touchpoints for this buyer yet.'}
                  </p>
                ) : (
                  <div className="space-y-8">
                    {dayGroups.map(({ day, events }) => (
                      <div key={day}>
                        <h2 className="font-[family-name:var(--font-serif)] text-xl mb-3">{day}</h2>
                        <div className="border-l-2 border-dust ml-1 pl-6 space-y-4">
                          {events.map((ev, i) => {
                            const style = kindStyle(ev.kind);
                            return (
                              <div key={`${ev.ts}-${ev.kind}-${i}`} className="relative">
                                <span className="absolute -left-[31px] top-1.5 w-2.5 h-2.5 rounded-full bg-dust border border-saddle/40" />
                                <div className="flex items-baseline gap-3 flex-wrap">
                                  <span className="text-xs text-saddle tabular-nums w-14 shrink-0">
                                    {timeLabel(ev.ts)}
                                  </span>
                                  <span className={`px-2 py-0.5 text-[11px] uppercase tracking-wide ${style.className}`}>
                                    {style.label}
                                  </span>
                                  <span className="text-sm">{ev.summary}</span>
                                </div>
                                {ev.detail && (
                                  <p className="text-xs text-saddle mt-1 ml-[68px] max-w-2xl">{ev.detail}</p>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </Container>
      </main>
    </AdminAuthGuard>
  );
}
