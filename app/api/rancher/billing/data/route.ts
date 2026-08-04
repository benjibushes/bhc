// Stage-3 Task 5 — billing dashboard data endpoint.
// Returns tier + subscription status + connect status + recent payouts
// + add-on purchase history for /rancher/billing UI.

import { NextResponse } from 'next/server';
import { getRecordById, getAllRecords, TABLES } from '@/lib/airtable';
import { TIERS, tierFor, commissionRateForTier } from '@/lib/tiers';
import { getRancherCommissionRate, hasLockedCommissionRate } from '@/lib/commission';
import { selectCommissionOwedRows, totalCommissionOwed, type CommissionOwedRow } from '@/lib/commissionOwed';
import { fetchReferralRowsForRancher } from '@/lib/referralReads';
import { getConnectAccountStatus } from '@/lib/stripeConnect';
import { getStripe } from '@/lib/stripe';
import { requireRancher } from '@/lib/rancherAuth';
import { isDemoMode } from '@/lib/demo/demoMode';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const PAYMENTS_TABLE = 'Payments';
const PAYOUTS_TABLE = 'Payouts';
const ADDONS_TABLE = 'Add-On Purchases';

export async function GET(req: Request) {
  const r = await requireRancher(req);
  if (r instanceof NextResponse) return r;
  const { session } = r;

  // DEMO MODE (local only, NEXT_PUBLIC_DEMO_MODE) — never true in prod; see
  // lib/demo/demoMode.ts. Mirrors the payouts route's demo branch so
  // /rancher/billing isn't a wall of nulls/not_connected on camera. Shape
  // matches the live response exactly; numbers agree with the demo store
  // (tier Ranch @ $350/mo, locked 6% commission) and with /api/rancher/
  // payouts' demo figures (last paid payout $1,225, $610 in transit). No
  // Stripe or Airtable call.
  if (isDemoMode()) {
    const dayMs = 24 * 60 * 60 * 1000;
    const iso = (deltaDays: number) => new Date(Date.now() + deltaDays * dayMs).toISOString();
    return NextResponse.json({
      pricingModel: 'tier_v2',
      tier: 'ranch',
      tierLabel: TIERS.ranch.label,
      monthlyCents: TIERS.ranch.monthlyCents,
      commissionRate: 0.06, // the demo rancher's locked Commission Rate
      subscriptionStatus: 'active',
      subscriptionStarted: iso(-45),
      subscriptionNext: iso(15),
      // No real Stripe subscription behind demo mode — keep the plan
      // switcher hidden so nothing on camera can click into a live 409.
      hasRealSubscription: false,
      connectStatus: 'active',
      connectAccountId: 'acct_DEMO00000000',
      connectCurrentlyDueCount: 0,
      connectCanResumeOnboarding: false,
      // Legacy escrow list — permanently empty under direct charges (same
      // as live); the UI renders stripePayouts.
      payouts: [],
      // Demo rancher rides the Connect rail — nothing owed, block hidden.
      commissionOwed: { rows: [], totalDue: 0 },
      stripePayouts: [
        {
          id: 'po_DEMO0003',
          amountCents: 61000,
          status: 'in_transit',
          createdISO: iso(-1),
          arrivalDateISO: iso(2),
          destinationLast4: '4242',
        },
        {
          id: 'po_DEMO0002',
          amountCents: 122500,
          status: 'paid',
          createdISO: iso(-8),
          arrivalDateISO: iso(-6),
          destinationLast4: '4242',
        },
        {
          id: 'po_DEMO0001',
          amountCents: 98750,
          status: 'paid',
          createdISO: iso(-22),
          arrivalDateISO: iso(-20),
          destinationLast4: '4242',
        },
      ],
      addOns: [],
    });
  }

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

  // Commission owed (ticket 2026-08-03) — unpaid post-close commission with a
  // Pay path per row. RAIL-PER-ROW: selection is per REFERRAL (Closed Won +
  // unpaid + no Deposit Paid At + Commission Due > 0), NEVER per rancher —
  // a tier_v2/Connect rancher with off-rail closes still owes, and a
  // deposit-rail row never shows here (its fee was buyer-paid at deposit).
  // Connect-only ranchers therefore get zero rows and the UI hides the block.
  //   null = read failed (UI says so, never claims "nothing owed")
  //   {rows: [], ...} = genuinely nothing owed
  let commissionOwed: { rows: CommissionOwedRow[]; totalDue: number } | null = {
    rows: [],
    totalDue: 0,
  };
  try {
    const referralRows = await fetchReferralRowsForRancher(session.rancherId);
    const rows = selectCommissionOwedRows(referralRows, session.rancherId);
    commissionOwed = { rows, totalDue: totalCommissionOwed(rows) };
  } catch (e: any) {
    console.warn('[billing/data] commission-owed fetch failed:', e?.message);
    commissionOwed = null;
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
    // SLICE E — the REAL commission rate, same precedence as every money path
    // (lib/commission.ts): the rancher's locked 'Commission Rate' field wins
    // (negotiated rates — Ashcraft is 4%, not the tier default), else the tier
    // default. The old `tierConfig?.commissionRate` ignored locked rates and
    // returned null for legacy ranchers, so /rancher/billing showed the wrong
    // number to anyone off the standard tier rate. Repeat-incident territory
    // (2026-05-20 Ashcraft dispute) — displayed rate must match billed rate.
    commissionRate: hasLockedCommissionRate(rancher)
      ? getRancherCommissionRate(rancher)
      : commissionRateForTier(tier),
    subscriptionStatus,
    subscriptionStarted,
    subscriptionNext,
    // Dashboard-audit rank 8: the plan switcher must only render for ranchers
    // with a REAL Stripe subscription — legacy_connect carries a synthetic
    // 'active' Subscription Status with no Stripe Subscription Id, and
    // /api/rancher/tier/change 409s without one.
    hasRealSubscription: !!String(rancher['Stripe Subscription Id'] || '').trim(),
    connectStatus,
    connectAccountId: connectAccountId || null,
    connectCurrentlyDueCount,
    connectCanResumeOnboarding,
    payouts,
    stripePayouts,
    commissionOwed,
    addOns,
  });
}
