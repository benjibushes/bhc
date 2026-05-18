// Resend Inbound webhook — capture every reply to BHC outbound emails.
//
// FLOW:
//   1. BHC sends outbound with Reply-To: ref-recXXX@replies.buyhalfcow.com
//   2. Buyer/rancher hits Reply → email lands at replies.buyhalfcow.com MX
//   3. Resend Inbound parses + POSTs the email here
//   4. We parse the To address back into a (type, recordId) context
//   5. AI classifies the body (objection category, sentiment, action needed)
//   6. We log everything to the Conversations Airtable table
//   7. If signal is strong (e.g. "we just bought"), we propose Closed Won
//      via a Telegram one-tap card
//   8. Mirror to Telegram so Ben sees every reply in real-time
//
// BEN'S SETUP (one-time, in Resend dashboard):
//   - Domain replies.buyhalfcow.com is added (✓ done)
//   - Add MX record per Resend's instructions:
//       Host: replies (or @ if subdomain root)
//       Type: MX
//       Priority: 10
//       Value: <whatever Resend dashboard shows — usually feedback-smtp.* or inbound.resend.com>
//   - Add SPF/DKIM TXT records as Resend instructs
//   - Resend dashboard → Inbound → Add endpoint:
//       URL: https://www.buyhalfcow.com/api/webhooks/resend-inbound
//       Domain: replies.buyhalfcow.com
//       Mode: catch-all (route all *@replies.buyhalfcow.com here)
//
// SETUP REQUIRED IN AIRTABLE (one-time):
//   Create table "Conversations" with fields:
//     - Timestamp (datetime, primary)
//     - Direction (singleSelect: inbound, outbound)
//     - From (text)
//     - To (text)
//     - Subject (text)
//     - Body (longtext)
//     - Body Plain (longtext) — text version
//     - Linked Referral (link to Referrals table, optional)
//     - Linked Consumer (link to Consumers table, optional)
//     - Linked Rancher (link to Ranchers table, optional)
//     - Sender Type (singleSelect: buyer, rancher, unknown)
//     - Objection Category (singleSelect: price, distance, timing, cut, ghost,
//                          ready-to-buy, scheduling, capacity, quality, other,
//                          none)
//     - Sentiment (singleSelect: positive, neutral, blocking)
//     - Action Needed (singleSelect: none, ben-eyes, auto-respond, propose-close-won)
//     - AI Summary (longtext) — one-line AI summary
//     - Raw Headers (longtext) — for forensic threading

import { NextResponse } from 'next/server';
import { createRecord, getRecordById, TABLES } from '@/lib/airtable';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { callClaude } from '@/lib/ai';
import { findReplyContext, type ReplyContext } from '@/lib/replyAddressing';
import { logAuditEntry } from '@/lib/auditLog';

export const maxDuration = 30;

const CONVERSATIONS_TABLE = 'Conversations';

const rf = (v: any) => v == null ? '' : (typeof v === 'object' && 'name' in v) ? String(v.name) : String(v);

// Normalize Resend's inbound payload across versions. The shape isn't
// completely stable, so we accept multiple variants and fall through.
type ResendInboundPayload = {
  type?: string;
  data?: {
    email_id?: string;
    from?: string | { email: string; name?: string };
    to?: string[] | string;
    subject?: string;
    text?: string;
    html?: string;
    headers?: Record<string, string>;
  };
  // Alternative shape (older / forwarded)
  from?: string;
  to?: string[] | string;
  subject?: string;
  text?: string;
  html?: string;
};

function pluck(payload: ResendInboundPayload) {
  const d = payload.data || (payload as any);
  const fromRaw = (d.from as any) || '';
  const fromAddr = typeof fromRaw === 'string' ? fromRaw : (fromRaw?.email || '');
  return {
    from: fromAddr,
    to: d.to || [],
    subject: d.subject || '(no subject)',
    text: d.text || '',
    html: d.html || '',
    headers: (d as any).headers || {},
  };
}

