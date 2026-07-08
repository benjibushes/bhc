// app/api/cron/nurture-drip/route.ts
//
// WAITLIST NURTURE DRIP (#111, 2026-07-08) — daily 16:30 UTC. The last
// unbuilt system: qualified buyers waiting on supply used to get ONE email
// at approval and then silence until routing. Four timed touches
// (lib/nurtureDrip.ts owns who/when, lib/email.ts owns the words):
//   1·d2 education → 2·d6 shop bridge → 3·d12 check-in → 4·d21 long-haul.
//
// SAFETY STACK (each layer independent):
//   - NURTURE_ENABLED 3-state: unset → skip · 'dry-run' → Telegram counts,
//     writes nothing · 'true' → live.
//   - Pure selector gates: WAITING/READY only, Qualified At required, any
//     active deal referral = out, terminal after touch 4, monotonic order.
//   - claim-before-send per (buyer, touch) — a crashed run can't double-send.
//   - guardedSend underneath: suppression list + 3/week frequency cap +
//     Email Log. Touch spacing (≥3d) can't trip the cap by itself.
//   - RUN_CAP 60/run + 250ms pacing (Airtable 5 req/s), SOFT_DEADLINE exits
//     honestly (the batch-approve lesson — never die silently mid-list).

import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import { dueNurtureTouch } from '@/lib/nurtureDrip';
import { isActiveDealReferral } from '@/lib/capacityCount';
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

  const [consumers, referrals] = await Promise.all([
    getAllRecords(TABLES.CONSUMERS) as Promise<any[]>,
    getAllRecords(TABLES.REFERRALS) as Promise<any[]>,
  ]);

  // Buyers with a live deal — the drip never talks over a rancher intro.
  const activeDealBuyers = new Set<string>();
  for (const r of referrals) {
    if (!isActiveDealReferral(r)) continue;
    for (const b of (r['Buyer'] || []) as string[]) activeDealBuyers.add(b);
  }

  const now = Date.now();
  const due: Array<{ c: any; touch: number }> = [];
  for (const c of consumers) {
    const t = dueNurtureTouch(
      {
        buyerStage: String(c['Buyer Stage'] || ''),
        qualifiedAt: String(c['Qualified At'] || ''),
        email: String(c['Email'] || ''),
        nurtureTouch: Number(c['Nurture Touch'] || 0),
        hasActiveDeal: activeDealBuyers.has(c.id),
      },
      now,
    );
    if (t) due.push({ c, touch: t.touch });
  }

  if (dryRun) {
    const byTouch: Record<string, number> = {};
    for (const d of due) byTouch[`touch${d.touch}`] = (byTouch[`touch${d.touch}`] || 0) + 1;
    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      `🌱 <b>nurture drip DRY RUN</b> — nothing sent\n\n` +
        `would send <b>${Math.min(due.length, RUN_CAP)}</b> of ${due.length} due ` +
        `(${Object.entries(byTouch).map(([k, v]) => `${k}: ${v}`).join(' · ')})\n\n` +
        `d2 education · d6 shop · d12 check-in · d21 long-haul. flip NURTURE_ENABLED=true to go live.`,
    ).catch(() => {});
    return {
      status: 'success',
      recordsTouched: 0,
      notes: `dry-run: ${due.length} due`,
      skipReasonBreakdown: { 'dry-run-due': due.length },
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
      const sentId = String((result as any)?.data?.id || '');
      if (sentId && !sentId.startsWith('skipped')) sent++;
    } catch {
      failed++;
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  if (sent > 0 || failed > 0) {
    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      `🌱 <b>nurture drip</b> — sent <b>${sent}</b>` +
        (failed ? ` · ${failed} failed (retried tomorrow)` : '') +
        (due.length > RUN_CAP ? ` · ${due.length - RUN_CAP} deferred to tomorrow` : '') +
        (timeBoxed ? ' · time-boxed' : ''),
    ).catch(() => {});
  }

  return {
    status: failed || timeBoxed ? 'partial' : 'success',
    recordsTouched: sent,
    notes: `sent=${sent} failed=${failed} due=${due.length}${timeBoxed ? ' timeBoxed' : ''}`,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('nurture-drip', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
