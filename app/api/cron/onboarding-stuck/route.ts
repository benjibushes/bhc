import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendEmail } from '@/lib/email';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { withCronRun } from '@/lib/cronRun';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '@/lib/secrets';

// Stuck-onboarding nudge cron. Runs daily 16:00 UTC.
//
// Three stuck-buckets the platform was previously not nudging:
//   - Onboarding Status = 'Call Complete' (had the call, never finished wizard)
//   - Onboarding Status = 'Docs Sent' (got setup link, never opened it)
//   - Agreement Signed = true AND Page Live = false (signed but didn't finish
//     pricing / about / logo / payment link → batch-approve gate not met)
//
// Cadence per rancher: day 3, day 7, day 14 since the relevant timestamp.
// After day 14 we stop emailing and Telegram-ping admin for manual outreach.
// Uses a per-rancher "Last Onboarding Nudge At" stamp to throttle.
//
// Why this exists: 31 ranchers currently stuck mid-funnel with zero
// platform-driven follow-up. Same network density they would deliver if
// completed = ~30 more states routable.

export const maxDuration = 90;

const DAY_MS = 24 * 60 * 60 * 1000;
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

function mintSetupUrl(rancherId: string): string {
  const token = jwt.sign({ type: 'rancher-setup', rancherId }, JWT_SECRET, { expiresIn: '60d' });
  return `${SITE_URL}/rancher/setup?token=${token}`;
}

function daysSince(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!isFinite(t)) return null;
  return Math.floor((Date.now() - t) / DAY_MS);
}

function pickNudgeBucket(d: number): 'day3' | 'day7' | 'day14' | null {
  if (d >= 14) return 'day14';
  if (d >= 7) return 'day7';
  if (d >= 3) return 'day3';
  return null;
}

function emailHtml(name: string, missing: string[], setupUrl: string, dayBucket: string): string {
  const list = missing.length
    ? `<ul style="color:#6B4F3F;line-height:1.8;">${missing.map((m) => `<li>${m}</li>`).join('')}</ul>`
    : '';
  const urgency =
    dayBucket === 'day14'
      ? `<p><strong>This is your final automated nudge.</strong> If now isn't the right time, just reply STOP and we'll close your account cleanly.</p>`
      : `<p>5 minutes and you're live + receiving buyer leads.</p>`;
  return `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:40px;background:#F4F1EC;color:#0E0E0E;">
<h1 style="font-family:Georgia,serif;margin:0 0 18px 0;">${name.split(' ')[0]} — you're almost live</h1>
<p>You started your BuyHalfCow setup but haven't finished. We've got buyers in your area waiting.</p>
${missing.length ? `<p><strong>To go live, we still need:</strong></p>${list}` : ''}
<div style="text-align:center;margin:32px 0;">
  <a href="${setupUrl}" style="display:inline-block;padding:16px 40px;background:#0E0E0E;color:#F4F1EC;text-decoration:none;font-weight:bold;font-size:14px;letter-spacing:1px;text-transform:uppercase;">Finish Setup</a>
</div>
${urgency}
<p style="font-size:14px;color:#6B4F3F;margin-top:24px;">Questions? Reply to this email.<br>— Benjamin, BuyHalfCow</p>
</body></html>`;
}

