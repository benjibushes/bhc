// app/api/cron/abandoned-quiz-nudge/route.ts
//
// F10 — Abandoned-quiz nudge cron.
//
// Targets buyers who signed up but never completed the qualification quiz.
// Window: Consumers created 1-72h ago, Qualified At empty, has Email, not
// Unsubscribed/Bounced.
//
// Dedup: stamp Notes "[abandoned-quiz-nudge YYYY-MM-DD]" so each buyer
// gets at most one nudge per day.
//
// Schedule: hourly. Conservative — better to miss a buyer than spam.

import { NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';
import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { sendEmail } from '@/lib/email';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { withCronRun } from '@/lib/cronRun';
import { JWT_SECRET } from '@/lib/secrets';

export const maxDuration = 120;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

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

function buildEmail(firstName: string, quizUrl: string, state: string) {
  const first = firstName || 'there';
  const subject = `${first}, finish your quiz to lock in a rancher (${state})`;
  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px;">
<div style="max-width:600px;margin:0 auto;background:white;padding:40px;border:1px solid #A7A29A;">
  <h1 style="font-family:Georgia,serif;font-size:22px;margin:0 0 16px;">Hey ${esc(first)} —</h1>
  <p>You started signing up for BuyHalfCow but haven't finished the 60-second quiz yet. The quiz tells me <strong>which rancher in ${esc(state)} fits you</strong>, what cut breakdown to push, and when you'll get your beef.</p>
  <p>It takes about a minute. No payment, no pressure.</p>
  <div style="text-align:center;margin:24px 0;">
    <a href="${quizUrl}" style="display:inline-block;padding:14px 32px;background:#0E0E0E;color:#F4F1EC;text-decoration:none;font-weight:bold;font-size:13px;letter-spacing:1px;text-transform:uppercase;">Finish my quiz →</a>
  </div>
  <p style="font-size:13px;color:#6B4F3F;">Questions? Hit reply.<br>— Ben<br>BuyHalfCow<br><em>Connecting every household to a ranch they trust.</em></p>
</div>
</body></html>`;
  return { subject, html };
}

async function realHandler(_request: Request): Promise<CronResult> {
  // 1-72h window — Airtable IS_AFTER + IS_BEFORE on Created Time
  const now = Date.now();
  const cutoffEarly = new Date(now - 72 * 60 * 60 * 1000).toISOString();
  const cutoffLate = new Date(now - 1 * 60 * 60 * 1000).toISOString();

  const candidates = await getAllRecords(
    TABLES.CONSUMERS,
    // S7 (2026-06-10): `{Created Time}` is Airtable metadata, NOT a field.
    // Filter formula must use `CREATED_TIME()` function. Schema has `Created`
    // (date) but it's only populated on signup form — use CREATED_TIME() for
    // reliability across all signup paths.
    `AND(
      {Status}="Approved",
      {Qualified At}="",
      IS_AFTER(CREATED_TIME(), "${cutoffEarly}"),
      IS_BEFORE(CREATED_TIME(), "${cutoffLate}"),
      NOT({Email}=""),
      {Unsubscribed}!=1,
      {Bounced}!=1
    )`.replace(/\s+/g, ' ')
  ).catch(() => []) as any[];

  const today = new Date().toISOString().slice(0, 10);
  let touched = 0;
  let skipped = 0;

  for (const c of candidates) {
    const notes = String(c['Notes'] || '');
    // Dedup: already nudged today
    if (notes.includes(`[abandoned-quiz-nudge ${today}]`)) {
      skipped++;
      continue;
    }
    const firstName = String(c['Full Name'] || '').split(' ')[0] || 'there';
    const state = String(c['State'] || 'your state');
    const email = String(c['Email'] || '').toLowerCase();
    if (!email) {
      skipped++;
      continue;
    }
    // Mint a fresh 14-day qualify-access JWT so the quiz POST authorizes.
    // Without a token, /api/qualify rejects the submit — the nudged buyer
    // fills the quiz, taps "finish," and nothing happens (dead-end link).
    // Mirrors app/api/admin/cleanup-stale-leads recovery-email minting.
    const quizToken = jwt.sign(
      { type: 'qualify-access', consumerId: c.id, email },
      JWT_SECRET,
      { expiresIn: '14d' },
    );
    const quizUrl = `${SITE_URL}/qualify/${encodeURIComponent(c.id)}?token=${encodeURIComponent(quizToken)}`;
    try {
      const { subject, html } = buildEmail(firstName, quizUrl, state);
      await sendEmail({
        to: email,
        subject,
        html,
        templateName: 'sendAbandonedQuizNudge',
      });
      // Stamp Notes for dedup
      await updateRecord(TABLES.CONSUMERS, c.id, {
        Notes: `[abandoned-quiz-nudge ${today}] sent. ${notes}`.slice(0, 2000),
      });
      touched++;
    } catch (e: any) {
      console.warn(`[abandoned-quiz-nudge] send failed for ${email}:`, e?.message);
    }
    // pace
    await new Promise((r) => setTimeout(r, 500));
  }

  // Operator visibility on nudge volume
  if (touched > 0) {
    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      `📨 <b>Abandoned-quiz nudges</b>: ${touched} sent · ${skipped} skipped (already nudged today).`
    ).catch(() => {});
  }

  return {
    status: 'success',
    recordsTouched: touched,
    notes: `sent=${touched} skipped=${skipped}`,
  };
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
