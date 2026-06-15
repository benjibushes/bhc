// app/api/admin/referrals/[id]/stage/route.ts
//
// F12 — Admin advances/changes a referral's Status from the desk UI.
// Validates target status against allowed transitions to prevent
// accidental skips (e.g. cant jump Intro Sent → Closed Won).

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';

export const dynamic = 'force-dynamic';

// Allowed stage transitions (canonical advance path).
// Permits any → Closed Lost (manual abandon) by special case.
const ALLOWED: Record<string, string[]> = {
  'Intro Sent': ['Awaiting Payment', 'Closed Lost'],
  'Awaiting Payment': ['Slot Locked', 'Closed Lost'],
  'Slot Locked': ['Closed Won', 'Closed Lost'],
  'Closed Lost': ['Intro Sent'], // revive
};

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const a = await requireAdmin(req);
  if (a) return a;

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ ok: false, error: 'missing id' }, { status: 400 });
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }

  const targetStatus = String(body?.status || '');
  if (!targetStatus) {
    return NextResponse.json({ ok: false, error: 'missing status' }, { status: 400 });
  }

  const referral = await getRecordById(TABLES.REFERRALS, id).catch(() => null);
  if (!referral) {
    return NextResponse.json({ ok: false, error: 'referral not found' }, { status: 404 });
  }

  const currentStatus = String((referral as any)['Status'] || '');
  const allowed = ALLOWED[currentStatus] || [];
  if (!allowed.includes(targetStatus)) {
    return NextResponse.json(
      { ok: false, error: `cannot transition ${currentStatus} → ${targetStatus}` },
      { status: 422 },
    );
  }

  try {
    await updateRecord(TABLES.REFERRALS, id, { Status: targetStatus });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message }, { status: 500 });
  }

  await sendTelegramMessage(
    TELEGRAM_ADMIN_CHAT_ID,
    `📊 <b>Stage advanced</b>\n\nReferral: ${id}\n${currentStatus} → <b>${targetStatus}</b>\nBuyer: ${(referral as any)['Buyer Email'] || '?'}\nRancher: ${(referral as any)['Rancher Name'] || '?'}`
  ).catch(() => {});

  return NextResponse.json({ ok: true, currentStatus: targetStatus });
}
