// app/api/cron/referral-stale-expiry/route.ts
//
// STALE-HOLD EXPIRY (routing sweep 2026-07-08, BULLETPROOFED same day) —
// daily 13:10 UTC, deliberately BEFORE stuck-buyer-recovery (14:30) so slots
// freed here get routed the SAME morning.
//
// WHY: capacity slots are held from Intro Sent → Closed Won/Lost with no
// expiry — dead intros read as FULL to the matcher while qualified buyers
// sit READY (discovery: Silverline 60/50, Foodstead 59/50). Founder rule:
// ranchers receive leads until they actually SELL their capacity.
//
// THE CLOSED LOOP (all three legs, verified by adversarial review):
//   1. FLIP    — stale pre-money referrals → Status 'Dormant' (+ audit note).
//   2. RESTORE — each flipped referral's buyer: if NO live deal remains
//                (isActiveDealReferral over the full set), Buyer Stage
//                MATCHED → READY, putting them back in every retry rail.
//                Without this the rancher was freed but the buyer stranded.
//   3. RESYNC  — affected ranchers' capacity counters recomputed from truth
//                and written to BOTH Redis and the Airtable mirror
//                (setCapacityCounter), so freed slots are visible to the
//                matcher immediately — not at next-day batch-approve.
//
// Selection prioritizes capacity-BLOCKED operational ranchers (the flips
// that actually reopen routing), excludes unlinked rows (free nothing), and
// stays conservative: pre-money statuses only, any deposit signal blocks,
// 21d silent both sides, 50/run.
//
// DARK: STALE_HOLD_EXPIRY_ENABLED unset → skip · 'dry-run' → Telegram
// report, writes NOTHING · 'true' → full loop. STALE_HOLD_DAYS overrides 21.

import { getAllRecords, getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import { selectStaleHolds, freedByRancher, DEFAULT_STALE_DAYS, EXPIRABLE_STATUSES } from '@/lib/staleHolds';
import { countHeldReferrals, isActiveDealReferral } from '@/lib/capacityCount';
import { setCapacityCounter, getMaxActiveReferrals } from '@/lib/rancherCapacity';
import { isRancherOperationalForBuyers } from '@/lib/rancherEligibility';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const RUN_CAP = 50;

interface ExpiryResult {
  status: 'success' | 'partial' | 'maintenance-blocked';
  recordsTouched: number;
  notes: string;
  skipReasonBreakdown?: Record<string, number>;
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
  const staleDays = Number(process.env.STALE_HOLD_DAYS) || DEFAULT_STALE_DAYS;

  // FULL referrals read (one scan): selection input + buyer-active map +
  // per-rancher capacity recount all derive from this single snapshot.
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

  const candidates = allRefs.filter((r) => EXPIRABLE_STATUSES.has(String(r?.['Status'] || '')));
  const stale = selectStaleHolds(candidates, Date.now(), { staleDays, cap: RUN_CAP, priorityRancherIds });

  if (stale.length === 0) {
    return { status: 'success', recordsTouched: 0, notes: `no stale holds (${candidates.length} open intros scanned)` };
  }

  const perRancher = freedByRancher(stale);
  const reportLines = Object.entries(perRancher)
    .sort((a, b) => b[1] - a[1])
    .map(([rid, n]) =>
      `· ${rancherNames[rid] || rid}: ${n} slot${n === 1 ? '' : 's'}${priorityRancherIds.has(rid) ? ' ⚡capacity-blocked' : ''}`);

  if (dryRun) {
    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      `🧪 <b>stale-hold expiry DRY RUN</b> — nothing written\n\n` +
        `would free <b>${stale.length}</b> slot${stale.length === 1 ? '' : 's'} ` +
        `(intros silent &gt;${staleDays}d, zero deposit signals):\n${reportLines.join('\n')}\n\n` +
        `live mode also: resets stranded buyers → READY + resyncs capacity counters (Redis + mirror) ` +
        `so the 14:30 UTC recovery pass routes freed slots same-day. flip STALE_HOLD_EXPIRY_ENABLED=true.`,
    ).catch(() => {});
    return {
      status: 'success',
      recordsTouched: 0,
      notes: `dry-run: would expire ${stale.length}`,
      skipReasonBreakdown: { 'dry-run-would-expire': stale.length },
    };
  }

  // ── LEG 1: FLIP (+ audit note so cron-expired ≠ manually-set Dormant) ──
  const flippedIds = new Set<string>();
  const auditStamp = `[auto-expired ${new Date().toISOString().slice(0, 10)}: no activity ${staleDays}d — slot released]`;
  let failed = 0;
  for (const ref of stale) {
    try {
      const existingNotes = String((ref as any)['Notes'] || '');
      await updateRecord(TABLES.REFERRALS, ref.id, {
        Status: 'Dormant',
        Notes: existingNotes ? `${existingNotes}\n${auditStamp}` : auditStamp,
      });
      flippedIds.add(ref.id);
    } catch {
      failed++;
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  // ── LEG 2: RESTORE stranded buyers (MATCHED → READY when no live deal) ──
  const buyersToCheck = new Set<string>();
  for (const ref of stale) {
    if (!flippedIds.has(ref.id)) continue;
    for (const b of ((ref as any)['Buyer'] || []) as string[]) buyersToCheck.add(b);
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
  const affectedRanchers = new Set<string>();
  for (const ref of stale) {
    if (!flippedIds.has(ref.id)) continue;
    const link = (ref as any)['Rancher'];
    if (Array.isArray(link) && link[0]) affectedRanchers.add(String(link[0]));
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

  await sendTelegramMessage(
    TELEGRAM_ADMIN_CHAT_ID,
    `🧹 <b>stale-hold expiry</b> — freed <b>${flippedIds.size}</b> slot${flippedIds.size === 1 ? '' : 's'}` +
      (failed ? ` (${failed} failed, retried tomorrow)` : '') +
      `\n\n${reportLines.join('\n')}\n\n` +
      `buyers reset to READY: <b>${restored}</b> · counters resynced now: <b>${resynced}</b> rancher${resynced === 1 ? '' : 's'} · ` +
      `recovery cron routes freed slots at 14:30 UTC today.`,
  ).catch(() => {});

  return {
    status: failed ? 'partial' : 'success',
    recordsTouched: flippedIds.size,
    notes: `expired ${flippedIds.size}${failed ? `, ${failed} failed` : ''} · buyers restored ${restored} · counters resynced ${resynced}`,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('referral-stale-expiry', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
