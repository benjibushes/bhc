import { NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import {
  updateRecord,
  createRecord,
  getAllRecords,
  getRecordById,
  escapeAirtableValue,
  TABLES,
} from '@/lib/airtable';
import { sendBrandListingConfirmation, sendFoundingHerdWelcome } from '@/lib/email';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { commissionRateForTier, TierSlug } from '@/lib/tiers';
import { rancherIdFromSubscription } from '@/lib/stripeSubscription';
import { markDepositSucceeded, markDepositRefunded } from '@/lib/contracts/payments';
import { recordClose } from '@/lib/contracts/rancher';

// Airtable table name for Stripe Events (Task 24 idempotency log)
const STRIPE_EVENTS_TABLE = 'Stripe Events';

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

// Map metadata.tier (sent by Stripe Payment Link / Checkout) → Founder Tier
// singleSelect value in Airtable + the dollar amount we record on the row.
// `monthly` and `annual` collapse to the same Founder Tier (Herd / Outlaw /
// Steward) — the price separation lives in Stripe, not on our table.
const TIER_MAP: Record<
  string,
  { tier: 'Herd' | 'Outlaw' | 'Steward' | 'Founding 100' | 'Title Founder'; numbered: boolean }
> = {
  'herd-monthly': { tier: 'Herd', numbered: false },
  'herd-annual': { tier: 'Herd', numbered: false },
  'outlaw-monthly': { tier: 'Outlaw', numbered: false },
  'outlaw-annual': { tier: 'Outlaw', numbered: false },
  'steward-monthly': { tier: 'Steward', numbered: false },
  'steward-annual': { tier: 'Steward', numbered: false },
  'founding-100': { tier: 'Founding 100', numbered: true },
  'title-founder': { tier: 'Title Founder', numbered: true },
  // Verification mode — $1 test charge from /founders when FOUNDERS_TEST_MODE=true.
  // Treated as a one-time founder-lifetime so we exercise the full path.
  'test-1': { tier: 'Founding 100', numbered: true },
};

export async function POST(request: Request) {
  const body = await request.text();
  const sig = request.headers.get('stripe-signature');

  if (!sig || !WEBHOOK_SECRET) {
    console.error('Missing Stripe signature or webhook secret');
    return NextResponse.json({ error: 'Missing signature' }, { status: 400 });
  }

  let event;
  try {
    event = getStripe().webhooks.constructEvent(body, sig, WEBHOOK_SECRET);
  } catch (err: any) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  // ------------------------------------------------------------------
  // IDEMPOTENCY: Stripe retries webhooks up to 3 days. Dedupe via Stripe
  // Events table. Skip if event.id already processed.
  // ------------------------------------------------------------------
  try {
    const safeEventId = event.id.replace(/"/g, '\\"');
    const existing: any[] = await getAllRecords(STRIPE_EVENTS_TABLE, `{Event Id} = "${safeEventId}"`);
    if (existing.length > 0 && existing[0]['Status'] === 'processed') {
      return NextResponse.json({ ok: true, skipped: 'duplicate event' });
    }
    // Insert received row (status=received). Will flip to processed at end of handler.
    if (existing.length === 0) {
      await createRecord(STRIPE_EVENTS_TABLE, {
        'Event Id': event.id,
        'Event Type': event.type,
        'Account Id': (event as any).account || '',
        'Received At': new Date().toISOString(),
        'Status': 'received',
      });
    }
  } catch (e: any) {
    console.warn('[stripe webhook] idempotency check failed (continuing):', e?.message);
  }

  // ------------------------------------------------------------------
  // Convert legacy flat-if to switch so we can add multiple event types
  // (founder churn + invoice failures) without nesting.
  // ------------------------------------------------------------------
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as any;
      const metaType = session.metadata?.type;

      if (metaType === 'brand-listing') {
        // ── BRAND LISTING (Stage 1) ──
        // CRITICAL: do NOT return early — must reach end-of-handler idempotency
        // flip. Wrap in try/catch + break so processed-flip always fires.
        try {
          await handleBrandListingCompleted(session);
        } catch (err: any) {
          console.error('[stripe webhook] brand-listing handler failed:', err?.message);
          await flipStripeEventFailed(event.id, err?.message);
          return NextResponse.json({ received: true, error: 'logged' });
        }
        break;
      }

      if (metaType === 'founder-subscription' || metaType === 'founder-lifetime') {
        // ── FOUNDING HERD (Project 3) ──
        // CRITICAL: do NOT return early — must reach end-of-handler idempotency
        // flip. Wrap in try/catch + break so processed-flip always fires.
        try {
          await handleFounderCheckoutCompleted(session, metaType);
        } catch (err: any) {
          console.error('[stripe webhook] founder-checkout handler failed:', err?.message);
          await flipStripeEventFailed(event.id, err?.message);
          return NextResponse.json({ received: true, error: 'logged' });
        }
        break;
      }

      // Unknown metadata.type — accept the webhook but no-op.
      break;
    }

    case 'customer.subscription.created': {
      const sub = event.data.object as any;
      try {
        await handleTierSubscriptionUpsert(sub);
      } catch (err: any) {
        console.error('[stripe webhook] subscription.created handler error:', err?.message);
        await flipStripeEventFailed(event.id, err?.message);
        return NextResponse.json({ received: true, error: 'logged' });
      }
      break;
    }

    case 'customer.subscription.updated': {
      const sub = event.data.object as any;
      try {
        await handleTierSubscriptionUpsert(sub);
      } catch (err: any) {
        console.error('[stripe webhook] subscription.updated handler error:', err?.message);
        await flipStripeEventFailed(event.id, err?.message);
        return NextResponse.json({ received: true, error: 'logged' });
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object as any;
      // ── Stage-3 tier subscription deletion ──
      // If the sub has a customer_account (V2 rancher sub), handle as tier cancellation.
      if (sub.customer_account) {
        try {
          await handleTierSubscriptionDeleted(sub);
        } catch (err: any) {
          console.error('[stripe webhook] tier subscription.deleted handler error:', err?.message);
          await flipStripeEventFailed(event.id, err?.message);
          return NextResponse.json({ received: true, error: 'logged' });
        }
        break;
      }
      // ── Legacy Founders Herd cancellation ──
      try {
        await markSubscriptionCancelled(sub.id);
      } catch (e) {
        console.error('Error handling subscription.deleted:', e);
      }
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object as any;
      try {
        await alertInvoicePaymentFailed(invoice);
      } catch (e) {
        console.error('Error handling invoice.payment_failed:', e);
      }
      break;
    }

    // ── Task 6b — buyer deposit settlement (tier_v2 Connect direct charge) ──
    // PaymentIntent metadata.type='buyer_deposit' is stamped by
    // lib/stripeConnect.createDepositCheckout. Fires on the Connect account
    // (event.account=acct_*). Idempotency is double-guarded by the Stripe
    // Events table at the top of this handler AND markDepositSucceeded's
    // own status check.
    case 'payment_intent.succeeded': {
      const pi = event.data.object as any;
      const metaType = pi?.metadata?.type;
      if (metaType !== 'buyer_deposit') {
        // Other PI succeeded events (founder one-shots, brand listings)
        // flow through checkout.session.completed. Skip.
        break;
      }
      try {
        const referralId = String(pi.metadata?.referralId || '');
        const rancherId = String(pi.metadata?.rancherId || '');
        const tier = String(pi.metadata?.tier || '');
        const amountCents = Number(pi.amount || 0);

        if (!referralId || !rancherId || !pi.id) {
          throw new Error(`buyer_deposit missing metadata (refId=${!!referralId}, rancherId=${!!rancherId}, piId=${!!pi.id})`);
        }

        // Flip Payments row pending → succeeded (idempotent — no-op on retry).
        await markDepositSucceeded(pi.id);

        // Flip Referral → Closed Won. Deposit = sale for tier_v2 (Connect direct
        // charge already captured funds; payout split happens on fulfillment
        // confirm via Task 9). recordClose decrements rancher capacity + flips
        // Buyer Stage to CLOSED + closes Threads.
        await recordClose({
          referralId,
          rancherId,
          outcome: 'won',
          saleAmount: amountCents / 100,
        });

        // Telegram celebration to admin chat.
        try {
          await sendTelegramMessage(
            TELEGRAM_ADMIN_CHAT_ID,
            `💰 DEPOSIT PAID — $${(amountCents / 100).toFixed(2)} (${tier} tier, ref=${referralId.slice(-6)})`,
          );
        } catch (e: any) {
          console.warn('[stripe webhook] telegram deposit alert failed:', e?.message);
        }
      } catch (e: any) {
        console.error('[stripe webhook] payment_intent.succeeded (buyer_deposit) failed:', e);
        await flipStripeEventFailed(event.id, e?.message || 'unknown');
        // 200 to Stripe — don't retry on a code bug (Stripe Events row is now
        // 'failed' so manual replay is possible). Returning 500 would create
        // a retry storm against a guaranteed-broken handler.
        return NextResponse.json({ received: true });
      }
      break;
    }

    case 'payment_intent.payment_failed': {
      const pi = event.data.object as any;
      const metaType = pi?.metadata?.type;
      if (metaType !== 'buyer_deposit') break;
      try {
        const errMsg = pi?.last_payment_error?.message || pi?.last_payment_error?.code || 'unknown';
        const referralId = String(pi.metadata?.referralId || '?');
        const tier = String(pi.metadata?.tier || '?');
        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          `⚠️ DEPOSIT FAILED — ${tier} tier, ref=${referralId.slice(-6)}, reason: ${errMsg}`,
        );
      } catch (e: any) {
        console.error('[stripe webhook] payment_intent.payment_failed handler:', e);
      }
      break;
    }

    case 'charge.refunded': {
      // Refund on a buyer deposit. Find the parent PI, flip Payments row to refunded.
      const charge = event.data.object as any;
      const metaType = charge?.metadata?.type || charge?.payment_intent_metadata?.type;
      // For Connect direct charges the metadata is on the parent PI, not the charge.
      // We can't always inspect both from a single webhook payload; if charge metadata
      // isn't present, fall back to checking payment_intent string + looking up the row.
      const piId = typeof charge?.payment_intent === 'string' ? charge.payment_intent : '';
      if (!piId) break;
      try {
        // If we have an existing Payments row keyed by this PI ID, refund it.
        await markDepositRefunded(piId);
        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          `↩️ Deposit refunded — PI ${piId.slice(-8)}`,
        );
      } catch (e: any) {
        console.warn('[stripe webhook] charge.refunded handler:', e?.message);
      }
      break;
    }

    case 'invoice.paid': {
      // Rancher commission invoice paid via Stripe hosted page (or via card-on-file).
      // metadata.type='commission-invoice' + metadata.referralId stamped at
      // creation in lib/stripe-commission.ts. Other invoice.paid events
      // (founder subscriptions, brand listings) flow through their own paths
      // so we early-out unless metadata.type matches.
      const inv = event.data.object as any;
      try {
        // ── Add-On purchase settlement ──
        if (inv?.metadata?.addOnPurchaseId) {
          const addOnId: string = inv.metadata.addOnPurchaseId;
          await updateRecord('Add-On Purchases', addOnId, { 'Status': 'paid' });
          console.log(`[stripe webhook] add-on purchase ${addOnId} marked paid`);
        }

        // ── Tier subscription renewal invoice — no-op (subscription.updated handles status) ──
        if (inv?.subscription) {
          console.log('[stripe webhook] subscription invoice paid (no-op):', inv.id);
          // intentional no-op — subscription.updated event carries status changes
        }

        // ── Legacy commission invoice ──
        if (inv?.metadata?.type === 'commission-invoice') {
          await handleCommissionInvoicePaid(inv);
        }
      } catch (e) {
        console.error('Error handling invoice.paid:', e);
      }
      break;
    }

    default:
      // Ignore unhandled event types — Stripe sends many we don't care about.
      break;
  }

  // ------------------------------------------------------------------
  // IDEMPOTENCY: flip Stripe Events row to processed.
  // ------------------------------------------------------------------
  try {
    const safeEventId = event.id.replace(/"/g, '\\"');
    const eventRows: any[] = await getAllRecords(STRIPE_EVENTS_TABLE, `{Event Id} = "${safeEventId}"`);
    if (eventRows[0]) {
      await updateRecord(STRIPE_EVENTS_TABLE, eventRows[0].id, {
        'Status': 'processed',
        'Processed At': new Date().toISOString(),
      });
    }
  } catch (e: any) {
    console.warn('[stripe webhook] idempotency processed-flip failed:', e?.message);
  }

  return NextResponse.json({ received: true });
}

