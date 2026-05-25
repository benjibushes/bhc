// Thread message API — GET lists messages, POST creates one.
//
// Auth: accepts BOTH buyer-session (Consumers JWT) AND rancher-session
// (Ranchers JWT). The thread's Buyer + Rancher links determine which side
// the authenticated party is on; sender id + sender type are stamped onto
// the message accordingly.
//
// Email mirror: every POST also sends an email to the OTHER side with a
// Reply-To of thread-<id>@replies.<domain>. Inbound replies hit
// /api/webhooks/resend-inbound which routes back into the thread via the
// `thread-` reply tag (Task 10).

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';
import { postMessage, listThreadMessages, THREADS_TABLE } from '@/lib/contracts/threads';
import { getRecordById, TABLES } from '@/lib/airtable';
import { JWT_SECRET } from '@/lib/secrets';
import { sendEmail } from '@/lib/email';
import { rateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type AuthInfo =
  | { kind: 'buyer'; id: string; name: string; email: string }
  | { kind: 'rancher'; id: string; name: string; email: string };

async function authBuyerOrRancher(): Promise<AuthInfo | null> {
  const ck = await cookies();
  const buyerCk = ck.get('bhc-member-auth');
  if (buyerCk?.value) {
    try {
      const d: any = jwt.verify(buyerCk.value, JWT_SECRET);
      if (d.type === 'member-session') {
        return {
          kind: 'buyer',
          id: d.consumerId,
          name: d.name || '',
          email: d.email || '',
        };
      }
    } catch {}
  }
  const rancherCk = ck.get('bhc-rancher-auth');
  if (rancherCk?.value) {
    try {
      const d: any = jwt.verify(rancherCk.value, JWT_SECRET);
      if (d.type === 'rancher-session') {
        return {
          kind: 'rancher',
          id: d.rancherId,
          name: d.name || '',
          email: d.email || '',
        };
      }
    } catch {}
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

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authBuyerOrRancher();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const own = await assertThreadOwnership(id, auth);
  if (!own.ok) return NextResponse.json({ error: own.error }, { status: own.error === 'Forbidden' ? 403 : 404 });
  const messages = await listThreadMessages(id);
  return NextResponse.json({ messages });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authBuyerOrRancher();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

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

  const { id } = await params;
  const own = await assertThreadOwnership(id, auth);
  if (!own.ok) return NextResponse.json({ error: own.error }, { status: own.error === 'Forbidden' ? 403 : 404 });
  const thread = own.thread!;

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
        await sendEmail({
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
        } as any);
      }
    }
  } catch (e: any) {
    console.warn('[threads message] email mirror failed (non-fatal):', e?.message);
  }

  return NextResponse.json({ ok: true });
}
