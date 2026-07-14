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
import { probeResendKey } from '@/lib/platformProbes';

export const maxDuration = 30;

interface CanaryResult {
  status: 'success' | 'partial' | 'error';
  recordsTouched: number;
  notes: string;
}

async function realHandler(_request: Request): Promise<CanaryResult> {
  // One probe, two consumers: this canary + the daily-health-digest both call
  // lib/platformProbes.probeResendKey — same detection, no drift.
  const probe = await probeResendKey();

  if (!probe.ok) {
    try {
      if (TELEGRAM_ADMIN_CHAT_ID) {
        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          `🚨 <b>EMAIL CANARY: ${probe.detail}</b>\n\n` +
            `Every buyer email (deposit links, receipts, magic links) is DOWN until this is fixed.\n` +
            `FIX: ${probe.fix || 'rotate RESEND_API_KEY in Vercel + redeploy'}`,
        );
      }
    } catch (e: any) {
      console.error('[email-canary] telegram alert failed:', e?.message);
    }
    return { status: 'error', recordsTouched: 0, notes: probe.detail };
  }

  if (probe.skipped) {
    // Network blip — don't cry wolf; partial keeps a persistent failure
    // visible in Cron Runs.
    return { status: 'partial', recordsTouched: 0, notes: probe.detail };
  }

  return { status: 'success', recordsTouched: 0, notes: 'resend key valid' };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('email-canary', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
