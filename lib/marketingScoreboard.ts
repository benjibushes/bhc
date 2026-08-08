// lib/marketingScoreboard.ts
//
// P6′ — MARKETING SCOREBOARD pure helpers (MARKETING-REVAMP-2026-08 §5
// Convergence + §7 "what worked means").
//
// Every function here is pure and fail-soft: the scoreboard reads OTHER
// systems' exhaust (Cron Runs notes, Email Sends rows, Referral stamps) and
// none of that exhaust is a contract — a reworded note or a blank stamp must
// degrade one row to "unavailable", never crash the route. Parsers return
// null when nothing recognizable is present; counters skip unparseable rows.
//
// Data sources (all free or near-free — plan §5 P6′: "lane sizes seeded free
// from reclassify-buyers' Cron Runs notes"):
//   - reclassify-buyers Cron Runs note: `total=N changed=N updated=N
//     errors=N | SEGMENT=count SEGMENT=count …` (route.ts breakdown) —
//     projected onto lanes via laneForSegment. Zero Consumers scans.
//   - ranch-stand-digest Cron Runs note: three shapes (outside-window skip,
//     DRY-RUN plan, live send tally) — see parseDigestNote.
//   - Email Sends rows: 'Template Name' → stream via resolveEmailStream.
//   - Referrals: 'Deposit Invite Sent At' / 'Deposit Requested At' /
//     'Deposit Paid At' stamps + Status='Closed Won' with 'Closed At'.
//
// EVALUATION GATES are event-count based, never fixed windows (plan §5 P6′:
// at current volume a fortnight can't tell a working phase from a dead one).

import { laneForSegment } from './routingSegment';
import { resolveEmailStream } from './emailStreams';

// ── Field-value plumbing (same unwrap the today route uses) ────────────────

/** Airtable single-selects sometimes come back as {name} objects. */
export function fieldStr(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object' && 'name' in (v as any)) return String((v as any).name ?? '');
  return String(v);
}

function parseMs(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  const t = Date.parse(String(raw));
  return Number.isFinite(t) ? t : null;
}

// ── Reclassify-buyers note → lane sizes ────────────────────────────────────

export interface ReclassifyBreakdown {
  /** `total=` token when present (whole-list size). */
  total: number | null;
  /** Segment → count, exactly as the cron wrote them. */
  segments: Record<string, number>;
}

/**
 * Parse the reclassify-buyers Cron Runs note:
 *   `total=2744 changed=12 updated=12 errors=0 | MATCH_NOW=51 STATE_WAITLIST=1741 …`
 * The segment breakdown is everything after the `|`. Returns null when no
 * segment token parses (reworded note, truncated row, empty string) — the
 * route maps null to an "unavailable" lanes band.
 */
export function parseReclassifyNote(note: unknown): ReclassifyBreakdown | null {
  if (typeof note !== 'string' || !note.trim()) return null;
  const pipeAt = note.indexOf('|');
  if (pipeAt === -1) return null;
  const segments: Record<string, number> = {};
  for (const m of note.slice(pipeAt + 1).matchAll(/([A-Z][A-Z0-9_]*)=(\d+)/g)) {
    segments[m[1]] = Number(m[2]);
  }
  if (Object.keys(segments).length === 0) return null;
  const totalMatch = note.slice(0, pipeAt).match(/\btotal=(\d+)/);
  return { total: totalMatch ? Number(totalMatch[1]) : null, segments };
}

export interface LaneSizes {
  shareReady: number;
  national: number;
  customer: number;
}

/**
 * Project a segment breakdown onto the 3-lane architecture. Unknown segment
 * names fall to 'national' inside laneForSegment (fail-safe, lowest-pressure
 * lane) — parity with every other lane consumer.
 */
export function laneSizesFromSegments(segments: Record<string, number>): LaneSizes {
  const sizes: LaneSizes = { shareReady: 0, national: 0, customer: 0 };
  for (const [segment, count] of Object.entries(segments)) {
    const n = Number(count);
    if (!Number.isFinite(n) || n <= 0) continue;
    const lane = laneForSegment(segment);
    if (lane === 'share-ready') sizes.shareReady += n;
    else if (lane === 'customer') sizes.customer += n;
    else sizes.national += n;
  }
  return sizes;
}

