// app/api/cron/qualified-no-action/route.ts
//
// ABANDON-CART NUDGE — gentle re-engagement for qualified buyers who
// didn't act (no deposit, no Cal.com booking, no inbound reply) within
// a small window after passing /qualify.
//
// Pattern from Crowd Cow + ButcherBox + Shopify cart abandonment data:
// 60-90 min post-decision is the sweet spot for first nudge. Earlier =
// pushy; later = forgotten. Email + optional SMS (gated on opt-in).
//
// Schedule: every 30 min. Window: Qualified At 30min-4h ago.
// Dedup: stamp Notes "[no-action-nudge YYYY-MM-DD]" so each buyer fires
// at most once.

import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { sendEmail } from '@/lib/email';
import { sendSMSToConsumer } from '@/lib/twilio';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { withCronRun } from '@/lib/cronRun';

export const maxDuration = 120;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

interface CronResult {
  status: 'success' | 'partial' | 'error';
  recordsTouched: number;
  notes: string;
}

function esc(s: string): string {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildEmailHtml(args: {
  firstName: string;
  rancherName: string;
  state: string;
}): { subject: string; html: string } {
  const first = args.firstName || 'there';
  const subject = `${first}, your match with ${args.rancherName} is still open`;
  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px;">
<div style="max-width:600px;margin:0 auto;background:white;padding:40px;border:1px solid #A7A29A;">
  <h1 style="font-family:Georgia,serif;font-size:24px;margin:0 0 16px;">Hey ${esc(first)} —</h1>
  <p>Saw you got matched with <strong>${esc(args.rancherName)}</strong> in ${esc(args.state)} earlier today but haven't locked your slot yet. No pressure — wanted to make sure the link didn't get lost.</p>
  <p><strong>What happens if you don't act:</strong> the slot sits open for someone else in your state. ${esc(args.rancherName)}&rsquo;s processing dates fill on a first-come basis.</p>
  <p><strong>If you have questions before deciding:</strong> hit reply. I read every email and answer same-day.</p>
  <div style="text-align:center;margin:24px 0;">
    <a href="${SITE_URL}/member" style="display:inline-block;padding:14px 32px;background:#0E0E0E;color:#F4F1EC;text-decoration:none;font-weight:bold;font-size:13px;letter-spacing:1px;text-transform:uppercase;">Open your match →</a>
  </div>
  <p style="font-size:13px;color:#6B4F3F;">— Benjamin, BuyHalfCow</p>
</div>
</body></html>`;
  return { subject, html };
}

async function realHandler(_request: Request): Promise<CronResult> {
  // Kill-switch gate
  if (process.env.MATCHING_ENABLED === 'false') {
    return { status: 'partial', recordsTouched: 0, notes: 'skipped — MATCHING_ENABLED=false' };
  }

  // Window: qualified within last 4h but at least 30min ago.
  const cutoffStart = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
  const cutoffEnd = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  // Pull recent qualified buyers. Filter formula keeps the cron's Airtable
  // I/O bounded to a small window.
  const formula = `AND(
    NOT({Qualified At} = BLANK()),
    {Qualified At} > '${cutoffStart}',
    {Qualified At} < '${cutoffEnd}',
    {Deposit Paid At} = BLANK(),
    {Unsubscribed} != TRUE(),
    {Bounced} != TRUE(),
    {Complained} != TRUE(),
    NOT(FIND('[no-action-nudge', {Notes}))
  )`.replace(/\s+/g, ' ');

  let candidates: any[] = [];
  try {
    candidates = (await getAllRecords(TABLES.CONSUMERS, formula)) as any[];
  } catch (e: any) {
    return { status: 'error', recordsTouched: 0, notes: `airtable query failed: ${e?.message}` };
  }

  if (candidates.length === 0) {
    return { status: 'success', recordsTouched: 0, notes: 'no qualified-no-action buyers in window' };
  }

  let nudgedEmail = 0;
  let nudgedSms = 0;
  const failures: string[] = [];

  for (const c of candidates) {
    const buyerId = c.id;
    const email = String(c['Email'] || '').trim();
    const firstName = String(c['Full Name'] || '').split(' ')[0] || 'there';
    const state = String(c['State'] || '');
    if (!email) continue;

    // Look up most recent active referral for this buyer to get rancher
    // name. Skip nudge if no active match (they're not in a state where
    // this nudge makes sense — likely waitlisted or already closed).
    let rancherName = 'your rancher';
    try {
      const refs = (await getAllRecords(
        TABLES.REFERRALS,
        `AND(FIND('${buyerId}', ARRAYJOIN({Buyer})) > 0, {Status}='Intro Sent')`,
      )) as any[];
      if (refs.length === 0) continue;
      rancherName = refs[0]['Suggested Rancher Name'] || refs[0]['Rancher Name'] || 'your rancher';
    } catch {
      // Lookup failed — skip rather than nudge with generic copy.
      continue;
    }

    // Email
    try {
      const { subject, html } = buildEmailHtml({ firstName, rancherName, state });
      const r: any = await sendEmail({
        to: email,
        subject,
        html,
        templateName: 'sendQualifiedNoActionNudge',
        _replyContext: { type: 'usr', recordId: buyerId },
      });
      if (!r?.suppressed) nudgedEmail++;
    } catch (e: any) {
      failures.push(`${email}: email ${e?.message || 'unknown'}`);
    }

    // SMS (opt-in only — sendSMSToConsumer re-checks SMS Opt-In + Unsub
    // internally, but we gate here too so we don't waste the call).
    if (c['SMS Opt-In']) {
      try {
        const ok = await sendSMSToConsumer({
          consumer: c,
          body: `Hey ${firstName} — your match with ${rancherName} is still open. Lock your slot: ${SITE_URL}/member — Ben @ BuyHalfCow (reply STOP to opt out)`,
          reason: 'qualified-no-action-nudge',
        });
        if (ok) nudgedSms++;
      } catch (e: any) {
        failures.push(`${email}: sms ${e?.message || 'unknown'}`);
      }
    }

    // Stamp Notes for dedup so we don't re-nudge same buyer
    try {
      const existing = String(c['Notes'] || '');
      await updateRecord(TABLES.CONSUMERS, buyerId, {
        'Notes': `[no-action-nudge ${new Date().toISOString().slice(0, 10)}] ${existing}`.slice(0, 2000),
      });
    } catch {}
  }

  // Operator visibility — only fire Telegram if we actually nudged
  // anyone, so the daily noise stays low.
  if (nudgedEmail > 0 || nudgedSms > 0) {
    try {
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `📨 <b>QUALIFIED-NO-ACTION NUDGE</b>\n\nEmail: ${nudgedEmail}\nSMS: ${nudgedSms}\nFailures: ${failures.length}`,
      );
    } catch {}
  }

  const status: CronResult['status'] = failures.length > 0 ? 'partial' : 'success';
  return {
    status,
    recordsTouched: nudgedEmail + nudgedSms,
    notes: `email=${nudgedEmail} sms=${nudgedSms} failures=${failures.length}`,
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
  return withCronRun('qualified-no-action', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
