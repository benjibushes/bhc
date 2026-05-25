// Stage-3 Task 5 — billing dashboard data endpoint.
// Returns tier + subscription status + connect status + recent payouts
// + add-on purchase history for /rancher/billing UI.

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';
import { getRecordById, getAllRecords, TABLES } from '@/lib/airtable';
import { TIERS, tierFor } from '@/lib/tiers';
import { getConnectAccountStatus } from '@/lib/stripeConnect';
import { JWT_SECRET } from '@/lib/secrets';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const PAYMENTS_TABLE = 'Payments';
const PAYOUTS_TABLE = 'Payouts';
const ADDONS_TABLE = 'Add-On Purchases';

export async function GET(_req: Request) {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get('bhc-rancher-auth');
  if (!sessionCookie?.value) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  let decoded: any;
  try { decoded = jwt.verify(sessionCookie.value, JWT_SECRET); }
  catch { return NextResponse.json({ error: 'Session expired' }, { status: 401 }); }
  if (decoded.type !== 'rancher-session') {
    return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
  }

  const rancher: any = await getRecordById(TABLES.RANCHERS, decoded.rancherId);
  if (!rancher) return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });

  const tier = tierFor(rancher);
  const tierConfig = tier ? TIERS[tier] : null;
  const pricingModel = String(rancher['Pricing Model'] || 'legacy');
  const subscriptionStatus = String(rancher['Subscription Status'] || 'none');
  const subscriptionStarted = rancher['Subscription Started At'] || null;
  const subscriptionNext = rancher['Subscription Next Invoice At'] || null;

  // Live Connect status read (never cached, never trust Airtable field)
  let connectStatus: string = 'not_connected';
  const connectAccountId = String(rancher['Stripe Connect Account Id'] || '');
  if (connectAccountId) {
    try {
      const liveStatus = await getConnectAccountStatus(connectAccountId);
      connectStatus = liveStatus.status;
    } catch (e: any) {
      console.warn('[billing/data] Connect status read failed:', e?.message);
      // Fall back to cached field if live read fails
      connectStatus = String(rancher['Stripe Connect Status'] || 'not_connected');
    }
  }

  // Recent payouts (last 30)
  const safeRancherId = decoded.rancherId.replace(/"/g, '\\"');
  let payouts: any[] = [];
  try {
    const allPayouts: any[] = await getAllRecords(
      PAYOUTS_TABLE,
      `SEARCH("${safeRancherId}", ARRAYJOIN({Rancher}))`,
    );
    payouts = allPayouts
      .sort((a: any, b: any) => new Date(b['Released At'] || 0).getTime() - new Date(a['Released At'] || 0).getTime())
      .slice(0, 30)
      .map((p: any) => ({
        id: p.id,
        amountCents: Number(p['Amount Cents']) || 0,
        status: String(p['Status'] || 'pending'),
        reason: String(p['Reason'] || ''),
        releasedAt: p['Released At'] || null,
        stripeTransferId: String(p['Stripe Transfer Id'] || ''),
      }));
  } catch (e: any) {
    console.warn('[billing/data] payouts fetch failed:', e?.message);
  }

  // Add-on purchase history
  let addOns: any[] = [];
  try {
    const allAddOns: any[] = await getAllRecords(
      ADDONS_TABLE,
      `SEARCH("${safeRancherId}", ARRAYJOIN({Rancher}))`,
    );
    addOns = allAddOns
      .sort((a: any, b: any) => new Date(b['Purchased At'] || 0).getTime() - new Date(a['Purchased At'] || 0).getTime())
      .map((a: any) => ({
        id: a.id,
        type: String(a['Type'] || ''),
        amountCents: Number(a['Amount Cents']) || 0,
        status: String(a['Status'] || 'pending'),
        purchasedAt: a['Purchased At'] || null,
        stripeInvoiceId: String(a['Stripe Invoice Id'] || ''),
      }));
  } catch (e: any) {
    console.warn('[billing/data] add-ons fetch failed:', e?.message);
  }

  return NextResponse.json({
    pricingModel,
    tier: tier || null,
    tierLabel: tierConfig?.label || null,
    monthlyCents: tierConfig?.monthlyCents || null,
    commissionRate: tierConfig?.commissionRate ?? null,
    subscriptionStatus,
    subscriptionStarted,
    subscriptionNext,
    connectStatus,
    connectAccountId: connectAccountId || null,
    payouts,
    addOns,
  });
}
