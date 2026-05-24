import { NextResponse } from 'next/server';
import { getAllRecords, TABLES } from '@/lib/airtable';
import { withCronRun } from '@/lib/cronRun';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { CRON_SECRET } from '@/lib/secrets';

export const maxDuration = 300;

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

async function realHandler(
  _request: Request,
): Promise<{
  status: 'success' | 'partial' | 'error';
  recordsTouched: number;
  notes: string;
}> {
  const sinceISO = new Date(Date.now() - SEVEN_DAYS_MS).toISOString();

  // Pull past 7d of sends + suppressions
  const allSends = (await getAllRecords(
    TABLES.EMAIL_SENDS,
    `{Sent At} > "${sinceISO}"`,
  )) as any[];

  // Aggregate by recipient
  const byRecipient: Record<string, { count: number; templates: string[] }> = {};
  const byTemplate: Record<string, number> = {};
  let suppressedCount = 0;

  for (const row of allSends) {
    const email = String(row['Recipient Email'] || '').toLowerCase();
    const template = String(row['Template Name'] || 'unknown');
    const status = String(row['Status'] || '');

    if (status === 'sent') {
      byRecipient[email] = byRecipient[email] || { count: 0, templates: [] };
      byRecipient[email].count++;
      if (byRecipient[email].templates.length < 6) {
        byRecipient[email].templates.push(template);
      }
      byTemplate[template] = (byTemplate[template] || 0) + 1;
    } else if (status === 'suppressed') {
      suppressedCount++;
    }
  }

  // Top 20 recipients by send count
  const topRecipients = Object.entries(byRecipient)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 20);

  // Cap-breach list: anyone with >3 sends in 7 days (matches default cap)
  const capBreaches = topRecipients.filter(([, v]) => v.count > 3);

  // Templates ranked by send volume
  const topTemplates = Object.entries(byTemplate)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  // Build Telegram digest
  const lines: string[] = [];
  lines.push(`📊 <b>SPAM AUDIT</b> · Week ending ${new Date().toISOString().slice(0, 10)}\n`);
  lines.push(`<b>Top 20 high-volume recipients</b> (last 7d):`);
  for (const [email, v] of topRecipients.slice(0, 20)) {
    const tmplList = v.templates.join(', ');
    lines.push(`${v.count}× ${email}\n  ${tmplList}`);
  }
  lines.push('');
  lines.push(`<b>Cap breaches</b> (>3 emails/week): <b>${capBreaches.length}</b>`);
  if (capBreaches.length > 0) {
    lines.push('Run <code>/emaillog &lt;email&gt;</code> on each to inspect.');
  }
  lines.push('');
  lines.push(`<b>Templates by volume</b>:`);
  for (const [template, count] of topTemplates) {
    lines.push(`${count}× ${template}`);
  }
  lines.push('');
  lines.push(`<b>Suppressions this week</b>: ${suppressedCount}`);
  lines.push(`<b>Total sends this week</b>: ${allSends.length - suppressedCount}`);

  const digest = lines.join('\n').slice(0, 4000); // Telegram cap

  if (TELEGRAM_ADMIN_CHAT_ID) {
    await sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, digest);
  }

  return {
    status: 'success',
    recordsTouched: allSends.length,
    notes: `total=${allSends.length} sends=${allSends.length - suppressedCount} suppressed=${suppressedCount} top=${topRecipients.length} breaches=${capBreaches.length}`,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  if (CRON_SECRET) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${CRON_SECRET}`) {
      const { searchParams } = new URL(request.url);
      if (searchParams.get('secret') !== CRON_SECRET) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }
  }
  return withCronRun('spam-audit', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
