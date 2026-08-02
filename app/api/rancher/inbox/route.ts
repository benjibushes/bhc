// Rancher inbox API — lists Threads where this rancher is linked, sorted by
// Last Message At desc, with the latest message body + sender type preview.

import { NextResponse } from 'next/server';
import { getRecordById, TABLES } from '@/lib/airtable';
import { listThreadsForRancher, listThreadMessages } from '@/lib/contracts/threads';
import { requireRancher } from '@/lib/rancherAuth';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(req: Request) {
  const r = await requireRancher(req);
  if (r instanceof NextResponse) return r;
  const { session } = r;

  // Threads for this rancher — exact-match on the denormalized 'Rancher Id
  // Text' with a full-scan + JS link-id-filter fallback (the old
  // SEARCH/ARRAYJOIN({Rancher}) scan compared the record id against Ranch
  // Name and NEVER matched — the inbox listed zero threads since it shipped).
  //
  // Wave 2 rancher-UX: a TOTAL read failure is a real error, not an empty
  // list. This route used to answer 200-{threads:[]} on any upstream outage,
  // so a rancher whose buyer had just replied saw a confident "no messages."
  // The inbox page renders a couldn't-load + retry state on non-2xx.
  let threads: any[];
  try {
    threads = await listThreadsForRancher(session.rancherId, { throwOnTotalFailure: true });
  } catch (e: any) {
    console.error('[rancher/inbox] threads read failed:', e?.message || e);
    return NextResponse.json(
      { error: "Couldn't load your messages just now — try again in a moment." },
      { status: 503 },
    );
  }
  threads.sort((a: any, b: any) => new Date(b['Last Message At'] || 0).getTime() - new Date(a['Last Message At'] || 0).getTime());

  // For each thread, fetch the latest message preview + buyer name.
  const enriched = await Promise.all(
    threads.slice(0, 50).map(async (t: any) => {
      let lastMessage = '';
      let lastSenderType = '';
      let messageCount = 0;
      let unreadFromBuyer = false;
      // listThreadMessages is never-error (returns [] on failure) and sorts
      // ascending by Created At — the latest message is the LAST element.
      const msgs: any[] = await listThreadMessages(t.id);
      messageCount = msgs.length;
      const latest = msgs[msgs.length - 1];
      if (latest) {
        lastMessage = String(latest['Body'] || '').slice(0, 200);
        lastSenderType = String(latest['Sender Type'] || '');
      }
      unreadFromBuyer = lastSenderType === 'buyer';

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