// ============================================================================
// Brand listing handler — the original Stage 1 flow, isolated unchanged.
// ============================================================================
async function handleBrandListingCompleted(session: any) {
  const { brandId, brandName } = session.metadata || {};
  if (!brandId) return NextResponse.json({ received: true });

  try {
    await updateRecord(TABLES.BRANDS, brandId, {
      'Payment Status': 'Paid',
      'Featured': true,
      'Stripe Session ID': session.id,
      'Paid At': new Date().toISOString(),
      'Amount Paid': (session.amount_total || 0) / 100,
    });

    if (session.customer_email) {
      await sendBrandListingConfirmation({
        brandName: brandName || 'Your Brand',
        email: session.customer_email,
        amountPaid: `$${((session.amount_total || 0) / 100).toFixed(0)}`,
      });
    }

    try {
      const { sendTelegramUpdate } = await import('@/lib/telegram');
      await sendTelegramUpdate(
        `💰 <b>Brand Payment Received</b>\n\n` +
          `🏷️ <b>${brandName}</b>\n` +
          `📧 ${session.customer_email}\n` +
          `💵 $${((session.amount_total || 0) / 100).toFixed(0)}\n\n` +
          `✅ Brand is now LIVE and featured to all members.`
      );
    } catch (e) {
      console.error('Telegram brand payment notification error:', e);
    }

    console.log(`Brand ${brandId} payment completed — now featured`);
  } catch (error) {
    // Audit finding 2026-05-20 #6: previously returned 500 → Stripe retries
    // 3× → triple founder welcomes + triple Telegram alerts. Now: log the
    // error + return 200 so Stripe stops. Idempotency on session_id (see
    // handleFounderCheckoutCompleted) catches any future retries.
    console.error('Error processing brand payment webhook (returning 200 to stop retries):', error);
    return NextResponse.json({ received: true, error: 'logged' });
  }

  return NextResponse.json({ received: true });
}

