// lib/campaignWaves.ts
//
// PURE wave selection for the CAMPAIGN AUTOPILOT (ADAPTIVE-MARKETING-DESIGN
// PR 2). The cron (app/api/cron/campaign-autopilot) injects rows + telemetry;
// everything here is deterministic and side-effect free so the whole policy
// is unit-testable.
//
// WHAT THE AUTOPILOT OWNS (rail disjointness, design doc §PR 2):
//   • FIRST TOUCH of never-campaigned buyers, via the requalify-send flow.
//     "Never campaigned" = no campaign claim stamp of ANY kind (Campaign Last
//     Sent At / Campaign Rail / Campaign Stage all empty — both rails write
//     into this namespace, so the first-touch pool is disjoint from the
//     demand-router arc BY CONSTRUCTION).
//   • The demand-router keeps post-engagement arcs + recovery untouched.
//   • 7d cross-rail belt: any demand-router stamp within 7 days skips the
//     buyer even if a claim field was reverted (the SMS-recovery stamp is not
//     a claim field, so the belt is not redundant).
//
// SELECTION PIPELINE (design doc): Consumers scan → mailable + lane +
// state ∈ servedStates + unclaimed → rancher-for-state policy →
// engagement-recency order → chunks of MAX_BATCH (60).
//
// BUDGET (all ceilings are per-UTC-day, measured against Email Sends truth):
//   • FULL = DAILY_CAMPAIGN_BUDGET (120/day) — the domain-wide campaign
//     ceiling lib/requalifyCampaign already enforces server-side; the
//     autopilot never asks for more than the remainder.
//   • RAMP = 30/day until the autopilot has 3 distinct live-send days behind
//     it (any volume-character change → the cron's live-day counter resets
//     naturally because it counts autopilot sends, not calendar days).
//   • DOMAIN WARMUP: while MARKETING_SEND_DOMAIN is set and Ben has not
//     stamped MARKETING_DOMAIN_WARMED='true', hold at RAMP regardless.
//
// AUTO-PAUSE, FAIL-CLOSED (checked before every live run):
//   • complaints ≥3 in the trailing 7d (lib/complaintTelemetry threshold)
//   • send-failure >10% on the prior run (attempted ≥10 so one flaky send
//     out of two can't wedge the rail shut)
//   • >5 hard bounces in the trailing 24h (webhook Notes stamps — the stamp
//     is day-granular, so the window floors to the UTC day: biased toward
//     pausing early, never late — the complaintTelemetry rule)
//   • ANY telemetry read failure = alarm (null in, pause out).
//
// RANCHER-FOR-STATE POLICY (one rancher owns each state's wave):
//   operational (isRancherOperationalForBuyers) + has a Slug, serving the
//   state per getOperationalServedStates; ties broken by
//     1. NO exclusive-ZIP gate first — a Service ZIP Prefixes rancher owns a
//        sub-state territory (Thomas/Houston), not the state's whole cohort;
//        a state-level wave routed at them would email mostly out-of-zone
//        buyers into the quiz fallback. They only take the state when they
//        are its ONLY operational rancher (requalify's zip belt then quietly
//        quizzes the out-of-zone tail).
//     2. primary state (rancher State === buyer state) beats routing-states
//        coverage — same rule as /api/matching/suggest.
//     3. fewer Current Active Referrals (load balance).
//     4. Slug ascending (deterministic).
//   The computed table is returned so the cron can log it (Ben-visible in
//   every Cron Runs row — slugs are public, counts only, never buyer PII).

import { normalizeState } from './states';
import { laneForSegment } from './routingSegment';
import {
  isRancherOperationalForBuyers,
  getOperationalServedStates,
  type RancherFields,
} from './rancherEligibility';
import { hasServiceZipGate } from './exclusiveZip';
import {
  isSyntheticTestEmail,
  lastActivityMs,
  CAMPAIGN_SMS_RECOVERY_FIELD,
  type ActiveDealKeys,
} from './demandRouter';
import { MAX_BATCH, DAILY_CAMPAIGN_BUDGET } from './requalifyCampaign';
import { SUNSET_SUPPRESSED_MARKER } from './marketingSunset';
import { COMPLAINT_ALERT_THRESHOLD } from './complaintTelemetry';
import { REQUEST_ONLY_RANCHER_SLUGS, isRequestOnlyRancher } from './requestOnlyRanchers';

// ── Constants ───────────────────────────────────────────────────────────────

