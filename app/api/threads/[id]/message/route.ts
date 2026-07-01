// Thread message API — GET lists messages, POST creates one.
//
// Auth: accepts buyer-session (Consumers JWT), rancher-session (Ranchers JWT),
// AND — as a strictly-scoped fallback — the referral-scoped deposit-grant
// cookie (campaign 1-tap buyers inside their 48h window). The grant path
// resolves the thread's Referral link FIRST and accepts the grant ONLY when it
// names exactly that referral (depositGrantAuthorizesThread) AND the grant's
// consumer is on the thread's Buyer link. Without it, a grant-only buyer could
// OPEN the thread (the by-referral GET accepts the grant via resolveDepositAuth)
// but hit a silent 401 wall composing. The thread's Buyer + Rancher links
// determine which side the authenticated party is on; sender id + sender type
// are stamped onto the message accordingly.
//
// Email mirror: every POST also sends an email to the OTHER side with a
// Reply-To of thread-<id>@replies.<domain>. Inbound replies hit
// /api/webhooks/resend-inbound which routes back into the thread via the
// `thread-` reply tag (Task 10).

import { NextResponse } from 'next/server';
import { postMessage, listThreadMessages, THREADS_TABLE } from '@/lib/contracts/threads';
import { getRecordById, TABLES } from '@/lib/airtable';
import { sendEmail } from '@/lib/email';
import { rateLimit } from '@/lib/rateLimit';
import { resolveBuyerSession, readDepositGrantPayload } from '@/lib/buyerAuth';
import { resolveRancherSession } from '@/lib/rancherAuth';
import { depositGrantAuthorizesThread } from '@/lib/campaignReserve';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type AuthInfo =
  | { kind: 'buyer'; id: string; name: string; email: string }
  | { kind: 'rancher'; id: string; name: string; email: string };

async function authBuyerOrRancher(req: Request): Promise<AuthInfo | null> {
  const buyer = await resolveBuyerSession(req);
  if (buyer) {
    return {
      kind: 'buyer',
      id: buyer.consumerId,
      name: buyer.name,
      email: buyer.email,
    };
  }
  const rancher = await resolveRancherSession(req);
  if (rancher) {
    return {
      kind: 'rancher',
      id: rancher.rancherId,
      name: rancher.name,
      email: rancher.email,
    };
  }
  return null;
}

async function assertThreadOwnership(threadId: string, auth: AuthInfo): Promise<{ ok: boolean; thread?: any; error?: string }> {
  let thread: any;
  try {
    thread = await getRecordById(THREADS_TABLE, threadId);
  } catch {
    return { ok: false, error: 'Thread not found' };
  }
  if (!thread) return { ok: false, error: 'Thread not found' };
  const linkField = auth.kind === 'buyer' ? 'Buyer' : 'Rancher';
  const ids: string[] = thread[linkField] || [];
  if (!ids.includes(auth.id)) {
    return { ok: false, error: 'Forbidden' };
  }
  return { ok: true, thread };
}

