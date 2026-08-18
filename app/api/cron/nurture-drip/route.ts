// app/api/cron/nurture-drip/route.ts
//
// WAITLIST NURTURE DRIP (#111, 2026-07-08) — daily 16:30 UTC. The last
// unbuilt system: qualified buyers waiting on supply used to get ONE email
// at approval and then silence until routing. Four timed touches
// (lib/nurtureDrip.ts owns who/when, lib/email.ts owns the words):
//   1·d2 education → 2·d6 shop bridge → 3·d12 check-in → 4·d21 long-haul.
//
// SAFETY STACK (each layer independent):
//   - NURTURE_ENABLED 3-state: unset → skip · 'dry-run' → counts to logs +
//     Cron Runs note (Wave 1C: no Telegram while dark), writes nothing ·
//     'true' → live.
//   - Pure selector gates: WAITING/READY only, Qualified At (or Funnel
//     Completed At, for held not-ready completers) required, any
//     active deal referral = out, terminal after touch 4, monotonic order.
//   - P2′ lane gate (lib/marketingSupplyGate): share-ready lane only.
//     'national' (unserved-state / no-budget / community) + 'customer'
//     (TERMINAL) buyers are SKIPPED, counted in the Cron Runs note.
//   - claim-before-send per (buyer, touch) — a crashed run can't double-send.
//   - guardedSend underneath: suppression list + 3/week frequency cap +
//     Email Log. Touch spacing (≥3d) can't trip the cap by itself.
//   - RUN_CAP 60/run + 250ms pacing (Airtable 5 req/s), SOFT_DEADLINE exits
//     honestly (the batch-approve lesson — never die silently mid-list).

import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendOperatorSignal } from '@/lib/operatorSignal';
import { shouldSendCronReport } from '@/lib/cronReportGate';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import { dueNurtureTouch } from '@/lib/nurtureDrip';
import { isActiveDealReferral } from '@/lib/capacityCount';
import { getServedStates } from '@/lib/routingSegment';
import { nurtureLaneGate } from '@/lib/marketingSupplyGate';
import { cooledDown } from '@/lib/marketingTouch';
import {
  sendNurtureEducation,
  sendNurtureShopBridge,
  sendNurtureCheckIn,
  sendNurtureLongHaul,
} from '@/lib/email';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const RUN_CAP = 60;
const SOFT_DEADLINE_MS = 240_000;

interface DripResult {
  status: 'success' | 'partial' | 'maintenance-blocked';
  recordsTouched: number;
  notes: string;
  skipReasonBreakdown?: Record<string, number>;
}

