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
  //
  // Wave C (2026-07-14): the mirror used to be the ONLY signal — if the
  // rancher's address was bounced/unsubscribed, guardedSend suppressed
  // without throwing and the route console.warn'd into the void. No push, no
  // operator signal, no polling anywhere reads THREADS — a live buyer typing
  // at the rancher just died. Now: (a) a PWA push rides alongside the email
  // for rancher recipients, (b) a suppressed rancher mirror escalates to the
  // operator so Ben can relay, and (c) the response carries emailMirror
  // status so the composer UI can say the other side wasn't emailed.
  const otherKind: 'buyer' | 'rancher' = auth.kind === 'buyer' ? 'rancher' : 'buyer';
  const recipientLinkField = otherKind === 'rancher' ? 'Rancher' : 'Buyer';
  const recipientIds: string[] = thread[recipientLinkField] || [];
  const recipientId: string | undefined = recipientIds[0];
  let emailMirror: 'sent' | 'suppressed' | 'failed' | 'skipped' = 'skipped';
  try {
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
          emailMirror = 'suppressed';
          console.warn(
            `[threads message] email mirror suppressed (${mirrorResult?.reason || 'unknown'}) — recipient not notified by email`,
          );
          // Wave C: a suppressed RANCHER mirror means a paying-intent buyer's
          // question is going nowhere — escalate so Ben can relay. 24h dedupe
          // per thread so a chatty buyer doesn't storm the channel.
          if (otherKind === 'rancher') {
            try {
              const { sendOperatorSignal } = await import('@/lib/operatorSignal');
              await sendOperatorSignal({
                urgency: 'normal',
                kind: 'system-error',
                summary: `Thread ${id}: rancher email suppressed — buyer message undelivered`,
                detail:
                  `A buyer message in thread ${id} was persisted, but the email mirror to the rancher was ` +
                  `suppressed (${mirrorResult?.reason || 'unknown'}). Unless they have push enabled, the rancher ` +
                  `has no idea the buyer is talking to them — relay it or fix the address.`,
                refs: [{ type: 'rancher', id: recipientId }],
                dedupeKey: `thread-mirror-${id}`,
                dedupeWindowMs: 24 * 60 * 60 * 1000,
              });
            } catch (sigErr: any) {
              console.warn('[threads message] suppression operator signal failed:', sigErr?.message);
            }
          }
        } else {
          emailMirror = 'sent';
        }
      }
    }
  } catch (e: any) {
    emailMirror = 'failed';
    console.warn('[threads message] email mirror failed (non-fatal):', e?.message);
  }

  // Wave C — PWA push alongside the email mirror. The push rail already
  // fires for routed-lead/deposit-paid/product-order but not for a live
  // buyer literally typing at the rancher. Dark-safe + best-effort
  // (sendRancherPush no-ops without VAPID/subscriptions, never throws) and
  // deliberately independent of the email result — when the address is
  // bounced, push may be the only channel left.
  if (otherKind === 'rancher' && recipientId) {
    try {
      const { sendRancherPush } = await import('@/lib/rancherPush');
      await sendRancherPush(recipientId, {
        title: 'new message from your buyer',
        body: messageBody.slice(0, 120),
        url: '/rancher/inbox',
      });
    } catch (pushErr: any) {
      console.warn('[threads message] rancher push skipped (non-fatal):', pushErr?.message);
    }
  }

  // emailMirror lets the composer render an honest thread status ("delivered
  // in-app — email to the other side was blocked") instead of implying the
  // other side was notified when they weren't.
  return NextResponse.json({ ok: true, emailMirror });
}
