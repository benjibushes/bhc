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
  TABLES,
} from '@/lib/airtable';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { sendEmail } from '@/lib/email';
import { markDepositRefunded, PAYMENTS_TABLE } from '@/lib/contracts/payments';

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
          const { flipped } = await markDepositRefunded(piId);
          if (flipped) {
            await sendTelegramMessage(
              TELEGRAM_ADMIN_CHAT_ID,
              `↩️ Deposit refunded — PI ${piId.slice(-8)}`,
            );
          }
        } catch (e: any) {
          console.warn('[stripe-connect charge.refunded] handler:', e?.message);
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
  await updateRecord(TABLES.RANCHERS, rancher.id, writeFields);

  // Telegram celebration when Connect goes active for the first time
  // EVER (gated on the persisted Connected At stamp, not the in-memory
  // wasActive read). Best-effort — Telegram failure does NOT roll back
  // the status flip.
  if (isNowActive && !alreadyCelebrated) {
    try {
      const label = rancher['Ranch Name'] || rancher['Operator Name'] || rancher['Email'] || accountId;
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `🏦 STRIPE CONNECT ACTIVE — ${label} ready to receive deposits`,
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
