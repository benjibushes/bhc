import { NextResponse } from 'next/server';
import { getAllRecords, getRecordById, updateRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { partitionUnpaidByRail } from '@/lib/commission';
import { rowsNeedingInvoiceMint } from '@/lib/commissionOwed';
import { createCommissionInvoice } from '@/lib/stripe-commission';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendOperatorSignal } from '@/lib/operatorSignal';
import { shouldSendCronReport } from '@/lib/cronReportGate';
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
    // Wave 1C noise gate: "No unpaid commissions found" is a zero-work run —
    // the Cron Runs row (written by withCronRun) is the record; no Telegram.
    return { status: 'success', recordsTouched: 0, notes: `${monthYear}: no unpaid commissions` };
  }

  // RAIL-PER-ROW (2026-07-15): decide skip/stamp per REFERRAL, never per
  // rancher. The old per-rancher tier_v2 branch skipped invoicing AND stamped
  // Commission Paid=true on EVERY unpaid Closed Won row — an off-rail close
  // (no deposit ever paid) by a tier_v2 rancher had its receivable destroyed.
  // Deposit-rail rows (Deposit Paid At stamped) had commission skimmed at
  // deposit via application_fee_amount: stamp those paid so they drop out of
  // future runs. Everything else — including tier_v2 off-rail closes — flows
  // into the monthly invoice below.
  // brokerUnpaid (RAIL-MATRIX 2026-08-04): broker referrals whose deposit was
  // never paid. NEVER invoiced (the represented rancher's agreement is
  // deposit-as-commission, no invoice — billing him here charges a model he
  // never signed) and NOT stamped Commission Paid (nothing was collected;
  // whether to chase the ranch by phone is a human call). Counted + surfaced.
  const { depositRail, brokerUnpaid, invoiceEligible } = partitionUnpaidByRail(allUnpaid);
  let depositRailStamped = 0;
  for (const r of depositRail) {
    try {
      await updateRecord(TABLES.REFERRALS, r.id, {
        'Commission Paid': true,
        'Commission Paid At': new Date().toISOString(),
      });
      depositRailStamped++;
    } catch (e: any) {
      console.warn(`[commission-invoices] deposit-rail Commission Paid stamp failed for ${r.id}:`, e?.message);
    }
  }
  if (depositRail.length > 0) {
    console.log(`[commission-invoices] ${depositRailStamped}/${depositRail.length} deposit-rail referrals stamped Commission Paid (taken at deposit — nothing to invoice)`);
  }
  if (brokerUnpaid.length > 0) {
    console.log(`[commission-invoices] ${brokerUnpaid.length} broker referral(s) skipped — represented ranchers are never invoiced (deposit IS the commission; these rows have no paid deposit)`);
  }

  // Group invoice-eligible unpaid referrals by rancher ID
  const byRancher: Record<string, {
    rancherId: string;
    thisMonth: any[];
    allUnpaid: any[];
  }> = {};

  for (const referral of invoiceEligible) {
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
  let stripeMinted = 0;
  let stripeMintErrors = 0;
  const summaryLines: string[] = [];

  for (const [rancherId, group] of Object.entries(byRancher)) {
    try {
      const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);
      const operatorName = rancher['Operator Name'] || rancher['Ranch Name'] || 'Rancher';
      const ranchName = rancher['Ranch Name'] || operatorName;
      const rancherEmail = rancher['Email'] || '';

      if (!rancherEmail) {
        console.warn(`No email for rancher ${rancherId}, skipping invoice`);
        continue;
      }

      // GAP CLOSURE (ticket 2026-08-03): this cron used to send a statement
      // ABOUT money owed with no payable link behind it — the Pay button was
      // gated on the unset COMMISSION_PAYMENT_URL env and no Stripe invoice
      // was ever created here, so rows whose close-time invoice failed (or
      // predated the RAIL-PER-ROW fix) stayed unpayable forever. Now: before
      // the statement goes out, mint the hosted Stripe invoice for every
      // unpaid invoice-eligible row that lacks one, and stamp it on the
      // Referral. Safe on retries — createCommissionInvoice carries the
      // per-referral idempotencyKey `invoice-${referralId}`, and rows already
      // stamped are filtered out by rowsNeedingInvoiceMint. Runs BEFORE the
      // email-dedup skip so a rerun still backfills invoices even when the
      // month's statement was already sent.
      for (const row of rowsNeedingInvoiceMint(group.allUnpaid)) {
        try {
          const minted = await createCommissionInvoice({
            rancher: {
              id: rancherId,
              operatorName,
              ranchName,
              email: rancherEmail,
              stripeCustomerId: rancher['Stripe Customer ID'] || undefined,
            },
            referral: {
              id: row.id,
              buyerName: row['Buyer Name'] || 'Buyer',
              orderType: row['Order Type'] || 'Beef order',
              saleAmount: Number(row['Sale Amount']) || 0,
              commissionDue: Number(row['Commission Due']) || 0,
            },
          });
          // Stamp Airtable AND the in-memory row so this run's line items
          // carry the fresh pay link (money-path truth gets persisted).
          row['Stripe Invoice ID'] = minted.invoiceId;
          row['Stripe Invoice URL'] = minted.invoiceUrl;
          await updateRecord(TABLES.REFERRALS, row.id, {
            'Stripe Invoice ID': minted.invoiceId,
            'Stripe Invoice URL': minted.invoiceUrl,
          });
          stripeMinted++;
        } catch (mintErr: any) {
          // createCommissionInvoice's own guards (floor/ceiling/ratio) fire
          // loud operator signals before throwing — don't double-alert, just
          // count it and keep the statement flowing (its line still renders,
          // payable via the dashboard's lazy-mint path).
          stripeMintErrors++;
          console.error(`[commission-invoices] Stripe mint failed for ${row.id}:`, mintErr?.message);
        }
      }

      const lineItems = group.thisMonth.map(r => ({
        buyerName: r['Buyer Name'] || 'Unknown Buyer',
        orderType: r['Order Type'] || 'Beef Order',
        saleAmount: Number(r['Sale Amount']) || 0,
        commissionDue: Number(r['Commission Due']) || 0,
        stripeInvoiceUrl: String(r['Stripe Invoice URL'] || '').trim() || null,
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
          stripeInvoiceUrl: null,
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

  // Wave 1C: report only when the run did work or failed (zero-work months
  // where every unpaid row was deposit-rail-stamped stay in the Cron Runs
  // note). Rides sendOperatorSignal so a dead bot token falls back instead of
  // silently swallowing a money report. Content unchanged.
  if (shouldSendCronReport({ workDone: invoicesSent + depositRailStamped + stripeMinted, failures: errors + stripeMintErrors })) {
    await sendOperatorSignal({
      urgency: 'normal',
      kind: 'other',
      summary: `Monthly Commission Invoices — ${monthYear}: ${invoicesSent} invoice(s) sent`,
      detail: [
        ...summaryLines,
        depositRailStamped > 0 ? `💳 ${depositRailStamped} deposit-rail referral(s) stamped paid (taken at deposit)` : '',
        brokerUnpaid.length > 0 ? `🤝 ${brokerUnpaid.length} broker referral(s) skipped — never invoiced; deposit not collected, follow up by hand` : '',
        stripeMinted > 0 ? `🧾 ${stripeMinted} Stripe invoice(s) minted for previously-unpayable rows` : '',
        stripeMintErrors > 0 ? `⚠️ ${stripeMintErrors} Stripe invoice mint failure(s)` : '',
        errors > 0 ? `⚠️ ${errors} error(s)` : '',
      ]
        .filter(Boolean)
        .join('\n') || undefined,
      dedupeKey: `commission-invoices:${monthYear}`,
      dedupeWindowMs: 6 * 60 * 60 * 1000,
    }).catch(() => {});
  }

  return {
    status: errors + stripeMintErrors > 0 ? 'partial' : 'success',
    recordsTouched: invoicesSent + stripeMinted,
    notes: `${monthYear}: invoices=${invoicesSent} unpaid=${allUnpaid.length} depositRailStamped=${depositRailStamped} brokerSkipped=${brokerUnpaid.length} stripeMinted=${stripeMinted} mintErrors=${stripeMintErrors} errors=${errors}`,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('commission-invoices', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