// ============================================================================
// Founding Herd handler — subscription + lifetime tiers.
// ============================================================================
//
// Idempotency model — single biggest launch-day defense:
//   1. Look up Consumers by `Stripe Session ID`. If a row already has it set,
//      we already processed this event — return 200 and skip everything.
//   2. Pre-compute the Founder Number (Founding 100 / Title Founder only) from
//      a live Airtable count.
//   3. Upsert the Consumer row (match by email if it exists; otherwise create).
//      Setting `Stripe Session ID` here is the lock — a second concurrent
//      delivery falls into branch (1) on its own write loop.
//   4. Send tier-aware welcome email. If `Founder Welcome Sent At` is already
//      populated, we skip the send (defense-in-depth against retries that
//      somehow bypassed the session lock).
//   5. Telegram alert.
//   6. Set `Founder Welcome Sent At` LAST so the email never double-fires.
async function handleFounderCheckoutCompleted(session: any, metaType: string) {
  const sessionId: string = session.id;
  const tierKey: string = (session.metadata?.tier || '').toString().toLowerCase();
  const mapped = TIER_MAP[tierKey];

  if (!mapped) {
    console.warn(`Founder webhook: unknown tier metadata '${tierKey}', skipping.`);
    return NextResponse.json({ received: true });
  }

  // Email — Stripe Payment Links return on `customer_details.email`; Checkout
  // sessions surface it on `customer_email`. Fall back to the latter for safety.
  const email: string =
    (session.customer_details?.email || session.customer_email || '').toString().trim();

  if (!email) {
    console.error('Founder webhook: no email on session', sessionId);
    return NextResponse.json({ received: true });
  }

  // ── 1. IDEMPOTENCY CHECK (5 LOC, mandatory) ──
  // If any Consumer already has this Stripe Session ID, this event is a retry.
  const existing = await getAllRecords(
    TABLES.CONSUMERS,
    `{Stripe Session ID} = "${escapeAirtableValue(sessionId)}"`
  );
  if (existing.length > 0) {
    console.log(`Founder webhook: session ${sessionId} already processed — skipping.`);
    return NextResponse.json({ received: true, idempotent: true });
  }

  const customerId: string = session.customer || '';
  const subscriptionId: string = session.subscription || '';
  const amountPaidCents: number = session.amount_total || 0;
  const amountPaid = amountPaidCents / 100;
  const nowIso = new Date().toISOString();
  const firstName = (
    session.customer_details?.name ||
    session.metadata?.firstName ||
    ''
  )
    .toString()
    .split(' ')[0] || 'there';

  // ── 2. Founder Number (Founding 100 / Title Founder only) ──
  // Atomic counter via Upstash Redis INCR. Race-safe under concurrent
  // webhook bursts (e.g. viral founders push). Falls back to legacy
  // Airtable count-then-add if Redis unset.
  let founderNumber: number | undefined;
  if (mapped.numbered) {
    const { assignFounderNumber } = await import('@/lib/founderNumber');
    const assigned = await assignFounderNumber(mapped.tier);
    if (assigned > 0) founderNumber = assigned;
  }

  // ── 3. Upsert Consumer row ──
  // Match by email so a Founder who's also a buyer keeps one row. NEVER
  // touch Buyer Stage / Buyer Stage Updated At — the two state machines are
  // orthogonal per Stage 1 changelog Section 2.
  const founderFields: any = {
    'Founder Tier': mapped.tier,
    'Stripe Session ID': sessionId,
    'Subscribed At': nowIso,
    'Tier Amount Paid': amountPaid,
    'Backer Type': session.metadata?.backerType === 'Brand' ? 'Brand' : 'Individual',
  };
  if (customerId) founderFields['Stripe Customer ID'] = customerId;
  if (subscriptionId) {
    founderFields['Stripe Subscription ID'] = subscriptionId;
    founderFields['Subscription Status'] = 'active';
  }
  if (typeof founderNumber === 'number') founderFields['Founder Number'] = founderNumber;
  // Wall opt-in ships from the Stripe custom field if collected; otherwise
  // default-true for paid tiers above Herd (the spec's display-by-default rule).
  const wallOptInRaw = (session.metadata?.wallOptIn || '').toString().toLowerCase();
  founderFields['Wall Opt-In'] =
    wallOptInRaw === 'true' || wallOptInRaw === 'yes' || mapped.tier !== 'Herd';

  let consumerId: string;
  let alreadyHadWelcome = false;
  try {
    const byEmail = await getAllRecords(
      TABLES.CONSUMERS,
      `LOWER({Email}) = "${escapeAirtableValue(email.toLowerCase())}"`
    );
    if (byEmail.length > 0) {
      const row: any = byEmail[0];
      consumerId = row.id;
      alreadyHadWelcome = !!row['Founder Welcome Sent At'];
      await updateRecord(TABLES.CONSUMERS, consumerId, founderFields);
    } else {
      // Use the customer's full name from Stripe if Stripe gave us one, else
      // fall back to the firstName-only string. `Full Name` is the real
      // Consumers field — there is no `First Name` column.
      const fullName = (
        session.customer_details?.name ||
        session.metadata?.fullName ||
        firstName
      ).toString();
      const created = await createRecord(TABLES.CONSUMERS, {
        ...founderFields,
        Email: email,
        'Full Name': fullName,
        Source: 'founders-page',
        Status: 'Approved',
      });
      consumerId = (created as any).id;
    }
  } catch (e) {
    console.error('Founder upsert failed:', e);
    // Return 200 instead of 500 to stop Stripe retry storms (3× → triple
    // welcomes + alerts). Idempotency via Stripe Session ID prevents
    // double-processing on retry anyway. Audit finding 2026-05-20 #6.
    console.error('[stripe-webhook] founder upsert failed (returning 200 to stop retries)');
    return NextResponse.json({ received: true, error: 'logged' });
  }

  // ── 4. Welcome email (skip if already sent — defense in depth) ──
  if (!alreadyHadWelcome) {
    try {
      await sendFoundingHerdWelcome({
        tier: mapped.tier,
        firstName,
        email,
        founderNumber,
        amountPaid,
      });
    } catch (e) {
      console.error('Founder welcome email failed:', e);
      // fall through — Telegram still fires
    }
  }

  // ── 5. Telegram alert with action buttons ──
  try {
    const { sendTelegramFounderBacker } = await import('@/lib/telegram');
    await sendTelegramFounderBacker({
      email,
      name: firstName,
      tier: mapped.tier,
      founderNumber,
      amountCents: Math.round(amountPaid * 100),
      isLifetime: metaType === 'founder-lifetime',
      consumerId,
    });
  } catch (e) {
    console.error('Telegram founder notification error:', e);
  }

  // ── 6. Set Founder Welcome Sent At LAST (idempotency for email retries) ──
  if (!alreadyHadWelcome) {
    try {
      await updateRecord(TABLES.CONSUMERS, consumerId, {
        'Founder Welcome Sent At': new Date().toISOString(),
      });
    } catch (e) {
      console.error('Failed to set Founder Welcome Sent At:', e);
    }
  }

  return NextResponse.json({ received: true, founderNumber });
}