// ── Ranch-stand-digest note parsing ────────────────────────────────────────

export interface DigestNoteSummary {
  /** True when the run was the outside-days-1-4 honest no-op. */
  outsideWindow: boolean;
  /** True when RANCH_STAND_DIGEST_ENABLED wasn't 'true' (plan-only run). */
  dryRun: boolean;
  tier: number | null;
  tierSizes: number[] | null;
  eligible: number | null;
  selected: number | null;
  /** Live runs only — null on dry-run/outside-window notes. */
  sent: number | null;
  thinMonth: boolean | null;
  skippedSunset: number | null;
  skippedNeverEngaged: number | null;
}

/**
 * Parse the ranch-stand-digest Cron Runs note. Three shapes exist (see
 * app/api/cron/ranch-stand-digest/route.ts):
 *   1. `skipped — outside send window (UTC day=17; digest sends days 1-4, …)`
 *   2. `DRY-RUN (…) — would send tier=1 tier-sizes=[9,9,9,8] eligible=35 …`
 *   3. `tier=1 tier-sizes=[…] … thin-month=false … sent=143 send-suppressed=0 …`
 * Returns null only when the note is empty/non-string or matches none of the
 * recognizable tokens — callers then fall back to the raw note passthrough.
 */
export function parseDigestNote(note: unknown): DigestNoteSummary | null {
  if (typeof note !== 'string' || !note.trim()) return null;
  const outsideWindow = /outside send window/i.test(note);
  const dryRun = /\bDRY-RUN\b/i.test(note);

  const grabInt = (re: RegExp): number | null => {
    const m = note.match(re);
    return m ? Number(m[1]) : null;
  };

  const tier = grabInt(/\btier=(\d+)/);
  const tierSizesMatch = note.match(/tier-sizes=\[([\d,\s]*)\]/);
  const tierSizes = tierSizesMatch
    ? tierSizesMatch[1]
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n))
    : null;
  const eligible = grabInt(/\beligible=(\d+)/);
  const selected = grabInt(/\bselected=(\d+)/);
  // `sent=` only appears on live runs; `send-suppressed=` also carries
  // "sent" as a substring, so anchor on a word boundary before `sent=`.
  const sent = grabInt(/(?:^|\s)sent=(\d+)/);
  const thinMatch = note.match(/thin-month=(true|false)/);
  const thinMonth = thinMatch ? thinMatch[1] === 'true' : null;
  const skippedSunset = grabInt(/skipped-sunset=(\d+)/);
  const skippedNeverEngaged = grabInt(/skipped-neverengaged=(\d+)/);

  const recognizedAnything =
    outsideWindow ||
    dryRun ||
    tier !== null ||
    tierSizes !== null ||
    eligible !== null ||
    sent !== null;
  if (!recognizedAnything) return null;

  return {
    outsideWindow,
    dryRun,
    tier,
    tierSizes,
    eligible,
    selected,
    sent,
    thinMonth,
    skippedSunset,
    skippedNeverEngaged,
  };
}

// ── Cron Runs row selection ────────────────────────────────────────────────

/**
 * Latest run row for a cron name (by parseable 'Started At'), or null.
 * Rows with unparseable timestamps are ignored rather than trusted.
 */
export function latestCronRunByName(
  rows: Array<Record<string, unknown>>,
  name: string,
): Record<string, unknown> | null {
  let best: Record<string, unknown> | null = null;
  let bestMs = -Infinity;
  for (const row of rows) {
    if (String(row?.['Name'] || '') !== name) continue;
    const t = parseMs(row?.['Started At']);
    if (t === null || t <= bestMs) continue;
    best = row;
    bestMs = t;
  }
  return best;
}

// ── Email Sends → per-stream counts ────────────────────────────────────────

export interface StreamCounts {
  marketing: number;
  transactional: number;
  total: number;
}

/**
 * Count sent rows per stream via resolveEmailStream('Template Name').
 * Unknown/blank templates land transactional — same fail-safe direction as
 * the sender itself, so the scoreboard never over-reports marketing volume.
 */
export function countSendsByStream(rows: Array<Record<string, unknown>>): StreamCounts {
  const counts: StreamCounts = { marketing: 0, transactional: 0, total: 0 };
  for (const row of rows) {
    const stream = resolveEmailStream(String(row?.['Template Name'] ?? ''));
    counts[stream]++;
    counts.total++;
  }
  return counts;
}

