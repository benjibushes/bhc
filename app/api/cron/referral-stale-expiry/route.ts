// app/api/cron/referral-stale-expiry/route.ts
//
// NO-DEAD-END SWEEP (was: stale-hold expiry) — daily 13:10 UTC, deliberately
// BEFORE stuck-buyer-recovery (14:30) so everything freed here gets routed the
// SAME morning.
//
// THREE TIERS, ONE CLOSED LOOP. Each tier answers a different way a deal can
// rot; all three then share the exact same restore + resync legs.
//
//   TIER 1 — STALE CAPACITY HOLDS (2026-07-08, LIVE)
//     Intro Sent / Rancher Contacted / Negotiation gone silent past their
//     window. Capacity slots are held from Intro Sent → Closed Won/Lost with
//     no expiry — dead intros read as FULL to the matcher while qualified
//     buyers sit READY (discovery: Silverline 60/50, Foodstead 59/50).
//     Founder rule: ranchers receive leads until they actually SELL.
//
//   TIER 2 — PENDING APPROVAL (2026-07-30, NEW — gated)
//     A rancher who never taps approve/decline froze the deal permanently:
//     'Pending Approval' had NO expiry path, and isActiveDealReferral counts
//     it as a live deal, so the BUYER was locked out of the entire
//     marketplace. Six buyers were stuck 58–92 days at discovery. This tier
//     frees no capacity slot (Pending Approval is pre-INCR by design — see
//     lib/capacityCount.ts); it frees the buyer. Window: ⅓ of the base (7d).
//
//   TIER 3 — UNREACHABLE DEPOSIT RELEASE (2026-07-30, NEW — gated)
//     A deposit request that was never paid: the chase caps at 2 buyer nudges
//     (lib/depositRequestNudge) and then nothing ever released the buyer. Six
//     buyers sat ~27 days past the ask with the deposit link NEVER opened and
//     both nudges spent. 'Awaiting Payment' IS capacity-holding, so each one
//     pinned a slot too. Money safety is the whole design of
//     lib/depositRelease — read that header before touching this tier.
//
// THE CLOSED LOOP (all three legs, verified by adversarial review):
//   1. FLIP    — selected referrals → 'Dormant' (+ per-tier audit note; tier 3
//                also stamps the structured Loss Reason).
//   2. RESTORE — each flipped referral's buyer: if NO live deal remains
//                (isActiveDealReferral over the full set), Buyer Stage
//                MATCHED → READY, putting them back in every retry rail.
//                Without this the rancher was freed but the buyer stranded.
//   3. RESYNC  — affected ranchers' capacity counters recomputed from truth
//                and written to BOTH Redis and the Airtable mirror
//                (setCapacityCounter), so freed slots are visible to the
//                matcher immediately — not at next-day batch-approve.
//
// Selection prioritizes capacity-BLOCKED operational ranchers, excludes rows
// with no attributed rancher (they free nothing and block nobody), honors the
// operator's ⏸️ Hold park and the 'rancher-added' My-Leads carve-out in every
// tier, and stays conservative: any deposit signal blocks tiers 1–2 outright.
//
// ── GATES ───────────────────────────────────────────────────────────────────
// STALE_HOLD_EXPIRY_ENABLED (master, unchanged): unset → whole cron skips ·
//   'dry-run' → log + Cron Runs note only (Wave 1C: no Telegram for a plan
//   that never executes), writes NOTHING · 'true' → runs.
// DEAL_RELEASE_ENABLED (NEW, default DRY): tiers 2+3 only. Anything but 'true'
//   → they are SELECTED and REPORTED every run but write nothing, so Ben reads
//   one honest report before ~12 real records are touched. 'true' → they write.
//   Tier 1's behavior is completely unchanged by this flag.
// STALE_HOLD_DAYS overrides the 21d base for every tier's multiplier.

