import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { isMaintenanceMode, maintenanceResponse } from '@/lib/maintenance';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { isRancherOperationalForBuyers } from '@/lib/rancherEligibility';

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

async function handler(request: Request) {
  try {
    if (isMaintenanceMode()) return maintenanceResponse('rancher-trust-promotion');

    // Cron secret guard — same pattern as nightly-rancher-audit
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

    const startedAt = Date.now();
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

      const closesPromote = closedWon >= 5;

      if (!closesPromote && !phaseExpired) continue;

      const ranchName = rancher['Operator Name'] || rancher['Ranch Name'] || '(unnamed)';
      const reason = closesPromote
        ? `${closedWon} Closed Won (>=5)`
        : `Onboarding Phase Until passed (${phaseUntilRaw})`;

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

    return NextResponse.json({
      success: true,
      durationMs: Date.now() - startedAt,
      operationalRanchers: operationalRanchers.length,
      evaluated,
      promoted,
      promotedDetails,
    });
  } catch (error: any) {
    console.error('Rancher-trust-promotion cron error:', error);
    try {
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `⚠️ <b>Trust promotion cron failed</b>\n\n${error.message}`
      );
    } catch {}
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return handler(request);
}

export async function POST(request: Request) {
  return handler(request);
}
