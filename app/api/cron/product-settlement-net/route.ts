// app/api/cron/product-settlement-net/route.ts
//
// PRODUCT SETTLEMENT SAFETY NET — re-derives Rancher Orders from Stripe truth
// so a charged product buyer can never go permanently invisible.
//
// Failure class it closes (checkout audit 2026-07-14, critical #1): the order
// row is created ONLY inside the connect webhook's payment_intent.succeeded
// handler. Unregistered endpoint / webhook-secret drift past Stripe's ~3-day
// retry / PermanentSettlementError → buyer charged + funds split, but no
// order, no receipt, no rancher ship-to email, no inventory decrement, no
// alert. The deposit rail has orphan-checkout-reaper; the product rail had
// nothing.
//
// Procedure (idempotent, cheap at current volume):
//   1. Load every rancher with a Stripe Connect Account Id (direct charges
//      live on THEIR accounts, so we must list per-account).
//   2. Per account: list PaymentIntents created in the last 3 days, keep
//      status='succeeded' + metadata.type='product_purchase'.
//   3. For each, check Rancher Orders by {Stripe Payment Intent}; missing →
//      settleProductPurchase(pi, acct) — the SAME idempotent settlement the
//      webhook runs (claimOnce + pre-create dedup), so a webhook racing the
//      net cannot double-create.
//   4. Telegram alert when anything was recovered (each recovery means the
//      webhook path failed — worth eyes) or permanently failed.
//
// Schedule: every 6h via vercel.json. Window 3d ≈ Stripe's retry horizon +
// slack; the cron overlaps itself so nothing falls between runs.

import { getAllRecords, TABLES, escapeAirtableValue } from '@/lib/airtable';
import { getStripeClient } from '@/lib/stripeConnect';
import { settleProductPurchase } from '@/lib/productSettlement';
import { isPermanentSettlementError } from '@/lib/stripeSettlement';
import { productPisNeedingSettlement } from '@/lib/productSettlementNet';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';

export const maxDuration = 300;

const WINDOW_SECONDS = 3 * 24 * 60 * 60; // 3 days

interface NetResult {
  status: 'success' | 'partial' | 'error';
  recordsTouched: number;
  notes: string;
}

async function realHandler(_request: Request): Promise<NetResult> {
  const stripe = getStripeClient();
  const createdGte = Math.floor(Date.now() / 1000) - WINDOW_SECONDS;

  // Every rancher with a Connect account — not just currently-active ones. A
  // rancher who went restricted YESTERDAY can still have a paid-but-unsettled
  // PI from the day before.
  const ranchers = await getAllRecords(TABLES.RANCHERS, `{Stripe Connect Account Id} != ''`);
  const accountIds = Array.from(
    new Set(
      ranchers
        .map((r: any) => String(r['Stripe Connect Account Id'] || '').trim())
        .filter(Boolean),
    ),
  );

  let scanned = 0;
  let recovered = 0;
  const permanentFailures: string[] = [];
  const accountErrors: string[] = [];
  const recoveredIds: string[] = [];

  for (const acct of accountIds) {
    let pis: any[] = [];
    try {
      // 100/acct/3d is far above real volume; auto_paging not needed yet. If a
      // single account ever exceeds this, the next 6h run catches the rest.
      const page = await stripe.paymentIntents.list(
        { limit: 100, created: { gte: createdGte } },
        { stripeAccount: acct },
      );
      pis = page.data || [];
    } catch (e: any) {
      // Restricted/deauthorized accounts can refuse list calls — note + move on.
      accountErrors.push(`${acct}: ${e?.message || 'list failed'}`);
      continue;
    }

    const productPis = pis.filter(
      (p) => p?.status === 'succeeded' && String(p?.metadata?.type || '') === 'product_purchase',
    );
    scanned += productPis.length;
    if (productPis.length === 0) continue;

    // One order-existence lookup per candidate (tiny sets at current volume).
    const existing = new Set<string>();
    for (const p of productPis) {
      try {
        const rows = await getAllRecords(
          TABLES.RANCHER_ORDERS,
          `{Stripe Payment Intent} = "${escapeAirtableValue(p.id)}"`,
        );
        if (rows.length > 0) existing.add(p.id);
      } catch {
        // Airtable blip: treat as existing (skip) — settling on a false-miss is
        // safe (settle dedups), but skipping is cheaper; next run re-checks.
        existing.add(p.id);
      }
    }

    for (const p of productPisNeedingSettlement(productPis, existing)) {
      try {
        await settleProductPurchase(p, acct);
        recovered += 1;
        recoveredIds.push(p.id);
      } catch (e: any) {
        if (isPermanentSettlementError(e)) {
          permanentFailures.push(`${p.id}: ${e?.message || 'permanent'}`);
        } else {
          accountErrors.push(`${p.id}: ${e?.message || 'settle failed'}`);
        }
      }
    }
  }

  // Recovery = the webhook path failed for that sale. Loud on purpose.
  if ((recovered > 0 || permanentFailures.length > 0) && TELEGRAM_ADMIN_CHAT_ID) {
    try {
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `🥅 <b>SETTLEMENT NET</b>\n\n` +
          (recovered > 0
            ? `Recovered <b>${recovered}</b> paid product order(s) the webhook missed:\n${recoveredIds.join('\n')}\n\nBuyer receipt + rancher ship-to emails just went out via the normal settle path. CHECK why the webhook missed them (secret? endpoint?).\n`
            : '') +
          (permanentFailures.length > 0
            ? `\n🚨 <b>${permanentFailures.length}</b> paid PI(s) CANNOT settle (malformed metadata) — money took, no order possible without a hand-fix:\n${permanentFailures.join('\n')}`
            : ''),
      );
    } catch (e: any) {
      console.error('[product-settlement-net] telegram failed:', e?.message);
    }
  }

  const notes =
    `${accountIds.length} accts, ${scanned} product PIs in window, ${recovered} recovered` +
    (permanentFailures.length ? `, ${permanentFailures.length} PERMANENT` : '') +
    (accountErrors.length ? `, ${accountErrors.length} errors: ${accountErrors.slice(0, 3).join(' | ')}` : '');

  if (permanentFailures.length > 0) return { status: 'error', recordsTouched: recovered, notes };
  if (accountErrors.length > 0) return { status: 'partial', recordsTouched: recovered, notes };
  return { status: 'success', recordsTouched: recovered, notes };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('product-settlement-net', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
