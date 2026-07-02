'use client';

// /admin/ranchers — THE rancher work-surface.
//
// Before this page existed, per-rancher actions were scattered across 4
// surfaces (main-dashboard dropdowns, /admin/migration, the orphaned
// /admin/today v1 drawer, and the [id] hub which had NO action buttons),
// the admin was blind to tier_v2/Connect state in lists, and /admin/ranchers
// itself 404'd despite being linked. This page is the single list: every
// rancher, their true pipeline stage (INCLUDING the call stages the old
// chips flattened), whether they can actually collect money, and the gated
// one-click Go Live that rides the slice-B rail (lib/goLiveRancher via
// POST /api/admin/ranchers/[id]/go-live).
//
// Stage derivation (first match wins, furthest-along first):
//   Live         — Onboarding Status = 'Live'
//   READY        — verification cleared (Onboarding Status = 'Verification
//                  Complete', or signed + Verification Status = 'Verified')
//                  AND isReadyToGoLive() — i.e. the server rail would accept
//                  the click (signed + Connect-ok-or-legacy + no pending
//                  verification). Shared predicate from lib/goLiveGates.
//   Verification — Onboarding Status = 'Verification Pending'/'Complete'
//                  (Complete lands here when the go-live gates still block —
//                  e.g. tier_v2 with Connect stuck at 'onboarding').
//   Signed       — Agreement Signed ✓ (or Onboarding Status says so)
//   Call Done    — Call Completed At stamped, or Onboarding Status =
//                  'Call Complete' / 'Docs Sent' (docs go out after the call)
//   Call Booked  — Call Scheduled ✓ or Onboarding Status = 'Call Scheduled'
//   Prospect     — Verification Status = 'Prospect' (prospector-created row,
//                  no real application behind it yet)
//   Applied      — everything else (they're in the table = they applied)

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { toast } from '@/lib/toast';
import { isReadyToGoLive, goLiveBlockersView } from '@/lib/goLiveGates';

interface RancherRow {
  id: string;
  ranch_name: string;
  operator_name: string;
  email: string;
  state: string;
  status: string;
  onboarding_status: string;
  active_status: string;
  verification_status: string;
  agreement_signed: boolean;
  call_scheduled: boolean;
  call_completed_at: string;
  pricing_model: string;
  stripe_connect_status: string;
  page_live: boolean;
  slug: string;
  current_active_referrals?: number;
  max_active_referrals?: number;
}

const STAGES = [
  'Prospect',
  'Applied',
  'Call Booked',
  'Call Done',
  'Signed',
  'Verification',
  'READY',
  'Live',
] as const;
type Stage = (typeof STAGES)[number];

const STAGE_HINTS: Record<Stage, string> = {
  'Prospect': 'Prospector-created row — no application yet',
  'Applied': 'Applied, no call booked yet',
  'Call Booked': 'Onboarding call scheduled',
  'Call Done': 'Call complete / docs sent, awaiting signature',
  'Signed': 'Agreement signed, needs verification',
  'Verification': 'Verification in flight (or gates still blocking)',
  'READY': 'All go-live gates pass — one click from Live',
  'Live': 'Active on platform',
};

function rancherStage(r: RancherRow): Stage {
  const s = r.onboarding_status || '';
  if (s === 'Live') return 'Live';
  const verificationCleared =
    s === 'Verification Complete' ||
    (!!r.agreement_signed && r.verification_status === 'Verified');
  if (verificationCleared && isReadyToGoLive(r)) return 'READY';
  if (s === 'Verification Pending' || s === 'Verification Complete') return 'Verification';
  if (r.agreement_signed || s === 'Agreement Signed') return 'Signed';
  if (r.call_completed_at || s === 'Call Complete' || s === 'Docs Sent') return 'Call Done';
  if (r.call_scheduled || s === 'Call Scheduled') return 'Call Booked';
  if (r.verification_status === 'Prospect') return 'Prospect';
  return 'Applied';
}

// tier_v2 collects deposits through Stripe Connect — anything other than
// 'active' means buyers 409 at checkout. Legacy is exempt (off-platform).
function cantCollect(r: RancherRow): boolean {
  return (
    String(r.pricing_model || '').toLowerCase() === 'tier_v2' &&
    String(r.stripe_connect_status || '').toLowerCase() !== 'active'
  );
}

const STAGE_BADGE: Record<Stage, string> = {
  'Prospect': 'bg-bone-deep text-saddle border-dust',
  'Applied': 'bg-bone-deep text-saddle border-dust',
  'Call Booked': 'bg-amber/15 text-amber-dark border-amber/60',
  'Call Done': 'bg-amber/15 text-amber-dark border-amber/60',
  'Signed': 'bg-dust/25 text-saddle border-dust',
  'Verification': 'bg-saddle/15 text-saddle border-saddle/40',
  'READY': 'bg-sage/15 text-sage-dark border-sage/40',
  'Live': 'bg-sage/15 text-sage-dark border-sage/40',
};

