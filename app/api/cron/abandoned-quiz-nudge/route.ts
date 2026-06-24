// app/api/cron/abandoned-quiz-nudge/route.ts
//
// Buyer quiz-invite DRIP — multi-touch nudge for approved buyers who never
// completed the qualification quiz (the #1 funnel leak: ~50% of approved
// buyers are never invited, and ~80% of the invited never click).
//
// Targets: Status=Approved, Qualified At empty, has Email, not suppressed,
// not already Matched/Closed, signed up within QUIZ_NUDGE_MAX_DAYS (default
// 21d — the forward-going window; widening to all-time = the parked dead-lead
// re-qualify campaign, gated on rancher Connect migration). SERVED STATES ONLY
// — only buyers whose state has an operational rancher (else they'd qualify
// straight onto a waitlist with no rancher to route to).
//
// Cadence: 4 touches, spaced — touch 1 on first sight, then +2d, +4d, +7d
// (≈ days 0 / 2 / 6 / 13). Copy escalates: invite → reminder → scarcity →
// last call. After 4 touches (or aging out of the window) the buyer stops.
//
// Progress is tracked WITHOUT a new schema field: each send stamps Notes with
// `[quiz-nudge YYYY-MM-DD tN]`. We count those stamps to know how many touches
// were sent and read the most-recent date for spacing. Legacy
// `[abandoned-quiz-nudge YYYY-MM-DD]` stamps also contain "quiz-nudge", so
// buyers already nudged by the old single-shot cron continue mid-drip.
//
// Schedule: hourly. Conservative — at most one touch per buyer per day.

import { NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';
import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { sendEmail } from '@/lib/email';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { withCronRun } from '@/lib/cronRun';
import { JWT_SECRET } from '@/lib/secrets';
import { isRancherOperationalForBuyers, getOperationalServedStates } from '@/lib/rancherEligibility';
import { normalizeState } from '@/lib/states';

export const maxDuration = 120;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

// Days to wait BEFORE each touch, indexed by touches-already-sent.
// [0,2,4,7] → touch1 immediately, touch2 +2d after touch1, etc. Length = max touches.
const CADENCE_SPACING_DAYS = [0, 2, 4, 7];
const MAX_TOUCHES = CADENCE_SPACING_DAYS.length;
const MAX_NUDGE_DAYS = Number(process.env.QUIZ_NUDGE_MAX_DAYS) || 21;
// Per-run send cap — paces a backlog over multiple hourly runs instead of one
// spike (deliverability + avoids a spam-filter trip on a suddenly-widened drip).
const MAX_SENDS_PER_RUN = Number(process.env.QUIZ_NUDGE_MAX_PER_RUN) || 50;

interface CronResult {
  status: 'success' | 'partial' | 'error';
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
      subject: `Your rancher spot in ${state} is still open — for now`,
      lead: `Quick heads up, ${first}.`,
      body: `Spots with our ${st} ranchers fill as families come through. Yours is still open, but I can't hold it without knowing what you're after. The 60-second quiz locks it in.`,
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
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  // Window: signed up between MAX_NUDGE_DAYS ago and 1h ago (give the signup
  // welcome a head start). Excludes already-matched/closed buyers.
  const cutoffEarly = new Date(now - MAX_NUDGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const cutoffLate = new Date(now - 1 * 60 * 60 * 1000).toISOString();

  const candidates = await getAllRecords(
    TABLES.CONSUMERS,
    `AND(
      {Status}="Approved",
      {Qualified At}="",
      IS_AFTER(CREATED_TIME(), "${cutoffEarly}"),
      IS_BEFORE(CREATED_TIME(), "${cutoffLate}"),
      NOT({Email}=""),
      {Unsubscribed}!=1,
      {Bounced}!=1,
      {Complained}!=1,
      {Buyer Stage}!="MATCHED",
      {Buyer Stage}!="CLOSED"
    )`.replace(/\s+/g, ' ')
  ).catch(() => []) as any[];

  // Served-states scoping (Ben, 2026-06-18): only nudge buyers whose state has
  // an operational rancher. Qualifying buyers in unserved states would dead-end
  // on waitlist and the "rancher in {state}" copy would over-promise. Union
  // logic mirrors the signup-time gate (hasOperationalRancherForState).
  const ranchers = (await getAllRecords(TABLES.RANCHERS).catch(() => [])) as any[];
  const servedStates = new Set<string>();
  for (const r of ranchers) {
    if (!isRancherOperationalForBuyers(r)) continue;
    for (const s of getOperationalServedStates(r)) servedStates.add(s);
  }
  const inServed = candidates.filter((c) => servedStates.has(normalizeState(c['State'])));
  const droppedUnserved = candidates.length - inServed.length;

  let touched = 0;
  let skipped = 0;
  const byTouch: Record<number, number> = {};

  for (const c of inServed) {
    if (touched >= MAX_SENDS_PER_RUN) break; // pace: drain the rest next run

    const notes = String(c['Notes'] || '');

    // One touch per buyer per day, max.
    if (notes.includes(`quiz-nudge ${today}`)) { skipped++; continue; }

    // Count prior touches + find the most-recent nudge date (matches both the
    // new `[quiz-nudge …]` and legacy `[abandoned-quiz-nudge …]` stamps).
    const dates = [...notes.matchAll(/quiz-nudge (\d{4}-\d{2}-\d{2})/g)].map((m) => m[1]).sort();
    const touchesSent = dates.length;
    if (touchesSent >= MAX_TOUCHES) { skipped++; continue; } // drip exhausted

    // Spacing: enough days since the last touch before firing the next one.
    if (touchesSent > 0) {
      const lastDate = dates[dates.length - 1];
      const daysSinceLast = Math.floor((Date.parse(today) - Date.parse(lastDate)) / 86_400_000);
      if (daysSinceLast < CADENCE_SPACING_DAYS[touchesSent]) { skipped++; continue; }
    }

    const touchNum = touchesSent + 1;
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
      // a duplicate send is worse.
      await updateRecord(TABLES.CONSUMERS, c.id, {
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

  return { status: 'success', recordsTouched: touched, notes: `sent=${touched} skipped=${skipped}` };
}

async function authedHandler(request: Request): Promise<Response> {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${cronSecret}`) {
      const { searchParams } = new URL(request.url);
      if (searchParams.get('secret') !== cronSecret) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
  }
  return withCronRun('abandoned-quiz-nudge', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
