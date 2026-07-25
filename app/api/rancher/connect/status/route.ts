// app/api/rancher/connect/status/route.ts
//
// Stage-3 Task 7 — live Stripe Connect status read.
//
// Used by /rancher/billing dashboard on page mount + post-onboarding return.
// ALWAYS reads from Stripe API directly (never cached) per BHC convention.
// Airtable's Stripe Connect Status field is a webhook-refreshed UI hint.

import { NextResponse } from 'next/server';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { getConnectAccountStatus, createOnboardingLink, connectHandoff } from '@/lib/stripeConnect';
import { computeConnectResync } from '@/lib/connectResync';
import { requireRancher } from '@/lib/rancherAuth';
import { sendOperatorSignal } from '@/lib/operatorSignal';

export const dynamic = 'force-dynamic';
export const maxDuration = 20;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

export async function GET(req: Request) {
  const r = await requireRancher(req);
  if (r instanceof NextResponse) return r;
  const { session } = r;

  const rancher: any = await getRecordById(TABLES.RANCHERS, session.rancherId);
  if (!rancher) return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });

  const accountId = String(rancher['Stripe Connect Account Id'] || '');
  if (!accountId) {
    // Structured truth for a rancher who has never begun. Shape matches the
    // connected case so the UI has exactly one contract to render.
    const handoff = connectHandoff({ hasAccount: false });
    return NextResponse.json({
      status: 'not_connected' as const,
      state: handoff.state,
      canResume: false,
      currentlyDueCount: 0,
      currentlyDue: [],
      nextAction: handoff.nextAction,
      resumeUrl: null,
    });
  }

  try {
    const result = await getConnectAccountStatus(accountId);
    const handoff = connectHandoff({
      hasAccount: true,
      status: result.status,
      currentlyDue: result.currentlyDue,
      canResumeOnboarding: result.canResumeOnboarding,
    });

    // A ready-to-use resume link, minted FRESH on this request — Stripe's
    // account links expire (~24h), so a cached one is a dead end. Only minted
    // when a fresh onboarding link is actually the right fix: an active
    // account has nothing to resume, and a Stripe-side hold can't be cleared
    // by another onboarding loop (those need the dashboard/support).
    // Best-effort: a link-mint failure must not turn an otherwise-good status
    // read into a 500 — the UI degrades to "no one-click resume", not blank.
    let resumeUrl: string | null = null;
    if (handoff.canResume) {
      try {
        const link = await createOnboardingLink({
          accountId,
          returnUrl: `${SITE_URL}/rancher/billing?onboarding=done`,
          refreshUrl: `${SITE_URL}/api/rancher/connect/start`,
        });
        resumeUrl = link.url;
      } catch (e: any) {
        console.warn('[connect/status] resume link mint failed (continuing):', e?.message);
      }
    }

    // Spread the raw read first so existing consumers (cardPaymentsActive,
    // onboardingComplete, requirementsStatus, status, currentlyDueCount,
    // canResumeOnboarding) keep working byte-identically, then add the
    // structured handoff on top.
    return NextResponse.json({
      ...result,
      state: handoff.state,
      canResume: handoff.canResume,
      nextAction: handoff.nextAction,
      resumeUrl,
    });
  } catch (e: any) {
    console.error('[connect/status] Stripe retrieve failed:', e?.message);
    return NextResponse.json(
      {
        error: `Stripe read failed: ${e?.message || 'unknown'}`,
        status: 'unknown',
        state: 'incomplete' as const,
        // Actionable, not a silent failure: the rancher can still be sent to
        // the start endpoint, which re-mints a link and re-reads status.
        nextAction:
          "We couldn't reach Stripe to check your payout setup just now. Try again in a moment — if it keeps happening, email hello@buyhalfcow.com and we'll finish it with you.",
        resumeUrl: null,
      },
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

  // Airtable single-selects sometimes arrive as {name} objects.
  const activeStatusObj: any = rancher['Active Status'];
  const activeStatus = String(
    typeof activeStatusObj === 'object' && activeStatusObj?.name
      ? activeStatusObj.name
      : activeStatusObj || ''
  );
  const isPaused = activeStatus === 'Paused';

  // paused_overdue dead-end (audit 2026-07-21): the migration-deadline cron
  // pauses overdue ranchers, and NOTHING auto-unpauses them when they finish
  // the upgrade — the webhook auto-go-live excludes previously-Live ranchers
  // and go-live-sync excludes Paused. Without this signal the rancher
  // completes everything and silently receives zero buyers. Loud ping so ops
  // unpauses; 24h dedupe so dashboard polling can't storm the channel.
  if (decision.wasPausedOverdue && isPaused) {
    await sendOperatorSignal({
      urgency: 'loud',
      kind: 'stuck-rancher',
      summary: `UPGRADE COMPLETE — UNPAUSE ${rancher['Ranch Name'] || rancher['Operator Name'] || session.rancherId}`,
      detail:
        `Rancher was auto-paused by the migration deadline (Migration Status was paused_overdue) and has now finished Stripe Connect (active).\n` +
        `Active Status is still 'Paused' — flip it to 'Active' from /admin/ranchers/${session.rancherId} so buyers route again.`,
      refs: [{ type: 'rancher', id: session.rancherId, label: String(rancher['Ranch Name'] || rancher['Operator Name'] || '') }],
      dedupeKey: `paused-overdue-upgrade:${session.rancherId}`,
      dedupeWindowMs: 24 * 3600 * 1000,
    });
  }

  return NextResponse.json({
    ok: true,
    changed: decision.changed,
    status: live.status,
    depositReady: decision.isNowActive,
    cardPaymentsActive: live.cardPaymentsActive,
    onboardingComplete: live.onboardingComplete,
    requirementsStatus: live.requirementsStatus,
    // Never claim "deposits will land" to a Paused rancher — buyer routing is
    // gated off until ops reactivates them (isRancherOperationalForBuyers
    // requires Active Status='Active').
    message: decision.isNowActive
      ? isPaused
        ? "Your bank is connected. Your account is currently paused — we've pinged the team to reactivate it, no action needed on your side."
        : "You're all set — your bank is connected and deposits will land in your account."
      : live.status === 'restricted'
        ? 'Stripe still needs more info. Open the portal to clear the flag.'
        : "Stripe hasn't finished verifying you yet. Resume onboarding to finish the remaining steps.",
  });
}
