// app/api/rancher/tier/portal/route.ts
//
// Stage-3 Task 4 — Stripe Customer Portal session for managing payment
// method, viewing invoices, cancelling subscription.
//
// V2: pass customer_account (NOT customer) to billingPortal.sessions.create.

import { NextResponse } from 'next/server';
import { getRecordById, TABLES } from '@/lib/airtable';
import { createBillingPortalSession } from '@/lib/stripeSubscription';
import { requireRancher } from '@/lib/rancherAuth';

export const dynamic = 'force-dynamic';
export const maxDuration = 20;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

export async function GET(req: Request) {
  if (process.env.STRIPE_CONNECT_ENABLED !== 'true') {
    return NextResponse.json({ error: 'Stripe Connect not enabled' }, { status: 503 });
  }

  const r = await requireRancher(req);
  if (r instanceof NextResponse) return r;
  const { session } = r;

  const rancher: any = await getRecordById(TABLES.RANCHERS, session.rancherId);
  if (!rancher) return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });

  const accountId = String(rancher['Stripe Connect Account Id'] || '');
  if (!accountId) {
    return NextResponse.json({ error: 'No Stripe account — pick a tier first' }, { status: 409 });
  }

  try {
    const { url } = await createBillingPortalSession(accountId, `${SITE_URL}/rancher/billing`);
    return NextResponse.json({ url });
  } catch (e: any) {
    console.error('[tier/portal] portal session create failed:', e?.message);
    return NextResponse.json({ error: `Portal session failed: ${e?.message || 'unknown'}` }, { status: 500 });
  }
}
