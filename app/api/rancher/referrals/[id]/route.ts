import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getRecordById, updateRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendTelegramUpdate } from '@/lib/telegram';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-member-secret-change-me';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const cookieStore = await cookies();
    const sessionCookie = cookieStore.get('bhc-rancher-auth');

    if (!sessionCookie?.value) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    let decoded: any;
    try {
      decoded = jwt.verify(sessionCookie.value, JWT_SECRET);
    } catch {
      return NextResponse.json({ error: 'Session expired' }, { status: 401 });
    }

    if (decoded.type !== 'rancher-session') {
      return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
    }

    const { id } = await params;
    const body = await request.json();
    const { status, saleAmount, notes } = body;

    // Verify this referral belongs to this rancher
    const referral = await getRecordById(TABLES.REFERRALS, id) as any;
    if (!referral) {
      return NextResponse.json({ error: 'Referral not found' }, { status: 404 });
    }

    const assignedIds = referral['Rancher'] || [];
    const suggestedIds = referral['Suggested Rancher'] || [];
    const isOwner = (Array.isArray(assignedIds) && assignedIds.includes(decoded.rancherId)) ||
                    (Array.isArray(suggestedIds) && suggestedIds.includes(decoded.rancherId));

    if (!isOwner) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const fields: Record<string, any> = {};

    // Ranchers can update to these statuses
    const allowedStatuses = ['Rancher Contacted', 'Negotiation', 'Closed Won', 'Closed Lost'];
    if (status && allowedStatuses.includes(status)) {
      fields['Status'] = status;

      if (status === 'Closed Won' || status === 'Closed Lost') {
        fields['Closed At'] = new Date().toISOString();

        // Decrement active referral count
        try {
          const rancher = await getRecordById(TABLES.RANCHERS, decoded.rancherId) as any;
          const currentCount = rancher['Current Active Referrals'] || 0;
          await updateRecord(TABLES.RANCHERS, decoded.rancherId, {
            'Current Active Referrals': Math.max(0, currentCount - 1),
          });
        } catch (e) {
          console.error('Error updating rancher referral count:', e);
        }
      }
    }

    if (saleAmount !== undefined && saleAmount > 0) {
      fields['Sale Amount'] = saleAmount;
      fields['Commission Due'] = Math.round(saleAmount * 0.10 * 100) / 100;
    }

    if (notes !== undefined) {
      fields['Notes'] = notes;
    }

    if (Object.keys(fields).length === 0) {
      return NextResponse.json({ error: 'No valid updates provided' }, { status: 400 });
    }

    await updateRecord(TABLES.REFERRALS, id, fields);

    // Notify admin via Telegram
    try {
      const buyerName = referral['Buyer Name'] || 'Unknown';
      if (status === 'Closed Won') {
        await sendTelegramUpdate(
          `<b>DEAL CLOSED</b>\n\n${decoded.name} closed a deal with ${buyerName}\nSale: $${saleAmount || 0}\nCommission: $${Math.round((saleAmount || 0) * 0.10 * 100) / 100}`
        );
      } else if (status) {
        await sendTelegramUpdate(
          `${decoded.name} updated referral for ${buyerName} to: <b>${status}</b>`
        );
      }
    } catch (e) {
      console.error('Telegram notification error:', e);
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Rancher referral update error:', error);
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}
