// app/api/cron/abandoned-quiz-nudge/route.ts
//
// Buyer quiz-invite DRIP — multi-touch nudge for approved buyers who never
// completed the qualification quiz (the #1 funnel leak: ~50% of approved
// buyers are never invited, and ~80% of the invited never click).
//
// Targets: Status=Approved, Qualified At empty, has Email, not suppressed,
// not already Matched/Closed, and RECENTLY ENGAGED: signed up within
// QUIZ_NUDGE_MAX_DAYS (default 21d) OR waiting-activation-nudged within that
// window (2026-07-22 — reactivated WAITING buyers were created long ago, so a
// created-time-only window made their mid-funnel drop-offs invisible; all-time
// widening stays parked). SERVED STATES ONLY
// — only buyers whose state has an operational rancher (else they'd qualify
// straight onto a waitlist with no rancher to route to).
//
// Cadence: 4 touches, spaced — touch 1 on first sight, then +2d, +4d, +7d
// (≈ days 0 / 2 / 6 / 13). Copy escalates: invite → reminder → scarcity →
// last call. After 4 touches (or aging out of the window) the buyer stops.
//
// Progress tracking (email-hygiene 2026-08-02): stage truth lives in the
// dedicated Consumers field `Quiz Nudge Log` (`t1:2026-08-02;t2:2026-08-04`).
// The old Notes markers (`[quiz-nudge YYYY-MM-DD tN]`) were the ONLY state,
// and the per-send `.slice(0, 2000)` on Notes deleted the oldest markers on
// chatty records — the drip forgot its touches and restarted from t1 forever.
// Dedup now reads the UNION of Notes markers + the log (a buyer with a marker
// but an empty log must not restart) and writes the log going forward; the
// Notes marker is still written as human-readable history only. Legacy
// `[abandoned-quiz-nudge YYYY-MM-DD]` stamps also contain "quiz-nudge", so
// buyers nudged by the old single-shot cron continue mid-drip. Pure logic in
// lib/quizNudgeLog.ts.
//
// Schedule: hourly. Conservative — at most one touch per buyer per day.

import { NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';
import { getAllRecords, updateRecord, TABLES, isInvalidFilterFormulaError } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendEmail } from '@/lib/email';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import { JWT_SECRET } from '@/lib/secrets';
import { getServedStates } from '@/lib/routingSegment';
import { normalizeState } from '@/lib/states';
import { decideQuizNudge, appendQuizNudgeLog, QUIZ_NUDGE_LOG_FIELD } from '@/lib/quizNudgeLog';

export const maxDuration = 120;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

// Cadence constants live in lib/quizNudgeLog.ts (pure, tested) — the cron
// only owns the window + per-run pacing.
const MAX_NUDGE_DAYS = Number(process.env.QUIZ_NUDGE_MAX_DAYS) || 21;
// Per-run send cap — paces a backlog over multiple hourly runs instead of one
// spike (deliverability + avoids a spam-filter trip on a suddenly-widened drip).
const MAX_SENDS_PER_RUN = Number(process.env.QUIZ_NUDGE_MAX_PER_RUN) || 50;

interface CronResult {
  status: 'success' | 'partial' | 'error' | 'maintenance-blocked';
  recordsTouched: number;
  notes: string;
}

