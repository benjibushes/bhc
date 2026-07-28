import { NextResponse } from 'next/server';
import { TABLES } from '@/lib/airtable';
// Airtable diet 2026-07-28: full-table reads ride the shared admin snapshot
// (module-scope + Redis, 3-min TTL) shared with health/command-center/analytics.
import { adminSnapshotTable } from '@/lib/adminSnapshot';
import { requireAdmin } from '@/lib/adminAuth';
import { getMaxActiveReferrals } from '@/lib/rancherCapacity';
import { getAdminConfig } from '@/lib/adminConfig';
import {
  computeUnpaidCommission,
  computeConnectFeeCaptured,
  countConnectFeePayments,
  legacyClosedWon,
} from '@/lib/commissionStats';

export const maxDuration = 60;

export async function GET(request: Request) {
  try {
    const __authResp = await requireAdmin(request);
    if (__authResp) return __authResp;
    const adminCfg = await getAdminConfig();
    const [consumers, ranchers] = await Promise.all([
      adminSnapshotTable(TABLES.CONSUMERS),
      adminSnapshotTable(TABLES.RANCHERS),
    ]);

    let referrals: any[] = [];
    try {
      referrals = await adminSnapshotTable(TABLES.REFERRALS);
    } catch (e) {
      console.warn('Referrals table not accessible');
    }

    const pendingApproval = referrals.filter((r: any) => r['Status'] === 'Pending Approval').length;

    const buyersByState: Record<string, number> = {};
    consumers.forEach((c: any) => {
      const state = c['State'] || 'Unknown';
      buyersByState[state] = (buyersByState[state] || 0) + 1;
    });
    const buyersByStateArr = Object.entries(buyersByState)
      .map(([state, count]) => ({ state, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const activeReferralsByRancher = ranchers
      .filter((r: any) => (r['Current Active Referrals'] || 0) > 0)
      .map((r: any) => ({
        rancherId: r.id,
        name: r['Operator Name'] || r['Ranch Name'] || 'Unknown',
        state: r['State'] || '',
        count: r['Current Active Referrals'] || 0,
        max: getMaxActiveReferrals(r),
      }))
      .sort((a: any, b: any) => b.count - a.count);

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    // Single source of truth for "Closed Won" + commission math. The dashboard
    // receivable tile must show ALL unpaid commission (any month), not just
    // this-month closes — mirrors command-center's commissionUnpaid.
    //
    // RAIL-AWARE (2026-07-24): `Commission Due` only means anything on the
    // LEGACY rail (rancher owes BHC 10%, invoiced monthly after close). A
    // Connect close already had its fee taken at deposit, so counting it here
    // would show the founder a receivable Stripe collected — and disagree with
    // the rancher dashboard, which filters on this same rail. Connect-rail
    // revenue is surfaced separately below from Payments.
    //
    // The rail filter applies to the COMMISSION sums only. `closedThisMonth`
    // stays all-rails: it is a DEAL COUNT, and a Connect close is every bit a
    // deal closed this month — narrowing it would under-report the month.
    const isClosedThisMonth = (r: any) => {
      const closedAt = r['Closed At'];
      return Boolean(closedAt && closedAt >= startOfMonth);
    };
    const closedThisMonth = referrals.filter(
      (r: any) => r['Status'] === 'Closed Won' && isClosedThisMonth(r),
    );

    // This-month LEGACY commission still owed (kept for any caller that wants
    // the monthly slice). The receivable TILE uses commissionUnpaid below.
    const totalCommission = legacyClosedWon(referrals as any[])
      .filter(isClosedThisMonth)
      .reduce(
        (sum: number, r: any) => sum + (r['Commission Paid'] === true ? 0 : (r['Commission Due'] || 0)), 0
      );

    // All-time unpaid LEGACY commission receivable (pre-Connect economics).
    const commissionUnpaid = computeUnpaidCommission(referrals);

    // ── CONNECT-RAIL TRUTH ───────────────────────────────────────────────
    // The other half of BHC revenue lives in Payments.Platform Fee Cents (the
    // marketplace fee added to the buyer and captured at deposit), NOT in
    // Referrals. Surfaced beside the legacy receivable so the operator sees
    // both rails instead of one number that silently means only one of them.
    // Non-fatal: a Payments read failure yields null (tile renders "—"),
    // never a wrong number and never a 500 on the whole dashboard.
    let connectFeeCaptured: number | null = null;
    let connectFeeCount: number | null = null;
    try {
      const payments = await adminSnapshotTable(TABLES.PAYMENTS);
      connectFeeCaptured = computeConnectFeeCaptured(payments as any[]);
      connectFeeCount = countConnectFeePayments(payments as any[]);
    } catch (e: any) {
      console.warn('[referrals stats] Payments read failed, Connect fee unavailable:', e?.message);
    }

    // Stalled leads — Intro Sent for longer than
    // the operator-tunable stall threshold and not yet closed. Status is still
    // 'Intro Sent' here (a replied/closed lead would no longer be in that state).
    const DAY = 24 * 60 * 60 * 1000;
    const stalledLeads = referrals.filter((r: any) => {
      if (r['Status'] !== 'Intro Sent') return false;
      const t = r['Intro Sent At'] || r['Approved At'];
      if (!t) return false;
      return (now.getTime() - new Date(t).getTime()) >= adminCfg.stallThresholdDays * DAY;
    }).length;

    const statusCounts: Record<string, number> = {};
    referrals.forEach((r: any) => {
      const s = r['Status'] || 'Unknown';
      statusCounts[s] = (statusCounts[s] || 0) + 1;
    });

    return NextResponse.json({
      totalBuyers: consumers.length,
      totalRanchers: ranchers.length,
      totalReferrals: referrals.length,
      pendingApproval,
      stalledLeads,
      buyersByState: buyersByStateArr,
      activeReferralsByRancher,
      closedDealsThisMonth: {
        count: closedThisMonth.length,
        totalCommission: Math.round(totalCommission * 100) / 100,
      },
      // All-time unpaid LEGACY commission receivable (pre-Connect rail only;
      // every Closed Won, not just this month). Connect-rail fee revenue is
      // NOT in here — see connectFeeCaptured.
      commissionUnpaid,
      // Connect-rail marketplace fee already captured at deposit (dollars),
      // summed from Payments.Platform Fee Cents on succeeded rows.
      // null ⇒ the Payments read failed; render "—", never $0.
      connectFeeCaptured,
      connectFeeCount,
      statusCounts,
    });
  } catch (error: any) {
    console.error('Error fetching referral stats:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
