// app/api/rancher/connect/start/route.ts
//
// Stage-3 Task 7 — initiate Stripe Connect Express onboarding.
//
// Flow:
//   1. Auth check (rancher-session JWT)
//   2. If no Stripe Connect Account Id on rancher: create V2 account, persist
//      IMMEDIATELY (so refresh-mid-flow doesn't duplicate)
//   3. Create V2 account link → Stripe-hosted onboarding URL
//   4. Return { url } → frontend redirects
//
// Refresh URL points back to this same endpoint so abandoned mid-flow can resume.
//
// CRITICAL: STRIPE_CONNECT_ENABLED env gate — refuses unless 'true'. Allows
// prod to ship this code with the flag off until canary (Task 16).

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { createConnectAccount, createOnboardingLink } from '@/lib/stripeConnect';
import { JWT_SECRET } from '@/lib/secrets';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

export async function POST(_req: Request) {
  if (process.env.STRIPE_CONNECT_ENABLED !== 'true') {
    return NextResponse.json({ error: 'Stripe Connect not enabled in this env' }, { status: 503 });
  }

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

  let accountId: string = String(rancher['Stripe Connect Account Id'] || '');

  // First-time onboarding: create the V2 Connect account, persist immediately
  if (!accountId) {
    const email = String(rancher['Email'] || '').trim();
    if (!email) {
      return NextResponse.json({ error: 'Rancher email required for Stripe Connect' }, { status: 400 });
    }
    const displayName =
      String(rancher['Operator Name'] || rancher['Ranch Name'] || 'BHC Rancher').trim();

    try {
      const result = await createConnectAccount({
        email,
        displayName,
        rancherId: decoded.rancherId,
      });
      accountId = result.accountId;
    } catch (e: any) {
      console.error('[connect/start] V2 account create failed:', e?.message);
      return NextResponse.json({ error: `Stripe account create failed: ${e?.message || 'unknown'}` }, { status: 500 });
    }

    // Persist BEFORE link creation so a refresh mid-flow doesn't create duplicates
    try {
      await updateRecord(TABLES.RANCHERS, decoded.rancherId, {
        'Stripe Connect Account Id': accountId,
        'Stripe Connect Status': 'onboarding',
      });
    } catch (e: any) {
      console.error('[connect/start] Airtable persist failed:', e?.message);
      // Continue — Stripe account exists; webhook will resync status
    }
  }

  // Generate onboarding link
  try {
    const { url } = await createOnboardingLink({
      accountId,
      returnUrl: `${SITE_URL}/rancher/billing?onboarding=done`,
      refreshUrl: `${SITE_URL}/api/rancher/connect/start`,
    });
    return NextResponse.json({ url, accountId });
  } catch (e: any) {
    console.error('[connect/start] onboarding link failed:', e?.message);
    return NextResponse.json({ error: `Onboarding link failed: ${e?.message || 'unknown'}` }, { status: 500 });
  }
}
