// Stage-3 Task 5 — billing dashboard data endpoint.
// Returns tier + subscription status + connect status + recent payouts
// + add-on purchase history for /rancher/billing UI.

import { NextResponse } from 'next/server';
import { getRecordById, getAllRecords, TABLES } from '@/lib/airtable';
import { TIERS, tierFor } from '@/lib/tiers';
import { getConnectAccountStatus } from '@/lib/stripeConnect';
import { getStripe } from '@/lib/stripe';
import { requireRancher } from '@/lib/rancherAuth';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const PAYMENTS_TABLE = 'Payments';
const PAYOUTS_TABLE = 'Payouts';
const ADDONS_TABLE = 'Add-On Purchases';

export async function GET(req: Request) {
  const r = await requireRancher(req);
  if (r instanceof NextResponse) return r;
  const { session } = r;

  const rancher: any = await getRecordById(TABLES.RANCHERS, session.rancherId);
  if (!rancher) return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });

  const tier = tierFor(rancher);
  const tierConfig = tier ? TIERS[tier] : null;
  const pricingModel = String(rancher['Pricing Model'] || 'legacy');
  const subscriptionStatus = String(rancher['Subscription Status'] || 'none');
  const subscriptionStarted = rancher['Subscription Started At'] || null;
  const subscriptionNext = rancher['Subscription Next Invoice At'] || null;

  // Live Connect status read (never cached, never trust Airtable field)
  let connectStatus: string = 'not_connected';
  // How many KYC items Stripe is still blocking on + whether a fresh onboarding
  // link can resume the rancher. Surfaced so the billing page can tell a stuck
  // rancher EXACTLY what's left and route the resume action correctly (the
  // Connect onboarding link clears requirements; the subscription portal can't).
  let connectCurrentlyDueCount = 0;
  let connectCanResumeOnboarding = false;
  const connectAccountId = String(rancher['Stripe Connect Account Id'] || '');
  if (connectAccountId) {
    try {
      const liveStatus = await getConnectAccountStatus(connectAccountId);
      connectStatus = liveStatus.status;
      connectCurrentlyDueCount = liveStatus.currentlyDueCount;
      connectCanResumeOnboarding = liveStatus.canResumeOnboarding;
    } catch (e: any) {
      console.warn('[billing/data] Connect status read failed:', e?.message);
      // Fall back to cached field if live read fails
      connectStatus = String(rancher['Stripe Connect Status'] || 'not_connected');
      // Conservative resume hint on fallback: any non-active cached status can
      // safely be resumed via the onboarding link (start re-mints / no-ops).
      connectCanResumeOnboarding = connectStatus !== 'active' && connectStatus !== 'not_connected';
    }
  }

  // LIVE Stripe payouts (Area E4a) — the truth for "did I get paid?".
  // The legacy `payouts` array below reads the escrow Payouts table, which is
  // permanently empty under the direct-charge model (releasePayout() in
  // lib/contracts/payments.ts has zero callers — direct charges never create
  // platform transfers), so the billing UI renders THIS list instead. The
  // legacy key stays in the response for shape compatibility only.
  // Read-only Stripe call, best-effort like every other block in this route:
  //   null = Stripe read failed (UI shows an error line, never "no payouts yet")
  //   []   = genuinely no payouts on the connected account yet
  let stripePayouts: Array<{
    id: string;
    amountCents: number;
    status: string;
    createdISO: string | null;
    arrivalDateISO: string | null;
    destinationLast4: string | null;
  }> | null = [];
  if (connectAccountId && process.env.STRIPE_CONNECT_ENABLED === 'true') {
    try {
      const stripe = getStripe();
      const live = await stripe.payouts.list(
        { limit: 10, expand: ['data.destination'] },
        { stripeAccount: connectAccountId },
      );
      stripePayouts = (live.data || []).map((p) => {
        // Expanded destination is a BankAccount/Card object carrying last4;
        // unexpanded (or deleted) destinations degrade to null gracefully.
        const dest: any = p.destination;
        return {
          id: p.id,
          amountCents: p.amount || 0,
          status: String(p.status || ''),
          createdISO: p.created ? new Date(p.created * 1000).toISOString() : null,
          arrivalDateISO: p.arrival_date ? new Date(p.arrival_date * 1000).toISOString() : null,
          destinationLast4:
            dest && typeof dest === 'object' && dest.last4 ? String(dest.last4) : null,
        };
      });
    } catch (e: any) {
      console.warn('[billing/data] live Stripe payouts read failed:', e?.message);
      stripePayouts = null;
    }
  }

  // Recent payouts (last 30)
  const safeRancherId = session.rancherId.replace(/"/g, '\\"');
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
    connectCurrentlyDueCount,
    connectCanResumeOnboarding,
    payouts,
    stripePayouts,
    addOns,
  });
}
