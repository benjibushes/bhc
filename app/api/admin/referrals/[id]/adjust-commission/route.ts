import { NextResponse } from 'next/server';
import { updateRecord, getRecordById, TABLES } from '@/lib/airtable';
import { sendTelegramUpdate } from '@/lib/telegram';

// POST /api/admin/referrals/[id]/adjust-commission
// Manually override a closed referral's commission amount (e.g., when a
// rancher disputes the 10% or a one-off discount was negotiated).
// Body: { commissionDue: number, reason?: string }
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const newAmount = Number(body.commissionDue);
    const reason = (body.reason || '').trim();

    if (isNaN(newAmount) || newAmount < 0) {
      return NextResponse.json({ error: 'commissionDue must be a non-negative number' }, { status: 400 });
    }

    const referral: any = await getRecordById(TABLES.REFERRALS, id);
    if (!referral) {
      return NextResponse.json({ error: 'Referral not found' }, { status: 404 });
    }
    if ((referral['Status']?.name || referral['Status']) !== 'Closed Won') {
      return NextResponse.json({ error: 'Can only adjust commission on Closed Won referrals' }, { status: 400 });
    }

    const oldAmount = Number(referral['Commission Due']) || 0;
    const existingNotes = referral['Notes'] || '';
    const stamp = new Date().toISOString().slice(0, 10);
    const note = `[COMMISSION ADJUSTED ${stamp} — $${oldAmount.toFixed(2)} → $${newAmount.toFixed(2)}${reason ? ` — ${reason}` : ''}]`;

    await updateRecord(TABLES.REFERRALS, id, {
      'Commission Due': newAmount,
      'Notes': `${note}\n${existingNotes}`.trim(),
    });

    await sendTelegramUpdate(
      `💰 <b>Commission adjusted</b>: ${referral['Buyer Name']} × ${referral['Suggested Rancher Name']}\n$${oldAmount.toFixed(2)} → <b>$${newAmount.toFixed(2)}</b>${reason ? `\nReason: ${reason}` : ''}`
    ).catch(() => {});

    return NextResponse.json({
      success: true,
      message: `Commission adjusted to $${newAmount.toFixed(2)}`,
      oldAmount,
      newAmount,
    });
  } catch (error: any) {
    console.error('Adjust commission error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