function esc(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Touch-indexed copy (touchNum is 1-based). Escalates invite → last call.
function buildEmail(touchNum: number, firstName: string, quizUrl: string, state: string) {
  const first = esc(firstName || 'there');
  const st = esc(state || 'your state');
  const variants: Record<number, { subject: string; lead: string; body: string }> = {
    1: {
      subject: `${firstName || 'there'}, finish your quiz to lock in a rancher (${state})`,
      lead: `You started signing up for BuyHalfCow but haven't finished the 60-second quiz yet.`,
      body: `The quiz tells me <strong>which rancher in ${st} fits you</strong>, what cut breakdown to push, and when you'll get your beef. About a minute. No payment, no pressure.`,
    },
    2: {
      subject: `Still time to get matched in ${state}`,
      lead: `Circling back — your BuyHalfCow quiz is still open.`,
      body: `Sixty seconds and I'll match you with a real ${st} rancher and lock in your cut breakdown. No payment to take it — it just tells me what you actually want.`,
    },
    3: {
      subject: `${first}, still want matched with a ${state} rancher?`,
      lead: `Quick heads up, ${first}.`,
      body: `Our ${st} ranchers take a limited number of families each season, and slots fill as buyers come through. The 60-second quiz is what gets you matched to the right one — there's nothing to pay and nothing you're on the hook for, it just tells me what you're after.`,
    },
    4: {
      subject: `Last call, ${firstName || 'there'} — should I close your file?`,
      lead: `This is my last note, ${first} — I don't want to keep emailing if the timing's off.`,
      body: `If you still want real beef from a ${st} rancher, the quiz is right here and takes a minute. If not, no worries at all — just reply and I'll close it out.`,
    },
  };
  const v = variants[touchNum] || variants[1];
  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px;">
<div style="max-width:600px;margin:0 auto;background:white;padding:40px;border:1px solid #A7A29A;">
  <h1 style="font-family:Georgia,serif;font-size:22px;margin:0 0 16px;">Hey ${first} —</h1>
  <p>${v.lead}</p>
  <p>${v.body}</p>
  <div style="text-align:center;margin:24px 0;">
    <a href="${quizUrl}" style="display:inline-block;padding:14px 32px;background:#0E0E0E;color:#F4F1EC;text-decoration:none;font-weight:bold;font-size:13px;letter-spacing:1px;text-transform:uppercase;">Finish my quiz →</a>
  </div>
  <p style="font-size:13px;color:#6B4F3F;">Questions? Hit reply.<br>— Ben<br>BuyHalfCow<br><em>Connecting every household to a ranch they trust.</em></p>
</div>
</body></html>`;
  return { subject: v.subject, html };
}

async function realHandler(_request: Request): Promise<CronResult> {
  // Maintenance gate — no sends while the platform is paused.
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }

  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  // Window: signed up between MAX_NUDGE_DAYS ago and 1h ago (give the signup
  // welcome a head start). Excludes already-matched/closed buyers.
  // {Funnel Completed At}="" (2026-07-15): held not-ready completers no longer
  // carry Qualified At — without this clause they'd get "finish your quiz"
  // nudges for a quiz they finished. Abandoned = NEITHER stamp present.
  const cutoffEarly = new Date(now - MAX_NUDGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const cutoffLate = new Date(now - 1 * 60 * 60 * 1000).toISOString();

  // Lead Source exclusion (2026-07-17, pressure audit): guide-only downloaders
  // now enter the pipeline as Status='Approved' + Buyer Stage='NEW' so they
  // aren't orphaned — but they NEVER started the quiz, so this drip's copy
  // ("you started signing up but haven't finished the 60-second quiz") is
  // FALSE for them and reads as a spammy wrong-cohort nag. Exclude them here;
  // they're still reachable by waiting-activation and the buyer sequences.
  // ENGAGEMENT-RECENCY WINDOW (2026-07-22, reactivation audit): the 21-day
  // window anchors on CREATED_TIME() *or* the waiting-activation nudge stamp.
  // Reactivated WAITING buyers were created months-to-years ago — a buyer who
  // clicks a waiting nudge, lands on /access, and stalls mid-funnel would
  // otherwise be invisible to this drip (record age fails the window). The OR
  // clause keeps the all-time dead-lead backlog excluded: only buyers we JUST
  // re-touched (Waiting Nudge Last Sent At inside the window) join the organic
  // signup cohort.
  const candidateFormula = (withWaitingRecency: boolean) =>
    `AND(
      {Status}="Approved",
      {Qualified At}="",
      {Funnel Completed At}="",
      {Lead Source}!="halfcow-guide",
      ${withWaitingRecency
        ? `OR(IS_AFTER(CREATED_TIME(), "${cutoffEarly}"), IS_AFTER({Waiting Nudge Last Sent At}, "${cutoffEarly}"))`
        : `IS_AFTER(CREATED_TIME(), "${cutoffEarly}")`},
      IS_BEFORE(CREATED_TIME(), "${cutoffLate}"),
      NOT({Email}=""),
      {Unsubscribed}!=1,
      {Bounced}!=1,
      {Complained}!=1,
      {Buyer Stage}!="MATCHED",
      {Buyer Stage}!="CLOSED"
    )`.replace(/\s+/g, ' ');

  let candidates: any[] = [];
  // Track a swallowed candidate-read failure so a broken Airtable read isn't
  // reported as a green zero-touch run (item 4 — mirror rancher-followup).
  let candidateReadFailed = false;
  try {
    candidates = (await getAllRecords(TABLES.CONSUMERS, candidateFormula(true))) as any[];
  } catch (e: any) {
    if (isInvalidFilterFormulaError(e)) {
      // {Waiting Nudge Last Sent At} missing → degrade to the created-time-only
      // window rather than silently killing the whole drip.
      console.warn('[abandoned-quiz-nudge] waiting-recency clause rejected; falling back to created-time window');
      try {
        candidates = (await getAllRecords(TABLES.CONSUMERS, candidateFormula(false))) as any[];
      } catch (e2: any) {
        console.warn('[abandoned-quiz-nudge] fallback candidate read failed:', e2?.message);
        candidateReadFailed = true;
      }
    } else {
      console.warn('[abandoned-quiz-nudge] candidate read failed:', e?.message);
      candidateReadFailed = true;
    }
  }

  // Served-states scoping (Ben, 2026-06-18): only nudge buyers whose state has
  // an operational rancher. Qualifying buyers in unserved states would dead-end
  // on waitlist and the "rancher in {state}" copy would over-promise. Uses the
  // shared P1′ helper (capacity-OUT — same semantics this loop always had).
  const ranchers = (await getAllRecords(TABLES.RANCHERS).catch(() => [])) as any[];
  const servedStates = getServedStates(ranchers);
  const inServed = candidates.filter((c) => servedStates.has(normalizeState(c['State'])));
  const droppedUnserved = candidates.length - inServed.length;

  let touched = 0;
  let skipped = 0;
  const byTouch: Record<number, number> = {};

  for (const c of inServed) {
    if (touched >= MAX_SENDS_PER_RUN) break; // pace: drain the rest next run

    const notes = String(c['Notes'] || '');
    const nudgeLog = String(c[QUIZ_NUDGE_LOG_FIELD] || '');

    // Durable dedup (email-hygiene 2026-08-02): one touch/day, 4 lifetime,
    // [0,2,4,7]-day spacing — counted from the UNION of the durable log field
    // and any surviving Notes markers, so Notes truncation can never restart
    // the drip. Pure + tested in lib/quizNudgeLog.ts.
    const decision = decideQuizNudge({ notes, log: nudgeLog, today });
    if (decision.action === 'skip') { skipped++; continue; }

    const touchNum = decision.touchNum;
    const firstName = String(c['Full Name'] || '').split(' ')[0] || 'there';
    const state = String(c['State'] || 'your state');
    const email = String(c['Email'] || '').toLowerCase();
    if (!email) { skipped++; continue; }

    // Fresh 30-day qualify-access JWT so the quiz POST authorizes (without it,
    // /api/qualify rejects the submit and the link dead-ends). 30d (was 14d)
    // because this is a multi-touch DRIP — the last touch lands ~day 13 and a
    // buyer may click days later; a short expiry dead-ends the very click the
    // nudge exists to earn.
    const quizToken = jwt.sign(
      { type: 'qualify-access', consumerId: c.id, email },
      JWT_SECRET,
      { expiresIn: '30d' },
    );
    const quizUrl = `${SITE_URL}/qualify/${encodeURIComponent(c.id)}?token=${encodeURIComponent(quizToken)}`;

    try {
      // Claim BEFORE sending so a crash between the send + the stamp can't
      // double-send this touch on the next hourly run. A failed send after the
      // claim just burns one drip touch (acceptable for a multi-touch drip);
      // a duplicate send is worse. The log field is the durable dedup truth;
      // the Notes marker is human-readable history only (its slice can no
      // longer reset the drip).
      await updateRecord(TABLES.CONSUMERS, c.id, {
        [QUIZ_NUDGE_LOG_FIELD]: appendQuizNudgeLog(nudgeLog, touchNum, today),
        Notes: `[quiz-nudge ${today} t${touchNum}] sent. ${notes}`.slice(0, 2000),
      });
      const { subject, html } = buildEmail(touchNum, firstName, quizUrl, state);
      await sendEmail({ to: email, subject, html, templateName: 'sendAbandonedQuizNudge' });
      touched++;
      byTouch[touchNum] = (byTouch[touchNum] || 0) + 1;
    } catch (e: any) {
      console.warn(`[abandoned-quiz-nudge] send failed for ${email}:`, e?.message);
    }
    await new Promise((r) => setTimeout(r, 500)); // pace
  }

  if (touched > 0) {
    const breakdown = Object.keys(byTouch).sort().map((t) => `t${t}:${byTouch[+t]}`).join(' ');
    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      `📨 <b>Quiz-invite drip</b> (served states): ${touched} sent (${breakdown}) · ${skipped} skipped · ${droppedUnserved} held (unserved state).`
    ).catch(() => {});
  }

  // A broken/degraded Airtable read must not be reported green (mirror
  // rancher-followup): a swallowed candidate-read error, or a ranchers read
  // returning 0 rows (prod always has ~80 → 0 = degraded/empty), yields a
  // zero-touch run that looks clean. Surface 'partial' so withCronRun alerts.
  if (candidateReadFailed || ranchers.length === 0) {
    return {
      status: 'partial',
      recordsTouched: touched,
      notes: `${candidateReadFailed ? 'candidate read failed' : 'ranchers read returned 0 rows — degraded/empty'}; not trusting a blind read. sent=${touched} skipped=${skipped}`,
    };
  }

  return { status: 'success', recordsTouched: touched, notes: `sent=${touched} skipped=${skipped}` };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  // heartbeat: hourly campaign cron — see lib/cronRun.ts (maxDuration kill
  // used to leave no Cron Runs row and no alarm).
  return withCronRun('abandoned-quiz-nudge', realHandler, { heartbeat: true })(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
