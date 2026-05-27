// Stage-3 Task 10 — rancher à la carte add-on purchase.
//
// Three Stripe-billed add-ons: video shoot ($2500), photo refresh ($1500),
// founder-letter campaign ($750). All one-time invoices to the rancher's
// Stripe Customer. brand_intro + ppc are NOT billable here — those are
// percent-of-deal manual invoices handled offline.
//
// Flow:
//   1. JWT auth
//   2. Validate slug + look up price ID from env (matches lib/tiers.ADD_ONS)
//   3. Ensure rancher has a Stripe Customer ID (cache on Rancher row)
//   4. Create Add-On Purchases Airtable row (status=pending) BEFORE invoice
//      so the webhook has a record to flip even on a retry/race
//   5. Stripe: invoiceItems.create → invoices.create → finalizeInvoice
//   6. Stamp Stripe Invoice Id on the Airtable row + return hosted URL
//   7. Telegram alert
//
// Webhook contract: app/api/webhooks/stripe/route.ts case 'invoice.paid'
// reads inv.metadata.addOnPurchaseId and flips Status → paid (Task 6a).

import { NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { getRecordById, createRecord, updateRecord, TABLES } from '@/lib/airtable';
import { ADD_ONS } from '@/lib/tiers';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { requireRancher } from '@/lib/rancherAuth';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const ADDONS_TABLE = 'Add-On Purchases';
const STRIPE_BILLABLE_SLUGS = new Set(['video', 'photo', 'founder_letter']);

// Slug → Airtable singleSelect display label for the Type field.
const TYPE_LABEL: Record<string, string> = {
  video: 'Custom Video Shoot',
  photo: 'Brand Photo Refresh',
  founder_letter: 'Founder Letter Campaign',
};

export async function POST(request: Request) {
  // Auth Phase 2: requireRancher routes through Clerk or legacy JWT.
  const r = await requireRancher(request);
  if (r instanceof NextResponse) return r;
  const { session } = r;

  // ── Body ──
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const slug = String(body?.slug || '').toLowerCase();
  if (!STRIPE_BILLABLE_SLUGS.has(slug)) {
    return NextResponse.json(
      { error: `Add-on "${slug}" is not Stripe-billable. brand_intro + ppc are invoiced manually.` },
      { status: 400 },
    );
  }

  const addOnConfig = ADD_ONS.find((a) => a.slug === slug);
  if (!addOnConfig || !addOnConfig.stripePriceIdEnv) {
    return NextResponse.json({ error: 'Add-on config missing' }, { status: 500 });
  }
  const priceId = process.env[addOnConfig.stripePriceIdEnv];
  if (!priceId) {
    return NextResponse.json(
      { error: `Add-on price ID not configured (${addOnConfig.stripePriceIdEnv})` },
      { status: 500 },
    );
  }
  const amountCents =
    addOnConfig.pricing.kind === 'one_time' ? addOnConfig.pricing.cents : 0;

  // ── Load rancher record ──
  const rancherId: string = session.rancherId;
  const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);
  if (!rancher) {
    return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });
  }
  const rancherEmail = String(rancher['Email'] || '').trim();
  if (!rancherEmail) {
    return NextResponse.json(
      { error: 'Your account is missing an email — set one before purchasing add-ons.' },
      { status: 422 },
    );
  }

  // ── Ensure Stripe customer (cached on Ranchers.Stripe Customer ID) ──
  const stripe = getStripe();
  let customerId = String(rancher['Stripe Customer ID'] || '');
  if (customerId) {
    try {
      const existing = await stripe.customers.retrieve(customerId);
      if (!existing || (existing as any).deleted) customerId = '';
    } catch {
      customerId = '';
    }
  }
  if (!customerId) {
    try {
      const customer = await stripe.customers.create(
        {
          email: rancherEmail,
          name: rancher['Ranch Name'] || rancher['Operator Name'] || rancherEmail,
          description: `BuyHalfCow rancher · ${rancher['Operator Name'] || ''}`,
          metadata: { type: 'rancher-addons', rancherId },
        },
        {
          idempotencyKey: `customer-addons-${rancherId}`,
        },
      );
      customerId = customer.id;
      try {
        await updateRecord(TABLES.RANCHERS, rancherId, { 'Stripe Customer ID': customerId });
      } catch (e: any) {
        console.warn('[addons/purchase] cache Stripe Customer ID failed:', e?.message);
      }
    } catch (e: any) {
      console.error('[addons/purchase] Stripe customer create failed:', e?.message);
      return NextResponse.json({ error: 'Could not create Stripe customer.' }, { status: 502 });
    }
  }

  // ── Airtable row first (pending) so webhook always has a target ──
  let addOnRowId = '';
  try {
    const created: any = await createRecord(ADDONS_TABLE, {
      'Rancher': [rancherId],
      'Type': TYPE_LABEL[slug],
      'Amount Cents': amountCents,
      'Status': 'pending',
      'Purchased At': new Date().toISOString(),
    });
    addOnRowId = String(created?.id || '');
  } catch (e: any) {
    console.error('[addons/purchase] Airtable createRecord failed:', e?.message);
    return NextResponse.json({ error: 'Could not record purchase intent.' }, { status: 500 });
  }
  if (!addOnRowId) {
    return NextResponse.json({ error: 'Airtable returned no record id.' }, { status: 500 });
  }

  // ── Stripe invoice item + invoice ──
  let invoice: any;
  try {
    // Attach the line item to the customer — it'll roll into the next draft
    // invoice we create below. metadata on both the item AND the invoice so
    // the webhook routes correctly even if Stripe reorders payloads.
    const invoiceMetadata = {
      type: 'addon-purchase',
      addOnPurchaseId: addOnRowId,
      rancherId,
      slug,
    };
    // SDK v20.4.1 types omit `price` on InvoiceItemCreateParams; cast params
    // (NOT the resource) per Stage-3 V2 SDK pattern. The runtime API accepts
    // price + customer for line-item attachment.
    await stripe.invoiceItems.create(
      {
        customer: customerId,
        price: priceId,
        description: addOnConfig.label,
        metadata: invoiceMetadata,
      } as any,
      {
        idempotencyKey: `addon-item-${addOnRowId}`,
      },
    );
    const created = await stripe.invoices.create(
      {
        customer: customerId,
        collection_method: 'send_invoice',
        days_until_due: 7,
        auto_advance: false, // we finalize explicitly below
        metadata: invoiceMetadata,
        description: `BuyHalfCow add-on — ${addOnConfig.label}`,
      },
      {
        idempotencyKey: `addon-invoice-${addOnRowId}`,
      },
    );
    // finalizeInvoice requires the invoice id string.
    invoice = await stripe.invoices.finalizeInvoice(String(created.id));
  } catch (e: any) {
    console.error('[addons/purchase] Stripe invoice flow failed:', e?.message);
    // Mark the Airtable row failed so the dangling pending row isn't confusing.
    try {
      await updateRecord(ADDONS_TABLE, addOnRowId, { 'Status': 'failed', 'Notes': `Stripe error: ${e?.message || 'unknown'}` });
    } catch {}
    return NextResponse.json({ error: `Stripe invoice failed: ${e?.message || 'unknown'}` }, { status: 502 });
  }

  // ── Stamp invoice id on Airtable row so the row is fully linked. ──
  try {
    await updateRecord(ADDONS_TABLE, addOnRowId, {
      'Stripe Invoice Id': String(invoice.id || ''),
    });
  } catch (e: any) {
    console.warn('[addons/purchase] stamp invoice id failed:', e?.message);
  }

  // ── Telegram alert ──
  try {
    const ranchName = rancher['Ranch Name'] || rancher['Operator Name'] || rancherId;
    const dollars = (amountCents / 100).toFixed(2);
    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      `🛒 ADD-ON purchased — ${ranchName} · ${addOnConfig.label} · $${dollars} · invoice ${invoice.id?.slice(-8) || '?'}`,
    );
  } catch (e: any) {
    console.warn('[addons/purchase] telegram alert failed:', e?.message);
  }

  const invoiceUrl = String(invoice.hosted_invoice_url || '');
  return NextResponse.json({
    ok: true,
    addOnPurchaseId: addOnRowId,
    invoiceId: invoice.id,
    invoiceUrl,
    amountCents,
  });
}