interface Classification {
  senderType: 'buyer' | 'rancher' | 'unknown';
  objectionCategory:
    | 'price' | 'distance' | 'timing' | 'cut' | 'ghost'
    | 'ready-to-buy' | 'scheduling' | 'capacity' | 'quality'
    | 'other' | 'none';
  sentiment: 'positive' | 'neutral' | 'blocking';
  actionNeeded: 'none' | 'ben-eyes' | 'auto-respond' | 'propose-close-won';
  summary: string;
}

const FALLBACK_CLASSIFICATION: Classification = {
  senderType: 'unknown',
  objectionCategory: 'other',
  sentiment: 'neutral',
  actionNeeded: 'ben-eyes',
  summary: 'AI classification unavailable — Ben to review.',
};

async function classifyReply(opts: {
  from: string;
  subject: string;
  body: string;
  context: ReplyContext | null;
}): Promise<Classification> {
  // Truncate to keep Claude prompt small + fast.
  const body = (opts.body || '').slice(0, 4000);
  const context = opts.context
    ? `Reply context: ${opts.context.type}=${opts.context.recordId}.`
    : 'Reply context: unknown — sender may have replied to an old or stripped Reply-To address.';

  const system = `You are an inbound-email triage classifier for BuyHalfCow,
a marketplace connecting buyers to verified ranchers for whole/half/quarter
cow purchases. You will be shown one inbound email reply.

Output STRICT JSON ONLY with these keys:
- senderType: "buyer" | "rancher" | "unknown"
- objectionCategory: one of: price, distance, timing, cut, ghost, ready-to-buy,
  scheduling, capacity, quality, other, none
- sentiment: "positive" | "neutral" | "blocking"
- actionNeeded: one of: none, ben-eyes, auto-respond, propose-close-won
- summary: one sentence under 25 words

Rules:
- "ready-to-buy" only if sender explicitly indicates intent to purchase NOW.
- "propose-close-won" only if message strongly implies the deal already closed
  (e.g. "we picked up last week", "thanks for the meat", "freezer is full").
- "ghost" if sender says they never heard back from the rancher.
- Default to "ben-eyes" when uncertain — you do not auto-respond on shaky reads.

Return JSON only — no preamble, no markdown fences.`;

  const user = `${context}

From: ${opts.from}
Subject: ${opts.subject}

Body:
${body}`;

  try {
    const raw = await callClaude({
      model: 'claude-haiku-4-5-20251001', // cheap+fast for classification
      system,
      user,
      maxTokens: 400,
    });
    // Strip code fences if model added them
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      senderType: parsed.senderType || 'unknown',
      objectionCategory: parsed.objectionCategory || 'other',
      sentiment: parsed.sentiment || 'neutral',
      actionNeeded: parsed.actionNeeded || 'ben-eyes',
      summary: (parsed.summary || '').toString().slice(0, 200),
    };
  } catch (e: any) {
    console.error('[resend-inbound] classify failed:', e?.message || e);
    return FALLBACK_CLASSIFICATION;
  }
}

async function resolveLinks(context: ReplyContext | null): Promise<{
  referralId?: string;
  consumerId?: string;
  rancherId?: string;
}> {
  if (!context) return {};

  if (context.type === 'ref') {
    try {
      const ref = await getRecordById(TABLES.REFERRALS, context.recordId) as any;
      if (!ref) return { referralId: context.recordId };
      const buyerLinks = ref['Buyer'] || [];
      const rancherLinks = ref['Rancher'] || ref['Suggested Rancher'] || [];
      return {
        referralId: context.recordId,
        consumerId: Array.isArray(buyerLinks) ? buyerLinks[0] : undefined,
        rancherId: Array.isArray(rancherLinks) ? rancherLinks[0] : undefined,
      };
    } catch {
      return { referralId: context.recordId };
    }
  }
  if (context.type === 'usr') return { consumerId: context.recordId };
  if (context.type === 'rnc') return { rancherId: context.recordId };
  return {};
}

