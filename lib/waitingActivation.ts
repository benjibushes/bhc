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

// ── DRY-RUN REPORT (T2.1, 2026-07-02) ────────────────────────────────────────
//
// WAITING_ACTIVATION_ENABLED='dry-run' runs the exact selection the live mode
// would use, sends NOTHING, stamps NOTHING, and reports what WOULD happen so
// the founder can eyeball the batch before flipping to 'true'. All sends to
// buyers stay founder-gated — this report is the gate's evidence.

export interface WaitingDryRunReport {
  poolSize: number;
  selectedCount: number;
  /** Selected buyers by State (blank state omitted). */
  byState: Record<string, number>;
  /** Selected buyers by prior nudge count ('0', '1', '2'). */
  byPriorNudges: Record<string, number>;
  /** Selected buyers who would ALSO get SMS (TCPA opt-in + phone + not unsubscribed). */
  smsEligibleCount: number;
  /** Age in whole days of the oldest selected signup, or null when empty. */
  oldestSignupDays: number | null;
  sample: Array<{
    id: string;
    firstName: string;
    state: string;
    signedUpDaysAgo: number | null;
    priorNudges: number;
  }>;
}

function signupAgeDays(c: WaitingConsumerLike, nowMs: number): number | null {
  const t = Date.parse(String(c._createdTime || ''));
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((nowMs - t) / DAY_MS));
}

export function buildWaitingDryRunReport(
  candidates: WaitingConsumerLike[],
  selected: WaitingConsumerLike[],
  opts: { nowISO: string; sampleSize?: number },
): WaitingDryRunReport {
  const nowMs = Date.parse(opts.nowISO);
  const sampleSize = opts.sampleSize ?? 10;

  const byState: Record<string, number> = {};
  const byPriorNudges: Record<string, number> = {};
  let smsEligibleCount = 0;

  for (const c of selected) {
    const state = String(c['State'] || '').trim();
    if (state) byState[state] = (byState[state] || 0) + 1;
    const prior = String(priorNudgeCount(c));
    byPriorNudges[prior] = (byPriorNudges[prior] || 0) + 1;
    // Mirrors sendSMSToConsumer's TCPA gate (opt-in + phone + not unsubscribed);
    // live sends additionally respect ENABLE_SMS + quiet hours.
    if (c['SMS Opt-In'] === true && String(c['Phone'] || '').trim() && !c['Unsubscribed']) {
      smsEligibleCount++;
    }
  }

  const oldest = selected.length ? signupAgeDays(selected[0], nowMs) : null;

  return {
    poolSize: candidates.length,
    selectedCount: selected.length,
    byState,
    byPriorNudges,
    smsEligibleCount,
    oldestSignupDays: oldest,
    sample: selected.slice(0, sampleSize).map((c) => ({
      id: String(c.id || ''),
      firstName: String(c['Full Name'] || '').split(' ')[0] || 'there',
      state: String(c['State'] || '').trim(),
      signedUpDaysAgo: signupAgeDays(c, nowMs),
      priorNudges: priorNudgeCount(c),
    })),
  };
}

/** Telegram-ready text for the dry-run report. Pure. */
export function formatWaitingDryRunReport(
  report: WaitingDryRunReport,
  opts: { cooldownDays: number; batchCap: number },
): string {
  const topStates = Object.entries(report.byState)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([s, n]) => `${s} ${n}`)
    .join(' · ') || 'none recorded';
  const priorLine = Object.entries(report.byPriorNudges)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([k, n]) => `${k}×: ${n}`)
    .join(' · ') || '—';
  const sampleLine = report.sample
    .map((s) => `${s.firstName} (${s.state || '?'}, ${s.signedUpDaysAgo ?? '?'}d, ${s.priorNudges} prior)`)
    .join(' · ') || '—';

  return [
    'WAITING ACTIVATION — DRY RUN (no sends, no stamps)',
    `Pool: ${report.poolSize} WAITING buyers (suppressed already excluded)`,
    `Would nudge this run: ${report.selectedCount} (cap ${opts.batchCap}, cooldown ${opts.cooldownDays}d)`,
    `SMS-eligible among them: ${report.smsEligibleCount} (TCPA opt-in + phone; live sends also respect ENABLE_SMS + quiet hours)`,
    `Prior nudges: ${priorLine}`,
    `Top states: ${topStates}`,
    `Oldest signup: ${report.oldestSignupDays === null ? '—' : `${report.oldestSignupDays} days ago`}`,
    `Sample: ${sampleLine}`,
    'Flip WAITING_ACTIVATION_ENABLED=true in Vercel to go live at this pace (one batch per day).',
  ].join('\n');
}