// ============================================================================
// Subscription churn — flips status to cancelled, alerts Ben.
// ============================================================================
async function markSubscriptionCancelled(subscriptionId: string) {
  if (!subscriptionId) return;
  const matches = await getAllRecords(
    TABLES.CONSUMERS,
    `{Stripe Subscription ID} = "${escapeAirtableValue(subscriptionId)}"`
  );
  if (matches.length === 0) return;
  const row: any = matches[0];
  try {
    await updateRecord(TABLES.CONSUMERS, row.id, {
      'Subscription Status': 'cancelled',
    });
  } catch (e) {
    console.error('Failed to mark subscription cancelled:', e);
  }
  try {
    const { sendTelegramSubscriptionCancelled } = await import('@/lib/telegram');
    await sendTelegramSubscriptionCancelled({
      email: (row['Email'] as string) || '(no email)',
      name: (row['Full Name'] as string) || (row['First Name'] as string) || '',
      tier: (row['Founder Tier'] as string) || '(no tier)',
      consumerId: row.id,
    });
  } catch (e) {
    console.error('Telegram churn notification error:', e);
  }
}

// ============================================================================
// Invoice payment_failed — Telegram only (no DB write yet — past_due is set
// by Stripe on the subscription object, which fires its own update event we
// can wire later if needed).
// ============================================================================
async function alertInvoicePaymentFailed(invoice: any) {
  try {
    const { sendTelegramInvoiceFailed } = await import('@/lib/telegram');
    // Best-effort tier lookup via subscription ID. If miss, blank fine.
    let tier = '(unknown tier)';
    if (invoice.subscription) {
      try {
        const matches = await getAllRecords(
          TABLES.CONSUMERS,
          `{Stripe Subscription ID} = "${escapeAirtableValue(invoice.subscription)}"`
        );
        if (matches.length > 0) {
          tier = ((matches[0] as any)['Founder Tier'] as string) || tier;
        }
      } catch {}
    }
    await sendTelegramInvoiceFailed({
      email: invoice.customer_email || '(no email)',
      name: invoice.customer_name || '',
      tier,
      amountCents: invoice.amount_due || 0,
    });
  } catch (e) {
    console.error('Telegram invoice-failed notification error:', e);
  }

  // Best-effort flip Subscription Status → past_due on the matching row.
  if (invoice.subscription) {
    try {
      const matches = await getAllRecords(
        TABLES.CONSUMERS,
        `{Stripe Subscription ID} = "${escapeAirtableValue(invoice.subscription)}"`
      );
      if (matches.length > 0) {
        await updateRecord(TABLES.CONSUMERS, (matches[0] as any).id, {
          'Subscription Status': 'past_due',
        });
      }
    } catch (e) {
      console.error('Failed to mark past_due:', e);
    }
  }
}

