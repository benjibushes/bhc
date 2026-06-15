import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendEmail } from '@/lib/email';
import { sendTelegramUpdate } from '@/lib/telegram';
import { withCronRun } from '@/lib/cronRun';

export const maxDuration = 60;

async function realHandler(_request: Request): Promise<{ status: 'success' | 'maintenance-blocked' | 'error'; recordsTouched: number; notes: string }> {
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }

  // Date-1 guard. Vercel Hobby tier silently skipped the `0 9 1 * *` monthly
  // schedule for 60+ days (0 Cron Runs rows between provisioning and
  // 2026-05-19). Switched to daily 9 UTC + this guard so the cron actually
  // fires once a month + a Cron Runs row appears every other day proving
  // we DID check.
  const today = new Date();
  if (today.getUTCDate() !== 1) {
    return { status: 'success', recordsTouched: 0, notes: `skipped — not 1st (UTC day=${today.getUTCDate()})` };
  }

  const ranchers = await getAllRecords(TABLES.RANCHERS);
  const activeRanchers = ranchers.filter((r: any) =>
    r['Active Status'] === 'Active' && r['Agreement Signed'] === true
  );

  const month = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });
  let sentCount = 0;
  let nonCompliantCount = 0;
  let skippedDuplicateCount = 0;
  let skippedMigratingCount = 0;
  let throttleFieldMissing = false;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const nowMs = Date.now();
  // Per-rancher dedup window. Monthly cadence intent = 28 days minimum between
  // compliance emails. Prevents duplicate sends if Vercel retries the cron OR
  // if the date-1 guard fires twice (DST drift, manual replay, etc.).
  const COMPLIANCE_DEDUP_DAYS = 25;

  for (const rancher of activeRanchers as any[]) {
    const email = rancher['Email'];
    const name = rancher['Operator Name'] || rancher['Ranch Name'] || 'Rancher';

    if (!email) continue;
    // Respect email opt-out / hard bounces (CAN-SPAM + deliverability). A
    // rancher who unsubscribed, bounced, or complained must never get the
    // monthly compliance report — even though it's mission-critical ops mail.
    if (rancher['Unsubscribed'] || rancher['Bounced'] || rancher['Complained']) continue;

    // Migration guard: tier_v2 ranchers don't self-report (commission is taken
    // automatically via Connect deposits), and a rancher mid-migration (invited /
    // call_scheduled / upgrading) must not get the legacy self-report email NOR
    // be auto-flipped Non-Compliant for "missed reports" they were never asked for.
    const pricingModel = String(rancher['Pricing Model'] || '').toLowerCase();
    const migrationStatus = String(rancher['Migration Status'] || '').toLowerCase();
    if (pricingModel === 'tier_v2' || ['invited', 'call_scheduled', 'upgrading'].includes(migrationStatus)) {
      skippedMigratingCount++;
      continue;
    }

    // Throttle: skip if we sent compliance to this rancher in the past 25 days.
    // Field is new — graceful fallback if Airtable doesn't have it yet.
    const lastSent = rancher['Last Compliance Reminder Sent At'];
    if (lastSent) {
      const daysSince = (nowMs - new Date(lastSent).getTime()) / DAY_MS;
      if (daysSince < COMPLIANCE_DEDUP_DAYS) {
        skippedDuplicateCount++;
        continue;
      }
    }

    // MISMATCH FIX: stamp throttle BEFORE sending email. Prior order had no
    // throttle at all — a cron retry on the 1st would re-fire all emails.
    // If the throttle write fails (field doesn't exist), surface that to the
    // operator via skippedReasons but STILL send the email — compliance is
    // mission-critical, dedup is opportunistic.
    let throttleStamped = false;
    try {
      await updateRecord(TABLES.RANCHERS, rancher.id, {
        'Last Compliance Reminder Sent At': new Date().toISOString(),
      });
      throttleStamped = true;
    } catch (fieldErr: any) {
      throttleFieldMissing = true;
      // Don't continue — we still want to send. Operator will see warning.
    }

    await sendEmail({
      to: email,
      subject: `BuyHalfCow Monthly Sales Report - ${month}`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #0E0E0E; background: #F4F1EC; margin: 0; padding: 20px; }
            .container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border: 1px solid #A7A29A; }
            h1 { font-family: Georgia, serif; font-size: 24px; }
            p { color: #6B4F3F; }
            .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #A7A29A; font-size: 12px; color: #A7A29A; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Monthly Sales Report</h1>
            <p>Hi ${name},</p>
            <p>Please report any sales from BuyHalfCow referrals last month.</p>
            <p>Simply reply to this email with:</p>
            <ul style="color: #6B4F3F;">
              <li>Number of sales completed</li>
              <li>Total sale amount</li>
              <li>Any buyer feedback</li>
            </ul>
            <p>If no sales were made through BuyHalfCow referrals, reply <strong>"No sales"</strong>.</p>
            <p>This helps us track commissions and improve the matching process.</p>
            <div class="footer">
              <p>— Benjamin, BuyHalfCow</p>
            </div>
          </div>
        </body>
        </html>
      `,
    });

    sentCount++;

    // Check for missed reports
    const missedReports = rancher['Consecutive Missed Reports'] || 0;
    if (missedReports >= 2) {
      await updateRecord(TABLES.RANCHERS, rancher.id, {
        'Active Status': 'Non-Compliant',
      });
      nonCompliantCount++;
    }
  }

  try {
    const warningSuffix = throttleFieldMissing
      ? `\n\n⚠️ Add "Last Compliance Reminder Sent At" datetime field to Ranchers table so dedup throttle activates next month.`
      : '';
    const skipSuffix = skippedDuplicateCount > 0
      ? ` (skipped ${skippedDuplicateCount} already-reminded within ${25}d)`
      : '';
    const migratingSuffix = skippedMigratingCount > 0
      ? ` (skipped ${skippedMigratingCount} tier_v2/migrating)`
      : '';
    await sendTelegramUpdate(
      `📋 <b>Compliance reminders sent</b>\n\nSent to ${sentCount} active rancher(s) for ${month}${skipSuffix}${migratingSuffix}${warningSuffix}`
    );
  } catch (e) {
    console.error('Telegram error:', e);
  }

  return {
    status: 'success',
    recordsTouched: sentCount + nonCompliantCount,
    notes: `${month}: sent ${sentCount} reminders, ${nonCompliantCount} non-compliant, ${skippedDuplicateCount} skipped (dedup), ${skippedMigratingCount} skipped (tier_v2/migrating)${throttleFieldMissing ? ' WARN: throttle field missing' : ''}`,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  // Cron auth — CRON_SECRET is required (validated at import via lib/secrets).
  const { CRON_SECRET } = await import('@/lib/secrets');
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${CRON_SECRET}`) {
    const url = new URL(request.url);
    const secret = url.searchParams.get('secret');
    if (secret !== CRON_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }
  return withCronRun('compliance-reminders', realHandler)(request);
}

export const GET = authedHandler;
