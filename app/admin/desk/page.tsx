'use client';

import { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import AdminAuthGuard from '../../components/AdminAuthGuard';

// Shape of a referral as returned by GET /api/referrals (subset we use here).
interface Referral {
  id: string;
  status: string;
  buyer_name: string;
  buyer_email: string;
  buyer_state: string;
  order_type: string;
  budget_range: string;
  intent_score: number;
  rancher_id: string;
  suggested_rancher_name: string;
  suggested_rancher_state: string;
  sale_amount: number;
  commission_due: number;
  created_at: string;
  intro_sent_at: string;
  closed_at: string;
  chase_count: number;
  last_chased_at: string;
  warmup_engaged_at: string;
}

// Urgency buckets, most-urgent first. Order here drives the sort.
type Bucket =
  | 'unmatched'
  | 'pending'
  | 'stalled'
  | 'awaiting'
  | 'active'
  | 'closed';

const BUCKET_ORDER: Record<Bucket, number> = {
  unmatched: 0,
  pending: 1,
  stalled: 2,
  awaiting: 3,
  active: 4,
  closed: 5,
};

// Statuses that count as "active" working deals (not closed, intro is out).
const ACTIVE_STATUSES = ['Intro Sent', 'Rancher Contacted', 'Negotiation'];
const STALL_DAYS = 5;

// ---- helpers --------------------------------------------------------------

function daysSince(iso: string): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

function money(n: number): string {
  if (!n) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(Math.round(n));
}

function fmtDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function isClosed(status: string): boolean {
  return status === 'Closed Won' || status === 'Closed Lost';
}

// Classify a referral into its urgency bucket.
function bucketOf(r: Referral): Bucket {
  if (isClosed(r.status)) return 'closed';
  if (!r.rancher_id) return 'unmatched';
  if (r.status === 'Pending Approval') return 'pending';
  if (r.status === 'Awaiting Payment') return 'awaiting';
  if (ACTIVE_STATUSES.includes(r.status)) {
    const d = daysSince(r.last_chased_at || r.intro_sent_at);
    if (d != null && d >= STALL_DAYS) return 'stalled';
    return 'active';
  }
  // Anything else open (unknown status, still has a rancher) lands in active.
  return 'active';
}

// Per-bucket visual + copy. accent = left border colour on the card.
const BUCKET_META: Record<
  Bucket,
  { label: string; accent: string; pill: string }
> = {
  unmatched: {
    label: 'Route to a rancher',
    accent: 'border-l-rust',
    pill: 'border-rust text-rust',
  },
  pending: {
    label: 'Approve + send intro',
    accent: 'border-l-blue-600',
    pill: 'border-blue-600 text-blue-700',
  },
  stalled: {
    label: 'Nudge or reroute',
    accent: 'border-l-amber-500',
    pill: 'border-amber-600 text-amber-700',
  },
  awaiting: {
    label: 'Collect balance',
    accent: 'border-l-sage-dark',
    pill: 'border-sage-dark text-sage-dark',
  },
  active: {
    label: 'In progress',
    accent: 'border-l-dust',
    pill: 'border-dust text-saddle',
  },
  closed: {
    label: 'Closed',
    accent: 'border-l-dust',
    pill: 'border-dust text-dust',
  },
};

// The next-action hint shown on each card (includes days-stalled when relevant).
function nextActionHint(r: Referral, b: Bucket): string {
  switch (b) {
    case 'unmatched':
      return 'Route to a rancher';
    case 'pending':
      return 'Approve + send intro';
    case 'stalled': {
      const d = daysSince(r.last_chased_at || r.intro_sent_at);
      return `No activity ${d ?? '?'}d — nudge or reroute`;
    }
    case 'awaiting':
      return 'Collect balance';
    case 'active':
      return 'Intro out — awaiting movement';
    case 'closed':
      return r.status === 'Closed Won' ? 'Won' : 'Lost';
  }
}

// Attention chips: which bucket each one filters to.
const CHIPS: { key: Bucket; label: string }[] = [
  { key: 'unmatched', label: 'Unmatched' },
  { key: 'pending', label: 'Pending approval' },
  { key: 'stalled', label: 'Stalled' },
  { key: 'awaiting', label: 'Awaiting payment' },
];

// ---- page -----------------------------------------------------------------

export default function SalesDeskQueuePage() {
  const [referrals, setReferrals] = useState<Referral[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState<Bucket | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await fetch('/api/referrals');
        if (!res.ok) {
          setErr(`Failed to load deals (${res.status})`);
        } else {
          const data = await res.json();
          setReferrals(Array.isArray(data) ? data : []);
        }
      } catch {
        setErr('Could not load the desk.');
      }
      setLoading(false);
    })();
  }, []);

  // Attach bucket once, reuse everywhere.
  const withBucket = useMemo(
    () => referrals.map((r) => ({ r, b: bucketOf(r) })),
    [referrals]
  );

  // Counts for the attention chips.
  const counts = useMemo(() => {
    const c: Record<Bucket, number> = {
      unmatched: 0,
      pending: 0,
      stalled: 0,
      awaiting: 0,
      active: 0,
      closed: 0,
    };
    for (const { b } of withBucket) c[b] += 1;
    return c;
  }, [withBucket]);

  const openCount = useMemo(
    () => withBucket.filter(({ b }) => b !== 'closed').length,
    [withBucket]
  );

  // Apply chip filter + text search, then sort by bucket priority, intent desc.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return withBucket
      .filter(({ b }) => (filter ? b === filter : true))
      .filter(({ r }) => {
        if (!q) return true;
        return (
          r.buyer_name.toLowerCase().includes(q) ||
          r.buyer_email.toLowerCase().includes(q) ||
          r.buyer_state.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        const ord = BUCKET_ORDER[a.b] - BUCKET_ORDER[b.b];
        if (ord !== 0) return ord;
        return (b.r.intent_score || 0) - (a.r.intent_score || 0);
      });
  }, [withBucket, filter, query]);

  return (
    <AdminAuthGuard>
      <main className="min-h-screen bg-bone text-charcoal pb-24">
        <div className="max-w-2xl mx-auto px-4 py-6">
          {/* Back link to match the cockpit's nav */}
          <Link
            href="/admin"
            className="text-sm text-saddle hover:text-charcoal"
          >
            ← Admin
          </Link>

          {/* Header */}
          <div className="mt-3">
            <h1 className="font-[family-name:var(--font-serif)] text-3xl">
              Sales desk
            </h1>
            <p className="text-sm text-saddle mt-1">
              {loading
                ? 'Loading the queue…'
                : `${openCount} open deal${openCount === 1 ? '' : 's'} — most urgent first.`}
            </p>
          </div>

          {/* Attention chips */}
          {!loading && !err && (
            <div className="mt-4 flex flex-wrap gap-2">
              {CHIPS.map((chip) => {
                const n = counts[chip.key];
                const on = filter === chip.key;
                return (
                  <button
                    key={chip.key}
                    onClick={() => setFilter(on ? null : chip.key)}
                    className={`px-3 py-1.5 text-xs border transition-colors ${
                      on
                        ? 'bg-charcoal text-bone border-charcoal'
                        : 'bg-white border-dust text-charcoal hover:border-charcoal'
                    }`}
                  >
                    {chip.label}
                    <span
                      className={`ml-1.5 font-medium ${
                        on ? 'text-bone' : n > 0 ? 'text-rust' : 'text-dust'
                      }`}
                    >
                      {n}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Search */}
          {!loading && !err && (
            <div className="mt-3">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search buyer name, email, or state…"
                className="w-full px-3 py-2 text-sm border border-dust bg-white focus:border-charcoal focus:outline-none"
              />
            </div>
          )}

          {/* Active-filter indicator */}
          {!loading && !err && filter && (
            <div className="mt-3 flex items-center gap-2 text-xs text-saddle">
              <span>
                Showing{' '}
                <strong className="text-charcoal">
                  {CHIPS.find((c) => c.key === filter)?.label}
                </strong>
              </span>
              <button
                onClick={() => setFilter(null)}
                className="underline hover:text-charcoal"
              >
                clear
              </button>
            </div>
          )}

          {/* States */}
          {loading && (
            <p className="text-center text-saddle py-16">Loading deals…</p>
          )}
          {err && !loading && (
            <p className="text-center text-rust py-16">{err}</p>
          )}
          {!loading && !err && visible.length === 0 && (
            <div className="mt-6 p-8 border border-dust bg-white text-center text-saddle text-sm">
              {referrals.length === 0
                ? 'No deals on the desk yet.'
                : 'No deals match this view.'}
            </div>
          )}

          {/* Card list */}
          {!loading && !err && visible.length > 0 && (
            <div className="mt-4 space-y-3">
              {visible.map(({ r, b }) => {
                const meta = BUCKET_META[b];
                const closed = b === 'closed';
                return (
                  <Link
                    key={r.id}
                    href={`/admin/desk/${r.id}`}
                    className={`block border border-dust border-l-4 ${meta.accent} bg-white p-4 hover:border-charcoal transition-colors ${
                      closed ? 'opacity-60' : ''
                    }`}
                  >
                    {/* Top row: buyer identity + status pill */}
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-medium truncate">
                          {r.buyer_name || 'Unnamed buyer'}
                        </div>
                        <div className="text-xs text-saddle mt-0.5">
                          {r.buyer_state || '—'}
                          {r.order_type ? ` · ${r.order_type}` : ''}
                          {` · intent ${Math.round(r.intent_score || 0)}`}
                        </div>
                      </div>
                      <span
                        className={`shrink-0 text-[11px] px-2 py-0.5 border bg-white ${meta.pill}`}
                      >
                        {r.status}
                      </span>
                    </div>

                    {/* Rancher line */}
                    <div className="mt-2 text-sm">
                      {r.rancher_id || r.suggested_rancher_name ? (
                        <span className="text-charcoal">
                          {r.suggested_rancher_name || 'Matched rancher'}
                          {r.suggested_rancher_state && (
                            <span className="text-dust">
                              {' '}
                              ({r.suggested_rancher_state})
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="text-rust font-medium">Unmatched</span>
                      )}
                    </div>

                    {/* Next-action hint */}
                    <div className="mt-2 text-xs text-saddle">
                      {nextActionHint(r, b)}
                    </div>

                    {/* Money (closed deals) */}
                    {closed && (!!r.sale_amount || !!r.commission_due) && (
                      <div className="mt-2 flex gap-4 text-xs">
                        {!!r.sale_amount && (
                          <span>
                            <span className="text-saddle">Sale </span>
                            <span className="font-medium">
                              {money(r.sale_amount)}
                            </span>
                          </span>
                        )}
                        {!!r.commission_due && (
                          <span>
                            <span className="text-saddle">Commission </span>
                            <span className="font-medium">
                              {money(r.commission_due)}
                            </span>
                          </span>
                        )}
                      </div>
                    )}

                    {/* Footer: created date + open affordance */}
                    <div className="mt-3 flex items-center justify-between">
                      <span className="text-[11px] text-dust">
                        Created {fmtDate(r.created_at)}
                      </span>
                      <span className="text-xs text-saddle">Open deal →</span>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      </main>
    </AdminAuthGuard>
  );
}