// ============================================================================
// COMMISSION INVOICE PAID — rancher settles their 10% on a Closed Won deal
// ============================================================================
async function handleCommissionInvoicePaid(invoice: any) {
  const referralId =
    invoice?.metadata?.referralId ||
    invoice?.lines?.data?.[0]?.metadata?.referralId ||
    '';
  const rancherId = invoice?.metadata?.rancherId || '';
  const amountPaidCents: number = invoice?.amount_paid || 0;
  const amountPaidDollars = amountPaidCents / 100;

  if (!referralId) {
    console.warn('[stripe webhook] commission invoice paid without referralId metadata:', invoice.id);
    return;
  }

  // Mark the referral as commission paid + persist amount + paid date.
  // Tolerate a missing record id — Stripe might fire a delayed event after
  // we've archived/restructured. Log AND track the failure so Telegram
  // celebrates honestly (was: silent swallow + lying celebration).
  let airtableWriteOk = true;
  let airtableWriteError = '';
  try {
    await updateRecord(TABLES.REFERRALS, referralId, {
      'Commission Paid': true,
      'Commission Paid At': new Date().toISOString(),
      'Stripe Invoice URL': invoice.hosted_invoice_url || '',
    });
  } catch (e: any) {
    airtableWriteOk = false;
    airtableWriteError = e?.message || 'unknown';
    console.error('[stripe webhook] mark commission paid failed:', airtableWriteError);
  }

  // Telegram celebration — same chat that gets sale alerts. MISMATCH FIX:
  // surface Airtable write status in the message so operator knows whether
  // the DB actually reflects the Stripe-confirmed payment.
  try {
    if (TELEGRAM_ADMIN_CHAT_ID) {
      let rancherLine = '';
      let buyerLine = '';
      try {
        const ref: any = await getRecordById(TABLES.REFERRALS, referralId);
        if (ref) {
          buyerLine = `\n👤 ${ref['Buyer Name'] || 'Unknown'}`;
        }
      } catch {
        /* non-fatal */
      }
      if (rancherId) {
        try {
          const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);
          if (rancher) {
            rancherLine = `\n🤠 ${rancher['Operator Name'] || rancher['Ranch Name'] || ''}`;
          }
        } catch {
          /* non-fatal */
        }
      }
      const statusFooter = airtableWriteOk
        ? `<i>Stripe invoice ${invoice.id}. Referral marked Commission Paid.</i>`
        : `⚠️ <b>AIRTABLE WRITE FAILED</b> — Stripe confirms paid but Referral row NOT updated. Fix Referral ${referralId} manually.\n<i>Error: ${airtableWriteError.slice(0, 150)}</i>`;
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `💰 <b>COMMISSION PAID</b>\n\n` +
          `<b>$${amountPaidDollars.toFixed(2)}</b> just landed in BHC's Stripe.` +
          rancherLine +
          buyerLine +
          `\n\n${statusFooter}`
      );
    }
  } catch (e: any) {
    console.error('[stripe webhook] commission-paid telegram alert failed:', e?.message);
  }
}

