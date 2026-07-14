// app/api/cron/email-canary/route.ts
//
// EMAIL-KEY CANARY — fires a loud Telegram alert the day the Resend API key
// goes invalid, instead of ranchers discovering it for us.
//
// Background: on 2026-07-14 the RESEND_API_KEY was found INVALID ("API key is
// invalid", validation_error) while ranchers were actively requesting buyer
// deposits — every buyer email silently died (guardedSend reports the failure
// per-send, but nobody watches per-send outcomes), and the reported symptom
// was "deposit links are not sending to customers." Every email rail
// (deposit links, receipts, magic links, nurture, final invoices) shares this
// single key, so a dead key is a platform-wide comms outage.
//
// Procedure (cheap, read-only):
//   1. GET https://api.resend.com/domains with RESEND_API_KEY.
//   2. 200 → healthy. 401/400 (invalid/revoked key) → CRITICAL Telegram alert.
//      Other non-200 (Resend outage) → warning-grade alert.
//   3. Missing key env → CRITICAL (env drift — the "fail silent" pattern).
//
// The alert channel is TELEGRAM on purpose: it works precisely when email is
// the thing that's broken. Schedule: daily via vercel.json.

import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';

export const maxDuration = 30;

interface CanaryResult {
  status: 'success' | 'partial' | 'error';
  recordsTouched: number;
  notes: string;
}

async function realHandler(_request: Request): Promise<CanaryResult> {
  const key = process.env.RESEND_API_KEY || '';

  const alert = async (headline: string, detail: string) => {
    try {
      if (TELEGRAM_ADMIN_CHAT_ID) {
        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          `🚨 <b>EMAIL CANARY: ${headline}</b>\n\n${detail}\n\n` +
            `Every buyer email (deposit links, receipts, magic links) is DOWN until this is fixed. ` +
            `Fix: resend.com → API Keys → create key → Vercel env RESEND_API_KEY → redeploy.`,
        );
      }
    } catch (e: any) {
      console.error('[email-canary] telegram alert failed:', e?.message);
    }
  };

  if (!key) {
    await alert('RESEND_API_KEY is NOT SET', 'The env var is missing/empty in this environment.');
    return { status: 'error', recordsTouched: 0, notes: 'RESEND_API_KEY missing' };
  }

  let res: Response;
  try {
    res = await fetch('https://api.resend.com/domains', {
      headers: { Authorization: `Bearer ${key}` },
      cache: 'no-store',
    });
  } catch (e: any) {
    // Network blip — don't cry wolf; report partial so a persistent failure
    // still shows up in Cron Runs.
    return { status: 'partial', recordsTouched: 0, notes: `resend unreachable: ${e?.message || 'network error'}` };
  }

  if (res.ok) {
    return { status: 'success', recordsTouched: 0, notes: 'resend key valid' };
  }

  if (res.status === 400 || res.status === 401 || res.status === 403) {
    await alert('Resend API key INVALID', `Resend rejected the key (HTTP ${res.status}).`);
    return { status: 'error', recordsTouched: 0, notes: `resend key rejected (HTTP ${res.status})` };
  }

  return { status: 'partial', recordsTouched: 0, notes: `resend non-200 (HTTP ${res.status}) — likely their outage` };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('email-canary', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
