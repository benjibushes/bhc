// app/api/cron/daily-health-digest/route.ts
//
// D1 — Single Telegram message 9am with platform health.
//
// What Ben sees:
//   - Promised follow-ups due today (absorbed from daily-digest, Wave 1C)
//   - 24h cron error count (any non-success runs)
//   - Active rancher count + capacity drift
//   - Pipeline: pending approval, awaiting payment, slot locked, closed today
//   - Funnel: signups, qualified, booked, closed (last 24h)
//   - Month-to-date: deals closed + commission (absorbed from daily-digest)
//   - Email pipeline: sent, suppressed, bounced
//   - Deploy SHA (compared to git HEAD if drift cron exposes it)
//
// Wave 1C (2026-08-01): daily-digest MERGED INTO this cron and deleted. The
// two fired 65 minutes apart and re-reported the same funnel with DIFFERENT
// filters ("new signups" = all consumers there, Approved-only here), so the
// operator saw conflicting numbers for the same-sounding metric. Canonical
// definitions now live here alone:
//   signups (24h)  = ALL consumers created in the last 24h (any status) —
//                    the daily-digest definition won; Approved-only silently
//                    hid pending signups from the top of the funnel.
//   qualified (24h)= those with Qualified At stamped.
// Dropped from daily-digest without replacement (stated in PR #wave1):
// whole-table member totals, pending-review count (batch-approve drains it
// daily), and the AI Business Brief (a second message re-narrating the same
// numbers — pure noise under the Wave 1C mandate).
//
// Schedule: daily 15:05 UTC (~9am MT). Single message, no spam.

import { NextResponse } from 'next/server';
import { getAllRecords, TABLES } from '@/lib/airtable';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { getLatestCronRuns, missingExpectedCrons } from '@/lib/cronIntrospection';
import { aggregatePausedCrons } from '@/lib/pausedCrons';
import { sendOperatorSignal } from '@/lib/operatorSignal';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import { runPlatformProbes } from '@/lib/platformProbes';
import { getMaxActiveReferrals } from '@/lib/rancherCapacity';
import {
  selectDueFollowUps,
  operatorToday,
  followUpContextLine,
  FOLLOW_UP_DIGEST_MAX_LINES,
  type DueFollowUp,
} from '@/lib/followUpQueue';
import { classifyCronFailures } from '@/lib/cronFailures';

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

/** Telegram parse_mode=HTML. Buyer-supplied text must not be able to break it. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Absorbed from daily-digest (Wave 1C merge) — pure so they're testable ──

/** Month-to-date Closed Won wins + commission. Pure off the referrals read. */
export function aggregateMonthToDate(
  referrals: any[],
  nowMs: number,
): { wins: number; commission: number } {
  const now = new Date(nowMs);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  let wins = 0;
  let commission = 0;
  for (const r of referrals) {
    if (String(r?.['Status'] || '') !== 'Closed Won') continue;
    const closed = new Date(String(r?.['Closed At'] || 0)).getTime();
    if (!Number.isFinite(closed) || closed < monthStart) continue;
    wins++;
    // Fee truth (audit-D fix, 2026-08-02): 'Commission Due' is the DEPRECATED
    // legacy-invoice receivable — $0 on every Connect and broker row, which is
    // every current-model deal. The fee those rails actually captured is
    // stamped in 'BHC Fee Cents'. Prefer it when a real fee exists; fall back
    // to the legacy receivable (same semantics as referralFeeDollars on the
    // rancher dashboard — a written 0 falls through so a legacy receivable is
    // never masked).
    const feeCents = Number(r?.['BHC Fee Cents']);
    commission +=
      Number.isFinite(feeCents) && feeCents > 0
        ? Math.round(feeCents) / 100
        : Number(r?.['Commission Due']) || 0;
  }
  return { wins, commission };
}

/**
 * Promised-follow-ups block ("I'll call you in two weeks", made real).
 * SILENT WHEN EMPTY, deliberately: a digest that reports "0 follow-ups"
 * every morning teaches the operator to skim past the whole message.
 * OPERATOR-ONLY — this tells the operator to make a call; it never emails
 * or texts the buyer.
 */
export function buildFollowUpBlock(followUpsDue: DueFollowUp[]): string {
  if (followUpsDue.length === 0) return '';
  const shown = followUpsDue.slice(0, FOLLOW_UP_DIGEST_MAX_LINES);
  return `<b>⏰ Follow up today (${followUpsDue.length})</b>\n${shown
    .map((f) => {
      const late = f.daysOverdue > 0 ? ` <i>(${f.daysOverdue}d late)</i>` : '';
      const phone = f.phone ? ` · ${escapeHtml(f.phone)}` : ' · no phone';
      const ctx = followUpContextLine(f.notes);
      return `• ${escapeHtml(f.name)}${phone}${late}${ctx ? `\n   ${escapeHtml(ctx)}` : ''}`;
    })
    .join('\n')}${
    followUpsDue.length > shown.length
      ? `\n<i>+${followUpsDue.length - shown.length} more on the desk</i>`
      : ''
  }`;
}

