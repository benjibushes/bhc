import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from './telegram';

/**
 * One typed entry point for every operator-facing alert. Replaces ad-hoc
 * sendTelegramMessage(...) calls scattered across crons/endpoints so:
 *   1. Throttle/dedupe lives in one place (avoids "10 capacity alerts in 5min").
 *   2. Urgency drives delivery (loud, normal, digest).
 *   3. Optional inline buttons follow a consistent format.
 *   4. Future: route loud alerts to SMS via Twilio without touching call sites.
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

export async function sendOperatorSignal(input: SignalInput): Promise<{ sent: boolean; reason?: string }> {
  const { urgency, kind, summary, detail, refs, actions, dedupeKey, dedupeWindowMs = 5 * 60 * 1000 } = input;
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
  try {
    await sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, lines.join('\n'), inlineKeyboard);
    return { sent: true };
  } catch (e: any) {
    console.error('[sendOperatorSignal] send failed:', e?.message);
    return { sent: false, reason: e?.message };
  }
}
