import { NextResponse } from 'next/server';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';

export const maxDuration = 30;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

// Daily healthcheck cron — runs at 7am MT (13:00 UTC), BEFORE any business crons.
// Calls /api/health and sends a Telegram summary so Ben knows everything is live.
async function handler(request: Request) {
  try {
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret) {
      const authHeader = request.headers.get('authorization');
      if (authHeader !== `Bearer ${cronSecret}`) {
        const { searchParams } = new URL(request.url);
        const secret = searchParams.get('secret');
        if (secret !== cronSecret) {
          return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
      }
    }

    const healthUrl = `${SITE_URL}/api/health?secret=${encodeURIComponent(cronSecret || '')}`;
    const res = await fetch(healthUrl);
    const data = await res.json();

    const checks = data.checks || {};
    const icon = (ok: boolean) => ok ? '✅' : '❌';
    const msLabel = (c: any) => c?.ok ? `${c.ms}ms` : (c?.error || 'failed');

    if (data.status === 'healthy') {
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `🟢 <b>All Systems Go</b> — ${new Date().toLocaleString('en-US', { timeZone: 'America/Denver', dateStyle: 'short', timeStyle: 'short' })}\n\n` +
        `${icon(checks.airtable?.ok)} Airtable — ${msLabel(checks.airtable)}\n` +
        `${icon(checks.resend?.ok)} Resend — ${msLabel(checks.resend)}\n` +
        `${icon(checks.telegram?.ok)} Telegram — ${msLabel(checks.telegram)}\n` +
        `${icon(checks.ai?.ok)} AI — ${msLabel(checks.ai)}`
      );
    } else {
      const failedChecks = Object.entries(checks)
        .filter(([, v]: any) => !v?.ok)
        .map(([k, v]: any) => `❌ <b>${k}</b>: ${v?.error || 'unknown'}`)
        .join('\n');

      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `🔴 <b>SYSTEM ${data.status === 'down' ? 'DOWN' : 'DEGRADED'}</b>\n\n` +
        failedChecks + '\n\n' +
        Object.entries(checks)
          .filter(([, v]: any) => v?.ok)
          .map(([k, v]: any) => `✅ ${k} — ${v.ms}ms`)
          .join('\n')
      );
    }

    return NextResponse.json({ success: true, status: data.status });
  } catch (error: any) {
    console.error('Healthcheck cron error:', error);
    try {
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `🔴 <b>HEALTHCHECK CRON FAILED</b>\n\n${error.message}\n\nThe health endpoint itself may be down.`
      );
    } catch (e) {
      console.error('Could not send healthcheck failure alert:', e);
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return handler(request);
}