export async function POST(request: Request) {
  try {
    const rawBody = await request.text();
    const secret = process.env.RESEND_INBOUND_WEBHOOK_SECRET || '';
    if (secret) {
      const { verifySvixSignature } = await import('@/lib/svixVerify');
      const verify = verifySvixSignature({
        body: rawBody,
        svixId: request.headers.get('svix-id'),
        svixTimestamp: request.headers.get('svix-timestamp'),
        svixSignature: request.headers.get('svix-signature'),
        secret,
      });
      if (!verify.ok) {
        console.warn('[resend-inbound] signature rejected:', verify.reason);
        return NextResponse.json({ ok: false, error: 'invalid signature' }, { status: 401 });
      }
    }
    let payload: ResendInboundPayload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 });
    }

    // For DEFENSE: accept only requests with the expected payload shape.
    const { from, to, subject, text, html, headers } = pluck(payload);

    if (!from && !text && !html) {
      return NextResponse.json({ ok: true, skipped: 'empty payload' });
    }

    const context = findReplyContext(to);
    const links = await resolveLinks(context);
    const bodyForClassify = text || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const classification = await classifyReply({
      from,
      subject,
      body: bodyForClassify,
      context,
    });

    let autoRespondResult: { sent: boolean; reason?: string } | null = null;
    if (
      classification.actionNeeded === 'auto-respond' &&
      classification.senderType === 'buyer' &&
      classification.sentiment !== 'blocking' &&
      ['ghost', 'scheduling'].includes(classification.objectionCategory)
    ) {
      const { maybeAutoRespond } = await import('@/lib/autoRespond');
      autoRespondResult = await maybeAutoRespond({
        to: from,
        subject,
        bodyContext: bodyForClassify,
        category: classification.objectionCategory,
      });
    }

    // Build the Conversations row. Fields that are linked records use arrays.
    const row: Record<string, unknown> = {
      'Timestamp': new Date().toISOString(),
      'Direction': 'inbound',
      'From': from,
      'To': Array.isArray(to) ? to.join(', ') : to,
      'Subject': subject,
      'Body': html || text,
      'Body Plain': text || bodyForClassify,
      'Sender Type': classification.senderType,
      'Objection Category': classification.objectionCategory,
      'Sentiment': classification.sentiment,
      'Action Needed': classification.actionNeeded,
      'AI Summary': classification.summary,
      'Raw Headers': JSON.stringify(headers || {}),
    };
    if (links.referralId) row['Linked Referral'] = [links.referralId];
    if (links.consumerId) row['Linked Consumer'] = [links.consumerId];
    if (links.rancherId) row['Linked Rancher'] = [links.rancherId];

    let conversationId: string | null = null;
    try {
      const created = await createRecord(CONVERSATIONS_TABLE, row);
      conversationId = (created as any)?.id || null;
    } catch (e: any) {
      // Graceful: table doesn't exist yet. Log to console + Telegram so Ben
      // sees the reply even if the table isn't ready.
      console.warn(`[resend-inbound] ${CONVERSATIONS_TABLE} unavailable:`, e?.message || e);
    }

    // ── ACTIVITY STAMPING on the Referral ─────────────────────────────────
    // If the inbound was tied to a referral, stamp the appropriate "Last X
    // Activity At" timestamp on that referral. Lets referral-chasup cron see
    // real engagement even when ranchers/buyers email each other directly
    // (which the cron's old freshness signal — Intro Sent At only — missed,
    // causing 70 lead auto-kills in 7 days before this fix).
    if (links.referralId) {
      try {
        const now = new Date().toISOString();
        const refUpdates: Record<string, any> = {};
        if (classification.senderType === 'rancher') {
          refUpdates['Last Rancher Activity At'] = now;
          refUpdates['Rancher Engaged Flag'] = true;
        } else if (classification.senderType === 'buyer') {
          refUpdates['Last Buyer Activity At'] = now;
        }
        if (Object.keys(refUpdates).length > 0) {
          const { updateRecord, TABLES } = await import('@/lib/airtable');
          await updateRecord(TABLES.REFERRALS, links.referralId, refUpdates);
        }
      } catch (e: any) {
        console.warn('[resend-inbound] referral activity stamp failed:', e?.message);
      }
    }

    // Audit log — every inbound capture is auditable
    try {
      await logAuditEntry({
        actor: 'cron',
        tool: 'resend-inbound',
        targetType: links.referralId ? 'Referral' : links.consumerId ? 'Consumer' : links.rancherId ? 'Rancher' : 'Other',
        targetId: links.referralId || links.consumerId || links.rancherId || 'unknown',
        args: { from, to, subject, hadContext: !!context },
        result: { classification, conversationId },
        reverseAction: { type: 'noop', reason: 'inbound capture is read-only' },
      });
    } catch {}

    // Telegram mirror — Ben sees every reply with the AI's read on it.
    // Inline buttons let him override the AI classification or escalate.
    try {
      const senderEmoji = classification.senderType === 'buyer' ? '👤' : classification.senderType === 'rancher' ? '🤠' : '📨';
      const sentimentEmoji = classification.sentiment === 'positive' ? '🟢' : classification.sentiment === 'blocking' ? '🔴' : '🟡';
      const actionLine = classification.actionNeeded === 'propose-close-won'
        ? '\n💰 <b>AI thinks this might be a closed deal.</b>'
        : classification.actionNeeded === 'auto-respond'
        ? '\n✏️ Auto-respond candidate.'
        : classification.actionNeeded === 'ben-eyes'
        ? '\n👀 Ben to review.'
        : '';

      const autoReplyLine = autoRespondResult?.sent
        ? '\n🤖 Auto-replied to buyer.'
        : autoRespondResult
        ? `\n⚠️ Auto-reply attempt failed: ${autoRespondResult.reason}`
        : '';

      const msg =
        `${senderEmoji} <b>Inbound reply</b> ${sentimentEmoji}\n\n` +
        `<b>From:</b> ${from}\n` +
        `<b>Subject:</b> ${subject}\n` +
        (context ? `<b>Threaded to:</b> ${context.type}=${context.recordId}\n` : `<b>No thread:</b> reply hit catch-all\n`) +
        `<b>Category:</b> ${classification.objectionCategory}\n\n` +
        `<i>${classification.summary}</i>` +
        actionLine +
        autoReplyLine;

      // Inline buttons only when there's actionable signal
      const inlineKeyboard = classification.actionNeeded === 'propose-close-won' && links.referralId
        ? {
            inline_keyboard: [
              [
                { text: '✅ Mark Closed Won', callback_data: `clcheck_won_${links.referralId}` },
                { text: '❌ Not closed', callback_data: `clcheck_working_${links.referralId}` },
              ],
            ],
          }
        : undefined;

      await sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, msg, inlineKeyboard);
    } catch (e: any) {
      console.error('[resend-inbound] Telegram mirror failed:', e?.message || e);
    }

    const ADMIN_EMAIL_FOR_FORWARD = process.env.ADMIN_EMAIL_FOR_FORWARD || process.env.ADMIN_EMAIL || '';
    if (ADMIN_EMAIL_FOR_FORWARD) {
      try {
        const { sendEmail } = await import('@/lib/email');
        await sendEmail({
          to: ADMIN_EMAIL_FOR_FORWARD,
          subject: `[BHC inbound] ${classification.objectionCategory} · ${subject}`,
          html: `<div style="font-family:monospace;font-size:12px;border-bottom:1px solid #ccc;padding-bottom:8px;margin-bottom:12px;">
<strong>From:</strong> ${from}<br>
<strong>To:</strong> ${Array.isArray(to) ? to.join(', ') : to}<br>
<strong>Context:</strong> ${context ? `${context.type}=${context.recordId}` : 'no-thread'}<br>
<strong>Classification:</strong> ${classification.senderType} · ${classification.objectionCategory} · ${classification.sentiment}<br>
<strong>AI Summary:</strong> ${classification.summary}
</div>${html || `<pre>${text}</pre>`}`,
          _bypassSuppression: true,
        } as any);
      } catch (e: any) {
        console.error('[resend-inbound] forward to admin failed:', e?.message);
      }
    }

    return NextResponse.json({
      ok: true,
      classified: classification.objectionCategory,
      sentiment: classification.sentiment,
      threaded: !!context,
      conversationId,
    });
  } catch (error: any) {
    console.error('[resend-inbound] error:', error);
    return NextResponse.json({ ok: false, error: error?.message }, { status: 500 });
  }
}

// GET handler for healthchecks + manual testing
export async function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: 'resend-inbound',
    purpose: 'Receives parsed inbound email payloads from Resend Inbound and classifies them.',
    domain: process.env.REPLIES_DOMAIN || 'replies.buyhalfcow.com',
  });
}
