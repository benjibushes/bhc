// lib/rancherReactivationSegment.ts
//
// Pure segmentation for the Rancher Reactivation Campaign.
//
// One responsibility: given ALL rancher records + "now", return which
// ranchers should get a first touch (Tier A warm first, then Tier B cold),
// which are due a +5d reminder, and which have gone silent and should be
// marked dormant. No I/O, no Airtable, no email — the cron
// (app/api/cron/rancher-reactivation) owns side-effects + the daily cap.
//
// Audience (per 2026-06-13 plan):
//   Tier A (warm): Pricing Model = legacy AND Onboarding Status in
//     {Call Complete, Docs Sent, Verification Complete} AND NOT
//     (Active Status = Active AND Onboarding Status = Live).
//   Tier B (cold): Pricing Model = legacy AND Onboarding Status empty/blank.
//
// Always excluded: tier_v2, the hardcoded EXCLUDE_RANCHER_IDS allowlist
//   (Wave-1 closers + manual hold-outs + active-live + Left Hand + dup
//   Renick), suppression flags (Unsubscribed/Bounced/Complained), and the
//   named test rows.
//
// Cadence (sanity-paced, enforced here so the cron stays a thin driver):
//   - untouched (Touch Count 0 / no Last Campaign Email Sent At) → first send
//   - Last Campaign Email Sent At < 5d ago → skip (too soon)
//   - +5d, no booking, not unsubscribed, Touch Count < 2 → ONE reminder
//   - +10d silent, Touch Count >= 2, no booking → mark dormant
//   - a booking (Migration Status=call_scheduled OR a Cal booking stamp)
//     drops the rancher out of every bucket — they self-served, leave alone.

const DAY_MS = 24 * 60 * 60 * 1000;
const REMINDER_AFTER_DAYS = 5;
const DORMANT_AFTER_DAYS = 10;

/**
 * Ranchers that must NEVER receive a reactivation email, by Airtable record
 * id. Field-based tier filters run on top of this, but these ids are
 * hardcoded to make double-contact impossible regardless of field drift.
 *
 *   - Wave-1 closers (already in a separate soft-invite send)
 *   - Manual hold-outs (Ben is handling these 1:1)
 *   - Left Hand Cattle (mid-funnel — Call Scheduled)
 *   - Duplicate Renick (paused dup of Gajewski)
 *
 * Active+Live legacy ranchers already getting leads are excluded by the
 * tier filters (they don't match Tier A's "not live" clause or Tier B's
 * "blank onboarding" clause), so they don't need ids here — but the
 * Wave-1/hold-out/Left-Hand/dup ids do, because some of them WOULD
 * otherwise match a tier.
 */
export const EXCLUDE_RANCHER_IDS: ReadonlySet<string> = new Set<string>([
  // ── Wave-1 closers ────────────────────────────────────────────────
  'recUpqF6yUAULpbPG',
  'recawSbn7dhszHQl5',
  'recVTmaMqVw191TQv',
  'recBkfqjMQ2txI8AM',
  'recy4vT2788bxLTkD',
  'rec2ni15F7NXtY9Ij',
  // ── Manual hold-outs (Ben handling 1:1) ───────────────────────────
  'recvtFXpo6FJ2l9XI', // Matula
  'recPG2ZQ4q0PnANba', // ZK
  'recPSwo6VMkmBNVl5', // AU Beef
  'recUJmcAdyLgLCMzi', // Next Horizon
  'recKIK3MyGxJ5cQx1', // Carters American Beef
  // ── Mid-funnel ────────────────────────────────────────────────────
  'recj1xWIDMaooGxFQ', // Left Hand Cattle (Onboarding = Call Scheduled)
  // ── Duplicate ─────────────────────────────────────────────────────
  'rec3K0LsDGQKONNnb', // duplicate Renick
  // ── Agreement-signed → Ben sends personally (don't auto-blast a signed ranch) ──
  'rec9SDcDugHTLsGLQ', // Cheyenne Ridge Cattle (CO)
  'recBWv3FUBAHFrt8W', // Lily Hill Farm (GA)
  'recdMkD7LvdzRYAhq', // Hubbard's Farm (VT)
]);

// Onboarding Status values that qualify a legacy rancher as Tier A (warm):
// got partway through onboarding but never went live.
const TIER_A_ONBOARDING = new Set(['Call Complete', 'Docs Sent', 'Verification Complete']);

