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
import { getLatestCronRuns, missingExpectedCrons } from '@/lib/cronIntrospection';
import { sendOperatorSignal } from '@/lib/operatorSignal';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import { runPlatformProbes } from '@/lib/platformProbes';

export const maxDuration = 60;

// Dead-man's-switch window (2026-07-02). 25h, not 24h: daily crons scheduled
// at a fixed slot are ~24h ± Vercel-jitter old at digest time (the digest's
// own yesterday-row is the worst case — it starts at the same minute this
// query runs), so a hard 24h cutoff coin-flips a false alarm every day. The
// 1h grace only delays detection of a genuinely dead daily cron by 1h; a
// missed slot still surfaces (~48h-old latest row is far outside 25h).
const WATCHDOG_WINDOW_MS = 25 * 60 * 60 * 1000;

interface CronResult {
  status: 'success' | 'partial' | 'error';
  recordsTouched: number;
  notes: string;
}

async function realHandler(_request: Request): Promise<CronResult> {
  const now = Date.now();
  const cutoff24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const cutoffToday = new Date().toISOString().slice(0, 10);

  // Parallel pulls. This cron's JOB is to report platform health — so if its
  // OWN reads fail it must SAY so, not render a green "all healthy" with zeros
  // (the old `.catch(() => [])` + always-`success` made a total Airtable outage
  // look like "0 signups, ✅ crons healthy"). Track each failure + downgrade.
  const readErrors: string[] = [];
  const safeRead = async (label: string, p: Promise<any[]>): Promise<any[]> => {
    try {
      return await p;
    } catch (e: any) {
      readErrors.push(`${label}: ${e?.message || 'failed'}`);
      return [];
    }
  };
  const [cronRuns, ranchers, consumers, referrals, emailSends] = await Promise.all([
    safeRead('cronRuns', getAllRecords('Cron Runs', `IS_AFTER({Started At}, '${cutoff24h}')`) as Promise<any[]>),
    safeRead('ranchers', getAllRecords(TABLES.RANCHERS, `{Active Status}='Active'`) as Promise<any[]>),
    safeRead('consumers', getAllRecords(
      TABLES.CONSUMERS,
      `AND({Status}='Approved', IS_AFTER(CREATED_TIME(), '${cutoff24h}'))`
    ) as Promise<any[]>),
    safeRead('referrals', getAllRecords(TABLES.REFERRALS) as Promise<any[]>),
    safeRead('emailSends', getAllRecords(
      TABLES.EMAIL_SENDS,
      `IS_AFTER({Sent At}, '${cutoff24h}')`
    ) as Promise<any[]>),
  ]);

  // Cron health
  const cronErrorRuns = cronRuns.filter((r: any) => {
    const s = String(r['Status'] || '').toLowerCase();
    return s === 'error' || s === 'partial';
  });
  const failedCronNames = Array.from(
    new Set(cronErrorRuns.map((r: any) => String(r['Name'] || 'unknown')))
  );

  // ── Dead-man's switch (2026-07-02) ──
  // Everything above only inspects Cron Runs rows that EXIST — a cron that
  // writes NO row (Vercel silently dropping a schedule; in-repo precedent:
  // commission-invoices skipped for 60+ days) was invisible. The missing-set
  // logic already existed in lib/cronIntrospection but its sole consumer was
  // the pull-only Telegram /cronstatus command. Push it here daily.
  // null = the watchdog read itself failed (Airtable outage) — in that case
  // we must NOT scream "every cron is missing"; the readErrors rail below
  // already downgrades the run and flags the blind spot.
  let missingCrons: string[] | null = null;
  try {
    const latestRuns = await getLatestCronRuns(WATCHDOG_WINDOW_MS);
    missingCrons = missingExpectedCrons(latestRuns, new Date().toISOString(), WATCHDOG_WINDOW_MS);
  } catch (e: any) {
    readErrors.push(`cronWatchdog: ${e?.message || 'failed'}`);
  }

  if (missingCrons && missingCrons.length > 0) {
    // Loud + dedupe 12h: sendOperatorSignal rides Telegram and falls back to
    // SMS/email on Telegram failure (lib/signalDelivery.ts) — the missing set
    // includes the frozen-money nets (deposit-accept-sla, orphan-checkout-
    // reaper, final-invoice-dunning, stuck-referral-reaper), so this alert
    // must not die with the wire. Never throws.
    await sendOperatorSignal({
      urgency: 'loud',
      kind: 'system-error',
      summary: `CRON WATCHDOG — ${missingCrons.length} expected cron${missingCrons.length === 1 ? '' : 's'} wrote NO run in 25h`,
      detail:
        `${missingCrons.join(', ')}\n\n` +
        `These crons are scheduled in vercel.json but left no Cron Runs row — ` +
        `check the Vercel cron schedule / recent deploys (Vercel has silently ` +
        `dropped schedules before: commission-invoices, 60+ days). ` +
        `/cronstatus for the full board.`,
      dedupeKey: 'cron-watchdog-missing',
      dedupeWindowMs: 12 * 60 * 60 * 1000,
    });
  }

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
  // 'failed' = SDK-level send errors (dead key class) — logged truthfully
  // since the 2026-07-14 email-truth fix. Nonzero = the pipe is sick TODAY.
  const failed24h = emailSends.filter((e: any) => String(e['Status'] || '') === 'failed').length;

  // ── MORNING-PULSE PROBES (2026-07-14) ──
  // Live assertions, not env-presence guesses: Stripe key, Resend key, Redis,
  // and the silent-killer env set — each red line carries its fix. Born from
  // the Resend outage where a dead key looked healthy for days.
  const probes = await runPlatformProbes();
  const probeReds = probes.filter((p) => !p.ok);
  const probeSkips = probes.filter((p) => p.ok && p.skipped);

  const fmtUsd = (cents: number) =>
    `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

  // The one-glance banner: green means "walk away", red means "read on".
  const anyRed =
    probeReds.length > 0 ||
    cronErrorRuns.length > 0 ||
    (missingCrons !== null && missingCrons.length > 0) ||
    failed24h > 0 ||
    readErrors.length > 0;

  const lines = [
    anyRed ? '🚨 <b>BHC needs attention</b>' : '✅ <b>BHC all green</b>',
    '☀️ <b>BHC Daily Health Digest</b>',
    '',
    probeReds.length === 0
      ? `✅ <b>Probes:</b> ${probes.length}/${probes.length} green (stripe · resend · redis · secrets)${probeSkips.length ? ` · ${probeSkips.length} skipped (network)` : ''}`
      : [
          `🚨 <b>Probes:</b> ${probeReds.length}/${probes.length} FAILING`,
          ...probeReds.map((p) => `  ❌ ${p.name}: ${p.detail}${p.fix ? `\n     FIX: ${p.fix}` : ''}`),
        ].join('\n'),
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
    failed24h > 0
      ? `🚨 <b>Email (24h):</b> ${sent24h} sent · ${failed24h} FAILED · ${suppressed24h} suppressed · ${bounced24h} bounced — failed sends mean the pipe is sick NOW`
      : `<b>Email (24h):</b> ${sent24h} sent · ${suppressed24h} suppressed · ${bounced24h} bounced`,
    '',
    cronErrorRuns.length > 0
      ? `🚨 <b>Cron failures (24h):</b> ${cronErrorRuns.length} runs across ${failedCronNames.length} crons → ${failedCronNames.slice(0, 8).join(', ')}`
      : `✅ <b>Crons healthy</b> — 0 failures in 24h`,
    missingCrons === null
      ? `⚠️ <b>Watchdog blind:</b> Cron Runs read failed — missing-cron check skipped this digest`
      : missingCrons.length > 0
        ? `🚨 <b>No run in 25h:</b> ${missingCrons.join(', ')} — check Vercel cron schedule / recent deploys`
        : `✅ <b>Watchdog:</b> all expected crons wrote a run in the last 25h`,
  ];

  // Surface read failures IN the digest so a blind monitor is impossible.
  // 6 reads total: the 5 parallel pulls + the watchdog's Cron Runs read.
  if (readErrors.length > 0) {
    lines.push(
      '',
      `⚠️ <b>Health read errors:</b> ${readErrors.length}/6 Airtable reads failed (${readErrors.map((e) => e.split(':')[0]).join(', ')}) — numbers above are incomplete.`
    );
  }

  await sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, lines.join('\n')).catch((e: any) =>
    console.warn('[daily-health-digest] telegram fire failed:', e?.message)
  );

  // The monitor must not report green when its own reads broke, and a failing
  // PROBE (dead key, missing webhook secret) must downgrade the run so the
  // Cron Runs board shows red even if Telegram delivery itself failed.
  const status: CronResult['status'] =
    readErrors.length >= 5 ? 'error'
    : readErrors.length > 0 || probeReds.length > 0 ? 'partial'
    : 'success';

  return {
    status,
    recordsTouched: 1,
    notes: `signups=${signups24h} qualified=${qualified24h} closed=${referralsClosedToday.length} cronErrors=${cronErrorRuns.length} missingCrons=${missingCrons === null ? 'read-failed' : missingCrons.length} readErrors=${readErrors.length}`,
  };
}

// Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` — the only auth
// requireCron accepts (the `?secret=` fallback leaked the secret into Vercel
// access logs and was removed in the cron-auth sweep). Was previously
// unauthenticated.
export async function GET(request: Request) {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('daily-health-digest', realHandler)(request);
}
