// Rancher inbox API — lists Threads where this rancher is linked, sorted by
// Last Message At desc, with the latest message body + sender type preview.

import { NextResponse } from 'next/server';
import { getAllRecords, getRecordById, TABLES } from '@/lib/airtable';
import { THREADS_TABLE, MESSAGES_TABLE } from '@/lib/contracts/threads';
import { requireRancher } from '@/lib/rancherAuth';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(req: Request) {
  // Auth Phase 2: requireRancher routes through Clerk or legacy JWT.
  const r = await requireRancher(req);
  if (r instanceof NextResponse) return r;
  const { session } = r;

  const safeId = session.rancherId.replace(/"/g, '\\"');
  const threads: any[] = await getAllRecords(THREADS_TABLE, `SEARCH("${safeId}", ARRAYJOIN({Rancher}))`);
  threads.sort((a: any, b: any) => new Date(b['Last Message At'] || 0).getTime() - new Date(a['Last Message At'] || 0).getTime());

  // For each thread, fetch the latest message preview + buyer name.
  const enriched = await Promise.all(
    threads.slice(0, 50).map(async (t: any) => {
      const safeT = t.id.replace(/"/g, '\\"');
      let lastMessage = '';
      let lastSenderType = '';
      let messageCount = 0;
      let unreadFromBuyer = false;
      try {
        const msgs: any[] = await getAllRecords(MESSAGES_TABLE, `SEARCH("${safeT}", ARRAYJOIN({Thread}))`);
        msgs.sort((a: any, b: any) => new Date(b['Created At']).getTime() - new Date(a['Created At']).getTime());
        messageCount = msgs.length;
        if (msgs[0]) {
          lastMessage = String(msgs[0]['Body'] || '').slice(0, 200);
          lastSenderType = String(msgs[0]['Sender Type'] || '');
        }
        unreadFromBuyer = lastSenderType === 'buyer';
      } catch (e: any) {
        console.warn('[rancher inbox] message fetch failed:', t.id, e?.message);
      }

      // Buyer display name.
      let buyerName = '';
      const buyerIds: string[] = t['Buyer'] || [];
      if (buyerIds[0]) {
        try {
          const b: any = await getRecordById(TABLES.CONSUMERS, buyerIds[0]);
          buyerName = b?.['Full Name'] || b?.['Email'] || '';
        } catch {}
      }

      return {
        id: t.id,
        subject: t['Subject'] || 'Pre-purchase questions',
        lastMessageAt: t['Last Message At'] || t['Created At'] || null,
        lastMessage,
        lastSenderType,
        messageCount,
        unreadFromBuyer,
        buyerId: buyerIds[0] || null,
        buyerName,
        status: t['Status'] || 'Active',
      };
    }),
  );

  return NextResponse.json({ threads: enriched });
}
