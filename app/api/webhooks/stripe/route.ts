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
import { sendEmail, sendBrandListingConfirmation, sendFoundingHerdWelcome } from '@/lib/email';
import { sendOperatorSignal } from '@/lib/operatorSignal';
import { commissionRateForTier, TierSlug } from '@/lib/tiers';
import { isCommissionRateFieldEmpty } from '@/lib/commission';
import { rancherIdFromSubscription } from '@/lib/stripeSubscription';
import { markDepositSucceeded, markDepositRefunded, markDepositDisputed, PAYMENTS_TABLE } from '@/lib/contracts/payments';
import { recordClose } from '@/lib/contracts/rancher';
import { funnelRecord } from '@/lib/funnelMetrics';
import { fireCapi, buildUserData } from '@/lib/metaCapi';
import { metaEventId } from '@/lib/analytics';
import { logAuditEntry } from '@/lib/auditLog';
import { settleBuyerDeposit, settleFinalInvoice, isPermanentSettlementError } from '@/lib/stripeSettlement';
import { settleBrokerDeposit } from '@/lib/brokerSettlement';
import { isBrokerRailMetadata } from '@/lib/brokerRail';

// Heaviest events (deposit/final-invoice settlement) do many sequential
// Airtable reads + writes plus a Stripe invoice call; the default function
// budget can be tight. 60s gives headroom so a slow Airtable batch can't
// truncate the handler before the idempotency processed-flip. Node runtime
// is already the default for this route (no edge export).
export const maxDuration = 60;

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
    // T5 (2026-06-10): Telegram alert on signature failure. If Stripe
    // rotates the webhook secret or the env var drifts, EVERY money
    // event silently 400s. 1 alert per 5 min so a real attack doesn't
    // flood Ben, but a misconfig surfaces in minutes.
    try {
      const { sendOperatorSignal } = await import('@/lib/operatorSignal');
      await sendOperatorSignal({
        urgency: 'loud',
        kind: 'system-error',
        summary: 'Stripe webhook SIGNATURE FAIL',
        detail: `${err.message?.slice(0, 200) || 'unknown'} — money events dropping. Verify STRIPE_WEBHOOK_SECRET in Vercel matches Stripe Dashboard.`,
        dedupeKey: 'stripe-sig-fail',
        dedupeWindowMs: 5 * 60 * 1000,
      });
    } catch {}
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

      if (metaType === 'reservation_hold') {
        // F7 — $49 reservation hold paid. Stamps Consumer record so
        // Cal booking gate clears + intro emails branch on hold-paid.
        try {
          const consumerId = session.metadata?.consumer_id as string | undefined;
          if (consumerId) {
            const { updateRecord, TABLES } = await import('@/lib/airtable');
            await updateRecord(TABLES.CONSUMERS, consumerId, {
              'Reservation Hold Paid At': new Date().toISOString(),
              'Reservation Hold Session Id': String(session.id || ''),
            });
            // F13 (Wave 1): operatorSignal, not raw Telegram — money-path
            // alerts must survive a Telegram outage (SMS/email failover +
            // dedupe live in the wrapper).
            await sendOperatorSignal({
              urgency: 'normal',
              kind: 'sale',
              summary: `Reservation hold paid — ${session.metadata?.buyer_name || session.customer_email || consumerId} — $${((session.amount_total || 0) / 100).toFixed(0)}`,
              detail: 'Cal booking unlocked.',
              dedupeKey: `reservation-hold-paid:${session.id}`,
            }).catch(() => {});
          }
        } catch (err: any) {
          console.error('[stripe webhook] reservation_hold handler failed:', err?.message);
        }
        break;
      }

      // (white_glove branch removed 2026-08-01: lib/whiteGlove.ts had zero
      // importers, so nothing could ever mint a session with that metadata —
      // lib + receiving branch deleted together.)

      // ── BROKER RAIL (the THIRD money model) ──────────────────────────────
      // Stripe delivers BOTH checkout.session.completed and
      // payment_intent.succeeded for the same broker charge. Handling both is
      // deliberate belt-and-suspenders — under the Clover apiVersion the PI is
      // created at pay time, so the session event can arrive first (or alone,
      // if the PI event is dropped). Double-settling is impossible: both paths
      // converge on markDepositSucceeded(pi.id), which no-ops once the Payments
      // row is 'succeeded', and every email/Telegram sits behind that anchor.
      if (isBrokerRailMetadata(session?.metadata)) {
        try {
          // Normalize the session into the PaymentIntent shape settlement
          // expects. amount_total is the charged total (the whole deposit).
          await settleBrokerDeposit({
            id: session.payment_intent ? String(session.payment_intent) : String(session.id || ''),
            amount: Number(session.amount_total || 0),
            metadata: session.metadata,
          });
        } catch (err: any) {
          console.error('[stripe webhook] broker checkout.session.completed failed:', err?.message);
          await flipStripeEventFailed(event.id, err?.message);
          if (isPermanentSettlementError(err)) {
            return NextResponse.json({ received: true, permanent: true });
          }
          return NextResponse.json({ error: 'settlement_retry' }, { status: 500 });
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
      const subMetaType = sub?.metadata?.type;
      // ── P4-A Gap 1: brand partner downgrade / status change ──
      // brand-partner-tier subs fire `updated` on every status flip (active →
      // past_due → canceled) and on tier downgrade (price_id change). Route
      // to dedicated handler so we mirror Brands.Subscription Status / Tier /
      // Active. Falls through to handleTierSubscriptionUpsert only when sub
      // is a rancher tier_v2 (has customer_account).
      if (subMetaType === 'brand-partner-tier') {
        try {
          await handleBrandPartnerSubscriptionUpdated(sub);
        } catch (err: any) {
          console.error('[stripe webhook] brand-partner subscription.updated handler error:', err?.message);
          await flipStripeEventFailed(event.id, err?.message);
          return NextResponse.json({ received: true, error: 'logged' });
        }
        break;
      }
      // ── P4-A Gap 2: backer (founder) subscription downgrade ──
      // founder-subscription subs (herd-monthly / outlaw-monthly / steward-*)
      // fire `updated` on tier downgrade. Mirror Consumers.Founder Tier.
      if (subMetaType === 'founder-subscription') {
        try {
          await handleFounderSubscriptionUpdated(sub);
        } catch (err: any) {
          console.error('[stripe webhook] founder subscription.updated handler error:', err?.message);
          await flipStripeEventFailed(event.id, err?.message);
          return NextResponse.json({ received: true, error: 'logged' });
        }
        break;
      }
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
      const subMetaType = sub?.metadata?.type;
      // ── P4-A Gap 1: brand partner cancellation ──
      // Fires when a brand cancels OR when their final dunning retry fails out.
      // Flip Brands.Subscription Status='canceled' + Active=false + Telegram alert.
      if (subMetaType === 'brand-partner-tier') {
        try {
          await handleBrandPartnerSubscriptionDeleted(sub);
        } catch (err: any) {
          console.error('[stripe webhook] brand-partner subscription.deleted handler error:', err?.message);
          await flipStripeEventFailed(event.id, err?.message);
          return NextResponse.json({ received: true, error: 'logged' });
        }
        break;
      }
      // ── P4-A Gap 2: backer (founder) subscription cancellation ──
      // founder-subscription subs (herd-monthly / outlaw-monthly / steward-*).
      // Flip Consumers.Subscription Status='canceled' + Founder Tier Cancelled At
      // (preserve Founder Tier value for back-compat — Wall placement, founder
      // number history). Telegram alert.
      if (subMetaType === 'founder-subscription') {
        try {
          await handleFounderSubscriptionDeleted(sub);
        } catch (err: any) {
          console.error('[stripe webhook] founder subscription.deleted handler error:', err?.message);
          await flipStripeEventFailed(event.id, err?.message);
          return NextResponse.json({ received: true, error: 'logged' });
        }
        break;
      }
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

      // ── Final invoice settlement (tier_v2 balance, rancher-initiated) ────
      // PaymentIntent metadata.type='final_invoice' is stamped by
      // lib/stripeConnect.createFinalInvoiceCheckout. Application_fee=0 —
      // 100% lands in rancher's Connect account. Triggers final Closed Won
      // state on the referral (deposit already moved it to Awaiting Payment
      // or similar terminal).
      if (metaType === 'final_invoice') {
        try {
          await settleFinalInvoice(pi);
        } catch (e: any) {
          console.error('[stripe webhook] payment_intent.succeeded (final_invoice) failed:', e);
          await flipStripeEventFailed(event.id, e?.message || 'unknown');
          // U1: retry TRANSIENT failures (Airtable 429 / timeout / read blip) so
          // a real settled payment doesn't orphan — settleFinalInvoice is
          // idempotent (Referral.Status==='Closed Won' short-circuits, and it
          // fails-closed on an unreadable referral). Only a PERMANENT failure
          // (malformed metadata) returns 200 to stop pointless 3-day redelivery.
          if (isPermanentSettlementError(e)) {
            return NextResponse.json({ received: true, permanent: true });
          }
          return NextResponse.json({ error: 'settlement_retry' }, { status: 500 });
        }
        break;
      }

      // ── BROKER RAIL settlement (the THIRD money model) ───────────────────
      // A plain charge on BHC's OWN account for a rancher who is represented,
      // not onboarded: no Connect, no application_fee, no payout. The whole
      // deposit is BHC's commission. Branch on the tamper-proof, Stripe-held
      // `rail` metadata (exact match) — NOT on metaType alone, so this can
      // never swallow a Connect deposit. See docs/BUSINESS-MODEL.md.
      if (isBrokerRailMetadata(pi?.metadata)) {
        try {
          await settleBrokerDeposit(pi);
        } catch (e: any) {
          console.error('[stripe webhook] payment_intent.succeeded (broker) failed:', e);
          await flipStripeEventFailed(event.id, e?.message || 'unknown');
          // Same retry contract as the other two rails: redeliver transient
          // failures (settleBrokerDeposit is idempotent at markDepositSucceeded),
          // stop redelivering permanent metadata faults.
          if (isPermanentSettlementError(e)) {
            return NextResponse.json({ received: true, permanent: true });
          }
          return NextResponse.json({ error: 'settlement_retry' }, { status: 500 });
        }
        break;
      }

      if (metaType !== 'buyer_deposit') {
        // Other PI succeeded events (founder one-shots, brand listings)
        // flow through checkout.session.completed. Skip.
        break;
      }
      try {
        await settleBuyerDeposit(pi);
      } catch (e: any) {
        console.error('[stripe webhook] payment_intent.succeeded (buyer_deposit) failed:', e);
        await flipStripeEventFailed(event.id, e?.message || 'unknown');
        // U1 (the deposit-orphan fix): a TRANSIENT failure here (Airtable 429 /
        // timeout flipping the Payments row) means the paid deposit did NOT
        // settle — the row is still 'pending' and the referral was never
        // stamped 'Deposit Paid At'. Returning 200 (the old behavior) told
        // Stripe never to retry, orphaning real money until a manual replay.
        // Return 5xx so Stripe redelivers and the deposit self-heals when the
        // blip clears. This is SAFE because settleBuyerDeposit throws ONLY
        // before/at its idempotency anchor (markDepositSucceeded's single row
        // flip) — every post-anchor side effect is try/caught or
        // fire-and-forget, so a redelivery can never double-settle or
        // double-notify. The orphan-checkout-reaper is the daily belt to this
        // suspenders. Only a PERMANENT failure (malformed metadata that can
        // never settle) returns 200 to stop pointless 3-day redelivery.
        if (isPermanentSettlementError(e)) {
          return NextResponse.json({ received: true, permanent: true });
        }
        return NextResponse.json({ error: 'settlement_retry' }, { status: 500 });
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
        // F13 (Wave 1): this is a balk moment — the buyer stood at the deposit
        // page and their card failed. Loud + failover so a Telegram outage
        // never hides it from the operator.
        await sendOperatorSignal({
          urgency: 'loud',
          kind: 'sale',
          summary: `DEPOSIT FAILED — ${tier} tier, ref=${referralId.slice(-6)}, reason: ${errMsg}`,
          ...(referralId !== '?' ? { refs: [{ type: 'referral' as const, id: referralId }] } : {}),
          dedupeKey: `deposit-failed:${pi.id}`,
        });
      } catch (e: any) {
        console.error('[stripe webhook] payment_intent.payment_failed handler:', e);
      }
      break;
    }

    // ── P3-A audit fix: SCA / 3DS challenge silently abandoned ──
    // When the buyer hits a 3DS challenge that they don't complete, the PI
    // sits in `requires_action` forever. Pre-fix the platform never alerted
    // and the Payments row never reflected this state, so deal looked "pending"
    // indefinitely on the admin surfaces. Now: flip Payments row to
    // `awaiting_auth` + LOUD Telegram so operator can DM/call the buyer.
    // We do NOT touch the Referral (deal isn't settled — Closed Won only on
    // payment_intent.succeeded).
    case 'payment_intent.requires_action': {
      const pi = event.data.object as any;
      const metaType = pi?.metadata?.type;
      if (metaType !== 'buyer_deposit') break;
      try {
        const referralId = String(pi.metadata?.referralId || '?');
        const tier = String(pi.metadata?.tier || '?');
        // Best-effort flip Payments row → awaiting_auth so the admin
        // Payments dashboard reflects the buyer-side blocker. Lookup by
        // Stripe Payment Intent Id (the only field guaranteed populated
        // at recordDeposit time). Status flip is best-effort — Telegram
        // alert always fires.
        try {
          const escaped = String(pi.id).replace(/"/g, '\\"');
          const rows: any[] = await getAllRecords(
            PAYMENTS_TABLE,
            `{Stripe Payment Intent Id} = "${escaped}"`,
          );
          if (rows.length > 0) {
            await updateRecord(PAYMENTS_TABLE, (rows[0] as any).id, {
              'Status': 'awaiting_auth',
            });
          }
        } catch (fieldErr: any) {
          // 'awaiting_auth' may not exist as a Status option in older
          // Airtable schemas. Log + continue so the Telegram alert fires.
          console.warn(
            `[stripe webhook] TODO: add 'awaiting_auth' to Payments.Status singleSelect — flip failed: ${fieldErr?.message || fieldErr}`,
          );
        }
        // F13 (Wave 1): balk moment (buyer stuck on 3DS) — loud + failover.
        await sendOperatorSignal({
          urgency: 'loud',
          kind: 'sale',
          summary: `DEPOSIT NEEDS AUTH — buyer hit 3DS challenge, ref=${referralId.slice(-6)}, ${tier} tier, PI ${String(pi.id).slice(-8)}`,
          ...(referralId !== '?' ? { refs: [{ type: 'referral' as const, id: referralId }] } : {}),
          dedupeKey: `deposit-needs-auth:${pi.id}`,
        });
      } catch (e: any) {
        console.error('[stripe webhook] payment_intent.requires_action handler:', e);
      }
      break;
    }

    // ── P3-A audit fix: ACH/bank-debit failure path ──
    // checkout.session.async_payment_failed fires when an ACH/bank debit
    // initiated through a Checkout Session fails AFTER the session completed
    // (ACH settles asynchronously over 3-5 business days). This is the ONLY
    // event Stripe sends — payment_intent.payment_failed does NOT fire for
    // async payment methods. Pre-fix: ACH failures were silent.
    //
    // Mirror invoice.payment_failed: dunning email for brands (Stripe-hosted
    // invoice URL doesn't apply here — async session failures use the original
    // Checkout URL or just a manage link), generic operator Telegram alert
    // otherwise.
    case 'checkout.session.async_payment_failed': {
      const session = event.data.object as any;
      try {
        const customerEmail = String(
          session?.customer_details?.email ||
          session?.customer_email ||
          '',
        ).trim().toLowerCase();
        const amountCents = Number(session?.amount_total || 0);
        const sessionId = String(session?.id || '');
        const metaType = String(session?.metadata?.type || '');

        // ── Brand dunning email if this session belongs to a brand ──
        let brandMatches: any[] = [];
        if (customerEmail) {
          try {
            brandMatches = (await getAllRecords(
              TABLES.BRANDS,
              `LOWER({Email}) = "${escapeAirtableValue(customerEmail)}"`,
            )) as any[];
          } catch {}
        }
        if (brandMatches.length > 0) {
          const brand = brandMatches[0];
          const brandEmail = String(brand['Email'] || customerEmail).trim();
          if (brandEmail) {
            try {
              const { sendBrandPaymentFailed } = await import('@/lib/email');
              await sendBrandPaymentFailed({
                brandName: String(brand['Brand Name'] || brand['Contact Name'] || 'partner'),
                contactName: String(brand['Contact Name'] || brand['Brand Name'] || 'there'),
                email: brandEmail,
                // Async-session failures don't have a hosted_invoice_url —
                // sendBrandPaymentFailed falls back to /brand-partners.
                hostedInvoiceUrl: undefined,
                amountCents,
              });
            } catch (e: any) {
              console.error('[stripe webhook] async_payment_failed brand dunning failed:', e?.message);
            }
            // Stamp past_due so churn-risk dashboards surface it.
            try {
              await updateRecord(TABLES.BRANDS, brand.id, {
                'Subscription Status': 'past_due',
              });
            } catch {}
          }
        }

        // Always fire the operator alert so we know an ACH failed.
        // F13 (Wave 1): loud + failover — an async payment failure is money
        // that silently un-happened days after checkout.
        await sendOperatorSignal({
          urgency: 'loud',
          kind: 'sale',
          summary: `ACH/BANK PAYMENT FAILED — ${metaType || 'unknown type'}, ${customerEmail || '(no email)'}, $${(amountCents / 100).toFixed(2)}, session ${sessionId.slice(-8)}`,
          dedupeKey: `async-payment-failed:${sessionId}`,
        });
      } catch (e: any) {
        console.error('[stripe webhook] checkout.session.async_payment_failed handler:', e);
      }
      break;
    }

    // ── P3-A audit fix: pre-renewal heads-up ──
    // Stripe fires `invoice.upcoming` 3-7d before a subscription renews
    // (default 3d, configurable in Stripe Dashboard). Used to send brand
    // partners + founder annual subs a heads-up email so they have time
    // to update card / cancel intentionally before the charge. Pre-fix
    // these were silent — surprise charge = chargeback risk.
    //
    // Lookup: invoice.customer (Stripe Customer ID) → match against
    // BRANDS by `Stripe Customer ID` first, then CONSUMERS (founder subs).
    // If neither matches, Telegram-alert operator (data integrity signal).
    case 'invoice.upcoming': {
      const inv = event.data.object as any;
      try {
        const customerId = String(inv?.customer || '').trim();
        const amountCents = Number(inv?.amount_due || inv?.total || 0);
        const amountDollars = amountCents / 100;
        // Stripe gives us a Unix epoch (seconds) for `next_payment_attempt`
        // or `period_end` — compute days from now defensively.
        const renewalEpoch = Number(
          inv?.next_payment_attempt || inv?.period_end || (Date.now() / 1000),
        );
        const daysUntilRenewal = Math.max(
          1,
          Math.round((renewalEpoch * 1000 - Date.now()) / (24 * 60 * 60 * 1000)),
        );

        if (!customerId) {
          console.warn('[stripe webhook] invoice.upcoming with no customer id — skipping');
          break;
        }

        // ── 1. Try BRANDS first (brand partner monthly renewals) ──
        let matched = false;
        try {
          const brandMatches: any[] = await getAllRecords(
            TABLES.BRANDS,
            `{Stripe Customer ID} = "${escapeAirtableValue(customerId)}"`,
          );
          if (brandMatches.length > 0) {
            const brand: any = brandMatches[0];
            const email = String(brand['Email'] || '').trim();
            if (email) {
              const { sendRenewalReminder } = await import('@/lib/email');
              await sendRenewalReminder({
                firstName: String(brand['Contact Name'] || brand['Brand Name'] || 'there'),
                email,
                amountDollars,
                daysUntilRenewal,
                recipientType: 'brand-partner',
                planName: brand['Tier'] ? `your ${String(brand['Tier']).toLowerCase()} partnership` : 'your bhc partnership',
              });
              matched = true;
            }
          }
        } catch (e: any) {
          console.warn('[stripe webhook] invoice.upcoming brand lookup failed:', e?.message);
        }

        // ── 2. Fall back to CONSUMERS (founder annual subs) ──
        if (!matched) {
          try {
            const consumerMatches: any[] = await getAllRecords(
              TABLES.CONSUMERS,
              `{Stripe Customer ID} = "${escapeAirtableValue(customerId)}"`,
            );
            if (consumerMatches.length > 0) {
              const consumer: any = consumerMatches[0];
              const email = String(consumer['Email'] || '').trim();
              if (email) {
                const { sendRenewalReminder } = await import('@/lib/email');
                await sendRenewalReminder({
                  firstName: String(consumer['Full Name'] || 'there'),
                  email,
                  amountDollars,
                  daysUntilRenewal,
                  recipientType: 'founder',
                  planName: consumer['Founder Tier'] ? `your ${String(consumer['Founder Tier'])} membership` : 'your founder membership',
                });
                matched = true;
              }
            }
          } catch (e: any) {
            console.warn('[stripe webhook] invoice.upcoming consumer lookup failed:', e?.message);
          }
        }

        // ── 3. No match → data-integrity Telegram alert ──
        if (!matched) {
          // F13 (Wave 1): billing-integrity drift on a money path — failover-
          // backed signal instead of raw Telegram.
          await sendOperatorSignal({
            urgency: 'normal',
            kind: 'system-error',
            summary: `INVOICE.UPCOMING — customer ${customerId} not found in Brands or Consumers ($${amountDollars.toFixed(2)} renewing in ~${daysUntilRenewal}d). Data drift check needed.`,
            dedupeKey: `invoice-upcoming-unmatched:${customerId}`,
          });
        }
      } catch (e: any) {
        console.error('[stripe webhook] invoice.upcoming handler:', e);
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
      // Pass the real partial/amount so a PARTIAL refund doesn't nuke the deal.
      const refundedCents = Number(charge?.amount_refunded || 0);
      const isPartial = refundedCents > 0 && refundedCents < Number(charge?.amount || 0);
      let refundFlipped = false;
      try {
        ({ flipped: refundFlipped } = await markDepositRefunded(piId, { partial: isPartial, refundedAmountCents: refundedCents }));
      } catch (e: any) {
        // GO-LIVE MONEY HARDENING finding 2 (2026-07-02): pre-fix this catch
        // console.warn'd and FELL THROUGH — the end-of-route idempotency flip
        // then stamped the Stripe Events row 'processed' + returned 200, so
        // Stripe never redelivered and a REAL refund silently never landed on
        // the Payments row (deal stayed Closed Won, buyer kept getting
        // post-purchase automation — money back, funnel says "won", forever).
        // Mirror the payment_intent.succeeded settlement pattern: a TRANSIENT
        // failure (Airtable 429/timeout) → flip event 'failed' + 5xx so
        // Stripe redelivers and the refund self-heals. SAFE because
        // markDepositRefunded is idempotent on re-call: full refunds
        // early-return once Payments.Status === 'refunded', and its only
        // throw points are BEFORE/AT the row write (the post-write referral
        // restore is caught internally and never throws). A PERMANENT
        // (classified) failure → loud operator signal + 200 to stop
        // pointless 3-day redelivery.
        console.error('[stripe webhook] charge.refunded markDepositRefunded failed:', e);
        await flipStripeEventFailed(event.id, e?.message || 'unknown');
        if (isPermanentSettlementError(e)) {
          try {
            const { sendOperatorSignal } = await import('@/lib/operatorSignal');
            await sendOperatorSignal({
              urgency: 'loud',
              kind: 'system-error',
              summary: 'REFUND NOT RECORDED (permanent) — manual reconcile needed',
              detail: `charge.refunded for PI ${piId} ($${(refundedCents / 100).toFixed(2)}) failed permanently: ${e?.message || 'unknown'}. Money moved at Stripe but the Payments row/referral was NOT updated.`,
              dedupeKey: `refund-mark-permanent:${piId}`,
            });
          } catch {}
          return NextResponse.json({ received: true, permanent: true });
        }
        return NextResponse.json({ error: 'refund_mark_retry' }, { status: 500 });
      }
      // Post-mark side effects are BEST-EFFORT, each isolated — a Telegram or
      // audit blip after a successfully recorded refund must never 5xx (that
      // would redeliver a done refund just to retry a notification).
      if (refundFlipped) {
        try {
          // F13 (Wave 1): money left the platform — loud + failover so a
          // Telegram outage never hides a refund from the operator.
          await sendOperatorSignal({
            urgency: 'loud',
            kind: 'sale',
            summary: `Deposit refunded — PI ${piId.slice(-8)}`,
            dedupeKey: `deposit-refunded:${piId}`,
          });
        } catch (e: any) {
          console.warn('[stripe webhook] charge.refunded operator signal failed:', e?.message);
        }
      } else {
        // ── P4-A Gap 3: founder lifetime refund ──
        // No Payments row flipped → could be a founder lifetime (Founding 100
        // / Title Founder) one-time refund. Pre-fix these were silent —
        // money refunded in Stripe, founder still showed on the Wall +
        // counter never released. Now: detect founder-tier metadata and
        // flip Consumers row + release counter + audit log + Telegram.
        // Best-effort: failure here does NOT roll back the deposit refund
        // path above (which already returned flipped:false).
        try {
          await handleFounderLifetimeRefundOrDispute(piId, charge, 'refund');
        } catch (e: any) {
          console.warn('[stripe webhook] founder-lifetime refund detection failed:', e?.message);
        }
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
        result: { paymentsRowFlipped: refundFlipped },
        reverseAction: { type: 'noop', reason: 'Stripe-driven refund — cannot un-refund via Airtable' },
      }).catch(e => console.error('[audit] charge-refunded log failed:', e));
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
    // P3-A audit fix: `updated` (evidence submitted, status transitions
    // like under_review → won/lost) was falling through silently. handleDispute
    // is idempotent on event.id via markDepositDisputed + the top-of-handler
    // Stripe Events dedup, so re-fires for status transitions cleanly land
    // on the Payments row with the latest dispute status.
    case 'charge.dispute.updated':
    case 'charge.dispute.closed':
      try {
        await handleDispute(event);
      } catch (e: any) {
        console.warn('[stripe webhook] dispute handler:', e?.message);
      }
      // ── P4-A Gap 3: founder lifetime dispute ──
      // Only fire on dispute.created (initial chargeback). funds_withdrawn /
      // updated / closed re-fire on the same dispute and shouldn't re-flip
      // Consumers.Founder Tier or re-decrement the counter (idempotency).
      // handleDispute already fires the LOUD Telegram alert, so founder
      // detection just adds Consumer-row + counter-release on top.
      if (event.type === 'charge.dispute.created') {
        try {
          const dispute = event.data.object as any;
          const piId: string =
            typeof dispute?.payment_intent === 'string'
              ? dispute.payment_intent
              : dispute?.payment_intent?.id || '';
          if (piId) {
            await handleFounderLifetimeRefundOrDispute(piId, dispute, 'dispute');
          }
        } catch (e: any) {
          console.warn('[stripe webhook] founder-lifetime dispute detection failed:', e?.message);
        }
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

        // ── Tier subscription renewal invoice ──
        // Pre-fix: this branch was a no-op, so brand-partner monthly renewals
        // were never logged. Brand churn analysis impossible without renewal
        // event stream. Now: look up BRANDS by Stripe Subscription Id and
        // stamp Last Renewal At + write `brand_partner_renewal` funnel event
        // when this is a brand-partner sub. Founder subs flow through their
        // own checkout.session.completed path so they don't double-fire here.
        if (inv?.subscription && inv?.metadata?.type !== 'brand-listing' && inv?.metadata?.type !== 'commission-invoice') {
          try {
            const brandMatches: any[] = await getAllRecords(
              TABLES.BRANDS,
              `{Stripe Subscription Id} = "${escapeAirtableValue(inv.subscription)}"`,
            );
            if (brandMatches.length > 0) {
              const brand: any = brandMatches[0];
              const renewalIso = new Date(((inv.status_transitions?.paid_at || inv.created || Date.now() / 1000) as number) * 1000).toISOString();
              // Best-effort write — `Last Renewal At` may not exist on the
              // Airtable schema yet. If the write 422s, log a TODO and keep
              // going so the funnel event still fires.
              try {
                await updateRecord(TABLES.BRANDS, brand.id, {
                  'Last Renewal At': renewalIso,
                });
              } catch (fieldErr: any) {
                console.warn(
                  `[stripe webhook] TODO: add 'Last Renewal At' (DateTime) field to BRANDS — write failed: ${fieldErr?.message || fieldErr}`,
                );
              }
              try {
                await funnelRecord({
                  stage: 'brand_partner_renewal',
                  amount: (inv.amount_paid || 0) / 100,
                  metadata: {
                    brandRecordId: brand.id,
                    invoiceId: inv.id,
                    subscriptionId: inv.subscription,
                    email: brand['Email'] || inv.customer_email || '',
                    tier: brand['Tier'] || '',
                  },
                });
              } catch (e: any) {
                console.warn('[stripe webhook] brand_partner_renewal funnel write failed:', e?.message);
              }
              console.log(`[stripe webhook] brand partner renewal logged for ${brand.id} (sub ${inv.subscription})`);
            } else {
              // Not a brand subscription — could be founder sub renewal.
              // Founder renewals still fall through to subscription.updated for status.
              console.log('[stripe webhook] subscription invoice paid, no brand match (likely founder):', inv.id);
            }
          } catch (e: any) {
            console.warn('[stripe webhook] brand renewal lookup failed (non-fatal):', e?.message);
          }
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

  // ── 4. Operator alert ──
  // F13 (Wave 1): operatorSignal (failover + dedupe), not raw Telegram — this
  // is real money landing. The old `if (TELEGRAM_ADMIN_CHAT_ID)` gate is gone:
  // the wrapper no-ops the Telegram wire itself when unconfigured and can
  // still reach the operator over SMS/email.
  try {
    await sendOperatorSignal({
      urgency: 'normal',
      kind: 'sale',
      summary: `BRAND PARTNER — ${tierName}`,
      detail:
        `<b>$${amountPaid.toFixed(0)}</b> from ${name || '(no name)'} (${email})\n\n` +
        `<a href="https://dashboard.stripe.com/payments/${sessionId}">Stripe session</a>`,
      dedupeKey: `brand-partner-tier:${sessionId}`,
    });
  } catch (e: any) {
    console.warn('[brand-partner-tier] operator signal failed:', e?.message);
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
    // Consumers schema uses uppercase `ID` (verified 2026-05-27 against live
    // Airtable schema). Ranchers uses lowercase `Id`. Different tables,
    // different conventions — case-sensitive Airtable silently strips writes
    // that don't match. G-4 fixed the Ranchers reads; this is the Consumers
    // founder-subscription twin (PM2 audit, schema-drift finding).
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
  // Final-sweep fix (2026-06-10): Consumers field is `Stripe Subscription ID`
  // (capital ID) — the lowercase-d formula 422'd the whole query, so founder
  // churn was never marked cancelled. Brands uses `Stripe Subscription Id`
  // (lowercase d) — that table's queries stay as-is.
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
// Invoice payment_failed — Telegram alert + Subscription Status=past_due +
// brand-side dunning email (i-7 audit).
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

  // ── I-7 audit: brand partner past_due dunning email ──────────────────
  // before this, brand subscription failure was silent. now we look up
  // BRANDS by Stripe Subscription Id (if tracked) OR by customer_email
  // and fire sendBrandPaymentFailed w/ Stripe hosted invoice URL so the
  // brand can update card + pay w/o leaving stripe.
  try {
    const { sendBrandPaymentFailed } = await import('@/lib/email');
    const customerEmail = String(invoice.customer_email || '').trim().toLowerCase();
    let brandMatches: any[] = [];
    if (invoice.subscription) {
      try {
        brandMatches = (await getAllRecords(
          TABLES.BRANDS,
          `{Stripe Subscription Id} = "${escapeAirtableValue(invoice.subscription)}"`,
        )) as any[];
      } catch {}
    }
    if (brandMatches.length === 0 && customerEmail) {
      try {
        brandMatches = (await getAllRecords(
          TABLES.BRANDS,
          `LOWER({Email}) = "${escapeAirtableValue(customerEmail)}"`,
        )) as any[];
      } catch {}
    }
    if (brandMatches.length > 0) {
      const brand = brandMatches[0];
      const brandEmail = String(brand['Email'] || customerEmail).trim();
      if (brandEmail) {
        await sendBrandPaymentFailed({
          brandName: String(brand['Brand Name'] || brand['Contact Name'] || 'partner'),
          contactName: String(brand['Contact Name'] || brand['Brand Name'] || 'there'),
          email: brandEmail,
          hostedInvoiceUrl: invoice.hosted_invoice_url || undefined,
          amountCents: invoice.amount_due || 0,
        });
        // Stamp past_due on brand row so admin can filter churn-risk surface.
        try {
          await updateRecord(TABLES.BRANDS, brand.id, {
            'Subscription Status': 'past_due',
          });
        } catch {}
      }
    }
  } catch (e) {
    console.error('[brand-past-due] dunning email failed (non-fatal):', e);
  }

  // ── Dashboard-audit rank 7: RANCHER subscription past_due dunning ────
  // Consumer + brand branches existed; a paid-tier rancher's card failure
  // was invisible to the rancher. Own try/catch, non-fatal, runs regardless
  // of consumer/brand hits above.
  //
  // Gated on invoice.subscription: add-on purchases are one-off invoices
  // (no subscription) — without this gate the email fallback would dun a
  // rancher for an add-on invoice retry.
  //
  // FIELD-NAME LANDMINE: Ranchers uses 'Stripe Subscription Id' (lowercase
  // 'd', per app/api/rancher/tier/change/route.ts) while Consumers uses
  // 'Stripe Subscription ID' — copy-pasting the consumer lookup silently
  // misses.
  if (invoice.subscription) {
    try {
      const customerEmail = String(invoice.customer_email || '').trim().toLowerCase();
      let rancherMatches: any[] = [];
      try {
        rancherMatches = (await getAllRecords(
          TABLES.RANCHERS,
          `{Stripe Subscription Id} = "${escapeAirtableValue(invoice.subscription)}"`,
        )) as any[];
      } catch {}
      if (rancherMatches.length === 0 && customerEmail) {
        try {
          const byEmail = (await getAllRecords(
            TABLES.RANCHERS,
            `LOWER({Email}) = "${escapeAirtableValue(customerEmail)}"`,
          )) as any[];
          // An email match whose row carries a DIFFERENT subscription id is
          // some other product's invoice (e.g. a rancher who's also a
          // founder) — never dun them for a sub that isn't theirs.
          rancherMatches = byEmail.filter((row: any) => {
            const trackedSub = String(row['Stripe Subscription Id'] || '').trim();
            return !trackedSub || trackedSub === String(invoice.subscription);
          });
        } catch {}
      }
      if (rancherMatches.length > 0) {
        const rancherRow = rancherMatches[0];
        const rancherEmail = String(rancherRow['Email'] || customerEmail).trim();
        if (rancherEmail) {
          const { sendRancherPaymentFailed } = await import('@/lib/email');
          await sendRancherPaymentFailed({
            rancherName: String(rancherRow['Ranch Name'] || rancherRow['Operator Name'] || 'your ranch'),
            contactName: String(rancherRow['Operator Name'] || rancherRow['Ranch Name'] || 'there'),
            email: rancherEmail,
            hostedInvoiceUrl: invoice.hosted_invoice_url || undefined,
            amountCents: invoice.amount_due || 0,
            rancherId: rancherRow.id,
          });
        }
        // Stamp past_due so /rancher/billing shows the warning banner and
        // admin can filter churn-risk. Plain string — Airtable singleSelect.
        try {
          await updateRecord(TABLES.RANCHERS, rancherRow.id, {
            'Subscription Status': 'past_due',
          });
        } catch {}
        // Best-effort push — never blocks, never throws (sendRancherPush's
        // contract), and a rancher with no devices is a silent 0.
        try {
          const { sendRancherPush } = await import('@/lib/rancherPush');
          await sendRancherPush(rancherRow.id, {
            title: 'your BuyHalfCow payment failed',
            body: 'update your card to keep your plan active',
            url: '/rancher/billing',
          });
        } catch {}
      }
    } catch (e) {
      console.error('[rancher-past-due] dunning failed (non-fatal):', e);
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
    const commissionPaidFields: Record<string, any> = {
      'Commission Paid': true,
      'Commission Paid At': new Date().toISOString(),
    };
    // NEVER blank a good URL. This wrote `hosted_invoice_url || ''`, so any
    // invoice.paid event where Stripe omitted the field (it is null on some
    // invoice states, and absent on replayed/expanded payloads) ERASED the
    // durable link we'd already stored — the operator's only handle on that
    // invoice. Write it only when Stripe actually sent one; otherwise leave
    // whatever is on the record untouched.
    if (invoice.hosted_invoice_url) {
      commissionPaidFields['Stripe Invoice URL'] = invoice.hosted_invoice_url;
    }
    await updateRecord(TABLES.REFERRALS, referralId, commissionPaidFields);
  } catch (e: any) {
    airtableWriteOk = false;
    airtableWriteError = e?.message || 'unknown';
    console.error('[stripe webhook] mark commission paid failed:', airtableWriteError);
  }

  // Operator celebration — same signal rail that carries sale alerts.
  // MISMATCH FIX: surface Airtable write status in the message so operator
  // knows whether the DB actually reflects the Stripe-confirmed payment.
  // F13 (Wave 1): operatorSignal, not raw Telegram. The AIRTABLE-WRITE-FAILED
  // variant is a manual-fix order — it rides LOUD so a Telegram outage falls
  // back to SMS/email; the clean celebration rides normal. The old
  // `if (TELEGRAM_ADMIN_CHAT_ID)` gate is gone: the wrapper no-ops the
  // Telegram wire itself when unconfigured and the failover still fires.
  try {
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
    await sendOperatorSignal({
      urgency: airtableWriteOk ? 'normal' : 'loud',
      kind: airtableWriteOk ? 'sale' : 'system-error',
      summary: `COMMISSION PAID — $${amountPaidDollars.toFixed(2)} just landed in BHC's Stripe.${airtableWriteOk ? '' : ' AIRTABLE WRITE FAILED — manual fix needed.'}`,
      detail: `${rancherLine}${buyerLine}\n\n${statusFooter}`.trim(),
      refs: [{ type: 'referral', id: referralId }],
      dedupeKey: `commission-paid:${invoice.id}`,
    });
  } catch (e: any) {
    console.error('[stripe webhook] commission-paid operator signal failed:', e?.message);
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
  };
  if (nextInvoiceAt !== null) {
    fields['Subscription Next Invoice At'] = nextInvoiceAt;
  }

  // Fetch the current rancher row ONCE — needed for (a) the locked-rate guard
  // and (b) the tier_v2 auto-flip check below.
  let currentRancher: any = null;
  let rancherFetchFailed = false;
  try {
    currentRancher = await getRecordById(TABLES.RANCHERS, rancherRecordId);
  } catch (e: any) {
    rancherFetchFailed = true;
    console.warn('[stripe webhook] tier sub upsert: rancher fetch failed:', e?.message);
  }

  // ── LOCKED-RATE GUARD — MONEY-TRUTH TAIL finding 1a (2026-07-01) ──────
  // This upsert used to write 'Commission Rate' = the tier default on EVERY
  // subscription.created/updated event, CLOBBERING negotiated locked rates
  // (Ashcraft-class: a locked 4% rancher who later subscribes to a tier got
  // silently re-locked to the tier default). Now the tier default is stamped
  // ONLY when the field is truly EMPTY (never written). Any non-empty value —
  // including a locked 0 (Operator) or even operator-typed garbage — is
  // operator-owned and is never overwritten; we log + fire a deduped operator
  // note so the skip is visible. If the rancher read failed we ALSO skip
  // (fail-safe: better to leave the rate for the next subscription event /
  // manual set than to risk clobbering a rate we could not read).
  const existingRateRaw = currentRancher?.['Commission Rate'];
  if (!rancherFetchFailed && isCommissionRateFieldEmpty(existingRateRaw)) {
    fields['Commission Rate'] = commissionRate;
    fields['Commission Rate Locked At'] = new Date().toISOString();
  } else if (!rancherFetchFailed) {
    console.log(
      `[stripe webhook] tier sub upsert: rancher ${rancherRecordId} already has Commission Rate=` +
      `${JSON.stringify(existingRateRaw)} — NOT overwriting with tier default ${commissionRate} (${tierLabel})`,
    );
    try {
      const { sendOperatorSignal } = await import('@/lib/operatorSignal');
      await sendOperatorSignal({
        urgency: 'normal',
        kind: 'audit',
        summary: `Tier subscription kept ${String(currentRancher?.['Operator Name'] || currentRancher?.['Ranch Name'] || rancherRecordId)}'s locked Commission Rate`,
        detail:
          `Rancher ${rancherRecordId} subscribed to ${tierLabel} (tier default rate ${commissionRate}), but their ` +
          `row already has Commission Rate = ${JSON.stringify(existingRateRaw)} — the locked rate WINS and was not ` +
          `overwritten. If they should be on the ${tierLabel} default instead, clear/update the field manually.`,
        refs: [{ type: 'rancher', id: rancherRecordId }],
        dedupeKey: `tier-upsert-rate-skip-${rancherRecordId}`,
        dedupeWindowMs: 24 * 60 * 60 * 1000,
      });
    } catch (sigErr: any) {
      console.warn('[stripe webhook] tier sub upsert: rate-skip operator note failed:', sigErr?.message);
    }
  } else {
    console.warn(
      `[stripe webhook] tier sub upsert: skipping Commission Rate write for ${rancherRecordId} — ` +
      `could not read the current row to check for a locked rate. Next subscription event retries.`,
    );
  }

  // ── AUTO-FLIP PRICING MODEL → tier_v2 (2026-06-04) ────────────────
  // Mirror of the gate in stripe-connect/syncRancherConnectStatus. If
  // subscription is now active AND Connect was already active, this is
  // the final step that activates tier_v2. Without this, the rancher
  // had to find + click the dashboard banner to flip. (Uses the rancher
  // row fetched above; a failed fetch skips the flip — same semantics as
  // the old inline try/catch.)
  let didAutoFlip = false;
  if ((sub.status === 'active' || sub.status === 'trialing') && currentRancher) {
    const connectStatus = String(currentRancher?.['Stripe Connect Status'] || '').toLowerCase();
    const pricingModel = String(currentRancher?.['Pricing Model'] || '').toLowerCase();
    if (connectStatus === 'active' && pricingModel !== 'tier_v2') {
      fields['Pricing Model'] = 'tier_v2';
      fields['Migration Status'] = 'completed';
      didAutoFlip = true;
    }
  }

  await updateRecord(TABLES.RANCHERS, rancherRecordId, fields);
  console.log(`[stripe webhook] tier sub upsert: rancher ${rancherRecordId} → tier=${tierLabel}, status=${sub.status}${didAutoFlip ? ' (auto-flipped Pricing Model → tier_v2)' : ''}`);

  if (didAutoFlip) {
    try {
      const { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } = await import('@/lib/telegram');
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `✨ <b>PRICING MODEL → tier_v2</b>\n\nRancher: ${rancherRecordId}\nTier: ${tierLabel}\nSub: ${sub.status}\nConnect: active\n\n<i>Next buyer match will show Reserve-Your-Share deposit CTA in intro email.</i>`,
      );
    } catch {}
  }
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

  // ── Wave C (2026-07-14): the terminal lapse must not land silently. ──────
  // The consequences enforce INSTANTLY (routing excludes canceled —
  // lib/rancherEligibility; deposits 409 — checkout/deposit), and the #376
  // payment-failed dunning email literally promised paying 'keeps your plan
  // from lapsing' — yet the lapse itself fired no email, no push, no ops
  // signal. Churn completed invisibly. All best-effort after the row write.
  const rancherRow: any = matches[0];
  const ranchName = String(rancherRow['Ranch Name'] || rancherRow['Operator Name'] || rancherRecordId);
  try {
    await sendOperatorSignal({
      urgency: 'loud',
      kind: 'sale',
      summary: `TIER SUB CANCELLED — ${ranchName}`,
      detail:
        `${ranchName}'s tier subscription is terminally cancelled (Tier → None). ` +
        `Routing now excludes them and buyer deposits are blocked. ` +
        `Rancher was emailed a reactivation CTA — a save call beats the email.`,
      refs: [{ type: 'rancher', id: rancherRecordId }],
      dedupeKey: `tier-sub-deleted:${sub?.id || rancherRecordId}`,
      dedupeWindowMs: 24 * 60 * 60 * 1000,
    });
  } catch (e: any) {
    console.warn('[stripe webhook] tier sub deleted: operator signal failed:', e?.message);
  }
  const rancherEmail = String(rancherRow['Email'] || '').trim();
  if (rancherEmail) {
    try {
      const firstName =
        String(rancherRow['Operator Name'] || rancherRow['Ranch Name'] || '').split(/\s+/)[0] || 'there';
      const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';
      const r = await sendEmail({
        to: rancherEmail,
        subject: 'your BuyHalfCow plan has ended — here\'s what changes',
        templateName: 'sendRancherSubscriptionEnded',
        html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;background:#F4F1EC;line-height:1.6;color:#0E0E0E">
          <p>hey ${firstName},</p>
          <p>your BuyHalfCow plan for <strong>${ranchName}</strong> has ended. Here's what that changes, effective now:</p>
          <ul style="font-size:15px;line-height:1.8">
            <li>new buyer routing to you is <strong>paused</strong></li>
            <li>buyers can't place deposits on your page</li>
            <li>your page and your existing conversations stay up</li>
          </ul>
          <p>Getting back on takes about a minute — pick a plan and everything switches back on:</p>
          <p><a href="${siteUrl}/rancher/billing" style="display:inline-block;background:#26251E;color:#F4F0E7;padding:12px 22px;text-decoration:none;">Re-pick a plan &rarr;</a></p>
          <p style="font-size:14px;color:#5A5752">If this wasn't intentional (card expired, bank hiccup) or you want to talk it through first, just reply — a real person reads this.</p>
          <p style="font-size:12px;color:#A7A29A;">— Ben<br>BuyHalfCow</p>
        </div>`,
      });
      if (!r?.success) {
        console.error(
          `[stripe webhook] tier sub deleted: rancher email suppressed (${(r as any)?.reason || 'unknown'}) — rancher NOT notified their plan ended`,
        );
      }
    } catch (e: any) {
      console.warn('[stripe webhook] tier sub deleted: rancher email failed (non-fatal):', e?.message);
    }
  }
  try {
    const { sendRancherPush } = await import('@/lib/rancherPush');
    await sendRancherPush(rancherRecordId, {
      title: 'your BHC plan ended',
      body: 'new leads + deposits are paused. tap to reactivate — takes 1 minute.',
      url: '/rancher/billing',
    });
  } catch (e: any) {
    console.warn('[stripe webhook] tier sub deleted: rancher push skipped (non-fatal):', e?.message);
  }
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
  // H-4 audit fix: dispute writes go through the payments contract so the
  // platform + Connect webhooks share a single Payments surface.
  let paymentRecordId: string | null = null;
  if (piId) {
    try {
      const { found, recordId } = await markDepositDisputed({
        stripePaymentIntentId: piId,
        disputeStatus: status,
        disputeAmountCents: dispute?.amount || 0,
        disputeReason: reason,
      });
      if (found && recordId) paymentRecordId = recordId;
    } catch (e: any) {
      console.error('[dispute] Airtable update failed:', e?.message);
    }
  }

  // LOUD alert — ops needs to act fast on disputes. Rides sendOperatorSignal
  // (2026-07-02) so a dead Telegram wire falls back to SMS/email
  // (lib/signalDelivery.ts) instead of swallowing a chargeback. Never throws.
  // Dedupe keys on eventType + dispute id: created/funds_withdrawn/closed are
  // distinct lifecycle moments and must each fire; Stripe re-fires of the
  // SAME event are suppressed.
  await sendOperatorSignal({
    urgency: 'loud',
    kind: 'dispute',
    summary: `STRIPE DISPUTE — ${eventType}`,
    detail:
      `Amount: $${amount}\n` +
      `Reason: ${reason}\n` +
      `Status: ${status}\n` +
      `Charge: ${chargeId}\n` +
      `Stripe: https://dashboard.stripe.com/payments/${chargeId}` +
      (paymentRecordId ? `\nPayments row: ${paymentRecordId}` : ''),
    dedupeKey: `dispute:${eventType}:${dispute?.id || chargeId || piId || 'unknown'}`,
  });

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
// P4-A Gap 1 — BRAND PARTNER SUBSCRIPTION UPDATED.
//
// Fires on every customer.subscription.updated for brand-partner-tier subs.
// Three causes:
//   1. Status flip — active → past_due (invoice failed) → canceled (final retry)
//      → unpaid (collections exhausted). Mirror to Brands.Subscription Status.
//   2. Tier downgrade — price_id changed (Spotlight → Featured or similar).
//      Mirror to Brands.Tier label.
//   3. Cancel-at-period-end flag — customer hit "cancel" but sub still active
//      until period_end. We mirror Subscription Status + stamp Cancel At Period
//      End so the brand dashboard shows the future-cancel state.
//
// Idempotency: read Brands row first, skip if already in target state. This
// shields us from Stripe's frequent `updated` re-fires (every metered usage
// report, every invoice generated, etc).
// ============================================================================
async function handleBrandPartnerSubscriptionUpdated(sub: any): Promise<void> {
  const subscriptionId: string = sub.id;
  if (!subscriptionId) return;

  // Look up Brand row by Stripe Subscription Id (brand schema uses lowercase `Id`).
  const matches: any[] = await getAllRecords(
    TABLES.BRANDS,
    `{Stripe Subscription Id} = "${escapeAirtableValue(subscriptionId)}"`,
  );
  if (matches.length === 0) {
    console.warn(`[brand-sub-updated] no Brand row matches subscription ${subscriptionId}`);
    return;
  }
  const brand: any = matches[0];
  const brandRecordId: string = brand.id;

  // ── Resolve new tier from price_id ──
  // sub.items.data[0].price.id is the current active price after the update.
  // Map env vars back to tier slug so we can stamp the human-readable label.
  const currentPriceId: string =
    sub?.items?.data?.[0]?.price?.id || sub?.plan?.id || '';
  const newTierSlug = brandPriceIdToTierSlug(currentPriceId);
  const newTierLabel = newTierSlug ? brandTierNameForSlug(newTierSlug) : '';

  // ── Resolve new status. Subscription.status values: active, past_due,
  //    unpaid, canceled, incomplete, incomplete_expired, trialing, paused ──
  const newStatus: string = String(sub?.status || '').toLowerCase();
  const cancelAtPeriodEnd: boolean = !!sub?.cancel_at_period_end;
  const previousTier: string = String(brand['Tier'] || '').trim();
  const previousStatus: string = String(brand['Subscription Status'] || '').trim().toLowerCase();

  // ── Idempotency: skip if nothing changed ──
  const statusChanged = previousStatus !== newStatus;
  const tierChanged = !!newTierLabel && previousTier !== newTierLabel;
  if (!statusChanged && !tierChanged) {
    console.log(`[brand-sub-updated] no-op for ${brandRecordId} — status=${newStatus}, tier=${newTierLabel || previousTier}`);
    return;
  }

  // ── Apply update ──
  const fields: Record<string, any> = {};
  if (statusChanged) {
    fields['Subscription Status'] = newStatus;
    // Stripe's `canceled` status → also flip Active off + Featured off so the
    // public Brands grid stops surfacing them. `past_due` / `unpaid` keep the
    // brand surfaced (they may recover via dunning).
    if (newStatus === 'canceled' || newStatus === 'unpaid') {
      fields['Active'] = false;
      fields['Featured'] = false;
    }
  }
  if (tierChanged) {
    fields['Tier'] = newTierLabel;
  }
  if (cancelAtPeriodEnd && sub?.cancel_at) {
    // Optional best-effort timestamp — field may not exist on schema yet.
    fields['Cancel At Period End'] = new Date(sub.cancel_at * 1000).toISOString();
  }
  await updateRecord(TABLES.BRANDS, brandRecordId, fields);

  // ── Operator alert per cause ──
  // F13 (Wave 1): recurring-revenue state change — operatorSignal so a
  // Telegram outage never hides churn/tier moves. Cancel rides loud
  // (save-attempt moment, mirrors TIER SUB CANCELLED); the rest normal.
  try {
    const brandName = String(brand['Brand Name'] || brand['Contact Name'] || brandRecordId);
    let alert = '';
    if (tierChanged) {
      alert = `BRAND TIER CHANGE\n${brandName}\n${previousTier || '(unknown)'} → <b>${newTierLabel}</b>\nsub ${subscriptionId.slice(-8)}`;
    } else if (newStatus === 'canceled') {
      alert = `BRAND CANCELLED\n${brandName}\nprev status: ${previousStatus}\nsub ${subscriptionId.slice(-8)}`;
    } else if (statusChanged) {
      alert = `BRAND status: ${brandName} → <b>${newStatus}</b> (was ${previousStatus || 'unknown'}) · sub ${subscriptionId.slice(-8)}`;
    }
    if (alert) {
      await sendOperatorSignal({
        urgency: newStatus === 'canceled' ? 'loud' : 'normal',
        kind: 'sale',
        summary: alert.split('\n')[0],
        detail: alert.split('\n').slice(1).join('\n') || undefined,
        dedupeKey: `brand-sub-updated:${subscriptionId}:${newStatus}:${newTierLabel}`,
      });
    }
  } catch (e: any) {
    console.warn('[brand-sub-updated] operator signal failed:', e?.message);
  }

  // ── Funnel event ──
  try {
    await funnelRecord({
      stage: tierChanged ? 'brand_partner_tier_changed' : 'brand_partner_status_changed',
      metadata: {
        brandRecordId,
        subscriptionId,
        previousTier,
        newTier: newTierLabel,
        previousStatus,
        newStatus,
      },
    });
  } catch (e: any) {
    console.warn('[brand-sub-updated] funnel record failed:', e?.message);
  }

  // ── Audit log — Stripe-driven Brand mutation, was previously invisible ──
  await logAuditEntry({
    actor: 'cron',
    tool: 'stripe-webhook-brand-partner-subscription-updated',
    targetType: 'Other',
    targetId: brandRecordId,
    args: { subscriptionId, previousTier, previousStatus, newStatus, newTier: newTierLabel },
    result: { fields },
    reverseAction: { type: 'noop', reason: 'Stripe-driven subscription update — replay from Stripe Events row' },
  }).catch(e => console.error('[audit] brand-sub-updated log failed:', e));
}

// ============================================================================
// P4-A Gap 1 — BRAND PARTNER SUBSCRIPTION DELETED.
//
// Fires on customer.subscription.deleted when a brand cancels (immediate) OR
// when their final dunning retry fails and Stripe auto-cancels. Status of the
// sub at delete time is always 'canceled'.
//
// Mirror: Brands.Subscription Status='canceled', Active=false, Featured=false,
// Cancelled At=now. Telegram alert. Funnel + audit log.
// Idempotent: re-read row, skip if already canceled.
// ============================================================================
async function handleBrandPartnerSubscriptionDeleted(sub: any): Promise<void> {
  const subscriptionId: string = sub.id;
  if (!subscriptionId) return;

  const matches: any[] = await getAllRecords(
    TABLES.BRANDS,
    `{Stripe Subscription Id} = "${escapeAirtableValue(subscriptionId)}"`,
  );
  if (matches.length === 0) {
    console.warn(`[brand-sub-deleted] no Brand row matches subscription ${subscriptionId}`);
    return;
  }
  const brand: any = matches[0];
  const brandRecordId: string = brand.id;
  const previousStatus: string = String(brand['Subscription Status'] || '').trim().toLowerCase();

  // ── Idempotency — already canceled, no-op ──
  if (previousStatus === 'canceled') {
    console.log(`[brand-sub-deleted] ${brandRecordId} already canceled — skipping`);
    return;
  }

  const fields: Record<string, any> = {
    'Subscription Status': 'canceled',
    'Active': false,
    'Featured': false,
    'Cancelled At': new Date().toISOString(),
  };
  await updateRecord(TABLES.BRANDS, brandRecordId, fields);

  // ── Operator alert ──
  // F13 (Wave 1): terminal churn on a paying brand — loud + failover
  // (mirrors TIER SUB CANCELLED), 24h dedupe window.
  try {
    const brandName = String(brand['Brand Name'] || brand['Contact Name'] || brandRecordId);
    const tier = String(brand['Tier'] || '(unknown)');
    await sendOperatorSignal({
      urgency: 'loud',
      kind: 'sale',
      summary: `BRAND CANCELLED — ${brandName}`,
      detail: `Tier: ${tier}\nPrev status: ${previousStatus || 'unknown'}\nsub ${subscriptionId.slice(-8)}\n\nSave attempt recommended within 48h.`,
      dedupeKey: `brand-sub-deleted:${subscriptionId}`,
      dedupeWindowMs: 24 * 60 * 60 * 1000,
    });
  } catch (e: any) {
    console.warn('[brand-sub-deleted] operator signal failed:', e?.message);
  }

  try {
    await funnelRecord({
      stage: 'brand_partner_cancelled',
      metadata: {
        brandRecordId,
        subscriptionId,
        previousStatus,
        tier: brand['Tier'] || '',
      },
    });
  } catch (e: any) {
    console.warn('[brand-sub-deleted] funnel record failed:', e?.message);
  }

  await logAuditEntry({
    actor: 'cron',
    tool: 'stripe-webhook-brand-partner-subscription-deleted',
    targetType: 'Other',
    targetId: brandRecordId,
    args: { subscriptionId, previousStatus },
    result: { fields },
    reverseAction: { type: 'noop', reason: 'Stripe-driven subscription cancel — cannot un-cancel via Airtable' },
  }).catch(e => console.error('[audit] brand-sub-deleted log failed:', e));
}

// ============================================================================
// P4-A Gap 2 — FOUNDER (BACKER) SUBSCRIPTION UPDATED.
//
// Fires on customer.subscription.updated for founder-subscription subs (recurring
// Herd / Outlaw / Steward tiers). Cause: tier downgrade (price_id change) or
// status flip.
//
// CONSUMERS schema note: uses uppercase `Stripe Subscription ID` (G-4 fix).
// Mirror Founder Tier (downgrade) + Subscription Status. Telegram alert.
// ============================================================================
async function handleFounderSubscriptionUpdated(sub: any): Promise<void> {
  const subscriptionId: string = sub.id;
  if (!subscriptionId) return;

  const matches: any[] = await getAllRecords(
    TABLES.CONSUMERS,
    `{Stripe Subscription ID} = "${escapeAirtableValue(subscriptionId)}"`,
  );
  if (matches.length === 0) {
    console.warn(`[founder-sub-updated] no Consumer row matches subscription ${subscriptionId}`);
    return;
  }
  const consumer: any = matches[0];
  const consumerId: string = consumer.id;

  // Resolve new tier from price_id via metadata.tier on the sub, since founder
  // Payment Links stamp metadata.tier='herd-monthly' / 'outlaw-monthly' / etc.
  // For tier downgrades initiated from Stripe Customer Portal, the metadata
  // stays on the sub (Stripe carries it forward) but new line item may swap.
  // Fall back to subscription metadata first; if that's stale, leave tier alone.
  const subTierKey: string = String(sub?.metadata?.tier || '').toLowerCase();
  const mappedNewTier = TIER_MAP[subTierKey]?.tier;

  const newStatus: string = String(sub?.status || '').toLowerCase();
  const previousTier: string = String(consumer['Founder Tier'] || '').trim();
  const previousStatus: string = String(consumer['Subscription Status'] || '').trim().toLowerCase();

  const tierChanged = !!mappedNewTier && previousTier !== mappedNewTier;
  const statusChanged = previousStatus !== newStatus;
  if (!tierChanged && !statusChanged) {
    console.log(`[founder-sub-updated] no-op for ${consumerId} — status=${newStatus}, tier=${mappedNewTier || previousTier}`);
    return;
  }

  const fields: Record<string, any> = {};
  if (statusChanged) fields['Subscription Status'] = newStatus;
  // Only flip Founder Tier on downgrade (mapped tier present + different).
  // Do NOT clear Founder Tier here — that's reserved for the deleted handler.
  if (tierChanged) fields['Founder Tier'] = mappedNewTier;
  try {
    await updateRecord(TABLES.CONSUMERS, consumerId, fields);
  } catch (e: any) {
    console.warn(`[founder-sub-updated] write failed: ${e?.message}`);
    throw e;
  }

  // Operator alert — F13 (Wave 1): recurring-revenue state change, rides
  // operatorSignal (failover + dedupe) instead of raw Telegram.
  try {
    const name = String(consumer['Full Name'] || consumer['Email'] || consumerId);
    let alert = '';
    if (tierChanged) {
      alert = `FOUNDER TIER CHANGE\n${name}\n${previousTier || '(unknown)'} → <b>${mappedNewTier}</b>\nsub ${subscriptionId.slice(-8)}`;
    } else if (statusChanged) {
      alert = `FOUNDER status: ${name} → <b>${newStatus}</b> (was ${previousStatus || 'unknown'}) · sub ${subscriptionId.slice(-8)}`;
    }
    if (alert) {
      await sendOperatorSignal({
        urgency: 'normal',
        kind: 'sale',
        summary: alert.split('\n')[0],
        detail: alert.split('\n').slice(1).join('\n') || undefined,
        dedupeKey: `founder-sub-updated:${subscriptionId}:${newStatus}:${mappedNewTier || previousTier}`,
      });
    }
  } catch (e: any) {
    console.warn('[founder-sub-updated] operator signal failed:', e?.message);
  }

  try {
    await funnelRecord({
      stage: tierChanged ? 'founder_tier_changed' : 'founder_status_changed',
      buyerId: consumerId,
      metadata: {
        subscriptionId,
        previousTier,
        newTier: mappedNewTier,
        previousStatus,
        newStatus,
      },
    });
  } catch (e: any) {
    console.warn('[founder-sub-updated] funnel record failed:', e?.message);
  }

  await logAuditEntry({
    actor: 'cron',
    tool: 'stripe-webhook-founder-subscription-updated',
    targetType: 'Consumer',
    targetId: consumerId,
    args: { subscriptionId, previousTier, previousStatus, newStatus, newTier: mappedNewTier },
    result: { fields },
    reverseAction: { type: 'noop', reason: 'Stripe-driven subscription update — replay from Stripe Events row' },
  }).catch(e => console.error('[audit] founder-sub-updated log failed:', e));
}

// ============================================================================
// P4-A Gap 2 — FOUNDER (BACKER) SUBSCRIPTION DELETED.
//
// Fires on customer.subscription.deleted for founder-subscription subs.
// Cause: backer cancelled (immediate or final dunning retry exhausted).
//
// Preservation choice: keep Founder Tier value (Wall placement + founder
// number history matter for back-compat — Wall page renders from Founder Tier).
// Instead, stamp Founder Tier Cancelled At + flip Subscription Status='canceled'.
// This is the SAFE choice the prompt asks us to make explicitly.
//
// CONSUMERS schema: uppercase `Stripe Subscription ID` (G-4 fix).
// ============================================================================
async function handleFounderSubscriptionDeleted(sub: any): Promise<void> {
  const subscriptionId: string = sub.id;
  if (!subscriptionId) return;

  const matches: any[] = await getAllRecords(
    TABLES.CONSUMERS,
    `{Stripe Subscription ID} = "${escapeAirtableValue(subscriptionId)}"`,
  );
  if (matches.length === 0) {
    console.warn(`[founder-sub-deleted] no Consumer row matches subscription ${subscriptionId}`);
    return;
  }
  const consumer: any = matches[0];
  const consumerId: string = consumer.id;
  const previousStatus: string = String(consumer['Subscription Status'] || '').trim().toLowerCase();

  // ── Idempotency — already canceled, no-op ──
  if (previousStatus === 'canceled') {
    console.log(`[founder-sub-deleted] ${consumerId} already canceled — skipping`);
    return;
  }

  // Stamp cancellation. Preserve Founder Tier (Wall placement).
  const fields: Record<string, any> = {
    'Subscription Status': 'canceled',
    'Founder Tier Cancelled At': new Date().toISOString(),
  };
  await updateRecord(TABLES.CONSUMERS, consumerId, fields);

  // Telegram alert via existing helper.
  try {
    const { sendTelegramSubscriptionCancelled } = await import('@/lib/telegram');
    await sendTelegramSubscriptionCancelled({
      email: (consumer['Email'] as string) || '(no email)',
      name: (consumer['Full Name'] as string) || '',
      tier: (consumer['Founder Tier'] as string) || '(no tier)',
      consumerId,
    });
  } catch (e: any) {
    console.warn('[founder-sub-deleted] telegram alert failed:', e?.message);
  }

  try {
    await funnelRecord({
      stage: 'founder_subscription_cancelled',
      buyerId: consumerId,
      metadata: {
        subscriptionId,
        previousStatus,
        tier: consumer['Founder Tier'] || '',
      },
    });
  } catch (e: any) {
    console.warn('[founder-sub-deleted] funnel record failed:', e?.message);
  }

  await logAuditEntry({
    actor: 'cron',
    tool: 'stripe-webhook-founder-subscription-deleted',
    targetType: 'Consumer',
    targetId: consumerId,
    args: { subscriptionId, previousStatus },
    result: { fields },
    reverseAction: { type: 'noop', reason: 'Stripe-driven subscription cancel — cannot un-cancel via Airtable' },
  }).catch(e => console.error('[audit] founder-sub-deleted log failed:', e));
}

// ============================================================================
// P4-A Gap 3 — FOUNDER LIFETIME REFUND / DISPUTE.
//
// One-time Founding 100 ($X) + Title Founder ($15k) lifetime payments fire
// charge.refunded / charge.dispute.created against the platform account. Pre-
// fix: existing handlers only matched buyer_deposit (Payments table) + brand-
// listing — so founder lifetime refunds were silent, the Wall kept the founder
// listed, and the per-tier counter never released the seat.
//
// Detection: charge has no Payments row (deposits) and no Brands row (listings).
// We look up Consumers by Stripe Payment Intent stamped at backer-checkout time.
// If we don't store PI ID, fall back to fetching the parent session via the
// Stripe API and matching session.id → Consumers.Stripe Session ID.
//
// Action:
//   - Stamp Consumers.Founder Tier = 'REFUNDED' (or 'DISPUTED') so Wall hides them
//   - Stamp Founder Refunded At + reason
//   - Decrement Redis counter so the tier seat is reclaimable
//   - LOUD Telegram + audit log
//
// All writes idempotent (re-read row, skip if already REFUNDED/DISPUTED).
// ============================================================================
async function handleFounderLifetimeRefundOrDispute(
  piId: string,
  source: any,
  kind: 'refund' | 'dispute',
): Promise<void> {
  if (!piId) return;

  // ── Look up the parent Checkout Session via PI to recover metadata.type ──
  // Stripe doesn't copy session metadata onto the PI for one-time payments,
  // so we have to fetch the session via the Stripe API. This is the only
  // canonical place metadata.type='founder-lifetime' is stamped.
  let session: any = null;
  let metaType = '';
  let consumer: any = null;
  let consumerId = '';
  let tierLabel = '';
  try {
    const stripe = getStripe();
    const list = await stripe.checkout.sessions.list({
      payment_intent: piId,
      limit: 1,
    });
    session = list?.data?.[0] || null;
    metaType = String(session?.metadata?.type || '');
  } catch (e: any) {
    console.warn('[founder-lifetime-refund] session lookup via PI failed:', e?.message);
  }

  // If we have a session and it's a founder lifetime, find the Consumer.
  if (session && metaType === 'founder-lifetime') {
    try {
      const sessionId = String(session.id || '');
      const rows: any[] = await getAllRecords(
        TABLES.CONSUMERS,
        `{Stripe Session ID} = "${escapeAirtableValue(sessionId)}"`,
      );
      if (rows.length > 0) {
        consumer = rows[0];
        consumerId = consumer.id;
        tierLabel = String(consumer['Founder Tier'] || '');
      }
    } catch (e: any) {
      console.warn('[founder-lifetime-refund] Consumer lookup by Session ID failed:', e?.message);
    }
  }

  // No founder lifetime detected — quietly exit (this is the "not a founder
  // refund" path; the charge.refunded outer handler already logged the audit).
  if (!consumer) {
    return;
  }

  // ── Idempotency: skip if already flipped ──
  const currentTier = String(consumer['Founder Tier'] || '').trim().toUpperCase();
  if (currentTier === 'REFUNDED' || currentTier === 'DISPUTED') {
    console.log(`[founder-lifetime-${kind}] ${consumerId} already in terminal state ${currentTier} — skipping`);
    return;
  }

  const flipLabel = kind === 'refund' ? 'REFUNDED' : 'DISPUTED';
  const stampField = kind === 'refund' ? 'Founder Refunded At' : 'Founder Disputed At';
  const reasonField = kind === 'refund' ? 'Founder Refund Reason' : 'Founder Dispute Reason';
  const reason: string =
    kind === 'refund'
      ? String(source?.refunds?.data?.[0]?.reason || source?.reason || 'unknown')
      : String(source?.reason || 'unknown');
  const amountCents: number =
    kind === 'refund'
      ? Number(source?.amount_refunded || source?.amount || 0)
      : Number(source?.amount || 0);

  const fields: Record<string, any> = {
    'Founder Tier': flipLabel,
    [stampField]: new Date().toISOString(),
    [reasonField]: reason.slice(0, 250),
  };
  await updateRecord(TABLES.CONSUMERS, consumerId, fields);

  // ── Decrement Redis counter so the tier seat is reclaimable ──
  // Only applies to numbered tiers (Founding 100 / Title Founder). The
  // counter key is `bhc:founder-number:<tier-slug>`. Use Redis DECR if the
  // module is configured; fail-open on miss (the Founder Number remains
  // "burned" until manually reset — better than crashing the webhook).
  const numberedTiers = ['Founding 100', 'Title Founder'];
  if (numberedTiers.includes(tierLabel)) {
    try {
      const { Redis } = await import('@upstash/redis');
      const url = process.env.UPSTASH_REDIS_REST_URL;
      const token = process.env.UPSTASH_REDIS_REST_TOKEN;
      if (url && token) {
        const redis = new Redis({ url, token });
        const key = `bhc:founder-number:${tierLabel.toLowerCase().replace(/\s+/g, '-')}`;
        // DECR — atomic. Bottoms out at 0 in Redis so we don't go negative
        // if the counter was already at the floor.
        const after = await redis.decr(key);
        if (typeof after === 'number' && after < 0) {
          await redis.set(key, 0);
        }
        console.log(`[founder-lifetime-${kind}] decremented counter ${key} → ${after}`);
      }
    } catch (e: any) {
      console.warn(`[founder-lifetime-${kind}] counter release failed (non-fatal):`, e?.message);
    }
  }

  // ── Operator alert ──
  // The DISPUTE variant is a chargeback — failure-class, so it rides the
  // loud sendOperatorSignal rail (SMS/email fallback when Telegram is down —
  // lib/signalDelivery.ts). The refund variant stays 'normal' urgency
  // (Telegram-only, delivery-equivalent to the old raw wire — refunds can be
  // self-initiated and don't warrant a 2am SMS). Never throws.
  {
    const name = String(consumer['Full Name'] || consumer['Email'] || consumerId);
    const amountDollars = (amountCents / 100).toFixed(2);
    const headline = kind === 'refund' ? 'FOUNDER LIFETIME REFUNDED' : 'FOUNDER LIFETIME DISPUTED';
    await sendOperatorSignal({
      urgency: kind === 'refund' ? 'normal' : 'loud',
      kind: kind === 'refund' ? 'sale' : 'dispute',
      summary: headline,
      detail: `<b>${name}</b>\nTier: ${tierLabel || '(unknown)'}\nAmount: $${amountDollars}\nReason: ${reason}\nPI ${piId.slice(-8)}\n\nWall placement removed. Seat counter released.`,
      dedupeKey: `founder-lifetime-${kind}:${piId || consumerId}`,
    });
  }

  try {
    await funnelRecord({
      stage: kind === 'refund' ? 'founder_lifetime_refunded' : 'founder_lifetime_disputed',
      buyerId: consumerId,
      amount: amountCents / 100,
      reason,
      metadata: { paymentIntentId: piId, tier: tierLabel },
    });
  } catch (e: any) {
    console.warn(`[founder-lifetime-${kind}] funnel record failed:`, e?.message);
  }

  await logAuditEntry({
    actor: 'cron',
    tool: `stripe-webhook-founder-lifetime-${kind}`,
    targetType: 'Consumer',
    targetId: consumerId,
    args: { paymentIntentId: piId, tier: tierLabel, amountCents, reason },
    result: { fields, counterReleased: numberedTiers.includes(tierLabel) },
    reverseAction: { type: 'noop', reason: `Stripe-driven founder lifetime ${kind} — cannot reverse via Airtable` },
  }).catch(e => console.error(`[audit] founder-lifetime-${kind} log failed:`, e));
}

// ============================================================================
// Helpers — brand price_id ↔ tier slug ↔ tier label.
// Used by handleBrandPartnerSubscriptionUpdated to detect downgrade.
// ============================================================================
function brandPriceIdToTierSlug(priceId: string): string | null {
  if (!priceId) return null;
  const map: Record<string, string> = {
    [process.env.STRIPE_BRAND_PRICE_SPOTLIGHT || '__unset_spotlight__']: 'spotlight',
    [process.env.STRIPE_BRAND_PRICE_FEATURED || '__unset_featured__']: 'featured',
    [process.env.STRIPE_BRAND_PRICE_FOUNDING || '__unset_founding__']: 'founding',
  };
  return map[priceId] || null;
}

function brandTierNameForSlug(slug: string): string {
  const names: Record<string, string> = {
    spotlight: 'Spotlight',
    featured: 'Featured',
    founding: 'Co-marketed',
  };
  return names[slug] || slug;
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

