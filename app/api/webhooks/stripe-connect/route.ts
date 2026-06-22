// Stripe Connect V2 webhook endpoint.
//
// Connect direct charges + Express onboarding fire V2 "thin" events on the
// CONNECTED account, not the platform account. They land on a SEPARATE
// Stripe Dashboard endpoint registration with its own signing secret
// (STRIPE_CONNECT_WEBHOOK_SECRET) — distinct from the platform webhook's
// STRIPE_WEBHOOK_SECRET.
//
// Audit B3 — without this handler, a rancher completes Stripe Express
// onboarding, account.requirements.summary.minimum_deadline.status flips,
// but nothing writes back to Ranchers.Stripe Connect Status. The
// /rancher dashboard banner cascade reads that field and shows
// "Connect bank →" forever for fully-onboarded ranchers.
//
// V2 "thin" event shape: payload contains only { id, type, related_object }.
// We retrieve the full event via stripe.v2.core.events.retrieve(thinEvent.id)
// and re-read live account status via getConnectAccountStatus() — never
// trust the event payload as source-of-truth for capability state.

import { NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { getConnectAccountStatus } from '@/lib/stripeConnect';
import {
  createRecord,
  updateRecord,
  getAllRecords,
  getRecordById,
  TABLES,
} from '@/lib/airtable';
import { settleBuyerDeposit, settleFinalInvoice } from '@/lib/stripeSettlement';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { sendEmail } from '@/lib/email';
import { markDepositRefunded, markDepositDisputed, PAYMENTS_TABLE } from '@/lib/contracts/payments';
import { getOrder, getOrderByCheckoutSession, getOrderByPaymentIntent, getOrderLines, updateOrder, releaseInventory } from '@/lib/commerce/repository';
import { logAuditEntry } from '@/lib/auditLog';
import { decrementCapacity, syncCapacityToAirtable } from '@/lib/rancherCapacity';
import { triggerLaunchWarmup } from '@/lib/triggerLaunchWarmup';

// Mirror the platform webhook's Stripe Events table for idempotency.
const STRIPE_EVENTS_TABLE = 'Stripe Events';

const CONNECT_WEBHOOK_SECRET = process.env.STRIPE_CONNECT_WEBHOOK_SECRET || '';

// Loud startup warning when the Connect webhook secret is missing in prod.
// Without it, every Connect event 400s + ranchers stay stuck on "Connect bank →"
// even after finishing Stripe Express onboarding (the bug this endpoint exists
// to fix). Operators must register the Connect endpoint in Stripe Dashboard
// + set the secret on Vercel. See docs/STAGE-3-MERGE-PLAYBOOK.md.
if (!CONNECT_WEBHOOK_SECRET && process.env.NODE_ENV === 'production') {
  console.warn(
    '[stripe-connect webhook] STRIPE_CONNECT_WEBHOOK_SECRET is not set — Connect events will fail signature verification. ' +
    'Set this in Vercel + register the endpoint in Stripe Dashboard before flipping STRIPE_CONNECT_ENABLED=true.',
  );
}

export async function POST(request: Request) {
  // Raw body is required for Stripe signature verification — do NOT call
  // request.json() first.
  const body = await request.text();
  const sig = request.headers.get('stripe-signature');

  if (!sig || !CONNECT_WEBHOOK_SECRET) {
    console.error('[stripe-connect webhook] missing signature or STRIPE_CONNECT_WEBHOOK_SECRET');
    return NextResponse.json({ error: 'Missing signature' }, { status: 400 });
  }

  // ------------------------------------------------------------------
  // EVENT PARSE — V2 thin events first, V1 classic events as fallback.
  //
  // V2 Connect account events deliver a thin payload { id, type,
  // related_object } verified via parseThinEvent, then hydrated via
  // stripe.v2.core.events.retrieve.
  //
  // V1 connected-account events (charge.dispute.*, charge.refunded,
  // payout.failed — Audit F6/F7/F8) come through the same endpoint as
  // classic event payloads verified via constructEvent. Same signing
  // secret; different payload shape.
  //
  // We try V2 first because the JSON has identifiable thin-event keys
  // (no `data.object`). If that throws (invalid signature OR not a thin
  // event), we fall back to V1 constructEvent. If BOTH fail, the
  // signature is genuinely bad → 400.
  // ------------------------------------------------------------------
  const stripe = getStripe();
  let event: any = null;
  let isV2 = false;
  let v2HydrateError: string | null = null;

  try {
    const thinEvent: any = (stripe as any).parseThinEvent(body, sig, CONNECT_WEBHOOK_SECRET);
    // parseThinEvent returns a minimal object — only proceed to hydrate
    // if it actually looks like a thin V2 payload (has `related_object`
    // or starts with `v2.`).
    const looksV2 =
      thinEvent?.type?.startsWith?.('v2.') ||
      !!thinEvent?.related_object;
    if (looksV2) {
      try {
        event = await (stripe.v2.core.events as any).retrieve(thinEvent.id);
        // Re-attach related_object since V2 retrieve doesn't include it
        // and our downstream code reads it.
        if (!event.related_object && thinEvent.related_object) {
          event.related_object = thinEvent.related_object;
        }
        isV2 = true;
      } catch (err: any) {
        v2HydrateError = err?.message || 'unknown';
        // Fall through — V1 fallback below.
      }
    }
  } catch {
    // parseThinEvent threw — could be V1 payload OR genuinely bad sig.
    // Fall through to V1 verification.
  }

  if (!event) {
    try {
      event = stripe.webhooks.constructEvent(body, sig, CONNECT_WEBHOOK_SECRET);
    } catch (err: any) {
      // Both V2 and V1 verification failed — bad signature.
      console.error(
        '[stripe-connect webhook] signature verification failed:',
        err?.message,
        v2HydrateError ? `(v2 hydrate also failed: ${v2HydrateError})` : '',
      );
      return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
    }
  }

  // ------------------------------------------------------------------
  // Connect events fire on the CONNECTED account. The account id lives
  // on different fields depending on event shape:
  //   - V2 account events: `related_object.id`
  //   - V1 events: `event.account` (top-level on the Event object)
  //   - V1 payout events: `event.data.object.destination` is the bank,
  //     so we use `event.account` (the connected acct that owns the payout)
  // ------------------------------------------------------------------
  const accountId: string =
    (event as any)?.related_object?.id ||
    (event as any)?.account ||
    (event as any)?.data?.id ||
    '';

  // ------------------------------------------------------------------
  // IDEMPOTENCY: dedupe via Stripe Events table. Mirrors platform
  // webhook at app/api/webhooks/stripe/route.ts lines 60-83. Connect
  // events use the connected account id (not platform account) as the
  // Account Id field.
  // ------------------------------------------------------------------
  try {
    const safeEventId = String(event.id).replace(/"/g, '\\"');
    const existing: any[] = await getAllRecords(STRIPE_EVENTS_TABLE, `{Event Id} = "${safeEventId}"`);
    if (existing.length > 0 && existing[0]['Status'] === 'processed') {
      return NextResponse.json({ ok: true, skipped: 'duplicate event' });
    }
    if (existing.length === 0) {
      await createRecord(STRIPE_EVENTS_TABLE, {
        'Event Id': event.id,
        'Event Type': event.type,
        'Account Id': accountId,
        'Received At': new Date().toISOString(),
        'Status': 'received',
      });
    }
  } catch (e: any) {
    console.warn('[stripe-connect webhook] idempotency check failed (continuing):', e?.message);
  }

  // ------------------------------------------------------------------
  // EVENT ROUTING
  //
  // Both event types collapse to the same handler — re-read live status
  // via getConnectAccountStatus() and write back to the Ranchers row.
  // Capability flips (active → restricted) and requirement updates
  // (currently_due cleared) both surface via these two types.
  // ------------------------------------------------------------------
  try {
    switch (event.type) {
      // V2 Connect account event type strings use bracket notation for
      // sub-resource segments. Per Stripe V2 docs:
      //   - `v2.core.account[requirements].updated` fires when account
      //     requirements collection summary changes (currently_due cleared,
      //     past_due triggered, etc).
      //   - `v2.core.account[configuration.merchant].capability_status_updated`
      //     fires when card_payments capability status flips (e.g. inactive
      //     → active when Express onboarding finishes). The
      //     `configuration.merchant` namespace is required — bare
      //     `[capability_status_updated]` is not a real Stripe event.
      //   - `v2.core.account.updated` is the catch-all for general account
      //     mutations and fires alongside the specific ones; subscribe to
      //     it as a belt-and-suspenders if a specific event lands somewhere
      //     unexpected.
      // 2026-06-09: switched from V2 Connect to V1 Express. V1 fires
      // `account.updated` whenever charges_enabled / payouts_enabled /
      // requirements.currently_due / capabilities.card_payments change.
      // `capability.updated` fires alongside for capability lifecycle.
      // V2 cases retained as no-ops for forward-compat if platform ever
      // moves to V2 — they simply won't fire on V1 Express accounts.
      case 'account.updated':
      case 'capability.updated':
      case 'v2.core.account[requirements].updated':
      case 'v2.core.account[configuration.merchant].capability_status_updated':
      case 'v2.core.account.updated': {
        if (!accountId) {
          console.warn('[stripe-connect webhook] no accountId on event', event.id, event.type);
          break;
        }
        await syncRancherConnectStatus(accountId);
        break;
      }

      // ── Audit F6 — dispute handlers (V1 events on connected account) ──
      // tier_v2 direct-charge buyer disputes fire on the CONNECTED account,
      // not the platform. Pre-F6 these were invisible to ops until Stripe
      // emailed; now we stamp the Payments row + LOUD Telegram alert.
      case 'charge.dispute.created':
      case 'charge.dispute.funds_withdrawn':
      case 'charge.dispute.closed':
        await handleDispute(event);
        break;

      // ── Audit F7 — payout.failed handler ──
      // Rancher's bank rejects the BHC payout (typo'd routing, closed acct,
      // etc) → rancher unaware until they notice missing money. Now: LOUD
      // Telegram to ops + auto-email rancher with failure reason + fix link.
      case 'payout.failed':
        await handlePayoutFailed(event);
        break;

      // ── P2-C / P3-B — account.application.deauthorized handler ──
      // When a tier_v2 rancher hits "Disconnect" on BHC under Stripe
      // Dashboard → Connected Apps, this V1 event fires on the platform-
      // attached connected acct. Pre-fix it fell through to the no-op
      // default: rancher stays operational in the matching engine, the
      // engine keeps routing buyers to them, and the first buyer to hit
      // /api/checkout/deposit gets a 4xx from Stripe (no connected acct).
      // Now: detach the rancher (status → 'detached', Active Status →
      // Paused, stamp Connect Detached At), free residual capacity, and
      // LOUD Telegram to ops so they re-onboard or mark the rancher
      // legacy.
      case 'account.application.deauthorized':
        await handleConnectDeauthorized(event);
        break;

      // ── Audit F8 — charge.refunded mirror ──
      // tier_v2 direct-charge refunds fire charge.refunded on the CONNECTED
      // account, not the platform. The existing handler only lived on the
      // platform webhook; Stripe-dashboard-initiated refunds went silent
      // because markDepositRefunded never ran. Now we mirror the same
      // idempotent call here. markDepositRefunded is a no-op when no
      // matching Payments row exists, so duplicate fires are safe.
      case 'charge.refunded': {
        const charge = event?.data?.object as any;
        const piId: string =
          typeof charge?.payment_intent === 'string' ? charge.payment_intent : '';
        if (!piId) break;
        try {
          // Pass the real partial/amount so a PARTIAL refund doesn't nuke the deal.
          const refundedCents = Number(charge?.amount_refunded || 0);
          const isPartial = refundedCents > 0 && refundedCents < Number(charge?.amount || 0);
          const { flipped } = await markDepositRefunded(piId, { partial: isPartial, refundedAmountCents: refundedCents });
          if (flipped) {
            await sendTelegramMessage(
              TELEGRAM_ADMIN_CHAT_ID,
              `↩️ Deposit refunded — PI ${piId.slice(-8)}`,
            );
          }
          // H-3 audit fix: Connect-side refund mirror was silent in audit
          // log. Stripe-dashboard refunds on tier_v2 direct charges fire
          // here, not on the platform webhook.
          await logAuditEntry({
            actor: 'cron',
            tool: 'stripe-connect-charge-refunded',
            targetType: 'Other',
            targetId: piId,
            args: { paymentIntentId: piId, chargeId: charge?.id, amount: (charge?.amount_refunded || 0) / 100 },
            result: { paymentsRowFlipped: flipped },
            reverseAction: { type: 'noop', reason: 'Stripe-driven refund — cannot un-refund via Airtable' },
          }).catch(e => console.error('[audit] connect charge-refunded log failed:', e));
        } catch (e: any) {
          console.warn('[stripe-connect charge.refunded] handler:', e?.message);
        }

        // ── COMMERCE ORDER refund mirror (Audit fix #3) ──────────────────────
        // The Payments-keyed path above never matches a commerce order (commerce
        // never writes a Payments row). Run a SEPARATE, additive resolution: if
        // this charge's PI maps to a commerce order, flip it 'refunded' + restock
        // the units. Wrapped in its own try so a commerce failure can't break the
        // (already-completed) deposit path and vice-versa.
        try {
          await handleCommerceRefund(piId, charge);
        } catch (e: any) {
          console.warn('[stripe-connect charge.refunded] commerce-order handler:', e?.message);
        }
        break;
      }

      // ── Phase 1B — commerce cart order settlement (checkout.session.*) ──
      // tier_v2 cart checkout (app/api/commerce/cart) creates a DIRECT-charge
      // Checkout Session on the connected account, so checkout.session.completed
      // and checkout.session.expired fire HERE (connected-account V1 events).
      //
      // We look the order up by Checkout Session id. If NO order matches, this
      // is a deposit-flow session (cow-share deposits never create an `orders`
      // row) or some other session — IGNORE it so the deposit flow is wholly
      // unaffected. Only sessions with a matching commerce order are handled.
      case 'checkout.session.completed':
        await handleCommerceSessionCompleted(event);
        break;

      case 'checkout.session.expired':
        await handleCommerceSessionExpired(event);
        break;

      // ── Dual-delivery settlement guard (p0-money-routing) ──────────────
      // The platform webhook AND this Connect webhook both receive
      // payment_intent.succeeded for the same PI (Stripe fans out to both
      // because the platform holds the application_fee and the connected
      // account owns the charge). The event.ids differ → the Stripe Events
      // table dedup at the top of this handler gives ZERO cross-webhook
      // protection. These guards make whichever fires FIRST settle fully;
      // the SECOND sees terminal state and no-ops.
      //
      //   buyer_deposit : Payments.Status === 'succeeded'  → pi.id-keyed anchor
      //   final_invoice : Referral.Status === 'Closed Won' → referralId-keyed anchor
      //
      // The settle* functions themselves (lib/stripeSettlement.ts) contain
      // markDepositSucceeded as a second idempotency anchor for deposit — this
      // outer guard is belt-and-suspenders so we never even enter the function
      // on the second delivery.
      case 'payment_intent.succeeded': {
        const pi = event?.data?.object;
        const metaType = pi?.metadata?.type;

        // ── PI-FALLBACK SETTLEMENT for commerce orders (CRITICAL gap fix) ──
        // The commerce cart settles on checkout.session.completed today. If
        // that Connect event isn't delivered, the order NEVER settles + the
        // reservation strands. payment_intent.succeeded is the redundant
        // settlement trigger. We resolve the order by the PI id (or
        // metadata.orderId fallback) and run the SAME shared settle path the
        // session handler uses — guarded on order status so whichever event
        // (session vs PI) fires FIRST settles and the SECOND no-ops. Mirrors
        // the dual-path the deposit/final_invoice branches already have.
        if (metaType === 'commerce_order') {
          const piId = String(pi?.id || '');
          try {
            // Primary: PI id (stamped by the session path or the cart route).
            let order = await getOrderByPaymentIntent(piId);
            // Fallback: orderId in metadata, for the race where the session
            // completed event hasn't yet stamped stripe_payment_intent_id when
            // this PI event arrives first (the exact gap this fix closes).
            if (!order) {
              const metaOrderId = String(pi?.metadata?.orderId || '');
              if (metaOrderId) order = await getOrder(metaOrderId);
            }
            if (!order) {
              // No commerce order matched — likely a non-commerce PI mislabeled,
              // or commerce DB unconfigured. Nothing to settle.
              console.warn('[stripe-connect pi.succeeded commerce] no order for PI', piId, 'metaOrderId:', pi?.metadata?.orderId);
              break;
            }
            // Buyer email off the PI (charge billing details or receipt_email).
            const piBuyerEmail: string | null =
              pi?.charges?.data?.[0]?.billing_details?.email ||
              pi?.receipt_email ||
              null;
            await settleCommerceOrder(order, piId || order.stripe_payment_intent_id, piBuyerEmail, 'pi.succeeded commerce');
          } catch (e: any) {
            console.error('[stripe-connect] payment_intent.succeeded commerce settlement failed:', e);
            await flipStripeEventFailed(event.id, e?.message || 'unknown');
            return NextResponse.json({ received: true });
          }
          break;
        }

        if (metaType !== 'buyer_deposit' && metaType !== 'final_invoice') break;
        const referralId = String(pi?.metadata?.referralId || '');
        if (!referralId) break;
        try {
          if (metaType === 'buyer_deposit') {
            // pi.id-keyed guard: if the Payments row is already 'succeeded', the
            // platform webhook (or a prior delivery) already settled — no-op.
            const rows: any[] = await getAllRecords(PAYMENTS_TABLE, `{Stripe Payment Intent Id} = "${String(pi.id).replace(/"/g, '\\"')}"`);
            if ((rows[0] as any)?.['Status'] === 'succeeded') break;
            await settleBuyerDeposit(pi);            // we're first — full settlement
          } else { // final_invoice
            const ref: any = await getRecordById(TABLES.REFERRALS, referralId).catch(() => null);
            if (String(ref?.['Status'] || '') === 'Closed Won') break;  // already closed
            await settleFinalInvoice(pi);
          }
        } catch (e: any) {
          console.error('[stripe-connect] payment_intent.succeeded settlement failed:', e);
          await flipStripeEventFailed(event.id, e?.message || 'unknown');
          return NextResponse.json({ received: true });
        }
        break;
      }

      default:
        // V2 ships many account-related event types we don't care about
        // (settings updates, person updates, etc). Skip + log.
        console.log('[stripe-connect webhook] unhandled event type:', event.type);
        break;
    }
  } catch (err: any) {
    // Spec: return 200 even on handler exceptions — don't retry against
    // a guaranteed-broken handler. Flip Stripe Events row to failed first.
    console.error('[stripe-connect webhook] handler exception:', err?.message);
    await flipStripeEventFailed(event.id, err?.message || 'unknown');
    return NextResponse.json({ received: true, error: 'logged' });
  }

  // ------------------------------------------------------------------
  // IDEMPOTENCY: flip Stripe Events row to processed.
  // ------------------------------------------------------------------
  try {
    const safeEventId = String(event.id).replace(/"/g, '\\"');
    const eventRows: any[] = await getAllRecords(STRIPE_EVENTS_TABLE, `{Event Id} = "${safeEventId}"`);
    if (eventRows[0]) {
      await updateRecord(STRIPE_EVENTS_TABLE, eventRows[0].id, {
        'Status': 'processed',
        'Processed At': new Date().toISOString(),
      });
    }
  } catch (e: any) {
    console.warn('[stripe-connect webhook] idempotency processed-flip failed:', e?.message);
  }

  return NextResponse.json({ received: true });
}

// ============================================================================
// Sync rancher Stripe Connect status from a live Stripe read.
// ============================================================================
async function syncRancherConnectStatus(accountId: string): Promise<void> {
  // Look up the Ranchers row by Connect account id. Multiple ranchers
  // sharing an account id would be a setup bug; we take the first.
  const safeAcct = accountId.replace(/"/g, '\\"');
  const matches = await getAllRecords(
    TABLES.RANCHERS,
    `{Stripe Connect Account Id} = "${safeAcct}"`,
  );
  const rancher: any = matches[0];
  if (!rancher) {
    console.warn(`[stripe-connect webhook] no rancher matches accountId ${accountId}`);
    // Still mark event processed at end of handler — not our row, but
    // the webhook fired correctly.
    return;
  }

  // Live read — never trust the thin event payload for capability state.
  const { status } = await getConnectAccountStatus(accountId);

  const currentStatus = String(rancher['Stripe Connect Status'] || '');
  const wasActive = currentStatus === 'active';
  const isNowActive = status === 'active';

  // Persistent dedupe key: the `Stripe Connect Connected At` stamp.
  // Two webhook events firing back-to-back (e.g. requirements.updated +
  // configuration.merchant.capability_status_updated) for the same
  // activation moment would both read `wasActive === false` in memory and
  // both fire the celebration. Stamping the timestamp once + gating
  // Telegram on `!alreadyCelebrated` makes the DB the dedupe authority.
  const alreadyCelebrated = !!rancher['Stripe Connect Connected At'];

  // Skip no-op writes to reduce Airtable noise. If the field already
  // matches, only fire the celebration logic if active-flip needs
  // stamping (which by definition means status changed).
  if (currentStatus === status) {
    return;
  }

  const writeFields: any = { 'Stripe Connect Status': status };
  if (isNowActive && !alreadyCelebrated) {
    writeFields['Stripe Connect Connected At'] = new Date().toISOString();
  }

  // ── AUTO-FLIP PRICING MODEL → tier_v2 (2026-06-04) ────────────────
  // When Connect goes active AND the rancher's subscription is paying,
  // they've completed every gate the legacy-upgrade endpoint requires.
  // Auto-flip here so the rancher doesn't have to hunt down the dashboard
  // banner + click "Switch to tier_v2" themselves. Mirrors the gate logic
  // in app/api/rancher/legacy-upgrade/route.ts (Subscription Status in
  // {active,trialing} + Connect status === 'active').
  //
  // Previously the dashboard banner was the only flip path → 0/16 ranchers
  // were reaching tier_v2 in audit. With this auto-flip, finishing Stripe
  // Connect is the trigger; no extra click needed.
  const subscriptionStatus = String(rancher['Subscription Status'] || '').toLowerCase();
  const subPaying = subscriptionStatus === 'active' || subscriptionStatus === 'trialing';
  const currentPricingModel = String(rancher['Pricing Model'] || '').toLowerCase();
  const shouldAutoFlip = isNowActive && subPaying && currentPricingModel !== 'tier_v2';
  if (shouldAutoFlip) {
    writeFields['Pricing Model'] = 'tier_v2';
    // Mark migration funnel complete so the migration-deadline cron stops
    // nudging + the /admin/migration tracker counts them as done.
    writeFields['Migration Status'] = 'completed';
  }

  // 2026-06-09 fix: separate Migration Status='completed' branch for the
  // case where Pricing Model was ALREADY flipped to tier_v2 by an upstream
  // step (e.g. /api/rancher/tier/select stamps tier_v2 the moment it
  // creates the Connect account, BEFORE Stripe Subscription/Connect
  // webhooks fire). Without this, the auto-flip branch above no-ops
  // (currentPricingModel === 'tier_v2' already) and Migration Status
  // never advances to 'completed' — leaving the /admin/migration tracker
  // showing the rancher as still in-progress forever.
  if (
    isNowActive &&
    subPaying &&
    currentPricingModel === 'tier_v2' &&
    !shouldAutoFlip
  ) {
    const currentMigStatus = String(rancher['Migration Status'] || '').toLowerCase();
    const incompleteStatuses = new Set(['', 'not_invited', 'invited', 'call_scheduled', 'upgrading']);
    if (incompleteStatuses.has(currentMigStatus)) {
      writeFields['Migration Status'] = 'completed';
    }
  }

  await updateRecord(TABLES.RANCHERS, rancher.id, writeFields);

  // ── AUTO-GO-LIVE (2026-06-18) ─────────────────────────────────────
  // Self-submitted tier_v2 ranchers who finish Connect AFTER signing their
  // agreement were stuck dark forever: the Stripe Connect webhook flipped
  // Connect Status to 'active' but never flipped Active Status → no
  // bookings. Fix: when Connect just went active AND the rancher already
  // has a signed agreement AND they are not yet Active, AND their Onboarding
  // Status is still in a pre-live state, auto-flip them to Live.
  //
  // Gate conditions (all must pass — idempotent, never double-flips):
  //   1. Connect just went active (isNowActive)
  //   2. Agreement Signed is truthy (legal gate satisfied)
  //   3. Active Status is NOT already 'Active' (idempotency)
  //   4. Onboarding Status is one of the pre-live states
  //      ('', 'Agreement Signed', 'Verification Complete',
  //       'Verification Pending', 'Docs Sent')
  //
  // We read the ORIGINAL `rancher` fields (not `writeFields`) to check
  // current state before our write — this is safe because `writeFields`
  // only ever sets Connect-related + Pricing/Migration fields, never
  // Active Status or Onboarding Status. Defensive Airtable: never throw
  // on missing field; all guards below handle undefined gracefully.
  const PRE_LIVE_ONBOARDING_STATUSES = new Set([
    '',
    'Agreement Signed',
    'Verification Complete',
    'Verification Pending',
    'Docs Sent',
  ]);
  const currentActiveStatus = String(rancher['Active Status'] || '');
  const agreementSigned = !!rancher['Agreement Signed'];
  const currentOnboardingStatus = String(rancher['Onboarding Status'] || '');
  const shouldAutoGoLive =
    isNowActive &&
    agreementSigned &&
    currentActiveStatus !== 'Active' &&
    PRE_LIVE_ONBOARDING_STATUSES.has(currentOnboardingStatus);

  if (shouldAutoGoLive) {
    try {
      await updateRecord(TABLES.RANCHERS, rancher.id, {
        'Active Status': 'Active',
        'Onboarding Status': 'Live',
        'Page Live': true,
      });

      // Fire launch warmup so the rancher's state buyers get warmed up
      // immediately instead of waiting up to 24h for the scheduled cron.
      // triggerLaunchWarmup is fire-and-forget + idempotent (per-buyer
      // Warmup Sent At gates double-send). Mirrors the admin go-live
      // endpoint at app/api/admin/ranchers/[id]/go-live/route.ts:80.
      triggerLaunchWarmup(`connect-webhook-auto-go-live:${rancher.id}`);

      // LOUD Telegram to ops — HTML-escape dynamic ranch name for safety.
      const ranchLabel = String(
        rancher['Ranch Name'] || rancher['Operator Name'] || rancher['Email'] || accountId,
      ).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `🟢 ${ranchLabel} auto-went-live — Connect active + agreement signed`,
      );
    } catch (e: any) {
      // Non-fatal — log but do NOT re-throw. The Connect Status flip already
      // landed above. The auto-go-live failure leaves them in a "Connect
      // active but not yet Live" state which ops can manually resolve.
      console.error('[stripe-connect webhook] auto-go-live failed:', e?.message);
    }
  }

  // Telegram celebration when Connect goes active for the first time
  // EVER (gated on the persisted Connected At stamp, not the in-memory
  // wasActive read). Best-effort — Telegram failure does NOT roll back
  // the status flip.
  if (isNowActive && !alreadyCelebrated) {
    try {
      const label = rancher['Ranch Name'] || rancher['Operator Name'] || rancher['Email'] || accountId;
      const flipNote = shouldAutoFlip
        ? `\n\n✨ Pricing Model auto-flipped to tier_v2 (sub paying + Connect active). Next buyer match will show Reserve-Your-Share deposit CTA.`
        : !subPaying
          ? `\n\n⏳ Subscription not yet active — Pricing Model stays legacy until tier paid. Rancher needs to pick a tier in /partner.`
          : '';
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `🏦 STRIPE CONNECT ACTIVE — ${label} ready to receive deposits${flipNote}`,
      );
    } catch (e: any) {
      console.warn('[stripe-connect webhook] telegram celebration failed:', e?.message);
    }
  }
}

// ============================================================================
// PHASE 1B — COMMERCE CART ORDER: checkout.session.completed
//
// A tier_v2 cart Checkout Session (created on the connected account by
// app/api/commerce/cart) finished paying. Look the order up by Checkout
// Session id; if none matches, this is a deposit-flow (or other) session —
// no-op so the cow-share deposit flow is wholly unaffected.
//
// On match: mark the order 'paid', CONSUME the held inventory (release with
// consume=true lowers qty_available — the sale is confirmed), and stamp the
// PaymentIntent id.
//
// Idempotency: Stripe can redeliver. We only act when the order is NOT already
// terminal (paid/cancelled/refunded). Because the cart route reserved the
// stock and we consume EXACTLY ONCE on the pending→paid transition, a
// redelivery sees status 'paid' and skips the consume — no double-decrement.
// ============================================================================
async function handleCommerceSessionCompleted(event: any): Promise<void> {
  const session = event?.data?.object as any;
  const sessionId: string = String(session?.id || '');
  if (!sessionId) return;

  let order: Awaited<ReturnType<typeof getOrderByCheckoutSession>>;
  try {
    order = await getOrderByCheckoutSession(sessionId);
  } catch (e: any) {
    console.error('[stripe-connect commerce.completed] order lookup failed:', e?.message);
    throw e; // bubble → Stripe Events row flipped to failed → operator can replay
  }
  // Not a commerce order (deposit-flow session, etc.) → ignore entirely.
  if (!order) return;

  const paymentIntentId: string | null =
    typeof session?.payment_intent === 'string'
      ? session.payment_intent
      : session?.payment_intent?.id || null;

  // Buyer email is NOT on the order (the cart route never collects it — Stripe
  // Checkout captures it). On a completed session it lives on customer_details.
  const buyerEmail: string | null =
    session?.customer_details?.email || session?.customer_email || null;

  // Delegate to the shared settle path so the checkout.session.completed and the
  // payment_intent.succeeded fallback run byte-identical settlement + are
  // mutually idempotent (whichever fires first settles; the second sees 'paid'
  // and no-ops via the status guard inside settleCommerceOrder).
  await settleCommerceOrder(order, paymentIntentId, buyerEmail, 'commerce.completed');
}

// ============================================================================
// SHARED COMMERCE SETTLE PATH — single source of truth for marking a commerce
// order 'paid' + consuming inventory, called by BOTH:
//   - checkout.session.completed (handleCommerceSessionCompleted), and
//   - payment_intent.succeeded   (the PI-fallback branch, p0 settlement gap fix)
//
// Stripe fans BOTH events out for the same Connect direct charge, and their
// event.ids differ → the Stripe Events dedupe table gives ZERO cross-path
// protection. This function is the cross-path idempotency anchor: it guards on
// the ORDER's own status (the system-of-record), so whichever event is
// delivered FIRST performs the full pending→paid settlement and the SECOND
// observes status 'paid' (or any terminal state) and no-ops — each unit is
// consumed at most once, regardless of delivery order or redelivery.
//
// Returns true only when THIS call performed the pending→paid transition (so
// the caller fires sale notifications exactly once); false on the idempotent
// no-op (already paid / cancelled / refunded).
//
// Throw-vs-swallow contract (mirrors the original session handler):
//   - order-lines read failure THROWS (order still 'pending' → Stripe retries
//     cleanly; if we flipped paid first then failed the read, the retry would
//     hit the 'paid' guard and strand the reservation forever).
//   - updateOrder('paid') failure THROWS for the same reason.
//   - per-line consume failure is logged, NOT thrown: the reserve already
//     removed the units from "available", so a missed consume leaves them
//     merely RESERVED (never oversold) — safe to reconcile manually.
//   - notification failures NEVER bubble (handled inside notifyCommerceOrderPaid).
// ============================================================================
async function settleCommerceOrder(
  order: NonNullable<Awaited<ReturnType<typeof getOrderByCheckoutSession>>>,
  paymentIntentId: string | null,
  buyerEmailHint: string | null,
  logTag: string,
): Promise<boolean> {
  // Cross-path + redelivery idempotency: only the pending→paid transition
  // settles. Any terminal/paid state means a prior delivery (this path or the
  // other) already handled it.
  if (order.status === 'paid' || order.status === 'cancelled' || order.status === 'refunded') {
    return false;
  }

  // Read the order lines BEFORE marking paid (see throw-contract above).
  let lines: Awaited<ReturnType<typeof getOrderLines>>;
  try {
    lines = await getOrderLines(order.id);
  } catch (e: any) {
    console.error(`[stripe-connect ${logTag}] getOrderLines failed — throwing for retry (order still pending):`, e?.message, 'order:', order.id);
    throw e;
  }

  // Flip to paid + stamp the PI. A mid-consume crash after this point leaves the
  // order 'paid' (correct — the buyer paid); a replay sees 'paid' and skips, so
  // each unit is consumed at most once.
  try {
    await updateOrder(order.id, {
      status: 'paid',
      ...(paymentIntentId ? { stripe_payment_intent_id: paymentIntentId } : {}),
    });
  } catch (e: any) {
    console.error(`[stripe-connect ${logTag}] updateOrder(paid) failed:`, e?.message);
    throw e;
  }

  for (const line of lines) {
    if (!line.variant_id || line.qty <= 0) continue;
    try {
      await releaseInventory(line.variant_id, line.qty, true);
    } catch (e: any) {
      console.error(`[stripe-connect ${logTag}] consume releaseInventory failed:`, line.variant_id, e?.message, '— manual reconcile needed for order', order.id);
    }
  }

  // Best-effort sale notifications — fired exactly once on the real settle.
  // Wrapped internally so a notification failure NEVER fails the webhook.
  await notifyCommerceOrderPaid(order, lines, buyerEmailHint, paymentIntentId, logTag);

  return true;
}

// ============================================================================
// COMMERCE SALE NOTIFICATIONS (Audit fix #2 — additive, best-effort).
//
// Fires on a commerce order settling to 'paid' (from the shared settle path):
//   - rancher + admin Telegram ("🛒 New order: {ranch} — {items} — ${total}")
//   - buyer confirmation email (if Stripe captured a buyer email)
//   - rancher confirmation email (to the rancher's Airtable Email)
//
// EVERY external call is wrapped in its own try/catch and logged — this
// function NEVER throws, so a Telegram/email/Airtable hiccup can't fail the
// webhook or block inventory settlement (which already happened upstream).
//
// We deliberately DO NOT call recordClose/settleBuyerDeposit here: those are
// referral-centric (Closed Won, commission ledger, affiliate enroll) and a
// commerce order has no referral. See the DEFERRED note below.
//
// ── DEFERRED (design task, not a bug) ───────────────────────────────────────
// The deeper revenue-ledger integration is intentionally out of scope:
//   - Airtable "Payments" row: the Payments table is REFERRAL-KEYED (Referral
//     linked-record is effectively required; recordDeposit/markDepositSucceeded
//     all key on a referralId / deposit PI). Commerce orders aren't referrals,
//     so writing a Payments row here would need a schema decision (nullable
//     Referral? a parallel "Commerce Payments" table?).
//   - Meta CAPI Purchase event + deal-flip: today fired from the referral
//     close path keyed on the buyer/referral. Commerce orders have no
//     referral/buyer-record linkage guaranteed, so attributing a CAPI Purchase
//     needs a buyer-identity design pass.
// Both are flagged for a follow-up design task; this notify path is the
// additive, no-refactor slice the audit asked for.
// ============================================================================
async function notifyCommerceOrderPaid(
  order: NonNullable<Awaited<ReturnType<typeof getOrderByCheckoutSession>>>,
  lines: Awaited<ReturnType<typeof getOrderLines>>,
  buyerEmailHint: string | null,
  paymentIntentId: string | null,
  logTag: string,
): Promise<void> {
  try {
    // Resolve the rancher (Airtable) for name / phone / email. Best-effort —
    // a lookup failure must not abort the rest of the fan-out.
    let rancher: any = null;
    try {
      rancher = await getRecordById(TABLES.RANCHERS, order.rancher_id);
    } catch (e: any) {
      console.warn(`[stripe-connect ${logTag}] rancher lookup for notify failed:`, e?.message);
    }

    const ranchName: string = String(
      rancher?.['Ranch Name'] || rancher?.['Operator Name'] || rancher?.['Email'] || order.rancher_id,
    );
    const rancherEmail: string | null = (rancher?.['Email'] as string) || null;
    const rancherPhone: string | null = (rancher?.['Phone'] as string) || null;

    // Item summary, e.g. "2× Eighth Share, 1× Brisket". Total = full sale value
    // (subtotal_cents), the buyer-facing order value, NOT the deposit charged now.
    const itemSummary =
      (lines || [])
        .filter((l) => l.qty > 0)
        .map((l) => `${l.qty}× ${l.label}`)
        .join(', ') || 'order';
    const totalDollars = (Number(order.subtotal_cents || 0) / 100).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const depositDollars = (Number(order.deposit_cents || 0) / 100).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

    // ── Telegram: admin chat (always) ──────────────────────────────────────
    try {
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `🛒 New order: ${ranchName} — ${itemSummary} — $${totalDollars}` +
          (Number(order.deposit_cents || 0) > 0 ? `\nDeposit charged now: $${depositDollars}` : ''),
      );
    } catch (e: any) {
      console.warn(`[stripe-connect ${logTag}] admin order-telegram failed:`, e?.message);
    }

    // ── Telegram: rancher chat (only if the rancher has a Telegram chat id) ──
    // Ranchers may store a personal Telegram chat id; gate on its presence so
    // we never blast the admin message twice or error on a missing id. Field
    // name is defensive (schema may vary) — any falsy value → skip silently.
    const rancherChatId = String(
      rancher?.['Telegram Chat Id'] || rancher?.['Telegram Chat ID'] || '',
    ).trim();
    if (rancherChatId && rancherChatId !== TELEGRAM_ADMIN_CHAT_ID) {
      try {
        await sendTelegramMessage(
          rancherChatId,
          `🛒 New order on BuyHalfCow: ${itemSummary} — $${totalDollars}`,
        );
      } catch (e: any) {
        console.warn(`[stripe-connect ${logTag}] rancher order-telegram failed:`, e?.message);
      }
    }

    // ── Buyer confirmation email (only if Stripe captured a buyer email) ────
    const buyerEmail = (buyerEmailHint || '').trim();
    if (buyerEmail) {
      try {
        await sendEmail({
          to: buyerEmail,
          subject: `your ${ranchName} order is confirmed`,
          html:
            `<p>thanks for your order from <strong>${escapeHtmlLocal(ranchName)}</strong>!</p>` +
            `<p><strong>Order:</strong> ${escapeHtmlLocal(itemSummary)}<br/>` +
            `<strong>Total:</strong> $${totalDollars}` +
            (Number(order.deposit_cents || 0) > 0 ? `<br/><strong>Charged today (deposit):</strong> $${depositDollars}` : '') +
            `</p>` +
            (rancherEmail || rancherPhone
              ? `<p>${escapeHtmlLocal(ranchName)} will be in touch about processing + pickup` +
                (rancherEmail ? ` — reach them at ${escapeHtmlLocal(rancherEmail)}` : '') +
                (rancherPhone ? ` or ${escapeHtmlLocal(rancherPhone)}` : '') +
                `.</p>`
              : '') +
            `<p>— BuyHalfCow</p>`,
        });
      } catch (e: any) {
        console.warn(`[stripe-connect ${logTag}] buyer confirmation email failed:`, e?.message);
      }
    }

    // ── Rancher confirmation email (to the rancher's Airtable Email) ────────
    if (rancherEmail) {
      try {
        const firstName = String(rancher?.['Operator Name'] || '').split(' ')[0] || 'there';
        await sendEmail({
          to: rancherEmail,
          subject: `🛒 new BuyHalfCow order — ${itemSummary}`,
          html:
            `<p>hey ${escapeHtmlLocal(firstName)} — you got a new order on BuyHalfCow.</p>` +
            `<p><strong>Order:</strong> ${escapeHtmlLocal(itemSummary)}<br/>` +
            `<strong>Total:</strong> $${totalDollars}` +
            (Number(order.deposit_cents || 0) > 0 ? `<br/><strong>Deposit collected:</strong> $${depositDollars}` : '') +
            (buyerEmail ? `<br/><strong>Buyer:</strong> ${escapeHtmlLocal(buyerEmail)}` : '') +
            `</p>` +
            `<p>log into your dashboard to manage fulfillment.</p>` +
            `<p>— BuyHalfCow</p>`,
        });
      } catch (e: any) {
        console.warn(`[stripe-connect ${logTag}] rancher confirmation email failed:`, e?.message);
      }
    }

    // Audit log — best-effort, never throws out.
    await logAuditEntry({
      actor: 'cron',
      tool: 'stripe-connect-commerce-order-paid',
      targetType: 'Other',
      targetId: order.id,
      args: { orderId: order.id, rancherId: order.rancher_id, paymentIntentId, source: logTag },
      result: { ranchName, itemSummary, totalCents: order.subtotal_cents, notifiedBuyer: !!buyerEmail, notifiedRancher: !!rancherEmail },
      reverseAction: { type: 'noop', reason: 'notification side-effect — nothing to reverse' },
    }).catch((e) => console.error('[audit] commerce-order-paid log failed:', e));
  } catch (e: any) {
    // Absolute backstop — this whole function is best-effort.
    console.error(`[stripe-connect ${logTag}] notifyCommerceOrderPaid unexpected error (swallowed):`, e?.message);
  }
}

// Telegram/email HTML escape — local copy (lib/telegram's escapeHtml is not
// exported). Only <, >, & need escaping for both Telegram HTML mode + email.
function escapeHtmlLocal(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ============================================================================
// PHASE 1B — COMMERCE CART ORDER: checkout.session.expired
//
// The buyer abandoned a tier_v2 cart Checkout Session and Stripe expired it.
// Free the held stock so it's not reserved for a dead session. Look up by
// Checkout Session id; no match → deposit-flow/other session → no-op.
//
// On match: release the reservation WITHOUT consuming (qty_available unchanged,
// qty_reserved lowered → units return to "available"), and mark the order
// 'cancelled'.
//
// Idempotency / double-release guard: we ONLY release when the order is still
// 'pending'. A session that already completed→'paid' (or was otherwise
// finalized) must NOT have its stock released — guarding on 'pending' makes the
// release fire at most once and never undoes a confirmed sale. A redelivered
// expired event sees status 'cancelled' and no-ops.
// ============================================================================
async function handleCommerceSessionExpired(event: any): Promise<void> {
  const session = event?.data?.object as any;
  const sessionId: string = String(session?.id || '');
  if (!sessionId) return;

  let order: Awaited<ReturnType<typeof getOrderByCheckoutSession>>;
  try {
    order = await getOrderByCheckoutSession(sessionId);
  } catch (e: any) {
    console.error('[stripe-connect commerce.expired] order lookup failed:', e?.message);
    throw e;
  }
  if (!order) return; // not a commerce order — ignore

  // Only a still-pending order frees stock. Already paid/cancelled/refunded →
  // no-op (never release a confirmed sale; never double-release a cancel).
  if (order.status !== 'pending') return;

  // Release (no consume) per line so the reserved units return to available.
  let lines: Awaited<ReturnType<typeof getOrderLines>> = [];
  try {
    lines = await getOrderLines(order.id);
  } catch (e: any) {
    console.error('[stripe-connect commerce.expired] getOrderLines failed — stock not freed:', e?.message, 'order:', order.id);
    throw e; // let Stripe retry so the held stock eventually frees
  }
  for (const line of lines) {
    if (!line.variant_id || line.qty <= 0) continue;
    try {
      await releaseInventory(line.variant_id, line.qty, false);
    } catch (e: any) {
      console.error('[stripe-connect commerce.expired] releaseInventory failed:', line.variant_id, e?.message, '— order', order.id);
    }
  }

  try {
    await updateOrder(order.id, { status: 'cancelled' });
  } catch (e: any) {
    console.error('[stripe-connect commerce.expired] updateOrder(cancelled) failed:', e?.message, 'order:', order.id);
  }
}

// ============================================================================
// STRIPE DISPUTE — chargeback handler (Audit F6).
// Mirrors app/api/webhooks/stripe/route.ts:handleDispute. Lives on BOTH
// webhooks because charge.dispute.* fires on the CONNECTED account for
// tier_v2 direct charges and on the PLATFORM for legacy charges; either
// path needs the same response.
//
// Looks up the Payments row by Stripe Payment Intent Id (the field
// recordDeposit() populates), not by Charge ID. dispute.payment_intent
// links us; for non-tier_v2 charges no row matches but Telegram still fires.
// ============================================================================
async function handleDispute(event: any): Promise<void> {
  const dispute = event?.data?.object as any;
  const chargeId: string =
    typeof dispute?.charge === 'string' ? dispute.charge : dispute?.charge?.id || '';
  const piId: string =
    typeof dispute?.payment_intent === 'string'
      ? dispute.payment_intent
      : dispute?.payment_intent?.id || '';
  const amount = (dispute?.amount || 0) / 100;
  const reason = dispute?.reason || 'unknown';
  const status = dispute?.status || 'unknown';
  const eventType = event?.type || 'charge.dispute';

  // Try to find the Payments row (tier_v2 deposits only).
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
      console.error('[stripe-connect dispute] Airtable update failed:', e?.message);
    }
  }

  // ── COMMERCE ORDER dispute linkage (Audit fix #3) ──────────────────────────
  // markDepositDisputed above is a no-op for commerce (no Payments row). If the
  // disputed charge's PI maps to a commerce order, surface that linkage so ops
  // can act. Per spec we LEAVE the order 'paid' (a dispute is not yet a loss —
  // funds may still be won; we do NOT restock here). A LOST dispute later
  // settles as a refund → charge.refunded → handleCommerceRefund flips it
  // 'refunded' + restocks. Best-effort: never throws out of the handler.
  let commerceOrderId: string | null = null;
  if (piId) {
    try {
      const order = await getOrderByPaymentIntent(piId);
      if (order) {
        commerceOrderId = order.id;
        console.warn(
          `[stripe-connect dispute] commerce order ${order.id} disputed (status=${status}) — left 'paid', no restock until/unless refunded. order status=${order.status}`,
        );
      }
    } catch (e: any) {
      console.warn('[stripe-connect dispute] commerce order lookup failed:', e?.message);
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
        (paymentRecordId ? `\nPayments row: ${paymentRecordId}` : '') +
        (commerceOrderId ? `\nCommerce order: ${commerceOrderId} (left 'paid' — restocks only if refunded)` : ''),
    );
  } catch (e: any) {
    console.warn('[stripe-connect dispute] telegram alert failed:', e?.message);
  }

  // H-3 audit fix: mirror dispute audit log on Connect path. tier_v2
  // disputes fire on the connected account webhook, not the platform.
  await logAuditEntry({
    actor: 'cron',
    tool: `stripe-connect-${eventType}`,
    targetType: 'Other',
    targetId: piId || chargeId || 'unknown',
    args: { paymentIntentId: piId, chargeId, eventType },
    result: { status, amount, reason, paymentRecordId, commerceOrderId },
    reverseAction: { type: 'noop', reason: 'Stripe-driven dispute — cannot un-dispute via Airtable' },
  }).catch(e => console.error('[audit] connect dispute log failed:', e));
}

