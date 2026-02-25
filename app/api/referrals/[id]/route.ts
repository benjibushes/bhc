import { NextResponse } from 'next/server';
import { updateRecord, getRecordById } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { status, saleAmount, commissionPaid, notes } = body;

    const fields: Record<string, any> = {};

    if (status) {
      if (status === 'Closed Won') {
        if (saleAmount === undefined || saleAmount === null || saleAmount <= 0) {
          return NextResponse.json({ error: 'Sale amount is required and must be > $0 for Closed Won' }, { status: 400 });
        }
      }

      fields['Status'] = status;

      if (status === 'Closed Won' || status === 'Closed Lost') {
        fields['Closed At'] = new Date().toISOString();

        try {
          const referral = await getRecordById(TABLES.REFERRALS, id);
          const rancherId = (referral as any)['Rancher']?.[0];
          if (rancherId) {
            const rancher = await getRecordById(TABLES.RANCHERS, rancherId);
            const currentCount = (rancher as any)['Current Active Referrals'] || 0;
            await updateRecord(TABLES.RANCHERS, rancherId, {
              'Current Active Referrals': Math.max(0, currentCount - 1),
            });
          }
        } catch (e) {
          console.error('Error decrementing rancher referrals:', e);
        }
      }
    }

    if (saleAmount !== undefined) {
      const amount = Number(saleAmount);
      if (isNaN(amount) || amount < 0) {
        return NextResponse.json({ error: 'Sale amount must be a positive number' }, { status: 400 });
      }
      const commissionRate = Number(process.env.NEXT_PUBLIC_COMMISSION_RATE || '0.10');
      fields['Sale Amount'] = amount;
      fields['Commission Due'] = Math.round(amount * commissionRate * 100) / 100;
    }

    if (commissionPaid !== undefined) {
      fields['Commission Paid'] = commissionPaid;
    }

    if (notes !== undefined) {
      fields['Notes'] = notes;
    }

    const updated = await updateRecord(TABLES.REFERRALS, id, fields);

    return NextResponse.json({ success: true, referral: updated });
  } catch (error: any) {
    console.error('Error updating referral:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const record = await getRecordById(TABLES.REFERRALS, id);
    return NextResponse.json(record);
  } catch (error: any) {
    console.error('Error fetching referral:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
