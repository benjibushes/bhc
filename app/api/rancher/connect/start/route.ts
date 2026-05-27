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
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { createConnectAccount, createOnboardingLink } from '@/lib/stripeConnect';
import { requireRancher } from '@/lib/rancherAuth';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

export async function POST(req: Request) {
  if (process.env.STRIPE_CONNECT_ENABLED !== 'true') {
    return NextResponse.json({ error: 'Stripe Connect not enabled in this env' }, { status: 503 });
  }

  // Auth Phase 2: requireRancher routes through Clerk or legacy JWT.
  const r = await requireRancher(req);
  if (r instanceof NextResponse) return r;
  const { session } = r;

  // Origin-aware return URL: wizard caller resumes at setup Step 8 (Fulfillment).
  // Default (billing dashboard caller) returns to /rancher/billing.
  // Without this, ranchers completing Stripe inside the wizard get stranded on
  // /rancher/billing and skip Step 8 (Fulfillment) + Step 9 (Sign agreement).
  let fromWizard = false;
  let wizardToken = '';
  try {
    const body = await req.json().catch(() => ({} as any));
    fromWizard = body?.from === 'wizard';
    wizardToken = typeof body?.wizardToken === 'string' ? body.wizardToken : '';
  } catch {
    /* body optional */
  }

  const rancher: any = await getRecordById(TABLES.RANCHERS, session.rancherId);
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
        rancherId: session.rancherId,
      });
      accountId = result.accountId;
    } catch (e: any) {
      console.error('[connect/start] V2 account create failed:', e?.message);
      return NextResponse.json({ error: `Stripe account create failed: ${e?.message || 'unknown'}` }, { status: 500 });
    }

    // Persist BEFORE link creation so a refresh mid-flow doesn't create duplicates
    try {
      await updateRecord(TABLES.RANCHERS, session.rancherId, {
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
    const returnUrl =
      fromWizard && wizardToken
        ? `${SITE_URL}/rancher/setup?token=${encodeURIComponent(wizardToken)}&connectComplete=1`
        : `${SITE_URL}/rancher/billing?onboarding=done`;
    const { url } = await createOnboardingLink({
      accountId,
      returnUrl,
      refreshUrl: `${SITE_URL}/api/rancher/connect/start`,
    });
    return NextResponse.json({ url, accountId });
  } catch (e: any) {
    console.error('[connect/start] onboarding link failed:', e?.message);
    return NextResponse.json({ error: `Onboarding link failed: ${e?.message || 'unknown'}` }, { status: 500 });
  }
}
