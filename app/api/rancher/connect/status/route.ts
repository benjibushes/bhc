// app/api/rancher/connect/status/route.ts
//
// Stage-3 Task 7 — live Stripe Connect status read.
//
// Used by /rancher/billing dashboard on page mount + post-onboarding return.
// ALWAYS reads from Stripe API directly (never cached) per BHC convention.
// Airtable's Stripe Connect Status field is a webhook-refreshed UI hint.

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';
import { getRecordById, TABLES } from '@/lib/airtable';
import { getConnectAccountStatus } from '@/lib/stripeConnect';
import { JWT_SECRET } from '@/lib/secrets';

export const dynamic = 'force-dynamic';
export const maxDuration = 20;

export async function GET(_req: Request) {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get('bhc-rancher-auth');
  if (!sessionCookie?.value) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  let decoded: any;
  try {
    decoded = jwt.verify(sessionCookie.value, JWT_SECRET);
  } catch {
    return NextResponse.json({ error: 'Session expired' }, { status: 401 });
  }
  if (decoded.type !== 'rancher-session') {
    return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
  }

  const rancher: any = await getRecordById(TABLES.RANCHERS, decoded.rancherId);
  if (!rancher) return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });

  const accountId = String(rancher['Stripe Connect Account Id'] || '');
  if (!accountId) {
    return NextResponse.json({ status: 'not_connected' as const });
  }

  try {
    const result = await getConnectAccountStatus(accountId);
    return NextResponse.json(result);
  } catch (e: any) {
    console.error('[connect/status] Stripe retrieve failed:', e?.message);
    return NextResponse.json(
      { error: `Stripe read failed: ${e?.message || 'unknown'}`, status: 'unknown' },
      { status: 500 },
    );
  }
}
