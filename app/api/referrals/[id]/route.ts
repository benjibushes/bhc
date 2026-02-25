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
      fields['Status'] = status;

      if (status === 'Closed Won' || status === 'Closed Lost') {
        fields['Closed At'] = new Date().toISOString();

        // Decrement rancher's active referral count
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
      fields['Sale Amount'] = saleAmount;
      fields['Commission Due'] = Math.round(saleAmount * 0.10 * 100) / 100;
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
