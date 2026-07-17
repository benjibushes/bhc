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
import { createRecord, getRecordById, findReferralByBuyerEmail, TABLES } from '@/lib/airtable';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { callClaude } from '@/lib/ai';
import { findReplyContext, type ReplyContext } from '@/lib/replyAddressing';
import { logAuditEntry } from '@/lib/auditLog';

export const maxDuration = 30;

const CONVERSATIONS_TABLE = 'Conversations';

const rf = (v: any) => v == null ? '' : (typeof v === 'object' && 'name' in v) ? String(v.name) : String(v);

// Extract the bare lowercased email from a "Name <addr@host>" or "addr@host" string.
const bareEmail = (raw: any): string => {
  const s = String(raw || '').toLowerCase().trim();
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim();
};

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
  threadId?: string;
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
  if (context.type === 'thread') {
    // Resolve the thread's buyer + rancher + referral so the downstream
    // activity stamp + audit log + Telegram alert have full context.
    try {
      const { THREADS_TABLE } = await import('@/lib/contracts/threads');
      const t: any = await getRecordById(THREADS_TABLE, context.recordId);
      if (!t) return { threadId: context.recordId };
      const buyerLinks = t['Buyer'] || [];
      const rancherLinks = t['Rancher'] || [];
      const referralLinks = t['Referral'] || [];
      return {
        threadId: context.recordId,
        consumerId: Array.isArray(buyerLinks) ? buyerLinks[0] : undefined,
        rancherId: Array.isArray(rancherLinks) ? rancherLinks[0] : undefined,
        referralId: Array.isArray(referralLinks) ? referralLinks[0] : undefined,
      };
    } catch {
      return { threadId: context.recordId };
    }
  }
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
    } else if (process.env.NODE_ENV === 'production') {
      // Audit finding 2026-05-20 #5: secret optional made the endpoint
      // anonymous-callable → writes to Conversations + Claude classify cost
      // + admin email spam vector. Fail-closed in prod.
      console.error('[resend-inbound] RESEND_INBOUND_WEBHOOK_SECRET unset in prod — refusing all requests');
      // Loud, deduped operator alarm so a missing secret can never silently
      // drop inbound replies again (the prior weeks-long leak). Once per 6h.
      try {
        const { sendOperatorSignal } = await import('@/lib/operatorSignal');
        await sendOperatorSignal({
          urgency: 'loud',
          kind: 'system-error',
          summary:
            '🚨 Inbound replies are being DROPPED — RESEND_INBOUND_WEBHOOK_SECRET is unset in production. Set it in Vercel + the Resend Inbound endpoint to restore reply routing.',
          dedupeKey: 'inbound-secret-missing',
          dedupeWindowMs: 6 * 60 * 60 * 1000,
        });
      } catch {
        /* alerting must never block the response */
      }
      return NextResponse.json({ ok: false, error: 'webhook secret not configured' }, { status: 401 });
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

    // ── FROM-EMAIL FALLBACK ───────────────────────────────────────────────
    // The tagged Reply-To path (ref-<id>@replies...) almost never fires: most
    // buyer-facing emails fall back to inbox@replies... (no _replyContext) and
    // buyers reply to old threads. Result: `Last Buyer Activity At` was blank
    // table-wide, so referral-chasup's ghost-auto-close treated every buyer as
    // never-engaged. When we have no tagged context, resolve the referral by
    // matching the inbound From address to a referral's Buyer Email. A From
    // match means the sender IS the buyer, so we also force senderType below.
    let matchedByFromEmail = false;
    if (!links.referralId && !links.threadId) {
      const fromAddr = bareEmail(from);
      if (fromAddr && fromAddr.includes('@')) {
        try {
          const ref: any = await findReferralByBuyerEmail(fromAddr);
          if (ref?.id) {
            links.referralId = ref.id;
            const buyerLinks = ref['Buyer'] || [];
            const rancherLinks = ref['Rancher'] || ref['Suggested Rancher'] || [];
            if (!links.consumerId && Array.isArray(buyerLinks)) links.consumerId = buyerLinks[0];
            if (!links.rancherId && Array.isArray(rancherLinks)) links.rancherId = rancherLinks[0];
            matchedByFromEmail = true;
          }
        } catch (e: any) {
          console.warn('[resend-inbound] from-email referral fallback failed:', e?.message);
        }
      }
    }

    const bodyForClassify = text || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const classification = await classifyReply({
      from,
      subject,
      body: bodyForClassify,
      context,
    });

    // ── COLD RANCHER PROSPECT guard ───────────────────────────────────────
    // A reply tagged prp-<id>@replies (set by the outreach dashboard on cold
    // rancher outreach) is rancher-side BY DEFINITION — the recipient address
    // itself encodes who it is. Override any AI mislabel so a prospect saying
    // "yeah, I'm interested" can NEVER be treated as a buyer: no ready-to-buy
    // escalation, no buyer objection copy, no buyer-facing "you pay the rancher
    // direct" reply. It just surfaces to Ben's Telegram as a rancher reply to
    // close by hand. (isBuyer below also excludes it, belt-and-suspenders.)
    const isProspect = context?.type === 'prp';
    if (isProspect) classification.senderType = 'rancher';

    // ── BUYER SALES ARM ───────────────────────────────────────────────────
    // For buyer replies that aren't blocking, either escalate (ready-to-buy →
    // call) or let the machine answer common objections in Ben's voice from
    // the template bank. Build the buyer context once, from the linked
    // referral/consumer/rancher, and load the purchase-readiness signals.
    let autoRespondResult: import('@/lib/autoRespond').AutoRespondResult | null = null;
    let escalation: { tier: string; sent: boolean } | null = null;
    let stagedReplyDraft = '';

    // Deterministic sender guard: never treat a message as a BUYER if the
    // From matches the linked RANCHER's email. Haiku can mislabel a short
    // rancher reply as senderType='buyer', which would send buyer-facing
    // objection copy ("you pay <rancher> direct...") to the rancher (audit
    // 2026-07-16). Resolve the rancher email up front and exclude it.
    let fromMatchesRancher = false;
    const fromAddrForGate = bareEmail(from);
    if (links.rancherId && fromAddrForGate) {
      try {
        const { getRecordById, TABLES } = await import('@/lib/airtable');
        const rr: any = await getRecordById(TABLES.RANCHERS, links.rancherId).catch(() => null);
        const remail = String(rr?.['Email'] || '').toLowerCase().trim();
        if (remail && fromAddrForGate.includes(remail)) fromMatchesRancher = true;
      } catch {}
    }

    // Deterministic STOP guard: a family who wants out must never get a
    // machine answer, regardless of what the classifier read (audit). Checks
    // opt-out language in the sender's OWN words only — quoted history is
    // stripped first, because our outbound emails legitimately contain
    // "unsubscribe"/opt-out lines: an interested reply quoting the original
    // ("...yes let's talk! > if you'd rather I stop emailing, just say so")
    // must never be read as a stop (pressure test 2026-07-17 C6 — it was
    // auto-Suppressing interested ranchers replying to the T3 breakup).
    const unquotedBody = String(bodyForClassify || '')
      .split(/\n\s*(?:>|On .{5,80} wrote:)/)[0]
      // html-derived bodies have collapsed newlines — catch the flat form too
      .split(/On .{5,80} wrote:/)[0]
      .replace(/^\s*>.*$/gm, '')
      .trim();
    const saysStop = /\b(unsubscribe|stop emailing|take me off|remove me|opt.?out|do not (contact|email)|leave me alone)\b/i.test(
      unquotedBody,
    );

    // ── PROSPECT REPLY STAMP (the booking-brain bridge) ───────────────────
    // Stamp the raw reply onto the Rancher Prospects row so the outreach
    // dashboard's booking brain (classify → availability → cal.com slot
    // proposals → cockpit one-tap Book) picks it up on its next pass.
    // Airtable is the bus between the two apps — no cross-app secrets.
    // Stamping Outreach Status='Replied' ALSO instantly halts T2/T3
    // follow-ups (pickFollowUps only touches status='Sent' rows), so a
    // rancher who replied can never get a canned follow-up afterward.
    // 'Reply Class' is deliberately NOT set — blank Reply Class + Replied
    // status is the brain's "unprocessed" marker.
    let prospectStampFailed = false;
    let prospectDuplicate = false;
    let prospectFromMismatch = false;
    if (isProspect && context) {
      const PROSPECTS_TABLE = 'tbljw0vdfMpyQ6Nk5'; // Rancher Prospects (dashboard app's table, same base)
      try {
        const { getRecordById, updateRecord } = await import('@/lib/airtable');
        const prow: any = await getRecordById(PROSPECTS_TABLE, context.recordId).catch(() => null);
        const mid = String(
          (headers as any)?.['message-id'] || (headers as any)?.['Message-Id'] || (headers as any)?.['Message-ID'] || '',
        ).trim();
        if (!prow) {
          // The exact silent failure the flag exists for (pressure test C7):
          // a bad/deleted record id means no halt + no brain — warn loudly.
          prospectStampFailed = true;
          console.warn('[resend-inbound] prp stamp: prospect row not found', context.recordId);
        } else if (mid && String(prow['Reply Message Id'] || '').trim() === mid) {
          // Resend redelivery of the SAME email (at-least-once) — already
          // stamped. Skip the re-stamp, duplicate Setter Log line, duplicate
          // Conversations row, and duplicate Telegram card (pressure test C3).
          prospectDuplicate = true;
        } else if (String(prow['Outreach Status'] || '') === 'Suppressed') {
          // A stopped prospect writing again must not resurrect — Telegram only.
          await sendTelegramMessage(
            TELEGRAM_ADMIN_CHAT_ID,
            `📨 <b>Suppressed prospect wrote again</b>\n${String(prow['Ranch Name'] || from).replace(/[<>&]/g, '')}\nReview by hand if worth reopening.`,
          ).catch(() => {});
        } else {
          const now = new Date().toISOString();
          const fromAddr = bareEmail(from);
          const rowEmail = String(prow['Email'] || '').toLowerCase().trim();
          const authResults = String(
            (headers as any)?.['authentication-results'] || (headers as any)?.['Authentication-Results'] || '',
          ).toLowerCase();
          const dkimSpfPass = /dkim=pass|spf=pass/.test(authResults);
          const fromMatches = !!rowEmail && fromAddr.includes(rowEmail);
          prospectFromMismatch = !fromMatches;
          const replyAuth = !fromMatches
            ? `from-mismatch:${fromAddr.slice(0, 80)}`
            : dkimSpfPass
            ? 'pass'
            : 'unverified';
          // A second reply arriving before the brain processed the first must
          // not erase it — APPEND so the brain classifies the full exchange
          // (pressure test C13). Cleared 'Reply Class'/'Reply Draft'/'Proposed
          // Slots' re-open the row so a reply AFTER processing gets triaged
          // fresh instead of staying invisible forever (C4/C8/C10/C16).
          const priorBody = String(prow['Reply Body'] || '').trim();
          const priorCls = String(prow['Reply Class'] || '').trim();
          // blank = brain hasn't run; 'triaging:' = brain is mid-pass right
          // now (our Reply Class clear below aborts its claim, so IT will not
          // finish — keep both bodies for the retriage).
          const priorUnprocessed = !!priorBody && (priorCls === '' || priorCls.startsWith('triaging:'));
          const newBody = bodyForClassify.slice(0, 4000);
          const mergedBody = priorUnprocessed
            ? `${priorBody}\n\n--- next reply ---\n\n${newBody}`.slice(0, 8000)
            : newBody;
          // Anti-forgery (pressure test C9): record ids are guessable enough
          // that a From-mismatched email must never be able to SUPPRESS a
          // prospect (that would mute legit outreach to a victim ranch). A
          // mismatched reply still stamps Replied — ranchers really do reply
          // from a different address than the one on file — but only an
          // address-matched sender can trigger the stop path.
          const effectiveStop = saysStop && fromMatches;
          const logDate = now.slice(0, 10);
          const priorLog = String(prow['Setter Log'] || '').replace(/\s+$/, '');
          const logLine = effectiveStop ? 'auto: stop (webhook)' : 'auto: reply received (webhook)';
          await updateRecord(PROSPECTS_TABLE, context.recordId, {
            'Outreach Status': effectiveStop ? 'Suppressed' : 'Replied',
            'Reply Body': mergedBody,
            'Reply Snippet': bodyForClassify.slice(0, 200),
            'Reply Message Id': mid,
            'Reply Auth': replyAuth,
            'Reply Class': '',
            'Reply Draft': '',
            'Proposed Slots': '',
            'Last Reply At': now,
            'Last Touch At': now,
            'Last Touch Note': logLine,
            'Setter Log': `${priorLog ? priorLog + '\n' : ''}${logDate} · ${logLine}`,
          });
        }
      } catch (e: any) {
        // Stamp failure must never drop the reply — the Telegram mirror below
        // still fires, and Ben sees it. But a silent stamp failure is the
        // worst partial failure: Ben sees the reply and assumes the machine
        // handled it, while follow-ups DIDN'T halt and the booking brain will
        // never pick it up. Flag it so the card below warns him explicitly.
        prospectStampFailed = true;
        console.warn('[resend-inbound] prp stamp failed:', e?.message || e);
      }
    }

    // Redelivered prospect email (same Message-Id already on the row): fully
    // handled the first time — skip the duplicate Conversations row, audit
    // entry, and Telegram card. Fast 200 so Resend stops retrying.
    if (prospectDuplicate) {
      return NextResponse.json({ ok: true, duplicate: true });
    }

    const isBuyer =
      !isProspect &&
      !fromMatchesRancher &&
      (classification.senderType === 'buyer' ||
        (classification.senderType === 'unknown' && !!links.referralId && matchedByFromEmail));

    // IDEMPOTENCY (audit 2026-07-17): Resend Inbound delivers at-least-once, so
    // the same reply can arrive twice. The thread-mirror block already dedups
    // on Message-Id; the buyer-arm sends (escalation email + one machine
    // objection reply + Telegram card) did NOT — a retry double-emailed the
    // BUYER and double-carded Ben. Claim the Message-Id once (Redis SET NX EX,
    // fails OPEN if Redis is down — a rare double is better than never sending)
    // before any buyer-arm side effect. Empty Message-Id (rare) skips the claim
    // and behaves as before.
    let buyerArmClaimed = true;
    {
      const midForClaim = String(
        (headers as any)?.['message-id'] ||
          (headers as any)?.['Message-Id'] ||
          (headers as any)?.['Message-ID'] ||
          '',
      ).trim();
      if (isBuyer && classification.sentiment !== 'blocking' && !saysStop && midForClaim) {
        try {
          const { claimOnce } = await import('@/lib/rancherCapacity');
          buyerArmClaimed = await claimOnce(`buyer-arm:${midForClaim}`, 3 * 24 * 60 * 60);
        } catch {
          buyerArmClaimed = true; // fail open
        }
      }
    }

    if (isBuyer && classification.sentiment !== 'blocking' && !saysStop && buyerArmClaimed) {
      // Resolve buyer context (best-effort — every field degrades gracefully).
      const ctx: import('@/lib/buyerReplyTemplates').BuyerReplyContext = {};
      const signals: import('@/lib/buyerEscalation').IntentSignals = {};
      // A transient Airtable failure reading the referral must NOT be
      // mistaken for "no deposit paid" — that would mis-tier a PAID customer
      // to 'warm' and email them a "let's lock it in" pitch (audit 2026-07-17).
      // Track whether we actually READ the deal record; the escalation send is
      // suppressed when we couldn't.
      let referralReadOk = !links.referralId; // no referral → nothing to read
      try {
        const { getRecordById, TABLES } = await import('@/lib/airtable');
        if (links.consumerId) {
          const c: any = await getRecordById(TABLES.CONSUMERS, links.consumerId).catch(() => null);
          if (c) {
            ctx.firstName = String(c['Name'] || c['First Name'] || '').trim();
            ctx.state = String(c['State'] || '').trim();
            // Qualified At + Response Ack At live on the CONSUMER, not the
            // Referral (verified: app/api/qualify writes them to consumer;
            // Response Ack At field is Consumers fldFjOCvy8v0ZVQNh). Reading
            // them off the referral would always see blank → warm tier.
            signals.qualifiedAt = String(c['Qualified At'] || '');
            signals.responseAckAt = String(c['Response Ack At'] || '');
          }
        }
        if (links.rancherId) {
          const r: any = await getRecordById(TABLES.RANCHERS, links.rancherId).catch(() => null);
          if (r) ctx.rancherName = String(r['Ranch Name'] || r['Name'] || '').trim();
        }
        if (links.referralId) {
          const ref: any = await getRecordById(TABLES.REFERRALS, links.referralId).catch(() => null);
          if (ref) {
            referralReadOk = true;
            // Deposit stamps live on the REFERRAL (the deal record).
            signals.referralStatus = String(ref['Status'] || ref['Referral Status'] || '');
            signals.depositLinkOpenedAt = String(ref['Deposit Link Opened At'] || '');
            signals.depositPaidAt = String(ref['Deposit Paid At'] || '');
            // Populate the buyer's REAL deposit link (the "fastest path to
            // purchase" the arm is designed around — was never set, so every
            // CTA fell back to the cal link; audit 2026-07-16). Needs a member
            // magic link so the buyer lands authed on the deposit page. Only
            // for a deposit-capable, not-yet-paid referral.
            const buyerEmailForLink = String(ref['Buyer Email'] || '').toLowerCase().trim();
            // Order Type is stored as a LABEL ('Half Cow' / 'Quarter Cow');
            // the deposit page matches the lowercase SLUG ('quarter'|'half'|
            // 'whole'). Extract the slug or the deep-link silently defaults to
            // 'half' and a quarter/whole buyer lands on the wrong cut (audit
            // 2026-07-17).
            const cutLabel = String(ref['Order Type'] || ref['Cut'] || '').toLowerCase();
            const cutSlug = cutLabel.includes('quarter')
              ? 'quarter'
              : cutLabel.includes('whole')
                ? 'whole'
                : cutLabel.includes('half')
                  ? 'half'
                  : '';
            if (links.consumerId && buyerEmailForLink && !signals.depositPaidAt && cutSlug) {
              try {
                const { generateMemberLoginToken } = await import('@/lib/secrets');
                const { depositPathFor } = await import('@/lib/reserveDeposit');
                const token = generateMemberLoginToken(links.consumerId, buyerEmailForLink);
                const next = depositPathFor(links.referralId, cutSlug as any);
                const site = process.env.SITE_URL || process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';
                ctx.depositUrl = `${site}/api/auth/member/verify?token=${token}&next=${encodeURIComponent(next)}`;
              } catch (e: any) {
                console.warn('[buyer-arm] deposit link mint failed:', e?.message);
              }
            }
          }
        }
      } catch (e: any) {
        console.warn('[buyer-arm] context resolve failed:', e?.message);
      }
      try {
        const { getOperatorBookingUrl } = await import('@/lib/calBooking');
        ctx.calLink = (await getOperatorBookingUrl('sales').catch(() => '')) || '';
      } catch {}

      const emailMessageId = String(
        (headers as any)?.['message-id'] || (headers as any)?.['Message-Id'] || (headers as any)?.['Message-ID'] || '',
      );

      if (classification.objectionCategory === 'ready-to-buy') {
        // ESCALATE: the machine never talks a ready buyer out of buying. Send
        // the fastest path to purchase and hand Ben a tiered hot-lead card.
        const { readinessTier, tierEmoji, readyToBuyEmail } = await import('@/lib/buyerEscalation');
        const { autoRespondMode } = await import('@/lib/autoRespond');
        const tier = readinessTier(signals);
        const mail = readyToBuyEmail(ctx, tier);
        // Respect the same dial: when BUYER_AUTORESPOND=off nothing auto-sends,
        // Ben just gets the hot card and reaches out himself. assisted/auto
        // both send the fast path (a ready buyer should never wait).
        // referralReadOk gate: if we have a referral but couldn't READ it, the
        // tier may be wrong (a paid customer could read as warm) — do NOT
        // auto-send the wrong pitch; Ben still gets the card (audit 2026-07-17).
        let sent = false;
        if (autoRespondMode() !== 'off' && referralReadOk) {
          try {
            const { sendEmail } = await import('@/lib/email');
            await sendEmail({
              to: from,
              subject: mail.subject,
              html: `<p>${mail.text.replace(/\n/g, '<br>')}</p>`,
              ...(emailMessageId ? { headers: { 'In-Reply-To': emailMessageId, References: emailMessageId } } : {}),
            } as any);
            sent = true;
          } catch (e: any) {
            console.warn('[buyer-arm] ready-to-buy send failed:', e?.message);
          }
        }
        escalation = { tier, sent };
        try {
          const { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } = await import('@/lib/telegram');
          // Escape all interpolated values — `from` (buyer-controlled display
          // name), rancherName, and the Haiku summary could otherwise inject
          // live HTML/links into Ben's operator card (parse_mode=HTML). Audit.
          const h = (s: string) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          await sendTelegramMessage(
            TELEGRAM_ADMIN_CHAT_ID,
            `${tierEmoji(tier)} <b>READY TO BUY — ${tier.toUpperCase()}</b>\n\n` +
              `<b>From:</b> ${h(String(from).slice(0, 100))}\n` +
              (ctx.rancherName ? `<b>Rancher:</b> ${h(ctx.rancherName)}\n` : '') +
              (links.referralId ? `<b>Referral:</b> <code>${h(links.referralId)}</code>\n` : '') +
              `<i>${h(classification.summary)}</i>\n\n` +
              (sent ? 'sent them the fastest path to purchase. call them now.' : '⚠️ path-to-purchase email failed — reach out by hand.'),
          );
        } catch {}
      } else {
        // ANSWER: template reply for a handled objection (assisted or auto).
        const { maybeAutoRespond } = await import('@/lib/autoRespond');
        autoRespondResult = await maybeAutoRespond({
          to: from,
          subject,
          category: classification.objectionCategory,
          ctx,
          inReplyTo: emailMessageId || undefined,
        });
        if (autoRespondResult?.staged && autoRespondResult.draft) {
          stagedReplyDraft = autoRespondResult.draft;
        }
      }
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
    // Buyer-arm staging: an assisted-mode template answer is stored on the row
    // so Ben (or a console one-tap) can send it. Fields are optional — if the
    // Conversations table doesn't have them yet, Airtable ignores unknown keys
    // only when typecast is off; createRecord here tolerates their absence.
    if (stagedReplyDraft) {
      row['Staged Reply'] = stagedReplyDraft;
      row['Reply Status'] = autoRespondResult?.sent ? 'sent' : 'staged';
    } else if (autoRespondResult?.sent) {
      row['Reply Status'] = 'auto-sent';
    } else if (escalation) {
      row['Reply Status'] = escalation.sent ? 'escalated (path sent)' : 'escalated';
    }
    if (links.referralId) row['Linked Referral'] = [links.referralId];
    if (links.consumerId) row['Linked Consumer'] = [links.consumerId];
    if (links.rancherId) row['Linked Rancher'] = [links.rancherId];

    let conversationId: string | null = null;
    try {
      const created = await createRecord(CONVERSATIONS_TABLE, row);
      conversationId = (created as any)?.id || null;
    } catch (e: any) {
      // The Staged Reply / Reply Status fields may not exist on the table yet
      // (buyer-arm additions). Rather than lose the whole conversation log to
      // a 422 on unknown fields, retry once without them.
      if (/unknown field|Staged Reply|Reply Status|422/i.test(String(e?.message || ''))) {
        const { ['Staged Reply']: _sr, ['Reply Status']: _rs, ...safe } = row as any;
        try {
          const created = await createRecord(CONVERSATIONS_TABLE, safe);
          conversationId = (created as any)?.id || null;
        } catch (e2: any) {
          console.warn(`[resend-inbound] ${CONVERSATIONS_TABLE} unavailable:`, e2?.message || e2);
        }
      } else {
        // Graceful: table doesn't exist yet. Telegram still fires below.
        console.warn(`[resend-inbound] ${CONVERSATIONS_TABLE} unavailable:`, e?.message || e);
      }
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

        // Resolve sender deterministically. AI may classify senderType='unknown'
        // for short/ambiguous replies. Don't let that silently SKIP stamping
        // (prior bug: chasup cron then auto-killed the lead, e.g. Ashcraft 2026-05-20).
        // Fall back to matching `from` against the rancher/buyer email on the
        // referral record. If we still can't decide, stamp Last Buyer Activity At
        // as the safe default — over-stamping buyer activity is harmless,
        // under-stamping rancher activity kills leads.
        let effectiveSenderType: 'rancher' | 'buyer' | 'unknown' = classification.senderType as any;
        // A From-email match resolved this referral via the buyer's own address,
        // so the sender is definitively the buyer — don't trust a shaky AI read.
        if (matchedByFromEmail) effectiveSenderType = 'buyer';
        if (effectiveSenderType === 'unknown' || !effectiveSenderType) {
          try {
            const { getRecordById, TABLES } = await import('@/lib/airtable');
            const refRow: any = await getRecordById(TABLES.REFERRALS, links.referralId);
            const buyerEmail = String(refRow?.['Buyer Email'] || '').toLowerCase().trim();
            const rancherIds: string[] = refRow?.['Rancher'] || refRow?.['Suggested Rancher'] || [];
            const rancherId = Array.isArray(rancherIds) ? rancherIds[0] : null;
            let rancherEmail = '';
            if (rancherId) {
              const rancherRow: any = await getRecordById(TABLES.RANCHERS, rancherId);
              rancherEmail = String(rancherRow?.['Email'] || '').toLowerCase().trim();
            }
            const fromLower = String(from || '').toLowerCase().trim();
            // Robust match: extract bare address from "Name <addr@host>"
            const addrMatch = fromLower.match(/<([^>]+)>/);
            const fromAddr = addrMatch ? addrMatch[1] : fromLower;
            if (rancherEmail && fromAddr.includes(rancherEmail)) {
              effectiveSenderType = 'rancher';
            } else if (buyerEmail && fromAddr.includes(buyerEmail)) {
              effectiveSenderType = 'buyer';
            } else {
              effectiveSenderType = 'buyer'; // safe default — chasup uses both stamps
            }
          } catch (lookupErr: any) {
            console.warn('[resend-inbound] sender resolve fallback failed:', lookupErr?.message);
            effectiveSenderType = 'buyer';
          }
        }

        if (effectiveSenderType === 'rancher') {
          refUpdates['Last Rancher Activity At'] = now;
          refUpdates['Rancher Engaged Flag'] = true;
          // NRD-6 (2026-06-05): rancher engagement after deposit lands ==
          // implicit acceptance. Load the existing referral, and if Deposit
          // Paid At is set AND Rancher Accepted At is blank, auto-stamp
          // accepted now. Real-world rancher behavior: they read the intro
          // email, reply with "great, looking forward to processing!" —
          // that IS the commitment. The explicit Accept button covers the
          // case where the rancher hasn't replied yet but is ready to lock.
          try {
            const { getRecordById, updateRecord, TABLES } = await import('@/lib/airtable');
            const existingRef: any = await getRecordById(TABLES.REFERRALS, links.referralId);
            if (existingRef?.['Deposit Paid At'] && !existingRef?.['Rancher Accepted At']) {
              refUpdates['Rancher Accepted At'] = now;
              refUpdates['Notes'] = `[NRD-auto-accept ${now.slice(0, 16)}] Rancher engaged via reply after deposit. Auto-stamped. ${String(existingRef['Notes'] || '')}`.slice(0, 2000);
              // Fire-and-forget Telegram so operator sees the auto-accept.
              try {
                const { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } = await import('@/lib/telegram');
                await sendTelegramMessage(
                  TELEGRAM_ADMIN_CHAT_ID,
                  `🔒 <b>AUTO-ACCEPT (NRD-6)</b>\n\nReferral: <code>${links.referralId}</code>\nRancher replied after deposit. Slot now locked non-refundable.`,
                );
              } catch {}
            }
          } catch (e: any) {
            console.warn('[NRD-6 auto-accept] lookup failed:', e?.message);
          }
        } else {
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

    // ── THREAD ROUTING ─────────────────────────────────────────────────────
    // If the inbound was tagged with thread-<id>@replies, post the body into
    // the thread so it appears in both the buyer's /checkout/<refId>/ask page
    // and the rancher's /rancher/inbox dashboard. Idempotent on Message-Id
    // header so Resend webhook retries don't double-write.
    if (links.threadId) {
      try {
        const { postMessage } = await import('@/lib/contracts/threads');
        // Determine sender: match `from` against buyer + rancher emails.
        let senderType: 'buyer' | 'rancher' | 'admin' = 'admin';
        let senderId = '';
        const { getRecordById, TABLES } = await import('@/lib/airtable');
        let buyerEmail = '';
        let rancherEmail = '';
        if (links.consumerId) {
          try {
            const b: any = await getRecordById(TABLES.CONSUMERS, links.consumerId);
            buyerEmail = String(b?.['Email'] || '').toLowerCase().trim();
          } catch {}
        }
        if (links.rancherId) {
          try {
            const r: any = await getRecordById(TABLES.RANCHERS, links.rancherId);
            rancherEmail = String(r?.['Email'] || '').toLowerCase().trim();
          } catch {}
        }
        const fromLower = String(from || '').toLowerCase().trim();
        const addrMatch = fromLower.match(/<([^>]+)>/);
        const fromAddr = addrMatch ? addrMatch[1] : fromLower;
        if (buyerEmail && fromAddr.includes(buyerEmail)) {
          senderType = 'buyer';
          senderId = links.consumerId || '';
        } else if (rancherEmail && fromAddr.includes(rancherEmail)) {
          senderType = 'rancher';
          senderId = links.rancherId || '';
        }

        const emailMessageId = String(
          (headers as any)?.['message-id'] ||
          (headers as any)?.['Message-Id'] ||
          (headers as any)?.['Message-ID'] ||
          '',
        );

        await postMessage({
          threadId: links.threadId,
          senderType,
          senderId,
          body: bodyForClassify.slice(0, 5000),
          sentVia: 'email',
          emailMessageId,
        });

        // Telegram visibility — operator sees every thread message inbound so
        // they can intervene if a deal gets stuck in a back-and-forth. Mute
        // by ignoring 'system' senders. Dedupe via Message-Id so Resend
        // webhook retries don't double-ping.
        try {
          const { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } = await import('@/lib/telegram');
          const senderEmoji = senderType === 'buyer' ? '👤' : senderType === 'rancher' ? '🤠' : '📨';
          const truncated = bodyForClassify.length > 300
            ? bodyForClassify.slice(0, 300) + '…'
            : bodyForClassify;
          const safeBody = truncated
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
          await sendTelegramMessage(
            TELEGRAM_ADMIN_CHAT_ID,
            `💬 <b>Thread message</b> ${senderEmoji}\n\n` +
            `<b>From:</b> ${String(from || '').slice(0, 100)}\n` +
            `<b>Thread:</b> <code>${links.threadId}</code>` +
            (links.referralId ? `\n<b>Referral:</b> <code>${links.referralId}</code>` : '') +
            `\n\n<i>${safeBody}</i>`,
          );
        } catch (telErr: any) {
          console.warn('[resend-inbound] thread Telegram alert failed:', telErr?.message);
        }
      } catch (e: any) {
        console.warn('[resend-inbound] thread message post failed:', e?.message);
      }
    }

    // Audit log — every inbound capture is auditable
    try {
      await logAuditEntry({
        actor: 'cron',
        tool: 'resend-inbound',
        targetType: links.threadId ? 'Thread' : links.referralId ? 'Referral' : links.consumerId ? 'Consumer' : links.rancherId ? 'Rancher' : 'Other',
        targetId: links.threadId || links.referralId || links.consumerId || links.rancherId || 'unknown',
        args: { from, to, subject, hadContext: !!context, matchedByFromEmail },
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

      // Buyer-arm status line. A ready-to-buy escalation already fired its own
      // hot card above, so keep this one quiet for that case.
      const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const autoReplyLine = escalation
        ? '' // escalation card already sent
        : autoRespondResult?.staged && autoRespondResult.draft
        ? `\n\n✏️ <b>Machine drafted a reply (staged):</b>\n<i>${esc(autoRespondResult.draft).slice(0, 500)}</i>\n(one-tap Send in the console, or send it yourself)`
        : autoRespondResult?.sent
        ? '\n🤖 Machine auto-answered the buyer.'
        : autoRespondResult && autoRespondResult.handled === false
        ? '' // nothing the machine handles — normal ben-eyes flow
        : autoRespondResult?.reason
        ? `\n⚠️ Auto-answer skipped: ${autoRespondResult.reason}`
        : '';

      // Escape all interpolated values (from/subject/summary are attacker- or
      // AI-influenced) — same HTML-injection class as the escalation card. Audit.
      const msg =
        `${senderEmoji} <b>Inbound reply</b> ${sentimentEmoji}\n\n` +
        `<b>From:</b> ${esc(from)}\n` +
        `<b>Subject:</b> ${esc(subject)}\n` +
        (context ? `<b>Threaded to:</b> ${esc(context.type)}=${esc(context.recordId)}\n` : `<b>No thread:</b> reply hit catch-all\n`) +
        `<b>Category:</b> ${esc(classification.objectionCategory)}\n\n` +
        `<i>${esc(classification.summary)}</i>` +
        actionLine +
        autoReplyLine +
        // Silent stamp failure is the one partial-failure Ben could mistake
        // for "handled" — say it out loud so he can halt follow-ups by hand.
        (prospectStampFailed
          ? '\n\n🚨 <b>PROSPECT STAMP FAILED</b> — reply seen but NOT recorded on the prospect row: follow-ups did not halt and the booking brain will not pick this up. Open the cockpit and mark this prospect Replied by hand.'
          : '') +
        (prospectFromMismatch
          ? '\n\n⚠️ Sender address differs from the prospect email on file — could be their other inbox, could be a forgery. Confirm identity before booking; autobook is blocked for this reply.'
          : '');

      // Inline buttons. A staged buyer reply gets a one-tap Send (buyer sales
      // arm). Otherwise a propose-close-won gets the close buttons.
      const inlineKeyboard =
        stagedReplyDraft && conversationId
          ? {
              inline_keyboard: [
                [{ text: '📧 Send this reply', callback_data: `bsend_${conversationId}` }],
              ],
            }
          : classification.actionNeeded === 'propose-close-won' && links.referralId
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
        // ONE-INBOX (2026-07-08): the forward is a WORKING copy, not a
        // notification — replyTo points at the original sender so hitting
        // reply in the admin inbox goes straight to the buyer/rancher
        // (previously it looped back to the platform's reply-catch domain),
        // and the subject stays clean so the human never sees our triage
        // tag. Triage metadata lives in the context block below.
        await sendEmail({
          to: ADMIN_EMAIL_FOR_FORWARD,
          replyTo: from,
          subject: `Re: ${subject}`,
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
    // 2026-06-09 P0 fix: was status 500. Resend retries on 500 → loop on
    // transient bugs. Return 200 so retry pressure clears + log to ops.
    console.error('[resend-inbound] error:', error);
    return NextResponse.json({ ok: false, error: error?.message }, { status: 200 });
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