import { getAllRecords, getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { findPaymentsByReferral } from '@/lib/contracts/payments';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendOperatorSignal } from '@/lib/operatorSignal';
import { shouldSendCronReport } from '@/lib/cronReportGate';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import {
  selectStaleHolds,
  freedByRancher,
  attributedRancherId,
  expiryNoteStamp,
  silentDays,
  formatDays,
  DEFAULT_STALE_DAYS,
  CAPACITY_HOLD_EXPIRABLE_STATUSES,
  BUYER_BLOCK_EXPIRABLE_STATUSES,
  staleDaysForStatus,
} from '@/lib/staleHolds';
import {
  selectDepositReleaseCandidates,
  depositReleaseRefusal,
  refusalBreakdown,
  releaseNoteStamp,
  daysSince,
  probeFromPayments,
  PAYMENTS_PROBE_FAILED,
  DEPOSIT_RELEASE_STATUS,
  DEPOSIT_RELEASE_LOSS_REASON,
  DEPOSIT_RELEASE_SILENCE_DAYS,
} from '@/lib/depositRelease';
import { countHeldReferrals, isActiveDealReferral } from '@/lib/capacityCount';
import { setCapacityCounter, getMaxActiveReferrals } from '@/lib/rancherCapacity';
import { isRancherOperationalForBuyers } from '@/lib/rancherEligibility';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const RUN_CAP = 50;
// Tiers 2+3 act on a much smaller, much more consequential cohort (a flip here
// ends a buyer's deal outright). Their own, tighter caps keep a bad day from
// touching dozens of real records before anyone notices.
const PENDING_APPROVAL_RUN_CAP = 25;
const DEPOSIT_RELEASE_RUN_CAP = 25;

const DEPOSIT_AWAITING_STATUS = 'Awaiting Payment';

interface ExpiryResult {
  status: 'success' | 'partial' | 'maintenance-blocked';
  recordsTouched: number;
  notes: string;
  skipReasonBreakdown?: Record<string, number>;
}

/** One pending write, so all three tiers share the flip/restore/resync legs. */
interface PlannedFlip {
  ref: any;
  tier: 'capacity' | 'pending-approval' | 'deposit-release';
  fields: Record<string, unknown>;
}