// ── Deposit funnel (Referrals stamps) ──────────────────────────────────────

export interface DepositFunnelCounts {
  inviteSent: number;
  requested: number;
  paid: number;
}

/**
 * Count referral rows whose deposit stamps fall at/after `sinceMs`.
 * Unparseable/blank stamps are skipped (a blank field means nothing wrote
 * it — hard rule 1 — not that the event didn't happen; counting only what
 * was stamped is the honest floor).
 */
export function countDepositFunnel(
  referrals: Array<Record<string, unknown>>,
  sinceMs: number,
): DepositFunnelCounts {
  const counts: DepositFunnelCounts = { inviteSent: 0, requested: 0, paid: 0 };
  for (const r of referrals) {
    const invited = parseMs(r?.['Deposit Invite Sent At']);
    if (invited !== null && invited >= sinceMs) counts.inviteSent++;
    const requested = parseMs(r?.['Deposit Requested At']);
    if (requested !== null && requested >= sinceMs) counts.requested++;
    const paid = parseMs(r?.['Deposit Paid At']);
    if (paid !== null && paid >= sinceMs) counts.paid++;
  }
  return counts;
}

export interface DepositFunnelRates {
  /** requested ÷ inviteSent, whole percent. Null when the denominator is 0. */
  inviteToRequestPct: number | null;
  /** paid ÷ requested, whole percent. Null when the denominator is 0. */
  requestToPaidPct: number | null;
  /** paid ÷ inviteSent, whole percent. Null when the denominator is 0. */
  inviteToPaidPct: number | null;
}

/**
 * Window-count ratios, not true cohort rates (a deposit paid this window may
 * have been invited last window) — at tens of events/month cohort plumbing
 * measures noise (plan §5: attribution at this volume was cut as YAGNI).
 * Ratios can legitimately exceed 100% on a window edge; they are NOT clamped
 * — an honest 120% is more informative than a fake 100%.
 */
export function computeFunnelRates(counts: DepositFunnelCounts): DepositFunnelRates {
  const pct = (num: number, den: number): number | null =>
    den > 0 ? Math.round((num / den) * 100) : null;
  return {
    inviteToRequestPct: pct(counts.requested, counts.inviteSent),
    requestToPaidPct: pct(counts.paid, counts.requested),
    inviteToPaidPct: pct(counts.paid, counts.inviteSent),
  };
}

// ── Weekly closes ──────────────────────────────────────────────────────────

export interface ClosedWonCounts {
  /** Closed Won with a parseable 'Closed At' at/after sinceMs. */
  closedInWindow: number;
  /**
   * Closed Won rows with NO parseable 'Closed At' — surfaced separately
   * because 'Closed At' is a singleLineText only some writers stamp
   * (lib/lossRecovery.ts) and hiding those rows would understate closes
   * silently.
   */
  missingClosedAt: number;
}

export function countClosedWonSince(
  referrals: Array<Record<string, unknown>>,
  sinceMs: number,
): ClosedWonCounts {
  let closedInWindow = 0;
  let missingClosedAt = 0;
  for (const r of referrals) {
    if (fieldStr(r?.['Status']) !== 'Closed Won') continue;
    const closedMs = parseMs(r?.['Closed At']);
    if (closedMs === null) missingClosedAt++;
    else if (closedMs >= sinceMs) closedInWindow++;
  }
  return { closedInWindow, missingClosedAt };
}

// ── Event-count evaluation gates (plan §7) ─────────────────────────────────

export interface GateProgress {
  /** Phase the gate evaluates (e.g. "P3′ digest"). */
  phase: string;
  /** Human metric name (e.g. "digest deliveries"). */
  metric: string;
  current: number;
  target: number;
  /** True once current >= target — the phase has enough events to judge. */
  reached: boolean;
  /** Ready-to-render "43/200". */
  label: string;
}

export function gateProgress(
  phase: string,
  metric: string,
  current: number,
  target: number,
): GateProgress {
  const cur = Number.isFinite(current) && current > 0 ? Math.floor(current) : 0;
  return {
    phase,
    metric,
    current: cur,
    target,
    reached: cur >= target,
    label: `${cur}/${target}`,
  };
}
