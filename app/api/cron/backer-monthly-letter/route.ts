import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendBackerMonthlyLetter } from '@/lib/email';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { CRON_SECRET } from '@/lib/secrets';
import { withCronRun } from '@/lib/cronRun';

// Backer monthly letter cron — fulfills the /founders explicit promise
// of "monthly founder letter" to every backer (Founder Tier set).
//
// Audit P0 I-4: prior to this, sendFoundingHerdWelcome (D0) was the only
// email backers ever received. Going silent post-D0 violated trust on the
// capital-raise page and risked future expense-ledger commitments.
//
// Schedule: 1st of each month at 14:00 UTC. The cron runner uses
// `Backer Letter Sent At` as a per-month idempotency stamp so re-runs in
// the same calendar month are no-ops.
//
// Frequency cap: monthly cadence sits well under typical 3/week sender
// limits; emailFrequencyGuard inside guardedSend still gets the final say.

export const maxDuration = 60;

const PER_RUN_CAP = 200; // safety ceiling — we have ~100 founders today

async function realHandler(
  _request: Request,
): Promise<{ status: 'success' | 'partial' | 'maintenance-blocked'; recordsTouched: number; notes: string }> {
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }

  // Pull all consumers + referrals (live stats source) in parallel.
  const [consumers, ranchers, referrals] = await Promise.all([
    getAllRecords(TABLES.CONSUMERS) as Promise<any[]>,
    getAllRecords(TABLES.RANCHERS) as Promise<any[]>,
    getAllRecords(TABLES.REFERRALS) as Promise<any[]>,
  ]);

  const now = new Date();
  const yyyymm = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  // Live stats — keep cheap (in-memory filters from already-fetched arrays).
  const rancherCount = ranchers.filter((r: any) => r['Active Status'] === 'Active').length;
  const buyerCount = consumers.filter((c: any) => (c['Status'] || '').toLowerCase() === 'approved').length;
  const stateCount = new Set(
    ranchers
      .filter((r: any) => r['Active Status'] === 'Active' && r['State'])
      .map((r: any) => String(r['State']).toUpperCase()),
  ).size;
  const monthClosedWon = referrals.filter((r: any) => {
    if (r['Status'] !== 'Closed Won') return false;
    const closed = new Date(r['Closed At'] || 0);
    return closed >= monthStart;
  }).length;
  const monthNewRanchers = ranchers.filter((r: any) => {
    const launched = new Date(r['Launched At'] || r['Created'] || 0);
    return launched >= monthStart;
  }).length;
  const foundingHundredClaimed = consumers.filter(
    (c: any) => c['Founder Tier'] === 'Founding 100',
  ).length;

  const stats = {
    rancherCount,
    buyerCount,
    stateCount,
    monthClosedWon,
    monthNewRanchers,
    foundingHundredClaimed,
  };

  // Pull eligible backers — Founder Tier set, not suppressed, not already
  // sent this calendar month.
  const eligible = consumers.filter((c: any) => {
    if (!c['Founder Tier']) return false;
    if (c['Unsubscribed'] || c['Bounced'] || c['Complained']) return false;
    const lastSent = c['Backer Letter Sent At'];
    if (lastSent) {
      const sentMonth = String(lastSent).slice(0, 7); // YYYY-MM
      if (sentMonth === yyyymm) return false;
    }
    if (!c['Email']) return false;
    return true;
  });

  const toSend = eligible.slice(0, PER_RUN_CAP);
  const errors: string[] = [];
  let sent = 0;

  for (const c of toSend) {
    const email = String(c['Email'] || '').trim().toLowerCase();
    if (!email) continue;
    const fullName = String(c['Full Name'] || '').trim();
    const firstName = fullName.split(/\s+/)[0] || 'there';
    const founderNumberRaw = c['Founder Number'];
    const founderNumber =
      typeof founderNumberRaw === 'number' && founderNumberRaw > 0 ? founderNumberRaw : undefined;
    try {
      const result = await sendBackerMonthlyLetter({
        firstName,
        email,
        tier: c['Founder Tier'],
        founderNumber,
        stats,
      });
      if (result.success) {
        await updateRecord(TABLES.CONSUMERS, c.id, {
          'Backer Letter Sent At': new Date().toISOString(),
        });
        sent++;
      } else {
        errors.push(`${c.id}: send failed`);
      }
    } catch (e: any) {
      errors.push(`${c.id}: ${e?.message || String(e)}`);
    }
  }

  if (sent > 0 && TELEGRAM_ADMIN_CHAT_ID) {
    try {
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `📬 <b>Backer monthly letter</b>\n\n` +
          `sent <b>${sent}</b> of <b>${eligible.length}</b> eligible (${yyyymm})\n` +
          `stats: ${rancherCount} ranchers · ${buyerCount} buyers · ${monthClosedWon} deals this month`,
      );
    } catch (e: any) {
      console.error('[backer-monthly-letter] telegram summary failed:', e?.message);
    }
  }

  return {
    status: errors.length ? 'partial' : 'success',
    recordsTouched: sent,
    notes: `eligible=${eligible.length} sent=${sent} errs=${errors.length}${errors.length ? ' err1=' + errors[0].slice(0, 80) : ''}`,
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
  return withCronRun('backer-monthly-letter', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
