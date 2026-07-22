import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord, TABLES, isInvalidFilterFormulaError } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import { isActiveDealReferral } from '@/lib/capacityCount';
import { readyStuckBuyersFormula, activeDealReferralsFormula } from '@/lib/cronReadFilters';
import { strandedMatchedBuyerIds } from '@/lib/strandedBuyers';

// SCALE (#3): filtered reads with graceful fallback. This cron only processes
// consumers at Buyer Stage=READY and only needs active-deal referrals to build
// the "already recovered" exclusion set. Push both filters to Airtable; on an
// INVALID_FILTER_BY_FORMULA-class error (e.g. a future field rename) fall back
// to the unfiltered scan + a one-time warn so behavior never breaks. The JS
// predicates (stage checks / isActiveDealReferral) remain the exact belt.
async function readReadyConsumers(): Promise<any[]> {
  try {
    return (await getAllRecords(TABLES.CONSUMERS, readyStuckBuyersFormula())) as any[];
  } catch (e: any) {
    if (!isInvalidFilterFormulaError(e)) throw e;
    console.warn('[stuck-buyer-recovery] READY filter rejected; falling back to full Consumers scan:', e?.message);
    return (await getAllRecords(TABLES.CONSUMERS)) as any[];
  }
}
async function readActiveDealReferrals(): Promise<any[]> {
  try {
    return (await getAllRecords(TABLES.REFERRALS, activeDealReferralsFormula())) as any[];
  } catch (e: any) {
    if (!isInvalidFilterFormulaError(e)) throw e;
    console.warn('[stuck-buyer-recovery] active-deal filter rejected; falling back to full Referrals scan:', e?.message);
    return (await getAllRecords(TABLES.REFERRALS)) as any[];
  }
}

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
//   - Active referral exists (any held status: Intro Sent → Slot Locked,
//     or Pending Approval with a linked rancher — see isActiveDealReferral)
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

async function realHandler(_request: Request): Promise<{ status: 'success' | 'maintenance-blocked'; recordsTouched: number; notes: string; skipReasonBreakdown?: Record<string, number> }> {
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }

  const skipReasons: Record<string, number> = {};

  // ── STRANDED-MATCHED RESTORE (routing forensics 2026-07-08) ──────────────
  // A buyer stuck at Buyer Stage='MATCHED' whose only referral(s) went
  // terminal (Closed Lost by a rancher, Dormant) is invisible to every
  // routing rail — all of them read Buyer Stage='READY'. Reset those to READY
  // FIRST so the READY read below (same run) reconsiders them against current
  // supply. Runs before the main pass; failures are per-buyer best-effort.
  let restoredStranded = 0;
  try {
    const [matched, activeRefs] = await Promise.all([
      getAllRecords(TABLES.CONSUMERS, '{Buyer Stage} = "MATCHED"').catch(
        async () => (await getAllRecords(TABLES.CONSUMERS)) as any[],
      ) as Promise<any[]>,
      readActiveDealReferrals(),
    ]);
    const strandedIds = strandedMatchedBuyerIds(matched, activeRefs);
    for (const id of strandedIds.slice(0, 50)) {
      try {
        await updateRecord(TABLES.CONSUMERS, id, { 'Buyer Stage': 'READY' });
        restoredStranded++;
      } catch { /* per-buyer best-effort — next run retries */ }
    }
    if (restoredStranded > 0) {
      skipReasons['stranded-matched-restored'] = restoredStranded;
    }
  } catch { /* restore is a backstop; never block the recovery pass */ }

  {
    const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';
    const now = Date.now();
    const DAY_MS = 86_400_000;

    const [consumers, referrals] = await Promise.all([
      readReadyConsumers(),
      readActiveDealReferrals(),
    ]);

    // Build a set of buyer IDs who already have an active referral.
    // isActiveDealReferral (lib/capacityCount) is the canonical "live deal
    // blocks a new match" predicate: all HELD statuses (Intro Sent → Slot
    // Locked), plus Pending Approval ONLY with a linked rancher — which
    // preserves the 2026-05-09 orphan-Pending-Approval fix (orphans are
    // failed-match residue and stay recoverable).
    //
    // BLOCKER-4 FIX (2026-07-01): the previous local literal omitted
    // 'Slot Locked', so a buyer whose deposit was already LOCKED could be
    // re-routed by this cron into a second referral.
    const buyersWithActiveRef = new Set<string>();
    for (const ref of referrals) {
      if (!isActiveDealReferral(ref)) continue;
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
      // BULLETPROOF FIX (2026-07-08): 'Ready to Buy' is an unreliable proxy —
      // it's stamped by warmup clicks AND a signup branch that's gated on the
      // buyer's state having an operational rancher AT SIGNUP TIME. A READY
      // buyer who signed up before their state had supply never gets the
      // stamp and was structurally unreachable here (the two stuck MO buyers).
      // A quiz-qualified READY buyer (Qualified At set) is routable — that IS
      // the qualification rule (quiz-required, never Intent Score alone).
      if (!readyToBuy && !c['Qualified At']) {
        skipReasons['not-stuck-yet'] = (skipReasons['not-stuck-yet'] || 0) + 1;
        continue;
      }
      // Segment gate (2026-07-22, reactivation audit): a BLANK Segment is
      // ELIGIBLE — plenty of import/signup paths never stamp it, and Qualified
      // At / Ready to Buy above already prove buyer intent (quiz-required
      // rule). Only an explicit non-buyer segment excludes, and the skip is
      // COUNTED so "stuck=0" can never hide real READY buyers behind an
      // unlogged filter.
      if (segment && segment !== 'Beef Buyer') {
        skipReasons['wrong-segment'] = (skipReasons['wrong-segment'] || 0) + 1;
        continue;
      }
      if (status === 'Rejected') continue;
      if (buyersWithActiveRef.has(c.id)) {
        skipReasons['already-recovered'] = (skipReasons['already-recovered'] || 0) + 1;
        continue;
      }

      // Cooldown — BULLETPROOF FIX (2026-07-08): was 24h, which meant
      // batch-approve's 09:01 UTC 'Last Match Attempt At' stamp cooldown-
      // locked the ENTIRE pool out of this cron's 14:30 run every single day
      // (5.5h gap < 24h). 4h keeps same-hour double-runs suppressed while
      // letting the two daily rails each take their shot.
      const RECOVERY_COOLDOWN_MS = 4 * 60 * 60 * 1000;
      const lastAttempt = c['Last Match Attempt At'];
      if (lastAttempt) {
        const ms = new Date(lastAttempt).getTime();
        if (ms > 0 && now - ms < RECOVERY_COOLDOWN_MS) {
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
    // Surface every skip reason (wrong-segment especially) so "stuck=0" is
    // diagnosable from the Cron Runs note alone.
    const skipNote = Object.keys(skipReasons).length
      ? ` skips=${Object.entries(skipReasons).map(([k, v]) => `${k}:${v}`).join(',')}`
      : '';
    return {
      status: 'success',
      recordsTouched: retried.length,
      notes: `stuck=${stuck.length} retried=${retried.length} matched=${matchedCount}${skipNote}`,
      skipReasonBreakdown: skipReasons,
    };
  }
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('stuck-buyer-recovery', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