async function realHandler(_request: Request): Promise<DripResult> {
  const mode = process.env.NURTURE_ENABLED;
  if (mode !== 'true' && mode !== 'dry-run') {
    return {
      status: 'success',
      recordsTouched: 0,
      notes: 'skipped: NURTURE_ENABLED not set',
      skipReasonBreakdown: { disabled: 1 },
    };
  }
  if (await isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'maintenance mode' };
  }
  const dryRun = mode === 'dry-run';
  const runStartMs = Date.now();

  const [consumers, referrals, ranchers] = await Promise.all([
    getAllRecords(TABLES.CONSUMERS) as Promise<any[]>,
    getAllRecords(TABLES.REFERRALS) as Promise<any[]>,
    getAllRecords(TABLES.RANCHERS) as Promise<any[]>,
  ]);

  // P2′ SUPPLY/LANE GATE (MARKETING-REVAMP-2026-08 §5): the drip is share-
  // pressure content, so only lane 'share-ready' receives it. Capacity-OUT
  // served-states set (P1′ shared helper) — an at-capacity rancher still
  // counts as coverage, so a single fill never flips a state's drip off.
  const servedStates = getServedStates(ranchers as any);

  // Buyers with a live deal — the drip never talks over a rancher intro.
  const activeDealBuyers = new Set<string>();
  for (const r of referrals) {
    if (!isActiveDealReferral(r)) continue;
    for (const b of (r['Buyer'] || []) as string[]) activeDealBuyers.add(b);
  }

  const now = Date.now();
  const due: Array<{ c: any; touch: number }> = [];
  // P2′ observability: how many otherwise-due buyers the lane gate held back.
  // 'national' buyers are NOT stamped/advanced — the digest/product flows
  // that will serve them are later phases; nothing interim is sent.
  let skippedNational = 0;
  let skippedCustomer = 0;
  // F18 (2026-08-18): cross-rail marketing cooldown — otherwise-due buyers
  // another rail touched within 24h. Skipped WITHOUT stamping, so the touch
  // stays due and fires on a later daily run.
  let skippedCooldown = 0;
  for (const c of consumers) {
    const t = dueNurtureTouch(
      {
        buyerStage: String(c['Buyer Stage'] || ''),
        qualifiedAt: String(c['Qualified At'] || ''),
        funnelCompletedAt: String(c['Funnel Completed At'] || ''),
        email: String(c['Email'] || ''),
        nurtureTouch: Number(c['Nurture Touch'] || 0),
        hasActiveDeal: activeDealBuyers.has(c.id),
        // My Leads (2026-07-29): 'rancher-crm' buyers never enter the drip —
        // they opted into the RANCHER, not into BHC marketing.
        leadSource: String((c['Lead Source'] as any)?.name || c['Lead Source'] || ''),
      },
      now,
    );
    if (!t) continue;
    // Lane gate AFTER the due selector so the counts reflect real
    // suppression (buyers who would actually have been emailed today).
    // share-ready buyers pass through byte-identical to the pre-gate drip
    // (pinned in lib/marketingSupplyGate.test.ts).
    const gate = nurtureLaneGate({
      routingSegment: c['Routing Segment'],
      state: c['State'],
      servedStates,
    });
    if (!gate.send) {
      if (gate.reason === 'national') skippedNational++;
      else skippedCustomer++;
      continue;
    }
    // F18 (2026-08-18): CROSS-RAIL MARKETING COOLDOWN. The drip had NO
    // cross-rail recency check — a buyer the demand-router / requalify /
    // email-sequences / warmup rail emailed this morning could get a nurture
    // touch the same afternoon. The shared lib/marketingTouch gate (24h
    // between ANY two marketing touches; chase rails exempt) holds them for
    // a later run — nothing is stamped, the touch stays due.
    if (!cooledDown(c, now)) {
      skippedCooldown++;
      continue;
    }
    due.push({ c, touch: t.touch });
  }
  const laneNote =
    ` skippedNational=${skippedNational} skippedCustomer=${skippedCustomer} skippedCooldown=${skippedCooldown}`;

  if (dryRun) {
    const byTouch: Record<string, number> = {};
    for (const d of due) byTouch[`touch${d.touch}`] = (byTouch[`touch${d.touch}`] || 0) + 1;
    // Wave 1C: env-dark plan → log + Cron Runs note only; no Telegram for a
    // rail that's off. Failures page via withCronRun's error/partial alert.
    console.info(
      `[nurture-drip] DRY RUN — would send ${Math.min(due.length, RUN_CAP)} of ${due.length} due ` +
        `(${Object.entries(byTouch).map(([k, v]) => `${k}: ${v}`).join(' · ')}) — ` +
        `flip NURTURE_ENABLED=true to go live`,
    );
    return {
      status: 'success',
      recordsTouched: 0,
      notes: `dry-run: ${due.length} due${laneNote}`,
      skipReasonBreakdown: {
        'dry-run-due': due.length,
        'lane-national': skippedNational,
        'lane-customer': skippedCustomer,
        'cross-rail-cooldown': skippedCooldown,
      },
    };
  }

  const { claimOnce } = await import('@/lib/rancherCapacity');
  let sent = 0;
  let failed = 0;
  let timeBoxed = false;
  const senders: Record<number, (d: { firstName: string; email: string; state: string }) => Promise<any>> = {
    1: (d) => sendNurtureEducation(d),
    2: (d) => sendNurtureShopBridge(d),
    3: (d) => sendNurtureCheckIn(d),
    4: (d) => sendNurtureLongHaul(d),
  };

  for (const { c, touch } of due.slice(0, RUN_CAP)) {
    if (Date.now() - runStartMs > SOFT_DEADLINE_MS) { timeBoxed = true; break; }
    try {
      // One winner per (buyer, touch) across concurrent/crashed runs.
      const won = await claimOnce(`nurture:${c.id}:${touch}`, 6 * 60 * 60);
      if (!won) continue;
      const result = await senders[touch]({
        firstName: String(c['Full Name'] || 'there').split(' ')[0],
        email: String(c['Email'] || ''),
        state: String(c['State'] || 'your state'),
      });
      // Suppressed/capped sends resolve WITHOUT throwing (the wrapper
      // returns id 'skipped-suppressed') — STILL stamp the touch so the
      // drip advances instead of re-attempting a suppressed address daily
      // forever; just don't count it as a real send.
      await updateRecord(TABLES.CONSUMERS, c.id, {
        'Nurture Touch': touch,
        'Nurture Touched At': new Date().toISOString(),
      });
      // guardedSend returns { success, suppressed?, reason? } — NOT the raw
      // Resend { data: { id } } shape this originally read. First live run
      // (2026-07-17, 60 processed) proved it: Email Log showed 57 real sends
      // + 3 suppressed while this counted sent=0, so the "🌱 nurture sent N"
      // Telegram never fired and the Cron Runs note read like a dead run.
      const r: any = result;
      if (r?.success && !r?.suppressed) sent++;
    } catch {
      failed++;
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  // Wave 1C transport migration: same gate (work or failures), now with
  // dedupe + failover via sendOperatorSignal. Content unchanged.
  if (shouldSendCronReport({ workDone: sent, failures: failed })) {
    await sendOperatorSignal({
      urgency: 'normal',
      kind: 'other',
      summary: `nurture drip — sent ${sent}` +
        (failed ? ` · ${failed} failed (retried tomorrow)` : '') +
        (due.length > RUN_CAP ? ` · ${due.length - RUN_CAP} deferred to tomorrow` : '') +
        (timeBoxed ? ' · time-boxed' : ''),
      dedupeKey: 'nurture-drip-summary',
      dedupeWindowMs: 6 * 60 * 60 * 1000,
    }).catch(() => {});
  }

  return {
    status: failed || timeBoxed ? 'partial' : 'success',
    recordsTouched: sent,
    notes: `sent=${sent} failed=${failed} due=${due.length}${laneNote}${timeBoxed ? ' timeBoxed' : ''}`,
    skipReasonBreakdown: {
      'lane-national': skippedNational,
      'lane-customer': skippedCustomer,
      'cross-rail-cooldown': skippedCooldown,
    },
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('nurture-drip', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