/** Email Sends `Campaign` tag prefix + template prefix for every autopilot
 * send (`campaign_autopilot-<st>`), so ramp/attribution queries can FIND it. */
export const AUTOPILOT_CAMPAIGN_PREFIX = 'autopilot';
/** The `Campaign Rail` claim value autopilot sends stamp on Consumers. */
export const AUTOPILOT_RAIL = 'autopilot';

/**
 * Ranchers excluded from the autopilot's first-touch state table.
 *
 * @deprecated Back-compat alias. The canonical list moved to
 * lib/requestOnlyRanchers (2026-08-17) once the live matcher needed the same
 * rule — this file had been the ONLY engine honoring it. Prefer
 * `isRequestOnlyRancher(rancher)` / `REQUEST_ONLY_RANCHER_SLUGS`; adding a
 * slug there excludes it from campaign waves AND generic routing at once.
 * Behavior here is unchanged: rep-provisions stays out of the wave table.
 */
export const CAMPAIGN_WAVE_EXCLUDED_SLUGS: ReadonlySet<string> = REQUEST_ONLY_RANCHER_SLUGS;

/**
 * Sellability gate (Ben, 2026-08-12: "route them properly"). A first-touch
 * wave must never land a buyer on a page with nothing to buy — the fleet
 * audit found Active ranchers with zero prices AND zero payment links
 * (routed buyers hit a dead end). Sellable = at least one cut priced at or
 * above the platform floor, OR any payment link (legacy ranchers sell
 * through links/off-platform). Deliberately independent of the 'Sells'
 * array: a priced cut is sellable even when the Sells field was never
 * filled in. States whose only candidate fails this gate drop out of the
 * wave table honestly (skip, not misroute).
 */
export function isWaveSellable(r: Record<string, unknown>): boolean {
  const MIN = 100; // MIN_TIER_PRICE (lib/pricing.ts) — kept literal to keep this lib pure/import-light
  const priced = ['Quarter Price', 'Half Price', 'Whole Price'].some((f) => {
    const n = Number(r[f]);
    return Number.isFinite(n) && n >= MIN;
  });
  if (priced) return true;
  return ['Quarter Payment Link', 'Half Payment Link', 'Whole Payment Link', 'Payment Link'].some(
    (f) => String(r[f] || '').trim().length > 0,
  );
}

export const RAMP_DAILY_CAP = 30;
/** Distinct live-send days required before the ramp cap lifts. */
export const RAMP_LIVE_DAYS = 3;
export const FULL_DAILY_CAP = DAILY_CAMPAIGN_BUDGET; // 120 — shared ceiling
export const CROSS_RAIL_SKIP_DAYS = 7;

export const BOUNCE_PAUSE_THRESHOLD = 5; // pause when MORE than this /24h
export const FAILURE_RATE_PAUSE = 0.1; // pause when prior-run failures exceed
export const FAILURE_MIN_ATTEMPTED = 10; // …with at least this many attempts

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Tri-state kill switch (fail-to-off, the variantMode contract) ───────────

export type AutopilotMode = 'off' | 'dry-run' | 'live';

/**
 * CAMPAIGN_AUTOPILOT_ENABLED: ONLY the exact string 'true' arms live sends,
 * ONLY 'dry-run' runs the L0 shadow (full selection + logging, zero sends).
 * Anything else — unset, 'false', casing typos, junk — is OFF.
 */
export function autopilotMode(
  raw: string | undefined = process.env.CAMPAIGN_AUTOPILOT_ENABLED,
): AutopilotMode {
  if (raw === 'true') return 'live';
  if (raw === 'dry-run') return 'dry-run';
  return 'off';
}

/**
 * Domain-warmup hold (design doc): while the marketing subdomain is
 * configured (MARKETING_SEND_DOMAIN set — every autopilot template is
 * marketing-stream, so sends ride it) and Ben has not recorded warmup
 * complete (MARKETING_DOMAIN_WARMED='true'), the autopilot holds at ramp
 * volume regardless of how many clean live days it has. No subdomain
 * configured = marketing rides the long-established apex → no hold.
 */
export function domainWarmupHold(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const domain = String(env.MARKETING_SEND_DOMAIN || '').trim();
  if (!domain) return false;
  return env.MARKETING_DOMAIN_WARMED !== 'true';
}

// ── Budget math ─────────────────────────────────────────────────────────────

