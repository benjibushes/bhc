import { NextResponse } from 'next/server';
import { getAllRecords, getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { CRON_SECRET } from '@/lib/secrets';
import { withCronRun } from '@/lib/cronRun';

// Awaiting Payment nudge — pings ranchers stuck >14d on Awaiting Payment
// referrals. Off-platform closes (rancher reported the close, buyer paying
// on delivery / Venmo / etc) shouldn't sit unresolved — either money lands
// and the rancher confirms via dashboard, or it falls through and the
// rancher marks Closed Lost. Either way the state needs to move.
//
// Why this exists: born from the 2026-05-20 Ashcraft/Eric Turner pattern.
// Awaiting Payment was added as a sane state for "we closed but haven't
// collected yet"; without a nudge, those rows rot.
//
// Schedule: daily 17 UTC (right before referral-chasup at 17 UTC — same
// general "follow-up" cluster).
//
// Throttle: 7 days per referral. Stored on `Rancher Reminded At` (reused
// field — same throttle as stale-lead nudges).

export const maxDuration = 60;

const STUCK_DAYS = 14;
const REMIND_INTERVAL_DAYS = 7;
const MAX_NUDGES_PER_RUN = 25;
const DAY_MS = 86_400_000;

async function realHandler(
  _request: Request,
): Promise<{ status: 'success' | 'partial' | 'maintenance-blocked'; recordsTouched: number; notes: string }> {
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }

  const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';
  const now = Date.now();
  const stuckCutoff = now - STUCK_DAYS * DAY_MS;
  const remindCutoff = now - REMIND_INTERVAL_DAYS * DAY_MS;

  let candidates: any[] = [];
  try {
    candidates = (await getAllRecords(
      TABLES.REFERRALS,
      `{Status} = "Awaiting Payment"`,
    )) as any[];
  } catch (e: any) {
    return {
      status: 'partial',
      recordsTouched: 0,
      notes: `query failed: ${e?.message?.slice(0, 200) || 'unknown'}`,
    };
  }

  // Filter: closed >14d ago, last reminder >7d ago (or never).
  const eligible = candidates.filter((r: any) => {
    const closedAt = r['Closed At'] ? new Date(r['Closed At']).getTime() : 0;
    if (!closedAt || closedAt > stuckCutoff) return false;
    const lastReminder = r['Rancher Reminded At']
      ? new Date(r['Rancher Reminded At']).getTime()
      : 0;
    if (lastReminder && lastReminder > remindCutoff) return false;
    return true;
  });

  const toNudge = eligible.slice(0, MAX_NUDGES_PER_RUN);
  const errors: string[] = [];
  let nudged = 0;

  for (const ref of toNudge) {
    const buyerName = ref['Buyer Name'] || '?';
    const rancherIds: string[] = ref['Rancher'] || ref['Suggested Rancher'] || [];
    const rancherId = Array.isArray(rancherIds) ? rancherIds[0] : null;
    if (!rancherId) {
      errors.push(`${ref.id}: no rancher linked`);
      continue;
    }

    let rancher: any = null;
    try {
      rancher = await getRecordById(TABLES.RANCHERS, rancherId);
    } catch (e: any) {
      errors.push(`${ref.id}: rancher fetch failed (${e?.message})`);
      continue;
    }
    if (!rancher) {
      errors.push(`${ref.id}: rancher record missing`);
      continue;
    }

    const rancherName = rancher['Operator Name'] || rancher['Ranch Name'] || '?';
    const closedDays = Math.floor((now - new Date(ref['Closed At']).getTime()) / DAY_MS);

    // Telegram card for Ben — the operator decides whether to ping the
    // rancher, mark Closed Lost, or let it ride another week. Keeping
    // this operator-mediated for now; a per-rancher email nudge can layer
    // on later (in a separate task) once we see how often this fires.
    // MISMATCH FIX: stamp throttle BEFORE Telegram. Prior order sent
    // the visible card then attempted the throttle stamp — if the stamp
    // write failed, next cron run had no throttle filter and duplicate-
    // nudged. Now: if throttle write fails, abort BEFORE the card.
    try {
      await updateRecord(TABLES.REFERRALS, ref.id, {
        'Rancher Reminded At': new Date().toISOString(),
      });
      if (TELEGRAM_ADMIN_CHAT_ID) {
        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          `🕓 <b>Awaiting Payment ${closedDays}d</b>\n\n` +
            `${buyerName} → ${rancherName}\n` +
            `Closed: ${closedDays} days ago. Still no payment confirmation.\n\n` +
            `Options:\n` +
            `• Rancher confirms payment via /rancher dashboard\n` +
            `• Mark Closed Lost in Airtable if buyer ghosted\n` +
            `• Re-nudge rancher: <code>${SITE_URL}/rancher</code>`,
        );
      }
      nudged++;
    } catch (e: any) {
      errors.push(`${ref.id}: ${e?.message?.slice(0, 100)}`);
    }
  }

  return {
    status: errors.length ? 'partial' : 'success',
    recordsTouched: nudged,
    notes: `eligible=${eligible.length} nudged=${nudged} errs=${errors.length}${errors.length ? ' err1=' + errors[0].slice(0, 80) : ''}`,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  if (CRON_SECRET) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${CRON_SECRET}`) {
      const { searchParams } = new URL(request.url);
      if (searchParams.get('secret') !== CRON_SECRET) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }
  }
  return withCronRun('awaiting-payment-nudge', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