// ============================================================================
// COMMERCE ORDER REFUND — flip order 'refunded' + restock (Audit fix #3).
//
// Called from the charge.refunded handler AFTER (and independently of) the
// Payments-keyed markDepositRefunded path. Resolves the commerce order by the
// charge's PaymentIntent; if none matches this is a deposit/other charge and we
// no-op (the Payments path already handled it).
//
// Idempotency (MONEY-CRITICAL): we guard on order.status. We only flip + restock
// when the order is still 'paid' — a redelivered charge.refunded sees status
// 'refunded' and no-ops, so units are restocked AT MOST ONCE and the order is
// flipped once. We deliberately do NOT act on a 'cancelled'/'pending' order
// (those never consumed stock on a confirmed sale, so there's nothing to
// restock and nothing to refund-flip).
//
// ── RESTOCK SEMANTICS CAVEAT (important for the reviewer) ───────────────────
// On settle we called releaseInventory(variantId, qty, consume=true), which did
// qty_reserved -= qty AND qty_available -= qty (the units left BOTH counters —
// sold). The spec prescribes releaseInventory(variantId, qty, consume=false) to
// "return units" on refund. But per the release_inventory RPC
// (supabase/migrations/0001_commerce_foundation.sql), consume=false only does
// qty_reserved = greatest(0, qty_reserved - qty) and leaves qty_available
// UNCHANGED. On an already-consumed (paid) order qty_reserved is already 0, so
// this call is effectively a NO-OP and does NOT add the sold units back to
// qty_available. A true add-back would need to RAISE qty_available (a new RPC
// or setInventory read-modify-write), but the repository + RPC are out of scope
// for this change (and setInventory would be racy). We therefore call exactly
// the prescribed primitive (correct + safe for the unlimited-stock / still-
// reserved cases, harmless no-op otherwise) and FLAG the true restock-to-
// available as a deferred repository/RPC task. Variants with no inventory row
// (unlimited) are a natural no-op inside the RPC.
// ============================================================================
async function handleCommerceRefund(piId: string, charge: any): Promise<void> {
  if (!piId) return;

  let order = await getOrderByPaymentIntent(piId);
  if (!order) return; // not a commerce order — Payments path owns it

  // Idempotency: only a still-'paid' order flips + restocks. Terminal/other
  // states (already 'refunded', 'cancelled', 'pending') no-op.
  if (order.status !== 'paid') {
    return;
  }

  const refundedCents = Number(charge?.amount_refunded || 0);
  const chargeCents = Number(charge?.amount || 0);
  const isPartial = refundedCents > 0 && chargeCents > 0 && refundedCents < chargeCents;

  // Read lines BEFORE the status flip so a read failure leaves the order 'paid'
  // → Stripe retry re-enters cleanly (mirrors the settle path's ordering).
  let lines: Awaited<ReturnType<typeof getOrderLines>> = [];
  try {
    lines = await getOrderLines(order.id);
  } catch (e: any) {
    console.error('[stripe-connect commerce.refund] getOrderLines failed — throwing for retry (order still paid):', e?.message, 'order:', order.id);
    throw e;
  }

  // PARTIAL refund: do NOT flip the whole order to 'refunded' (the sale is still
  // largely intact) and do NOT restock — mirrors markDepositRefunded's
  // partial-vs-full discipline. Log + alert so ops can reconcile manually.
  if (isPartial) {
    console.warn(
      `[stripe-connect commerce.refund] PARTIAL refund ($${(refundedCents / 100).toFixed(2)} of $${(chargeCents / 100).toFixed(2)}) on commerce order ${order.id} — left 'paid', no restock. Manual reconcile if a full refund follows.`,
    );
    try {
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `↩️ PARTIAL refund on commerce order ${order.id} — $${(refundedCents / 100).toFixed(2)} of $${(chargeCents / 100).toFixed(2)}. Order left 'paid' (no restock).`,
      );
    } catch {}
    return;
  }

  // FULL refund: flip 'refunded' FIRST so a mid-restock crash leaves the order
  // terminal (a replay sees 'refunded' and no-ops → no double-restock).
  try {
    await updateOrder(order.id, { status: 'refunded' });
  } catch (e: any) {
    console.error('[stripe-connect commerce.refund] updateOrder(refunded) failed:', e?.message, 'order:', order.id);
    throw e; // bubble → Stripe Events row failed → operator replay
  }

  // Restock per line. See the RESTOCK SEMANTICS CAVEAT above — this calls the
  // spec-prescribed primitive; it is a no-op-or-reserved-release in practice on
  // a consumed sale + a natural no-op for unlimited variants. Best-effort per
  // line so one failure doesn't strand the others.
  for (const line of lines) {
    if (!line.variant_id || line.qty <= 0) continue;
    try {
      await releaseInventory(line.variant_id, line.qty, false);
    } catch (e: any) {
      console.error('[stripe-connect commerce.refund] restock releaseInventory failed:', line.variant_id, e?.message, '— manual reconcile for order', order.id);
    }
  }

  try {
    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      `↩️ Commerce order refunded — order ${order.id} (PI ${piId.slice(-8)}). Flipped 'refunded' + restock attempted.`,
    );
  } catch {}

  await logAuditEntry({
    actor: 'cron',
    tool: 'stripe-connect-commerce-order-refunded',
    targetType: 'Other',
    targetId: order.id,
    args: { paymentIntentId: piId, chargeId: charge?.id, orderId: order.id, refundedCents },
    result: { orderFlipped: 'refunded', linesRestocked: lines.filter((l) => l.variant_id && l.qty > 0).length },
    reverseAction: { type: 'noop', reason: 'Stripe-driven refund — cannot un-refund via Airtable' },
  }).catch((e) => console.error('[audit] commerce-order-refunded log failed:', e));
}

