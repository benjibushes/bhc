// app/api/cron/base-capacity/route.ts
//
// THE CAPACITY ALARM (capacity audit 2026-08-19).
//
// Airtable's Team-plan cap is 50,000 records PER BASE, and NOTHING watched it.
// Measured on the day this was written the base sat at 36,451 / 50,000 —
// 72.9%, roughly 39 days of headroom at net inflow — with no cron, no dashboard
// tile and no alert anywhere that would have said a word. The first symptom
// would have been the outage: at the cap Airtable rejects CREATE, and because
// lib/airtable.ts only retries unknown-field and bad-select-option errors, that
// rejection propagates straight to app/api/consumers/route.ts's 500 "Could not
// complete signup." Every signup, referral, deposit and payment write fails at
// the same moment, buyer-visible, while ad spend keeps running.
//
// This cron is the sensor. Once a day it pages every table (one-field
// projection, pageSize 100, ~370 requests for ~36k records) and counts, PACED
// at 2.5 req/s so the census can never trip the ceiling it is watching for. The
// same pass measures rows created in the last 24h, and the total is diffed
// against the previous run (kept in Redis, no Airtable write) to get NET inflow
// — gross inflow overstates growth wherever retention is deleting.
//
// Thresholds and the two-axis (percent AND days-of-runway) rule live in
// lib/baseCapacity.ts. Levels: watch 60% is logged only; warn 70% / <=45 days
// is a daily 'normal' card; critical 85% / <=21 days and emergency 95% ride the
// LOUD rail (Telegram, with SMS+email fallback if Telegram is down).
//
// ON BY DEFAULT — the whole finding was "nothing watches this", so a
// dark-by-default flag would reproduce the bug. Opt OUT with
// BASE_CAPACITY_WATCH_ENABLED=false. It always writes a Cron Runs row, so it
// belongs in EXPECTED_CRONS_24H, not EXCLUDED.
//
// Scheduled `25 4 * * *` (≈9:25pm MT) — a quiet hour, and clear of the 03:10 /
// 09:10 / 15:10 / 21:10 log-retention slots so the two never share the request
// budget.

import { NextResponse } from 'next/server';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import { sendOperatorSignal } from '@/lib/operatorSignal';
import {
  runBaseCensus,
  summarizeCensus,
  netInflowPerDay,
  readCensusBaseline,
  writeCensusBaseline,
} from '@/lib/airtableCensus';
import { capacityAlarm, formatCapacityDetail, resolveRecordCap } from '@/lib/baseCapacity';

export const maxDuration = 300;

interface CronResult {
  status: 'success' | 'partial' | 'error';
  recordsTouched: number;
  notes: string;
}

async function realHandler(_request: Request): Promise<CronResult> {
  const apiKey = process.env.AIRTABLE_API_KEY;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!apiKey || !baseId) {
    return { status: 'error', recordsTouched: 0, notes: 'AIRTABLE_API_KEY / AIRTABLE_BASE_ID missing' };
  }

  const census = await runBaseCensus({ apiKey, baseId });
  const summary = summarizeCensus(census.tables);
  const now = Date.now();

  // NET where we can measure it, GROSS otherwise. Gross can only make the
  // projection SHORTER, i.e. the alarm fires earlier — the safe direction.
  const baseline = await readCensusBaseline();
  const net = netInflowPerDay(baseline, summary.total, now);
  const inflowPerDay = net ?? summary.grossInflowPerDay;
  const inflowSource = net === null ? 'gross-24h' : 'net-vs-previous-census';
  await writeCensusBaseline(summary.total, now);

  const alarm = capacityAlarm({
    total: summary.total,
    inflowPerDay,
    biggestTables: summary.biggest,
  });

  if (alarm.fire) {
    await sendOperatorSignal({
      urgency: alarm.urgency,
      kind: 'system-error',
      summary: alarm.summary,
      detail: formatCapacityDetail(alarm),
      dedupeKey: alarm.dedupeKey,
      dedupeWindowMs: 20 * 60 * 60 * 1000, // once a day per level; an escalation changes the key
    }).catch(() => {});
  } else {
    console.info(`[base-capacity] ${alarm.level}: ${alarm.summary}`);
  }

  // A TRUNCATED census under-counts, and an under-count could silence the
  // alarm — the one failure mode that matters here. Say so out loud, always.
  if (census.truncated) {
    await sendOperatorSignal({
      urgency: 'normal',
      kind: 'system-error',
      summary: 'base-capacity census INCOMPLETE — the total below is a floor, not the truth',
      detail:
        `Counted ${summary.total.toLocaleString('en-US')} of an unknown total in ${census.requests} requests.\n` +
        (census.errors.length ? `errors: ${census.errors.slice(0, 4).join(' | ')}` : 'ran out of time budget'),
      dedupeKey: `base-capacity-truncated:${new Date(now).toISOString().slice(0, 10)}`,
    }).catch(() => {});
  }

  const top = summary.biggest.map((t) => `${t.table} ${t.count}`).join(', ');
  return {
    status: census.truncated ? 'partial' : 'success',
    recordsTouched: 0, // read-only sensor; it must not look like it mutated rows
    notes:
      `${alarm.level} ${summary.total}/${resolveRecordCap()} (${alarm.pct}%) · ` +
      `inflow ${inflowPerDay}/day (${inflowSource}) · ` +
      `${alarm.daysToCap === null ? 'not growing' : `${alarm.daysToCap}d to cap`} · ` +
      `top: ${top} · ${census.requests} reqs${census.truncated ? ' · TRUNCATED' : ''}`.slice(0, 500),
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;

  // ON by default — see header. Explicit opt-out only.
  if (process.env.BASE_CAPACITY_WATCH_ENABLED === 'false') {
    return NextResponse.json({ skipped: 'disabled' });
  }

  return withCronRun('base-capacity', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
