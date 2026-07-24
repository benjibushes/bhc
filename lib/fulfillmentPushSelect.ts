// Pure candidate selection for the fulfillment-push-net cron (Batch C — "no
// silent stranding").
//
// The old cron did `IS_AFTER(Ordered At, now-3d)` + an unsorted `slice(0,20)`.
// Two silent-stranding bugs fell out of that:
//   1. During a >3-day outage or a >20-order backlog, an order aged out of the
//      3-day window and was NEVER auto-pushed again — paid, and it would never
//      appear in the rancher's store.
//   2. The unsorted slice could push the same 20 recent rows every run and
//      starve older ones for the last day of their window.
//
// This selector fixes both and adds two recovery paths:
//   • M1 — SORT oldest-first, then cap. The oldest never starve behind newer
//     rows, and a window-INDEPENDENT backstop keeps aged blank rows in
//     consideration (bounded so no-integration rows can't occupy the cap
//     forever — see the blank branch).
//   • Stale-'pushing' recovery — Batch A pre-stamps 'pushing' BEFORE the
//     Shopify call, so a hard crash mid-push strands a row at 'pushing'.
//     Re-pushing is SAFE now (unique BHC-oid tag + Idempotency-Key dedup), so
//     we re-attempt a stale 'pushing' row (older than a short grace) exactly
//     like a blank one.
//   • M2 — operator-requested, window-INDEPENDENT retry via
//     'Push Retry Requested At'. An operator who fixes a bad SKU on day 7 sets
//     that field; we push regardless of age and CLEAR the field after the
//     attempt so it doesn't re-fire every run.
//
// Pure + fully unit-tested. The cron does the Airtable I/O (fetch New orders,
// run the push, clear the retry flag, tally outcomes).

import { decidePushDisposition } from './fulfillmentPushRunner';

// Grace during which a blank row is always swept — covers a rancher who
// connects Shopify AFTER the order settled (the runner leaves 'no-integration'
// blank on purpose so this window picks it up).
export const PUSH_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
// A row stuck at 'pushing' longer than this is a hard-crash strand, not a real
// in-flight push (any live push resolves in seconds; cron runs are 2h apart).
export const STALE_PUSHING_GRACE_MS = 30 * 60 * 1000;
// Connector calls are serial Shopify hits — keep the per-run cap sane.
export const MAX_PUSH_PER_RUN = 20;

export interface PushCandidateOrder {
  id: string;
  /** 'Status' — only 'New' rows are ever pushable. */
  status?: string;
  /** 'External Push Status' — '', 'pushing', 'pushed', 'failed:*', … */
  externalPushStatus?: string;
  /** 'External Pushed At' — set on success/cancel; BLANK on a pre-stamped
   *  'pushing' row (the pre-stamp only writes the status), so staleness of a
   *  'pushing' row usually falls back to Ordered At. */
  externalPushedAt?: string;
  /** 'Ordered At' — settlement always stamps this; drives oldest-first order. */
  orderedAt?: string;
  /** 'Push Retry Requested At' — operator flag for a window-independent retry. */
  pushRetryRequestedAt?: string;
  /** 'External Order Id' — presence means already pushed. */
  externalOrderId?: string;
  /**
   * Does the rancher have a usable fulfillment integration? Computed by the
   * cron from the Ranchers table. `undefined` = unknown (e.g. the rancher
   * fetch failed) → treated as YES so we never strand a genuinely pushable
   * order. Only an explicit `false` excludes an AGED blank row from the
   * backstop (those never push and would otherwise sit at the head of the
   * oldest-first queue forever).
   */
  hasIntegration?: boolean;
}

export type CandidateSource = 'retry-requested' | 'blank' | 'aged' | 'stale-pushing';

export interface PushSelection {
  /** Row ids to feed runFulfillmentPush — retry-requested first, then
   *  oldest-first — capped at MAX_PUSH_PER_RUN. */
  toPush: string[];
  /** Rows whose 'Push Retry Requested At' must be cleared after this run:
   *  every retry row we attempt this run PLUS moot retry rows (already
   *  pushed/cancelled). A retry row deferred past the cap keeps its flag so it
   *  re-fires next run. */
  clearRetryIds: string[];
  /** Push-eligible candidates BEFORE the cap. */
  totalEligible: number;
  /** Push-eligible candidates that did NOT make the cap this run. */
  deferred: number;
  /** Candidate-source tally for the Cron Runs 'Skip Reason Breakdown'. */
  sourceCounts: Partial<Record<CandidateSource, number>>;
}

interface Ranked {
  id: string;
  /** 0 = operator-requested retry (jumps the queue), 1 = routine sweep. */
  priority: number;
  /** now - Ordered At; -Infinity when Ordered At is unparseable (sorts last). */
  ageMs: number;
  source: CandidateSource;
}

/**
 * Decide which New Rancher-Orders rows to push this run, in what order, and
 * which 'Push Retry Requested At' flags to clear afterward.
 */
