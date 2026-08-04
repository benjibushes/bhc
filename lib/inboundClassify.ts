// Inbound-reply AI triage classifier.
//
// Extracted VERBATIM from app/api/webhooks/resend-inbound/route.ts
// (2026-08-03) so the admin backfill (app/api/admin/backfill-inbound-bodies)
// can re-run classification on recovered bodies with the exact same brain the
// live webhook uses. Next.js route files may only export HTTP handlers, so
// the function had to move to lib to be shared. No behavior change.

import { callClaude } from '@/lib/ai';
import type { ReplyContext } from '@/lib/replyAddressing';

export interface Classification {
  senderType: 'buyer' | 'rancher' | 'unknown';
  objectionCategory:
    | 'price' | 'distance' | 'timing' | 'cut' | 'ghost'
    | 'ready-to-buy' | 'scheduling' | 'capacity' | 'quality'
    | 'other' | 'none';
  sentiment: 'positive' | 'neutral' | 'blocking';
  actionNeeded: 'none' | 'ben-eyes' | 'auto-respond' | 'propose-close-won';
  summary: string;
}

export const FALLBACK_CLASSIFICATION: Classification = {
  senderType: 'unknown',
  objectionCategory: 'other',
  sentiment: 'neutral',
  actionNeeded: 'ben-eyes',
  summary: 'AI classification unavailable — Ben to review.',
};

export async function classifyInboundReply(opts: {
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
    console.error('[inbound-classify] classify failed:', e?.message || e);
    return FALLBACK_CLASSIFICATION;
  }
}
