// app/api/rancher/connect/status/route.ts
//
// Stage-3 Task 7 — live Stripe Connect status read.
//
// Used by /rancher/billing dashboard on page mount + post-onboarding return.
// ALWAYS reads from Stripe API directly (never cached) per BHC convention.
// Airtable's Stripe Connect Status field is a webhook-refreshed UI hint.

import { NextResponse } from 'next/server';
import { getRecordById, TABLES } from '@/lib/airtable';
import { getConnectAccountStatus } from '@/lib/stripeConnect';
import { requireRancher } from '@/lib/rancherAuth';

export const dynamic = 'force-dynamic';
export const maxDuration = 20;

export async function GET(req: Request) {
  // Auth Phase 2: requireRancher routes through Clerk or legacy JWT.
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
