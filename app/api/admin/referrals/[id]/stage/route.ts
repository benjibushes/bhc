// app/api/admin/referrals/[id]/stage/route.ts
//
// F12 — Admin advances/changes a referral's Status from the desk UI.
// Validates target status against allowed transitions to prevent
// accidental skips (e.g. cant jump Intro Sent → Closed Won).

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
// Allowed stage transitions — canonical advance path, STAMP-aware.
// Data-layer audit P1-1 (2026-08-18): the table used to be a plain
// Status→Status map here, which offered an already-accepted 'Awaiting Payment'
// row 'Slot Locked' (a backward re-accept) instead of the close. The
// send-final-invoice route rewrites Status over the accepted row, so Status
// alone cannot tell the two 'Awaiting Payment' meanings apart — see
// lib/referralStage. The desk button renders nextStageFor() from this same
// table, so the two can never drift.
import { allowedStagesFrom } from '@/lib/referralStage';

export const dynamic = 'force-dynamic';

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
  const allowed = allowedStagesFrom(referral);
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
