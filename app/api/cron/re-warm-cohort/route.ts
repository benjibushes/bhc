import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { CRON_SECRET } from '@/lib/secrets';
import { withCronRun } from '@/lib/cronRun';

// Re-warm cohort cron — reanimates buyers stuck in the "warmed but never
// engaged" state.
//
// The problem this solves:
//   ~679 buyers (as of 2026-05-19) received the rancher-launch-warmup
//   email, never clicked YES, and never moved out of waitlist. Every other
//   cron filters them out:
//     - rancher-launch-warmup Phase 1: filters NOT({Warmup Sent At})
//     - rancher-launch-warmup Phase 2 Day-7 nudge: one-shot (Warmup Stage='nudged')
//     - email-sequences READY_NUDGE: one-shot (Sequence Stage='READY_NUDGE')
//     - batch-approve waitlist retry: gated by isQualifiedForRouting which
//       requires an explicit YES click
//   They are dead inventory forever unless we reset them.
//
// What this cron does:
//   Once per day, find buyers warmed 60+ days ago with no engagement and
//   clear their Warmup Sent At + Warmup Stage. That puts them back in the
//   rancher-launch-warmup Phase 1 candidate set so they get a fresh warmup
//   the next time their rancher's batch fires.
//
// Safety rails:
//   - Lifetime cap of 2 re-warm attempts per buyer (Re-Warm Attempts field)
//     prevents infinite spam to disengaged buyers.
//   - Daily reanimation cap of 50 bleeds the cohort in over ~2 weeks so
//     Resend doesn't see a spike.
//   - Respects Unsubscribed / Bounced / Complained suppression flags.
//
// Schedule: daily 16:30 UTC (10:30 AM MT) — runs after rancher-launch-warmup
// at 13:30 UTC so reanimated buyers wait one full day before next warmup batch.

export const maxDuration = 60;

const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;
const DAILY_REANIMATE_CAP = 50;
const MAX_REWARM_ATTEMPTS = 2;
// Outer per-run ceiling — layered on top of DAILY_REANIMATE_CAP.
// Tighter cap under paid-scale to keep cohort drain predictable.
const MAX_PER_RUN = 25;

async function realHandler(
  _request: Request,
): Promise<{ status: 'success' | 'partial' | 'maintenance-blocked'; recordsTouched: number; notes: string }> {
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }

  // Pull stuck cohort: Approved + Warmup Sent At set + Warmup Engaged At empty
  // + not suppressed. Filter the 60-day age window + lifetime-cap in JS so we
  // don't need a complex Airtable formula.
  const buyers = (await getAllRecords(
    TABLES.CONSUMERS,
    `AND({Status} = "Approved", {Warmup Sent At} != BLANK(), {Warmup Engaged At} = BLANK(), NOT({Unsubscribed}), NOT({Bounced}), NOT({Complained}))`,
  )) as any[];

  const now = Date.now();
  const eligible = buyers.filter((b) => {
    const attempts = Number(b['Re-Warm Attempts']) || 0;
    if (attempts >= MAX_REWARM_ATTEMPTS) return false;
    // Skip buyers who already engaged via Ready to Buy (they'll route through
    // matching/suggest on the next batch-approve run anyway).
    if (b['Ready to Buy']) return false;
    const sentAt = new Date(b['Warmup Sent At']).getTime();
    if (Number.isNaN(sentAt)) return false;
    return now - sentAt >= SIXTY_DAYS_MS;
  });

  const toReanimate = eligible.slice(0, DAILY_REANIMATE_CAP);
  const errors: string[] = [];
  let reanimated = 0;

  for (const b of toReanimate) {
    if (reanimated >= MAX_PER_RUN) {
      console.log(`[re-warm-cohort] hit MAX_PER_RUN=${MAX_PER_RUN}, stopping`);
      break;
    }
    try {
      await updateRecord(TABLES.CONSUMERS, b.id, {
        // Clear so rancher-launch-warmup Phase 1 NOT({Warmup Sent At}) filter
        // picks them back up.
        'Warmup Sent At': null,
        'Warmup Stage': null,
        // Audit trail: when we reset + how many times. Increment defensively
        // so a second cron run on the same day can't double-bump (the 60-day
        // age check above only passes once Warmup Sent At is repopulated).
        'Warmup Reanimated At': new Date().toISOString(),
        'Re-Warm Attempts': (Number(b['Re-Warm Attempts']) || 0) + 1,
      });
      reanimated++;
    } catch (e: any) {
      errors.push(`${b.id}: ${e?.message || String(e)}`);
    }
  }

  // Telegram heads-up so Ben knows the next rancher-launch-warmup batch will
  // be larger than usual.
  if (reanimated > 0 && TELEGRAM_ADMIN_CHAT_ID) {
    try {
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `♻️ <b>Re-warm cohort</b>\n\n` +
          `Reanimated <b>${reanimated}</b> stuck buyers ` +
          `(of ${eligible.length} eligible · cap ${DAILY_REANIMATE_CAP}/day)\n` +
          `They will appear in the next rancher-launch-warmup batch.`,
      );
    } catch (e: any) {
      console.error('[re-warm-cohort] telegram summary failed:', e?.message);
    }
  }

  return {
    status: errors.length ? 'partial' : 'success',
    recordsTouched: reanimated,
    notes: `eligible=${eligible.length} reanimated=${reanimated} cap=${DAILY_REANIMATE_CAP} errs=${errors.length}${errors.length ? ' err1=' + errors[0].slice(0, 80) : ''}`,
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
  return withCronRun('re-warm-cohort', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