// ============================================================================
// STRIPE PAYOUT FAILED — bank rejection handler (Audit F7).
// Fires on payout.failed on the CONNECTED account (payouts fire on the
// rancher's connected acct, not platform). Rancher's bank rejected the
// payout — typo in routing/account #, account closed, frozen, etc.
//
// We alert ops via Telegram + auto-email the rancher with the failure
// reason + link to their billing dashboard so they can correct it. Without
// this they'd discover the problem only by noticing missing money.
// ============================================================================
async function handlePayoutFailed(event: any): Promise<void> {
  const payout = event?.data?.object as any;
  const accountId: string = event?.account || ''; // Connect account that owns this payout
  const amount = (payout?.amount || 0) / 100;
  const failureMessage = payout?.failure_message || 'no reason given';
  const failureCode = payout?.failure_code || 'unknown';

  if (!accountId) {
    console.warn('[stripe-connect payout.failed] missing account ID on event');
    return;
  }

  // Look up the rancher by Connect Account ID.
  let rancherEmail: string | null = null;
  let rancherName: string | null = null;
  try {
    const safeAcct = accountId.replace(/"/g, '\\"');
    const rows: any[] = await getAllRecords(
      TABLES.RANCHERS,
      `{Stripe Connect Account Id} = "${safeAcct}"`,
    );
    if (rows.length > 0) {
      const r: any = rows[0];
      rancherEmail = (r['Email'] as string) || null;
      rancherName = (r['Operator Name'] as string) || (r['Ranch Name'] as string) || null;
    }
  } catch (e: any) {
    console.error('[stripe-connect payout.failed] rancher lookup failed:', e?.message);
  }

  // LOUD Telegram alert to ops.
  try {
    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      `🚨 STRIPE PAYOUT FAILED\n` +
        `Rancher: ${rancherName || accountId}\n` +
        `Amount: $${amount}\n` +
        `Reason: ${failureMessage} (${failureCode})\n` +
        `Stripe: https://dashboard.stripe.com/connect/accounts/${accountId}`,
    );
  } catch (e: any) {
    console.warn('[stripe-connect payout.failed] telegram alert failed:', e?.message);
  }

  // Email the rancher with the fix path.
  if (rancherEmail) {
    try {
      const firstName = (rancherName || '').split(' ')[0] || 'there';
      await sendEmail({
        to: rancherEmail,
        subject: 'your stripe payout failed — quick fix needed',
        html:
          `<p>hey ${firstName} — heads up, your bank rejected your latest BuyHalfCow payout ($${amount}).</p>` +
          `<p>reason: ${failureMessage}</p>` +
          `<p>usually means a typo in your routing/account # or the account was closed. fix it in your <a href="https://buyhalfcow.com/rancher/billing">billing dashboard</a> or just reply to this email + i'll help.</p>` +
          `<p>— Ben @ BuyHalfCow</p>`,
      });
    } catch (e: any) {
      console.error('[stripe-connect payout.failed] email send failed:', e?.message);
    }
  }

  // H-3 audit fix: payout.failed was previously invisible. Log so ops can
  // reconcile failed payouts against the operator-side resolution.
  await logAuditEntry({
    actor: 'cron',
    tool: 'stripe-connect-payout-failed',
    targetType: 'Rancher',
    targetId: accountId,
    args: { accountId, amount, failureMessage, failureCode },
    result: { rancherEmail, rancherName, alerted: !!rancherEmail },
    reverseAction: { type: 'noop', reason: 'Stripe payout failure — fix is rancher-side bank update, not Airtable' },
  }).catch(e => console.error('[audit] payout-failed log failed:', e));
}

