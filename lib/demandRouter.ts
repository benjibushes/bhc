// lib/demandRouter.ts
//
// THE DEMAND ROUTER — pure, side-effect-free selection + rendering logic for
// the capacity-gated backfill campaign (docs/NATIONWIDE-2-RANCHER-CAMPAIGN.md
// + docs/CAMPAIGN-SENDS.md). The cron at app/api/cron/demand-router/route.ts
// does all the I/O (Airtable reads, email/SMS sends, stamps, Telegram); this
// module decides WHO gets WHAT and proves it can't oversell.
//
// Everything here is a deterministic pure function over plain objects so it can
// be unit-tested with zero Airtable/network deps (node:test, mirrors
// lib/capacityCount.ts + lib/routingSegment.ts).
//
// SAFETY NOTE: buildCampaignPlan() NEVER sends or stamps. It returns a Plan
// describing exactly what WOULD happen. The cron renders that plan to
// Telegram in dry-run mode and only executes (send + stamp) when CAMPAIGN_LIVE.
// Capacity gating + dedupe live HERE, so the dry-run plan and the live run are
// guaranteed identical in their selection — Ben reviews the dry-run, then flips
// the flag and the same buyers get the same waves.

import { normalizeState } from './states';

// ─────────────────────────────────────────────────────────────────────
// COAST → RANCHER ROUTING
// WEST   → Foodstead (MT)            recYCVL85vofeqXAd / slug foodstead
// EAST   → Silverline Cattle Co (MO) recy4vT2788bxLTkD / slug silverline-cattle-co-mo
// CENTRAL→ Silverline (everything not WEST or EAST)
// State sets are verbatim from the task spec.
// ─────────────────────────────────────────────────────────────────────

export type Coast = 'WEST' | 'EAST' | 'CENTRAL';

export const FOODSTEAD = {
  id: 'recYCVL85vofeqXAd',
  slug: 'foodstead',
  name: 'Foodstead',
  ranchState: 'Montana',
} as const;

export const SILVERLINE = {
  id: 'recy4vT2788bxLTkD',
  slug: 'silverline-cattle-co-mo',
  name: 'Silverline Cattle Co',
  ranchState: 'Missouri',
} as const;

export interface RancherTarget {
  id: string;
  slug: string;
  name: string;
  ranchState: string;
}

// WEST = CA OR WA NV AZ ID UT MT WY CO NM AK HI
export const WEST_STATES: ReadonlySet<string> = new Set([
  'CA', 'WA', 'NV', 'AZ', 'ID', 'UT', 'MT', 'WY', 'CO', 'NM', 'AK', 'HI',
]);

// EAST = NY NJ PA MA CT RI VT NH ME MD DE VA NC SC GA FL WV DC
export const EAST_STATES: ReadonlySet<string> = new Set([
  'NY', 'NJ', 'PA', 'MA', 'CT', 'RI', 'VT', 'NH', 'ME', 'MD', 'DE',
  'VA', 'NC', 'SC', 'GA', 'FL', 'WV', 'DC',
]);

/**
 * Map a buyer's state (any spelling) to a coast. CENTRAL = the rest.
 * Returns null only when the state is blank/unrecognized — those buyers
 * cannot be routed (we never guess a coast).
 */
export function coastForState(rawState: unknown): Coast | null {
  const code = normalizeState(rawState);
  if (!code) return null;
  if (WEST_STATES.has(code)) return 'WEST';
  if (EAST_STATES.has(code)) return 'EAST';
  return 'CENTRAL';
}

/** WEST → Foodstead; EAST + CENTRAL → Silverline. */
export function rancherForCoast(coast: Coast): RancherTarget {
  return coast === 'WEST' ? { ...FOODSTEAD } : { ...SILVERLINE };
}

/** Convenience: state → rancher (null if state unroutable). */
export function rancherForState(rawState: unknown): RancherTarget | null {
  const coast = coastForState(rawState);
  return coast ? rancherForCoast(coast) : null;
}

// ─────────────────────────────────────────────────────────────────────
// TIER ORDERING (warm-back, deliverability)
//   1. stranded-qualified — Qualified At set, NO active referral
//   2. HOT                — Ready to Buy OR Warmup Engaged
//   3. WARM               — everything else still eligible
// Lower rank = contacted first.
// ─────────────────────────────────────────────────────────────────────

export type Tier = 'stranded-qualified' | 'hot' | 'warm';

export const TIER_RANK: Record<Tier, number> = {
  'stranded-qualified': 0,
  hot: 1,
  warm: 2,
};

// Referral statuses that mean the buyer is actively in a deal with a rancher
// (a "held" / active referral). A buyer with one of these is NOT stranded and
// must NOT be re-routed by the campaign — the rancher + operator own them.
// Mirrors lib/capacityCount HELD_REFERRAL_STATUSES + routingSegment's TERMINAL
// referral guard.
export const ACTIVE_REFERRAL_STATUSES: ReadonlySet<string> = new Set([
  'Intro Sent',
  'Rancher Contacted',
  'Negotiation',
  'Awaiting Payment',
  'Slot Locked',
  'Closed Won',
]);

