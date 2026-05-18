import { NextResponse } from 'next/server';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { withCronRun } from '@/lib/cronRun';

export const maxDuration = 30;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

// Daily healthcheck cron — runs at 7am MT (13:00 UTC), BEFORE any business crons.
// Calls /api/health and sends a Telegram summary so Ben knows everything is live.
async function realHandler(_request: Request): Promise<{ status: 'success' | 'partial' | 'error'; recordsTouched: number; notes: string }> {
  const cronSecret = process.env.CRON_SECRET;
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

  const ok = data.status === 'healthy';
  return {
    status: ok ? 'success' : (data.status === 'down' ? 'error' : 'partial'),
    recordsTouched: Object.keys(checks).length,
    notes: `health=${data.status}; ${Object.entries(checks).map(([k, v]: any) => `${k}=${v?.ok ? 'ok' : 'fail'}`).join(' ')}`,
  };
}

async function authedHandler(request: Request): Promise<Response> {
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
  return withCronRun('healthcheck', realHandler)(request);
}

export const GET = authedHandler;
