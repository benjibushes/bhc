// app/api/admin/cleanup-stale-leads/route.ts
//
// ONE-SHOT CLEANUP — recovers leads who signed up during the manual-promote
// deploy gap (06/02 → 06/04). They came in BEFORE phone gate + qualify gate
// were live in prod, so their records are missing phone numbers and the
// Qualified At stamp. Instead of stranding them in WAITING forever, this
// endpoint mints a fresh qualify-access JWT per buyer and sends a recovery
// email asking them to complete the new 4-question quiz.
//
// Buckets:
//   - HAS PHONE, NOT QUALIFIED: send quiz invite (still recoverable)
//   - NO PHONE, NOT QUALIFIED:  send "we need your phone" email pointing
//                               at /access prefilled (re-signup path)
//
// SAFETY: admin-only. Dry-run by default — must pass ?fire=true to actually
// send emails. Stamps Consumer Notes with `[cleanup-recovery YYYY-MM-DD]`
// so we can't double-fire to the same buyer.

import { NextResponse, NextRequest } from 'next/server';
import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { sendEmail } from '@/lib/email';
import { requireAdmin } from '@/lib/adminAuth';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '@/lib/secrets';

export const maxDuration = 300;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

interface BucketCount {
  hasPhoneNotQualified: number;
  noPhoneNotQualified: number;
  alreadyRecovered: number;
}

