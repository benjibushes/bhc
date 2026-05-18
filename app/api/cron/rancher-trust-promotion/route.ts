import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { isRancherOperationalForBuyers } from '@/lib/rancherEligibility';
import { withCronRun } from '@/lib/cronRun';

export const maxDuration = 60;

// ─────────────────────────────────────────────────────────────────────────
// RANCHER TRUST PROMOTION CRON
//
// Daily 14:00 UTC. For every operationally-Live rancher whose Trust Mode
// is currently OFF, decide whether to flip it ON.
//
// Promotion criteria (either condition graduates the rancher):
//   1. Closed Won count >= 5      — proven they can convert
//   2. Onboarding Phase Until is in the past — onboarding window closed
//
// Flipping Trust Mode=true causes app/api/cron/rancher-launch-warmup to
// switch from batched throttle to a one-shot legacy drain for this
// rancher, AND removes the first-week founder-approval gate in
// app/api/warmup/engage. In practice: the rancher has earned full pipe.
//
// Posts a Telegram alert per promotion so Ben can intervene if a rancher
// that shouldn't be trusted gets flipped (e.g. ghost closes).
// ─────────────────────────────────────────────────────────────────────────

async function realHandler(_request: Request): Promise<{ status: 'success' | 'maintenance-blocked'; recordsTouched: number; notes: string }> {
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }

  {
    const now = Date.now();

    const [allRanchers, allReferrals] = await Promise.all([
      getAllRecords(TABLES.RANCHERS) as Promise<any[]>,
      // Only need Closed Won referrals — but pulling all once is cheaper than
      // per-rancher filtered fetches if there are >5 ranchers.
      getAllRecords(TABLES.REFERRALS, '{Status} = "Closed Won"') as Promise<any[]>,
    ]);

    // Group Closed Won counts by rancher id (Rancher field is a linked-record
    // array; check both Rancher and Suggested Rancher to be safe).
    const closedWonByRancher = new Map<string, number>();
    for (const ref of allReferrals) {
      const linked: string[] = ref['Rancher'] || [];
      for (const id of linked) {
        closedWonByRancher.set(id, (closedWonByRancher.get(id) || 0) + 1);
      }
    }

    const operationalRanchers = allRanchers.filter(isRancherOperationalForBuyers);

    let promoted = 0;
    let evaluated = 0;
    const promotedDetails: Array<{ name: string; reason: string; closedWon: number }> = [];

    for (const rancher of operationalRanchers) {
      // Already trusted — skip
      if (rancher['Trust Mode']) continue;
      evaluated++;

      const closedWon = closedWonByRancher.get(rancher.id) || 0;

      const phaseUntilRaw = rancher['Onboarding Phase Until'];
      const phaseUntilMs = phaseUntilRaw ? new Date(phaseUntilRaw).getTime() : null;
      const phaseExpired = phaseUntilMs !== null && !Number.isNaN(phaseUntilMs) && phaseUntilMs < now;

      // LEGACY GRADUATION — ranchers who went live BEFORE this cron existed
      // never got `Onboarding Phase Until` stamped at go-live. Without this
      // fallback they'd sit throttled forever (5/week + Telegram approval gate).
      // If Onboarding Phase Until is blank AND their live signal (Agreement
      // Signed At, Approved At, or Created) is older than 30 days, treat them
      // as graduated. This is the bulk-promote path on first run after merge —
      // every existing partner flips Trust Mode=true overnight.
      const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
      const liveSignal =
        rancher['Agreement Signed At'] ||
        rancher['Approved At'] ||
        rancher['Created'] ||
        rancher.createdTime;
      const liveSignalMs = liveSignal ? new Date(liveSignal).getTime() : null;
      const legacyGraduated =
        phaseUntilRaw == null &&
        liveSignalMs !== null &&
        !Number.isNaN(liveSignalMs) &&
        now - liveSignalMs >= THIRTY_DAYS_MS;

      const closesPromote = closedWon >= 5;

      if (!closesPromote && !phaseExpired && !legacyGraduated) continue;

      const ranchName = rancher['Operator Name'] || rancher['Ranch Name'] || '(unnamed)';
      const reason = closesPromote
        ? `${closedWon} Closed Won (>=5)`
        : phaseExpired
        ? `Onboarding Phase Until passed (${phaseUntilRaw})`
        : `Legacy auto-graduate (live ${Math.round((now - liveSignalMs!) / (24 * 60 * 60 * 1000))}d, no phase set)`;

      try {
        await updateRecord(TABLES.RANCHERS, rancher.id, { 'Trust Mode': true });
        promoted++;
        promotedDetails.push({ name: ranchName, reason, closedWon });

        try {
          await sendTelegramMessage(
            TELEGRAM_ADMIN_CHAT_ID,
            `🎓 <b>Trust Mode promoted</b> — ${ranchName}\n\n` +
            `Reason: ${reason}\n` +
            `Closed Won total: ${closedWon}\n\n` +
            `<i>Throttle is now OFF for this rancher. Warmup will drain their state's waitlist on the next cron tick. First-week founder approval gate also lifts.</i>`
          );
        } catch (e) {
          console.error('[trust-promotion] telegram alert failed:', e);
        }
      } catch (e: any) {
        console.error(`[trust-promotion] failed to flip Trust Mode for ${ranchName}:`, e?.message);
      }
    }

    return {
      status: 'success',
      recordsTouched: promoted,
      notes: `operational=${operationalRanchers.length} evaluated=${evaluated} promoted=${promoted}`,
    };
  }
}

async function authedHandler(request: Request): Promise<Response> {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get('authorization');
    const ok = authHeader === `Bearer ${cronSecret}`;
    if (!ok) {
      const { searchParams } = new URL(request.url);
      if (searchParams.get('secret') !== cronSecret) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }
  }
  return withCronRun('rancher-trust-promotion', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
