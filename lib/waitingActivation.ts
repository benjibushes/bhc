// lib/waitingActivation.ts
//
// Area A3 (2026-07-01): pure eligibility selector for the waiting-activation
// cron (app/api/cron/waiting-activation).
//
// ~2,000 signed-up buyers rot at `Buyer Stage = WAITING` in Consumers because
// routing is PULL — only quiz-qualified buyers (score >= 75 via /api/qualify)
// ever reach matching. This module decides WHO gets the "finish your
// qualification" nudge on a given run. Dependency-free decision logic, so it
// unit-tests without Airtable (same pattern as lib/depositSla.ts).
//
// Eligibility (ALL must hold):
//   - Buyer Stage === 'WAITING'
//   - has a non-blank Email
//   - not suppressed: Unsubscribed / Bounced / Complained all falsy (the
//     repo's standard Consumers suppression trio — mirrors abandoned-quiz-
//     nudge, buyer-pulse, re-warm-cohort)
//   - fewer than WAITING_NUDGE_LIFETIME_CAP prior nudges (Waiting Nudge Count)
//   - last nudge (Waiting Nudge Last Sent At) at least cooldownDays ago; a
//     non-empty stamp that doesn't parse is treated as RECENT (skip) so a
//     corrupt field can never cause a nudge storm
//
// Ordering: oldest signup first (Airtable record `_createdTime`, exposed by
// lib/airtable getAllRecords) — the stale backlog is the point of this cron.
// Output is capped at batchCap per run to pace sends.

export const WAITING_NUDGE_LIFETIME_CAP = 3;

export interface WaitingConsumerLike {
  id?: string;
  'Buyer Stage'?: unknown;
  Email?: unknown;
  Unsubscribed?: unknown;
  Bounced?: unknown;
  Complained?: unknown;
  'Waiting Nudge Last Sent At'?: unknown;
  'Waiting Nudge Count'?: unknown;
  /** Airtable record metadata (ISO string), added by getAllRecords. */
  _createdTime?: unknown;
  [key: string]: unknown;
}

export interface WaitingNudgeOptions {
  /** "now" as an ISO string — keeps the selector deterministic in tests. */
  nowISO: string;
  /** Minimum days between nudges to the same buyer. */
  cooldownDays: number;
  /** Max buyers returned per run (selector output cap). */
  batchCap: number;
}

const DAY_MS = 86_400_000;

function priorNudgeCount(c: WaitingConsumerLike): number {
  const n = Number(c['Waiting Nudge Count']);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function createdTimeMs(c: WaitingConsumerLike): number {
  const t = Date.parse(String(c._createdTime || ''));
  // Missing/unparseable createdTime sorts as oldest — a buyer is never
  // dropped for lacking record metadata.
  return Number.isFinite(t) ? t : 0;
}

/**
 * Per-record predicate: should this consumer get a waiting-activation nudge
 * right now? Pure — reads only the record + options.
 */
export function isWaitingNudgeEligible(
  c: WaitingConsumerLike,
  opts: Pick<WaitingNudgeOptions, 'nowISO' | 'cooldownDays'>,
): boolean {
  if (String(c['Buyer Stage'] || '').trim() !== 'WAITING') return false;

  if (!String(c['Email'] || '').trim()) return false;

  // Suppression trio — any one set means never contact on this channel pair.
  if (c['Unsubscribed'] || c['Bounced'] || c['Complained']) return false;

  // Lifetime cap: after WAITING_NUDGE_LIFETIME_CAP touches, stop forever.
  if (priorNudgeCount(c) >= WAITING_NUDGE_LIFETIME_CAP) return false;

  // Cooldown: no nudge within the last cooldownDays.
  const rawStamp = String(c['Waiting Nudge Last Sent At'] || '').trim();
  if (rawStamp) {
    const lastMs = Date.parse(rawStamp);
    if (!Number.isFinite(lastMs)) return false; // corrupt stamp → skip, never storm
    const nowMs = Date.parse(opts.nowISO);
    if (!Number.isFinite(nowMs)) return false;
    if (nowMs - lastMs < opts.cooldownDays * DAY_MS) return false;
  }

  return true;
}

/**
 * Pick the buyers to nudge this run: eligible per isWaitingNudgeEligible,
 * oldest signup first, at most batchCap.
 */
export function selectWaitingBuyersForNudge<T extends WaitingConsumerLike>(
  consumers: T[],
  opts: WaitingNudgeOptions,
): T[] {
  const cap = Math.floor(opts.batchCap);
  if (!Array.isArray(consumers) || consumers.length === 0 || cap <= 0) return [];
  return consumers
    .filter((c) => isWaitingNudgeEligible(c, opts))
    .sort((a, b) => createdTimeMs(a) - createdTimeMs(b))
    .slice(0, cap);
}
