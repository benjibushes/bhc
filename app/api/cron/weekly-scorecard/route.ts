// app/api/cron/weekly-scorecard/route.ts
//
// THE MONDAY SCOREBOARD (2026-07-08). The GTM verdict picked the metric
// religion — deposits placed + orders shipped (bookings, not GMV) — but
// nothing forced a weekly look, and without a Monday number the operator
// drifts back into build mode. Every Monday morning this drops the week's
// truth into Telegram:
//
//   deposits placed (count + $) · product orders (count + $) · orders
//   shipped · Connect-active ranchers (the supply valve) · WAITING buyers
//   (the demand queue) — each vs. the prior week where cheap to compute.
//
// Reads are scale-safe: Payments + Rancher Orders filtered to 14 days
// server-side; Ranchers rides the L1/L2 table cache; the WAITING count is a
// single filtered read of Consumers (Buyer Stage only).
//
// No env gate: operator-only Telegram report, same class as
// daily-health-digest. Weekly schedule → EXCLUDED_CRONS_24H (a 24h watchdog
// expectation would false-alarm six days a week by design).

import { NextResponse } from 'next/server';
import { getAllRecords, TABLES } from '@/lib/airtable';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { isRealRancherTouch, needsFirstCall } from '@/lib/untouchedIntros';

export const maxDuration = 120;

interface CronResult {
  status: 'success' | 'partial';
  recordsTouched: number;
  notes: string;
}

const num = (v: any): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
const usd = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

function weekSplit<T>(rows: T[], dateOf: (r: T) => string): { thisWeek: T[]; lastWeek: T[] } {
  const now = Date.now();
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  const thisWeek: T[] = [];
  const lastWeek: T[] = [];
  for (const r of rows) {
    const t = new Date(dateOf(r) || 0).getTime();
    if (!t) continue;
    if (now - t <= WEEK) thisWeek.push(r);
    else if (now - t <= 2 * WEEK) lastWeek.push(r);
  }
  return { thisWeek, lastWeek };
}

const delta = (cur: number, prev: number) =>
  prev === 0 ? (cur > 0 ? ' (new)' : '') : ` (${cur >= prev ? '+' : ''}${cur - prev} vs last wk)`;

