// app/api/rancher/connect/status/route.ts
//
// Stage-3 Task 7 — live Stripe Connect status read.
//
// Used by /rancher/billing dashboard on page mount + post-onboarding return.
// ALWAYS reads from Stripe API directly (never cached) per BHC convention.
// Airtable's Stripe Connect Status field is a webhook-refreshed UI hint.

import { NextResponse } from 'next/server';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { getConnectAccountStatus } from '@/lib/stripeConnect';
import { computeConnectResync } from '@/lib/connectResync';
import { requireRancher } from '@/lib/rancherAuth';

export const dynamic = 'force-dynamic';
export const maxDuration = 20;

export async function GET(req: Request) {
  const r = await requireRancher(req);
  if (r instanceof NextResponse) return r;
  const { session } = r;

  const rancher: any = await getRecordById(TABLES.RANCHERS, session.rancherId);
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

// POST /api/rancher/connect/status
//
// Rancher-side "re-check status" — the self-serve sibling of the admin
// resync-connect endpoint. The dashboard banner cascade reads the CACHED
// Airtable `Stripe Connect Status`, which only the account.updated webhook
// writes 'active'. When that event fires early (pre-merge dup race) or never
// reaches us, a rancher who has actually finished Stripe KYC stays stuck on the
// "connect your bank" banner forever — a dead-end that blocks every deposit.
//
// This does the authoritative LIVE Stripe read and persists the true status to
// the rancher's OWN record (scoped via requireRancher — a rancher can only
// resync themselves). Read-derived, no money mutation: it writes only what the
// webhook would have written (status field + Connected At + migration tracker),
// computed by the shared pure helper so it stays in lockstep with the admin
// path. Idempotent: skips the write when live already matches the cache.
export async function POST(req: Request) {
  if (process.env.STRIPE_CONNECT_ENABLED !== 'true') {
    return NextResponse.json(
      { error: 'Stripe Connect not enabled in this env' },
      { status: 503 },
    );
  }

  const r = await requireRancher(req);
  if (r instanceof NextResponse) return r;
  const { session } = r;

  const rancher: any = await getRecordById(TABLES.RANCHERS, session.rancherId);
  if (!rancher) return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });

  const accountId = String(rancher['Stripe Connect Account Id'] || '').trim();
  if (!accountId) {
    // No Connect account yet — nothing to resync. Surface as not_connected so
    // the UI can keep showing the "start onboarding" affordance.
    return NextResponse.json({ ok: true, changed: false, status: 'not_connected' as const });
  }

  let live: Awaited<ReturnType<typeof getConnectAccountStatus>>;
  try {
    live = await getConnectAccountStatus(accountId);
  } catch (e: any) {
    console.error('[connect/status POST] Stripe retrieve failed:', e?.message);
    return NextResponse.json(
      { error: `Stripe read failed: ${e?.message || 'unknown'}`, status: 'unknown' },
      { status: 502 },
    );
  }

  const previousStatus = String(rancher['Stripe Connect Status'] || '');
  const decision = computeConnectResync({
    liveStatus: live.status,
    previousStatus,
    alreadyConnectedAt: !!rancher['Stripe Connect Connected At'],
    pricingModel: String(rancher['Pricing Model'] || ''),
    migrationStatus: String(rancher['Migration Status'] || ''),
    nowISO: new Date().toISOString(),
  });

  if (decision.changed) {
    try {
      await updateRecord(TABLES.RANCHERS, session.rancherId, decision.writeFields);
    } catch (e: any) {
      console.error('[connect/status POST] Airtable persist failed:', e?.message);
      return NextResponse.json(
        { error: `Persist failed: ${e?.message || 'unknown'}` },
        { status: 500 },
      );
    }
  }

  return NextResponse.json({
    ok: true,
    changed: decision.changed,
    status: live.status,
    depositReady: decision.isNowActive,
    cardPaymentsActive: live.cardPaymentsActive,
    onboardingComplete: live.onboardingComplete,
    requirementsStatus: live.requirementsStatus,
    message: decision.isNowActive
      ? "You're all set — your bank is connected and deposits will land in your account."
      : live.status === 'restricted'
        ? 'Stripe still needs more info. Open the portal to clear the flag.'
        : "Stripe hasn't finished verifying you yet. Resume onboarding to finish the remaining steps.",
  });
}
