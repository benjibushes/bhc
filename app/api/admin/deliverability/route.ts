import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';
import { getAllRecords, TABLES } from '@/lib/airtable';
import { summarizeDeliverability } from '@/lib/deliverabilityStats';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const authResp = await requireAdmin(request);
  if (authResp) return authResp;

  // getAllRecords returns flattened objects: { id, _createdTime, ...fields }
  // summarizeDeliverability expects { fields: Record<string, any> }, so we wrap.
  const wrap = (records: any[]) =>
    records.map((r) => {
      const { id, _createdTime, ...fields } = r;
      return { fields };
    });

  let conversations: any[] = [];
  let consumers: any[] = [];
  let ranchers: any[] = [];

  try {
    conversations = await getAllRecords(TABLES.CONVERSATIONS);
  } catch {
    // Missing Conversations table must not 500 the panel
  }
  try {
    consumers = await getAllRecords(
      TABLES.CONSUMERS,
      'OR({Bounced}=TRUE(),{Complained}=TRUE())',
    );
  } catch {
    // Non-fatal
  }
  try {
    ranchers = await getAllRecords(
      TABLES.RANCHERS,
      'OR({Bounced}=TRUE(),{Complained}=TRUE())',
    );
  } catch {
    // Non-fatal
  }

  const summary = summarizeDeliverability({
    conversations: wrap(conversations),
    suppressed: wrap([...consumers, ...ranchers]),
    nowMs: Date.now(),
  });

  return NextResponse.json({
    ok: true,
    summary,
    inboundConfigured: !!process.env.RESEND_INBOUND_WEBHOOK_SECRET,
    eventsConfigured: !!process.env.RESEND_WEBHOOK_SECRET,
  });
}
