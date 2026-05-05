// Stripe-backed commission invoicing for rancher Closed Won deals.
//
// When a rancher marks a Referral as Closed Won and inputs the agreed sale
// amount, we generate a Stripe Invoice in BHC's account billed to the
// rancher's email. Stripe auto-sends the hosted invoice page; rancher pays
// the 10% commission via card (or ACH if enabled in Stripe dashboard).
// Webhook fires `invoice.paid` → we mark Commission Paid on the Referral.
//
// Stripe Customer is cached on the Rancher record (`Stripe Customer ID`) so
// repeat invoices reuse the same customer. Without caching we'd duplicate
// customers on every close.
//
// Why Stripe Invoice (vs Checkout Session or Payment Link):
//   - Native B2B "send invoice, they pay" pattern
//   - Hosted invoice page with PDF download for rancher's records
//   - Stripe sends the email itself — no Resend round-trip
//   - Auto-tracks paid/unpaid + sends reminders if days_until_due elapses
//   - Webhook event `invoice.paid` is the canonical "commission settled" signal

import Stripe from 'stripe';
import { getStripe } from '@/lib/stripe';
import { TABLES, updateRecord } from '@/lib/airtable';

interface CommissionInvoiceArgs {
  rancher: {
    id: string;
    operatorName: string;
    ranchName: string;
    email: string;
    stripeCustomerId?: string;
  };
  referral: {
    id: string;
    buyerName: string;
    orderType: string;
    saleAmount: number;
    commissionDue: number;
  };
}

interface CommissionInvoiceResult {
  invoiceId: string;
  invoiceUrl: string; // hosted_invoice_url
  customerId: string;
  status: string;
}

async function ensureStripeCustomer(
  stripe: Stripe,
  rancher: CommissionInvoiceArgs['rancher']
): Promise<string> {
  if (rancher.stripeCustomerId) {
    // Validate the cached id still exists in Stripe (rancher might have been
    // deleted manually). If retrieve throws, fall through to create.
    try {
      const c = await stripe.customers.retrieve(rancher.stripeCustomerId);
      if (c && !(c as any).deleted) return rancher.stripeCustomerId;
    } catch {
      // fall through
    }
  }
  const customer = await stripe.customers.create({
    email: rancher.email,
    name: rancher.ranchName || rancher.operatorName,
    description: `BuyHalfCow rancher · ${rancher.operatorName}`,
    metadata: {
      type: 'rancher-commission',
      rancherId: rancher.id,
      ranchName: rancher.ranchName,
    },
  });
  // Cache for future invoices
  try {
    await updateRecord(TABLES.RANCHERS, rancher.id, {
      'Stripe Customer ID': customer.id,
    });
  } catch (e: any) {
    // Non-fatal — next invoice will hit the cache miss + try again
    console.warn('[stripe-commission] cache stripeCustomerId failed:', e?.message);
  }
  return customer.id;
}

/**
 * Create + finalize a commission invoice. Returns the hosted_invoice_url for
 * surfacing in the rancher email.
 *
 * Throws on Stripe errors — caller should fall back to plain-email reminder
 * so the rancher still gets an actionable note.
 */
export async function createCommissionInvoice(
  args: CommissionInvoiceArgs
): Promise<CommissionInvoiceResult> {
  const stripe = getStripe();

  if (!args.rancher.email) {
    throw new Error('Rancher email required for commission invoice');
  }
  if (args.referral.commissionDue <= 0) {
    throw new Error('Commission due must be > 0');
  }

  const customerId = await ensureStripeCustomer(stripe, args.rancher);
  const amountCents = Math.round(args.referral.commissionDue * 100);
  const description = `Commission · ${args.referral.buyerName} · ${args.referral.orderType} · $${args.referral.saleAmount.toFixed(2)} sale (10%)`;

  // Order matters with API 2026: create draft invoice FIRST, then attach
  // line item to it explicitly with `invoice` field, then finalize + send.
  // The legacy "create pending invoiceItem → invoices.create picks it up"
  // path silently fails on this API version — the invoice gets created
  // before the pending item attaches, finalizes at $0, auto-marks paid.
  const draft = await stripe.invoices.create({
    customer: customerId,
    collection_method: 'send_invoice',
    days_until_due: 30,
    // Disable auto-advance — we want to control finalize/send timing so
    // line item attaches before the invoice transitions out of draft.
    auto_advance: false,
    description: `BuyHalfCow commission for ${args.referral.buyerName} (${args.referral.orderType})`,
    metadata: {
      type: 'commission-invoice',
      referralId: args.referral.id,
      rancherId: args.rancher.id,
      saleAmount: String(args.referral.saleAmount),
    },
    footer:
      'Thanks for closing the deal. Reply to this invoice if anything looks off — Ben.',
  });

  if (!draft.id) throw new Error('Stripe invoice id missing after create');

  // Attach the commission line item directly to the draft.
  await stripe.invoiceItems.create({
    customer: customerId,
    invoice: draft.id,
    amount: amountCents,
    currency: 'usd',
    description,
    metadata: {
      type: 'commission',
      referralId: args.referral.id,
      rancherId: args.rancher.id,
    },
  });

  // Finalize → moves draft to "open", generates hosted_invoice_url + PDF.
  const finalized = await stripe.invoices.finalizeInvoice(draft.id);

  // Explicitly send the invoice email. With collection_method='send_invoice'
  // Stripe needs an explicit `sendInvoice` call to email the hosted page —
  // finalize alone does NOT email when auto_advance is false.
  let sent = finalized;
  if (finalized.status === 'open' && finalized.id) {
    try {
      sent = await stripe.invoices.sendInvoice(finalized.id);
    } catch (sendErr: any) {
      // sendInvoice can fail if invoice is already paid/uncollectible —
      // not fatal, hosted URL still works for direct linking.
      console.warn('[stripe-commission] sendInvoice failed:', sendErr?.message);
    }
  }

  const url = sent.hosted_invoice_url || finalized.hosted_invoice_url || '';
  return {
    invoiceId: sent.id || finalized.id || draft.id,
    invoiceUrl: url,
    customerId,
    status: sent.status || 'open',
  };
}

/**
 * Webhook payload helper — extract the referralId Stripe stamped on the
 * invoice metadata.
 */
export function getReferralIdFromInvoice(invoice: any): string | null {
  return (
    invoice?.metadata?.referralId ||
    invoice?.lines?.data?.[0]?.metadata?.referralId ||
    null
  );
}
