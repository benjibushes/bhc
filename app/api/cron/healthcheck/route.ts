import { NextResponse } from 'next/server';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { sendOperatorSignal } from '@/lib/operatorSignal';
import { withCronRun } from '@/lib/cronRun';

export const maxDuration = 30;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

// Daily healthcheck cron — runs at 7am MT (13:00 UTC), BEFORE any business crons.
// Calls /api/health and sends a Telegram summary so Ben knows everything is live.
async function realHandler(_request: Request): Promise<{ status: 'success' | 'partial' | 'error'; recordsTouched: number; notes: string }> {
  const cronSecret = process.env.CRON_SECRET;
  // Audit finding 2026-05-20 #35: previously `?secret=` query string —
  // CRON_SECRET leaked into Vercel access logs on every call. Now Bearer
  // header (not logged).
  const healthUrl = `${SITE_URL}/api/health`;
  const res = await fetch(healthUrl, {
    headers: cronSecret ? { Authorization: `Bearer ${cronSecret}` } : {},
  });
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

    // Audit finding 2026-05-20 #36: route degraded/down through typed
    // operator signal w/ dedupe so flapping deps don't fire forever.
    await sendOperatorSignal({
      urgency: 'loud',
      kind: 'system-error',
      summary: `System ${data.status === 'down' ? 'DOWN' : 'DEGRADED'}`,
      detail: failedChecks,
      dedupeKey: `healthcheck-${data.status}`,
      dedupeWindowMs: 60 * 60_000, // 1h
    });
    // Keep the raw Telegram card too for the rich-formatted status — it's
    // gated by the operator-signal dedupe so we don't double-fire on a stable
    // bad state.
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