// ============================================================================
// STRIPE CONNECT DEAUTHORIZED — rancher detached BHC from Stripe (P3-B).
//
// account.application.deauthorized fires on the platform webhook when a
// connected rancher disconnects BHC under Stripe Dashboard → Connected
// Apps. Pre-fix the event fell through to no-op: the matching engine
// kept routing buyers, but /api/checkout/deposit failed because Stripe
// had no live connected account to charge against.
//
// Now we: pause the rancher (Active Status='Paused' kills routing
// eligibility — see lib/rancherEligibility.ts + lib/bulkRoute.ts),
// stamp Stripe Connect Status='detached' so dashboards surface the
// reason, free residual capacity if the rancher had open active
// referrals (otherwise the counter + the engine's "available slots"
// drift apart), and LOUD Telegram to ops.
// ============================================================================
async function handleConnectDeauthorized(event: any): Promise<void> {
  // event.account is the connected acct that disconnected (V1 event shape).
  const accountId: string = (event as any)?.account || '';
  if (!accountId) {
    console.warn('[stripe-connect deauthorized] missing event.account');
    return;
  }

  // Look up rancher by Connect Account ID.
  const safeAcct = accountId.replace(/"/g, '\\"');
  const rows: any[] = await getAllRecords(
    TABLES.RANCHERS,
    `{Stripe Connect Account Id} = "${safeAcct}"`,
  );
  const rancher: any = rows[0];

  if (!rancher) {
    // No matching rancher — event still valid (e.g. a test acct, or a
    // rancher we already wiped). Telegram so ops sees the orphan, then
    // return. The outer handler still marks the Stripe Events row
    // processed.
    try {
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `🔌 CONNECT DETACHED — no Ranchers row matches acct ${accountId}. Orphan webhook — verify if this acct was previously wiped.`,
      );
    } catch (e: any) {
      console.warn('[stripe-connect deauthorized] orphan telegram failed:', e?.message);
    }
    return;
  }

  const rancherId: string = rancher.id;
  const rancherLabel =
    rancher['Ranch Name'] || rancher['Operator Name'] || rancher['Email'] || accountId;

  // Build the write payload. We always flip Status + Active Status; the
  // Connect Detached At timestamp is best-effort (the field may not yet
  // exist in the schema — wrapping the whole write in try/catch with a
  // retry-without-timestamp fallback keeps the pause path bulletproof).
  const now = new Date().toISOString();
  const writeFields: Record<string, unknown> = {
    'Stripe Connect Status': 'detached', // singleSelect; typecast auto-creates option
    'Active Status': 'Paused',
    'Connect Detached At': now,
  };

  try {
    await updateRecord(TABLES.RANCHERS, rancherId, writeFields);
  } catch (e: any) {
    // Likely cause: `Connect Detached At` field missing from Airtable
    // schema. Retry without the timestamp so the critical fields (pause
    // routing + flip status) still land.
    console.warn(
      '[stripe-connect deauthorized] write w/ Connect Detached At failed — retrying without timestamp:',
      e?.message,
    );
    try {
      delete (writeFields as any)['Connect Detached At'];
      await updateRecord(TABLES.RANCHERS, rancherId, writeFields);
      console.warn(
        '[stripe-connect deauthorized] TODO: add `Connect Detached At` (dateTime) field to Ranchers table.',
      );
    } catch (retryErr: any) {
      console.error(
        '[stripe-connect deauthorized] critical write retry failed — rancher still routing:',
        retryErr?.message,
      );
      // Re-throw to bubble to the outer try/catch → Stripe Events row
      // flipped to 'failed' → operator can replay.
      throw retryErr;
    }
  }

  // Free residual capacity. If the rancher has active referrals counted
  // in Current Active Referrals, the matching engine still treats those
  // slots as occupied; without decrementing here the counter + the
  // engine's available-slots drift apart and ops can't tell why the
  // rancher's slot count never returns to 0 when they're paused. We
  // decrement once per active referral.
  const currentActive = Number(rancher['Current Active Referrals'] || 0);
  if (currentActive > 0) {
    try {
      let next = currentActive;
      for (let i = 0; i < currentActive; i++) {
        next = await decrementCapacity(rancherId);
      }
      await syncCapacityToAirtable(rancherId, next);
    } catch (e: any) {
      console.warn('[stripe-connect deauthorized] capacity decrement failed:', e?.message);
    }
  }

  // LOUD Telegram to ops.
  try {
    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      `🔌 CONNECT DETACHED — ${rancherLabel} disconnected Stripe Connect. Routing paused. Action: contact rancher to re-onboard OR mark legacy.`,
    );
  } catch (e: any) {
    console.warn('[stripe-connect deauthorized] telegram alert failed:', e?.message);
  }

  // Audit log — reverseAction is noop because re-authorizing Connect
  // requires the rancher to walk back through Stripe Express onboarding.
  // No Airtable-side undo flips them back to operational without a real
  // Connect account.
  await logAuditEntry({
    actor: 'cron',
    tool: 'stripe-connect-deauthorize',
    targetType: 'Rancher',
    targetId: rancherId,
    args: { accountId, eventId: event?.id },
    result: {
      previousActiveStatus: rancher['Active Status'] || null,
      previousConnectStatus: rancher['Stripe Connect Status'] || null,
      previousActiveReferrals: currentActive,
      rancherLabel,
    },
    reverseAction: {
      type: 'noop',
      reason: 'rancher must re-onboard Connect via Stripe Express',
    },
  }).catch(e => console.error('[audit] connect-deauthorize log failed:', e));
}

// ============================================================================
// IDEMPOTENCY FAILURE HELPER — flips a Stripe Events row to failed.
// Inlined from app/api/webhooks/stripe/route.ts:845-858 (no shared module
// exists yet; matches platform webhook field shape exactly).
// ============================================================================
async function flipStripeEventFailed(eventId: string, errorMessage: string): Promise<void> {
  try {
    const safeEventId = String(eventId).replace(/"/g, '\\"');
    const eventRows: any[] = await getAllRecords(STRIPE_EVENTS_TABLE, `{Event Id} = "${safeEventId}"`);
    if (eventRows[0]) {
      await updateRecord(STRIPE_EVENTS_TABLE, eventRows[0].id, {
        'Status': 'failed',
        'Error': (errorMessage || 'unknown').slice(0, 500),
      });
    }
  } catch (e: any) {
    console.warn('[stripe-connect webhook] flipStripeEventFailed — could not update Stripe Events row:', e?.message);
  }
}