export function selectPushCandidates(orders: PushCandidateOrder[], nowIso: string): PushSelection {
  const empty: PushSelection = {
    toPush: [], clearRetryIds: [], totalEligible: 0, deferred: 0, sourceCounts: {},
  };
  const now = Date.parse(nowIso);
  if (Number.isNaN(now)) return empty;

  const ranked: Ranked[] = [];
  const mootRetryIds: string[] = [];

  for (const o of orders || []) {
    if (!o || !o.id) continue;
    if (String(o.status || '') !== 'New') continue;

    const st = String(o.externalPushStatus || '').trim();
    const orderedMs = Date.parse(String(o.orderedAt || ''));
    const ageMs = Number.isNaN(orderedMs) ? Number.NEGATIVE_INFINITY : now - orderedMs;

    // ── M2: operator-requested retry — window-INDEPENDENT, top priority ──────
    if (String(o.pushRetryRequestedAt || '').trim()) {
      const disp = decidePushDisposition({
        'External Order Id': o.externalOrderId,
        'External Push Status': o.externalPushStatus,
      });
      if (disp.action === 'push') {
        // Pushable (blank / pushing / failed:*) — attempt regardless of age.
        ranked.push({ id: o.id, priority: 0, ageMs, source: 'retry-requested' });
      } else {
        // Already pushed/cancelled — the request is moot, but still clear the
        // flag so it stops re-firing every run.
        mootRetryIds.push(o.id);
      }
      continue;
    }

    // ── Routine sweep (no explicit retry request) ────────────────────────────
    if (st === '') {
      // Within the 3-day grace we always sweep (covers a late Shopify connect,
      // matching the runner leaving 'no-integration' blank). Beyond the window
      // the M1 backstop keeps the row in play so a long outage/backlog can't
      // strand it — UNLESS we KNOW the rancher has no integration (those never
      // push and would otherwise camp the head of the oldest-first queue).
      const withinWindow = ageMs !== Number.NEGATIVE_INFINITY && ageMs < PUSH_WINDOW_MS;
      if (withinWindow) {
        ranked.push({ id: o.id, priority: 1, ageMs, source: 'blank' });
      } else if (o.hasIntegration !== false) {
        ranked.push({ id: o.id, priority: 1, ageMs, source: 'aged' });
      }
      // else: aged + known-no-integration → product-fulfillment-sla owns it.
      continue;
    }

    if (st === 'pushing') {
      // Hard-crash strand recovery. Prefer External Pushed At; fall back to
      // Ordered At (a pre-stamped 'pushing' row has no External Pushed At).
      // Only re-attempt STALE rows — never interrupt a fresh in-flight push.
      const pushedMs = Date.parse(String(o.externalPushedAt || ''));
      const refMs = Number.isNaN(pushedMs) ? orderedMs : pushedMs;
      if (!Number.isNaN(refMs) && now - refMs >= STALE_PUSHING_GRACE_MS) {
        ranked.push({ id: o.id, priority: 1, ageMs, source: 'stale-pushing' });
      }
      continue;
    }
    // Any other status (pushed / cancelled / failed:* / skipped:*) is NOT a
    // routine candidate — failed:* recovers only via Push Retry Requested At.
  }

  // Retry-requested first (priority), then oldest-first (largest age first).
  ranked.sort((a, b) => a.priority - b.priority || b.ageMs - a.ageMs);

  const toPush = ranked.slice(0, MAX_PUSH_PER_RUN).map((r) => r.id);
  const toPushSet = new Set(toPush);

  const clearRetryIds = [
    ...mootRetryIds,
    ...ranked
      .filter((r) => r.source === 'retry-requested' && toPushSet.has(r.id))
      .map((r) => r.id),
  ];

  const sourceCounts: Partial<Record<CandidateSource, number>> = {};
  for (const r of ranked) sourceCounts[r.source] = (sourceCounts[r.source] || 0) + 1;

  return {
    toPush,
    clearRetryIds,
    totalEligible: ranked.length,
    deferred: Math.max(0, ranked.length - toPush.length),
    sourceCounts,
  };
}

// Classify the row's External Push Status AFTER a push attempt, so the cron can
// report an honest run status and fire a loud alert when a run makes zero
// forward progress despite having real work.
export type PushOutcome = 'pushed' | 'skipped' | 'failed' | 'retryable';

export function classifyPushOutcome(externalPushStatus: string | undefined | null): PushOutcome {
  const s = String(externalPushStatus || '').trim();
  // 'pushed-unstamped:<id>' DID create the external order (the stamp write
  // failed and the runner already alerted) — count it as pushed, not stranded.
  if (s === 'pushed' || s.startsWith('pushed-unstamped')) return 'pushed';
  if (s === 'cancelled' || s.startsWith('skipped:')) return 'skipped';
  if (s.startsWith('failed:') || s.startsWith('cancel-failed:')) return 'failed';
  // '' (transient failure reverted to blank) or 'pushing' (still) → retryable.
  return 'retryable';
}