async function realHandler(_request: Request): Promise<CronResult> {
  const errors: string[] = [];

  // Deposits placed — Payments succeeded, last 14d (server-side filter).
  let payments: any[] = [];
  try {
    payments = (await getAllRecords(
      TABLES.PAYMENTS,
      `AND({Status} = "succeeded", IS_AFTER({Created At}, DATEADD(NOW(), -14, 'days')))`,
    )) as any[];
  } catch (e: any) { errors.push(`payments: ${e?.message?.slice(0, 50)}`); }
  const dep = weekSplit(payments, (p) => String(p['Created At'] || p['_createdTime'] || ''));
  const depCents = dep.thisWeek.reduce((s, p) => s + num(p['Amount Cents']), 0);

  // Product orders — Rancher Orders, last 14d.
  let orders: any[] = [];
  try {
    orders = (await getAllRecords(
      TABLES.RANCHER_ORDERS,
      `IS_AFTER({Ordered At}, DATEADD(NOW(), -14, 'days'))`,
    )) as any[];
  } catch (e: any) { errors.push(`orders: ${e?.message?.slice(0, 50)}`); }
  const ord = weekSplit(orders, (o) => String(o['Ordered At'] || ''));
  const ordCents = Math.round(ord.thisWeek.reduce((s, o) => s + num(o['Buyer Paid']) * 100, 0));
  const shippedThisWeek = ord.thisWeek.filter((o) => String(o['Status'] || '') === 'Shipped').length;
  const unshippedTotal = orders.filter((o) => String(o['Status'] || '') === 'New').length;

  // Supply valve — Connect-active ranchers (cached table read).
  let activeRanchers = 0;
  let rancherNames = '';
  try {
    const ranchers = (await getAllRecords(TABLES.RANCHERS)) as any[];
    const active = ranchers.filter((r) => String(r['Stripe Connect Status'] || '') === 'active');
    activeRanchers = active.length;
    rancherNames = active.map((r) => String(r['Ranch Name'] || '').trim()).filter(Boolean).slice(0, 8).join(', ');
  } catch (e: any) { errors.push(`ranchers: ${e?.message?.slice(0, 50)}`); }

  // Demand queue — WAITING buyers (filtered, Buyer Stage only).
  let waiting = -1;
  try {
    const rows = (await getAllRecords(TABLES.CONSUMERS, `UPPER({Buyer Stage}) = "WAITING"`, {
      fields: ['Buyer Stage'],
    })) as any[];
    waiting = rows.length;
  } catch (e: any) { errors.push(`consumers: ${e?.message?.slice(0, 50)}`); }

  // Touch accountability (2026-07-15) — per-rancher REAL-touch rate on intros
  // from the last 28 days. Forensics: only 38% of 703 intros ever got a real
  // rancher touch, and "couldn't reach buyer" is the #1 loss reason downstream.
  // Same rule as the dashboard's needs-first-call queue (lib/untouchedIntros):
  // a Last Rancher Activity At stamp on the intro's own UTC day is the
  // auto-stamp artifact and counts as NO touch. Read is scale-safe: 28d
  // server-side filter + 4 fields.
  let touchLines: string[] = [];
  try {
    const intros = (await getAllRecords(
      TABLES.REFERRALS,
      `IS_AFTER({Intro Sent At}, DATEADD(NOW(), -28, 'days'))`,
      { fields: ['Suggested Rancher Name', 'Intro Sent At', 'Last Rancher Activity At', 'Status'] },
    )) as any[];
    const byRancher = new Map<string, { intros: number; touched: number; untouched: number }>();
    for (const r of intros) {
      const name = String(r['Suggested Rancher Name'] || '').trim() || 'Unassigned';
      const row = byRancher.get(name) || { intros: 0, touched: 0, untouched: 0 };
      const introSentAt = String(r['Intro Sent At'] || '');
      const lastActivity = String(r['Last Rancher Activity At'] || '');
      row.intros += 1;
      if (isRealRancherTouch(introSentAt, lastActivity)) row.touched += 1;
      // Untouched = still awaiting a first call NOW (terminal + deposit-rail
      // rows drop out — needsFirstCall carries the status gate).
      if (needsFirstCall({ status: String(r['Status'] || ''), introSentAt, lastRancherActivityAt: lastActivity })) {
        row.untouched += 1;
      }
      byRancher.set(name, row);
    }
    touchLines = [...byRancher.entries()]
      .sort(
        (a, b) =>
          b[1].untouched - a[1].untouched ||
          a[1].touched / Math.max(1, a[1].intros) - b[1].touched / Math.max(1, b[1].intros),
      )
      .slice(0, 10)
      .map(([name, s]) => {
        const pct = s.intros ? Math.round((s.touched / s.intros) * 100) : 0;
        return ` · ${name}: <b>${pct}%</b> touched (${s.touched}/${s.intros})${s.untouched > 0 ? ` · ⚠️ ${s.untouched} awaiting first call` : ''}`;
      });
  } catch (e: any) { errors.push(`touch: ${e?.message?.slice(0, 50)}`); }

  const lines = [
    `📊 <b>MONDAY SCOREBOARD</b> — week of ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
    '',
    `💰 deposits placed: <b>${dep.thisWeek.length}</b> · ${usd(depCents)}${delta(dep.thisWeek.length, dep.lastWeek.length)}`,
    `📦 product orders: <b>${ord.thisWeek.length}</b> · ${usd(ordCents)}${delta(ord.thisWeek.length, ord.lastWeek.length)}`,
    `🚚 shipped this week: <b>${shippedThisWeek}</b>${unshippedTotal > 0 ? ` · ⚠️ ${unshippedTotal} awaiting shipment` : ''}`,
    `🤠 Connect-active ranchers: <b>${activeRanchers}</b>${rancherNames ? ` (${rancherNames})` : ''}`,
    waiting >= 0 ? `🧑‍🌾 buyers WAITING for supply: <b>${waiting.toLocaleString()}</b>` : '',
    ...(touchLines.length
      ? ['', `📞 rancher touch rate — intros last 28d (same-day auto-stamp ≠ touch):`, ...touchLines]
      : []),
    '',
    `the week is won on: deposits placed + orders shipped + ranchers activated.`,
  ].filter(Boolean);

  await sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, lines.join('\n')).catch((e: any) =>
    errors.push(`telegram: ${e?.message?.slice(0, 50)}`),
  );

  return {
    status: errors.length ? 'partial' : 'success',
    recordsTouched: 0,
    notes:
      `deposits=${dep.thisWeek.length}/${usd(depCents)} orders=${ord.thisWeek.length}/${usd(ordCents)} ` +
      `shipped=${shippedThisWeek} active=${activeRanchers} waiting=${waiting}` +
      (errors.length ? ` errs=${errors.length}` : ''),
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('weekly-scorecard', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
