// Stage-3 Task 11.5 — legacy → tier_v2 atomic opt-in upgrade.
//
// Grandfathered legacy ranchers (Pricing Model='legacy') run the
// post-close 10% commission-invoice flow. To opt-in to tier_v2 (monthly
// subscription + Connect direct-charge deposits) they must FIRST:
//   1. Pick + pay a tier subscription via /partner/checkout/[tier]
//      (writes Tier + Subscription Status + Stripe Subscription Id)
//   2. Complete Stripe Connect Express onboarding
//      (writes Stripe Connect Status='active')
//
// Only THEN does this endpoint atomically flip Pricing Model. The flip is
// one-way for v1 — there is no revert path. (If a rancher needs to go back,
// admin handles it manually + we re-issue legacy commission invoices.)
//
// The endpoint reads live Stripe Connect status (NOT the cached Airtable
// field) so a stale cache can't unblock the upgrade.

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { getConnectAccountStatus } from '@/lib/stripeConnect';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { logAuditEntry } from '@/lib/auditLog';
import { JWT_SECRET } from '@/lib/secrets';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const PAYING_SUBSCRIPTION_STATES = new Set(['active', 'trialing']);

export async function POST(_req: Request) {
  // ── Auth: rancher-session cookie ──
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get('bhc-rancher-auth');
  if (!sessionCookie?.value) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  let decoded: any;
  try {
    decoded = jwt.verify(sessionCookie.value, JWT_SECRET);
  } catch {
    return NextResponse.json({ error: 'Session expired' }, { status: 401 });
  }
  if (decoded.type !== 'rancher-session') {
    return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
  }

  const rancherId: string = decoded.rancherId;
  const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);
  if (!rancher) {
    return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });
  }

  // ── Already tier_v2? Idempotent no-op (safer than 4xx — UI may double-fire). ──
  const currentModel = String(rancher['Pricing Model'] || 'legacy');
  if (currentModel === 'tier_v2') {
    return NextResponse.json({ ok: true, alreadyUpgraded: true });
  }

  // ── Prerequisite 1: tier subscription must be active or trialing. ──
  const subscriptionStatus = String(rancher['Subscription Status'] || '');
  if (!PAYING_SUBSCRIPTION_STATES.has(subscriptionStatus)) {
    return NextResponse.json(
      {
        error: 'subscription_required',
        message: 'Pick + pay a tier subscription first.',
        nextStep: '/partner',
      },
      { status: 412 },
    );
  }

  // ── Prerequisite 2: Connect account verified — live read from Stripe, not the cached Airtable field. ──
  const connectAccountId = String(rancher['Stripe Connect Account Id'] || '');
  if (!connectAccountId) {
    return NextResponse.json(
      {
        error: 'connect_required',
        message: 'Connect your Stripe account first.',
        nextStep: '/rancher/billing',
      },
      { status: 412 },
    );
  }
  let connectLive;
  try {
    connectLive = await getConnectAccountStatus(connectAccountId);
  } catch (e: any) {
    console.error('[legacy-upgrade] Stripe Connect retrieve failed:', e?.message);
    return NextResponse.json(
      { error: 'connect_check_failed', message: 'Could not verify Connect status. Try again in a minute.' },
      { status: 502 },
    );
  }
  if (connectLive.status !== 'active') {
    return NextResponse.json(
      {
        error: 'connect_not_active',
        message: `Connect account status is "${connectLive.status}". Finish Stripe Express onboarding first.`,
        connectStatus: connectLive.status,
        nextStep: '/rancher/billing',
      },
      { status: 412 },
    );
  }

  // ── Atomic flip + audit log + Telegram. ──
  const now = new Date().toISOString();
  await updateRecord(TABLES.RANCHERS, rancherId, {
    'Pricing Model': 'tier_v2',
  });

  // Best-effort audit + alerts. Don't roll back the flip on side-effect failure.
  try {
    await logAuditEntry({
      actor: 'manual',
      tool: 'legacy-upgrade',
      targetType: 'Rancher',
      targetId: rancherId,
      args: { previousModel: 'legacy', newModel: 'tier_v2', triggeredBy: rancherId },
      result: { ok: true, at: now },
      reverseAction: {
        type: 'airtable-update',
        table: 'Ranchers',
        recordId: rancherId,
        fields: { 'Pricing Model': 'legacy' },
      },
    });
  } catch (e: any) {
    console.warn('[legacy-upgrade] audit log write failed:', e?.message);
  }

  try {
    const ranchName = rancher['Ranch Name'] || rancher['Operator Name'] || rancherId;
    const tier = rancher['Tier'] || 'unknown tier';
    const tierLabel = typeof tier === 'object' && tier?.name ? tier.name : String(tier);
    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      `🆙 LEGACY → tier_v2 — ${ranchName} (${tierLabel}). Connect active + sub ${subscriptionStatus}.`,
    );
  } catch (e: any) {
    console.warn('[legacy-upgrade] telegram alert failed:', e?.message);
  }

  return NextResponse.json({ ok: true, pricingModel: 'tier_v2', upgradedAt: now });
}