function readEnumOrString(v: unknown): string {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v !== null && 'name' in v) {
    return String((v as { name?: unknown }).name || '');
  }
  return String(v);
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true' || v === 1;
}

function num(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** True if the buyer is currently in an active referral / deal. */
export function hasActiveReferral(buyer: Record<string, unknown>): boolean {
  const status = readEnumOrString(buyer['Referral Status']);
  if (status && ACTIVE_REFERRAL_STATUSES.has(status)) return true;
  // Buyer Stage MATCHED is the lifecycle mirror of "in a deal".
  const stage = readEnumOrString(buyer['Buyer Stage']);
  if (stage === 'MATCHED') return true;
  return false;
}

/**
 * Classify the buyer's warm-back tier, or null if the buyer doesn't qualify
 * for ANY tier (no intent signal at all → not contacted this round).
 *
 * stranded-qualified: passed the quiz (Qualified At + score>=75) AND has no
 *   active referral — the highest-value "we dropped the ball" cohort.
 * hot: explicit purchase intent — Ready to Buy OR Warmup Engaged At.
 * warm: any other still-contactable lead with a usable intent score.
 */
export function classifyTier(
  buyer: Record<string, unknown>,
  opts: { warmMinIntent?: number } = {},
): Tier | null {
  const warmMinIntent = opts.warmMinIntent ?? 1;

  const qualifiedAt = buyer['Qualified At'];
  const qualScore = num(buyer['Qualification Score']);
  if (qualifiedAt && qualScore >= 75 && !hasActiveReferral(buyer)) {
    return 'stranded-qualified';
  }

  const readyToBuy = asBool(buyer['Ready to Buy']);
  const engaged = !!buyer['Warmup Engaged At'];
  if (readyToBuy || engaged) return 'hot';

  // WARM — a still-contactable lead. Require SOME intent signal so we don't
  // pull in pure tire-kickers (deliverability). Intent Score OR a high Intent
  // Classification both count.
  const intent = num(buyer['Intent Score']);
  const intentClass = readEnumOrString(buyer['Intent Classification']).toLowerCase();
  if (intent >= warmMinIntent || intentClass === 'high' || intentClass === 'medium') {
    return 'warm';
  }
  return null;
}

/**
 * Derive the buyer's cut ('quarter'|'half'|'whole') from the Order Type field
 * (values like "Quarter", "Half", "Whole", or "Quarter Cow"). Returns null for
 * "Not Sure"/blank/unrecognized — the 1-tap reserve token requires a real cut,
 * so a null means the cron must use the rancher-page fallback instead.
 * Pure + deterministic. Mirrors CUT_LABELS keys in lib/reserveDeposit.
 */
export function cutForBuyer(buyer: Record<string, unknown>): 'quarter' | 'half' | 'whole' | null {
  const raw = readEnumOrString(buyer['Order Type']).trim().toLowerCase();
  if (!raw) return null;
  const first = raw.split(/\s+/)[0]; // "quarter cow" → "quarter"
  if (first === 'quarter' || first === 'half' || first === 'whole') return first;
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// SUPPRESSION  (deliverability + compliance + anti-spam)
//   - unsubscribed / bounced / complained          → excluded forever
//   - contacted in the last 7 days (any channel)   → excluded this run
//   - 18-month-dead (no activity in 18 months)     → excluded up front
//   - already sunset by this campaign              → excluded
//   - no email on record                           → can't send
// ─────────────────────────────────────────────────────────────────────

export const DAY_MS = 24 * 60 * 60 * 1000;
export const RECENT_CONTACT_DAYS = 7;
export const DEAD_MONTHS = 18;

export type SuppressReason =
  | 'unsubscribed'
  | 'bounced'
  | 'complained'
  | 'no-email'
  | 'synthetic-test'
  | 'recent-contact'
  | '18-month-dead'
  | 'already-sunset';

// RFC 2606 / RFC 6761 reserved TLDs — these can NEVER be real, deliverable
// domains. Matched on the domain SUFFIX so subdomains count too
// (e.g. foo@e2e.reserved.invalid → ".invalid"). Kept deliberately tight so a
// real buyer is never caught.
const RESERVED_TLDS: readonly string[] = ['.invalid', '.test', '.local', '.example'];

// Local-part prefixes used by internal synthetic/test harnesses. The BHC audit
// skill mints probe addresses like `probe-audit-...@...` — never a real buyer.
const SYNTHETIC_LOCAL_PREFIXES: readonly string[] = ['probe-audit'];

/**
 * True iff the email is a synthetic / non-deliverable TEST address that must
 * never receive a campaign send. PRECISE on purpose (reserved TLDs + a known
 * audit-probe local-part prefix) so it can't false-positive a real buyer.
 * Pure + case-insensitive.
 */
export function isSyntheticTestEmail(email: string): boolean {
  const e = String(email || '').trim().toLowerCase();
  if (!e || !e.includes('@')) return false;
  const at = e.lastIndexOf('@');
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  if (RESERVED_TLDS.some((tld) => domain === tld.slice(1) || domain.endsWith(tld))) return true;
  // Prefix must be a WHOLE local-part token — either the entire local-part, or
  // immediately followed by a delimiter (`-` `_` `.` `+`). So `probe-audit-123`
  // / `probe-audit` match, but a real `probe-audithon` does NOT. Maximally
  // precise so a real buyer is never caught.
  for (const p of SYNTHETIC_LOCAL_PREFIXES) {
    if (local === p) return true;
    if (local.startsWith(p) && /[-_.+]/.test(local.charAt(p.length))) return true;
  }
  return false;
}

/**
 * The most-recent "we last touched / heard from this buyer" timestamp across
 * every activity field. Used by BOTH the 7-day recency guard and the 18-month
 * dead cutoff. Campaign Last Sent At is included so a campaign send counts as
 * recent contact (idempotency belt-and-suspenders).
 */
export function lastActivityMs(buyer: Record<string, unknown>): number {
  const fields = [
    'Campaign Last Sent At',
    'Last Contacted At',
    'Last Contacted',
    'Last Email Event At',
    'Last Email Delivered At',
    'Last Email Opened At',
    'Last Email Clicked At',
    'Routing Segment Last Sent At',
    'Sequence Sent At',
    'Warmup Sent At',
    'Warmup Engaged At',
    'Qualified At',
    'Buyer Stage Updated At',
    'Approved At',
    'Created',
  ];
  let max = 0;
  for (const f of fields) {
    const v = buyer[f];
    if (!v) continue;
    const t = new Date(v as string).getTime();
    if (Number.isFinite(t) && t > max) max = t;
  }
  return max;
}

/**
 * Returns a SuppressReason if the buyer must be skipped this run, else null.
 * `now` is injected for deterministic testing.
 */
export function suppressionReason(
  buyer: Record<string, unknown>,
  now: number,
): SuppressReason | null {
  if (asBool(buyer['Unsubscribed'])) return 'unsubscribed';
  if (asBool(buyer['Bounced'])) return 'bounced';
  if (asBool(buyer['Complained'])) return 'complained';

  const email = String(buyer['Email'] || '').trim();
  if (!email) return 'no-email';

  // Synthetic / non-deliverable test addresses (E2E records, audit probes) must
  // NEVER be emailed. Checked right after the email-presence guard so it short-
  // circuits before any send decision.
  if (isSyntheticTestEmail(email)) return 'synthetic-test';

  // Already sunset by this campaign → never re-enter.
  const stage = readEnumOrString(buyer['Campaign Stage']);
  if (stage === 'Sunset' || buyer['Campaign Sunset At']) return 'already-sunset';

  // 18-month-dead — exclude up front (deliverability). A buyer we've literally
  // never recorded activity for (max=0) is treated as dead too.
  const last = lastActivityMs(buyer);
  const deadCutoff = now - DEAD_MONTHS * 30 * DAY_MS;
  if (last === 0 || last < deadCutoff) return '18-month-dead';

  // Contacted in the last 7 days by a NON-campaign channel → don't pile on.
  // NOTE: a prior campaign wave (`Campaign Last Sent At`) is intentionally NOT
  // checked here — the campaign's own cadence is governed by decideWave()'s
  // 3-/4-day wave gaps (which are <7d by design), and that gate is idempotent.
  // If we treated our own Msg1 as "recent contact" we'd permanently stall the
  // arc at Msg1 and Msg2/Msg3 would never fire. (`Campaign Last Sent At` still
  // counts as activity in lastActivityMs above, so it keeps the buyer alive.)
  const lastContacted = buyer['Last Contacted At'] || buyer['Last Contacted'];
  if (lastContacted) {
    const t = new Date(lastContacted as string).getTime();
    if (Number.isFinite(t) && now - t < RECENT_CONTACT_DAYS * DAY_MS) {
      return 'recent-contact';
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// WAVE PROGRESSION  (Msg1 day 0 → Msg2 day +3 → Msg3 day +7)
// Tracked per buyer via `Campaign Stage` + `Campaign Last Sent At`.
// Idempotent: a buyer already at a stage cannot be re-sent that wave; the
// next wave only unlocks once the spacing gap has elapsed.
// ─────────────────────────────────────────────────────────────────────

export type Wave = 'Msg1' | 'Msg2' | 'Msg3';

export const CAMPAIGN_STAGE_FOR_WAVE: Record<Wave, string> = {
  Msg1: 'Msg1 Sent',
  Msg2: 'Msg2 Sent',
  Msg3: 'Msg3 Sent',
};

// Days that must elapse AFTER the prior wave before the next fires.
// Msg1→Msg2 = +3, Msg2→Msg3 = +4 (so Msg3 lands ~day 7 from Msg1).
export const WAVE_GAP_DAYS: Record<'Msg2' | 'Msg3', number> = {
  Msg2: 3,
  Msg3: 4,
};

export type WaveDecision =
  | { send: true; wave: Wave }
  | { send: false; reason: 'cooldown' | 'arc-complete' };

/**
 * Decide the next wave to send to a buyer given their current campaign stamp.
 * Pure + deterministic (now injected).
 *
 *  - no stage           → Msg1 (day 0)
 *  - Msg1 Sent + >=3d   → Msg2
 *  - Msg2 Sent + >=4d   → Msg3
 *  - Msg3 Sent          → arc-complete (caller sunsets if no engagement)
 *  - within the gap     → cooldown (idempotent: never double-send a wave)
 */
export function decideWave(
  buyer: Record<string, unknown>,
  now: number,
): WaveDecision {
  const stage = readEnumOrString(buyer['Campaign Stage']);
  const lastSentRaw = buyer['Campaign Last Sent At'];
  const lastSent = lastSentRaw ? new Date(lastSentRaw as string).getTime() : 0;
  const daysSince = lastSent ? (now - lastSent) / DAY_MS : Infinity;

  if (!stage || stage === '') return { send: true, wave: 'Msg1' };
  if (stage === 'Msg1 Sent') {
    return daysSince >= WAVE_GAP_DAYS.Msg2
      ? { send: true, wave: 'Msg2' }
      : { send: false, reason: 'cooldown' };
  }
  if (stage === 'Msg2 Sent') {
    return daysSince >= WAVE_GAP_DAYS.Msg3
      ? { send: true, wave: 'Msg3' }
      : { send: false, reason: 'cooldown' };
  }
  // Msg3 Sent or Sunset → arc done.
  return { send: false, reason: 'arc-complete' };
}

/**
 * True if a buyer finished the full 3-wave arc with no engagement and is past
 * the final cooldown → should be sunset (suppress, protect reputation).
 * "No engagement" = never clicked/opened a campaign-era email AND never
 * advanced to Ready to Buy / an active referral since Msg1.
 */
export function shouldSunset(
  buyer: Record<string, unknown>,
  now: number,
): boolean {
  const stage = readEnumOrString(buyer['Campaign Stage']);
  if (stage !== 'Msg3 Sent') return false;
  const lastSentRaw = buyer['Campaign Last Sent At'];
  const lastSent = lastSentRaw ? new Date(lastSentRaw as string).getTime() : 0;
  if (!lastSent) return false;
  // Give Msg3 a few days to land before sunsetting.
  if (now - lastSent < WAVE_GAP_DAYS.Msg3 * DAY_MS) return false;
  // Engaged at all? Then don't sunset — keep them.
  if (engagedSinceCampaign(buyer)) return false;
  return true;
}

/** Did the buyer show ANY positive engagement (clicked/ready/in-deal)? */
export function engagedSinceCampaign(buyer: Record<string, unknown>): boolean {
  if (asBool(buyer['Ready to Buy'])) return true;
  if (hasActiveReferral(buyer)) return true;
  if (num(buyer['Email Clicks']) > 0) return true;
  if (buyer['Last Email Clicked At']) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────
// CAPACITY-GATED BATCH SIZING
//
// THE CUMULATIVE-CAP INVARIANT (the over-invite fix):
//   A Msg1 invite does NOT consume an open slot — slots only decrement when a
//   buyer actually books a deposit. So a per-RUN ceiling of openSlots×buffer
//   resets every hourly run and would re-invite a fresh batch each hour against
//   the SAME unfilled slots → ~24× over-invite/day → breaks "cannot oversell"
//   AND honest scarcity ("a few shares left" sent to 144 people for 2 shares).
//
//   The fix: the cap bounds the CUMULATIVE invited-but-unconverted POPULATION,
//   not per-run throughput. New (Msg1) invites get a budget of
//       max(0, openSlots×buffer − outstandingInvites)
//   where outstandingInvites = buyers already in the arc (Campaign Stage ∈
//   {Msg1/2/3 Sent}) who haven't converted (no active referral) and aren't
//   sunset. Msg2/Msg3 are CONTINUATIONS of already-counted buyers, so they send
//   OUTSIDE that budget — arcs always complete.
//
//   Net invariant: invited-but-unconverted population per coast can never
//   exceed openSlots×buffer, no matter how many runs execute.
// ─────────────────────────────────────────────────────────────────────

export const DEFAULT_DAILY_CAP = 25; // per coast, per run — deliverability pace
export const DEFAULT_CONVERSION_BUFFER = 3; // invite ~3 per open slot (win-back ~8-15%)

/**
 * Total invite capacity for a coast = openSlots × buffer (the absolute ceiling
 * on the outstanding-invited population). NOT per-run — see the cumulative-cap
 * invariant above. Clamped >= 0.
 */
export function inviteCapacity(
  openSlots: number,
  opts: { conversionBuffer?: number } = {},
): number {
  const buffer = opts.conversionBuffer ?? DEFAULT_CONVERSION_BUFFER;
  const slots = Math.max(0, Math.floor(openSlots));
  if (slots <= 0) return 0;
  return slots * Math.max(1, buffer);
}

/**
 * How many NEW (Msg1) buyers we may invite for a coast THIS run.
 *
 *   = clamp( inviteCapacity(openSlots) − outstandingInvites , 0, dailyCap )
 *
 * The cumulative term (− outstandingInvites) is what stops the per-run ceiling
 * from resetting each hour; the dailyCap term just paces a cold-start burst so
 * we don't fire the whole budget in one tick (deliverability ramp).
 *
 * Returns 0 when there are no open slots OR the outstanding population already
 * fills the ceiling — the caller then waitlists that coast's new demand.
 */
export function newInviteBudget(
  openSlots: number,
  outstandingInvites: number,
  opts: { dailyCap?: number; conversionBuffer?: number } = {},
): number {
  const dailyCap = opts.dailyCap ?? DEFAULT_DAILY_CAP;
  const ceiling = inviteCapacity(openSlots, opts);
  const remaining = Math.max(0, ceiling - Math.max(0, Math.floor(outstandingInvites)));
  return Math.max(0, Math.min(dailyCap, remaining));
}

/**
 * @deprecated Use newInviteBudget (cumulative) for Msg1 sizing. Retained only
 * for the per-run ceiling notion; equals min(dailyCap, openSlots×buffer).
 * Kept exported for back-compat with any external caller + the unit tests that
 * assert the per-run math.
 */
export function sizeBatch(
  openSlots: number,
  opts: { dailyCap?: number; conversionBuffer?: number } = {},
): number {
  const dailyCap = opts.dailyCap ?? DEFAULT_DAILY_CAP;
  return Math.max(0, Math.min(dailyCap, inviteCapacity(openSlots, opts)));
}

/**
 * Count buyers who are ALREADY in the campaign arc and still occupy an invite
 * slot — i.e. invited (Campaign Stage ∈ {Msg1/2/3 Sent}) but NOT yet converted
 * (no active referral) and NOT sunset. This is the cumulative term subtracted
 * from the invite ceiling so re-runs can't re-fill the same slots.
 *
 * Pure. `coastOf` lets the caller bucket by coast (WEST vs EAST/CENTRAL pooled);
 * pass a function returning the buyer's coast or null (unroutable → not counted).
 */
export function countOutstandingInvites(
  buyers: CampaignBuyer[],
  coastOf: (f: Record<string, unknown>) => Coast | null,
): { west: number; eastCentral: number } {
  let west = 0;
  let eastCentral = 0;
  for (const b of buyers) {
    const f = b.fields;
    const stage = readEnumOrString(f['Campaign Stage']);
    const invited = stage === 'Msg1 Sent' || stage === 'Msg2 Sent' || stage === 'Msg3 Sent';
    if (!invited) continue;
    if (f['Campaign Sunset At']) continue; // sunset → slot released
    if (hasActiveReferral(f)) continue; // converted/in-deal → consumes a real slot, not an invite
    const coast = coastOf(f);
    if (!coast) continue;
    if (coast === 'WEST') west++;
    else eastCentral++;
  }
  return { west, eastCentral };
}

/**
 * Compute open deposit slots for a rancher from raw field values.
 * Mirrors lib/rancherCapacity.getMaxActiveReferrals (reads BOTH the typo'd
 * `Max Active Referalls` and the corrected spelling). Clamped at >= 0.
 */
export function openSlotsFor(rancher: {
  max?: number;
  current?: number;
}): number {
  const max = Math.max(0, num(rancher.max));
  const current = Math.max(0, num(rancher.current));
  return Math.max(0, max - current);
}

// ─────────────────────────────────────────────────────────────────────
// THE PLANNER — pure. Decides the full set of actions for a run with NO
// side effects. The cron executes (or, in dry-run, just reports) this plan.
// ─────────────────────────────────────────────────────────────────────

export interface CampaignBuyer {
  id: string;
  fields: Record<string, unknown>;
}

export interface CapacityInput {
  /** Open deposit slots for Foodstead (WEST). */
  west: number;
  /** Open deposit slots for Silverline (EAST + CENTRAL). */
  eastCentral: number;
}

export interface PlannedSend {
  buyerId: string;
  email: string;
  firstName: string;
  state: string; // normalized 2-letter
  coast: Coast;
  rancher: RancherTarget;
  tier: Tier;
  wave: Wave;
  /** True only if the buyer is SMS-opted-in (TCPA) AND this wave has an SMS variant. */
  sms: boolean;
  phone: string;
  /**
   * The buyer's chosen cut ('quarter'|'half'|'whole') derived from Order Type,
   * or null if unknown/unsure. Drives the 1-tap reserve token (the deposit
   * checkout needs a cut). When null, the cron falls back to the rancher page.
   */
  cut: 'quarter' | 'half' | 'whole' | null;
}

export interface PlannedWaitlist {
  buyerId: string;
  state: string;
  coast: Coast;
  reason: 'rancher-at-capacity';
}

export interface PlannedSunset {
  buyerId: string;
  reason: 'full-arc-no-engagement';
}

export interface CampaignPlan {
  sends: PlannedSend[];
  waitlist: PlannedWaitlist[];
  sunset: PlannedSunset[];
  suppressed: Record<SuppressReason, number>;
  /** Open vs filled per rancher, for the report. */
  capacity: {
    // open = open deposit slots; outstanding = already-invited-unconverted
    // population; newBudget = remaining NEW-invite budget this run (the
    // cumulative cap); planned = sends actually planned for the coast.
    west: { open: number; outstanding: number; newBudget: number; planned: number };
    eastCentral: { open: number; outstanding: number; newBudget: number; planned: number };
  };
  /** Sends grouped by wave, for the report. */
  byWave: Record<Wave, number>;
  /** Waitlist counts grouped by state, for the report. */
  waitlistByState: Record<string, number>;
}

export interface BuildPlanOpts {
  now: number;
  capacity: CapacityInput;
  dailyCap?: number;
  conversionBuffer?: number;
  /** Waves that have an SMS variant (only Msg2 per CAMPAIGN-SENDS.md). */
  smsWaves?: ReadonlySet<Wave>;
}

const DEFAULT_SMS_WAVES: ReadonlySet<Wave> = new Set<Wave>(['Msg2']);

function firstNameOf(buyer: Record<string, unknown>): string {
  const full = String(buyer['Full Name'] || '').trim();
  return full.split(/\s+/)[0] || 'there';
}

function emptySuppressed(): Record<SuppressReason, number> {
  return {
    unsubscribed: 0,
    bounced: 0,
    complained: 0,
    'no-email': 0,
    'synthetic-test': 0,
    'recent-contact': 0,
    '18-month-dead': 0,
    'already-sunset': 0,
  };
}

/**
 * Build the full campaign plan for ONE run. Pure: no Airtable, no network, no
 * mutation of inputs. Deterministic given (buyers, now, capacity).
 *
 * Algorithm:
 *  1. For every buyer: suppress-check → tally + drop.
 *  2. Classify coast (drop unroutable states) + tier.
 *  3. Sunset buyers who finished the arc w/ no engagement (does not consume a slot).
 *  4. Decide the next wave; drop cooldown/arc-complete.
 *  5. Sort eligible buyers per coast by (tier rank, then a deterministic
 *     intent/score desc) so the highest-intent go first.
 *  6. CUMULATIVE capacity gate per coast:
 *       - Msg2/Msg3 (continuations) ALWAYS send — they're already counted in
 *         the outstanding-invited population, so completing their arc consumes
 *         no NEW invite budget.
 *       - Msg1 (new invites) get newInviteBudget = clamp(openSlots×buffer −
 *         outstandingInvites, 0, dailyCap). HOT/stranded over that budget →
 *         state-waitlist; WARM rolls to a future run.
 *     This bounds the invited-but-unconverted population at openSlots×buffer
 *     across ALL runs (fixes the per-run reset → ~24× over-invite bug).
 */
export function buildCampaignPlan(
  buyers: CampaignBuyer[],
  opts: BuildPlanOpts,
): CampaignPlan {
  const { now, capacity } = opts;
  const smsWaves = opts.smsWaves ?? DEFAULT_SMS_WAVES;
  const suppressed = emptySuppressed();
  const sunset: PlannedSunset[] = [];

  // Cumulative term: how many already-invited, unconverted, non-sunset buyers
  // each coast is already carrying. New (Msg1) invites are budgeted against
  // openSlots×buffer MINUS this — so re-runs can't re-fill the same slots.
  const outstanding = countOutstandingInvites(buyers, (f) => coastForState(f['State']));

  // Eligible-to-send candidates, bucketed by coast (EAST + CENTRAL share
  // Silverline's slot pool, so we bucket them together as "eastCentral").
  // Msg1 (new) and continuation (Msg2/Msg3) candidates are kept in SEPARATE
  // buckets because only Msg1 is bound by the cumulative new-invite budget.
  interface Cand extends PlannedSend {
    sortIntent: number;
  }
  const westNew: Cand[] = [];
  const eastCentralNew: Cand[] = [];
  const westCont: Cand[] = [];
  const eastCentralCont: Cand[] = [];

  for (const b of buyers) {
    const f = b.fields;

    // 1. Suppression.
    const sr = suppressionReason(f, now);
    if (sr) {
      suppressed[sr]++;
      continue;
    }

    // 3. Sunset (before wave decision; arc-complete + no-engagement).
    if (shouldSunset(f, now)) {
      sunset.push({ buyerId: b.id, reason: 'full-arc-no-engagement' });
      continue;
    }

    // 2. Coast + tier.
    const coast = coastForState(f['State']);
    if (!coast) continue; // unroutable state — can't pick a rancher
    const tier = classifyTier(f);
    if (!tier) continue; // no intent signal at all → not this round

    // 4. Wave decision (idempotent).
    const decision = decideWave(f, now);
    if (!decision.send) continue;

    const rancher = rancherForCoast(coast);
    const wave = decision.wave;
    const smsOptIn = asBool(f['SMS Opt-In']);
    const phone = String(f['Phone'] || '').trim();
    const cand: Cand = {
      buyerId: b.id,
      email: String(f['Email'] || '').trim(),
      firstName: firstNameOf(f),
      state: normalizeState(f['State']),
      coast,
      rancher,
      tier,
      wave,
      sms: smsOptIn && !!phone && smsWaves.has(wave),
      phone,
      cut: cutForBuyer(f),
      sortIntent: num(f['Intent Score']) + num(f['Qualification Score']),
    };
    // Split by NEW (Msg1) vs CONTINUATION (Msg2/Msg3). Only Msg1 is bound by
    // the cumulative new-invite budget; continuations always complete.
    const isNew = wave === 'Msg1';
    if (coast === 'WEST') (isNew ? westNew : westCont).push(cand);
    else (isNew ? eastCentralNew : eastCentralCont).push(cand);
  }

  // 5. Sort each NEW pool: tier rank asc, then intent desc, then buyerId for a
  // fully deterministic order (stable across runs given identical data).
  const byPriority = (a: Cand, b: Cand): number => {
    const t = TIER_RANK[a.tier] - TIER_RANK[b.tier];
    if (t !== 0) return t;
    if (b.sortIntent !== a.sortIntent) return b.sortIntent - a.sortIntent;
    return a.buyerId < b.buyerId ? -1 : a.buyerId > b.buyerId ? 1 : 0;
  };
  westNew.sort(byPriority);
  eastCentralNew.sort(byPriority);

  // 6. CUMULATIVE capacity gate per coast (new invites only).
  const westOpen = Math.max(0, Math.floor(capacity.west));
  const eastOpen = Math.max(0, Math.floor(capacity.eastCentral));
  const westBudget = newInviteBudget(westOpen, outstanding.west, opts);
  const eastBudget = newInviteBudget(eastOpen, outstanding.eastCentral, opts);

  const sends: PlannedSend[] = [];
  const waitlist: PlannedWaitlist[] = [];

  const stripSort = (c: Cand): PlannedSend => {
    const { sortIntent: _omit, ...rest } = c;
    return rest;
  };

  // Continuations (Msg2/Msg3) ALWAYS send — already counted in outstanding.
  for (const c of westCont) sends.push(stripSort(c));
  for (const c of eastCentralCont) sends.push(stripSort(c));

  // New invites (Msg1) are gated by the cumulative budget; HOT/stranded over
  // budget → state-waitlist, WARM rolls forward.
  function applyNew(cands: Cand[], budget: number, coast: Coast) {
    for (let i = 0; i < cands.length; i++) {
      if (i < budget) {
        sends.push(stripSort(cands[i]));
      } else if (cands[i].tier !== 'warm') {
        waitlist.push({
          buyerId: cands[i].buyerId,
          state: cands[i].state,
          coast,
          reason: 'rancher-at-capacity',
        });
      }
    }
  }
  applyNew(westNew, westBudget, 'WEST');
  applyNew(eastCentralNew, eastBudget, 'CENTRAL'); // coast label informational; EAST+CENTRAL pooled

  // Reports.
  const byWave: Record<Wave, number> = { Msg1: 0, Msg2: 0, Msg3: 0 };
  for (const s of sends) byWave[s.wave]++;
  const waitlistByState: Record<string, number> = {};
  for (const w of waitlist) {
    const key = w.state || 'unknown';
    waitlistByState[key] = (waitlistByState[key] || 0) + 1;
  }

  return {
    sends,
    waitlist,
    sunset,
    suppressed,
    capacity: {
      west: {
        open: westOpen,
        outstanding: outstanding.west,
        newBudget: westBudget,
        planned: sends.filter((s) => s.coast === 'WEST').length,
      },
      eastCentral: {
        open: eastOpen,
        outstanding: outstanding.eastCentral,
        newBudget: eastBudget,
        planned: sends.filter((s) => s.coast !== 'WEST').length,
      },
    },
    byWave,
    waitlistByState,
  };
}

// ─────────────────────────────────────────────────────────────────────
// MESSAGE RENDERING  (copy verbatim from docs/CAMPAIGN-SENDS.md)
// Tokens: {first} {state} {rancher} {ranchstate} {link}
// On-brand: lowercase, honest scarcity, "— Ben". No hype.
// ─────────────────────────────────────────────────────────────────────

export interface RenderCtx {
  firstName: string;
  state: string; // 2-letter or full — we display as given
  rancher: RancherTarget;
  /** Personalized 1-tap deposit link, or the rancher-page fallback URL. */
  link: string;
}

export interface RenderedMessage {
  subject: string;
  /** Plain-text body (the canonical campaign copy). */
  text: string;
  /** Minimal HTML wrapper of the same copy for the email channel. */
  html: string;
  /** SMS body (opt-in only) — null when the wave has no SMS variant. */
  sms: string | null;
}

function tok(s: string, ctx: RenderCtx): string {
  return s
    .replace(/\{first\}/g, ctx.firstName)
    .replace(/\{state\}/g, ctx.state)
    .replace(/\{rancher\}/g, ctx.rancher.name)
    .replace(/\{ranchstate\}/g, ctx.rancher.ranchState)
    .replace(/\{link\}/g, ctx.link);
}

function esc(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Render plain text to a minimal, on-brand HTML body. Links become anchors.
function textToHtml(text: string, ctx: RenderCtx): string {
  const safe = esc(text)
    // turn the bare link into a styled anchor
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (t === esc(ctx.link)) {
        return `<p style="margin:18px 0;"><a href="${esc(ctx.link)}" style="color:#0E0E0E;font-weight:600;text-decoration:underline;">${esc(ctx.link)}</a></p>`;
      }
      if (t === '') return '';
      return `<p style="margin:14px 0;color:#2A2A2A;font-size:15px;line-height:1.6;">${line}</p>`;
    })
    .filter(Boolean)
    .join('\n');
  return `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;color:#0E0E0E;">${safe}</div>`;
}

export const SUBJECTS: Record<Wave, string> = {
  Msg1: 'your beef’s ready (ships to {state})',
  Msg2: 'a few shares left ({rancher})',
  Msg3: 'why we’re doing this',
};

// Bodies are the EXACT copy from docs/CAMPAIGN-SENDS.md (tokenized).
const BODY_MSG1 = `hey {first},

you raised your hand for real beef a while back — we didn't forget.

straight talk: we're building a network of local ranchers in {state}, doing it
the right way. that takes time, and we don't cut corners.

but you don't have to wait. {rancher} — a {ranchstate} family raising grass-fed
beef the way it should be — can ship a share straight to your door. cold-chain,
arrives frozen, raised right.

limited shares this round. reserve yours:
{link}

— Ben`;

const BODY_MSG2 = `{first} — quick one. {rancher} has only a few shares left this round — shipped to
{state}, grass-fed, raised right. if you want one:
{link}
— Ben`;

const BODY_MSG3 = `quick one, {first}.

the mission is a real local rancher in every community — beef raised right, sold
direct, families over feedlots. we're locking that in state by state, and it's
working.

until your local rancher is live, {rancher} has you covered — same standard,
shipped to your door.

this is the start of something big. glad you're in it.
{link}
— Ben`;

const BODIES: Record<Wave, string> = {
  Msg1: BODY_MSG1,
  Msg2: BODY_MSG2,
  Msg3: BODY_MSG3,
};

// SMS variant — only Msg2 has one per the doc. Always carries STOP.
const SMS_MSG2 = `BuyHalfCow: only a few shares left from {rancher} — ships to {state}, grass-fed, raised right. reserve: {link}
reply STOP to opt out`;

const SMS_BODIES: Partial<Record<Wave, string>> = {
  Msg2: SMS_MSG2,
};

/** Render a wave's full message set for a buyer. Pure. */
export function renderMessage(wave: Wave, ctx: RenderCtx): RenderedMessage {
  const subject = tok(SUBJECTS[wave], ctx);
  const text = tok(BODIES[wave], ctx);
  const smsTemplate = SMS_BODIES[wave];
  return {
    subject,
    text,
    html: textToHtml(text, ctx),
    sms: smsTemplate ? tok(smsTemplate, ctx) : null,
  };
}

/**
 * The campaign-reserve link for a buyer. Prefers a 1-tap token minted by
 * `mintCampaignReserveToken` (feat/campaign-1tap-links) if that helper exists;
 * otherwise falls back to the rancher's public page. This module stays pure —
 * the cron passes the resolved link in; this helper just builds the fallback.
 */
export function rancherPageUrl(siteUrl: string, rancher: RancherTarget): string {
  const base = siteUrl.replace(/\/+$/, '');
  return `${base}/ranchers/${rancher.slug}`;
}

// Template names for the email frequency-guard whitelist (the campaign engine
// owns cadence, not the 3/week cap). Kept here so the sender + the guard agree.
export const CAMPAIGN_TEMPLATE_NAMES: Record<Wave, string> = {
  Msg1: 'demandRouterMsg1',
  Msg2: 'demandRouterMsg2',
  Msg3: 'demandRouterMsg3',
};

/** The Email Sends `Campaign` tag for this campaign (analytics linkage). */
export const CAMPAIGN_NAME = 'demand-router-backfill';