export interface BudgetInput {
  /** campaign_* Email Sends rows already sent this UTC day (domain-wide). */
  sentToday: number;
  /** Distinct UTC days with ≥1 live autopilot send (ramp ladder progress). */
  priorLiveSendDays: number;
  /** domainWarmupHold() — subdomain configured but not yet warmed. */
  domainWarming: boolean;
}

export interface BudgetDecision {
  ceiling: number;
  rampActive: boolean;
  rampReason: 'ramp-days' | 'domain-warmup' | null;
  /** How many the autopilot may select this run (ceiling − sentToday, ≥0). */
  remaining: number;
}

export function decideBudget(input: BudgetInput): BudgetDecision {
  const sentToday = Math.max(0, Math.floor(input.sentToday));
  const rampReason: BudgetDecision['rampReason'] = input.domainWarming
    ? 'domain-warmup'
    : input.priorLiveSendDays < RAMP_LIVE_DAYS
      ? 'ramp-days'
      : null;
  const ceiling = rampReason ? RAMP_DAILY_CAP : FULL_DAILY_CAP;
  return {
    ceiling,
    rampActive: rampReason !== null,
    rampReason,
    remaining: Math.max(0, ceiling - sentToday),
  };
}

// ── Auto-pause gates ────────────────────────────────────────────────────────

export interface GuardTelemetry {
  /** Trailing-7d complaint count, or null = the read FAILED (alarm). */
  complaints7d: number | null;
  /** Trailing-24h hard-bounce stamp count, or null = read FAILED (alarm). */
  bounces24h: number | null;
  /**
   * The prior autopilot run's send stats parsed from its Cron Runs notes:
   *   {attempted, failed} — a completed prior run
   *   'none'              — no prior run recorded (first run: fine)
   *   null                — the Cron Runs read FAILED (alarm)
   */
  priorRun: { attempted: number; failed: number } | 'none' | null;
}

/**
 * The fail-closed pause decision. Returns a human-readable reason when the
 * autopilot must NOT send this run, else null. Telemetry that could not be
 * read is treated as an alarm (design doc §2 invariant 3).
 */
export function autoPauseReason(t: GuardTelemetry): string | null {
  if (t.complaints7d === null) return 'complaint telemetry read failed (fail closed)';
  if (t.complaints7d >= COMPLAINT_ALERT_THRESHOLD) {
    return `complaints ${t.complaints7d}/7d ≥ ${COMPLAINT_ALERT_THRESHOLD}`;
  }
  if (t.bounces24h === null) return 'bounce telemetry read failed (fail closed)';
  if (t.bounces24h > BOUNCE_PAUSE_THRESHOLD) {
    return `hard bounces ${t.bounces24h}/24h > ${BOUNCE_PAUSE_THRESHOLD}`;
  }
  if (t.priorRun === null) return 'prior-run stats read failed (fail closed)';
  if (t.priorRun !== 'none' && t.priorRun.attempted >= FAILURE_MIN_ATTEMPTED) {
    const rate = t.priorRun.failed / t.priorRun.attempted;
    if (rate > FAILURE_RATE_PAUSE) {
      return `prior run failure rate ${(rate * 100).toFixed(0)}% (${t.priorRun.failed}/${t.priorRun.attempted}) > ${FAILURE_RATE_PAUSE * 100}%`;
    }
  }
  return null;
}

// ── Run-stats token (Cron Runs notes → next run's failure gate) ─────────────

export interface RunStats {
  attempted: number;
  sent: number;
  suppressed: number;
  failed: number;
}

/** Machine-readable token embedded in the Cron Runs note. Counts only. */
export function formatRunStats(s: RunStats): string {
  return `stats[attempted=${s.attempted} sent=${s.sent} suppressed=${s.suppressed} failed=${s.failed}]`;
}

const RUN_STATS_RE =
  /stats\[attempted=(\d+) sent=(\d+) suppressed=(\d+) failed=(\d+)\]/;

/** Parse the token back out of a prior run's notes. Null when absent. */
export function parseRunStats(notes: unknown): RunStats | null {
  const m = String(notes ?? '').match(RUN_STATS_RE);
  if (!m) return null;
  return {
    attempted: Number(m[1]),
    sent: Number(m[2]),
    suppressed: Number(m[3]),
    failed: Number(m[4]),
  };
}

// ── Bounce stamp counting (mirror of lib/complaintTelemetry) ────────────────