// Named test rows that must never be contacted (matched case-insensitively
// against Ranch Name / Operator Name). The dup Renick is handled by id above.
const TEST_RANCH_NAMES = new Set(['synthetic e2e test ranch', 'demo cattle co']);

// Airtable single-select fields come back as either a bare string or an
// object { name }. Normalize to a trimmed string. Mirrors readEnumOrString
// in lib/rancherEligibility.ts.
function readEnumOrString(v: unknown): string {
  if (!v) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'object' && v !== null && 'name' in v) {
    return String((v as { name?: unknown }).name || '').trim();
  }
  return String(v).trim();
}

function isTruthyFlag(v: unknown): boolean {
  // Airtable checkbox = true | undefined. Be defensive about string "true".
  if (v === true) return true;
  if (typeof v === 'string') return v.trim().toLowerCase() === 'true';
  return false;
}

function parseDateMs(v: unknown): number | null {
  if (!v) return null;
  const ms = new Date(String(v)).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** A rancher who has self-served a call is out of the campaign entirely. */
function hasBooking(r: any): boolean {
  const ms = readEnumOrString(r['Migration Status']).toLowerCase();
  if (ms === 'call_scheduled') return true;
  // Booking stamps that actually exist on the Ranchers table (confirmed against
  // the live schema). Presence of a value is enough — we don't parse it.
  if (r['Call Scheduled'] === true) return true;
  if (r['Migration Call Booked At'] || r['Migration Call Completed At']) return true;
  return false;
}

export interface ReactivationRancher {
  id: string;
  firstName: string;
  ranchName: string;
  state: string;
  email: string;
  tier: 'A' | 'B';
  touchCount: number;
}

export interface ReactivationDormant {
  id: string;
  ranchName: string;
  email: string;
  tier: 'A' | 'B';
}

export interface SegmentResult {
  /** Untouched Tier A ranchers eligible for a first send. */
  tierAToSend: ReactivationRancher[];
  /** Untouched Tier B ranchers eligible for a first send. */
  tierBToSend: ReactivationRancher[];
  /** Touched once, >=5d ago, no booking, not unsubscribed → ONE reminder. */
  reminders: ReactivationRancher[];
  /** Silent >=10d after first touch with >=2 touches → mark dormant. */
  toMarkDormant: ReactivationDormant[];
  /** Diagnostics for the preview script + cron Telegram digest. */
  counts: {
    totalRanchers: number;
    tierAEligible: number;
    tierBEligible: number;
    excludedById: number;
    suppressed: number;
    booked: number;
    skippedTooSoon: number;
  };
}

interface Candidate {
  r: any;
  id: string;
  tier: 'A' | 'B';
  touchCount: number;
  lastSentMs: number | null;
}

function firstNameOf(r: any): string {
  const name = String(r['Operator Name'] || r['Ranch Name'] || '').trim();
  return name.split(/\s+/)[0] || '';
}

function ranchNameOf(r: any): string {
  return String(r['Ranch Name'] || r['Operator Name'] || 'your ranch').trim();
}

/**
 * Segment all ranchers into the campaign buckets for a single cron tick.
 *
 * @param allRanchers raw Airtable rows (id + fields spread), as returned by
 *                    getAllRecords(TABLES.RANCHERS).
 * @param now         reference time (Date) — injectable for deterministic
 *                    preview/inspection.
 *
 * Note: this does NOT apply the daily send cap (8) — the cron slices
 * `[...tierAToSend, ...tierBToSend]` to the cap, Tier A first. Reminders and
 * dormant marking are not subject to the first-send cap.
 */
export function segmentRanchers(allRanchers: any[], now: Date = new Date()): SegmentResult {
  const nowMs = now.getTime();
  const counts = {
    totalRanchers: allRanchers.length,
    tierAEligible: 0,
    tierBEligible: 0,
    excludedById: 0,
    suppressed: 0,
    booked: 0,
    skippedTooSoon: 0,
  };

  const candidates: Candidate[] = [];

  for (const r of allRanchers) {
    const id: string = r.id;
    if (!id) continue;

    // ── Hard exclude: id allowlist ────────────────────────────────────
    if (EXCLUDE_RANCHER_IDS.has(id)) {
      counts.excludedById++;
      continue;
    }

    // ── Hard exclude: named test rows ─────────────────────────────────
    const ranchLc = String(r['Ranch Name'] || '').trim().toLowerCase();
    const opLc = String(r['Operator Name'] || '').trim().toLowerCase();
    if (TEST_RANCH_NAMES.has(ranchLc) || TEST_RANCH_NAMES.has(opLc)) {
      continue;
    }

    // ── Only legacy ranchers are in scope ─────────────────────────────
    const pricingModel = String(r['Pricing Model'] || '').trim().toLowerCase();
    if (pricingModel === 'tier_v2') continue;

    // ── Must have an email to contact ─────────────────────────────────
    const email = String(r['Email'] || '').trim();
    if (!email || !email.includes('@')) continue;

    // ── Suppression (also enforced by the send layer; belt-and-suspenders).
    if (
      isTruthyFlag(r['Unsubscribed']) ||
      isTruthyFlag(r['Bounced']) ||
      isTruthyFlag(r['Complained'])
    ) {
      counts.suppressed++;
      continue;
    }

    // ── Tier assignment ───────────────────────────────────────────────
    const onboarding = readEnumOrString(r['Onboarding Status']);
    const active = readEnumOrString(r['Active Status']);

    // Never reactivate ranchers we've intentionally paused / flagged / removed
    // (covers the first-touch path; the reminder path is guarded in the cron).
    if (active === 'Paused' || active === 'Non-Compliant' || active === 'Removed') {
      counts.suppressed++;
      continue;
    }

    let tier: 'A' | 'B' | null = null;
    if (TIER_A_ONBOARDING.has(onboarding)) {
      // Tier A — warm. Exclude any that are already Active + Live (getting
      // leads). In practice none of the Tier-A onboarding values is "Live",
      // but the spec states the clause explicitly, so enforce it.
      const isActiveAndLive = active === 'Active' && onboarding === 'Live';
      if (!isActiveAndLive) tier = 'A';
    } else if (onboarding === '') {
      // Tier B — cold. Listed but never onboarded (blank Onboarding Status).
      tier = 'B';
    }
    if (!tier) continue;

    // ── Booking short-circuits the whole campaign for this rancher ────
    if (hasBooking(r)) {
      counts.booked++;
      continue;
    }

    if (tier === 'A') counts.tierAEligible++;
    else counts.tierBEligible++;

    const touchCount = Number(r['Campaign Touch Count'] || 0) || 0;
    const lastSentMs = parseDateMs(r['Last Campaign Email Sent At']);

    candidates.push({ r, id, tier, touchCount, lastSentMs });
  }

  const tierAToSend: ReactivationRancher[] = [];
  const tierBToSend: ReactivationRancher[] = [];
  const reminders: ReactivationRancher[] = [];
  const toMarkDormant: ReactivationDormant[] = [];

  for (const c of candidates) {
    const { r, id, tier, touchCount, lastSentMs } = c;

    const toRancher = (): ReactivationRancher => ({
      id,
      firstName: firstNameOf(r),
      ranchName: ranchNameOf(r),
      state: String(r['State'] || '').trim(),
      email: String(r['Email'] || '').trim(),
      tier,
      touchCount,
    });

    // ── Never touched → first send ────────────────────────────────────
    if (touchCount <= 0 || lastSentMs === null) {
      if (tier === 'A') tierAToSend.push(toRancher());
      else tierBToSend.push(toRancher());
      continue;
    }

    const daysSinceLast = (nowMs - lastSentMs) / DAY_MS;

    // ── Too soon since last touch → skip this tick ────────────────────
    if (daysSinceLast < REMINDER_AFTER_DAYS) {
      counts.skippedTooSoon++;
      continue;
    }

    // ── +10d silent with >=2 touches → mark dormant ───────────────────
    // (booking already filtered out above; reaching here means no booking.)
    if (daysSinceLast >= DORMANT_AFTER_DAYS && touchCount >= 2) {
      toMarkDormant.push({
        id,
        ranchName: ranchNameOf(r),
        email: String(r['Email'] || '').trim(),
        tier,
      });
      continue;
    }

    // ── +5d, exactly one touch → ONE reminder (will bump Touch Count→2)
    if (daysSinceLast >= REMINDER_AFTER_DAYS && touchCount < 2) {
      reminders.push(toRancher());
      continue;
    }

    // touchCount >= 2 but < 10 days, or any other gap → wait (no-op).
  }

  return { tierAToSend, tierBToSend, reminders, toMarkDormant, counts };
}
