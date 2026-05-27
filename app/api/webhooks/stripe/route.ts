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
import { sendBrandListingConfirmation, sendFoundingHerdWelcome, sendPostPurchaseWelcome } from '@/lib/email';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { commissionRateForTier, TierSlug } from '@/lib/tiers';
import { rancherIdFromSubscription } from '@/lib/stripeSubscription';
import { markDepositSucceeded, markDepositRefunded, PAYMENTS_TABLE } from '@/lib/contracts/payments';
import { recordClose } from '@/lib/contracts/rancher';
import { funnelRecord } from '@/lib/funnelMetrics';
import { fireCapi, buildUserData } from '@/lib/metaCapi';
import { logAuditEntry } from '@/lib/auditLog';

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

      if (metaType === 'brand-partner-tier') {
        // ── BRAND PARTNER TIERS (Audit F1 — was the highest $$$ leak) ──
        // Spotlight ($295) / Featured ($595) / Co-marketed ($1500). Pre-F1 these
        // fired with no metadata.type the webhook recognized — money landed in
        // Stripe with ZERO Airtable row, no welcome, no funnel event.
        try {
          await handleBrandPartnerTierCompleted(session);
        } catch (err: any) {
          console.error('[stripe webhook] brand-partner-tier handler failed:', err?.message);
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
          const metadataKeys = Object.keys(pi.metadata || {}).join(',');
          throw new Error(`buyer_deposit missing required ids — refId=${!!referralId} rancherId=${!!rancherId} piId=${!!pi.id} actualMetadataKeys=[${metadataKeys}]`);
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

        // ── Funnel event — deposit_paid (largest LTV event on platform) ──
        // P0 audit fix: brand-partner + founder flows BOTH fire funnel +
        // CAPI Purchase; buyer deposit (highest-value conversion) didn't.
        // Without this row the admin conversion dashboard can't see deposit
        // closes — and CAPI Purchase below is invisible to Meta = no paid-ad
        // optimization on the most valuable event.
        const amountDollars = amountCents / 100;
        try {
          await funnelRecord({
            stage: 'deposit_paid',
            referralId,
            rancherId,
            amount: amountDollars,
            metadata: {
              tier,
              paymentIntentId: pi.id,
            },
          });
        } catch (e: any) {
          console.warn('[stripe webhook] funnel deposit_paid record failed:', e?.message);
        }

        // Buyer post-purchase welcome — closes the "you bought" loop with
        // a warm BHC-branded email (cuts education preview, freezer prep,
        // pickup/delivery timeline). Mirrors the legacy quick-action(won)
        // path which fires this email on close; without this, tier_v2 buyers
        // would only get Stripe's generic receipt + the Day-14 cuts email
        // weeks later — missing the immediate confirmation moment.
        // Best-effort: failure does NOT roll back the close.
        // Also: reuse the fetched buyer below for Meta CAPI Purchase user_data.
        let buyerForCapi: { email?: string; firstName?: string; lastName?: string } = {};
        try {
          const referralRow: any = await getRecordById(TABLES.REFERRALS, referralId).catch(() => null);
          const buyerLinksForEmail: string[] = (referralRow?.['Buyer'] || []) as string[];
          const buyerIdForEmail = buyerLinksForEmail[0] || '';
          const buyer: any = buyerIdForEmail
            ? await getRecordById(TABLES.CONSUMERS, buyerIdForEmail).catch(() => null)
            : null;
          const rancherForEmail: any = await getRecordById(TABLES.RANCHERS, rancherId).catch(() => null);
          if (buyer?.['Email']) {
            const fullName = String(buyer['Full Name'] || '').trim();
            const nameParts = fullName.split(/\s+/);
            buyerForCapi = {
              email: String(buyer['Email']).toLowerCase(),
              firstName: nameParts[0] || undefined,
              lastName: nameParts.slice(1).join(' ') || undefined,
            };
            if (rancherForEmail) {
              await sendPostPurchaseWelcome({
                firstName: nameParts[0] || '',
                email: String(buyer['Email']),
                rancherName: String(rancherForEmail['Operator Name'] || rancherForEmail['Ranch Name'] || 'your rancher'),
                orderType: String(referralRow?.['Order Type'] || ''),
              });
            }
          }
        } catch (e: any) {
          console.warn('[stripe webhook] sendPostPurchaseWelcome failed:', e?.message);
        }

        // ── Meta Conversions API: server-side `Purchase` event ──────────
        // Largest paid-ad attribution event on the platform — buyer deposit
        // is the highest-LTV conversion. Pairs with client deposit_completed
        // Pixel fire via event_id=referralId (server has pi.id, client has
        // Stripe Checkout session_id — referralId is the only stable identifier
        // both surfaces share). E-1 + E-3 fixes ensure dedup actually works.
        // Fire-and-forget — never block.
        fireCapi([{
          event_name: 'Purchase',
          event_time: Math.floor(Date.now() / 1000),
          event_id: referralId,
          action_source: 'system_generated',
          user_data: buildUserData(buyerForCapi),
          custom_data: {
            value: amountDollars,
            currency: 'usd',
            content_name: `Beef deposit — ${tier || 'unknown'} tier`,
            content_category: 'buyer-deposit',
          },
        }]).catch((e) => console.error('[meta-capi] buyer_deposit Purchase fire failed:', e));

        // Telegram celebration to admin chat.
        try {
          await sendTelegramMessage(
            TELEGRAM_ADMIN_CHAT_ID,
            `💰 DEPOSIT PAID — $${(amountCents / 100).toFixed(2)} (${tier} tier, ref=${referralId.slice(-6)})`,
          );
        } catch (e: any) {
          console.warn('[stripe webhook] telegram deposit alert failed:', e?.message);
        }

        // H-3 audit fix: audit row on the deposit-paid webhook mutation.
        // Pre-fix the AI Audit Log only captured admin-triggered refunds —
        // buyer deposit success (highest-$$$ webhook write) was invisible.
        // Non-reversible: webhook-driven state can't be cleanly undone via
        // Airtable replay (would require Stripe-side refund).
        await logAuditEntry({
          actor: 'cron',
          tool: 'stripe-webhook-deposit-paid',
          targetType: 'Referral',
          targetId: referralId,
          args: { paymentIntentId: pi.id, tier, amountCents },
          result: { status: 'succeeded', amountDollars: amountCents / 100 },
          reverseAction: { type: 'noop', reason: 'Stripe-driven deposit settlement — cannot un-charge via Airtable' },
        }).catch(e => console.error('[audit] deposit-paid log failed:', e));
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
      // Refund on a charge. For Connect direct charges metadata lives on the
      // parent PaymentIntent, not the Charge — so we look up the Payments
      // row by PI id. markDepositRefunded returns flipped:false when no row
      // matches (founder lifetime refunds, brand listing refunds), so we
      // only fire the admin Telegram alert when an actual deposit row flipped.
      const charge = event.data.object as any;
      const piId = typeof charge?.payment_intent === 'string' ? charge.payment_intent : '';
      if (!piId) break;
      try {
        const { flipped } = await markDepositRefunded(piId);
        if (flipped) {
          await sendTelegramMessage(
            TELEGRAM_ADMIN_CHAT_ID,
            `↩️ Deposit refunded — PI ${piId.slice(-8)}`,
          );
        }
        // H-3 audit fix: refund mutations were invisible to the audit log
        // unless triggered via /api/admin/payments/refund. Stripe-dashboard
        // refunds, partial refunds, automatic dispute refunds — all silent.
        await logAuditEntry({
          actor: 'cron',
          tool: 'stripe-webhook-charge-refunded',
          targetType: 'Other',
          targetId: piId,
          args: { paymentIntentId: piId, chargeId: charge?.id, amount: (charge?.amount_refunded || 0) / 100 },
          result: { paymentsRowFlipped: flipped },
          reverseAction: { type: 'noop', reason: 'Stripe-driven refund — cannot un-refund via Airtable' },
        }).catch(e => console.error('[audit] charge-refunded log failed:', e));
      } catch (e: any) {
        console.warn('[stripe webhook] charge.refunded handler:', e?.message);
      }
      break;
    }

    // ── Audit F6 — dispute handlers ──
    // Pre-F6 the platform was silent on chargebacks: buyer disputes silently
    // debited the rancher bank + clawed back BHC's fee, and operators only
    // learned via the Stripe email. Now we stamp the Payments row + fire
    // a LOUD Telegram alert so ops can act fast (file evidence, refund
    // proactively, etc).
    case 'charge.dispute.created':
    case 'charge.dispute.funds_withdrawn':
    case 'charge.dispute.closed':
      try {
        await handleDispute(event);
      } catch (e: any) {
        console.warn('[stripe webhook] dispute handler:', e?.message);
      }
      break;

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
// BRAND PARTNER TIER (Spotlight / Featured / Co-marketed) — Audit F1.
//
// Pre-F1 these checkouts (Payment Links in Stripe Dashboard) fired
// checkout.session.completed with no metadata.type our switch recognized.
// Money landed in Stripe, but the BRANDS table had zero rows, no welcome
// email fired, no funnel event was logged, and no Telegram alert reached
// the operator chat. Highest $$$ leak on the platform.
//
// /api/checkout/brand was rewritten to create a Checkout Session with
// metadata.type='brand-partner-tier' so this handler can take over.
//
// Idempotency model — same shape as handleFounderCheckoutCompleted:
//   1. Look up BRANDS by `Stripe Session ID`. If hit → no-op (Stripe retry).
//   2. Otherwise look up by email — upsert (existing row gets fields filled
//      in, new row gets created).
//   3. Setting `Stripe Session ID` is the lock — second concurrent delivery
//      falls into branch (1) on its own write loop.
//   4. Welcome email + Telegram + funnel event — all best-effort, all
//      non-fatal so retries don't double-fire if any of them succeed but
//      a later one throws.
// ============================================================================
async function handleBrandPartnerTierCompleted(session: any) {
  const sessionId: string = session.id;
  const tier: string = (session.metadata?.tier || '').toString().toLowerCase();
  const tierName: string = (session.metadata?.tier_name || tier || 'Brand Partner').toString();

  // Email — Checkout Sessions surface it on customer_details.email; fall
  // back to top-level customer_email defensively.
  const email: string = (
    session.customer_details?.email ||
    session.customer_email ||
    ''
  )
    .toString()
    .trim()
    .toLowerCase();

  const name: string = (
    session.customer_details?.name ||
    session.metadata?.brandName ||
    ''
  ).toString();

  const amountPaidCents: number = session.amount_total || 0;
  const amountPaid = amountPaidCents / 100;
  const nowIso = new Date().toISOString();

  if (!email) {
    console.warn(`[brand-partner-tier] session ${sessionId} missing customer email — skipping`);
    return;
  }

  // ── 1. IDEMPOTENCY: skip if Stripe Session ID already booked ──
  const bySession = await getAllRecords(
    TABLES.BRANDS,
    `{Stripe Session ID} = "${escapeAirtableValue(sessionId)}"`,
  );
  if (bySession.length > 0) {
    console.log(`[brand-partner-tier] session ${sessionId} already processed — skipping`);
    return;
  }

  // Status: Founding for the $1500 co-marketed tier (treat as inner-circle
  // partner — kept for admin dashboard filtering). Other tiers = Active Partner.
  const partnerStatus = tier === 'founding' || tier === 'comarketed' ? 'Founding' : 'Active Partner';

  const sharedFields: Record<string, any> = {
    'Tier': tierName,
    'Amount Paid': amountPaid,
    'Stripe Session ID': sessionId,
    'Payment Status': 'Paid',
    'Paid At': nowIso,
    'Status': partnerStatus,
    'Featured': true,
  };

  // ── 2. Upsert by email so a Brand who's also a tier purchaser keeps one row ──
  let brandRecordId: string;
  try {
    const byEmail = await getAllRecords(
      TABLES.BRANDS,
      `LOWER({Email}) = "${escapeAirtableValue(email)}"`,
    );
    if (byEmail.length > 0) {
      brandRecordId = (byEmail[0] as any).id;
      await updateRecord(TABLES.BRANDS, brandRecordId, sharedFields);
    } else {
      const created = await createRecord(TABLES.BRANDS, {
        ...sharedFields,
        'Brand Name': name || email.split('@')[0],
        'Contact Name': name,
        'Email': email,
      });
      brandRecordId = (created as any).id;
    }
  } catch (e: any) {
    // Same defensive pattern as handleFounderCheckoutCompleted — return
    // without throwing so the top-level Stripe Events row still flips
    // to 'processed' and Stripe stops retrying. The Telegram alert below
    // will fire only if the upsert succeeded, which is the right shape
    // (no lying celebrations).
    console.error('[brand-partner-tier] upsert failed (returning, will be 200):', e?.message);
    throw e;
  }

  // ── 3. Welcome email — reuses Stage-1 Brand listing template. Same idea
  //      (welcome to the network), correct enough for tier purchasers. If
  //      we want tier-specific copy later, branch here on `tier`.
  try {
    await sendBrandListingConfirmation({
      brandName: name || email,
      email,
      amountPaid: `$${amountPaid.toFixed(0)}`,
    });
  } catch (e: any) {
    console.error('[brand-partner-tier] welcome email failed:', e?.message);
  }

  // ── 4. Telegram alert ──
  try {
    if (TELEGRAM_ADMIN_CHAT_ID) {
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `💰 <b>BRAND PARTNER — ${tierName}</b>\n\n` +
          `<b>$${amountPaid.toFixed(0)}</b> from ${name || '(no name)'} (${email})\n\n` +
          `<a href="https://dashboard.stripe.com/payments/${sessionId}">Stripe session</a>`,
      );
    }
  } catch (e: any) {
    console.warn('[brand-partner-tier] telegram alert failed:', e?.message);
  }

  // ── 5. Funnel event for the admin dashboard conversion view ──
  try {
    await funnelRecord({
      stage: 'brand_partner_tier_purchased',
      amount: amountPaid,
      metadata: {
        tier,
        tierName,
        brandRecordId,
        sessionId,
        email,
      },
    });
  } catch (e: any) {
    console.warn('[brand-partner-tier] funnel record failed:', e?.message);
  }

  // ── Meta Conversions API: server-side `Purchase` event ──────────────
  // Client Pixel loses 30-50% under iOS 14.5+ ATT + adblockers. Deduped
  // with the client Pixel via event_id=<stripeSessionId>. Fire-and-forget.
  const firstNameForCapi = name?.toString().trim().split(/\s+/)[0] || undefined;
  fireCapi([{
    event_name: 'Purchase',
    event_time: Math.floor(Date.now() / 1000),
    event_id: sessionId,
    action_source: 'system_generated',
    user_data: buildUserData({ email, firstName: firstNameForCapi }),
    custom_data: {
      value: amountPaid,
      currency: 'usd',
      content_name: `Brand Partner ${tierName}`,
      content_category: 'brand_partner',
    },
  }]).catch((e) => console.error('[meta-capi] brand partner purchase fire failed:', e));

  // H-3 audit fix: log brand partner tier purchase — Stripe-driven write,
  // was previously invisible to the audit trail.
  await logAuditEntry({
    actor: 'cron',
    tool: 'stripe-webhook-brand-partner-tier',
    targetType: 'Other',
    targetId: brandRecordId,
    args: { sessionId, tier, tierName, email },
    result: { amountPaid, partnerStatus },
    reverseAction: { type: 'noop', reason: 'Stripe-driven brand partner purchase — cannot un-charge via Airtable' },
  }).catch(e => console.error('[audit] brand-partner-tier log failed:', e));

  console.log(`[brand-partner-tier] ${tierName} ($${amountPaid}) booked for ${email} → brand ${brandRecordId}`);
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
    founderFields['Stripe Subscription Id'] = subscriptionId;
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

  // ── Meta Conversions API: server-side `Purchase` event ──────────────
  // Client Pixel loses 30-50% under iOS 14.5+ ATT + adblockers. Deduped
  // with the client Pixel via event_id=<stripeSessionId>. Fire-and-forget.
  fireCapi([{
    event_name: 'Purchase',
    event_time: Math.floor(Date.now() / 1000),
    event_id: sessionId,
    action_source: 'system_generated',
    user_data: buildUserData({ email, firstName }),
    custom_data: {
      value: amountPaid,
      currency: 'usd',
      content_name: `Founder ${mapped.tier}`,
      content_category: metaType === 'founder-lifetime' ? 'lifetime' : 'subscription',
    },
  }]).catch((e) => console.error('[meta-capi] founder purchase fire failed:', e));

  // H-3 audit fix: log founder checkout — was previously invisible.
  await logAuditEntry({
    actor: 'cron',
    tool: 'stripe-webhook-founder-checkout',
    targetType: 'Consumer',
    targetId: consumerId,
    args: { sessionId, tier: mapped.tier, metaType, email },
    result: { amountPaid, founderNumber, subscriptionId },
    reverseAction: { type: 'noop', reason: 'Stripe-driven founder purchase — cannot un-charge via Airtable' },
  }).catch(e => console.error('[audit] founder-checkout log failed:', e));

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
// STRIPE DISPUTE — chargeback handler (Audit F6).
// Fires on charge.dispute.{created,funds_withdrawn,closed}. For tier_v2
// direct charges this fires on the CONNECTED account; for platform charges
// (founder lifetime, brand listings) it fires on the PLATFORM. Identical
// handler lives on both webhook files since either could fire depending on
// charge type.
//
// We look up the Payments row by Stripe Payment Intent Id (the field
// recordDeposit() actually populates), not by Charge ID. dispute.payment_intent
// gives us the link; for non-tier_v2 charges no Payments row will match and
// the Airtable update is skipped — but the Telegram alert ALWAYS fires.
// ============================================================================
async function handleDispute(event: any): Promise<void> {
  const dispute = event.data.object as any;
  const chargeId: string =
    typeof dispute?.charge === 'string' ? dispute.charge : dispute?.charge?.id || '';
  const piId: string =
    typeof dispute?.payment_intent === 'string'
      ? dispute.payment_intent
      : dispute?.payment_intent?.id || '';
  const amount = (dispute?.amount || 0) / 100;
  const reason = dispute?.reason || 'unknown';
  const status = dispute?.status || 'unknown';
  const eventType = event.type;

  // Try to find the Payments row (tier_v2 deposits only). Look up by PI id
  // since that's what recordDeposit() stores. For founder lifetime / brand
  // listing charges, no row will match — that's fine, we still alert.
  let paymentRecordId: string | null = null;
  if (piId) {
    try {
      const safePi = piId.replace(/"/g, '\\"');
      const rows: any[] = await getAllRecords(
        PAYMENTS_TABLE,
        `{Stripe Payment Intent Id} = "${safePi}"`,
      );
      if (rows.length > 0) {
        const rowId: string = rows[0].id;
        paymentRecordId = rowId;
        await updateRecord(PAYMENTS_TABLE, rowId, {
          'Dispute Status': status,
          'Dispute Amount': amount,
          'Dispute Reason': reason,
          'Dispute Updated At': new Date().toISOString(),
        });
      }
    } catch (e: any) {
      console.error('[dispute] Airtable update failed:', e?.message);
    }
  }

  // LOUD Telegram alert — ops needs to act fast on disputes.
  try {
    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      `🚨 STRIPE DISPUTE — ${eventType}\n` +
        `Amount: $${amount}\n` +
        `Reason: ${reason}\n` +
        `Status: ${status}\n` +
        `Charge: ${chargeId}\n` +
        `Stripe: https://dashboard.stripe.com/payments/${chargeId}` +
        (paymentRecordId ? `\nPayments row: ${paymentRecordId}` : ''),
    );
  } catch (e: any) {
    console.warn('[dispute] telegram alert failed:', e?.message);
  }

  // H-3 audit fix: dispute writes were invisible. Log the chargeback so
  // ops can reconstruct the timeline post-mortem (created → withdrew →
  // closed). Non-reversible: dispute state lives in Stripe.
  await logAuditEntry({
    actor: 'cron',
    tool: `stripe-webhook-${eventType}`,
    targetType: 'Other',
    targetId: piId || chargeId || 'unknown',
    args: { paymentIntentId: piId, chargeId, eventType },
    result: { status, amount, reason, paymentRecordId },
    reverseAction: { type: 'noop', reason: 'Stripe-driven dispute — cannot un-dispute via Airtable' },
  }).catch(e => console.error('[audit] dispute log failed:', e));
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

