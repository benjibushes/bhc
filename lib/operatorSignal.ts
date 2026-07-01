import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from './telegram';
import { planSignalDelivery } from './signalDelivery';

/**
 * One typed entry point for every operator-facing alert. Replaces ad-hoc
 * sendTelegramMessage(...) calls scattered across crons/endpoints so:
 *   1. Throttle/dedupe lives in one place (avoids "10 capacity alerts in 5min").
 *   2. Urgency drives delivery (loud, normal, digest).
 *   3. Optional inline buttons follow a consistent format.
 *   4. Loud alerts that Telegram FAILS to deliver (rotten bot token, Telegram
 *      outage) fall back to SMS (OPERATOR_ALERT_PHONE) + email
 *      (OPERATOR_ALERT_EMAIL, else ADMIN_EMAIL) — see lib/signalDelivery.ts
 *      for the pure routing decision. Fallbacks are best-effort: they never
 *      throw into the caller, and they respect the same dedupe window as the
 *      primary wire (an outage must not SMS-storm the operator).
 */

export type SignalUrgency = 'loud' | 'normal' | 'digest';
export type SignalKind =
  | 'capacity'
  | 'sale'
  | 'stuck-rancher'
  | 'login-miss'
  | 'system-error'
  | 'inbound-reply'
  | 'verification-request'
  | 'recovery-suggestion'
  | 'audit'
  | 'other';

interface SignalInput {
  urgency: SignalUrgency;
  kind: SignalKind;
  summary: string;
  detail?: string;
  refs?: Array<{ type: 'rancher' | 'referral' | 'consumer' | 'cron'; id: string; label?: string }>;
  actions?: Array<{ label: string; callbackData: string }>;
  dedupeKey?: string;
  dedupeWindowMs?: number;
}

const _dedupe: Record<string, number> = {};
const URGENCY_EMOJI: Record<SignalUrgency, string> = { loud: '🚨', normal: '🟡', digest: '⚪️' };

// Minimal HTML-escape for the fallback email body (lib/email.ts's esc() is
// not exported; alert summaries can contain <, >, & from error messages).
function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Keep SMS to a single GSM-7 segment: plain ASCII (no emoji — emoji forces
// UCS-2 and cuts the segment to 70 chars), summary + first line of detail,
// hard cap 160.
function smsBody(kind: SignalKind, summary: string, detail?: string): string {
  const firstDetailLine = (detail || '').split('\n').find((l) => l.trim()) || '';
  const base = `BHC ALERT ${kind.toUpperCase()}: ${summary}${firstDetailLine ? ` — ${firstDetailLine.trim()}` : ''}`;
  return base.length > 160 ? `${base.slice(0, 157)}...` : base;
}

export async function sendOperatorSignal(input: SignalInput): Promise<{ sent: boolean; reason?: string }> {
  const { urgency, kind, summary, detail, refs, actions, dedupeKey, dedupeWindowMs = 5 * 60 * 1000 } = input;
  // Dedupe check happens ONCE, before ANY wire (Telegram + fallbacks) — the
  // fallback must inherit the same suppression so a Telegram outage doesn't
  // turn a repeating loud alert into an SMS storm.
  if (dedupeKey) {
    const last = _dedupe[dedupeKey];
    if (last && Date.now() - last < dedupeWindowMs) {
      return { sent: false, reason: 'deduped' };
    }
    _dedupe[dedupeKey] = Date.now();
  }
  const head = `${URGENCY_EMOJI[urgency]} <b>${kind.toUpperCase()}</b> ${summary}`;
  const lines = [head];
  if (detail) lines.push('', detail);
  if (refs && refs.length) {
    lines.push('', refs.map((r) => `• ${r.type}=${r.id}${r.label ? ` (${r.label})` : ''}`).join('\n'));
  }
  const inlineKeyboard = actions && actions.length > 0
    ? { inline_keyboard: [actions.map((a) => ({ text: a.label, callback_data: a.callbackData }))] }
    : undefined;

  // ── Primary wire: Telegram ────────────────────────────────────────────
  // sendTelegramMessage returns null on failure (unconfigured token, non-ok
  // response after retries) and can reject on network errors — both count
  // as "not delivered" for fallback purposes.
  let telegramOk = false;
  let failReason: string | undefined;
  try {
    const res = await sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, lines.join('\n'), inlineKeyboard);
    telegramOk = res !== null && res !== undefined;
    if (!telegramOk) failReason = 'telegram-returned-null';
  } catch (e: any) {
    console.error('[sendOperatorSignal] send failed:', e?.message);
    failReason = e?.message || 'telegram-threw';
  }

  const smsTarget = process.env.OPERATOR_ALERT_PHONE || '';
  // Internal-mail convention mirrors lib/email.ts: ADMIN_EMAIL env with a
  // hard default, so the email fallback always has a target.
  const emailTarget = process.env.OPERATOR_ALERT_EMAIL || process.env.ADMIN_EMAIL || 'admin@buyhalfcow.com';

  const plan = planSignalDelivery({
    urgency,
    telegramOk,
    hasSmsTarget: Boolean(smsTarget),
    hasEmailTarget: Boolean(emailTarget),
  });

  // ── Fallback wires (loud + Telegram down only) — BEST-EFFORT ─────────
  // Dynamic imports keep the twilio SDK + the 3600-line email module out of
  // operatorSignal's static dependency graph (every cron/webhook imports this
  // file); the fallback path is rare by construction. Each wire is isolated
  // in its own try/catch: alerting must never crash the caller.
  const fallbacksDelivered: string[] = [];
  if (plan.sms) {
    try {
      const { sendSMS } = await import('./twilio');
      const ok = await sendSMS({ to: smsTarget, body: smsBody(kind, summary, detail) });
      if (ok) fallbacksDelivered.push('sms');
    } catch (e: any) {
      console.error('[sendOperatorSignal] SMS fallback failed:', e?.message || e);
    }
  }
  if (plan.email) {
    try {
      const { sendEmail } = await import('./email');
      const detailHtml = detail ? `<pre style="white-space:pre-wrap;">${escHtml(detail)}</pre>` : '';
      const refsHtml = refs && refs.length
        ? `<p>${refs.map((r) => `${r.type}=${escHtml(r.id)}${r.label ? ` (${escHtml(r.label)})` : ''}`).join('<br>')}</p>`
        : '';
      const result = await sendEmail({
        to: emailTarget,
        subject: `[BHC ALERT] ${kind.toUpperCase()}: ${summary}`,
        html: `<p><strong>Loud operator alert — Telegram delivery FAILED, this is the email fallback.</strong></p>
<p><strong>${escHtml(kind.toUpperCase())}</strong>: ${escHtml(summary)}</p>
${detailHtml}
${refsHtml}
<p style="color:#6B4F3F;">Check the Telegram bot token / Telegram status — the primary alert wire is down.</p>`,
        // 'sendAdminAlert' is in TRANSACTIONAL_WHITELIST ("capping these
        // blinds the team") so the 3/week frequency cap can't silently
        // suppress alert emails during a multi-day Telegram outage.
        templateName: 'sendAdminAlert',
      });
      if (result?.success) fallbacksDelivered.push('email');
    } catch (e: any) {
      console.error('[sendOperatorSignal] email fallback failed:', e?.message || e);
    }
  }

  if (telegramOk) return { sent: true };
  if (fallbacksDelivered.length > 0) {
    return { sent: true, reason: `telegram-failed; delivered-via=${fallbacksDelivered.join(',')}` };
  }
  return { sent: false, reason: failReason };
}
