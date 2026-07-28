// POST /api/campaign/requalify-send — CRON_SECRET-gated requalification
// campaign sender (2026-07-28, Ben-approved CV campaign).
//
// WHY THIS EXISTS: campaign sends must run IN PRODUCTION where the live
// RESEND_API_KEY lives (Vercel Sensitive — unreadable locally; the local copy
// drifted and silently failed 50/50 sends). This endpoint accepts a vetted
// recipient batch and pushes every send through the FULL guarded rail
// (sendEmail → guardedSend: suppression re-check at send time, frequency cap,
// tokenized unsubscribe headers + CAN-SPAM footer, Email Sends logging with
// delivered/opened/clicked tracking).
//
// SAFETY SHAPE:
//   • Bearer CRON_SECRET (requireCron) — machine auth, no cookies.
//   • The TEMPLATE IS BAKED IN server-side (the approved copy from
//     docs/marketing/email-quiz-resume.md, quiz-incomplete variant, CV pin).
//     Callers supply ONLY {email, name, state} — this can never send
//     arbitrary content.
//   • Hard cap MAX_BATCH per call; ~600ms pacing (deliverability + the shared
//     8/s Resend gate); per-recipient results returned for the operator log.
//   • dryRun=true echoes the rendered copy for the first recipient and sends
//     nothing.

import { NextResponse } from 'next/server';
import { requireCron } from '@/lib/cronAuth';
import { sendEmail } from '@/lib/email';
import { renderRequalifyEmail, validateRequalifyBatch, DAILY_CAMPAIGN_BUDGET } from '@/lib/requalifyCampaign';
import { getAllRecords } from '@/lib/airtable';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(request: Request) {
  const denied = requireCron(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const parsed = validateRequalifyBatch(body);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const { recipients, campaign, dryRun, rancher } = parsed;
  if (dryRun) {
    const first = recipients[0];
    const preview = renderRequalifyEmail(first.name, first.state, rancher);
    return NextResponse.json({ dryRun: true, count: recipients.length, preview });
  }

  // DOMAIN-WIDE DAILY BUDGET: all rancher campaigns share one deliverability
  // ramp. Count today's campaign_* sends (Email Sends truth) and refuse any
  // batch that would blow the ceiling — five parallel campaigns must never
  // multiply into a blast. Fails CLOSED on a read error: a campaign email is
  // never urgent enough to send blind.
  try {
    const today = new Date().toISOString().slice(0, 10);
    const sentToday = await getAllRecords(
      'Email Sends',
      `AND(FIND('campaign_', {Template Name}) = 1, IS_SAME({Sent At}, '${today}', 'day'))`,
    );
    if (sentToday.length + recipients.length > DAILY_CAMPAIGN_BUDGET) {
      return NextResponse.json(
        { error: `daily campaign budget: ${sentToday.length} sent today + ${recipients.length} requested > ${DAILY_CAMPAIGN_BUDGET}` },
        { status: 429 },
      );
    }
  } catch (e: unknown) {
    return NextResponse.json({ error: 'budget check failed — refusing to send blind' }, { status: 503 });
  }

  let sent = 0, suppressed = 0, failed = 0;
  const results: Array<{ email: string; ok: boolean; suppressed?: boolean; reason?: string }> = [];
  for (const r of recipients) {
    try {
      const rendered = renderRequalifyEmail(r.name, r.state, rancher);
      const res = await sendEmail({
        to: r.email,
        subject: rendered.subject,
        html: rendered.html,
        templateName: `campaign_${campaign}`,
      });
      if (res.success) sent += 1;
      else if (res.suppressed) suppressed += 1;
      else failed += 1;
      results.push({ email: r.email, ok: !!res.success, suppressed: res.suppressed, reason: res.reason });
    } catch (e: unknown) {
      failed += 1;
      results.push({ email: r.email, ok: false, reason: String((e as Error)?.message || 'send threw').slice(0, 120) });
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  return NextResponse.json({ campaign, sent, suppressed, failed, results });
}