// The Resend webhook writes `[Auto-unsub YYYY-MM-DD] bounced` on Consumers
// Notes for every email.bounced event (app/api/webhooks/resend). The negative
// lookahead-free tail guard keeps complaint lines out ('spam complaint' never
// contains the word 'bounced').
const BOUNCE_LINE_RE = /\[Auto-unsub (\d{4}-\d{2}-\d{2})\][^\n]*bounced/gi;

/** Dates of every bounce stamp in a Notes blob. */
export function extractBounceDates(notes: unknown): string[] {
  if (typeof notes !== 'string' || !notes) return [];
  const dates: string[] = [];
  for (const m of notes.matchAll(BOUNCE_LINE_RE)) dates.push(m[1]);
  return dates;
}

/**
 * Count bounce stamps at or after `sinceMs`. Same-day duplicates on one
 * record count once (webhook redelivery must not inflate the rate). Stamps
 * are UTC-day granular — pass a day-floored `sinceMs` (bias: pause early).
 */
export function countBounceStampsSince(
  records: Array<Record<string, unknown>>,
  sinceMs: number,
): number {
  let total = 0;
  for (const rec of records) {
    const distinctDays = new Set(extractBounceDates(rec?.['Notes']));
    for (const day of distinctDays) {
      const t = Date.parse(`${day}T00:00:00Z`);
      if (Number.isFinite(t) && t >= sinceMs) total++;
    }
  }
  return total;
}

// ── Rancher-for-state policy ────────────────────────────────────────────────

export interface StateRancher {
  id: string;
  slug: string;
  name: string;
}

/**
 * One rancher owns each served state's wave. See the policy comment at the
 * top of this file. Returns the state→rancher table; states with no
 * operational sluggged rancher simply have no entry (their buyers count as
 * state-unserved in the plan).
 */
