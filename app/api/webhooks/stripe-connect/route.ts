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

// Mirror the platform webhook's Stripe Events table for idempotency.
const STRIPE_EVENTS_TABLE = 'Stripe Events';

const CONNECT_WEBHOOK_SECRET = process.env.STRIPE_CONNECT_WEBHOOK_SECRET || '';

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
  // V2 THIN EVENT PARSE + HYDRATE
  //
  // V2 webhooks deliver a thin payload { id, type, related_object }. We
  // verify the signature via parseThinEvent then retrieve the full event
  // via stripe.v2.core.events.retrieve(thinEvent.id).
  //
  // The Stripe SDK (v20.4.1) types lag behind the V2 surface — cast on
  // the resource, NOT on the params, so we keep param shape validation.
  // ------------------------------------------------------------------
  const stripe = getStripe();
  let thinEvent: any;
  try {
    thinEvent = (stripe as any).parseThinEvent(body, sig, CONNECT_WEBHOOK_SECRET);
  } catch (err: any) {
    console.error('[stripe-connect webhook] signature verification failed:', err?.message);
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  let event: any;
  try {
    event = await (stripe.v2.core.events as any).retrieve(thinEvent.id);
  } catch (err: any) {
    console.error('[stripe-connect webhook] failed to hydrate event', thinEvent?.id, err?.message);
    // Return 200 — Stripe will not retry a hydrate failure usefully and
    // we'd just keep retrying against an unreachable id.
    return NextResponse.json({ received: true, error: 'hydrate_failed' });
  }

  // ------------------------------------------------------------------
  // Connect events fire on the CONNECTED account. The account id lives
  // on `related_object.id` for v2.core.account[...] events; some shapes
  // surface it as `data.id`. Support both for safety.
  // ------------------------------------------------------------------
  const accountId: string =
    (event as any)?.related_object?.id ||
    (event as any)?.data?.id ||
    (thinEvent as any)?.related_object?.id ||
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
      case 'v2.core.account[requirements].updated':
      case 'v2.core.account[capability_status_updated]': {
        if (!accountId) {
          console.warn('[stripe-connect webhook] no accountId on event', event.id, event.type);
          break;
        }
        await syncRancherConnectStatus(accountId);
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

  // Skip no-op writes to reduce Airtable noise. If the field already
  // matches, only fire the celebration logic if active-flip needs
  // stamping (which by definition means status changed).
  if (currentStatus === status) {
    return;
  }

  const writeFields: any = { 'Stripe Connect Status': status };
  if (!wasActive && isNowActive) {
    writeFields['Stripe Connect Connected At'] = new Date().toISOString();
  }
  await updateRecord(TABLES.RANCHERS, rancher.id, writeFields);

  // Telegram celebration when Connect goes active for the first time.
  // Best-effort — Telegram failure does NOT roll back the status flip.
  if (!wasActive && isNowActive) {
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
