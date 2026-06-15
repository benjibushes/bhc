// app/api/cron/daily-health-digest/route.ts
//
// D1 — Single Telegram message 9am with platform health.
//
// What Ben sees:
//   - 24h cron error count (any non-success runs)
//   - Active rancher count + capacity drift
//   - Pipeline: pending approval, awaiting payment, slot locked, closed today
//   - Funnel: signups, qualified, booked, closed (last 24h)
//   - Email pipeline: sent, suppressed, bounced
//   - Deploy SHA (compared to git HEAD if drift cron exposes it)
//
// Schedule: daily 14:00 UTC (~9am MT). Single message, no spam.

import { NextResponse } from 'next/server';
import { getAllRecords, TABLES } from '@/lib/airtable';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { withCronRun } from '@/lib/cronRun';

export const maxDuration = 60;

interface CronResult {
  status: 'success' | 'partial' | 'error';
  recordsTouched: number;
  notes: string;
}

async function realHandler(_request: Request): Promise<CronResult> {
  const now = Date.now();
  const cutoff24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const cutoffToday = new Date().toISOString().slice(0, 10);

  // Parallel pulls
  const [cronRuns, ranchers, consumers, referrals, emailSends] = await Promise.all([
    getAllRecords('Cron Runs', `IS_AFTER({Started At}, '${cutoff24h}')`).catch(() => [] as any[]),
    getAllRecords(TABLES.RANCHERS, `{Active Status}='Active'`).catch(() => [] as any[]),
    getAllRecords(
      TABLES.CONSUMERS,
      `AND({Status}='Approved', IS_AFTER(CREATED_TIME(), '${cutoff24h}'))`
    ).catch(() => [] as any[]),
    getAllRecords(TABLES.REFERRALS).catch(() => [] as any[]),
    getAllRecords(
      TABLES.EMAIL_SENDS,
      `IS_AFTER({Sent At}, '${cutoff24h}')`
    ).catch(() => [] as any[]),
  ]);

  // Cron health
  const cronErrorRuns = cronRuns.filter((r: any) => {
    const s = String(r['Status'] || '').toLowerCase();
    return s === 'error' || s === 'partial';
  });
  const failedCronNames = Array.from(
    new Set(cronErrorRuns.map((r: any) => String(r['Name'] || 'unknown')))
  );

  // Funnel
  const signups24h = consumers.length;
  const qualified24h = consumers.filter((c: any) => c['Qualified At']).length;
  const referralsAwaiting = referrals.filter((r: any) => String(r['Status'] || '') === 'Awaiting Payment').length;
  const referralsLocked = referrals.filter((r: any) => String(r['Status'] || '') === 'Slot Locked').length;
  const referralsClosedToday = referrals.filter((r: any) => {
    const ca = String(r['Closed At'] || '');
    return String(r['Status'] || '') === 'Closed Won' && ca.startsWith(cutoffToday);
  });
  const closedTodayValueCents = referralsClosedToday.reduce(
    (acc: number, r: any) => acc + Math.round(Number(r['Sale Amount'] || 0) * 100),
    0
  );
  const intro24h = referrals.filter((r: any) => {
    const i = String(r['Intro Sent At'] || '');
    return i > cutoff24h;
  }).length;
  const booked24h = referrals.filter((r: any) => {
    const b = String(r['Sales Call Booked At'] || '');
    return b > cutoff24h;
  }).length;

  // Ranchers
  const livePages = ranchers.filter((r: any) => r['Page Live'] === true).length;
  const tier_v2 = ranchers.filter((r: any) => String(r['Pricing Model'] || '').toLowerCase() === 'tier_v2').length;
  const legacyActive = ranchers.length - tier_v2;
  // #1 silent failure: a tier_v2 rancher whose Stripe Connect onboarding never
  // reached 'active' CANNOT take buyer deposits — leads route to them and die
  // at checkout. Surface the count so stuck Connect onboarding is visible.
  const connectStuck = ranchers.filter(
    (r: any) =>
      String(r['Pricing Model'] || '').toLowerCase() === 'tier_v2' &&
      String(r['Stripe Connect Status'] || '').toLowerCase() !== 'active'
  ).length;
  const capacityTotal = ranchers.reduce(
    (acc: number, r: any) => acc + Number(r['Current Active Referrals'] || 0),
    0
  );

  // Email
  const sent24h = emailSends.filter((e: any) => String(e['Status'] || '') === 'sent').length;
  const suppressed24h = emailSends.filter((e: any) => String(e['Status'] || '') === 'suppressed').length;
  const bounced24h = emailSends.filter((e: any) => String(e['Status'] || '') === 'bounced').length;

  const fmtUsd = (cents: number) =>
    `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

  const lines = [
    '☀️ <b>BHC Daily Health Digest</b>',
    '',
    `<b>Closed today:</b> ${referralsClosedToday.length} deal${referralsClosedToday.length === 1 ? '' : 's'} · ${fmtUsd(closedTodayValueCents)}`,
    `<b>Pipeline:</b> ${referralsAwaiting} awaiting payment · ${referralsLocked} slot locked`,
    '',
    `<b>Funnel (24h):</b>`,
    `  signups ${signups24h} → qualified ${qualified24h} → intro ${intro24h} → booked ${booked24h}`,
    '',
    `<b>Ranchers:</b> ${ranchers.length} active · ${livePages} live pages · ${tier_v2} tier_v2 (${legacyActive} legacy) · ${capacityTotal} buyers in pipeline`,
    connectStuck > 0
      ? `🚨 <b>Connect stuck:</b> ${connectStuck} tier_v2 rancher${connectStuck === 1 ? '' : 's'} can't take deposits (Stripe Connect ≠ active)`
      : `✅ <b>Connect:</b> all tier_v2 ranchers can take deposits`,
    '',
    `<b>Email (24h):</b> ${sent24h} sent · ${suppressed24h} suppressed · ${bounced24h} bounced`,
    '',
    cronErrorRuns.length > 0
      ? `🚨 <b>Cron failures (24h):</b> ${cronErrorRuns.length} runs across ${failedCronNames.length} crons → ${failedCronNames.slice(0, 8).join(', ')}`
      : `✅ <b>Crons healthy</b> — 0 failures in 24h`,
  ];

  await sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, lines.join('\n')).catch((e: any) =>
    console.warn('[daily-health-digest] telegram fire failed:', e?.message)
  );

  return {
    status: 'success',
    recordsTouched: 1,
    notes: `signups=${signups24h} qualified=${qualified24h} closed=${referralsClosedToday.length} cronErrors=${cronErrorRuns.length}`,
  };
}

export async function GET(request: Request) {
  return withCronRun('daily-health-digest', realHandler)(request);
}