// Deposit-grant fallback for thread-scoped access when NEITHER session
// resolves. The grant is REFERRAL-scoped and this route is THREAD-scoped, so
// the thread's Referral link is resolved first and the grant is accepted ONLY
// when it names exactly that referral (never weakened):
//   - no/invalid grant cookie → 401 (no credential at all)
//   - thread doesn't exist    → 404
//   - valid grant, DIFFERENT referral (or consumer not the thread's buyer) → 403
// The grant JWT is verified locally (readDepositGrantPayload) BEFORE any
// Airtable read, so unauthenticated probes never reach the table.
async function grantThreadAccess(
  req: Request,
  threadId: string,
): Promise<{ auth: AuthInfo; thread: any } | NextResponse> {
  const grant = await readDepositGrantPayload(req);
  if (!grant) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  let thread: any;
  try {
    thread = await getRecordById(THREADS_TABLE, threadId);
  } catch {
    return NextResponse.json({ error: 'Thread not found' }, { status: 404 });
  }
  if (!thread) return NextResponse.json({ error: 'Thread not found' }, { status: 404 });
  // STRICT referral↔thread scope match (pure, tested): a grant for referral A
  // can never act on referral B's thread.
  if (!depositGrantAuthorizesThread(grant.referralId, thread['Referral'])) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  // Same containment as assertThreadOwnership's buyer branch: the grant's
  // consumer must BE the thread's buyer.
  const buyerIds: string[] = thread['Buyer'] || [];
  if (!buyerIds.includes(grant.consumerId)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  // Grant carries only consumerId — name/email stay '' (matches
  // resolveDepositAuth's grant path; nothing in this route needs them).
  return { auth: { kind: 'buyer', id: grant.consumerId, name: '', email: '' }, thread };
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await authBuyerOrRancher(req);
  if (auth) {
    const own = await assertThreadOwnership(id, auth);
    if (!own.ok) return NextResponse.json({ error: own.error }, { status: own.error === 'Forbidden' ? 403 : 404 });
  } else {
    // Grant-only buyer (campaign 1-tap): the ask page refreshes messages via
    // this GET after posting, so read access must match the by-referral GET.
    const granted = await grantThreadAccess(req, id);
    if (granted instanceof NextResponse) return granted;
  }
  const messages = await listThreadMessages(id);
  return NextResponse.json({ messages });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let auth: AuthInfo | null = await authBuyerOrRancher(req);
  let thread: any;

  if (auth) {
    // Rate limit: 10 messages per 60s per sender. Anti-spam guard so a runaway
    // client OR malicious actor can't flood the rancher's inbox. Buyers and
    // ranchers each get their own bucket scoped by sender id.
    const rl = await rateLimit(`threads:msg:${auth.kind}:${auth.id}`, { requests: 10, window: '1m' });
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'Slow down — too many messages. Wait a minute and try again.' },
        { status: 429 },
      );
    }

    const own = await assertThreadOwnership(id, auth);
    if (!own.ok) return NextResponse.json({ error: own.error }, { status: own.error === 'Forbidden' ? 403 : 404 });
    thread = own.thread!;
  } else {
    const granted = await grantThreadAccess(req, id);
    if (granted instanceof NextResponse) return granted;
    auth = granted.auth;
    thread = granted.thread;
    // Same anti-spam budget, same buyer-scoped bucket as the session path —
    // a buyer can't dodge the cap by switching credentials.
    const rl = await rateLimit(`threads:msg:${auth.kind}:${auth.id}`, { requests: 10, window: '1m' });
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'Slow down — too many messages. Wait a minute and try again.' },
        { status: 429 },
      );
    }
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const messageBody = String(body?.body || '').trim();
  if (messageBody.length < 1 || messageBody.length > 5000) {
    return NextResponse.json({ error: 'body must be 1–5000 chars' }, { status: 400 });
  }

  await postMessage({
    threadId: id,
    senderType: auth.kind,
    senderId: auth.id,
    body: messageBody,
    sentVia: 'web',
  });

  // Email mirror to the OTHER side. Reply-To = thread-<id>@replies.<domain>
  // so the inbound webhook routes a reply back into this thread (Task 10).
  // Non-fatal: the message is already persisted; an email send failure
  // shouldn't block the API response.
  try {
    const otherKind: 'buyer' | 'rancher' = auth.kind === 'buyer' ? 'rancher' : 'buyer';
    const recipientLinkField = otherKind === 'rancher' ? 'Rancher' : 'Buyer';
    const recipientIds: string[] = thread[recipientLinkField] || [];
    const recipientId = recipientIds[0];
    if (recipientId) {
      const recipientTable = otherKind === 'rancher' ? TABLES.RANCHERS : TABLES.CONSUMERS;
      const recipient: any = await getRecordById(recipientTable, recipientId);
      const recipientEmail: string = recipient?.['Email'] || '';
      if (recipientEmail) {
        const subjectPrefix = thread['Subject'] || 'BuyHalfCow message';
        const senderLabel = auth.kind === 'buyer' ? 'a buyer' : 'your rancher';
        const mirrorResult = await sendEmail({
          to: recipientEmail,
          subject: `New message — ${subjectPrefix}`,
          html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:36px;border:1px solid #A7A29A;background:#fff;line-height:1.6;color:#0E0E0E">
            <p style="margin:0 0 16px;color:#6B4F3F;font-size:14px;">${senderLabel} just sent you a message:</p>
            <div style="background:#F4F1EC;padding:16px;border-left:3px solid #6B4F3F;margin:16px 0;">
              ${messageBody.replace(/</g, '&lt;').replace(/\n/g, '<br>')}
            </div>
            <p style="margin-top:24px;font-size:12px;color:#A7A29A;">
              Reply to this email to respond. Your reply will land in the BuyHalfCow thread for both of you.
            </p>
          </div>`,
          _replyContext: { type: 'thread' as any, recordId: id } as any,
          // Guard-truth fix (2026-07-01): default 'sendEmail' templateName was
          // frequency-capped — thread notifications silently dropped mid-deal.
          // Whitelisted (customer-expected 1:1 message mirror).
          templateName: 'sendThreadMessageNotification',
        } as any);
        // TRUTH: suppression returns success:false without throwing. The
        // message is persisted in-thread either way, but log honestly so a
        // "rancher never replied" report is debuggable.
        if (!mirrorResult?.success) {
          console.warn(
            `[threads message] email mirror suppressed (${mirrorResult?.reason || 'unknown'}) — recipient not notified by email`,
          );
        }
      }
    }
  } catch (e: any) {
    console.warn('[threads message] email mirror failed (non-fatal):', e?.message);
  }

  return NextResponse.json({ ok: true });
}
