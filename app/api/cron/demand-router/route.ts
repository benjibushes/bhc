// app/api/cron/demand-router/route.ts
//
// THE DEMAND ROUTER — capacity-gated sender for the nationwide backfill
// campaign (docs/NATIONWIDE-2-RANCHER-CAMPAIGN.md + docs/CAMPAIGN-SENDS.md),
// now a COMBINED email+SMS, send-time-gated, recovery-aware flow.
//
// Runs hourly (see vercel.json). Each run:
//   1. Resolves the campaign's CONFIGURED rancher set (A2) — env
//      DEMAND_CAMPAIGN_RANCHER_IDS, positional 1st=WEST 2nd=EAST+CENTRAL,
//      defaulting to Foodstead+Silverline — validates each with
//      isRancherOperationalForBuyers (the SAME single-source gate the real
//      matching engine /api/matching/suggest uses; a failing rancher is
//      SKIPPED: pool sends nothing, console.warn + operator note), then reads
//      open deposit slots per rancher from the canonical capacity helper.
//   2. [Upgrade B] Counts reservations that paid a deposit in the last 7 days →
//      a live social-proof line injected into Msg2/Msg3 (omitted below a floor).
//   3. Selects the next batch of highest-intent, not-yet-contacted-this-wave
//      buyers by coast → matching rancher, sized to min(daily cap, open slots ×
//      conversion buffer). Tier order: stranded-qualified → HOT → WARM. The arc
//      is EMAIL-LED (planner smsWaves disabled — SMS is a recovery touch, below).
//   4. Sends the buyer's current wave (Msg1 day0 / Msg2 +3 / Msg3 +7) by EMAIL
//      via lib/email — but only inside the EMAIL send-window for the buyer's
//      local time [Upgrade C]; out-of-window sends DEFER to a later hourly run.
//   5. [Upgrade C] SMS RECOVERY: opted-in buyers emailed ≥8h ago who haven't
//      converted get ONE short, DISTINCT recovery SMS (different angle), gated to
//      the SMS send-window + TCPA, stamped on Campaign SMS Recovery Sent At.
//   6. [Upgrade A] ABANDONED-RESERVE RECOVERY: buyers who created a reserve
//      referral but never paid the deposit get a recovery EMAIL ("your {cut}
//      share is still held →"), then a recovery SMS if still unconverted —
//      stamped on Reserve Recovery Sent At / Reserve Recovery SMS Sent At.
//   7. Stamps disposition, waitlists overflow demand by state, sunsets dead
//      full-arc buyers, Telegram report to Ben.
//
// ── NON-NEGOTIABLE SAFETY (unchanged) ─────────────────────────────────────
//  • DRY-RUN DEFAULT. Unless CAMPAIGN_LIVE === 'true', this does ALL selection
//    + renders every message + reports EXACTLY what it WOULD send/recover, but
//    sends NOTHING and writes NO disposition. Applies to the backfill arc, the
//    SMS recovery, AND the abandoned-reserve recovery.
//  • KILL-SWITCH. CAMPAIGN_ROUTER_ENABLED must be 'true' or the cron no-ops.
//  • CAPACITY-GATED. Never selects more than openSlots × buffer. (Recovery is
//    NOT capacity-gated by design — those buyers already hold a reserve slot.)
//  • IDEMPOTENT. Stage/last-sent dedupe + recovery stamps written BEFORE the
//    send (claim-before-send) so a failed/again run never double-sends.
//  • TCPA. Every SMS is opt-in-gated (planner/selector + sendSMSToConsumer) and
//    double-gated by ENABLE_SMS; SMS only fires inside the SMS send-window.
//  • CRON_SECRET auth + maintenance gate + withCronRun (mirrors other crons).
//
// Mirrors app/api/cron/buyer-pulse + deposit-accept-sla (auth, maintenance,
// withCronRun, sequential per-record try/catch, stamp-before-side-effect).