async function realHandler(_request: Request): Promise<ExpiryResult> {
  const mode = process.env.STALE_HOLD_EXPIRY_ENABLED;
  if (mode !== 'true' && mode !== 'dry-run') {
    return {
      status: 'success',
      recordsTouched: 0,
      notes: 'skipped: STALE_HOLD_EXPIRY_ENABLED not set',
      skipReasonBreakdown: { disabled: 1 },
    };
  }
  if (await isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'maintenance mode' };
  }
  const dryRun = mode === 'dry-run';
  // Tiers 2+3 default to DRY even when the master switch is live: the first
  // production run acts on ~12 real records, and Ben reads the report first.
  const releaseLive = process.env.DEAL_RELEASE_ENABLED === 'true';
  const staleDays = Number(process.env.STALE_HOLD_DAYS) || DEFAULT_STALE_DAYS;
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);

  // FULL referrals read (one scan): every tier's selection input + the
  // buyer-active map + per-rancher capacity recount derive from this snapshot.
  const allRefs = (await getAllRecords(TABLES.REFERRALS)) as any[];
  const ranchers = (await getAllRecords(TABLES.RANCHERS)) as any[];

  const rancherNames: Record<string, string> = {};
  const priorityRancherIds = new Set<string>();
  for (const r of ranchers) {
    rancherNames[r.id] = String(r['Ranch Name'] || r.id);
    // Priority = operational ranchers whose TRUE held count blocks routing —
    // freeing their slots is the whole point; they jump the selection queue.
    try {
      if (isRancherOperationalForBuyers(r)) {
        const held = countHeldReferrals(r.id, allRefs);
        if (held >= getMaxActiveReferrals(r)) priorityRancherIds.add(r.id);
      }
    } catch { /* prioritization is best-effort */ }
  }

  const statusOf = (r: any): string => String(r?.['Status'] || '');
  const nameOf = (r: any): string => String(r?.['Buyer Name'] || '').trim() || '(no name)';

  // ── TIER 1: stale capacity holds (unchanged behavior) ──────────────────────
  const capacityCandidates = allRefs.filter((r) =>
    CAPACITY_HOLD_EXPIRABLE_STATUSES.has(statusOf(r)),
  );
  const staleCapacity = selectStaleHolds(capacityCandidates, now, {
    staleDays,
    cap: RUN_CAP,
    priorityRancherIds,
  });

  // ── TIER 2: pending approval (gated) ──────────────────────────────────────
  const pendingCandidates = allRefs.filter((r) => BUYER_BLOCK_EXPIRABLE_STATUSES.has(statusOf(r)));
  const stalePending = selectStaleHolds(pendingCandidates, now, {
    staleDays,
    cap: PENDING_APPROVAL_RUN_CAP,
    priorityRancherIds,
  });

  // ── TIER 3: unreachable deposit release (gated) ───────────────────────────
  // Narrow with the pure static gates FIRST, then spend one Payments lookup
  // per capped survivor — never an N+1 over the whole table.
  const depositCandidates = allRefs.filter((r) => statusOf(r) === DEPOSIT_AWAITING_STATUS);
  const depositShortlist = selectDepositReleaseCandidates(depositCandidates, {
    nowMs: now,
    cap: DEPOSIT_RELEASE_RUN_CAP,
  });
  for (const r of depositShortlist) {
    // FAIL CLOSED: a throw leaves the probe at ok:false, which the pure gate
    // turns into a 'payment-state-unknown' refusal. An Airtable blip must
    // never read as "this referral has no payments."
    try {
      r.__payments = probeFromPayments(await findPaymentsByReferral(String(r.id)));
    } catch {
      r.__payments = PAYMENTS_PROBE_FAILED;
    }
    await new Promise((s) => setTimeout(s, 150));
  }
  const depositReleases = depositShortlist.filter(
    (r) => depositReleaseRefusal(r, now) === null,
  );
  // Over EVERY awaiting-payment row, not just the shortlist: "0 released" has
  // to be diagnosable from the Cron Runs note alone, without a re-read.
  const depositRefusals = refusalBreakdown(depositCandidates, now);

  const totalSelected = staleCapacity.length + stalePending.length + depositReleases.length;
  if (totalSelected === 0) {
    return {
      status: 'success',
      recordsTouched: 0,
      notes:
        `nothing to release · holds=${capacityCandidates.length} pendingApproval=${pendingCandidates.length} ` +
        `awaitingPayment=${depositCandidates.length}` +
        (Object.keys(depositRefusals).length
          ? ` depositRefusals=${Object.entries(depositRefusals).map(([k, v]) => `${k}:${v}`).join(',')}`
          : ''),
    };
  }

  // ── Operator report lines (shared by dry-run and live) ────────────────────
  const perRancher = freedByRancher(staleCapacity);
  const capacityLines = Object.entries(perRancher)
    .sort((a, b) => b[1] - a[1])
    .map(([rid, n]) =>
      `· ${rancherNames[rid] || rid}: ${n} slot${n === 1 ? '' : 's'}${priorityRancherIds.has(rid) ? ' ⚡capacity-blocked' : ''}`);
  const pendingLines = stalePending.map((r) => {
    const rid = attributedRancherId(r);
    const d = silentDays(r, now);
    return `· ${nameOf(r)} → ${rancherNames[rid] || rid || '?'} (${d === null ? '?' : d}d unanswered)`;
  });
  const depositLines = depositReleases.map((r) => {
    const rid = attributedRancherId(r);
    // Age of the ASK is the number that matters here (not generic silence) —
    // it is the same number the Notes stamp records.
    const asked = daysSince(r['Deposit Requested At'], now);
    const opened = String(r['Deposit Link Opened At'] || '').trim() ? 'link opened' : 'link NEVER opened';
    return `· ${nameOf(r)} → ${rancherNames[rid] || rid || '?'} (asked ${asked === null ? '?' : asked}d ago, ${opened})`;
  });

  const gateNote = releaseLive ? '' : ' <i>(DRY — set DEAL_RELEASE_ENABLED=true to act)</i>';
  const tierBlocks: string[] = [];
  if (capacityLines.length) {
    tierBlocks.push(
      `<b>Stale holds</b> — ${staleCapacity.length} slot${staleCapacity.length === 1 ? '' : 's'} ` +
        `(silent &gt;${formatDays(staleDays)}d · Negotiation &gt;${formatDays(staleDaysForStatus('Negotiation', staleDays))}d):\n` +
        capacityLines.join('\n'),
    );
  }
  if (pendingLines.length) {
    tierBlocks.push(
      `<b>Pending Approval never answered</b> — ${stalePending.length} buyer${stalePending.length === 1 ? '' : 's'} ` +
        `unblocked (&gt;${formatDays(staleDaysForStatus('Pending Approval', staleDays))}d)${gateNote}:\n` +
        pendingLines.join('\n'),
    );
  }
  if (depositLines.length) {
    tierBlocks.push(
      `<b>Unpaid deposits released</b> — ${depositReleases.length} buyer${depositReleases.length === 1 ? '' : 's'} ` +
        `(nudges exhausted + ${DEPOSIT_RELEASE_SILENCE_DAYS}d silence, zero payments on file)${gateNote}:\n` +
        depositLines.join('\n'),
    );
  }

  if (dryRun) {
    // Wave 1C: a dry-run plan repeats daily and never executes — log + Cron
    // Runs note only; withCronRun alerts on failures. No Telegram.
    console.info(
      `[referral-stale-expiry] DRY RUN — would expire ${staleCapacity.length} holds, ` +
        `${stalePending.length} pending-approval, ${depositReleases.length} unpaid deposits ` +
        `(flip STALE_HOLD_EXPIRY_ENABLED=true to act)`,
    );
    return {
      status: 'success',
      recordsTouched: 0,
      notes:
        `dry-run: would expire ${staleCapacity.length} holds, ${stalePending.length} pending-approval, ` +
        `${depositReleases.length} unpaid deposits`,
      skipReasonBreakdown: {
        'dry-run-would-expire': staleCapacity.length,
        'dry-run-would-expire-pending': stalePending.length,
        'dry-run-would-release-deposit': depositReleases.length,
      },
    };
  }

  // ── PLAN: one write payload per row, so the legs below are tier-agnostic ──
  const planned: PlannedFlip[] = [];
  const withNote = (ref: any, stamp: string): string => {
    const existing = String(ref?.['Notes'] || '');
    return existing ? `${existing}\n${stamp}` : stamp;
  };
  for (const ref of staleCapacity) {
    planned.push({
      ref,
      tier: 'capacity',
      fields: { Status: 'Dormant', Notes: withNote(ref, expiryNoteStamp(ref, { today, staleDays, nowMs: now })) },
    });
  }
  if (releaseLive) {
    for (const ref of stalePending) {
      planned.push({
        ref,
        tier: 'pending-approval',
        fields: { Status: 'Dormant', Notes: withNote(ref, expiryNoteStamp(ref, { today, staleDays, nowMs: now })) },
      });
    }
    for (const ref of depositReleases) {
      planned.push({
        ref,
        tier: 'deposit-release',
        fields: {
          Status: DEPOSIT_RELEASE_STATUS,
          // Structured reason on a DORMANT row, never Closed Lost — see the
          // LOSS-REASON SCOPING block in lib/depositRelease.ts.
          'Loss Reason': DEPOSIT_RELEASE_LOSS_REASON,
          Notes: withNote(ref, releaseNoteStamp(ref, { today, nowMs: now })),
        },
      });
    }
  }

  // ── LEG 1: FLIP (+ audit note so cron-expired ≠ manually-set Dormant) ──
  const flippedIds = new Set<string>();
  const flippedByTier: Record<string, number> = {};
  let failed = 0;
  for (const plan of planned) {
    try {
      await updateRecord(TABLES.REFERRALS, plan.ref.id, plan.fields);
      flippedIds.add(plan.ref.id);
      flippedByTier[plan.tier] = (flippedByTier[plan.tier] || 0) + 1;
    } catch {
      failed++;
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  // ── LEG 2: RESTORE stranded buyers (MATCHED → READY when no live deal) ──
  const buyersToCheck = new Set<string>();
  for (const plan of planned) {
    if (!flippedIds.has(plan.ref.id)) continue;
    for (const b of ((plan.ref as any)['Buyer'] || []) as string[]) buyersToCheck.add(b);
  }
  let restored = 0;
  for (const buyerId of buyersToCheck) {
    const stillActive = allRefs.some(
      (r) =>
        !flippedIds.has(r.id) &&
        Array.isArray(r['Buyer']) &&
        r['Buyer'].includes(buyerId) &&
        isActiveDealReferral(r),
    );
    if (stillActive) continue;
    try {
      const consumer: any = await getRecordById(TABLES.CONSUMERS, buyerId);
      // Only MATCHED flips back — never stomp CLOSED / NURTURE / PRODUCT_BUYER.
      if (String(consumer?.['Buyer Stage'] || '') === 'MATCHED') {
        await updateRecord(TABLES.CONSUMERS, buyerId, { 'Buyer Stage': 'READY' });
        restored++;
      }
    } catch { /* per-buyer best-effort; tomorrow's run re-checks */ }
    await new Promise((r) => setTimeout(r, 200));
  }

  // ── LEG 3: RESYNC capacity counters (Redis + Airtable mirror) NOW ──
  // Tier 2 rows held no slot (Pending Approval is pre-INCR), so their resync
  // is a harmless no-op recompute-from-truth; tiers 1+3 genuinely free one.
  const affectedRanchers = new Set<string>();
  for (const plan of planned) {
    if (!flippedIds.has(plan.ref.id)) continue;
    const rid = attributedRancherId(plan.ref);
    if (rid) affectedRanchers.add(rid);
  }
  const postFlipRefs = allRefs.filter((r) => !flippedIds.has(r.id));
  let resynced = 0;
  for (const rid of affectedRanchers) {
    try {
      const truth = countHeldReferrals(rid, postFlipRefs);
      await setCapacityCounter(rid, truth);
      resynced++;
    } catch { /* drift-check (6h) is the backstop */ }
  }

  const heldFreed = (flippedByTier['capacity'] || 0) + (flippedByTier['deposit-release'] || 0);
  // Wave 1C: the "nothing written this run" card (gated tiers selected, tier 1
  // empty) repeated daily with the same names — zero-work runs now stay in the
  // Cron Runs note. Report only when something was actually released or a
  // write failed; rides sendOperatorSignal for dedupe + failover.
  if (shouldSendCronReport({ workDone: flippedIds.size, failures: failed })) {
    await sendOperatorSignal({
      urgency: 'normal',
      kind: 'other',
      summary:
        `no-dead-end sweep — released ${flippedIds.size} deal${flippedIds.size === 1 ? '' : 's'} ` +
        `(${heldFreed} capacity slot${heldFreed === 1 ? '' : 's'})` +
        (failed ? ` · ${failed} failed, retried tomorrow` : ''),
      detail:
        `${tierBlocks.join('\n\n')}\n\n` +
        `buyers reset to READY: <b>${restored}</b> · counters resynced now: <b>${resynced}</b> rancher${resynced === 1 ? '' : 's'} · ` +
        `recovery cron re-routes them at 14:30 UTC today.`,
      dedupeKey: 'referral-stale-expiry-summary',
      dedupeWindowMs: 6 * 60 * 60 * 1000,
    }).catch(() => {});
  } else if (!planned.length) {
    console.info(
      '[referral-stale-expiry] nothing written this run — gated tiers only ' +
        `(DEAL_RELEASE_ENABLED off): pending=${stalePending.length} deposit=${depositReleases.length}`,
    );
  }

  const tierNote = Object.entries(flippedByTier)
    .map(([k, v]) => `${k}:${v}`)
    .join(',');
  return {
    status: failed ? 'partial' : 'success',
    recordsTouched: flippedIds.size,
    notes:
      `released ${flippedIds.size} (${tierNote || 'none'})${failed ? `, ${failed} failed` : ''} · ` +
      `buyers restored ${restored} · counters resynced ${resynced}` +
      (releaseLive ? '' : ` · tiers 2+3 DRY (would: pending ${stalePending.length}, deposit ${depositReleases.length})`),
    skipReasonBreakdown: {
      ...flippedByTier,
      ...(releaseLive
        ? {}
        : {
            'dry-pending-approval': stalePending.length,
            'dry-deposit-release': depositReleases.length,
          }),
      ...depositRefusals,
    },
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('referral-stale-expiry', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
