// POST /api/support/report — buyer distress intake (Area A8).
//
// Before this route, every support link was a raw mailto to the primary
// domain, which the resend-inbound pipeline doesn't watch: a paying buyer
// with "beef arrived thawed" got zero record, zero Telegram, zero SLA —
// unanswered distress converts straight to chargebacks.
//
// This route:
//   1. rate-limits (5/min/IP) + honeypots (hidden `website` field → fake
//      success) — same guard pattern as /api/consumers
//   2. validates shape via lib/supportIntake (pure, unit-tested)
//   3. OPTIONALLY attaches the buyer session (support must also work for
//      locked-out buyers, so no auth is required)
//   4. writes a row into the Conversations table using the EXACT field
//      names the resend-inbound webhook writes (no 'Source' field exists in
//      that schema, so the channel is marked via the '[support-form]'
//      subject prefix + Raw Headers)
//   5. ALWAYS fires a loud operator signal to Telegram — even if the
//      Airtable write fails, the distress signal is never lost.
//
// No money-path writes. Conversations + operator signal only.

import { NextResponse } from 'next/server';
import { createRecord, TABLES } from '@/lib/airtable';
import { rateLimit, getRequestIp } from '@/lib/rateLimit';
import { sendOperatorSignal } from '@/lib/operatorSignal';
import { resolveBuyerSession } from '@/lib/buyerAuth';
import { validateSupportReport, type SupportCategory } from '@/lib/supportIntake';

export const maxDuration = 15;

const SUCCESS_MESSAGE = 'We got it — a human will reply within a few hours.';

// Map the form's category onto the Conversations table's EXISTING
// 'Objection Category' single-select options (see the schema comment in
// app/api/webhooks/resend-inbound/route.ts: price, distance, timing, cut,
// ghost, ready-to-buy, scheduling, capacity, quality, other, none). Only
// exact semantic matches map to a named option; everything else is 'other'.
const OBJECTION_CATEGORY: Record<SupportCategory, string> = {
  'order-issue': 'other',
  'refund-request': 'other',
  'rancher-unresponsive': 'ghost',
  'quality-claim': 'quality',
  'other': 'other',
};

const MONEY_RISK_CATEGORIES: SupportCategory[] = ['refund-request', 'quality-claim'];

export async function POST(request: Request) {
  try {
    // Rate limit. No-op when Upstash env unset (safe fallthrough) — same
    // pattern as /api/consumers. 5/min/IP.
    const ip = getRequestIp(request);
    const rl = await rateLimit(`support-report:${ip}`, { requests: 5, window: '1m' });
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'Too many reports from this network — wait a minute and try again, or email hello@buyhalfcow.com.' },
        { status: 429 },
      );
    }

    let body: any;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    // Honeypot — the /support form renders a hidden `website` field. Real
    // users never fill it; bots that POST it get a fake success so they
    // don't adapt.
    if (typeof body.website === 'string' && body.website.trim().length > 0) {
      return NextResponse.json({ success: true, message: SUCCESS_MESSAGE });
    }

    const validation = validateSupportReport(body);
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const { email, category, message, referralId } = validation.normalized;

    // Auth is OPTIONAL — a locked-out buyer must still be able to report a
    // problem. Best-effort: if a member session exists, link the consumer.
    let consumerId: string | null = null;
    try {
      const session = await resolveBuyerSession(request);
      if (session?.consumerId) consumerId = session.consumerId;
    } catch {
      // Never let auth resolution block a distress report.
    }

    const moneyRisk = MONEY_RISK_CATEGORIES.includes(category);
    const excerpt = message.slice(0, 200);

    // ── Conversations row — field names mirror the resend-inbound webhook
    // exactly. That schema has no 'Source'/channel field, so the channel is
    // marked via the subject prefix (and Raw Headers for forensics).
    const row: Record<string, unknown> = {
      'Timestamp': new Date().toISOString(),
      'Direction': 'inbound',
      'From': email,
      'To': 'support form (buyhalfcow.com/support)',
      'Subject': `[support-form] ${category} — ${email}`,
      'Body': message,
      'Body Plain': message,
      'Sender Type': 'buyer',
      'Objection Category': OBJECTION_CATEGORY[category],
      'Sentiment': 'blocking',
      'Action Needed': 'ben-eyes',
      'AI Summary': `Support form (${category}): ${excerpt}`,
      'Raw Headers': JSON.stringify({
        source: 'support-form',
        ip,
        category,
        referralId: referralId || null,
        consumerId: consumerId || null,
      }),
    };
    if (referralId) row['Linked Referral'] = [referralId];
    if (consumerId) row['Linked Consumer'] = [consumerId];

    let conversationWriteFailed = false;
    try {
      await createRecord(TABLES.CONVERSATIONS, row);
    } catch (e: any) {
      // NEVER lose the distress signal: fall through to the operator signal
      // (which will carry the full excerpt) and still return success — the
      // buyer's report reached a human either way.
      conversationWriteFailed = true;
      console.error('[support-report] Conversations write failed:', e?.message || e);
    }

    // ── Operator signal — loud, always. Dedupe per email+category, 10 min.
    try {
      const refs: Array<{ type: 'referral' | 'consumer'; id: string }> = [];
      if (referralId) refs.push({ type: 'referral', id: referralId });
      if (consumerId) refs.push({ type: 'consumer', id: consumerId });

      const detailLines = [excerpt];
      if (conversationWriteFailed) {
        detailLines.push('', '⚠️ Conversations write FAILED — this Telegram message is the only record.');
      }

      await sendOperatorSignal({
        urgency: 'loud',
        kind: 'inbound-reply',
        summary: `${moneyRisk ? '💰 MONEY-RISK ' : ''}Support form [${category}] from ${email}`,
        detail: detailLines.join('\n'),
        refs: refs.length ? refs : undefined,
        dedupeKey: `support-form:${email}:${category}`,
        dedupeWindowMs: 10 * 60 * 1000,
      });
    } catch (e: any) {
      // sendOperatorSignal already swallows Telegram errors; this is belt +
      // suspenders so the buyer still gets a calm success response.
      console.error('[support-report] operator signal failed:', e?.message || e);
    }

    return NextResponse.json({ success: true, message: SUCCESS_MESSAGE });
  } catch (e: any) {
    console.error('[support-report] unexpected error:', e?.message || e);
    return NextResponse.json(
      { error: 'Something went wrong on our end. Please email hello@buyhalfcow.com and we will take care of you.' },
      { status: 500 },
    );
  }
}
