import { NextResponse } from 'next/server';
import { updateRecord, getRecordById, getAllRecords } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendTelegramSaleCelebration } from '@/lib/telegram';
import { requireAdmin } from '@/lib/adminAuth';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const __authResp = await requireAdmin(request);
    if (__authResp) return __authResp;
    const { id } = await params;
    const body = await request.json();
    const { status, saleAmount, commissionPaid, notes, closeReason } = body;

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

    // ── BUYER STATUS + HEALTH SYNC ───────────────────────────────────────
    // Mirror the rancher PATCH: when a referral closes, sync the buyer's
    // Referral Status so batch-approve's waitlist retry filter doesn't skip
    // them forever, AND update Buyer Health so the routing engine reflects
    // quality (Closed Won → customer, no_response → ghost-counter).
    if (status === 'Closed Won' || status === 'Closed Lost') {
      try {
        const refForBuyer = await getRecordById(TABLES.REFERRALS, id) as any;
        const buyerIds = refForBuyer['Buyer'] || [];
        const buyerId = Array.isArray(buyerIds) ? buyerIds[0] : null;
        if (buyerId) {
          if (status === 'Closed Won') {
            await updateRecord(TABLES.CONSUMERS, buyerId, {
              'Referral Status': 'Closed Won',
              'Sequence Stage': 'purchased',
              'Buyer Health': 'Closed Won',
              'Missed Responses': 0,
            });
          } else {
            // Closed Lost — base status sync always
            await updateRecord(TABLES.CONSUMERS, buyerId, {
              'Referral Status': 'Unmatched',
              'Sequence Stage': 'rerouted',
            });
            // If admin specifies closeReason='no_response', count it as a miss
            if (closeReason === 'no_response') {
              const buyer = await getRecordById(TABLES.CONSUMERS, buyerId) as any;
              const NON_RESPONSIVE_THRESHOLD = 2;
              const prevMisses = Number(buyer['Missed Responses'] || 0);
              const newMisses = prevMisses + 1;
              const updates: Record<string, any> = { 'Missed Responses': newMisses };
              const becameNonResponsive = newMisses >= NON_RESPONSIVE_THRESHOLD &&
                String(buyer['Buyer Health']?.name || buyer['Buyer Health'] || '') !== 'Non-Responsive';
              if (becameNonResponsive) updates['Buyer Health'] = 'Non-Responsive';
              await updateRecord(TABLES.CONSUMERS, buyerId, updates);
              if (becameNonResponsive) {
                try {
                  const { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } = await import('@/lib/telegram');
                  await sendTelegramMessage(
                    TELEGRAM_ADMIN_CHAT_ID,
                    `🚫 <b>Buyer auto-flagged Non-Responsive (admin close)</b>\n\n` +
                    `👤 ${buyer['Full Name'] || 'Unknown'} (${buyer['State'] || '?'})\n` +
                    `📧 ${buyer['Email'] || '?'}\n` +
                    `Misses: ${newMisses} consecutive no-response closes\n` +
                    `<i>Excluded from future routing until reactivated.</i>`,
                  );
                } catch { /* non-fatal */ }
              }
            }
          }
        }
      } catch (e) {
        console.error('Buyer status sync error:', e);
      }
    }

    // L2e: fire celebration when admin marks something Closed Won
    if (status === 'Closed Won') {
      try {
        const referral = await getRecordById(TABLES.REFERRALS, id) as any;
        const rancherIds = referral['Rancher'] || referral['Suggested Rancher'] || [];
        const rancherId = Array.isArray(rancherIds) ? rancherIds[0] : null;
        let rancherName = referral['Suggested Rancher Name'] || 'Rancher';
        if (rancherId) {
          try {
            const r = await getRecordById(TABLES.RANCHERS, rancherId) as any;
            rancherName = r['Operator Name'] || r['Ranch Name'] || rancherName;
          } catch { /* keep default */ }
        }
        const allRefs = await getAllRecords(TABLES.REFERRALS) as any[];
        const rancherWins = allRefs.filter((r) => {
          if (r['Status'] !== 'Closed Won') return false;
          const ids = r['Rancher'] || r['Suggested Rancher'] || [];
          return rancherId ? Array.isArray(ids) && ids.includes(rancherId) : false;
        });
        const isFirstSaleForRancher = rancherWins.length === 1;
        const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
        const monthlyWins = rancherWins.filter((r) => new Date(r['Closed At'] || 0).getTime() >= monthStart);
        const monthlyCommission = monthlyWins.reduce((s, r) => s + (r['Commission Due'] || 0), 0);
        const lifetimeCommission = rancherWins.reduce((s, r) => s + (r['Commission Due'] || 0), 0);
        const commissionRate = Number(process.env.NEXT_PUBLIC_COMMISSION_RATE || '0.10');
        const commission = Math.round((saleAmount || 0) * commissionRate * 100) / 100;

        await sendTelegramSaleCelebration({
          referralId: id,
          buyerName: referral['Buyer Name'] || 'Unknown buyer',
          rancherName,
          saleAmount: saleAmount || 0,
          commission,
          isFirstSaleForRancher,
          monthlyWins: monthlyWins.length,
          monthlyCommission,
          lifetimeWins: rancherWins.length,
          lifetimeCommission,
        });
      } catch (e) {
        console.error('Sale celebration notification error:', e);
      }
    }

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