// ============================================================================
// TIER SUBSCRIPTION UPSERT — handles subscription.created + subscription.updated
// Writes tier, subscription status, commission rate etc. to the Ranchers row.
// ============================================================================
async function handleTierSubscriptionUpsert(sub: any): Promise<void> {
  // V2: sub.customer_account is the acct_* connected account id
  const { connectedAccountId } = rancherIdFromSubscription(sub);

  // Prefer metadata.rancherId if available (set in Task 4 checkout); fall back
  // to a lookup by Stripe Connect Account Id.
  let rancherRecordId: string = sub.metadata?.rancherId || '';

  if (!rancherRecordId) {
    if (!connectedAccountId) {
      console.warn('[stripe webhook] tier sub upsert: no customer_account and no rancherId metadata — skipping');
      return;
    }
    const matches: any[] = await getAllRecords(
      TABLES.RANCHERS,
      `{Stripe Connect Account Id} = "${escapeAirtableValue(connectedAccountId)}"`
    );
    if (matches.length === 0) {
      console.warn(`[stripe webhook] tier sub upsert: no rancher found for acct ${connectedAccountId}`);
      return;
    }
    rancherRecordId = matches[0].id as string;
  }

  // Tier from metadata (lowercase: 'pasture' | 'ranch' | 'operator')
  const tierSlug = (sub.metadata?.tier || '').toLowerCase() as TierSlug;
  if (!tierSlug || !['pasture', 'ranch', 'operator'].includes(tierSlug)) {
    console.warn(`[stripe webhook] tier sub upsert: unknown tier slug "${tierSlug}" on sub ${sub.id}`);
    return;
  }

  const tierLabel = tierSlug.charAt(0).toUpperCase() + tierSlug.slice(1); // Pasture / Ranch / Operator
  const commissionRate = commissionRateForTier(tierSlug);
  const nextInvoiceAt = sub.current_period_end
    ? new Date(sub.current_period_end * 1000).toISOString()
    : null;

  const fields: Record<string, any> = {
    'Tier': tierLabel,
    'Stripe Subscription Id': sub.id,
    'Subscription Status': sub.status,
    'Subscription Started At': new Date(sub.start_date * 1000).toISOString(),
    'Commission Rate': commissionRate,
    'Commission Rate Locked At': new Date().toISOString(),
  };
  if (nextInvoiceAt !== null) {
    fields['Subscription Next Invoice At'] = nextInvoiceAt;
  }

  await updateRecord(TABLES.RANCHERS, rancherRecordId, fields);
  console.log(`[stripe webhook] tier sub upsert: rancher ${rancherRecordId} → tier=${tierLabel}, status=${sub.status}`);
}

