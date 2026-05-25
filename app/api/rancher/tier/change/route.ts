// app/api/rancher/tier/change/route.ts
//
// Stage-3 Task 4 — tier upgrade/downgrade via subscription.update w/ proration.
//
// Body: { tier: TierSlug }
// Requires existing Stripe Subscription Id on rancher row.

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';
import { getRecordById, TABLES } from '@/lib/airtable';
import { changeSubscriptionTier } from '@/lib/stripeSubscription';
import { TierSlug, TIERS } from '@/lib/tiers';
import { JWT_SECRET } from '@/lib/secrets';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

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
  const newTier = String(body.tier || '').toLowerCase() as TierSlug;
  if (!TIERS[newTier]) {
    return NextResponse.json({ error: 'Invalid tier' }, { status: 400 });
  }

  const rancher: any = await getRecordById(TABLES.RANCHERS, decoded.rancherId);
  if (!rancher) return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });

  const subscriptionId = String(rancher['Stripe Subscription Id'] || '');
  if (!subscriptionId) {
    return NextResponse.json(
      { error: 'No active subscription — use /api/rancher/tier/select to start one' },
      { status: 409 },
    );
  }

  try {
    await changeSubscriptionTier(subscriptionId, newTier);
    // Webhook will fire customer.subscription.updated → updates Airtable Tier field
    return NextResponse.json({ ok: true, newTier });
  } catch (e: any) {
    console.error('[tier/change] subscription update failed:', e?.message);
    return NextResponse.json({ error: `Tier change failed: ${e?.message || 'unknown'}` }, { status: 500 });
  }
}
