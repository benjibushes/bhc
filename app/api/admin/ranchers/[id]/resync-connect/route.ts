import { NextResponse, NextRequest } from 'next/server';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { getConnectAccountStatus } from '@/lib/stripeConnect';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { logAuditEntry } from '@/lib/auditLog';
import { requireAdmin } from '@/lib/adminAuth';

// POST /api/admin/ranchers/[id]/resync-connect
//
// Operator-only endpoint that force-refreshes a rancher's Stripe Connect
// status from a LIVE Stripe read — the same read syncRancherConnectStatus()
// performs on the account.updated webhook (app/api/webhooks/stripe-connect).
//
// Why this exists: the only writer of `Stripe Connect Status = 'active'` is
// the account.updated webhook. If that event fired BEFORE a Connect account
// was merged onto its canonical Ranchers row (the 2026-06-10 Renick Valley
// dup-merge race), or simply never reached us, the canonical row stays stuck
// at 'onboarding' even though Stripe has charges_enabled. The buyer deposit
// checkout (/api/checkout/deposit) HARD-requires status === 'active', so a
// stale 'onboarding' silently blocks every deposit.
//
// This endpoint does the authoritative live read + persists the true status,
// breaking the dependency on Stripe spontaneously re-firing the event. It is
// the diagnostic ("what is Jesse's real Stripe state?") AND the fix, and the
// reusable tool for the 14-rancher tier_v2 migration wave.
//
// Idempotent: skips the write when the live status already matches Airtable.
// Read-derived: writes ONLY what the webhook would have written. No money
// mutation — it flips a status field + (when active) advances the migration
// tracker, mirroring stripe-connect/syncRancherConnectStatus.
//
// Auth: admin cookie OR x-internal-secret header (matches mark-legacy-connect
// + send-v2-upgrade). No rancher-side flow — admin operates this during/after
// the upgrade call.

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || '';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    if (process.env.STRIPE_CONNECT_ENABLED !== 'true') {
      return NextResponse.json(
        { error: 'Stripe Connect not enabled in this env' },
        { status: 503 },
      );
    }

    const internalHeader = request.headers.get('x-internal-secret') || '';
    const isInternal = INTERNAL_API_SECRET && internalHeader === INTERNAL_API_SECRET;
    if (!isInternal) {
      const unauthorized = await requireAdmin(request);
      if (unauthorized) return unauthorized;
    }

    const { id } = await context.params;
    if (!id || !id.startsWith('rec')) {
      return NextResponse.json({ error: 'Invalid rancher id' }, { status: 400 });
    }

    let rancher: any;
    try {
      rancher = await getRecordById(TABLES.RANCHERS, id);
    } catch {
      return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });
    }
    if (!rancher) return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });

    const accountId = String(rancher['Stripe Connect Account Id'] || '').trim();
    if (!accountId) {
      return NextResponse.json(
        { error: 'Rancher has no Stripe Connect Account Id — nothing to resync' },
        { status: 400 },
      );
    }

    // ── LIVE Stripe read (authoritative; never trust the Airtable hint) ──
    let live: Awaited<ReturnType<typeof getConnectAccountStatus>>;
    try {
      live = await getConnectAccountStatus(accountId);
    } catch (e: any) {
      console.error('[resync-connect] Stripe retrieve failed:', e?.message);
      return NextResponse.json(
        { error: `Stripe read failed: ${e?.message || 'unknown'}`, status: 'unknown' },
        { status: 502 },
      );
    }

    const previousStatus = String(rancher['Stripe Connect Status'] || '');
    const isNowActive = live.status === 'active';
    const alreadyCelebrated = !!rancher['Stripe Connect Connected At'];

    // No-op when the live status already matches what's stored.
    if (previousStatus === live.status) {
      return NextResponse.json({
        ok: true,
        changed: false,
        rancherId: id,
        connectAccountId: accountId,
        status: live.status,
        cardPaymentsActive: live.cardPaymentsActive,
        onboardingComplete: live.onboardingComplete,
        requirementsStatus: live.requirementsStatus,
        depositReady: isNowActive,
        message: isNowActive
          ? 'Already active — deposits flow. No change.'
          : `Live Stripe status is '${live.status}' (matches Airtable). Rancher must finish Stripe Connect onboarding before deposits unlock.`,
      });
    }

    // ── Persist true status. Mirror the webhook's active-flip side effects. ──
    const writeFields: Record<string, any> = { 'Stripe Connect Status': live.status };
    if (isNowActive && !alreadyCelebrated) {
      writeFields['Stripe Connect Connected At'] = new Date().toISOString();
    }
    // When Connect goes active, a tier_v2 rancher has cleared the last gate —
    // advance the migration tracker so the cron stops nudging + /admin/migration
    // counts them done. (Subscription-paying gate not required here: Legacy
    // Connect ranchers carry no subscription but are fully deposit-ready once
    // Connect is active.)
    const pricingModel = String(rancher['Pricing Model'] || '').toLowerCase();
    const migStatus = String(rancher['Migration Status'] || '').toLowerCase();
    const incompleteMig = new Set(['', 'not_invited', 'invited', 'call_scheduled', 'upgrading']);
    if (isNowActive && pricingModel === 'tier_v2' && incompleteMig.has(migStatus)) {
      writeFields['Migration Status'] = 'completed';
    }

    try {
      await updateRecord(TABLES.RANCHERS, id, writeFields);
    } catch (e: any) {
      console.error('[resync-connect] Airtable persist failed:', e?.message);
      return NextResponse.json(
        { error: `Persist failed: ${e?.message || 'unknown'}` },
        { status: 500 },
      );
    }

    const ranchName = String(rancher['Ranch Name'] || rancher['Operator Name'] || accountId);
    const now = new Date().toISOString();

    // ── Audit + Telegram (best-effort; never roll back the status write) ──
    try {
      await logAuditEntry({
        actor: 'manual',
        tool: 'resync-connect',
        targetType: 'Rancher',
        targetId: id,
        args: { connectAccountId: accountId, previousStatus, liveStatus: live.status },
        result: { ok: true, at: now, ...live },
        reverseAction: {
          type: 'airtable-update',
          table: 'Ranchers',
          recordId: id,
          fields: { 'Stripe Connect Status': previousStatus || 'onboarding' },
        },
      });
    } catch (e: any) {
      console.warn('[resync-connect] audit log failed:', e?.message);
    }

    try {
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        isNowActive
          ? `🏦 <b>CONNECT RESYNC → ACTIVE</b>\n\n🤠 ${ranchName}\nAccount: ${accountId}\nWas: ${previousStatus || '(empty)'} → now: active\n\n<i>Deposits now flow. Buyers can pay this rancher.</i>`
          : `🔄 <b>Connect resync</b>\n\n🤠 ${ranchName}\nAccount: ${accountId}\nWas: ${previousStatus || '(empty)'} → now: ${live.status}\nrequirements: ${live.requirementsStatus || 'n/a'} · card_payments: ${live.cardPaymentsActive ? 'active' : 'inactive'}\n\n<i>Still not deposit-ready — rancher must finish Stripe onboarding.</i>`,
      );
    } catch {}

    return NextResponse.json({
      ok: true,
      changed: true,
      rancherId: id,
      ranchName,
      connectAccountId: accountId,
      previousStatus: previousStatus || null,
      status: live.status,
      cardPaymentsActive: live.cardPaymentsActive,
      onboardingComplete: live.onboardingComplete,
      requirementsStatus: live.requirementsStatus,
      migrationCompleted: writeFields['Migration Status'] === 'completed',
      depositReady: isNowActive,
      message: isNowActive
        ? `${ranchName} is ACTIVE — deposits flow. Buyers can pay this rancher now.`
        : `${ranchName} live status is '${live.status}'. Rancher must finish Stripe Connect onboarding (requirements: ${live.requirementsStatus || 'n/a'}) before deposits unlock.`,
    });
  } catch (error: any) {
    console.error('resync-connect error:', error);
    return NextResponse.json(
      { error: error?.message || 'Could not resync Stripe Connect status' },
      { status: 500 },
    );
  }
}