import { NextResponse } from 'next/server';
import { getAllRecords, getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { findPaymentsByReferral } from '@/lib/contracts/payments';
import { isMaintenanceMode } from '@/lib/maintenance';
import {
  sendDemandRouterCampaign,
  getSuppressionList,
  didSuppressionListBuildFail,
} from '@/lib/email';
import { sendSMSToConsumer } from '@/lib/twilio';
import { smsEnabled } from '@/lib/smsFlag';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import { logAuditEntry } from '@/lib/auditLog';
import { getMaxActiveReferrals, getLiveCapacity } from '@/lib/rancherCapacity';
import { countClosedWonReferrals } from '@/lib/capacityCount';
import { mintCampaignReserveToken } from '@/lib/campaignReserve';
import { type Cut } from '@/lib/reserveDeposit';
import {
  buildCampaignPlan,
  buildCampaignPools,
  campaignRancherForBuyer,
  defaultPairServedStates,
  renderMessage,
  renderSmsRecovery,
  rancherPageUrl,
  brokerReservePageUrl,
  parseCampaignRancherIds,
  activeDealBuyerKeys,
  type ActiveDealKeys,
  CAMPAIGN_RANCHER_IDS_ENV,
  openSlotsFor,
  countRecentDeposits,
  socialProofLine,
  isSmsRecoveryEligible,
  CAMPAIGN_TEMPLATE_NAMES,
  CAMPAIGN_STAGE_FOR_WAVE,
  CAMPAIGN_NAME,
  CAMPAIGN_SMS_RECOVERY_FIELD,
  DEFAULT_SMS_RECOVERY_HOURS,
  SOCIAL_PROOF_DAYS,
  FOODSTEAD,
  SILVERLINE,
  type CampaignBuyer,
  type CampaignPool,
  type CampaignPoolInput,
  type PoolCapacityReport,
  type PlannedSend,
  type CampaignPlan,
  type RancherTarget,
} from '@/lib/demandRouter';
import {
  isRancherOperationalForBuyers,
  getOperationalServedStates,
} from '@/lib/rancherEligibility';
import { rancherForStateTable } from '@/lib/campaignWaves';
import { isBrokerRancher } from '@/lib/brokerRail';
import { isRequestOnlyRancher, isRequestOnlyRancherId } from '@/lib/requestOnlyRanchers';
import { isEmailWindow, isSmsWindow } from '@/lib/sendWindow';
import { normalizeState } from '@/lib/states';
import {
  selectRecoveryEmail,
  selectRecoverySms,
  renderRecoveryEmail,
  renderRecoverySms,
  DEFAULT_RESERVE_RECOVERY_HOURS,
  DEFAULT_RESERVE_RECOVERY_SMS_HOURS,
  RECOVERY_CAMPAIGN_NAME,
  RECOVERY_EMAIL_TEMPLATE,
  RESERVE_RECOVERY_EMAIL_FIELD,
  RESERVE_RECOVERY_SMS_FIELD,
  type RecoveryReferralLike,
} from '@/lib/reserveRecovery';

export const maxDuration = 180;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

// ── Safety flags ─────────────────────────────────────────────────────────
// Kill-switch: the whole cron no-ops unless explicitly enabled.
function routerEnabled(): boolean {
  return process.env.CAMPAIGN_ROUTER_ENABLED === 'true';
}
// DRY-RUN default: only TRUE when the operator has explicitly armed live sends.
function isLive(): boolean {
  return process.env.CAMPAIGN_LIVE === 'true';
}
// SMS is double-gated: ENABLE_SMS env AND per-consumer SMS Opt-In (TCPA).
// F3 (2026-07-01): the ENABLE_SMS check is the shared smsEnabled() from
// lib/smsFlag ('1' | 'true', case-insensitive) — this route used to require
// exactly 'true' while lib/smsEvents required '1', so no single env value
// lit the whole channel.

interface CronResult {
  status: 'success' | 'partial' | 'error' | 'maintenance-blocked';
  recordsTouched: number;
  notes: string;
}

/**
 * Resolve the buyer-facing {link} for a planned send.
 *
 * BROKER BRANCH FIRST (F19, 2026-08-18): a broker-rail ranch never gets a
 * /r/d token — that redemption resolves via getRancherBySlug, whose formula
 * excludes Broker Rail, so the token degrades to a bare page visit. Ported
 * from the requalify-send pattern (isBrokerRoutable → broker reserve CTA):
 * broker pools link straight to the ranch's own reserve surface.
 * `brokerRancherIds` comes from readCapacity, which judged the actual record
 * (isBrokerRancher) at pool-resolve time.
 *
 * Otherwise personalizes the 1-tap deposit link via mintCampaignReserveToken
 * (#122): a scoped token pinning {consumerId, rancherSlug, cut} →
 * /r/d/<token>, which the /r/d route exchanges for a cut-prefilled deposit
 * checkout (eligibility-gated server-side). Falls back to the rancher's
 * public page `/ranchers/<slug>` ONLY if minting can't proceed — i.e. the
 * buyer has no usable cut (Order Type blank/"Not Sure") or mint throws (mint
 * requires a valid cut + slug). The fallback keeps the campaign honest for
 * buyers we can't 1-tap.
 */
async function resolveLink(
  rancher: RancherTarget,
  send: PlannedSend,
  brokerRancherIds: ReadonlySet<string>,
): Promise<string> {
  if (brokerRancherIds.has(rancher.id)) {
    return brokerReservePageUrl(SITE_URL, rancher);
  }
  const base = SITE_URL.replace(/\/+$/, '');
  if (send.cut) {
    try {
      const token = mintCampaignReserveToken({
        consumerId: send.buyerId,
        rancherSlug: rancher.slug,
        cut: send.cut,
      });
      if (token) return `${base}/r/d/${token}`;
    } catch (e: any) {
      // mint throws on a bad cut/slug — fall back rather than ship a broken link.
      console.warn(`[demand-router] mint failed for ${send.buyerId}, using rancher-page fallback:`, e?.message);
    }
  }
  return rancherPageUrl(SITE_URL, rancher);
}

/**
 * Resolve + validate the campaign's CONFIGURED ranchers (A2) and read open
 * deposit slots per pool. openSlots = Max Active Referrals − live Current
 * Active count (Redis-backed, race-safe). Clamped >= 0.
 *
 * THE OPERATIONAL GATE (A2): every configured rancher — default or env-set —
 * is checked against isRancherOperationalForBuyers, the SAME single-source
 * gate the real matching engine (/api/matching/suggest) uses. A configured
 * rancher that fails the gate is SKIPPED (target=null, capacity 0): its pool
 * sends NOTHING this run (the planner drops even continuations), with a
 * console.warn + an operator-visible note in the Telegram report. This closes
 * the "campaign routes to a dark rancher" hole.
 */
async function readCapacity(ids: readonly string[]): Promise<{
  /** Every operational configured rancher, as a campaign pool (N-rancher model). */
  pools: CampaignPool[];
  /** Per-pool report detail, aligned with `pools` order. */
  poolDetail: Array<{ name: string; max: number; cur: number }>;
  degraded: string[];
  skipped: string[];
  /**
   * Configured rancher ids whose RECORD is broker-rail (F19) — their campaign
   * links must be the broker reserve surface, never a Connect-only /r/d token.
   */
  brokerRancherIds: ReadonlySet<string>;
}> {
  // FAIL-CLOSED on a missing/failed rancher record. getMaxActiveReferrals(null)
  // returns DEFAULT_MAX=5 — a transient fetch failure would otherwise INVENT 5
  // open slots and trigger unintended live sends. For a money-adjacent sender we
  // must never fabricate capacity: a null record → 0 slots for that pool (skip
  // it this run). The `degraded` list surfaces the skip in the report.
  const degraded: string[] = [];
  // Operational-gate + config skips — operator-visible in the Telegram report.
  const skipped: string[] = [];
  // F19: broker-rail configured ranchers (judged from the RECORD below) — the
  // link resolvers route these at their own reserve surface, never /r/d.
  const brokerRancherIds = new Set<string>();

  // The default pair keeps its curated display fields (and short report names,
  // byte-identical to the legacy report); any OTHER configured rancher is
  // hydrated from its Airtable record.
  function curatedTargetFor(id: string): RancherTarget | null {
    if (id === FOODSTEAD.id) return { ...FOODSTEAD };
    if (id === SILVERLINE.id) return { ...SILVERLINE };
    return null;
  }
  function displayNameFor(id: string, fallback: string): string {
    if (id === FOODSTEAD.id) return 'Foodstead';
    if (id === SILVERLINE.id) return 'Silverline';
    return fallback;
  }

  // CAPACITY = CLOSED SALES (#358, 2026-07-22): campaign open slots gate on
  // Closed Won — the physical head remaining — not the held-lead mirror.
  // Throttling invites on held pipeline depth idled campaign capacity the
  // founder rule says must keep flowing (held is a load-balance tiebreak,
  // never a gate). One scan serves both slots; on a failed scan we fall back
  // to the held counter (conservative: throttles, never over-invites).
  let campaignWonRefs: any[] | null = null;
  try {
    campaignWonRefs = (await getAllRecords(TABLES.REFERRALS, `{Status} = "Closed Won"`)) as any[];
  } catch (e: any) {
    console.warn('[demand-router] Closed Won scan failed — falling back to held counter:', e?.message);
  }

  // F8 (2026-08-18): STATE-AWARE DEFAULT POOLS. When a curated default
  // rancher is configured, build the operational state-owner table (the SAME
  // rancherForStateTable the campaign autopilot uses — one policy, one
  // implementation) so the default pair's reach can cede every state owned by
  // a different operational rancher (AZ→gila). Read failure degrades to the
  // pair's OWN Routing States (still never nationwide-for-free) with an
  // operator-visible note — conservative in the only direction that matters.
  let stateOwners: ReadonlyMap<string, { id: string }> | null = null;
  if (ids.some((id) => !!curatedTargetFor(id))) {
    try {
      const allRanchers = (await getAllRecords(TABLES.RANCHERS)) as any[];
      stateOwners = rancherForStateTable(allRanchers as any);
    } catch (e: any) {
      degraded.push('state-owner table read failed — default pair limited to its own Routing States this run');
      console.warn('[demand-router] state-owner table read failed (F8 fallback to own served states):', e?.message);
    }
  }

  async function resolveSlot(
    id: string,
    label: string,
  ): Promise<{
    open: number;
    max: number;
    cur: number;
    target: RancherTarget | null;
    name: string;
    servedStates: ReadonlySet<string>;
  }> {
    const rec = (await getRecordById(TABLES.RANCHERS, id).catch(() => null)) as any;
    if (!rec) {
      // For the known default pair, keep the curated target on a TRANSIENT
      // fetch failure — but FAIL CLOSED on reach (F8, 2026-08-18): with no
      // record we can't know its Routing States, and the old servedStates=null
      // here meant "serve nationwide", so a fetch blip re-opened the exact
      // AZ→Montana hole this pool model exists to close. Empty reach = even
      // mid-arc continuations hold for one run (untouched, no stamp) — the
      // 3-/4-day wave gaps make a one-run hold invisible. An unknown
      // configured id we know nothing about (no slug/name) → skip entirely.
      const curated = curatedTargetFor(id);
      if (curated) {
        degraded.push(`${displayNameFor(id, curated.name)} (${label}): rancher record unavailable → capacity forced to 0, reach forced empty (continuations hold this run)`);
        return { open: 0, max: 0, cur: 0, target: curated, name: displayNameFor(id, curated.name), servedStates: new Set() };
      }
      skipped.push(`${label}: configured rancher ${id} could not be read → pool disabled this run`);
      console.warn(`[demand-router] configured campaign rancher ${id} (${label}) unreadable — pool disabled this run`);
      return { open: 0, max: 0, cur: 0, target: null, name: id, servedStates: new Set() };
    }

    const recName = String(rec['Ranch Name'] || rec['Operator Name'] || id).trim() || id;
    const name = displayNameFor(id, recName);

    // F10 (2026-08-18): REQUEST-ONLY SUPPLY — Ben's standing rule that
    // specialty supply (Rep Provisions) is NEVER a generic campaign target.
    // Checked by SLUG (the shared list every engine consults) AND by REC-ID
    // belt: this pool env is configured by record id, so a slug rename in
    // Airtable must not slip a request-only ranch into a generic deposit
    // campaign. Trumps everything below — an operational request-only ranch
    // is still refused.
    if (isRequestOnlyRancher(rec) || isRequestOnlyRancherId(id)) {
      skipped.push(`${name} (${label}): request-only rancher — never a generic campaign target → pool disabled this run`);
      console.warn(`[demand-router] configured campaign rancher ${name} (${id}, ${label}) is request-only — pool disabled this run`);
      return { open: 0, max: 0, cur: 0, target: null, name, servedStates: new Set() };
    }

    // THE OPERATIONAL GATE — single source: lib/rancherEligibility, the same
    // gate /api/matching/suggest applies. Fails → NEVER routed to this run.
    if (!isRancherOperationalForBuyers(rec)) {
      skipped.push(`${name} (${label}): failed the operational gate (isRancherOperationalForBuyers) → NOT routed to this run`);
      console.warn(`[demand-router] configured campaign rancher ${name} (${id}, ${label}) failed isRancherOperationalForBuyers — pool disabled this run`);
      return { open: 0, max: 0, cur: 0, target: null, name, servedStates: new Set() };
    }

    const target = curatedTargetFor(id) ?? hydrateTarget(id, rec);
    if (!target) {
      skipped.push(`${name} (${label}): operational but has no Slug → cannot build campaign links → NOT routed to this run`);
      console.warn(`[demand-router] configured campaign rancher ${name} (${id}, ${label}) has no Slug — pool disabled this run`);
      return { open: 0, max: 0, cur: 0, target: null, name, servedStates: new Set() };
    }

    // F19 (2026-08-18): broker-ness judged from the RECORD, once, here — the
    // link resolvers must send this pool's buyers to the broker reserve
    // surface, never a Connect-only /r/d token (its redemption excludes
    // Broker Rail and degrades to a bare page visit).
    if (isBrokerRancher(rec)) brokerRancherIds.add(id);

    // ROUTING-STATES GATE (audit 2026-07-22 finding 1; widened by F8
    // 2026-08-18): EVERY pool — default or not — only serves the states its
    // record says it serves (getOperationalServedStates — home state +
    // admin-approved Routing States, the SAME rule the real matching engine
    // uses). The curated default pair used to ship servedStates=null
    // ("nationwide by design"), which pushed Montana deposit links at ~110
    // AZ waitlist buyers whose state has its own operational rancher. Its
    // reach is now its own Routing States MINUS any state owned by a
    // DIFFERENT operational state-table rancher (defaultPairServedStates —
    // those buyers belong to their state rancher's rail).
    let servedStates: ReadonlySet<string>;
    if (!curatedTargetFor(id)) {
      servedStates = new Set(getOperationalServedStates(rec));
      if (servedStates.size === 0) {
        skipped.push(`${name} (${label}): no served states on record (blank State, no approved Routing States) → pool cannot route any buyer this run`);
        console.warn(`[demand-router] configured campaign rancher ${name} (${id}, ${label}) has no served states — pool routes nothing`);
      }
    } else {
      const own = new Set(getOperationalServedStates(rec));
      servedStates = stateOwners ? defaultPairServedStates(own, id, stateOwners) : own;
      if (servedStates.size === 0) {
        skipped.push(`${name} (${label}): no reachable states after the Routing-States + state-owner gates → pool cannot route any buyer this run`);
        console.warn(`[demand-router] default campaign rancher ${name} (${id}, ${label}) has no reachable states — pool routes nothing`);
      }
    }

    const max = getMaxActiveReferrals(rec);
    // Closed Won is the capacity gate (#358); the held counter is only the
    // degraded fallback when the Closed Won scan above failed.
    const cur = campaignWonRefs
      ? countClosedWonReferrals(id, campaignWonRefs)
      : await getLiveCapacity(id).catch(
          () => Number(rec?.['Current Active Referrals'] || 0),
        );
    return { open: openSlotsFor({ max, current: cur }), max, cur, target, name, servedStates };
  }

  // N-RANCHER MODEL (finding 2): EVERY configured id resolves to a pool —
  // extras are no longer discarded. 1-2 ids keep the legacy positional coast
  // labels (and buildCampaignPools keeps their coast split); 3+ route by
  // served states.
  const labels = ids.length <= 2
    ? ids.map((_, i) => (i === 0 ? 'WEST' : 'EAST+CENTRAL'))
    : ids.map((_, i) => `POOL ${i + 1}`);
  const resolved = await Promise.all(ids.map((id, i) => resolveSlot(id, labels[i])));
  if (ids.length === 1) {
    skipped.push(`EAST+CENTRAL: no rancher configured (${CAMPAIGN_RANCHER_IDS_ENV} has fewer than 2 ids) → pool disabled this run`);
    console.warn('[demand-router] EAST+CENTRAL pool has no configured campaign rancher — pool disabled this run');
  }

  // Positional slot inputs (null = disabled pool, position preserved so a
  // dark 1st rancher doesn't shift the 2nd into the WEST slot).
  const slotInputs: Array<CampaignPoolInput | null> = resolved.map((r) =>
    r.target ? { target: r.target, openSlots: r.open, servedStates: r.servedStates } : null,
  );
  while (slotInputs.length < 2) slotInputs.push(null);
  const pools = buildCampaignPools(slotInputs);
  const poolDetail = resolved
    .filter((r) => r.target)
    .map((r) => ({ name: r.name, max: r.max, cur: r.cur }));

  return { pools, poolDetail, degraded, skipped, brokerRancherIds };
}

/** Build a RancherTarget for a non-default configured rancher from its record. */
function hydrateTarget(id: string, rec: any): RancherTarget | null {
  const slug = String(rec?.['Slug'] || '').trim();
  if (!slug) return null; // no public page / 1-tap link possible → unroutable
  const name = String(rec?.['Ranch Name'] || rec?.['Operator Name'] || '').trim() || slug;
  const ranchState = String(rec?.['State'] || '').trim() || 'local';
  return { id, slug, name, ranchState };
}

/**
 * Pull the candidate buyer pool. We intentionally pull broadly (active-ish
 * consumers) and let the PURE planner do all suppression/tiering/gating — that
 * keeps the selection logic in one tested place. We exclude only the obvious
 * hard-suppressed at the Airtable layer to keep the payload small.
 */
async function readBuyers(): Promise<CampaignBuyer[]> {
  // Exclude unsubscribed/bounced/complained + already-sunset at the query layer
  // (cheap pre-filter). Everything else is decided by buildCampaignPlan.
  const formula =
    'AND(' +
    '{Email} != "", ' +
    'NOT({Unsubscribed} = TRUE()), ' +
    'NOT({Bounced} = TRUE()), ' +
    'NOT({Complained} = TRUE()), ' +
    'NOT({Campaign Stage} = "Sunset")' +
    ')';
  const rows = (await getAllRecords(TABLES.CONSUMERS, formula)) as any[];
  return rows.map((r) => ({ id: r.id, fields: r as Record<string, unknown> }));
}

/**
 * FINDING 1 (pre-flip guard, 2026-07-01): pull the raw ACTIVE-DEAL referral
 * rows so the pure planner can exclude every mid-deal buyer (deposit pending,
 * slot locked, live intro) from ALL tiers + waves via isActiveDealReferral —
 * the SAME canonical predicate matching/suggest uses for its already-in-a-deal
 * guard. The formula pulls the held statuses + Pending Approval (the pure
 * index re-judges each row, so a linked-rancher check never lives in the
 * formula). Fail-open to the Consumer mirror fields on a read error — the
 * planner still enforces hasActiveReferral on its own; the warn surfaces it.
 */
async function readActiveDealReferrals(): Promise<Array<Record<string, unknown>>> {
  try {
    return (await getAllRecords(
      TABLES.REFERRALS,
      `OR({Status} = "Intro Sent", {Status} = "Rancher Contacted", {Status} = "Negotiation", {Status} = "Awaiting Payment", {Status} = "Slot Locked", {Status} = "Pending Approval")`,
    )) as Array<Record<string, unknown>>;
  } catch (e: any) {
    console.warn(
      '[demand-router] active-deal referral read failed — mid-deal exclusion falls back to Consumer mirror fields only:',
      e?.message,
    );
    return [];
  }
}

// ── Disposition stamps (LIVE only) ─────────────────────────────────────────

async function stampSend(send: PlannedSend, now: Date): Promise<void> {
  const fields: Record<string, unknown> = {
    'Campaign Stage': CAMPAIGN_STAGE_FOR_WAVE[send.wave],
    'Campaign Last Sent At': now.toISOString(),
    'Campaign Rancher': [send.rancher.id],
  };
  await updateRecord(TABLES.CONSUMERS, send.buyerId, fields);
}

async function stampWaitlist(buyerId: string, state: string): Promise<void> {
  await updateRecord(TABLES.CONSUMERS, buyerId, { 'Campaign Waitlist State': state });
}

async function stampSunset(buyerId: string, now: Date): Promise<void> {
  await updateRecord(TABLES.CONSUMERS, buyerId, {
    'Campaign Stage': 'Sunset',
    'Campaign Sunset At': now.toISOString(),
  });
}

// ── Telegram report ─────────────────────────────────────────────────────────

function buildReport(plan: CampaignPlan, opts: {
  live: boolean;
  smsOn: boolean;
  poolDetail: Array<{ name: string; max: number; cur: number }>;
  failures: string[];
  degraded: string[];
  /** Configured-rancher skips (operational gate / config) — operator-visible. */
  rancherSkips: string[];
  emailsDeferred: number;
  proof: SocialProof;
  smsRec: { planned: number; sent: number; deferred: number };
  recovery: {
    emailPlanned: number;
    emailSent: number;
    emailDeferred: number;
    smsPlanned: number;
    smsSent: number;
    smsDeferred: number;
  };
}): string {
  const mode = opts.live ? '🟢 LIVE' : '🟡 DRY-RUN (nothing sent)';
  const poolCap: PoolCapacityReport[] = plan.poolCapacity || [];
  const suppressedTotal = Object.values(plan.suppressed).reduce((a, b) => a + b, 0);
  const suppressedBreak = Object.entries(plan.suppressed)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}:${n}`)
    .join(' · ') || 'none';
  const waitlistBreak = Object.entries(plan.waitlistByState)
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `${s}:${n}`)
    .join(' · ') || 'none';

  const lines: string[] = [
    `🐄 <b>DEMAND ROUTER</b> · ${mode} · combined email+SMS`,
    '',
    '<b>Capacity</b> (open slots / cap · outstanding-invited / new-invite budget · Msg1 sent today)',
    ...poolCap.map((p, i) =>
      `• ${opts.poolDetail[i]?.name || p.name}: ${p.open} open / ${opts.poolDetail[i]?.max ?? '?'} cap · ${p.outstanding} out / ${p.newBudget} new-budget · ${p.sentToday} today → filling ${p.planned}`,
    ),
  ];
  if (poolCap.length === 0) {
    lines.push('• no operational campaign rancher this run');
  }
  if (opts.rancherSkips.length > 0) {
    // A2: configured rancher failed the operational gate / config anomaly —
    // that pool is DISABLED this run (nothing sent, not even continuations).
    lines.push('', '⛔ <b>Campaign rancher skipped (operational gate / config):</b>', ...opts.rancherSkips.map((s) => `• ${s}`));
    const ps = plan.skippedNoRancher;
    if (ps.west + ps.eastCentral > 0) {
      lines.push(`• Buyers held back (roll forward, no stamp): WEST:${ps.west} · EAST+CENTRAL:${ps.eastCentral}`);
    }
  }
  if (opts.degraded.length > 0) {
    lines.push('', '⚠️ <b>Capacity degraded (fail-closed):</b>', ...opts.degraded.map((g) => `• ${g}`));
  }
  // Upgrade B — social proof shown (or omitted) this run.
  const proofShown = opts.proof.overall
    ? `“${opts.proof.overall}”`
    : 'omitted (below floor — never shows a weak number)';
  lines.push(
    '',
    '<b>Backfill arc (email-led)</b>',
    `• Msg1 (new): ${plan.byWave.Msg1} · Msg2: ${plan.byWave.Msg2} · Msg3: ${plan.byWave.Msg3}`,
    `• Email ${opts.live ? 'sent' : 'WOULD send'}: ${plan.sends.length}` +
      `${opts.emailsDeferred > 0 ? ` (${opts.emailsDeferred} deferred — outside send-window)` : ''}`,
    `• Social proof: ${proofShown}`,
    '',
    '<b>SMS recovery</b> (opted-in, emailed ≥8h ago, unconverted — distinct angle)',
    `• ${opts.live ? 'sent' : 'WOULD send'}: ${opts.smsRec.sent}/${opts.smsRec.planned}` +
      `${opts.smsRec.deferred > 0 ? ` (${opts.smsRec.deferred} deferred — outside SMS window)` : ''}` +
      `${opts.smsOn ? '' : ' · ENABLE_SMS off'}`,
    '',
    '<b>Abandoned-reserve recovery</b> (reserved, never deposited — highest ROI)',
    `• Email: ${opts.recovery.emailSent}/${opts.recovery.emailPlanned}` +
      `${opts.recovery.emailDeferred > 0 ? ` (${opts.recovery.emailDeferred} deferred)` : ''}`,
    `• SMS: ${opts.recovery.smsSent}/${opts.recovery.smsPlanned}` +
      `${opts.recovery.smsDeferred > 0 ? ` (${opts.recovery.smsDeferred} deferred)` : ''}` +
      `${opts.smsOn ? '' : ' · ENABLE_SMS off'}`,
    '',
    `<b>Waitlisted by state:</b> ${plan.waitlist.length} (${waitlistBreak})`,
    `<b>Sunset (full arc, no engagement):</b> ${plan.sunset.length}`,
    `<b>Suppressed:</b> ${suppressedTotal} (${suppressedBreak})`,
  );
  if (opts.failures.length > 0) {
    lines.push('', '<b>Failures:</b>', ...opts.failures.slice(0, 8).map((f) => `• ${f}`));
  }
  if (!opts.live) {
    lines.push('', '<i>Set CAMPAIGN_LIVE=true to arm. Review the plan above first.</i>');
  }
  return lines.join('\n');
}

// ── Per-send execution (LIVE) — EMAIL-LED backfill wave ──────────────────────
//
// Returns deferred:true (Upgrade C) when the buyer is OUTSIDE their local email
// send-window — we then leave the wave stamp UNTOUCHED so a later in-window
// hourly run picks them up (the send is deferred, never dropped).

async function executeSend(
  send: PlannedSend,
  now: Date,
  socialProof: string,
  failures: string[],
  /**
   * The buyer's PRE-CLAIM campaign fields (from the already-fetched row) so a
   * failed — not suppressed — send can revert the claim stamp and the next run
   * retries the wave (audit 2026-07-22: a Resend-level failure resolves
   * {success:false, suppressed:false} without throwing, and the claim-before-
   * send stamp would otherwise mark the wave sent forever with nothing
   * delivered).
   */
  prior: { stage: string | null; lastSent: string | null; rancher: string[] | null },
  /** F19: broker-rail pool ids — their links go to the broker reserve surface. */
  brokerRancherIds: ReadonlySet<string>,
): Promise<{ emailOk: boolean; deferred: boolean }> {
  let emailOk = false;

  // Revert the claim stamp to its pre-claim values so the wave is retried on a
  // later run. Failure to revert is itself surfaced — the claim then stays
  // burned (the pre-existing behavior) rather than risking a double-send.
  const revertClaim = async (why: string): Promise<void> => {
    try {
      await updateRecord(TABLES.CONSUMERS, send.buyerId, {
        'Campaign Stage': prior.stage,
        'Campaign Last Sent At': prior.lastSent,
        'Campaign Rancher': prior.rancher,
      });
    } catch (e: any) {
      failures.push(`${send.email}: claim revert failed after ${why} — wave burned — ${e?.message?.slice(0, 80) || 'unknown'}`);
    }
  };

  // SEND-WINDOW GATE (Upgrade C) — BEFORE render/claim so a deferred send
  // consumes nothing: no stamp, no wave advance. The next hourly run that lands
  // inside the buyer's local email window will send it. EMAIL window ~9-11am +
  // mid-afternoon, never overnight (env-tunable). Buyer-local via state→tz.
  if (!isEmailWindow(send.state, now.getTime())) {
    return { emailOk: false, deferred: true };
  }

  // RENDER FIRST (pure, no side effects). Doing this BEFORE the claim-stamp
  // means a render/link failure aborts WITHOUT consuming the wave — otherwise a
  // throw here would leave the stage stamped but nothing sent, silently
  // skipping the wave forever. Render can't have side effects, so it's safe to
  // precede the claim. Msg2/Msg3 carry the live {socialProof} line (Upgrade B).
  let msg: ReturnType<typeof renderMessage>;
  try {
    const link = await resolveLink(send.rancher, send, brokerRancherIds);
    msg = renderMessage(send.wave, {
      firstName: send.firstName,
      state: send.state,
      rancher: send.rancher,
      link,
      socialProof,
    });
  } catch (e: any) {
    failures.push(`${send.email}: render failed, NOT stamped/sent — ${e?.message || 'unknown'}`);
    return { emailOk: false, deferred: false };
  }

  // CLAIM BEFORE SEND (idempotency): stamp the stage + last-sent BEFORE the
  // actual send so a crash/timeout after this point can never re-send the same
  // wave on the next run (the wave-gap dedupe in decideWave keys off exactly
  // these fields). If the stamp itself fails we SKIP the send entirely (better
  // a missed wave than a double-send) and surface it.
  try {
    await stampSend(send, now);
  } catch (e: any) {
    failures.push(`${send.email}: stamp failed, send SKIPPED — ${e?.message || 'unknown'}`);
    return { emailOk: false, deferred: false };
  }

  // EMAIL — suppression + frequency-whitelist handled inside the sender. SMS is
  // NOT sent here: the arc is email-led and SMS is a LATER recovery touch
  // (runSmsRecovery) per the research, so a buyer never gets a simultaneous
  // email+SMS blast.
  try {
    const res = await sendDemandRouterCampaign({
      email: send.email,
      subject: msg.subject,
      html: msg.html,
      templateName: CAMPAIGN_TEMPLATE_NAMES[send.wave],
      recipientConsumerId: send.buyerId,
      replyConsumerId: send.buyerId,
      campaign: CAMPAIGN_NAME,
    });
    emailOk = !!res?.success;
    if (res?.suppressed) {
      // Suppressed (unsub/bounce/complaint) is terminal — keep the stamp so we
      // never retry into a suppression.
      failures.push(`${send.email}: email suppressed — ${res.reason || 'unknown'}`);
    } else if (!res?.success) {
      // FAILED, not suppressed (dead key, rate-limit, provider error): the wave
      // was claimed but nothing was delivered. Record it AND revert the claim
      // so the next in-window run retries instead of silently burning the wave.
      failures.push(`${send.email}: email failed — ${res?.reason || 'unknown'} (claim reverted, will retry)`);
      await revertClaim('send failure');
    }
  } catch (e: any) {
    failures.push(`${send.email}: email failed — ${e?.message || 'unknown'} (claim reverted, will retry)`);
    await revertClaim('send throw');
  }

  // Audit (best-effort, reversible stamp).
  try {
    await logAuditEntry({
      actor: 'cron',
      tool: 'demand-router',
      targetType: 'Consumer',
      targetId: send.buyerId,
      args: { wave: send.wave, rancher: send.rancher.slug, email: send.email },
      result: { emailOk },
      reverseAction: {
        type: 'airtable-update',
        table: TABLES.CONSUMERS,
        recordId: send.buyerId,
        // Restore prior campaign state. We can't un-send an email; this reverts
        // the disposition so a re-run would re-evaluate the wave.
        fields: { 'Campaign Stage': null, 'Campaign Last Sent At': null },
      },
    });
  } catch {
    /* non-fatal */
  }

  return { emailOk, deferred: false };
}

// ── Upgrade B: live social proof ─────────────────────────────────────────────
//
// Count reservations that paid a deposit in the last SOCIAL_PROOF_DAYS days
// (overall + per configured campaign rancher, cheap because we already hold the
// rows). Returns pre-formatted lines (or '' to omit). We read the Referrals once
// with a CREATED-agnostic Deposit-Paid filter; the pure counter does the window.
interface SocialProof {
  overall: string;
  byRancher: Record<string, string>; // rancherId → line ('' when below floor)
}

async function readSocialProof(nowMs: number, rancherIds: readonly string[]): Promise<SocialProof> {
  let rows: Array<Record<string, unknown>> = [];
  try {
    // Pull referrals with a non-empty Deposit Paid At in the window. We filter to
    // the window in the formula too (cheap server-side narrowing) but the pure
    // countRecentDeposits re-applies it deterministically.
    const sinceIso = new Date(nowMs - SOCIAL_PROOF_DAYS * 24 * 60 * 60 * 1000).toISOString();
    rows = (await getAllRecords(
      TABLES.REFERRALS,
      `AND({Deposit Paid At} != '', IS_AFTER({Deposit Paid At}, '${sinceIso}'))`,
    )) as Array<Record<string, unknown>>;
  } catch (e: any) {
    // Non-fatal: social proof is additive. On a read failure we OMIT it (no line)
    // rather than block the campaign.
    console.warn('[demand-router] social-proof read failed (omitting):', e?.message);
    return { overall: '', byRancher: {} };
  }
  const overallN = countRecentDeposits(rows, nowMs, { days: SOCIAL_PROOF_DAYS });
  const byRancher: Record<string, string> = {};
  for (const id of rancherIds) {
    byRancher[id] = socialProofLine(
      countRecentDeposits(rows, nowMs, { days: SOCIAL_PROOF_DAYS, rancherId: id }),
    );
  }
  return { overall: socialProofLine(overallN), byRancher };
}

/**
 * Pick the social-proof line for a send: prefer the buyer's matched rancher's
 * own recent count (more credible), else fall back to the overall count. Either
 * may be '' (omit) — and the renderer collapses the line cleanly.
 */
function proofForRancher(proof: SocialProof, rancherId: string): string {
  return proof.byRancher[rancherId] || proof.overall || '';
}

// ── Upgrade C: SMS recovery pass (backfill arc) ──────────────────────────────
//
// A SEPARATE, LATER SMS touch for opted-in buyers the campaign emailed ≥N hours
// ago who haven't converted (research: SMS recovers an unengaged email). ONE
// distinct SMS per buyer, gated to the SMS send-window + TCPA, stamped on
// Campaign SMS Recovery Sent At. Capacity-free (these buyers were already
// email-selected within capacity).
async function runSmsRecovery(
  buyers: CampaignBuyer[],
  now: Date,
  live: boolean,
  smsOn: boolean,
  proof: SocialProof,
  pools: CampaignPool[],
  activeDeals: ActiveDealKeys,
  failures: string[],
  /** F19: broker-rail pool ids — their links go to the broker reserve surface. */
  brokerRancherIds: ReadonlySet<string>,
): Promise<{ planned: number; sent: number; deferred: number }> {
  const nowMs = now.getTime();
  const smsRecoveryHours = Number(process.env.CAMPAIGN_SMS_RECOVERY_HOURS || DEFAULT_SMS_RECOVERY_HOURS);

  // FINDING 1 (pre-flip guard): a mid-deal buyer per referral truth must not
  // get a recovery SMS either — isSmsRecoveryEligible only sees the Consumer
  // mirror fields, which can be stale.
  const isMidDeal = (b: CampaignBuyer): boolean => {
    if (activeDeals.ids.has(b.id)) return true;
    const email = String(b.fields['Email'] || '').trim().toLowerCase();
    return !!email && activeDeals.emails.has(email);
  };

  // Pure eligibility: opted-in, emailed ≥N h ago, in-arc, unconverted, not yet
  // SMS-recovered. Then require a routable state (for the link's rancher + tz).
  const eligible = buyers.filter(
    (b) => isSmsRecoveryEligible(b.fields, nowMs, { smsRecoveryHours }) && !isMidDeal(b),
  );

  let planned = 0;
  let sent = 0;
  let deferred = 0;

  for (const b of eligible) {
    const f = b.fields;
    // A2/N-pool: the buyer's STAMPED campaign rancher (serves-gated) — a
    // gated-out / skipped / non-serving pool is never routed to, so no
    // recovery SMS link either.
    const rancher = campaignRancherForBuyer(f, pools);
    if (!rancher) continue; // unroutable state or pool disabled → can't build a link
    planned++;

    // SMS SEND-WINDOW gate (Upgrade C) — defer (no stamp) if outside the local
    // SMS window (weekday 9-12 / 5-7pm, never overnight). Picked up next run.
    if (!isSmsWindow(f['State'], nowMs)) {
      deferred++;
      continue;
    }
    // A5: ENABLE_SMS check BEFORE any stamp — if SMS is off (launch default) or
    // this is a dry-run, SKIP ENTIRELY without stamping, so the one-shot
    // Campaign SMS Recovery Sent At field isn't burned and the buyer is still
    // recoverable once SMS turns on.
    if (!smsOn || !live) continue;

    // Build the 1-tap link (same resolver as the email arc).
    const cut = cutLabelToCut(f['Order Type']);
    const fakeSend: PlannedSend = {
      buyerId: b.id,
      email: String(f['Email'] || ''),
      firstName: String(f['Full Name'] || '').trim().split(/\s+/)[0] || 'there',
      state: normalizeState(f['State']),
      coast: 'CENTRAL', // unused for link
      rancher,
      tier: 'warm', // unused
      wave: 'Msg2', // unused
      sms: true,
      phone: String(f['Phone'] || '').trim(),
      cut,
    };
    let link: string;
    try {
      link = await resolveLink(rancher, fakeSend, brokerRancherIds);
    } catch {
      link = rancherPageUrl(SITE_URL, rancher);
    }

    const body = renderSmsRecovery({
      firstName: fakeSend.firstName,
      state: fakeSend.state,
      rancher,
      link,
      socialProof: proofForRancher(proof, rancher.id),
    });

    // CLAIM BEFORE SEND — stamp the SMS-recovery field first so a crash can't
    // re-send. If the stamp fails, skip (better a missed SMS than a double).
    try {
      await updateRecord(TABLES.CONSUMERS, b.id, {
        [CAMPAIGN_SMS_RECOVERY_FIELD]: now.toISOString(),
      });
    } catch (e: any) {
      failures.push(`sms-recovery ${b.id}: stamp failed, skipped — ${e?.message?.slice(0, 80) || 'unknown'}`);
      continue;
    }

    // Only reached when smsOn (A5) — a stamp always corresponds to a real send.
    try {
      const ok = await sendSMSToConsumer({
        consumer: f as Record<string, any>,
        body,
        reason: 'demand-router sms-recovery',
      });
      if (ok) sent++;
    } catch (e: any) {
      failures.push(`sms-recovery ${b.id}: send failed — ${e?.message?.slice(0, 80) || 'unknown'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return { planned, sent, deferred };
}

// ── Upgrade A: abandoned-reserve recovery pass ───────────────────────────────
//
// Buyers who created a reserve referral but never paid the deposit = the hottest
// recoverable cohort. Two idempotent steps (both stamp BEFORE the side effect):
//   • recovery EMAIL — "your {cut} share is still held →" + the 1-tap link.
//   • recovery SMS   — later, if still unconverted + opted-in (different angle).
// NOT capacity-gated: the buyer already holds a reserve slot. Send-window gated.
interface RecoveryRow extends RecoveryReferralLike {
  id: string;
  Rancher?: unknown;
  'Suggested Rancher'?: unknown;
  'Buyer Email'?: unknown;
  'Buyer Name'?: unknown;
  'Buyer State'?: unknown;
  'Order Type'?: unknown;
  Buyer?: unknown;
}

// BLAST-RADIUS BOUND (A7): `campaignRancherIds` = the CONFIGURED campaign
// ranchers this recovery flow is allowed to touch (parseCampaignRancherIds —
// defaults to Foodstead+Silverline). The first LIVE run must NEVER email a
// platform-wide historical backlog of every abandoned reserve ever — only
// reserves pinned to the campaign ranchers, created within the recent window.
async function readRecoveryReferrals(
  nowMs: number,
  campaignRancherIds: ReadonlySet<string>,
): Promise<RecoveryRow[]> {
  const recoveryHours = Number(process.env.RESERVE_RECOVERY_HOURS || DEFAULT_RESERVE_RECOVERY_HOURS);
  // A7: max-age cap (created within N days, default 14) so a first LIVE run can't
  // blast a huge historical backlog, AND rancher scope to the campaign ranchers.
  const maxAgeDays = Number(process.env.RESERVE_RECOVERY_MAX_AGE_DAYS || 14);
  const minCreated = nowMs - maxAgeDays * 24 * 60 * 60 * 1000; // not older than this

  // Pull deposit-intent referrals that have NOT paid a deposit. Keep the formula
  // permissive (the pure selector enforces status/refund/age) and refund-field-
  // free (mirrors deposit-accept-sla: {Refunded At} may not exist on Referrals,
  // and an unknown field errors the whole query). The CREATED_TIME() bound
  // (audit 2026-07-22) pushes the A7 max-age cap server-side so the read stops
  // returning every unpaid deposit-intent referral ever — the JS filter below
  // re-applies the exact window as the belt.
  let rows: RecoveryRow[] = [];
  try {
    rows = (await getAllRecords(
      TABLES.REFERRALS,
      `AND({Deposit Paid At} = '', FIND('Deposit', {Match Type} & ''), IS_AFTER(CREATED_TIME(), '${new Date(minCreated).toISOString()}'))`,
    )) as RecoveryRow[];
  } catch (e: any) {
    console.warn('[demand-router] recovery referral read failed:', e?.message);
    return [];
  }
  const maxCreated = nowMs - recoveryHours * 60 * 60 * 1000; // old enough to consider

  const prelim = rows.filter((r) => {
    const created = r._createdTime ? new Date(String(r._createdTime)).getTime() : 0;
    if (!(created > 0 && created <= maxCreated && created >= minCreated)) return false;
    // Rancher scope — only reserves pinned to the campaign ranchers (A7).
    const links = (r.Rancher || r['Suggested Rancher']) as unknown;
    const ids = Array.isArray(links) ? links.map(String) : [];
    return ids.some((id) => campaignRancherIds.has(id));
  });

  // Enrich with the linked Payments row (authoritative refund/dispute signal),
  // exactly like deposit-accept-sla — only for the scoped, in-window survivors so
  // we don't N+1 the whole table.
  for (const ref of prelim) {
    try {
      // Payments-by-referral (G1/E6): exact match on {Referral Id Text} first,
      // legacy ARRAYJOIN scan only as back-compat fallback (see
      // findPaymentsByReferral in lib/contracts/payments.ts).
      const payments = (await findPaymentsByReferral(String(ref.id))) as any[];
      ref.__payment =
        payments.find(
          (p) =>
            p['Refunded At'] ||
            String(p['Status'] || '').toLowerCase() === 'refunded' ||
            String(p['Dispute Status'] || '').trim(),
        ) || payments[0] || null;
    } catch {
      ref.__payment = null;
    }
  }
  return prelim;
}

// Resolve the rancher (id + slug + name) a recovery referral points at — needed
// for the 1-tap link + copy. Reads the linked Rancher record's Slug/Name.
async function rancherForReferral(
  ref: RecoveryRow,
): Promise<{ id: string; slug: string; name: string; broker: boolean } | null> {
  const links = (ref.Rancher || ref['Suggested Rancher']) as unknown;
  const ids = Array.isArray(links) ? links.map(String) : [];
  const id = ids[0];
  if (!id) return null;
  try {
    const rec = (await getRecordById(TABLES.RANCHERS, id)) as any;
    if (!rec) return null;
    const slug = String(rec['Slug'] || '').trim();
    const name = String(rec['Operator Name'] || rec['Ranch Name'] || 'your rancher').trim();
    if (!slug) return null; // no slug → can't mint a 1-tap link; skip recovery
    // F19: broker-rail flag judged from the record — recoveryLink must send
    // this ranch's buyers to its reserve surface, never a /r/d token.
    return { id, slug, name, broker: isBrokerRancher(rec) };
  } catch {
    return null;
  }
}

function cutLabelToCut(orderType: unknown): Cut | null {
  const raw = String(orderType || '').trim().toLowerCase();
  if (!raw) return null;
  const first = raw.split(/\s+/)[0];
  if (first === 'quarter' || first === 'half' || first === 'whole') return first as Cut;
  return null;
}

/** Build the 1-tap recovery link for a referral (token → /r/d/<token>), with
 * a rancher-page fallback when the buyer's cut is unknown or minting fails.
 * BROKER BRANCH FIRST (F19): a broker ranch never gets a /r/d token — its
 * redemption excludes Broker Rail and the link degrades to a bare page visit.
 * Broker reserves recover at the ranch's own reserve surface instead. */
function recoveryLink(
  consumerId: string,
  rancher: { slug: string; broker?: boolean },
  cut: Cut | null,
): string {
  if (rancher.broker) {
    return brokerReservePageUrl(SITE_URL, rancher);
  }
  const base = SITE_URL.replace(/\/+$/, '');
  if (cut && consumerId) {
    try {
      const token = mintCampaignReserveToken({ consumerId, rancherSlug: rancher.slug, cut });
      if (token) return `${base}/r/d/${token}`;
    } catch {
      /* fall through to rancher page */
    }
  }
  return `${base}/ranchers/${rancher.slug}`;
}

// Fetch the linked Consumer for a recovery referral (the authoritative source of
// the buyer's State for TZ/window-gating — A1 — and opt-in/phone for SMS). The
// reserve flow does NOT write {Buyer State} on the referral, so we MUST read the
// Consumer's State; trusting the referral's blank Buyer State would fall back to
// Central for every reserve buyer (a Hawaii reserver could get a 4am text).
async function consumerForReferral(ref: RecoveryRow): Promise<any | null> {
  const links = ref.Buyer as unknown;
  const consumerId = Array.isArray(links) ? String(links[0] || '') : '';
  if (!consumerId) return null;
  try {
    return (await getRecordById(TABLES.CONSUMERS, consumerId)) as any;
  } catch {
    return null;
  }
}

async function runReserveRecovery(
  rows: RecoveryRow[],
  now: Date,
  live: boolean,
  smsOn: boolean,
  proof: SocialProof,
  failures: string[],
): Promise<{
  emailPlanned: number;
  emailSent: number;
  emailDeferred: number;
  smsPlanned: number;
  smsSent: number;
  smsDeferred: number;
}> {
  const nowMs = now.getTime();
  const recoveryHours = Number(process.env.RESERVE_RECOVERY_HOURS || DEFAULT_RESERVE_RECOVERY_HOURS);
  const smsHours = Number(process.env.RESERVE_RECOVERY_SMS_HOURS || DEFAULT_RESERVE_RECOVERY_SMS_HOURS);
  const opts = { now: nowMs, recoveryHours, smsHours };

  const emailEligible = selectRecoveryEmail(rows, opts);
  const smsEligible = selectRecoverySms(rows, opts);

  // PER-RUN CACHES (audit 2026-07-22): the email and SMS passes used to N+1
  // re-fetch the SAME rancher + consumer per referral in BOTH loops. Cache by
  // linked-record id so each rancher/consumer is fetched at most once per run.
  const rancherCache = new Map<string, Awaited<ReturnType<typeof rancherForReferral>>>();
  const consumerCache = new Map<string, any>();
  const cachedRancherForReferral = async (ref: RecoveryRow) => {
    const links = (ref.Rancher || ref['Suggested Rancher']) as unknown;
    const rid = Array.isArray(links) ? String(links[0] || '') : '';
    if (!rid) return null;
    if (!rancherCache.has(rid)) rancherCache.set(rid, await rancherForReferral(ref));
    return rancherCache.get(rid) ?? null;
  };
  const cachedConsumerForReferral = async (ref: RecoveryRow) => {
    const links = ref.Buyer as unknown;
    const cid = Array.isArray(links) ? String(links[0] || '') : '';
    if (!cid) return null;
    if (!consumerCache.has(cid)) consumerCache.set(cid, await consumerForReferral(ref));
    return consumerCache.get(cid) ?? null;
  };

  let emailPlanned = 0;
  let emailSent = 0;
  let emailDeferred = 0;
  let smsPlanned = 0;
  let smsSent = 0;
  let smsDeferred = 0;

  // ── Recovery EMAIL ──
  for (const ref of emailEligible) {
    const rancher = await cachedRancherForReferral(ref);
    if (!rancher) continue;
    // A1: pull the Consumer — authoritative State (window gate) + identity.
    const consumer = await cachedConsumerForReferral(ref);
    if (!consumer) continue;
    const consumerId = String(consumer.id || '');
    const email = String(consumer['Email'] || ref['Buyer Email'] || '').trim();
    if (!email) continue;
    const state = consumer['State']; // A1: NOT ref['Buyer State']
    emailPlanned++;

    // EMAIL send-window gate — defer (no stamp) outside the local email window.
    if (!isEmailWindow(state, nowMs)) {
      emailDeferred++;
      continue;
    }
    if (!live) continue;

    const cut = cutLabelToCut(ref['Order Type'] || consumer['Order Type']);
    const link = recoveryLink(consumerId, rancher, cut);
    const firstName = String(ref['Buyer Name'] || consumer['Full Name'] || email).trim().split(/[ @]/)[0] || 'there';
    const msg = renderRecoveryEmail({
      firstName,
      cut: cut || 'beef',
      rancher: rancher.name,
      link,
      socialProof: proofForRancher(proof, rancher.id),
    });

    // CLAIM BEFORE SEND — stamp the recovery field first (idempotent).
    try {
      await updateRecord(TABLES.REFERRALS, ref.id, {
        [RESERVE_RECOVERY_EMAIL_FIELD]: now.toISOString(),
      });
    } catch (e: any) {
      failures.push(`reserve-recovery-email ${ref.id}: stamp failed, skipped — ${e?.message?.slice(0, 80) || 'unknown'}`);
      continue;
    }
    try {
      const res = await sendDemandRouterCampaign({
        email,
        subject: msg.subject,
        html: msg.html,
        templateName: RECOVERY_EMAIL_TEMPLATE,
        recipientConsumerId: consumerId || undefined,
        replyConsumerId: consumerId || undefined,
        campaign: RECOVERY_CAMPAIGN_NAME,
      });
      if (res?.success) emailSent++;
      if (res?.suppressed) {
        failures.push(`reserve-recovery-email ${email}: suppressed — ${res.reason || 'unknown'}`);
      } else if (!res?.success) {
        // FAILED, not suppressed (audit 2026-07-22): the ONE-SHOT recovery
        // stamp was already claimed — revert it (it was empty by selector
        // definition) so a later run retries instead of burning the recovery.
        failures.push(`reserve-recovery-email ${email}: send failed — ${res?.reason || 'unknown'} (stamp reverted, will retry)`);
        try {
          await updateRecord(TABLES.REFERRALS, ref.id, { [RESERVE_RECOVERY_EMAIL_FIELD]: null });
        } catch (e2: any) {
          failures.push(`reserve-recovery-email ${ref.id}: stamp revert failed — recovery burned — ${e2?.message?.slice(0, 80) || 'unknown'}`);
        }
      }
    } catch (e: any) {
      failures.push(`reserve-recovery-email ${email}: send failed — ${e?.message?.slice(0, 80) || 'unknown'} (stamp reverted, will retry)`);
      try {
        await updateRecord(TABLES.REFERRALS, ref.id, { [RESERVE_RECOVERY_EMAIL_FIELD]: null });
      } catch (e2: any) {
        failures.push(`reserve-recovery-email ${ref.id}: stamp revert failed — recovery burned — ${e2?.message?.slice(0, 80) || 'unknown'}`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  // ── Recovery SMS (opt-in only, later, distinct angle) ──
  for (const ref of smsEligible) {
    const rancher = await cachedRancherForReferral(ref);
    if (!rancher) continue;
    // A1: pull the Consumer — authoritative State (window gate) + opt-in/phone.
    const consumer = await cachedConsumerForReferral(ref);
    if (!consumer) continue;
    const consumerId = String(consumer.id || '');
    const state = consumer['State']; // A1: NOT ref['Buyer State']
    smsPlanned++;

    // SMS send-window gate — defer (no stamp) outside the local SMS window.
    if (!isSmsWindow(state, nowMs)) {
      smsDeferred++;
      continue;
    }
    // A5: ENABLE_SMS check BEFORE any stamp — if SMS is off (launch default),
    // SKIP ENTIRELY without stamping, so the one-shot recovery field isn't
    // burned and the buyer is still recoverable when SMS turns on.
    if (!smsOn || !live) continue;

    const cut = cutLabelToCut(ref['Order Type'] || consumer['Order Type']);
    const link = recoveryLink(consumerId, rancher, cut);
    const firstName = String(ref['Buyer Name'] || consumer['Full Name'] || '').trim().split(/[ @]/)[0] || 'there';
    const body = renderRecoverySms({
      firstName,
      cut: cut || 'beef',
      rancher: rancher.name,
      link,
      socialProof: proofForRancher(proof, rancher.id),
    });

    // CLAIM BEFORE SEND — stamp the SMS-recovery field first (idempotent). Only
    // reached when smsOn (A5), so a stamp always corresponds to a real attempt.
    try {
      await updateRecord(TABLES.REFERRALS, ref.id, {
        [RESERVE_RECOVERY_SMS_FIELD]: now.toISOString(),
      });
    } catch (e: any) {
      failures.push(`reserve-recovery-sms ${ref.id}: stamp failed, skipped — ${e?.message?.slice(0, 80) || 'unknown'}`);
      continue;
    }
    try {
      const ok = await sendSMSToConsumer({
        consumer,
        body,
        reason: 'demand-router reserve-recovery',
      });
      if (ok) smsSent++;
    } catch (e: any) {
      failures.push(`reserve-recovery-sms ${ref.id}: send failed — ${e?.message?.slice(0, 80) || 'unknown'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return { emailPlanned, emailSent, emailDeferred, smsPlanned, smsSent, smsDeferred };
}

// ── Handler ─────────────────────────────────────────────────────────────────

async function realHandler(_request: Request): Promise<CronResult> {
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }

  // KILL-SWITCH — no-op (success row) unless explicitly enabled. Ships inert.
  if (!routerEnabled()) {
    return {
      status: 'success',
      recordsTouched: 0,
      notes: 'no-op: CAMPAIGN_ROUTER_ENABLED !== "true" (kill-switch off)',
    };
  }

  const live = isLive();
  const smsOn = smsEnabled();
  const now = new Date();
  const nowMs = now.getTime();

  // A2: the campaign's rancher set is CONFIG, not code — DEMAND_CAMPAIGN_
  // RANCHER_IDS (positional: 1st=WEST, 2nd=EAST+CENTRAL) with the original
  // Foodstead+Silverline pair as the default. Pure parse (unit-tested);
  // readCapacity then validates every id with isRancherOperationalForBuyers.
  const campaignRancherIds = parseCampaignRancherIds(process.env);
  const campaignRancherIdSet: ReadonlySet<string> = new Set(campaignRancherIds);

  // 1. Capacity FIRST (audit 2026-07-22): when NO configured rancher survives
  // the operational gate, nothing can send this run — not new invites, not
  // continuations, not recovery (all links route to campaign ranchers) — so we
  // short-circuit BEFORE the four broad table reads (near-full Consumers scan
  // + three Referrals reads) instead of burning the shared Airtable budget.
  const cap = await readCapacity(campaignRancherIds);
  if (cap.pools.length === 0) {
    const why = cap.skipped.concat(cap.degraded).join(' | ') || 'no ids resolved';
    return {
      status: 'success',
      recordsTouched: 0,
      notes: `no-op: no operational campaign rancher this run — skipped all table reads (${why.slice(0, 300)})`,
    };
  }

  // 2. Buyers + Upgrade B social proof + Upgrade A recovery referrals
  // (parallel reads). Recovery rows are read BEFORE the plan so their buyers
  // can be excluded from the wave arc (A4 double-touch fix).
  const [buyers, proof, recoveryRows, activeDealRows] = await Promise.all([
    readBuyers(),
    readSocialProof(nowMs, campaignRancherIds),
    readRecoveryReferrals(nowMs, campaignRancherIdSet),
    readActiveDealReferrals(),
  ]);

  // Row lookup for claim-revert (pre-claim campaign fields) + waitlist
  // already-stamped skips — pure in-memory, no extra reads.
  const buyerFieldsById = new Map<string, Record<string, unknown>>();
  for (const b of buyers) buyerFieldsById.set(b.id, b.fields);

  // FINDING 1: index the mid-deal buyers once (referral truth) — shared by the
  // pure planner (wave arc) and the SMS-recovery pass below.
  const activeDeals = activeDealBuyerKeys(activeDealRows);

  // A4: consumer ids that have an OPEN abandoned-reserve referral → owned by
  // reserve-recovery this run, so the wave arc must skip them (no buyer gets BOTH
  // a wave email and a reserve-recovery email in the same window).
  const excludeBuyerIds = new Set<string>();
  for (const ref of recoveryRows) {
    const links = (ref.Buyer as unknown);
    const cid = Array.isArray(links) ? String(links[0] || '') : '';
    if (cid) excludeBuyerIds.add(cid);
  }

  // 3. PURE PLAN — selection + tiering + capacity gating + wave decisions +
  // suppression + sunset. EMAIL-LED: smsWaves empty so the planner does NOT fire
  // a simultaneous Msg2 SMS — SMS is a separate recovery touch (Upgrade C).
  const plan = buildCampaignPlan(buyers, {
    now: nowMs,
    dailyCap: Number(process.env.CAMPAIGN_DAILY_CAP || 25),
    conversionBuffer: Number(process.env.CAMPAIGN_CONVERSION_BUFFER || 3),
    smsWaves: new Set(), // email-led; SMS handled by runSmsRecovery
    excludeBuyerIds, // A4: skip buyers owned by reserve-recovery this run
    activeDealReferrals: activeDealRows, // finding 1: mid-deal buyers are hands-off
    // N-RANCHER POOL MODEL (audit 2026-07-22): every configured + operational
    // rancher, Routing-States gated, per-rancher budgets with fall-through,
    // true per-UTC-day Msg1 cap.
    pools: cap.pools,
  });

  const failures: string[] = [];
  let emailsSent = 0;
  let emailsDeferred = 0;
  let waitlisted = 0;
  let sunsetted = 0;

  // F24 (2026-08-18): PRE-WARM THE SUPPRESSION LIST ONCE PER RUN, and abort a
  // LIVE batch LOUDLY when it cannot be built. Every sender below rides
  // guardedSend, whose per-send suppression check fails OPEN on a broken
  // list — acceptable for one transactional email, not for a campaign batch:
  // an Airtable outage would let a whole run of marketing sends bypass the
  // unsub/bounce/complaint list (CAN-SPAM + deliverability). One warm build
  // here serves the entire batch via the 5-minute cache.
  if (live) {
    await getSuppressionList();
    if (didSuppressionListBuildFail()) {
      const note = 'ABORTED: suppression list build failed — refusing to batch-send against an empty suppression set (fail closed; retried next run)';
      try {
        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          `🐄 <b>DEMAND ROUTER</b> · 🛑 ${note}`,
        );
      } catch {
        /* the abort itself must not be blocked by Telegram */
      }
      return { status: 'error', recordsTouched: 0, notes: note };
    }
  }

  if (live) {
    // ── EXECUTE: backfill email sends (window-gated, claim-before-send). ──
    for (const send of plan.sends) {
      try {
        // Pre-claim campaign fields for the failed-send claim revert.
        const pf = buyerFieldsById.get(send.buyerId);
        const priorRancherLinks = Array.isArray(pf?.['Campaign Rancher'])
          ? (pf!['Campaign Rancher'] as unknown[]).map(String)
          : null;
        const prior = {
          stage: pf?.['Campaign Stage'] ? String((pf['Campaign Stage'] as any)?.name ?? pf['Campaign Stage']) : null,
          lastSent: pf?.['Campaign Last Sent At'] ? String(pf['Campaign Last Sent At']) : null,
          rancher: priorRancherLinks && priorRancherLinks.length > 0 ? priorRancherLinks : null,
        };
        const result = await executeSend(send, now, proofForRancher(proof, send.rancher.id), failures, prior, cap.brokerRancherIds);
        if (result.emailOk) emailsSent++;
        if (result.deferred) emailsDeferred++;
        // Gentle pace between sends (deliverability) — the email lib also rate-
        // limits internally, this just spreads the loop.
        if (!result.deferred) await new Promise((resolve) => setTimeout(resolve, 250));
      } catch (e: any) {
        failures.push(`${send.email}: send loop error — ${e?.message || 'unknown'}`);
      }
    }
    for (const w of plan.waitlist) {
      try {
        // Idempotent skip (audit 2026-07-22): the same over-budget buyers
        // re-enter plan.waitlist EVERY hourly run — an identical stamp already
        // on the row (pure in-memory check, field is in the buyers read) means
        // no write. Real writes are paced like the send loop.
        const f = buyerFieldsById.get(w.buyerId);
        if (f && String(f['Campaign Waitlist State'] || '').trim() === w.state) continue;
        await stampWaitlist(w.buyerId, w.state);
        waitlisted++;
        await new Promise((resolve) => setTimeout(resolve, 250));
      } catch (e: any) {
        failures.push(`waitlist ${w.buyerId}: ${e?.message || 'unknown'}`);
      }
    }
    for (const s of plan.sunset) {
      try {
        await stampSunset(s.buyerId, now);
        sunsetted++;
      } catch (e: any) {
        failures.push(`sunset ${s.buyerId}: ${e?.message || 'unknown'}`);
      }
    }
  } else {
    // DRY-RUN: count how many of the planned email sends WOULD defer on the
    // send-window (so the report is honest about timing), but stamp/send nothing.
    for (const send of plan.sends) {
      if (!isEmailWindow(send.state, nowMs)) emailsDeferred++;
    }
  }

  // 4. Upgrade C — SMS recovery touch (runs in dry-run as a plan count too).
  const smsRec = await runSmsRecovery(buyers, now, live, smsOn, proof, cap.pools, activeDeals, failures, cap.brokerRancherIds);

  // 5. Upgrade A — abandoned-reserve recovery (email then later SMS). Reuses the
  // already-read recoveryRows (scoped + age-bounded — A7) so no double read.
  const recovery = await runReserveRecovery(recoveryRows, now, live, smsOn, proof, failures);

  // 6. Telegram report. This used to fire on EVERY run, unconditionally. This
  // cron runs hourly, and with the kill-switch off it does nothing — so it was
  // sending 24 messages a day to say a dark rail did nothing. That was 44% of
  // all operator Telegram traffic from this one line. Report when the rail is
  // live, when a dry run actually planned something, or when something failed.
  // A silent dark rail is the correct signal that it is dark.
  const reportWorthSending =
    live || failures.length > 0 || plan.sends.length > 0 || smsRec.planned > 0 || recovery.emailPlanned > 0;
  try {
    if (reportWorthSending) await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      buildReport(plan, {
        live,
        smsOn,
        poolDetail: cap.poolDetail,
        failures,
        degraded: cap.degraded,
        rancherSkips: cap.skipped,
        emailsDeferred,
        proof,
        smsRec,
        recovery,
      }),
    );
  } catch {
    /* non-fatal */
  }

  const suppressedTotal = Object.values(plan.suppressed).reduce((a, b) => a + b, 0);
  const recordsTouched = live
    ? emailsSent + waitlisted + sunsetted + smsRec.sent + recovery.emailSent + recovery.smsSent
    : 0;
  const status: CronResult['status'] = failures.length > 0 ? 'partial' : 'success';
  const planned = plan.sends.length;
  const recoSummary =
    `reserve-recovery email=${recovery.emailSent}/${recovery.emailPlanned} sms=${recovery.smsSent}/${recovery.smsPlanned}` +
    ` · sms-recovery=${smsRec.sent}/${smsRec.planned}`;
  // A2: operator-visible skip note (only when a configured rancher was gated
  // out / config anomaly) — full detail is in the Telegram report.
  const poolSkips = plan.skippedNoRancher.west + plan.skippedNoRancher.eastCentral;
  const skipNote = cap.skipped.length > 0
    ? ` · rancher-skips=${cap.skipped.length} (held-back buyers=${poolSkips}, see Telegram)`
    : '';
  const slotsNote = cap.pools.map((p) => `${p.rancher.name}=${p.openSlots}`).join(' ') || 'none';
  const notes = live
    ? `LIVE email=${emailsSent}/${planned} (deferred=${emailsDeferred}) ${recoSummary} waitlist=${waitlisted} sunset=${sunsetted} suppressed=${suppressedTotal} failures=${failures.length} (slots ${slotsNote})${skipNote}`
    : `DRY-RUN would email=${planned} (defer=${emailsDeferred}) ${recoSummary} · waitlist=${plan.waitlist.length} sunset=${plan.sunset.length} suppressed=${suppressedTotal} (slots ${slotsNote})${skipNote} — set CAMPAIGN_LIVE=true to arm`;

  return { status, recordsTouched, notes };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  // heartbeat: hourly campaign cron — a maxDuration kill mid-batch used to
  // leave NO Cron Runs row (finally never runs) and the 25h dead-man never
  // flags an hourly cron. See lib/cronRun.ts.
  return withCronRun('demand-router', realHandler, { heartbeat: true })(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
