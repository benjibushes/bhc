import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { CRON_SECRET } from '@/lib/secrets';
import { withCronRun } from '@/lib/cronRun';

// Stuck-buyer recovery — runs daily and retries matching for buyers who
// engaged (clicked YES on warmup) but never got matched to a rancher.
//
// Scenarios this catches:
//   1. Buyer clicked YES when all in-state ranchers were at capacity →
//      Buyer Stage=READY, Ready to Buy=true, no active referral. Capacity
//      may have freed up since.
//   2. Buyer's state had zero verified ranchers when they engaged → READY
//      stage. New rancher in their state may have gone live since.
//   3. matching/suggest threw an error mid-flight (Airtable rate limit,
//      network blip) → buyer never got a referral row.
//   4. First-week approval gate held a referral, Ben tapped Skip, no
//      next-best rancher found → buyer reverted to READY waiting for
//      capacity.
//
// Stop conditions:
//   - Buyer Stage = MATCHED (already has a rancher)
//   - Buyer Stage = CLOSED (already bought)
//   - Active referral exists (Intro Sent / Rancher Contacted / Negotiation)
//   - Status = Rejected / Pending review for too long
//   - Last matching attempt within 24h (don't hammer)
//
// What it does:
//   - Filters buyers where Buyer Stage = READY AND Ready to Buy = true
//   - Skips ones who already have an active referral row
//   - Calls /api/matching/suggest with warmupEngaged=true (hot-lead bypass)
//   - If match found → matching/suggest flips stage to MATCHED + fires intros
//   - If still no match → leaves buyer at READY (we'll retry tomorrow)
//   - Telegram digest summarizes what was retried + outcomes

export const maxDuration = 60;

// LOCK-aware (2026-06-06): every status that means a rancher is engaged or
// the buyer is in flight. Re-routing a buyer with one of these blocks would
// overlap leads + frustrate both the working rancher and the buyer. Stays
// in sync with lib/referralLock.ts LOCKED_STATUSES (plus the non-locked
// Pending Approval / Intro Sent which are also "in motion").
const ACTIVE_REFERRAL_STATUSES = [
  'Pending Approval',
  'Intro Sent',
  'Rancher Contacted',
  'Negotiation',
  'Awaiting Payment',
];

