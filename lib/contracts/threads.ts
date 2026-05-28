// Threads — shared by Buyer + Rancher verticals via this contract.
// Each thread: one buyer ↔ one rancher, scoped to a referral. Both verticals
// post messages via postMessage(); neither imports the other's pages.
//
// Email mirror: when a message posts, the calling route emails the OTHER side
// with a Reply-To of thread-<id>@replies.<domain>. Inbound replies hit
// /api/webhooks/resend-inbound which routes back into the thread via the
// `thread-` reply tag (Task 10 wires the inbound side).

import { createRecord, updateRecord, getAllRecords } from '@/lib/airtable';

export type SenderType = 'buyer' | 'rancher' | 'admin' | 'system';
export type SendVia = 'web' | 'email' | 'telegram';

export interface ThreadCreateInput {
  referralId: string;
  buyerId: string;
  rancherId: string;
  subject: string;
}

export interface MessageInput {
  threadId: string;
  senderType: SenderType;
  senderId: string;
  body: string;
  sentVia: SendVia;
  emailMessageId?: string;
}

export const THREADS_TABLE = 'Threads';
export const MESSAGES_TABLE = 'Thread Messages';

export async function createThread(input: ThreadCreateInput): Promise<{ id: string }> {
  const created: any = await createRecord(THREADS_TABLE, {
    'Referral': [input.referralId],
    'Buyer': [input.buyerId],
    'Rancher': [input.rancherId],
    'Subject': input.subject,
    'Created At': new Date().toISOString(),
    'Last Message At': new Date().toISOString(),
    'Status': 'Active',
  });
  return { id: created.id };
}

export async function getOrCreateThreadForReferral(
  refId: string,
  buyerId: string,
  rancherId: string,
): Promise<{ id: string; isNew: boolean }> {
  const safeId = refId.replace(/"/g, '\\"');
  const existing: any[] = await getAllRecords(
    THREADS_TABLE,
    `SEARCH("${safeId}", ARRAYJOIN({Referral}))`
  );
  if (existing.length > 0) {
    return { id: existing[0].id, isNew: false };
  }
  const { id } = await createThread({
    referralId: refId,
    buyerId,
    rancherId,
    subject: 'Pre-purchase questions',
  });
  return { id, isNew: true };
}

export async function postMessage(input: MessageInput): Promise<{ id: string }> {
  // Idempotency on inbound email: if emailMessageId matches existing message,
  // no-op. Prevents Resend retries from creating duplicate Thread Messages.
  if (input.emailMessageId) {
    const safeMsgId = input.emailMessageId.replace(/"/g, '\\"');
    const existing: any[] = await getAllRecords(
      MESSAGES_TABLE,
      `{Email Message Id} = "${safeMsgId}"`
    );
    if (existing.length > 0) return { id: existing[0].id };
  }
  const created: any = await createRecord(MESSAGES_TABLE, {
    'Thread': [input.threadId],
    'Sender Type': input.senderType,
    'Sender Id': input.senderId,
    'Body': input.body.slice(0, 5000),
    'Sent Via': input.sentVia,
    'Created At': new Date().toISOString(),
    'Email Message Id': input.emailMessageId || '',
  });
  // Bump thread's Last Message At so inbox sort stays accurate.
  try {
    await updateRecord(THREADS_TABLE, input.threadId, {
      'Last Message At': new Date().toISOString(),
    });
  } catch (e: any) {
    console.warn('[contracts.postMessage] Last Message At bump failed (non-fatal):', e?.message);
  }
  return { id: created.id };
}

export async function listThreadMessages(threadId: string): Promise<any[]> {
  const safeId = threadId.replace(/"/g, '\\"');
  const rows: any[] = await getAllRecords(
    MESSAGES_TABLE,
    `SEARCH("${safeId}", ARRAYJOIN({Thread}))`
  );
  // Sort ascending by Created At so the UI renders chronologically.
  rows.sort((a, b) => new Date(a['Created At']).getTime() - new Date(b['Created At']).getTime());
  return rows;
}