// Work order: actionable first (READY on top), then the pipeline walking
// backwards, Live parked at the bottom (they need attention least).
const SORT_ORDER: Stage[] = [
  'READY',
  'Verification',
  'Signed',
  'Call Done',
  'Call Booked',
  'Applied',
  'Prospect',
  'Live',
];

export default function AdminRanchersPage() {
  const [ranchers, setRanchers] = useState<RancherRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stageFilter, setStageFilter] = useState<Stage | ''>('');
  const [readyOnly, setReadyOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/ranchers');
      const payload = await res.json();
      if (!res.ok) {
        setError(payload?.error || `Failed (HTTP ${res.status})`);
        return;
      }
      setRanchers(Array.isArray(payload) ? payload : []);
    } catch (e: any) {
      setError(e?.message || 'Network error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  // Inline Go Live — rides the ONE rail (slice B). Server re-checks the same
  // gates, so this button is an offer, not an authority.
  const handleGoLive = async (r: RancherRow) => {
    const name = r.ranch_name || r.operator_name || r.id;
    if (
      !window.confirm(
        `Go live: publish "${name}" and email every waiting buyer in their state. This cannot be undone. Continue?`,
      )
    )
      return;
    setRowBusy(r.id);
    try {
      const res = await fetch(`/api/admin/ranchers/${r.id}/go-live`, { method: 'POST' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || payload?.error) {
        toast.error('Go-Live failed', payload?.error || `HTTP ${res.status}`);
      } else {
        toast.success(
          `${name} is live`,
          payload?.matched ? `Auto-matched ${payload.matched} waiting buyers` : undefined,
        );
        await load();
      }
    } catch (e: any) {
      toast.error('Go-Live failed', e?.message);
    } finally {
      setRowBusy(null);
    }
  };

  const stageOf = useMemo(() => {
    const m = new Map<string, Stage>();
    for (const r of ranchers) m.set(r.id, rancherStage(r));
    return m;
  }, [ranchers]);

  const readyCount = useMemo(
    () => ranchers.filter((r) => stageOf.get(r.id) !== 'Live' && isReadyToGoLive(r)).length,
    [ranchers, stageOf],
  );

  const q = search.toLowerCase().trim();
  const visible = ranchers
    .filter((r) => {
      if (stageFilter && stageOf.get(r.id) !== stageFilter) return false;
      if (readyOnly && (stageOf.get(r.id) === 'Live' || !isReadyToGoLive(r))) return false;
      if (q) {
        const hay = `${r.ranch_name} ${r.operator_name} ${r.email} ${r.state}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const d =
        SORT_ORDER.indexOf(stageOf.get(a.id) || 'Applied') -
        SORT_ORDER.indexOf(stageOf.get(b.id) || 'Applied');
      if (d !== 0) return d;
      return (a.ranch_name || a.operator_name || '').localeCompare(
        b.ranch_name || b.operator_name || '',
      );
    });

  if (loading) {
    return (
      <div className="p-8">
        <p className="text-sm text-saddle">Loading ranchers…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8 max-w-xl">
        <div className="p-4 border border-rust bg-bone text-rust-dark">
          <p className="font-medium">Failed to load ranchers</p>
          <p className="text-sm mt-1">{error}</p>
          <button
            onClick={load}
            className="mt-3 px-3 py-1.5 text-sm bg-rust-dark text-bone hover:bg-rust"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-10 space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-[family-name:var(--font-serif)] text-3xl md:text-4xl lowercase">
            ranchers
          </h1>
          <p className="text-sm text-saddle mt-1">
            every rancher, their true pipeline stage, and the gated Go-Live rail. Click a row for
            the full hub (page editor + actions).
          </p>
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search ranch, operator, email, state…"
          className="px-3 py-2 border border-dust text-sm bg-white w-72 max-w-full"
        />
      </header>

      {/* Pipeline stage chips — includes the call stages the old chips flattened */}
      <div className="flex gap-1 overflow-x-auto pb-1">
        <button
          onClick={() => {
            setStageFilter('');
            setReadyOnly(false);
          }}
          className={`px-3 py-1.5 text-xs font-medium whitespace-nowrap border transition-colors ${
            !stageFilter && !readyOnly
              ? 'bg-charcoal text-bone border-charcoal'
              : 'border-dust hover:bg-dust'
          }`}
        >
          All ({ranchers.length})
        </button>
        {STAGES.map((stage) => {
          const count = ranchers.filter((r) => stageOf.get(r.id) === stage).length;
          return (
            <button
              key={stage}
              onClick={() => {
                setStageFilter(stage);
                setReadyOnly(false);
              }}
              title={STAGE_HINTS[stage]}
              className={`px-3 py-1.5 text-xs font-medium whitespace-nowrap border transition-colors ${
                stageFilter === stage
                  ? 'bg-charcoal text-bone border-charcoal'
                  : 'border-dust hover:bg-dust'
              }`}
            >
              {stage} ({count})
            </button>
          );
        })}
        {/* Ready-to-go-live filter — the shared isReadyToGoLive predicate,
            regardless of which stage band the rancher technically sits in. */}
        <button
          onClick={() => {
            setReadyOnly(true);
            setStageFilter('');
          }}
          title="Every non-Live rancher the go-live rail would accept right now (lib/goLiveGates)"
          className={`px-3 py-1.5 text-xs font-semibold whitespace-nowrap border transition-colors ${
            readyOnly
              ? 'bg-sage-dark text-white border-sage-dark'
              : 'border-sage text-sage-dark hover:bg-sage/10'
          }`}
        >
          ⚡ Ready to go live ({readyCount})
        </button>
      </div>

      {/* The list */}
      {visible.length === 0 ? (
        <p className="text-sm text-dust italic border border-dust bg-white px-4 py-6">
          No ranchers match.
        </p>
      ) : (
        <ul className="border border-dust bg-white divide-y divide-bone-deep">
          {visible.map((r) => {
            const stage = stageOf.get(r.id) || 'Applied';
            const name = r.ranch_name || r.operator_name || '(unnamed)';
            const blockers = goLiveBlockersView(r);
            const offersGoLive = stage !== 'Live' && isReadyToGoLive(r);
            return (
              <li
                key={r.id}
                className="p-3 flex flex-wrap items-center justify-between gap-3 hover:bg-bone transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Link
                      href={`/admin/ranchers/${r.id}`}
                      className="font-medium text-charcoal hover:underline truncate"
                    >
                      {name}
                    </Link>
                    <span
                      title={STAGE_HINTS[stage]}
                      className={`px-2 py-0.5 text-xs border ${STAGE_BADGE[stage]}`}
                    >
                      {stage}
                    </span>
                    {cantCollect(r) && (
                      <span
                        title={`tier_v2 but Stripe Connect is "${r.stripe_connect_status || 'unset'}" — buyer deposits 409 until it's active. Use Resync Connect in the rancher hub.`}
                        className="px-2 py-0.5 text-xs font-semibold border border-rust bg-rust/10 text-rust-dark"
                      >
                        ⛔ can&apos;t collect
                      </span>
                    )}
                    {stage === 'Live' && r.active_status === 'Paused' && (
                      <span className="px-2 py-0.5 text-xs border border-amber-dark text-amber-dark">
                        paused
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-saddle truncate mt-0.5">
                    {r.operator_name}
                    {r.state ? ` · ${r.state}` : ''}
                    {r.pricing_model ? ` · ${r.pricing_model}` : ''}
                    {r.stripe_connect_status ? ` · Connect: ${r.stripe_connect_status}` : ''}
                    {typeof r.current_active_referrals === 'number' && r.max_active_referrals
                      ? ` · ${r.current_active_referrals}/${r.max_active_referrals} active`
                      : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {offersGoLive && (
                    <button
                      onClick={() => handleGoLive(r)}
                      disabled={rowBusy === r.id}
                      className="px-3 py-1 bg-sage-dark text-white uppercase text-xs tracking-wider hover:opacity-90 disabled:opacity-50"
                    >
                      {rowBusy === r.id ? '…' : 'Go Live'}
                    </button>
                  )}
                  {!offersGoLive && stage !== 'Live' && blockers.length > 0 && (
                    <span
                      title={`Not ready to go live: ${blockers.join('; ')}`}
                      className="px-2 py-1 text-xs border border-amber-dark text-amber-dark cursor-default max-w-[220px] truncate"
                    >
                      blocked: {blockers.join('; ')}
                    </span>
                  )}
                  <Link
                    href={`/admin/ranchers/${r.id}`}
                    className="px-3 py-1 text-xs border border-dust text-saddle hover:border-charcoal hover:text-charcoal whitespace-nowrap"
                  >
                    open →
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-xs text-dust">
        Go Live only appears when the server rail would accept it (agreement signed ·
        Connect-active-or-legacy · no pending verification). Pause / Resume / Resync / upgrade
        actions live inside each rancher&apos;s hub.
      </p>
    </div>
  );
}
