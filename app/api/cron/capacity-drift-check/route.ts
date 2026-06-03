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
// The query against the Referrals table — Rancher=<id> AND Status='Intro Sent'
// — is the GROUND TRUTH for how many active referrals a rancher actually has.
// It's the count we'd compute from scratch if everything else burned down.
// This cron uses it as the canonical reconciliation source.
//
// Daily flow:
//   1. Pull all Active ranchers.
//   2. For each: count actual Intro Sent referrals via Airtable query.
//   3. Read Redis counter (raw, no bootstrap) + Airtable mirror.
//   4. If any of the three disagree → force-write Redis + Airtable mirror
//      to the query count. Fire one Telegram per drift.
//
// Conservative scope: ONLY repairs ranchers with Active Status='Active'. A
// paused/inactive rancher isn't receiving leads so drift is cosmetic and
// will self-heal on reactivation via the lazy-bootstrap paths.

import { NextResponse } from 'next/server';
import { getAllRecords, escapeAirtableValue, TABLES } from '@/lib/airtable';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { peekRedisCapacity, setCapacityCounter } from '@/lib/rancherCapacity';
import { withCronRun } from '@/lib/cronRun';

export const maxDuration = 180;

interface DriftResult {
  status: 'success' | 'partial' | 'error';
  recordsTouched: number;
  notes: string;
}

async function realHandler(_request: Request): Promise<DriftResult> {
  const ranchers = (await getAllRecords(TABLES.RANCHERS)) as any[];
  const active = ranchers.filter(r => (r['Active Status'] || '') === 'Active');

  let driftFixed = 0;
  let alreadyConsistent = 0;
  const failedRepairs: string[] = [];

  for (const rancher of active) {
    const rancherId = rancher.id;
    const name = rancher['Operator Name'] || rancher['Ranch Name'] || rancherId;
    const airtableCount = Number(rancher['Current Active Referrals'] || 0);

    // Ground-truth count: every NON-TERMINAL referral attached to this rancher.
    // A slot is held from the Intro Sent INCR until the Closed Won/Lost DECR.
    // Statuses BETWEEN those bookends (Rancher Contacted, Negotiation,
    // Awaiting Payment) hold the slot too — there's no INCR/DECR at those
    // transitions. Counting only 'Intro Sent' was wrong (2026-06-02 audit):
    // when a rancher progressed buyers PAST Intro Sent (real sales work),
    // the cron read queryCount=N-1 and "fixed" airtableCount=N down to N-1
    // → silently freed a held slot → matching/suggest then over-allocated
    // that rancher. The 15-of-16 fix-every-run pattern was the drift cron
    // destroying live capacity holds, not catching real drift.
    //
    // Pending Approval is intentionally excluded — those are pre-Intro-Sent
    // and haven't fired the INCR. Closed Won/Lost are terminal post-DECR.
    let queryCount = 0;
    try {
      const escapedId = escapeAirtableValue(rancherId);
      const formula = `AND(FIND("${escapedId}", ARRAYJOIN({Rancher})) > 0, OR({Status}="Intro Sent", {Status}="Rancher Contacted", {Status}="Negotiation", {Status}="Awaiting Payment"))`;
      const refs = (await getAllRecords(TABLES.REFERRALS, formula)) as any[];
      queryCount = refs.length;
    } catch (e: any) {
      console.error(`[capacity-drift-check] Referrals query failed for ${name}:`, e?.message);
      failedRepairs.push(`${name}: query failed (${e?.message || 'unknown'})`);
      continue;
    }

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