async function realHandler(_request: Request): Promise<{ status: 'success' | 'maintenance-blocked'; recordsTouched: number; notes: string; skipReasonBreakdown?: Record<string, number> }> {
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }

  const skipReasons: Record<string, number> = {};

  {
    const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
    const now = Date.now();
    const DAY_MS = 86_400_000;

    const [consumers, referrals] = await Promise.all([
      getAllRecords(TABLES.CONSUMERS) as Promise<any[]>,
      getAllRecords(TABLES.REFERRALS) as Promise<any[]>,
    ]);

    // Build a set of buyer IDs who already have an active referral.
    //
    // BUG-FIX 2026-05-09: previously counted "Pending Approval" with NO
    // linked rancher as active. Those are orphan records from a failed
    // matching attempt (capacity full, all candidates excluded). Treating
    // them as active blocked stuck-buyer-recovery from retrying. Fix:
    // Pending Approval only counts as active if a rancher is linked.
    const buyersWithActiveRef = new Set<string>();
    for (const ref of referrals) {
      const status = (ref['Status'] || '').toString();
      if (!ACTIVE_REFERRAL_STATUSES.includes(status)) continue;
      if (status === 'Pending Approval') {
        const hasRancher =
          (Array.isArray(ref['Rancher']) && ref['Rancher'].length > 0) ||
          (Array.isArray(ref['Suggested Rancher']) && ref['Suggested Rancher'].length > 0);
        if (!hasRancher) continue; // orphan, recoverable
      }
      const buyerLinks: string[] = ref['Buyer'] || [];
      for (const id of buyerLinks) buyersWithActiveRef.add(id);
    }

    const stuck: any[] = [];
    for (const c of consumers) {
      const stage = (c['Buyer Stage'] || '').toString();
      const readyToBuy = c['Ready to Buy'] === true;
      const segment = (c['Segment'] || '').toString();
      const status = (c['Status'] || '').toString();

      // Eligible: READY stage, opted in via warmup, beef segment, approved.
      if (stage !== 'READY') {
        skipReasons['not-stuck-yet'] = (skipReasons['not-stuck-yet'] || 0) + 1;
        continue;
      }
      if (!readyToBuy) {
        skipReasons['not-stuck-yet'] = (skipReasons['not-stuck-yet'] || 0) + 1;
        continue;
      }
      if (segment !== 'Beef Buyer') continue;
      if (status === 'Rejected') continue;
      if (buyersWithActiveRef.has(c.id)) {
        skipReasons['already-recovered'] = (skipReasons['already-recovered'] || 0) + 1;
        continue;
      }

      // Cooldown: don't retry within 24h of last attempt.
      const lastAttempt = c['Last Match Attempt At'];
      if (lastAttempt) {
        const ms = new Date(lastAttempt).getTime();
        if (ms > 0 && now - ms < DAY_MS) {
          skipReasons['paused'] = (skipReasons['paused'] || 0) + 1;
          continue;
        }
      }

      stuck.push(c);
    }

    const retried: Array<{ id: string; name: string; state: string; matched: boolean }> = [];

    // Cap per-run to avoid blasting Resend / Airtable. 50 retries is plenty —
    // if there are more than 50 stuck buyers, we'll catch the rest tomorrow.
    const RETRY_CAP = 50;
    for (const c of stuck.slice(0, RETRY_CAP)) {
      const buyerState = (c['State'] || '').toString();
      if (!c['Email'] || !buyerState) {
        // Mark attempt anyway so we don't keep filtering them in.
        try {
          await updateRecord(TABLES.CONSUMERS, c.id, {
            'Last Match Attempt At': new Date().toISOString(),
          });
        } catch {}
        continue;
      }

      // PERFECT-D (2026-06-05): GUARD-2 412s matching/suggest if Qualified At
      // is blank. Pre-quiz buyers stuck in WAITING/READY would silently 412
      // here every cron run. Gate at this layer: if not yet qualified, skip
      // the routing call + log so daily digest surfaces it. The LEAK-3
      // backfill flow + new-lead quiz redirect handles get-to-quiz; this cron
      // only re-routes ALREADY-qualified stranded buyers.
      if (!c['Qualified At']) {
        skipReasons['needs-quiz'] = (skipReasons['needs-quiz'] || 0) + 1;
        // Stamp attempt so cooldown holds.
        try {
          await updateRecord(TABLES.CONSUMERS, c.id, {
            'Last Match Attempt At': new Date().toISOString(),
          });
        } catch {}
        continue;
      }

      let matched = false;
      try {
        const matchRes = await fetch(`${SITE_URL}/api/matching/suggest`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(process.env.INTERNAL_API_SECRET ? { 'x-internal-secret': process.env.INTERNAL_API_SECRET } : {}),
          },
          body: JSON.stringify({
            buyerState,
            buyerId: c.id,
            buyerName: c['Full Name'] || '',
            buyerEmail: c['Email'],
            buyerPhone: c['Phone'] || '',
            orderType: c['Order Type'] || '',
            budgetRange: c['Budget'] || '',
            intentScore: c['Intent Score'] || 0,
            intentClassification: c['Intent Classification'] || '',
            notes: c['Notes'] || '',
            warmupEngaged: true, // hot-lead bypass — they already said YES
          }),
        });
        if (matchRes.ok) {
          const j = await matchRes.json();
          if (j.matchFound || j.alreadyActive) matched = true;
        }
      } catch (e: any) {
        console.error(`[stuck-buyer-recovery] retry failed for ${c.id}:`, e?.message);
      }

      // Always stamp the attempt so cooldown holds.
      try {
        await updateRecord(TABLES.CONSUMERS, c.id, {
          'Last Match Attempt At': new Date().toISOString(),
          // matching/suggest flips Buyer Stage on success, but if we had a
          // race where the flip didn't land, force it here as belt-and-suspenders.
          ...(matched ? { 'Buyer Stage': 'MATCHED', 'Buyer Stage Updated At': new Date().toISOString() } : {}),
        });
      } catch (e: any) {
        console.error(`[stuck-buyer-recovery] stamp failed for ${c.id}:`, e?.message);
      }

      retried.push({
        id: c.id,
        name: (c['Full Name'] || c['Email'] || '?').toString(),
        state: buyerState,
        matched,
      });
    }

    // Telegram summary if anything happened.
    if (retried.length && TELEGRAM_ADMIN_CHAT_ID) {
      try {
        const matchedCount = retried.filter((r) => r.matched).length;
        const stillStuck = retried.length - matchedCount;
        const lines: string[] = [
          `🔄 <b>Stuck-buyer recovery</b>`,
          `Retried ${retried.length} READY buyers.`,
          `✅ Matched: ${matchedCount}`,
          `⏳ Still no rancher: ${stillStuck}`,
        ];
        if (stillStuck > 0) {
          const stillStuckBuyers = retried.filter((r) => !r.matched).slice(0, 10);
          lines.push('');
          lines.push('<b>Still waiting on capacity:</b>');
          for (const r of stillStuckBuyers) {
            lines.push(`  · ${r.name} (${r.state})`);
          }
          if (stillStuck > 10) lines.push(`  · ...and ${stillStuck - 10} more`);
        }
        await sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, lines.join('\n'));
      } catch (e: any) {
        console.error('[stuck-buyer-recovery] telegram summary failed:', e?.message);
      }
    }

    const matchedCount = retried.filter((r) => r.matched).length;
    return {
      status: 'success',
      recordsTouched: retried.length,
      notes: `stuck=${stuck.length} retried=${retried.length} matched=${matchedCount}`,
    };
  }
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
  return withCronRun('stuck-buyer-recovery', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
