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
import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { createConnectAccount } from '@/lib/stripeConnect';
import { createTierCheckoutSession } from '@/lib/stripeSubscription';
import { TierSlug, TIERS } from '@/lib/tiers';
import { JWT_SECRET } from '@/lib/secrets';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

export async function POST(req: Request) {
  if (process.env.STRIPE_CONNECT_ENABLED !== 'true') {
    return NextResponse.json({ error: 'Stripe Connect not enabled' }, { status: 503 });
  }

  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get('bhc-rancher-auth');
  if (!sessionCookie?.value) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  let decoded: any;
  try { decoded = jwt.verify(sessionCookie.value, JWT_SECRET); }
  catch { return NextResponse.json({ error: 'Session expired' }, { status: 401 }); }
  if (decoded.type !== 'rancher-session') {
    return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
  }

  let body: any = {};
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }); }
  const tier = String(body.tier || '').toLowerCase() as TierSlug;
  if (!TIERS[tier]) {
    return NextResponse.json({ error: 'Invalid tier — must be pasture, ranch, or operator' }, { status: 400 });
  }

  const rancher: any = await getRecordById(TABLES.RANCHERS, decoded.rancherId);
  if (!rancher) return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });

  // Refuse if subscription already active
  if (rancher['Subscription Status'] === 'active' || rancher['Subscription Status'] === 'trialing') {
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
      const result = await createConnectAccount({ email, displayName, rancherId: decoded.rancherId });
      accountId = result.accountId;
    } catch (e: any) {
      console.error('[tier/select] V2 account create failed:', e?.message);
      return NextResponse.json({ error: `Stripe account create failed: ${e?.message || 'unknown'}` }, { status: 500 });
    }
    try {
      await updateRecord(TABLES.RANCHERS, decoded.rancherId, {
        'Stripe Connect Account Id': accountId,
        'Stripe Connect Status': 'onboarding',
        'Pricing Model': 'tier_v2',
      });
    } catch (e: any) {
      console.error('[tier/select] Airtable persist failed:', e?.message);
      // Continue — Stripe account exists; webhook can resync
    }
  }

  // Now create Checkout Session for the tier subscription
  try {
    const { url } = await createTierCheckoutSession({
      rancherId: decoded.rancherId,
      connectedAccountId: accountId,
      tier,
      successUrl: `${SITE_URL}/partner/checkout/${tier}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${SITE_URL}/partner/checkout/${tier}?canceled=1`,
    });
    return NextResponse.json({ url });
  } catch (e: any) {
    console.error('[tier/select] Checkout Session create failed:', e?.message);
    return NextResponse.json({ error: `Checkout failed: ${e?.message || 'unknown'}` }, { status: 500 });
  }
}
