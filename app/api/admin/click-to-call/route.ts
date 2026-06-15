// app/api/admin/click-to-call/route.ts
//
// F11 — Admin clicks "Call" on a Consumer card. Returns call SID.

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';
import { getRecordById, TABLES } from '@/lib/airtable';
import { initiateCall, isClickToCallEnabled } from '@/lib/clickToCall';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const a = await requireAdmin(req);
  if (a) return a;

  if (!isClickToCallEnabled()) {
    return NextResponse.json({ ok: false, error: 'feature disabled' }, { status: 404 });
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }

  const consumerId = String(body?.consumerId || '');
  if (!consumerId) {
    return NextResponse.json({ ok: false, error: 'missing consumerId' }, { status: 400 });
  }

  const consumer = await getRecordById(TABLES.CONSUMERS, consumerId).catch(() => null);
  if (!consumer) {
    return NextResponse.json({ ok: false, error: 'consumer not found' }, { status: 404 });
  }

  const phone = String((consumer as any)['Phone'] || '');
  if (!phone) {
    return NextResponse.json({ ok: false, error: 'consumer has no phone' }, { status: 400 });
  }

  const result = await initiateCall({
    buyerPhone: phone,
    buyerName: String((consumer as any)['Full Name'] || 'buyer'),
    consumerId,
  });

  if (!result) {
    return NextResponse.json({ ok: false, error: 'call initiate failed' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, callSid: result.callSid });
}
