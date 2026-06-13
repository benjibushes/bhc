import { NextResponse, NextRequest } from 'next/server';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { createConnectAccount, createOnboardingLink } from '@/lib/stripeConnect';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { logAuditEntry } from '@/lib/auditLog';
import { requireAdmin } from '@/lib/adminAuth';

// POST /api/admin/ranchers/[id]/mark-legacy-connect
//
// Operator-only endpoint that flips a rancher onto the HYBRID path:
//   - Pricing Model = 'tier_v2'  (so buyer deposit checkout routes through Connect)
//   - Tier          = 'Legacy Connect'  (so application_fee_amount uses 10%)
//   - Stripe Connect Account created (if not already) + onboarding URL returned
//
// Why this exists: some ranchers don't want a monthly subscription
// (Pasture $150 / Ranch $350 / Operator $500) but DO want platform-handled
// deposits. The hybrid keeps them on the legacy 10% commission rate while
// upgrading the deposit collection mechanism from "off-platform Payment
// Link + post-close invoice" to "Stripe Connect direct charge at deposit
// time w/ 10% application_fee_amount".
//
// First-ever write of Tier='Legacy Connect' uses typecast=true via
// lib/airtable's updateRecord, so Airtable auto-creates the singleSelect
// choice (the Meta API does not permit choices PATCH on existing fields).
//
// Idempotent: re-runs just mint a fresh onboarding link without duplicate
// Connect account creation (createConnectAccount has its own
// per-rancherId idempotencyKey too).
//
// Auth: admin cookie OR x-internal-secret header (matches send-v2-upgrade
// pattern). No rancher-side flow — admin operates this during the call.

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
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

    const email: string = (rancher['Email'] || '').toString().trim();
    if (!email) {
      return NextResponse.json(
        { error: 'Rancher has no email on file (required for Stripe Connect)' },
        { status: 400 },
      );
    }
    const operatorName: string =
      (rancher['Operator Name'] || rancher['Ranch Name'] || 'BHC Rancher').toString().trim();
    const ranchName: string = (rancher['Ranch Name'] || operatorName).toString();

    // ── Ensure Stripe Connect account exists ──
    let accountId: string = String(rancher['Stripe Connect Account Id'] || '').trim();
    let accountCreated = false;
    if (!accountId) {
      try {
        const result = await createConnectAccount({
          email,
          displayName: operatorName,
          rancherId: id,
        });
        accountId = result.accountId;
        accountCreated = true;
      } catch (e: any) {
        console.error('[mark-legacy-connect] V2 account create failed:', e?.message);
        return NextResponse.json(
          { error: `Stripe account create failed: ${e?.message || 'unknown'}` },
          { status: 500 },
        );
      }
    }

    // ── Persist the hybrid flags + Connect account ──
    // typecast: true (via lib/airtable.updateRecord) auto-creates the
    // 'Legacy Connect' singleSelect choice on first write.
    const fieldsToPatch: Record<string, any> = {
      'Tier': 'Legacy Connect',
      'Pricing Model': 'tier_v2',
      'Stripe Connect Account Id': accountId,
    };
    // Only stamp onboarding if not already active (don't clobber an existing
    // active rancher's status if this endpoint is re-fired mid-flow).
    const currentConnectStatus = String(rancher['Stripe Connect Status'] || '');
    if (currentConnectStatus !== 'active') {
      fieldsToPatch['Stripe Connect Status'] = 'onboarding';
    }

    try {
      await updateRecord(TABLES.RANCHERS, id, fieldsToPatch);
    } catch (e: any) {
      console.error('[mark-legacy-connect] Airtable persist failed:', e?.message);
      return NextResponse.json(
        { error: `Persist failed: ${e?.message || 'unknown'}` },
        { status: 500 },
      );
    }

    // ── Mint fresh Stripe Connect Express onboarding link ──
    let onboardingUrl: string;
    try {
      // Public, session-free confirmation page. Cold-link visitors finishing
      // Stripe Express have no rancher session, so /rancher/billing rendered
      // "Not authenticated" here (fix 2026-06-13). /rancher/connected is public.
      const returnUrl = `${SITE_URL}/rancher/connected?onboarding=done`;
      const refreshUrl = `${SITE_URL}/api/rancher/connect/start`;
      const { url } = await createOnboardingLink({
        accountId,
        returnUrl,
        refreshUrl,
      });
      onboardingUrl = url;
    } catch (e: any) {
      console.error('[mark-legacy-connect] onboarding link failed:', e?.message);
      return NextResponse.json(
        { error: `Onboarding link failed: ${e?.message || 'unknown'}` },
        { status: 500 },
      );
    }

    // ── Audit + Telegram (best-effort; don't roll back the flip on failure) ──
    const now = new Date().toISOString();
    try {
      await logAuditEntry({
        actor: 'manual',
        tool: 'mark-legacy-connect',
        targetType: 'Rancher',
        targetId: id,
        args: {
          previousModel: String(rancher['Pricing Model'] || 'legacy'),
          newModel: 'tier_v2',
          newTier: 'Legacy Connect',
          accountCreated,
          connectAccountId: accountId,
        },
        result: { ok: true, at: now, onboardingMinted: true },
        reverseAction: {
          type: 'airtable-update',
          table: 'Ranchers',
          recordId: id,
          fields: {
            'Tier': String(rancher['Tier']?.name || rancher['Tier'] || 'None'),
            'Pricing Model': String(rancher['Pricing Model'] || 'legacy'),
          },
        },
      });
    } catch (e: any) {
      console.warn('[mark-legacy-connect] audit log failed:', e?.message);
    }

    try {
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `🪢 <b>Hybrid (Legacy Connect) flagged</b>\n\n🤠 ${ranchName}\n📧 ${email}\nState: ${rancher['State'] || '?'}\nAccount: ${accountId} ${accountCreated ? '(NEW)' : '(existing)'}\nCommission: 10% via application_fee_amount at deposit\nSubscription: none\n\n<b>Onboarding URL (send to rancher):</b>\n${onboardingUrl}`,
      );
    } catch {}

    return NextResponse.json({
      ok: true,
      rancherId: id,
      ranchName,
      tier: 'Legacy Connect',
      pricingModel: 'tier_v2',
      commissionRate: 0.10,
      connectAccountId: accountId,
      accountCreated,
      onboardingUrl,
      message: `${ranchName} flagged as Legacy Connect. Send the onboardingUrl to rancher to complete Stripe Connect Express. They'll be deposit-ready the moment Stripe Connect Status flips to 'active' via webhook.`,
    });
  } catch (error: any) {
    console.error('mark-legacy-connect error:', error);
    return NextResponse.json(
      { error: error?.message || 'Could not mark rancher as Legacy Connect' },
      { status: 500 },
    );
  }
}