// P4b — "started but didn't finish" cohort. Pure so it's unit-testable off the
// live Airtable read. Three buckets of ranchers who entered the funnel and
// stalled somewhere no other digest line surfaces:
//   - blankOver2d      : applied (Onboarding Status BLANK) >2 days ago, never advanced
//   - signedNotLive    : Agreement Signed = true but Page Live = false (signed-but-dark)
//   - welcomeFailed     : Welcome Email Failed At set (no emailed copy of the wizard link)
export interface StuckOnboardingBuckets {
  blankOver2d: Array<{ id: string; name: string; daysOld: number }>;
  signedNotLive: Array<{ id: string; name: string }>;
  welcomeFailed: Array<{ id: string; name: string }>;
}

export function aggregateStuckOnboarding(ranchers: any[], nowMs: number): StuckOnboardingBuckets {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const nameOf = (r: any) => String(r['Operator Name'] || r['Ranch Name'] || r.id || 'Unknown');
  const out: StuckOnboardingBuckets = { blankOver2d: [], signedNotLive: [], welcomeFailed: [] };
  for (const r of ranchers) {
    const onboarding = String(r['Onboarding Status'] || '').trim();
    if (!onboarding) {
      const created = new Date(String(r['_createdTime'] || '')).getTime();
      if (Number.isFinite(created)) {
        const daysOld = Math.floor((nowMs - created) / DAY_MS);
        if (daysOld >= 2) out.blankOver2d.push({ id: r.id, name: nameOf(r), daysOld });
      }
    }
    if (r['Agreement Signed'] === true && r['Page Live'] !== true) {
      out.signedNotLive.push({ id: r.id, name: nameOf(r) });
    }
    if (r['Welcome Email Failed At']) {
      out.welcomeFailed.push({ id: r.id, name: nameOf(r) });
    }
  }
  return out;
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
  const [cronRuns, ranchers, consumers, referrals, emailSends, stuckRanchers, failedSignupAttempts, cronPauses, followUpRows, pendingSyncRows] = await Promise.all([
    safeRead('cronRuns', getAllRecords('Cron Runs', `IS_AFTER({Started At}, '${cutoff24h}')`) as Promise<any[]>),
    safeRead('ranchers', getAllRecords(TABLES.RANCHERS, `{Active Status}='Active'`) as Promise<any[]>),
    // Wave 1C merge: was Approved-only, which disagreed with daily-digest's
    // all-consumers count for the same-sounding "new signups" metric. The
    // all-consumers definition is canonical now — a pending signup is still a
    // signup; qualified24h narrows by Qualified At below.
    safeRead('consumers', getAllRecords(
      TABLES.CONSUMERS,
      `IS_AFTER(CREATED_TIME(), '${cutoff24h}')`
    ) as Promise<any[]>),
    safeRead('referrals', getAllRecords(TABLES.REFERRALS) as Promise<any[]>),
    safeRead('emailSends', getAllRecords(
      TABLES.EMAIL_SENDS,
      `IS_AFTER({Sent At}, '${cutoff24h}')`
    ) as Promise<any[]>),
    // P4b: started-but-didn't-finish cohort (superset filter — aggregateStuck-
    // Onboarding refines the 2-day age on the blank bucket in JS). Active-only
    // `ranchers` above misses these (they're Pending / signed-but-dark).
    safeRead('stuckRanchers', getAllRecords(
      TABLES.RANCHERS,
      `OR({Onboarding Status}=BLANK(), AND({Agreement Signed}=TRUE(), {Page Live}!=TRUE()), NOT({Welcome Email Failed At}=BLANK()))`
    ) as Promise<any[]>),
    // P4b: failed signup attempts (any outcome except 'created') in last 24h.
    safeRead('signupAttempts', getAllRecords(
      'Signup Attempts',
      `AND(IS_AFTER(CREATED_TIME(), '${cutoff24h}'), {Outcome}!='created')`
    ) as Promise<any[]>),
    // Invisible-pause fix (2026-07-28): a cron paused via Cron Pauses keeps
    // writing status='paused' rows, so it never trips the dead-man's switch —
    // synthetic-e2e sat paused 49 days with zero digest visibility. Small
    // filtered read; aggregatePausedCrons also falls back to the 24h run rows
    // if this read degrades.
    safeRead('cronPauses', getAllRecords(
      TABLES.CRON_PAUSES,
      `{Paused}=TRUE()`
    ) as Promise<any[]>),
    // Wave 1C merge (from daily-digest): promised follow-ups. Filtered to
    // rows with a promise on file — selectDueFollowUps applies the calendar
    // + suppression + terminal-stage gates in JS.
    safeRead('followUps', getAllRecords(
      TABLES.CONSUMERS,
      `NOT({Next Follow Up At} = BLANK())`
    ) as Promise<any[]>),
    // Wave 1C merge (from daily-digest): supply-stall backstop — synced
    // Shopify products import OFF /shop until /approvestore. The filter
    // returns ONLY unapproved rows, not the whole catalog.
    safeRead('pendingSyncProducts', getAllRecords(
      TABLES.RANCHER_PRODUCTS,
      'AND({Sync Managed} = TRUE(), NOT({Marketplace Approved} = TRUE()))'
    ) as Promise<any[]>),
  ]);

  // Cron health — shared classifier (lib/cronFailures, extracted 2026-08-01
  // for the /admin/today cockpit): error/partial rows + stale 'started'
  // heartbeats (lambda killed before `finally` — scale audit 2026-07-22).
  // Same math as before the extraction; the digest's Telegram output is
  // unchanged.
  const { errorRuns: cronErrorRuns, failedCronNames } = classifyCronFailures(cronRuns, now);

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

  // Wave 1C merge (from daily-digest): pending-approval + stalled pipeline
  // counts, month-to-date wins, promised follow-ups — all off reads already
  // in hand, zero extra Airtable calls beyond the two new filtered pulls.
  const referralsPendingApproval = referrals.filter(
    (r: any) => String(r['Status'] || '') === 'Pending Approval'
  ).length;
  const stalledReferrals = referrals.filter((r: any) => {
    if (!['Intro Sent', 'Rancher Contacted'].includes(String(r['Status'] || ''))) return false;
    const lastActivity = r['Last Chased At'] || r['Intro Sent At'] || r['Approved At'];
    if (!lastActivity) return false;
    return now - new Date(String(lastActivity)).getTime() >= 5 * 24 * 60 * 60 * 1000;
  }).length;
  const mtd = aggregateMonthToDate(referrals, now);
  const followUpsDue = selectDueFollowUps(followUpRows as any[], operatorToday());
  const followUpBlock = buildFollowUpBlock(followUpsDue);
  const pendingSyncApproval = pendingSyncRows.length;

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
  // Wave 1C merge (from daily-digest): active ranchers at ≥80% of their cap.
  const nearCapacity = ranchers.filter((r: any) => {
    const cur = Number(r['Current Active Referrals'] || 0);
    return cur >= getMaxActiveReferrals(r) * 0.8;
  }).length;

  // Email
  const sent24h = emailSends.filter((e: any) => String(e['Status'] || '') === 'sent').length;
  const suppressed24h = emailSends.filter((e: any) => String(e['Status'] || '') === 'suppressed').length;
  const bounced24h = emailSends.filter((e: any) => String(e['Status'] || '') === 'bounced').length;
  // 'failed' = SDK-level send errors (dead key class) — logged truthfully
  // since the 2026-07-14 email-truth fix. Nonzero = the pipe is sick TODAY.
  const failed24h = emailSends.filter((e: any) => String(e['Status'] || '') === 'failed').length;

  // P4b — started-but-didn't-finish cohort + failed-signup-attempts count.
  const stuck = aggregateStuckOnboarding(stuckRanchers, now);
  const failedSignups24h = failedSignupAttempts.length;

  // ⏸ Paused bucket — every deliberately-paused cron gets a daily line so a
  // pause can never be invisible again. Not a red condition (pausing is an
  // operator decision) but it must be SEEN daily.
  const pausedCrons = aggregatePausedCrons({ pauseRows: cronPauses, recentRuns: cronRuns, nowMs: now });

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
    // Promised follow-ups first — the one section that IS an action list.
    // Renders as nothing on a day with no promises due (see buildFollowUpBlock).
    followUpBlock || null,
    '',
    probeReds.length === 0
      ? `✅ <b>Probes:</b> ${probes.length}/${probes.length} green (stripe · resend · redis · secrets)${probeSkips.length ? ` · ${probeSkips.length} skipped (network)` : ''}`
      : [
          `🚨 <b>Probes:</b> ${probeReds.length}/${probes.length} FAILING`,
          ...probeReds.map((p) => `  ❌ ${p.name}: ${p.detail}${p.fix ? `\n     FIX: ${p.fix}` : ''}`),
        ].join('\n'),
    '',
    `<b>Closed today:</b> ${referralsClosedToday.length} deal${referralsClosedToday.length === 1 ? '' : 's'} · ${fmtUsd(closedTodayValueCents)}`,
    `<b>Month:</b> ${mtd.wins} deal${mtd.wins === 1 ? '' : 's'} closed · $${mtd.commission.toLocaleString()} commission`,
    `<b>Pipeline:</b> ${referralsAwaiting} awaiting payment · ${referralsLocked} slot locked · ${referralsPendingApproval} pending approval · ${stalledReferrals} stalled 5d+`,
    '',
    `<b>Funnel (24h):</b>`,
    `  signups ${signups24h} → qualified ${qualified24h} → intro ${intro24h} → booked ${booked24h}`,
    '',
    `<b>Ranchers:</b> ${ranchers.length} active · ${livePages} live pages · ${tier_v2} tier_v2 (${legacyActive} legacy) · ${capacityTotal} buyers in pipeline${nearCapacity > 0 ? ` · ⚠️ ${nearCapacity} near capacity` : ''}`,
    connectStuck > 0
      ? `🚨 <b>Connect stuck:</b> ${connectStuck} tier_v2 rancher${connectStuck === 1 ? '' : 's'} can't take deposits (Stripe Connect ≠ active)`
      : `✅ <b>Connect:</b> all tier_v2 ranchers can take deposits`,
    pendingSyncApproval > 0
      ? `🕓 <b>Synced products pending /approvestore:</b> ${pendingSyncApproval} (off /shop until approved)`
      : null,
    '',
    failed24h > 0
      ? `🚨 <b>Email (24h):</b> ${sent24h} sent · ${failed24h} FAILED · ${suppressed24h} suppressed · ${bounced24h} bounced — failed sends mean the pipe is sick NOW`
      : `<b>Email (24h):</b> ${sent24h} sent · ${suppressed24h} suppressed · ${bounced24h} bounced`,
    '',
    // P4b — the onboarding funnel's silent middle: ranchers who started and
    // stalled where no other line catches them, + failed signup-door attempts.
    `<b>Started, not finished:</b> ${stuck.blankOver2d.length} applied&gt;2d blank · ${stuck.signedNotLive.length} signed-not-live · ${stuck.welcomeFailed.length} welcome-email-failed`,
    stuck.welcomeFailed.length > 0
      ? `  ⚠️ welcome-email-failed: ${stuck.welcomeFailed.slice(0, 6).map((w) => w.name).join(', ')} — no emailed wizard link, resend manually`
      : null,
    `<b>Signup attempts (failed, 24h):</b> ${failedSignups24h} non-created (validation / rate-limit / server-error / timeout)`,
    '',
    cronErrorRuns.length > 0
      ? `🚨 <b>Cron failures (24h):</b> ${cronErrorRuns.length} runs across ${failedCronNames.length} crons → ${failedCronNames.slice(0, 8).join(', ')}`
      : `✅ <b>Crons healthy</b> — 0 failures in 24h`,
    missingCrons === null
      ? `⚠️ <b>Watchdog blind:</b> Cron Runs read failed — missing-cron check skipped this digest`
      : missingCrons.length > 0
        ? `🚨 <b>No run in 25h:</b> ${missingCrons.join(', ')} — check Vercel cron schedule / recent deploys`
        : `✅ <b>Watchdog:</b> all expected crons wrote a run in the last 25h`,
    pausedCrons.length > 0
      ? `⏸ <b>Paused crons:</b> ${pausedCrons
          .map((p) => `${p.name}${p.pausedDays !== null ? ` ${p.pausedDays}d` : ''}${p.reason ? ` (${p.reason.slice(0, 40)})` : ''}`)
          .join(' · ')} — /resumecron to wake`
      : null,
  ];

  // Surface read failures IN the digest so a blind monitor is impossible.
  // 11 reads total: the 10 parallel pulls + the watchdog's Cron Runs read.
  if (readErrors.length > 0) {
    lines.push(
      '',
      `⚠️ <b>Health read errors:</b> ${readErrors.length}/11 Airtable reads failed (${readErrors.map((e) => e.split(':')[0]).join(', ')}) — numbers above are incomplete.`
    );
  }

  await sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, lines.filter((l) => l !== null).join('\n')).catch((e: any) =>
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
    notes: `signups=${signups24h} qualified=${qualified24h} closed=${referralsClosedToday.length} mtdWins=${mtd.wins} followUpsDue=${followUpsDue.length} syncPendingApproval=${pendingSyncApproval} cronErrors=${cronErrorRuns.length} missingCrons=${missingCrons === null ? 'read-failed' : missingCrons.length} paused=${pausedCrons.length} readErrors=${readErrors.length} stuck=${stuck.blankOver2d.length}/${stuck.signedNotLive.length}/${stuck.welcomeFailed.length} failedSignups24h=${failedSignups24h}`,
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
