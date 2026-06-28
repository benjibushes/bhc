import { NextResponse } from 'next/server';
import { getAllRecords, getRecordById, updateRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendTelegramUpdate } from '@/lib/telegram';
import { sendMonthlyCommissionInvoice } from '@/lib/email';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';

export const maxDuration = 60;

// Runs on the 1st of each month at 10am MT (16:00 UTC)
// Sends commission invoices to ranchers with unpaid commissions
async function realHandler(_request: Request): Promise<{ status: 'success' | 'partial' | 'maintenance-blocked'; recordsTouched: number; notes: string }> {
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }

  // Date-1 guard. Vercel Hobby tier silently skipped the `0 16 1 * *` monthly
  // schedule (0 Cron Runs rows in 60+ days). Switched to daily 16 UTC + this
  // guard so the cron actually fires on the 1st + Cron Runs has a row every
  // day proving we DID check.
  const today = new Date();
  if (today.getUTCDate() !== 1) {
    return { status: 'success', recordsTouched: 0, notes: `skipped — not 1st (UTC day=${today.getUTCDate()})` };
  }

  // Determine the previous month for the invoice period
  const now = new Date();
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const monthYear = prevMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const prevMonthStart = prevMonth.toISOString().slice(0, 10);
  const prevMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().slice(0, 10);

  // Fetch all unpaid Closed Won referrals
  const allUnpaid = await getAllRecords(
    TABLES.REFERRALS,
    'AND({Status} = "Closed Won", NOT({Commission Paid}))'
  ) as any[];

  if (allUnpaid.length === 0) {
    await sendTelegramUpdate('📋 <b>Commission Invoices</b>: No unpaid commissions found. No invoices sent.');
    return { status: 'success', recordsTouched: 0, notes: `${monthYear}: no unpaid commissions` };
  }

  // Group ALL unpaid referrals by rancher ID
  const byRancher: Record<string, {
    rancherId: string;
    thisMonth: any[];
    allUnpaid: any[];
  }> = {};

  for (const referral of allUnpaid) {
    const rancherIds: string[] = referral['Suggested Rancher'] || referral['Rancher'] || [];
    const rancherId = rancherIds[0];
    if (!rancherId) continue;

    if (!byRancher[rancherId]) {
      byRancher[rancherId] = { rancherId, thisMonth: [], allUnpaid: [] };
    }
    byRancher[rancherId].allUnpaid.push(referral);

    const closedAt = referral['Closed At'];
    if (closedAt) {
      const closedDate = closedAt.slice(0, 10);
      if (closedDate >= prevMonthStart && closedDate <= prevMonthEnd) {
        byRancher[rancherId].thisMonth.push(referral);
      }
    }
  }

  let invoicesSent = 0;
  let errors = 0;
  const summaryLines: string[] = [];

  let tierV2Skipped = 0;
  for (const [rancherId, group] of Object.entries(byRancher)) {
    try {
      const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);
      const operatorName = rancher['Operator Name'] || rancher['Ranch Name'] || 'Rancher';
      const ranchName = rancher['Ranch Name'] || operatorName;
      const rancherEmail = rancher['Email'] || '';

      // Tier_v2 ranchers SKIP. Their commission was already taken at deposit
      // time via Stripe Connect application_fee_amount. Firing a legacy
      // monthly commission invoice would double-bill them. Also patch
      // referral rows to Commission Paid=true so they drop out of future runs.
      const pricingModel = String(rancher?.['Pricing Model'] || 'legacy');
      if (pricingModel === 'tier_v2') {
        for (const r of group.allUnpaid) {
          try {
            await updateRecord(TABLES.REFERRALS, r.id, {
              'Commission Paid': true,
              'Commission Paid At': new Date().toISOString(),
            });
          } catch (e: any) {
            console.warn(`[commission-invoices] tier_v2 Commission Paid stamp failed for ${r.id}:`, e?.message);
          }
        }
        tierV2Skipped += group.allUnpaid.length;
        console.log(`[commission-invoices] tier_v2 rancher ${rancherId} — skipped + marked ${group.allUnpaid.length} referrals Commission Paid`);
        continue;
      }

      if (!rancherEmail) {
        console.warn(`No email for rancher ${rancherId}, skipping invoice`);
        continue;
      }

      const lineItems = group.thisMonth.map(r => ({
        buyerName: r['Buyer Name'] || 'Unknown Buyer',
        orderType: r['Order Type'] || 'Beef Order',
        saleAmount: Number(r['Sale Amount']) || 0,
        commissionDue: Number(r['Commission Due']) || 0,
      }));

      const totalCommissionDue = lineItems.reduce((sum, item) => sum + item.commissionDue, 0);
      const runningTotalUnpaid = group.allUnpaid.reduce(
        (sum, r) => sum + (Number(r['Commission Due']) || 0),
        0
      );

      if (lineItems.length === 0 && runningTotalUnpaid <= 0) continue;

      if (lineItems.length === 0) {
        lineItems.push({
          buyerName: '(No new sales this month)',
          orderType: '—',
          saleAmount: 0,
          commissionDue: 0,
        });
      }

      // IDEMPOTENCY GUARD (RW-7 audit): if Vercel cron retries on the
      // 1st of the month after a partial run, sendMonthlyCommissionInvoice
      // could fire to the same rancher twice — money-facing duplicate
      // invoice. Check Email Sends for this template + recipient within
      // the current calendar month. Skip if already sent.
      try {
        const { getAllRecords, escapeAirtableValue } = await import('@/lib/airtable');
        const firstOfMonthIso = new Date(today.getUTCFullYear(), today.getUTCMonth(), 1).toISOString();
        const dupRows = (await getAllRecords(
          TABLES.EMAIL_SENDS,
          `AND({Template Name} = "sendMonthlyCommissionInvoice", LOWER({Recipient Email}) = "${escapeAirtableValue(rancherEmail.toLowerCase())}", {Sent At} > "${firstOfMonthIso}", {Status} = "sent")`,
        )) as any[];
        if (dupRows.length > 0) {
          summaryLines.push(`🤠 ${ranchName}: skipped (invoice already sent this month)`);
          continue;
        }
      } catch (e: any) {
        // Fail-open: if Email Sends read fails, proceed to send. Better
        // to risk a rare duplicate than skip a real invoice.
        console.warn(`[commission-invoices] dedup check failed for ${rancherEmail}:`, e?.message);
      }

      // ATOMIC idempotency backstop — claim a once-per-month key right before the
      // send. The Email Sends dedup above fails OPEN (proceeds on read error);
      // this claim does NOT, so a Vercel retry while Airtable is slow can't
      // double-invoice a rancher (money-facing). 3h TTL covers the same-day
      // retry window (the cron only fires on the 1st); the persisted Email Sends
      // row is the month-long backstop. Degrades open only if Redis is entirely
      // absent (it's configured in prod).
      const { claimOnce } = await import('@/lib/rancherCapacity');
      const invoiceClaimed = await claimOnce(
        `commission-invoice:${rancherId}:${monthYear}`,
        3 * 60 * 60,
      );
      if (!invoiceClaimed) {
        summaryLines.push(`🤠 ${ranchName}: skipped (invoice already claimed this run)`);
        continue;
      }

      await sendMonthlyCommissionInvoice({
        operatorName,
        ranchName,
        email: rancherEmail,
        monthYear,
        lineItems,
        totalCommissionDue,
        runningTotalUnpaid,
      });

      summaryLines.push(
        `🤠 ${ranchName}: ${group.thisMonth.length} sale(s), $${totalCommissionDue.toFixed(2)} this month, $${runningTotalUnpaid.toFixed(2)} total unpaid`
      );
      invoicesSent++;
    } catch (err: any) {
      console.error(`Commission invoice error for rancher ${rancherId}:`, err.message);
      errors++;
    }
  }

  const telegramMsg = [
    `📋 <b>Monthly Commission Invoices — ${monthYear}</b>`,
    `${invoicesSent} invoice(s) sent`,
    ...summaryLines,
    errors > 0 ? `⚠️ ${errors} error(s)` : '',
  ]
    .filter(Boolean)
    .join('\n');

  await sendTelegramUpdate(telegramMsg);

  return {
    status: errors > 0 ? 'partial' : 'success',
    recordsTouched: invoicesSent,
    notes: `${monthYear}: invoices=${invoicesSent} unpaid=${allUnpaid.length} errors=${errors}`,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('commission-invoices', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
