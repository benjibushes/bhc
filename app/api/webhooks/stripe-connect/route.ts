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
  getFirstRecord,
  getRecordById,
  TABLES,
} from '@/lib/airtable';
import { settleBuyerDeposit, settleFinalInvoice, isPermanentSettlementError } from '@/lib/stripeSettlement';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { sendEmail } from '@/lib/email';
import { markDepositRefunded, markDepositDisputed } from '@/lib/contracts/payments';
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
    // Event Id is unique — getFirstRecord (maxRecords:1) instead of paginating
    // the whole filtered scan. Same decision logic on the single row.
    const existing = await getFirstRecord(STRIPE_EVENTS_TABLE, `{Event Id} = "${safeEventId}"`);
    if (existing && existing['Status'] === 'processed') {
      return NextResponse.json({ ok: true, skipped: 'duplicate event' });
    }
    if (!existing) {
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
        break;
      }

      // ── Dual-delivery settlement guard (p0-money-routing) ──────────────
      // The platform webhook AND this Connect webhook both receive
      // payment_intent.succeeded for the same PI (Stripe fans out to both
      // because the platform holds the application_fee and the connected
      // account owns the charge). The event.ids differ → the Stripe Events
      // table dedup at the top of this handler gives ZERO cross-webhook
      // protection. These guards make whichever fires FIRST settle fully;
      // the SECOND sees terminal state and no-ops.
      //
      //   buyer_deposit : claimOnce(settle-deposit:<pi.id>) + Payments.Status
      //                   flip INSIDE settleBuyerDeposit → pi.id-keyed anchors
      //   final_invoice : Referral.Status === 'Closed Won' → referralId-keyed anchor
      //
      // E3 efficiency (m8): the buyer_deposit branch used to pre-scan Payments
      // by PI here and then settleBuyerDeposit re-ran the IDENTICAL query via
      // markDepositSucceeded — 2 scans of the hottest table per delivery. The
      // outer pre-scan is dropped: a repeat delivery re-enters
      // settleBuyerDeposit, where the claimOnce serializer and/or the
      // already-succeeded row flip short-circuit BEFORE any non-idempotent
      // side effect (funnel/email/Telegram). Same terminal behavior, 1 scan.
      case 'payment_intent.succeeded': {
        const pi = event?.data?.object;
        const metaType = pi?.metadata?.type;
        if (metaType !== 'buyer_deposit' && metaType !== 'final_invoice') break;
        const referralId = String(pi?.metadata?.referralId || '');
        if (!referralId) break;
        try {
          if (metaType === 'buyer_deposit') {
            // Idempotency lives inside settleBuyerDeposit (claimOnce +
            // markDepositSucceeded's pi.id-keyed row flip) — see block comment.
            await settleBuyerDeposit(pi);
          } else { // final_invoice
            const ref: any = await getRecordById(TABLES.REFERRALS, referralId).catch(() => null);
            if (String(ref?.['Status'] || '') === 'Closed Won') break;  // already closed
            await settleFinalInvoice(pi);
          }
        } catch (e: any) {
          console.error('[stripe-connect] payment_intent.succeeded settlement failed:', e);
          await flipStripeEventFailed(event.id, e?.message || 'unknown');
          // C1: these deposit + final-invoice PIs are DIRECT charges on the
          // connected account, so Stripe delivers payment_intent.succeeded ONLY
          // to THIS endpoint. Returning 200 on a TRANSIENT failure (Airtable
          // 429/timeout) orphaned real paid money — Stripe treats 200 as success
          // and never redelivers. Mirror the platform webhook (stripe/route.ts):
          // return 5xx on a transient failure so Stripe redelivers and the
          // deposit/final-invoice self-heals. This is SAFE because both settle*
          // functions throw only before/at their idempotency anchor, and a
          // redelivered event re-runs (flipStripeEventFailed sets Status='failed',
          // and the dedup at the top skips only 'processed') into the pi.id-keyed
          // anchors inside settleBuyerDeposit / the Closed-Won guard above — so a
          // redelivery can never double-settle or double-notify.
          // Only a PERMANENT failure (malformed metadata that can never settle)
          // returns 200 to stop pointless 3-day redelivery.
          if (isPermanentSettlementError(e)) {
            return NextResponse.json({ received: true, permanent: true });
          }
          return NextResponse.json({ error: 'settlement_retry' }, { status: 500 });
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
    const eventRow = await getFirstRecord(STRIPE_EVENTS_TABLE, `{Event Id} = "${safeEventId}"`);
    if (eventRow) {
      await updateRecord(STRIPE_EVENTS_TABLE, eventRow.id, {
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
  // sharing an account id would be a setup bug; we take the first
  // (getFirstRecord = maxRecords:1, same first row as the old full scan).
  const safeAcct = accountId.replace(/"/g, '\\"');
  const rancher: any = await getFirstRecord(
    TABLES.RANCHERS,
    `{Stripe Connect Account Id} = "${safeAcct}"`,
  );
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
    result: { status, amount, reason, paymentRecordId },
    reverseAction: { type: 'noop', reason: 'Stripe-driven dispute — cannot un-dispute via Airtable' },
  }).catch(e => console.error('[audit] connect dispute log failed:', e));
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
    const r: any = await getFirstRecord(
      TABLES.RANCHERS,
      `{Stripe Connect Account Id} = "${safeAcct}"`,
    );
    if (r) {
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
          `<p>usually means a typo in your routing/account # or the account was closed. fix it in your <a href="https://www.buyhalfcow.com/rancher/billing">billing dashboard</a> or just reply to this email + i'll help.</p>` +
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
  const rancher: any = await getFirstRecord(
    TABLES.RANCHERS,
    `{Stripe Connect Account Id} = "${safeAcct}"`,
  );

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
    const eventRow = await getFirstRecord(STRIPE_EVENTS_TABLE, `{Event Id} = "${safeEventId}"`);
    if (eventRow) {
      await updateRecord(STRIPE_EVENTS_TABLE, eventRow.id, {
        'Status': 'failed',
        'Error': (errorMessage || 'unknown').slice(0, 500),
      });
    }
  } catch (e: any) {
    console.warn('[stripe-connect webhook] flipStripeEventFailed — could not update Stripe Events row:', e?.message);
  }
}