async function realHandler(_request: Request): Promise<{ status: 'success' | 'maintenance-blocked'; recordsTouched: number; notes: string }> {
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }

  const all = (await getAllRecords(TABLES.RANCHERS)) as any[];
  const results: any[] = [];
  let sent = 0;
  let escalated = 0;

  for (const r of all) {
    if (r['Unsubscribed']) continue;
    const onboarding = (r['Onboarding Status'] || '').toString();
    const agreementSigned = !!r['Agreement Signed'];
    const pageLive = !!r['Page Live'];

    // Pick anchor date based on bucket.
    let anchorISO: string | null = null;
    let bucketLabel = '';
    const missing: string[] = [];

    if (agreementSigned && !pageLive) {
      anchorISO = r['Agreement Signed At'] || null;
      bucketLabel = 'signed-no-page';
      if (!r['Slug']) missing.push('A URL slug (in My Page tab)');
      if (!r['About Text']) missing.push('About text (a short story of your ranch)');
      if (!(r['Quarter Payment Link'] || r['Half Payment Link'] || r['Whole Payment Link'])) {
        missing.push('At least one payment link (Square / Stripe / PayPal)');
      }
    } else if (onboarding === 'Call Complete') {
      anchorISO = r['Call Completed At'] || null;
      bucketLabel = 'call-complete';
      missing.push('Sign the partner agreement (1 click in the setup wizard)');
    } else if (onboarding === 'Docs Sent') {
      anchorISO = r['Docs Sent At'] || null;
      bucketLabel = 'docs-sent';
      missing.push('Open your setup link and finish the wizard');
    } else {
      continue;
    }

    const days = daysSince(anchorISO || undefined);
    if (days === null || days < 3) continue;
    const bucket = pickNudgeBucket(days);
    if (!bucket) continue;

    // Throttle: don't re-send same bucket within 4 days.
    const lastNudgeISO: string | undefined = r['Last Onboarding Nudge At'] || undefined;
    const sinceLast = daysSince(lastNudgeISO);
    if (sinceLast !== null && sinceLast < 4) continue;

    const email = (r['Email'] || '').toString().trim();
    const name = (r['Operator Name'] || r['Ranch Name'] || 'Rancher').toString();

    if (bucket === 'day14') {
      // Hand off to admin instead of emailing again. Manual outreach
      // beats automation past 2 weeks of silence.
      try {
        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          `🚨 <b>STUCK ONBOARDING (14d)</b>\n\n${name}\n${email}\nBucket: ${bucketLabel}\nMissing: ${missing.join('; ') || '(see record)'}\n\n<i>Bot has nudged 3x with no progress. Call them or close the loop manually.</i>`
        );
        escalated++;
        // Still stamp so we don't ping every day.
        await updateRecord(TABLES.RANCHERS, r.id, {
          'Last Onboarding Nudge At': new Date().toISOString(),
        });
        results.push({ id: r.id, name, action: 'escalated-to-admin', bucket: bucketLabel });
      } catch (e: any) {
        console.error('Escalation failed:', e?.message);
      }
      continue;
    }

    if (!email) continue;
    try {
      const setupUrl = mintSetupUrl(r.id);
      const result: any = await sendEmail({
        to: email,
        subject: `${name.split(' ')[0]}, you're 1 step from live on BuyHalfCow`,
        html: emailHtml(name, missing, setupUrl, bucket),
        _replyContext: { type: 'rnc', recordId: r.id },
      } as any);
      const hasErr = result?.suppressed;
      if (hasErr) {
        console.error('Stuck-onboarding send suppressed:', result.reason ?? 'no reason');
        continue;
      }
      await updateRecord(TABLES.RANCHERS, r.id, {
        'Last Onboarding Nudge At': new Date().toISOString(),
      });
      sent++;
      results.push({ id: r.id, name, action: `sent-${bucket}`, bucket: bucketLabel });
    } catch (e: any) {
      console.error('Stuck-onboarding send error:', e?.message);
    }
  }

  if (sent + escalated > 0) {
    try {
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `📬 <b>Onboarding-stuck cron</b>\n\nNudged: ${sent}\nEscalated to you: ${escalated}\nTotal touched: ${sent + escalated}`
      );
    } catch {}
  }

  return {
    status: 'success',
    recordsTouched: sent + escalated,
    notes: `sent=${sent} escalated=${escalated}`,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${cronSecret}`) {
      const { searchParams } = new URL(request.url);
      if (searchParams.get('secret') !== cronSecret) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }
  }
  return withCronRun('onboarding-stuck', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