function buildRecoveryEmailHtml(args: { firstName: string; qualifyUrl: string; noPhone: boolean }) {
  const { firstName, qualifyUrl, noPhone } = args;
  const first = firstName || 'there';
  const subject = noPhone
    ? `${first} — we need a quick update on your beef order`
    : `${first} — last step to lock in your rancher match`;
  const intro = noPhone
    ? `<p>You signed up over the last few days but our system didn't capture a phone number for you — and your matched rancher needs one to call when your share is ready.</p><p>Click below to update your info (takes 30 seconds) and answer 4 quick questions to confirm your match:</p>`
    : `<p>Quick update: we shipped a 4-question match-confirmation flow so we only introduce buyers to ranchers when both sides are ready. You signed up before this was live — finishing the 4 questions takes 60 seconds and locks in your match.</p>`;
  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:40px;background:#F4F1EC;color:#0E0E0E;">
<h1 style="font-family:Georgia,serif;margin:0 0 20px 0;">Hi ${first} — quick follow-up</h1>
${intro}
<div style="text-align:center;margin:32px 0;">
  <a href="${qualifyUrl}" style="display:inline-block;padding:16px 40px;background:#0E0E0E;color:#F4F1EC;text-decoration:none;font-weight:bold;font-size:14px;letter-spacing:1px;text-transform:uppercase;">Confirm Your Match</a>
</div>
<p style="font-size:13px;color:#6B4F3F;">4 questions: size (quarter/half/whole), timing, storage situation, quick acknowledgment. Then you're matched.</p>
<p style="font-size:13px;color:#6B4F3F;">Hit reply with any questions — I read every email.</p>
<p style="font-size:13px;color:#6B4F3F;">— Benjamin, BuyHalfCow</p>
</body></html>`;
  return { subject, html };
}

export async function POST(request: NextRequest) {
  const __authResp = await requireAdmin(request);
  if (__authResp) return __authResp;

  const url = new URL(request.url);
  const fire = url.searchParams.get('fire') === 'true';
  const hoursBack = Number(url.searchParams.get('hours') || '72');
  const since = new Date(Date.now() - hoursBack * 3600 * 1000).toISOString().slice(0, 10);

  // Pull past N hours of Beef Buyer signups that never qualified.
  const formula = `AND(
    {Created} >= '${since}',
    {Segment} = 'Beef Buyer',
    {Status} = 'Approved',
    {Qualified At} = BLANK(),
    {Unsubscribed} != TRUE(),
    {Bounced} != TRUE(),
    {Complained} != TRUE(),
    NOT(FIND('[cleanup-recovery', {Notes}))
  )`.replace(/\s+/g, ' ');

  let candidates: any[] = [];
  try {
    candidates = await getAllRecords(TABLES.CONSUMERS, formula);
  } catch (e: any) {
    return NextResponse.json({ error: `Airtable query failed: ${e?.message}` }, { status: 500 });
  }

  const counts: BucketCount = { hasPhoneNotQualified: 0, noPhoneNotQualified: 0, alreadyRecovered: 0 };
  const planned: Array<{ id: string; email: string; bucket: 'has_phone' | 'no_phone' }> = [];

  for (const c of candidates) {
    const hasPhone = !!String(c['Phone'] || '').trim();
    if (hasPhone) counts.hasPhoneNotQualified++;
    else counts.noPhoneNotQualified++;
    if (c['Email']) {
      planned.push({
        id: c.id,
        email: String(c['Email']),
        bucket: hasPhone ? 'has_phone' : 'no_phone',
      });
    }
  }

  if (!fire) {
    return NextResponse.json({
      mode: 'dry-run',
      since,
      total: candidates.length,
      counts,
      plannedSample: planned.slice(0, 5),
      message: `Dry-run only. Pass ?fire=true to actually send ${planned.length} recovery emails.`,
    });
  }

  // FIRE MODE — actually send.
  let sent = 0;
  let failed = 0;
  const failures: string[] = [];

  for (const p of planned) {
    try {
      const c: any = candidates.find((x: any) => x.id === p.id);
      const firstName = String(c?.['Full Name'] || '').split(' ')[0] || 'there';
      const qualifyToken = jwt.sign(
        { type: 'qualify-access', consumerId: p.id, email: p.email.toLowerCase() },
        JWT_SECRET,
        { expiresIn: '14d' }, // 14-day grace for recovery — longer than fresh signup window
      );
      const qualifyUrl = `${SITE_URL}/qualify/${encodeURIComponent(p.id)}?token=${encodeURIComponent(qualifyToken)}`;
      const { subject, html } = buildRecoveryEmailHtml({
        firstName,
        qualifyUrl,
        noPhone: p.bucket === 'no_phone',
      });
      const r: any = await sendEmail({
        to: p.email,
        subject,
        html,
        templateName: 'sendCleanupRecovery',
      });
      if (r && r.suppressed) {
        failed++;
        failures.push(`${p.email}: ${r.reason || 'suppressed'}`);
      } else {
        sent++;
        // Stamp Notes so we never double-fire to this buyer.
        try {
          const existingNotes = String(c?.['Notes'] || '');
          await updateRecord(TABLES.CONSUMERS, p.id, {
            'Notes': `[cleanup-recovery ${new Date().toISOString().slice(0, 10)}] ${existingNotes}`.slice(0, 2000),
          });
        } catch {}
      }
    } catch (e: any) {
      failed++;
      failures.push(`${p.email}: ${e?.message || 'unknown'}`);
    }
  }

  // Loud Telegram summary so operator can see the cleanup result without
  // hunting through logs.
  try {
    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      `🧹 <b>STALE LEAD CLEANUP RAN</b>\n\n` +
        `Window: past ${hoursBack}h\n` +
        `Sent: ${sent}\n` +
        `Failed: ${failed}\n` +
        `Buckets: has-phone=${counts.hasPhoneNotQualified} no-phone=${counts.noPhoneNotQualified}\n\n` +
        (failures.length > 0
          ? `Failures (first 5):\n${failures.slice(0, 5).join('\n')}`
          : '<i>All sends succeeded.</i>'),
    );
  } catch {}

  return NextResponse.json({
    mode: 'fired',
    since,
    total: candidates.length,
    counts,
    sent,
    failed,
    failures: failures.slice(0, 20),
  });
}

export async function GET(request: NextRequest) {
  // Convenience: GET = dry-run, POST = optionally fire.
  return POST(request);
}
