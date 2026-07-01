// app/api/rancher/tier/select/route.ts
//
// Stage-3 Task 4 — initial tier pick. Creates V2 Connect account if not
// already created, then creates a Checkout Session for the tier subscription.
//
// Order (critical):
//   1. Auth
//   2. Read rancher
//   3. If no Stripe Connect Account Id: createConnectAccount + persist
//      IMMEDIATELY (so subscription on customer_account works)
//   4. createTierCheckoutSession with customer_account = acct_*
//   5. Return { url }
//
// Refuses if STRIPE_CONNECT_ENABLED !== 'true'. Refuses if subscription
// already active (use /tier/change instead).

import { NextResponse } from 'next/server';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { createConnectAccount } from '@/lib/stripeConnect';
import { createTierCheckoutSession } from '@/lib/stripeSubscription';
import { TierSlug, TIERS } from '@/lib/tiers';
import { requireRancher } from '@/lib/rancherAuth';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

export async function POST(req: Request) {
  if (process.env.STRIPE_CONNECT_ENABLED !== 'true') {
    return NextResponse.json({ error: 'Stripe Connect not enabled' }, { status: 503 });
  }

  const r = await requireRancher(req);
  if (r instanceof NextResponse) return r;
  const { session } = r;

  let body: any = {};
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }); }
  const tier = String(body.tier || '').toLowerCase() as TierSlug;
  // When the request originates from the self-serve setup wizard, thread the
  // wizard token so Stripe sends the rancher BACK into the wizard (at the
  // Connect step) instead of /rancher/billing — otherwise paying ranchers
  // skip Fulfillment + Refund Policy + Sign. Mirrors the connect/start route.
  const fromWizard = body?.from === 'wizard';
  const wizardToken = typeof body?.wizardToken === 'string' ? body.wizardToken : '';
  if (!TIERS[tier]) {
    return NextResponse.json(
      { error: 'Invalid tier — must be pasture, ranch, operator, or legacy_connect' },
      { status: 400 },
    );
  }

  const rancher: any = await getRecordById(TABLES.RANCHERS, session.rancherId);
  if (!rancher) return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });

  // Refuse only if a REAL paid subscription is already active. legacy_connect
  // has no subscription so this gate doesn't apply.
  //
  // CRITICAL (Legacy Connect → Pasture deadlock fix): Legacy Connect ranchers
  // carry a SYNTHETIC 'active' Subscription Status with NO `Stripe Subscription
  // Id`. Without the hasRealSubscription guard below, they 409 here ("use
  // tier/change") while tier/change 409s them back ("no subscription → use
  // tier/select") — so they can NEVER start a real paid tier. Gate on a real
  // Stripe Subscription Id so a synthetic-active Legacy Connect rancher can
  // start a genuine Pasture/Ranch/Operator subscription through this route.
  const hasRealSubscription = !!String(rancher['Stripe Subscription Id'] || '').trim();
  if (
    tier !== 'legacy_connect' &&
    hasRealSubscription &&
    (rancher['Subscription Status'] === 'active' || rancher['Subscription Status'] === 'trialing')
  ) {
    return NextResponse.json(
      { error: 'Subscription already active — use /api/rancher/tier/change to switch tiers' },
      { status: 409 },
    );
  }

  // Create Connect account first (idempotent via persisted Account Id)
  let accountId: string = String(rancher['Stripe Connect Account Id'] || '');
  if (!accountId) {
    const email = String(rancher['Email'] || '').trim();
    if (!email) {
      return NextResponse.json({ error: 'Rancher email required' }, { status: 400 });
    }
    const displayName = String(rancher['Operator Name'] || rancher['Ranch Name'] || 'BHC Rancher').trim();
    try {
      const result = await createConnectAccount({ email, displayName, rancherId: session.rancherId });
      accountId = result.accountId;
    } catch (e: any) {
      console.error('[tier/select] V2 account create failed:', e?.message);
      return NextResponse.json({ error: `Stripe account create failed: ${e?.message || 'unknown'}` }, { status: 500 });
    }
    try {
      await updateRecord(TABLES.RANCHERS, session.rancherId, {
        'Stripe Connect Account Id': accountId,
        'Stripe Connect Status': 'onboarding',
        'Pricing Model': 'tier_v2',
      });
    } catch (e: any) {
      console.error('[tier/select] Airtable persist failed:', e?.message);
      // Continue — Stripe account exists; webhook can resync
    }
  }

  // 2026-06-09 hybrid path: legacy_connect skips Stripe Subscription
  // creation entirely. The rancher pays NO monthly fee — they keep
  // their 10% commission rate (from lib/tiers.ts TIERS.legacy_connect.
  // commissionRate=0.10) but get Stripe Connect direct-deposit payouts.
  //
  // Persist Tier='Legacy Connect' + synthetic Subscription Status='active'
  // so all downstream gates (matching engine, deposit route, /admin/migration
  // tracker) treat them as a paying tier_v2 rancher even though no Stripe
  // Subscription object exists.
  //
  // Typecast=true so Airtable auto-creates the 'Legacy Connect' singleSelect
  // choice on first write if not present (we couldn't add it via Meta API
  // earlier — meta endpoint rejected the choices PATCH).
  if (tier === 'legacy_connect') {
    try {
      // updateRecord already retries with typecast=true internally
      // (lib/airtable.ts:201) — Airtable creates the 'Legacy Connect'
      // singleSelect choice automatically on first write.
      await updateRecord(TABLES.RANCHERS, session.rancherId, {
        'Tier': 'Legacy Connect',
        'Pricing Model': 'tier_v2',
        // Synthetic 'active' so isQualifiedForRouting + matching engine
        // see legacy_connect ranchers as eligible. application_fee_amount
        // is still computed from TIERS.legacy_connect.commissionRate (10%).
        'Subscription Status': 'active',
        // Mark the migration funnel mid-flight since legacy_connect has
        // no subscription gate. Connect webhook refines to 'completed'
        // once the bank is actually connected.
        'Migration Status': 'upgrading',
      });
    } catch (e: any) {
      console.error('[tier/select] legacy_connect persist failed:', e?.message);
      return NextResponse.json(
        { error: `Could not persist Legacy Connect tier: ${e?.message || 'unknown'}` },
        { status: 500 },
      );
    }
    // No Stripe Checkout URL to return — wizard reads `skipCheckout: true`
    // and advances straight to Step 9 (Stripe Connect onboarding).
    return NextResponse.json({
      skipCheckout: true,
      tier: 'legacy_connect',
      nextStep: 'connect',
      message: 'Legacy Connect selected — go connect your bank account.',
    });
  }

  // Now create Checkout Session for the tier subscription (Pasture / Ranch / Operator).
  // Wizard callers return INTO the wizard (Step 9 / Connect via tierComplete=1)
  // so they keep going through Fulfillment + Sign; non-wizard callers (e.g. the
  // /partner/checkout pages) keep the original success/cancel pages.
  const successUrl =
    fromWizard && wizardToken
      ? `${SITE_URL}/rancher/setup?token=${encodeURIComponent(wizardToken)}&tierComplete=1`
      : `${SITE_URL}/partner/checkout/${tier}/success?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl =
    fromWizard && wizardToken
      ? `${SITE_URL}/rancher/setup?token=${encodeURIComponent(wizardToken)}`
      : `${SITE_URL}/partner/checkout/${tier}?canceled=1`;
  try {
    const { url } = await createTierCheckoutSession({
      rancherId: session.rancherId,
      connectedAccountId: accountId,
      tier,
      successUrl,
      cancelUrl,
    });
    return NextResponse.json({ url });
  } catch (e: any) {
    console.error('[tier/select] Checkout Session create failed:', e?.message);
    return NextResponse.json({ error: `Checkout failed: ${e?.message || 'unknown'}` }, { status: 500 });
  }
}