// ============================================================================
// TIER SUBSCRIPTION DELETED — clears tier + sub id, marks canceled.
// Preserves Commission Rate + Commission Rate Locked At as historical record.
// ============================================================================
async function handleTierSubscriptionDeleted(sub: any): Promise<void> {
  const { connectedAccountId } = rancherIdFromSubscription(sub);

  if (!connectedAccountId) {
    console.warn('[stripe webhook] tier sub deleted: no customer_account — skipping');
    return;
  }

  const matches: any[] = await getAllRecords(
    TABLES.RANCHERS,
    `{Stripe Connect Account Id} = "${escapeAirtableValue(connectedAccountId)}"`
  );
  if (matches.length === 0) {
    console.warn(`[stripe webhook] tier sub deleted: no rancher found for acct ${connectedAccountId}`);
    return;
  }

  const rancherRecordId: string = matches[0].id;
  await updateRecord(TABLES.RANCHERS, rancherRecordId, {
    'Subscription Status': 'canceled',
    'Tier': 'None',
    'Stripe Subscription Id': '',
    // Commission Rate + Commission Rate Locked At intentionally NOT cleared
    // — keep as historical record of the rancher's last tier.
  });
  console.log(`[stripe webhook] tier sub deleted: rancher ${rancherRecordId} marked canceled`);
}

// ============================================================================
// IDEMPOTENCY FAILURE HELPER — flips a Stripe Events row to failed.
// ============================================================================
async function flipStripeEventFailed(eventId: string, errorMessage: string): Promise<void> {
  try {
    const safeEventId = eventId.replace(/"/g, '\\"');
    const eventRows: any[] = await getAllRecords(STRIPE_EVENTS_TABLE, `{Event Id} = "${safeEventId}"`);
    if (eventRows[0]) {
      await updateRecord(STRIPE_EVENTS_TABLE, eventRows[0].id, {
        'Status': 'failed',
        'Error': (errorMessage || 'unknown').slice(0, 500),
      });
    }
  } catch (e: any) {
    console.warn('[stripe webhook] flipStripeEventFailed — could not update Stripe Events row:', e?.message);
  }
}