export function rancherForStateTable(
  ranchers: RancherFields[],
): Map<string, StateRancher> {
  interface Candidate extends StateRancher {
    zipGated: boolean;
    primary: boolean;
    load: number;
  }
  const byState = new Map<string, Candidate[]>();
  for (const r of ranchers) {
    if (!isRancherOperationalForBuyers(r)) continue;
    const slug = String((r as any)['Slug'] || '').trim();
    if (!slug) continue; // requalify-send resolves ranchers by slug — unroutable
    // REQUEST-ONLY exclusion (Ben, 2026-08-12). Rep Provisions is the
    // specialty grass-finished option for buyers who specifically request
    // it — never a first-touch wave, never a generic fallback. Their
    // nationwide service range was making them the default for 30+ states
    // in this table. The list is now SHARED with the live matcher
    // (lib/requestOnlyRanchers → app/api/matching/suggest, which had no
    // such exclusion at all until 2026-08-17); add a slug there and both
    // engines drop it. Deals/nudges and the rancher's own page/deep-link
    // are untouched. Preference-targeted waves become possible once the
    // quiz captures a grass-finished preference (no such Consumers field
    // exists today).
    if (isRequestOnlyRancher(r)) continue;
    // Sellability gate — never wave buyers at a page with nothing to buy.
    if (!isWaveSellable(r as Record<string, unknown>)) continue;
    const name =
      String((r as any)['Ranch Name'] || (r as any)['Operator Name'] || '').trim() || slug;
    const id = String((r as any).id || '');
    const home = normalizeState(r['State']);
    const zipGated = hasServiceZipGate(r as any);
    const load = Number((r as any)['Current Active Referrals'] || 0);
    for (const st of getOperationalServedStates(r)) {
      const bucket = byState.get(st) || [];
      bucket.push({ id, slug, name, zipGated, primary: home === st, load });
      byState.set(st, bucket);
    }
  }
  const table = new Map<string, StateRancher>();
  for (const [st, cands] of byState) {
    cands.sort((a, b) => {
      if (a.zipGated !== b.zipGated) return a.zipGated ? 1 : -1;
      if (a.primary !== b.primary) return a.primary ? -1 : 1;
      if (a.load !== b.load) return a.load - b.load;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
    const win = cands[0];
    table.set(st, { id: win.id, slug: win.slug, name: win.name });
  }
  return table;
}

// ── Claim / cross-rail predicates ───────────────────────────────────────────

/**
 * Has EITHER campaign rail ever claimed this buyer? Any of the claim fields
 * non-empty counts — the requalify rail writes Campaign Last Sent At +
 * Campaign Rail; the demand-router writes Campaign Last Sent At + Campaign
 * Stage. Checking all three means a partially-reverted claim still reads as
 * claimed (better a missed first touch than a double-send).
 */
export function isCampaignClaimed(fields: Record<string, unknown>): boolean {
  if (String(fields['Campaign Last Sent At'] || '').trim()) return true;
  const rail = fields['Campaign Rail'];
  const railStr =
    rail && typeof rail === 'object' && 'name' in (rail as Record<string, unknown>)
      ? String((rail as Record<string, unknown>).name || '')
      : String(rail || '');
  if (railStr.trim()) return true;
  const stage = fields['Campaign Stage'];
  const stageStr =
    stage && typeof stage === 'object' && 'name' in (stage as Record<string, unknown>)
      ? String((stage as Record<string, unknown>).name || '')
      : String(stage || '');
  return !!stageStr.trim();
}

/**
 * The 7d cross-rail belt: true when a demand-router Consumer-side stamp
 * (wave send or SMS recovery) landed within `days`. The claim check above
 * already excludes anyone the router EVER wave-touched; this belt covers the
 * SMS-recovery stamp (not a claim field) and any future revert edge.
 */
export function demandRouterTouchedWithinDays(
  fields: Record<string, unknown>,
  nowMs: number,
  days: number = CROSS_RAIL_SKIP_DAYS,
): boolean {
  const cutoff = nowMs - days * DAY_MS;
  for (const f of ['Campaign Last Sent At', CAMPAIGN_SMS_RECOVERY_FIELD]) {
    const v = fields[f];
    if (!v) continue;
    const t = new Date(String(v)).getTime();
    if (Number.isFinite(t) && t >= cutoff) return true;
  }
  return false;
}

// ── Wave selection ──────────────────────────────────────────────────────────

export type WaveSkipReason =
  | 'no-email'
  | 'synthetic'
  | 'suppressed-flags'
  | 'sunset-suppressed'
  | 'already-claimed'
  | 'cross-rail-7d'
  | 'mid-deal'
  | 'lane-national'
  | 'lane-customer'
  | 'no-state'
  | 'state-unserved'
  | 'duplicate-email'
  | 'beyond-budget';

export interface WaveRecipient {
  email: string;
  name: string;
  state: string;
}

export interface WaveBatch {
  rancherSlug: string;
  rancherName: string;
  state: string;
  /** ≤ MAX_BATCH recipients, engagement-recency ordered. */
  recipients: WaveRecipient[];
}

export interface WavePlan {
  /** Dispatch-ordered batches (most-engaged groups first), each ≤ MAX_BATCH. */
  batches: WaveBatch[];
  /** Total recipients across batches (≤ budget.remaining). */
  selected: number;
  /** Eligible pool size BEFORE the budget cut. */
  eligible: number;
  budget: BudgetDecision;
  skips: Partial<Record<WaveSkipReason, number>>;
  /** The rancher-for-state table actually used, for the Cron Runs log. */
  stateTable: Array<{ state: string; slug: string }>;
}

function readEnumish(v: unknown): string {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v !== null && 'name' in v) {
    return String((v as { name?: unknown }).name || '');
  }
  return String(v);
}

export interface SelectWavesInput {
  /** Raw Consumers rows (broad prefilter is the cron's concern; every gate
   * below re-checks purely). */
  consumers: Array<Record<string, unknown>>;
  /** Raw Ranchers rows (rancherForStateTable filters to operational). */
  ranchers: RancherFields[];
  /** activeDealBuyerKeys(referral rows) — mid-deal buyers are hands-off. */
  activeDeals: ActiveDealKeys;
  now: number;
  budget: BudgetInput;
}

/**
 * The whole autopilot decision, pure. First-touch pool → rancher-for-state →
 * engagement-recency order → budget cut → (rancher, state) batches of
 * ≤ MAX_BATCH.
 */
export function selectCampaignWaves(input: SelectWavesInput): WavePlan {
  const budget = decideBudget(input.budget);
  const table = rancherForStateTable(input.ranchers);
  const skips: Partial<Record<WaveSkipReason, number>> = {};
  const skip = (r: WaveSkipReason): void => {
    skips[r] = (skips[r] || 0) + 1;
  };

  interface Cand {
    email: string;
    name: string;
    state: string;
    rancher: StateRancher;
    activity: number;
  }
  const cands: Cand[] = [];
  for (const c of input.consumers) {
    const email = String(c['Email'] || '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      skip('no-email');
      continue;
    }
    if (isSyntheticTestEmail(email)) {
      skip('synthetic');
      continue;
    }
    if (c['Unsubscribed'] === true || c['Bounced'] === true || c['Complained'] === true) {
      skip('suppressed-flags');
      continue;
    }
    if (String(c['Notes'] || '').includes(SUNSET_SUPPRESSED_MARKER)) {
      skip('sunset-suppressed');
      continue;
    }
    if (isCampaignClaimed(c)) {
      skip('already-claimed');
      continue;
    }
    if (demandRouterTouchedWithinDays(c, input.now)) {
      skip('cross-rail-7d');
      continue;
    }
    const id = String((c as any).id || '');
    if ((id && input.activeDeals.ids.has(id)) || input.activeDeals.emails.has(email)) {
      skip('mid-deal');
      continue;
    }
    // Lane gate: the stored Routing Segment is the single lane engine
    // (reclassify-buyers owns freshness — NEVER re-derive lanes here). A
    // blank segment falls through to the state gate below, which is the
    // same served-state test the lane projection rests on.
    const segment = readEnumish(c['Routing Segment']);
    if (segment) {
      const lane = laneForSegment(segment);
      if (lane === 'national') {
        skip('lane-national');
        continue;
      }
      if (lane === 'customer') {
        skip('lane-customer');
        continue;
      }
    }
    const state = normalizeState(c['State']);
    if (!state) {
      skip('no-state');
      continue;
    }
    const rancher = table.get(state);
    if (!rancher) {
      skip('state-unserved');
      continue;
    }
    cands.push({
      email,
      name: String(c['Full Name'] || '').trim(),
      state,
      rancher,
      activity: lastActivityMs(c),
    });
  }

  // Engagement-recency order (most recently engaged first — the digest's
  // tier-1-first rule), email asc as the deterministic tiebreak.
  cands.sort((a, b) => {
    if (a.activity !== b.activity) return b.activity - a.activity;
    return a.email < b.email ? -1 : a.email > b.email ? 1 : 0;
  });

  // Duplicate-pair factory belt: one wave slot per email. The requalify
  // route claims EVERY matching Consumers row for the email it sends to, so
  // one slot fully claims the pair.
  const seen = new Set<string>();
  const deduped: Cand[] = [];
  for (const c of cands) {
    if (seen.has(c.email)) {
      skip('duplicate-email');
      continue;
    }
    seen.add(c.email);
    deduped.push(c);
  }

  const eligible = deduped.length;
  const taken = deduped.slice(0, budget.remaining);
  if (deduped.length > taken.length) {
    skips['beyond-budget'] = deduped.length - taken.length;
  }

  // Group by (rancher, state) in first-appearance order (≈ most-engaged
  // group first), then chunk each group to MAX_BATCH.
  const groups = new Map<string, { rancher: StateRancher; state: string; rows: Cand[] }>();
  for (const c of taken) {
    const key = `${c.rancher.slug} ${c.state}`;
    const g = groups.get(key);
    if (g) g.rows.push(c);
    else groups.set(key, { rancher: c.rancher, state: c.state, rows: [c] });
  }
  const batches: WaveBatch[] = [];
  for (const g of groups.values()) {
    for (let i = 0; i < g.rows.length; i += MAX_BATCH) {
      batches.push({
        rancherSlug: g.rancher.slug,
        rancherName: g.rancher.name,
        state: g.state,
        recipients: g.rows
          .slice(i, i + MAX_BATCH)
          .map((r) => ({ email: r.email, name: r.name, state: r.state })),
      });
    }
  }

  return {
    batches,
    selected: taken.length,
    eligible,
    budget,
    skips,
    stateTable: [...table.entries()]
      .map(([state, r]) => ({ state, slug: r.slug }))
      .sort((a, b) => (a.state < b.state ? -1 : 1)),
  };
}

/**
 * Distinct UTC days carrying ≥1 autopilot send, from Email Sends rows'
 * `Sent At` values — the ramp ladder's progress meter. Pure over injected
 * ISO strings so the cron's query stays thin.
 */
export function countDistinctSendDays(sentAtValues: ReadonlyArray<unknown>): number {
  const days = new Set<string>();
  for (const v of sentAtValues) {
    const t = new Date(String(v || '')).getTime();
    if (!Number.isFinite(t)) continue;
    days.add(new Date(t).toISOString().slice(0, 10));
  }
  return days.size;
}
