import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getRecordById, updateRecord, getAllRecords } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendTelegramUpdate, sendTelegramSaleCelebration } from '@/lib/telegram';
import jwt from 'jsonwebtoken';

export const maxDuration = 60;

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

          const rancherState = rancher['State'] || '';
          const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

          // ── CLOSED LOST: Re-route this buyer to another rancher ──
          if (status === 'Closed Lost') {
            const buyerIds = referral['Buyer'] || [];
            const buyerId = Array.isArray(buyerIds) ? buyerIds[0] : null;
            if (buyerId) {
              try {
                const buyer = await getRecordById(TABLES.CONSUMERS, buyerId) as any;
                if (buyer && buyer['Email']) {
                  // Reset buyer's referral status so matching picks them up
                  await updateRecord(TABLES.CONSUMERS, buyerId, {
                    'Referral Status': 'Unmatched',
                    'Sequence Stage': 'rerouted',
                  });
                  // Re-trigger matching for this specific buyer
                  await fetch(`${SITE_URL}/api/matching/suggest`, {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      ...(process.env.INTERNAL_API_SECRET ? { 'x-internal-secret': process.env.INTERNAL_API_SECRET } : {}),
                    },
                    body: JSON.stringify({
                      buyerState: buyer['State'] || '',
                      buyerId: buyerId,
                      buyerName: buyer['Full Name'] || '',
                      buyerEmail: buyer['Email'],
                      buyerPhone: buyer['Phone'] || '',
                      orderType: buyer['Order Type'] || '',
                      budgetRange: buyer['Budget'] || '',
                      intentScore: buyer['Intent Score'] || 50,
                      intentClassification: buyer['Intent Classification'] || 'Medium',
                      notes: buyer['Notes'] || '',
                    }),
                  });
                }
              } catch (rerouteErr) {
                console.error('Re-route buyer error:', rerouteErr);
              }
            }
          }

          // ── CLOSED WON or LOST: Auto-match waiting consumers to freed-up capacity ──
          if (rancherState) {
            const waiting = await getAllRecords(TABLES.CONSUMERS, `AND({Status} = "Approved", {Referral Status} = "Unmatched", {Segment} = "Beef Buyer", {State} = "${rancherState}")`) as any[];
            const sorted = waiting
              .sort((a, b) => (b['Intent Score'] || 0) - (a['Intent Score'] || 0))
              .slice(0, 3);

            for (const consumer of sorted) {
              try {
                await fetch(`${SITE_URL}/api/matching/suggest`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    ...(process.env.INTERNAL_API_SECRET ? { 'x-internal-secret': process.env.INTERNAL_API_SECRET } : {}),
                  },
                  body: JSON.stringify({
                    buyerState: rancherState,
                    buyerId: consumer.id,
                    buyerName: consumer['Full Name'],
                    buyerEmail: consumer['Email'],
                    buyerPhone: consumer['Phone'],
                    orderType: consumer['Order Type'],
                    budgetRange: consumer['Budget'],
                    intentScore: consumer['Intent Score'],
                    intentClassification: consumer['Intent Classification'],
                    notes: consumer['Notes'],
                  }),
                });
              } catch (autoMatchErr) {
                console.error('Auto-match error:', autoMatchErr);
              }
            }
          }
        } catch (e) {
          console.error('Error updating rancher referral count:', e);
        }
      }
    }

    if (saleAmount !== undefined && saleAmount > 0) {
      fields['Sale Amount'] = saleAmount;
      const commissionRate = Number(process.env.NEXT_PUBLIC_COMMISSION_RATE || '0.10');
      fields['Commission Due'] = Math.round(saleAmount * commissionRate * 100) / 100;
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
        // L2e: pull rancher's win history to show monthly + lifetime + first-sale milestone
        const allRefs = await getAllRecords(TABLES.REFERRALS) as any[];
        const rancherWins = allRefs.filter((r) => {
          if (r['Status'] !== 'Closed Won') return false;
          const ids = r['Rancher'] || r['Suggested Rancher'] || [];
          return Array.isArray(ids) && ids.includes(decoded.rancherId);
        });
        // The current referral is already updated above, so it's in rancherWins
        const isFirstSaleForRancher = rancherWins.length === 1;
        const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
        const monthlyWinsForRancher = rancherWins.filter((r) => new Date(r['Closed At'] || 0).getTime() >= monthStart);
        const monthlyCommission = monthlyWinsForRancher.reduce((s, r) => s + (r['Commission Due'] || 0), 0);
        const lifetimeCommission = rancherWins.reduce((s, r) => s + (r['Commission Due'] || 0), 0);
        const commission = Math.round((saleAmount || 0) * 0.10 * 100) / 100;

        await sendTelegramSaleCelebration({
          referralId: id,
          buyerName,
          rancherName: decoded.name,
          saleAmount: saleAmount || 0,
          commission,
          isFirstSaleForRancher,
          monthlyWins: monthlyWinsForRancher.length,
          monthlyCommission,
          lifetimeWins: rancherWins.length,
          lifetimeCommission,
        });
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
