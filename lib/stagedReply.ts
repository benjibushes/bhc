// lib/stagedReply.ts
//
// THE ONE SEND PATH for a machine-staged buyer reply (Conversations rows the
// resend-inbound webhook writes with Reply Status='staged' + a Staged Reply
// draft).
//
// Lifted VERBATIM from the Telegram webhook's `bsend_` handler (cockpit
// CRM-parity, docs/ADAPTIVE-MARKETING-DESIGN.md §3.5 C3) so the cockpit's
// replies-waiting band and the Telegram one-tap button share ONE
// claim/sanitize/thread/send/stamp rail instead of drifting copies. The
// Telegram handler now delegates here; the admin endpoint
// (app/api/admin/replies/[id]/send) is the second caller.
//
// Reply Status values — read from the single writer,
// app/api/webhooks/resend-inbound/route.ts:709-716 (do not invent new ones):
//   'staged'                — draft on the row, waiting for a human tap
//   'sent'                  — a human tapped Send (this module's stamp)
//   'auto-sent'             — machine sent without staging (full-auto mode)
//   'escalated'             — needs Ben's own words; NO sendable draft
//   'escalated (path sent)' — escalated after a path-to-purchase email fired
//
// DOUBLE-SEND SAFETY: callers claim BEFORE sending via claimStagedReplySend,
// which uses the SAME Redis key namespace as the Telegram handler
// (`bhc:telegram:cb:bsend:<conversationId>`) — so a Telegram tap and a
// cockpit tap on the same conversation contend for ONE claim. Fail-closed on
// Redis error: better to refuse a legit tap than double-email a buyer
// (audit 2026-07-16 precedent).

import { getRecordById, updateRecord, TABLES } from './airtable';
import { sendEmail } from './email';

/** Reply Status values that mean "waiting on a human" (the cockpit band). */
export const REPLY_WAITING_STATUSES = [
  'staged',
  'escalated',
  'escalated (path sent)',
] as const;

export function isReplyWaiting(replyStatus: unknown): boolean {
  return (REPLY_WAITING_STATUSES as readonly string[]).includes(
    String(replyStatus ?? '').trim(),
  );
}

/** Only 'staged' rows carry a machine draft a one-tap Send may fire. */
export function isReplySendable(replyStatus: unknown, stagedReply: unknown): boolean {
  return (
    String(replyStatus ?? '').trim() === 'staged' &&
    String(stagedReply ?? '').trim().length > 0
  );
}

/**
 * Sanitize outbound links defensively (draft is template-derived, but the
 * buyer's own inbound text could have influenced context). Only cal.com and
 * buyhalfcow.com hosts (and their subdomains) survive; everything else —
 * including unparseable URLs — is replaced. Verbatim from the Telegram
 * handler.
 */
export function sanitizeStagedReplyLinks(draft: string): string {
  return String(draft || '').replace(/https?:\/\/[^\s<>"')]+/gi, (u: string) => {
    try {
      const h = new URL(u).hostname;
      return /(^|\.)(cal\.com|buyhalfcow\.com)$/i.test(h) ? u : '[link removed]';
    } catch {
      return '[link removed]';
    }
  });
}

/** Pull the bare address out of a `Name <addr>` From header (or pass through). */
export function replyAddressFromFrom(fromRaw: unknown): string {
  const s = String(fromRaw || '');
  const addrMatch = s.match(/<([^>]+)>/);
  return (addrMatch ? addrMatch[1] : s).toLowerCase().trim();
}

/** Message-Id for threading, out of the row's captured Raw Headers JSON. */
export function inReplyToFromRawHeaders(rawHeaders: unknown): string {
  try {
    const hdrs = JSON.parse(String(rawHeaders || '{}'));
    return String(hdrs['message-id'] || hdrs['Message-Id'] || hdrs['Message-ID'] || '');
  } catch {
    return '';
  }
}

export type SendStagedReplyResult =
  | { status: 'sent'; to: string }
  | { status: 'not-found' }
  | { status: 'already-sent' }
  | { status: 'no-draft' };

/**
 * Load → guard → sanitize → thread → send → stamp. Throws only when the
 * actual email send throws (callers surface that); a failed 'sent' stamp is
 * swallowed exactly as the Telegram handler always did — the send already
 * happened, and un-sending is not an option.
 */
export async function sendStagedReply(conversationId: string): Promise<SendStagedReplyResult> {
  const conv: any = await getRecordById(TABLES.CONVERSATIONS, conversationId).catch(() => null);
  if (!conv) return { status: 'not-found' };
  if (String(conv['Reply Status'] || '') === 'sent') return { status: 'already-sent' };

  const draft = String(conv['Staged Reply'] || '').trim();
  const buyerEmail = replyAddressFromFrom(conv['From']);
  const subject = String(conv['Subject'] || '').trim();
  if (!draft || !buyerEmail.includes('@')) return { status: 'no-draft' };

  const safe = sanitizeStagedReplyLinks(draft);
  const inReplyTo = inReplyToFromRawHeaders(conv['Raw Headers']);

  await sendEmail({
    to: buyerEmail,
    subject: subject ? `Re: ${subject}`.slice(0, 200) : 'Re: your beef question',
    html: `<p>${safe.replace(/\n/g, '<br>')}</p>`,
    ...(inReplyTo ? { headers: { 'In-Reply-To': inReplyTo, References: inReplyTo } } : {}),
  } as any);

  try {
    await updateRecord(TABLES.CONVERSATIONS, conversationId, { 'Reply Status': 'sent' });
  } catch {
    /* field may not exist; send already happened */
  }
  return { status: 'sent', to: buyerEmail };
}

// ── claim (double-send guard for the admin endpoint) ───────────────────────
//
// Same key namespace + TTL as the Telegram route's claimCallback so both
// surfaces contend for one claim per conversation. In-memory fallback when
// Redis is unconfigured (dev); FAIL-CLOSED on a Redis error — refusing a legit
// tap costs a retry, a double-send costs a buyer.

export const STAGED_REPLY_CLAIM_TTL_SECONDS = 300;

const _memoryClaims = new Map<string, number>();

function claimMemory(key: string, ttlSeconds: number): boolean {
  const cutoff = Date.now() - ttlSeconds * 1000;
  for (const [k, ts] of _memoryClaims.entries()) {
    if (ts < cutoff) _memoryClaims.delete(k);
  }
  if (_memoryClaims.has(key)) return false;
  _memoryClaims.set(key, Date.now());
  return true;
}

/** Test hook. */
export function _resetStagedReplyClaimsForTests(): void {
  _memoryClaims.clear();
}

export async function claimStagedReplySend(conversationId: string): Promise<boolean> {
  const key = `bsend:${conversationId}`;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return claimMemory(key, STAGED_REPLY_CLAIM_TTL_SECONDS);
  try {
    const { Redis } = await import('@upstash/redis');
    const redis = new Redis({ url, token });
    const result = await redis.set(`bhc:telegram:cb:${key}`, '1', {
      nx: true,
      ex: STAGED_REPLY_CLAIM_TTL_SECONDS,
    });
    return result === 'OK';
  } catch (e: any) {
    console.error('[stagedReply] claim Redis error (failing closed):', e?.message || e);
    return false;
  }
}
