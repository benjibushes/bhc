// app/api/cron/capacity-drift-check/route.ts
//
// CAPACITY DRIFT DETECTION + AUTO-REPAIR
//
// Background: rancher capacity is tracked in TWO places by design.
//   - Upstash Redis counter (`bhc:rancher-capacity:<id>`) is the source of
//     truth for atomic INCR/DECR at match time — race-safe under burst.
//   - Airtable `Current Active Referrals` is a mirror that powers dashboards
//     + cron reads. Eventually-consistent.
//
// Reality across weeks: these CAN drift.
//   1. Redis lost during an Upstash outage → bootstrap rebuilds from Airtable
//      but a concurrent INCR during the outage was never persisted.
//   2. Airtable mirror write fails post-INCR (lib/rancherCapacity.ts logs +
//      swallows) → counter advances but mirror stays behind.
//   3. Manual operator edit in Airtable bumps `Current Active Referrals`
//      without touching Redis (rare but happens during incident response).
//
// The held-slot referrals attached to a rancher (Rancher link = <id> AND a
// non-terminal Status) are the GROUND TRUTH for how many active referrals a
// rancher actually has. It's the count we'd compute from scratch if everything
// else burned down. This cron uses it as the canonical reconciliation source.
//
// NOTE (2026-06-23 fix): the count is computed in memory by matching the
// {Rancher} link array against the rancher's record id. The previous
// `FIND("<recId>", ARRAYJOIN({Rancher}))` formula was broken — ARRAYJOIN of a
// link field emits the linked records' NAMES, not their rec… ids, so it matched
// nothing and the cron force-wrote 0 to every Active rancher. See
// buildHeldCountsByRancher below.
//
// Daily flow:
//   1. Pull all Active ranchers + all referrals (one read each).
//   2. For each rancher: held-slot count = referrals whose {Rancher} link
//      contains this rancher id AND whose Status is non-terminal.
//   3. Read Redis counter (raw, no bootstrap) + Airtable mirror.
//   4. If any of the three disagree → force-write Redis + Airtable mirror
//      to the held-slot count. Fire one Telegram per drift.
//
// Conservative scope: ONLY repairs ranchers with Active Status='Active'. A
// paused/inactive rancher isn't receiving leads so drift is cosmetic and
// will self-heal on reactivation via the lazy-bootstrap paths.

import { NextResponse } from 'next/server';
import { getAllRecords, TABLES } from '@/lib/airtable';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { peekRedisCapacity, setCapacityCounter } from '@/lib/rancherCapacity';
import { HELD_REFERRAL_STATUSES } from '@/lib/capacityCount';
import { withCronRun } from '@/lib/cronRun';

export const maxDuration = 180;

interface DriftResult {
  status: 'success' | 'partial' | 'error';
  recordsTouched: number;
  notes: string;
}

// Held-slot statuses come from the canonical capacityCount module so this cron,
// batch-approve's self-heal, the admin-health drift readout, and the Redis
// bootstrap ALL use the SAME set (they used to differ and overwrite each other).
const HELD_STATUSES = HELD_REFERRAL_STATUSES;

// Count held referrals per rancher id, in memory.
//
// WHY NOT a per-rancher filterByFormula: the previous implementation used
// `FIND("<recId>", ARRAYJOIN({Rancher}))`. ARRAYJOIN of a linked-record field
// emits the linked records' PRIMARY-FIELD display values (Ranch Names), NOT
// their rec… ids — so FIND(recId, "...") never matched and queryCount was 0
// for EVERY rancher. The cron then force-wrote Current Active Referrals=0 to
// every Active rancher (and 0'd Redis), stomping the correct counts written by
// matching/suggest + batch-approve and reporting "fixed=N" each run. The SDK
// returns the {Rancher} link as an array of rec… id strings, so an in-memory
// `.includes(rancherId)` is the correct id match (same approach batch-approve
// uses). This also drops N per-rancher Airtable calls.
function buildHeldCountsByRancher(referrals: any[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const ref of referrals) {
    if (!HELD_STATUSES.has(ref['Status'])) continue;
    const link = ref['Rancher'];
    if (!Array.isArray(link)) continue;
    for (const rid of link) {
      if (typeof rid === 'string') counts[rid] = (counts[rid] || 0) + 1;
    }
  }
  return counts;
}

async function realHandler(_request: Request): Promise<DriftResult> {
  const ranchers = (await getAllRecords(TABLES.RANCHERS)) as any[];
  const active = ranchers.filter(r => (r['Active Status'] || '') === 'Active');

  // Single ground-truth read of all referrals, bucketed by rancher id in
  // memory. Pulled ONCE up front (not per-rancher) so the held-slot count is
  // computed by id match, not by the broken ARRAYJOIN-of-names formula.
  let heldCounts: Record<string, number>;
  try {
    const allReferrals = (await getAllRecords(TABLES.REFERRALS)) as any[];
    heldCounts = buildHeldCountsByRancher(allReferrals);
  } catch (e: any) {
    console.error('[capacity-drift-check] Referrals read failed:', e?.message);
    return {
      status: 'error',
      recordsTouched: 0,
      notes: `referrals read failed: ${e?.message || 'unknown'}`,
    };
  }

  let driftFixed = 0;
  let alreadyConsistent = 0;
  const failedRepairs: string[] = [];

  for (const rancher of active) {
    const rancherId = rancher.id;
    const name = rancher['Operator Name'] || rancher['Ranch Name'] || rancherId;
    const airtableCount = Number(rancher['Current Active Referrals'] || 0);

    // Ground-truth count: every held-slot referral linked to this rancher,
    // matched by record id against the {Rancher} link array (see
    // buildHeldCountsByRancher for why the prior ARRAYJOIN formula was broken).
    const queryCount = heldCounts[rancherId] || 0;

    const redisCount = await peekRedisCapacity(rancherId);
    const redisDisplay = redisCount === null ? 'null' : String(redisCount);

    const driftDetected =
      (redisCount !== null && redisCount !== queryCount) ||
      airtableCount !== queryCount;
    if (!driftDetected) {
      alreadyConsistent++;
      continue;
    }

    // Auto-repair: force both sources to match the query count.
    const { redisOk, airtableOk } = await setCapacityCounter(rancherId, queryCount);
    if (redisOk && airtableOk) {
      driftFixed++;
      // One Telegram per drift so the operator sees the diff. Wrapped so a
      // Telegram outage can't break the audit loop — drift is fixed either
      // way; the alert is observability not control.
      try {
        if (TELEGRAM_ADMIN_CHAT_ID) {
          await sendTelegramMessage(
            TELEGRAM_ADMIN_CHAT_ID,
            `🔧 <b>CAPACITY DRIFT FIXED</b> — ${name}\n` +
              `Redis=${redisDisplay} Airtable=${airtableCount} Query=${queryCount} — set to ${queryCount}`,
          );
        }
      } catch (e: any) {
        console.error('[capacity-drift-check] Telegram alert failed:', e?.message);
      }
    } else {
      failedRepairs.push(
        `${name}: repair partial (redis=${redisOk} airtable=${airtableOk})`,
      );
    }
  }

  const status: DriftResult['status'] =
    failedRepairs.length > 0 ? 'partial' : 'success';
  const notes =
    `active=${active.length} fixed=${driftFixed} ok=${alreadyConsistent} ` +
    `failures=${failedRepairs.length}` +
    (failedRepairs.length > 0 ? ` — ${failedRepairs.slice(0, 3).join('; ')}` : '');

  return {
    status,
    recordsTouched: driftFixed,
    notes,
  };
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
  return withCronRun('capacity-drift-check', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
