import { NextResponse } from 'next/server';
import { TABLES } from '@/lib/airtable';
// Airtable diet 2026-07-28: full-table reads ride the shared admin snapshot
// (module-scope + Redis, 3-min TTL) — this route, health, command-center and
// referrals-stats were each independently re-scanning the same big tables.
import { adminSnapshotTable } from '@/lib/adminSnapshot';
import { requireRole } from '@/lib/adminAuth';
import { getSpendInRange } from '@/lib/adSpend';
import { sourceQualityRates } from '@/lib/sourceQuality';
import { deriveSalesMetrics, isLegacyInquirySale } from '@/lib/salesMetrics';
import { computeLegacyCommissionEarned, computeConnectFeeCaptured } from '@/lib/commissionStats';

export const maxDuration = 60;

// P1 audit D-5: date filter + per-Source attribution breakdown.
// Closest thing to per-channel CAC w/o Meta Ads spend integration.
// Query param: ?sinceDays=7|30|90|all (default 'all' for backward compat).

export async function GET(request: Request) {
  try {
    // Opened to 'ads' partner: read-only buyer/funnel analytics.
    const __authResp = await requireRole(request, ['admin', 'ads']);
    if (__authResp) return __authResp;

    const url = new URL(request.url);
    const sinceParam = (url.searchParams.get('sinceDays') || 'all').toLowerCase();
    const sinceDays = sinceParam === 'all' ? null : Math.max(1, Math.min(365, Number(sinceParam) || 0));
    const cutoff = sinceDays ? Date.now() - sinceDays * 86400000 : 0;
    const withinRange = (iso: any): boolean => {
      if (!sinceDays) return true;
      if (!iso) return false;
      const t = new Date(iso).getTime();
      return Number.isFinite(t) && t >= cutoff;
    };

    const consumers = await adminSnapshotTable(TABLES.CONSUMERS);
    const inquiries = await adminSnapshotTable(TABLES.INQUIRIES);
    const campaigns = await adminSnapshotTable(TABLES.CAMPAIGNS);

    let referrals: any[] = [];
    try {
      referrals = await adminSnapshotTable(TABLES.REFERRALS);
    } catch {
      // Referrals table may not exist yet
    }

    // Payments carry the CONNECT-rail fee (`Platform Fee Cents`) — the half of
    // BHC's revenue that Referrals knows nothing about. Needed for a truthful
    // ROAS numerator (see bhcRevenueAllRails below). Degrades to [] so the
    // page still renders if the table read fails.
    let payments: any[] = [];
    try {
      payments = await adminSnapshotTable(TABLES.PAYMENTS);
    } catch {
      // Payments table may not exist in every environment
    }

    // Apply date filter — fall back to including the row if it has no Created
    // when sinceDays is 'all' (legacy rows pre-Created field).
    const consumersInRange = consumers.filter((c: any) => withinRange(c['Created'] || c._createdTime));
    const inquiriesInRange = inquiries.filter((i: any) => withinRange(i['Created'] || i._createdTime));
    const referralsInRange = referrals.filter((r: any) => withinRange(r['Created At'] || r['Created'] || r._createdTime));
    const paymentsInRange = payments.filter((p: any) => withinRange(p['Created At'] || p._createdTime));

    // Legacy Inquiries "Sale Completed" path (pre-tier_v2 / manual closes) —
    // still used below for campaign attribution + the activity feed.
    const completedSales = inquiriesInRange.filter(isLegacyInquirySale);

    // B4: the tier_v2 deposit funnel writes SALES to Referrals (+ Payments),
    // NOT Inquiries — so the headline numbers read ~0 the moment ads drive
    // deposit-flow sales unless Referrals are counted. All derivation lives in
    // lib/salesMetrics (pure, unit-tested): a referral is a sale once the
    // deposit landed ('Deposit Paid At') OR it reached 'Closed Won', counted
    // exactly ONCE — the previous inline math re-added the Closed Won slice on
    // top of referral revenue/commission, near-doubling both the moment the
    // first funnel deal closed. Conversion = sales per funnel LEAD (consumers).
    const sales = deriveSalesMetrics(inquiriesInRange, referralsInRange, consumersInRange.length);

    const campaignStats: any[] = [];
    const campaignMap = new Map();

    campaigns.forEach((c: any) => {
      const name = c['Campaign Name'];
      if (name) {
        campaignMap.set(name, {
          campaignName: name,
          // Field is `Recipients` (not `Recipients Count`) — the prior name
          // never existed in the Campaigns schema, so emailsSent was always 0.
          emailsSent: parseInt(c['Recipients'] || '0'),
          signUps: 0,
          inquiries: 0,
          sales: 0,
          totalRevenue: 0,
          totalCommission: 0,
        });
      }
    });

    consumersInRange.forEach((c: any) => {
      const campaign = c['Campaign'];
      if (campaign && campaignMap.has(campaign)) {
        const stats = campaignMap.get(campaign);
        stats.signUps++;
      }
    });

    inquiriesInRange.forEach((i: any) => {
      const source = i['Source'];
      if (source && campaignMap.has(source)) {
        const stats = campaignMap.get(source);
        stats.inquiries++;
        if (i['Status'] === 'Sale Completed') {
          stats.sales++;
          stats.totalRevenue += parseFloat(i['Sale Amount'] || '0');
          stats.totalCommission += parseFloat(i['Commission Amount'] || '0');
        }
      }
    });

    campaignStats.push(...Array.from(campaignMap.values()));

    // P1 audit D-5: per-Source attribution. Buckets Consumers by their Source
    // field (organic / rancher-page / exit-intent / partner-XXX /
    // rancher-<slug>) and traces them through to matches and closes via the
    // Referrals + Closed Won pipeline. Sortable by closed-won $ — Ben's
    // closest signal to per-channel CAC w/o spend data.
    const sourceMap = new Map<string, {
      source: string;
      signups: number;
      qualified: number;      // slice 4: Qualified At set — passed the quiz
      matches: number;
      depositsPaid: number;   // slice 4: Deposit Paid At — real tier_v2 money
      closes: number;
      commissionDue: number;
      /** Connect-rail fee captured at deposit, attributed to this source. */
      connectFee: number;
      saleRevenue: number;
    }>();
    const bucket = (key: string) => {
      if (!sourceMap.has(key)) {
        sourceMap.set(key, { source: key, signups: 0, qualified: 0, matches: 0, depositsPaid: 0, closes: 0, commissionDue: 0, connectFee: 0, saleRevenue: 0 });
      }
      return sourceMap.get(key)!;
    };

    // Index succeeded Connect fees by the referral that earned them, so each
    // source's ROAS can count the money BHC actually banked at deposit — not
    // just the legacy `Commission Due` receivable. `Referral` is the link
    // field; `Referral Id Text` is the denormalised fallback.
    const paymentsByReferralId = new Map<string, any[]>();
    for (const p of paymentsInRange) {
      const link = p['Referral'];
      const rid = (Array.isArray(link) ? link[0] : link) || p['Referral Id Text'] || '';
      if (!rid) continue;
      const list = paymentsByReferralId.get(rid);
      if (list) list.push(p);
      else paymentsByReferralId.set(rid, [p]);
    }

    // Index Consumers by id to map referrals back to their Source.
    // ROAS fix: the source map must cover ALL consumers (all-time), not just
    // those created in-range. A close inside the range whose buyer signed up
    // BEFORE the window would otherwise be dropped (consumerSourceById.get
    // returns undefined → the close is silently uncounted → ROAS under-reports).
    // Mirrors command-center route (~232-237). Signups still count in-range only.
    const consumerSourceById = new Map<string, string>();
    consumers.forEach((c: any) => {
      const source = (c['Source'] || 'organic').toString().trim() || 'organic';
      if (c.id) consumerSourceById.set(c.id, source);
    });
    consumersInRange.forEach((c: any) => {
      const source = (c['Source'] || 'organic').toString().trim() || 'organic';
      bucket(source).signups++;
      // slice 4: quiz-passers per source (top-of-funnel quality signal).
      if (c['Qualified At']) bucket(source).qualified++;
    });

    // Walk Referrals — link to Buyer to get Source. If a referral has no
    // linked buyer or the buyer was created outside the range, skip.
    referralsInRange.forEach((r: any) => {
      const buyerIds = r['Buyer'] || [];
      const buyerId = Array.isArray(buyerIds) ? buyerIds[0] : null;
      if (!buyerId) return;
      const source = consumerSourceById.get(buyerId);
      if (!source) return;
      const status = r['Status'] || '';
      // Active referral counts as "matched" if it's past Pending Approval
      if (status && status !== 'Pending Approval') {
        bucket(source).matches++;
      }
      if (status === 'Closed Won') {
        bucket(source).closes++;
        bucket(source).commissionDue += Number(r['Commission Due'] || 0);
        bucket(source).saleRevenue += Number(r['Sale Amount'] || 0);
      }
      // slice 4: real tier_v2 money per source — independent of Closed Won.
      // A paid deposit is the truest "this source pays" signal (the deposit
      // funnel writes money to Referrals, not Closed Won). Counted once per
      // referral that has a Deposit Paid At stamp.
      if (r['Deposit Paid At']) bucket(source).depositsPaid++;

      // Connect-rail fee earned by this referral, attributed to its source.
      // Uses the shared helper so 'succeeded'-only + cents→dollars stays in
      // one place. Independent of Closed Won: the fee is taken at deposit.
      const refPayments = paymentsByReferralId.get(r.id);
      if (refPayments) bucket(source).connectFee += computeConnectFeeCaptured(refPayments);
    });

    // Join paid-ad spend (same date range) to each source → ROAS + CAC.
    //   roas    = BHC revenue / spend     (platform return, BOTH rails)
    //   gmvRoas = sale $ / spend          (standard marketing ROAS)
    //   cac     = spend / paying customers
    const spend = await getSpendInRange(cutoff);

    // ── BHC REVENUE, BOTH RAILS (money-model truth, mirrors #485) ───────────
    // The old blended ROAS divided `sales.totalCommission` by spend. That sum
    // is rail-blind: `Commission Due` only means anything on the deprecated
    // invoice-after-close rail, so as Connect scales the numerator drifts
    // further below what BHC actually earned and ROAS reads worse every month.
    // Compose the numerator from the two rails' own sources of truth instead —
    // reusing lib/commissionStats so the rail logic is never re-implemented:
    //   legacy  — Closed Won, legacy-rail only, `Commission Due`
    //   connect — succeeded Payments' `Platform Fee Cents` (taken at deposit)
    //   legacy inquiries — the pre-tier_v2 Inquiries ledger, kept visible
    // No double count: referralRail() sends a row to exactly one of the first
    // two (a `Deposit Paid At` stamp means Connect took the fee already).
    const legacyCommission = computeLegacyCommissionEarned(referralsInRange);
    const connectFeeCaptured = computeConnectFeeCaptured(paymentsInRange);
    const bhcRevenueAllRails =
      Math.round((legacyCommission + connectFeeCaptured + sales.legacyInquiryCommission) * 100) / 100;

    const breakdownRows = Array.from(sourceMap.values()).map((s) => {
      const sp = spend.bySource.get(s.source.trim().toLowerCase()) || 0;
      // slice 4: funnel-quality rates — which source sends ready-to-buy leads
      // that actually PAY. qualifiedRate = top-funnel targeting; payRate =
      // signup→money; qualifiedToPaidRate = of quiz-passers, who paid.
      const quality = sourceQualityRates(s);
      // BHC's real take from this source: legacy receivable + Connect fee.
      const bhcRevenue = Math.round((s.commissionDue + s.connectFee) * 100) / 100;
      return {
        ...s,
        bhcRevenue,
        spend: sp,
        // null (not 0) when this source has no logged spend — an unspent
        // source has no return, it does not have a zero return.
        roas: sp > 0 ? bhcRevenue / sp : null,
        gmvRoas: sp > 0 ? s.saleRevenue / sp : null,
        // Cost per paying customer for this source. null when either side is 0.
        cac: sp > 0 && s.depositsPaid > 0 ? sp / s.depositsPaid : null,
        ...quality,
      };
    });
    // Surface spend on sources that have no signups in range (pure waste) so
    // it's never hidden — otherwise blended ROAS would drop with no visible row.
    const seenSources = new Set(Array.from(sourceMap.keys()).map((k) => k.trim().toLowerCase()));
    spend.bySource.forEach((sp, src) => {
      if (!seenSources.has(src)) {
        // Spend with nothing to show for it. roas/gmvRoas are a TRUE 0 here
        // (money went out, none came back) — not the "no data" case, which is
        // null. cac stays null: zero customers, so cost-per-customer is
        // undefined rather than infinite.
        breakdownRows.push({
          source: src, signups: 0, qualified: 0, matches: 0, depositsPaid: 0, closes: 0, commissionDue: 0,
          connectFee: 0, bhcRevenue: 0, saleRevenue: 0, spend: sp, roas: 0, gmvRoas: 0, cac: null,
          qualifiedRate: null, payRate: null, qualifiedToPaidRate: null,
        });
      }
    });
    const sourceBreakdown = breakdownRows.sort((a, b) => b.commissionDue - a.commissionDue);

    const recentActivity: any[] = [];

    consumersInRange
      .slice(-10)
      .reverse()
      .forEach((c: any) => {
        recentActivity.push({
          type: 'signup',
          name: c['Full Name'] || 'Unknown',
          details: `Applied for access in ${c['State'] || 'Unknown'}`,
          source: c['Campaign'] || c['Source'] || 'organic',
          date: c['Created'] || new Date().toISOString(),
        });
      });

    inquiriesInRange
      .filter((i: any) => i['Status'] !== 'Pending')
      .slice(-5)
      .reverse()
      .forEach((i: any) => {
        recentActivity.push({
          type: 'inquiry',
          name: i['Consumer Name'] || 'Unknown',
          details: `Inquired about ${i['Ranch Name'] || 'a ranch'}`,
          source: i['Source'] || 'organic',
          date: i['Created'] || new Date().toISOString(),
        });
      });

    completedSales
      .slice(-5)
      .reverse()
      .forEach((i: any) => {
        recentActivity.push({
          type: 'sale',
          name: i['Consumer Name'] || 'Unknown',
          details: `Purchased from ${i['Ranch Name'] || 'a ranch'}`,
          source: i['Source'] || 'organic',
          amount: parseFloat(i['Commission Amount'] || '0'),
          date: i['Created'] || new Date().toISOString(),
        });
      });

    // Sort activity by date
    recentActivity.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    // Referral analytics — date-filtered
    const closedWon = referralsInRange.filter((r: any) => r['Status'] === 'Closed Won');
    const refRevenue = closedWon.reduce((s: number, r: any) => s + (r['Sale Amount'] || 0), 0);
    const refCommission = closedWon.reduce((s: number, r: any) => s + (r['Commission Due'] || 0), 0);
    const pendingReferrals = referralsInRange.filter((r: any) => r['Status'] === 'Pending Approval').length;
    const activeReferrals = referralsInRange.filter((r: any) =>
      !['Closed Won', 'Closed Lost', 'Dormant'].includes(r['Status'])
    ).length;

    const avgTimeToClose = closedWon.length > 0
      ? closedWon.reduce((s: number, r: any) => {
          const created = r['Created At'] ? new Date(r['Created At']).getTime() : 0;
          const closed = r['Closed At'] ? new Date(r['Closed At']).getTime() : 0;
          return s + (closed && created ? (closed - created) / 86400000 : 0);
        }, 0) / closedWon.length
      : 0;

    // Intent score correlation
    const highIntentClosed = closedWon.filter((r: any) => r['Intent Classification'] === 'High').length;
    const highIntentTotal = referralsInRange.filter((r: any) => r['Intent Classification'] === 'High').length;
    const medIntentClosed = closedWon.filter((r: any) => r['Intent Classification'] === 'Medium').length;
    const medIntentTotal = referralsInRange.filter((r: any) => r['Intent Classification'] === 'Medium').length;

    // Revenue by state
    const revenueByState: Record<string, number> = {};
    closedWon.forEach((r: any) => {
      const state = r['Buyer State'] || 'Unknown';
      revenueByState[state] = (revenueByState[state] || 0) + (r['Sale Amount'] || 0);
    });
    const revenueByStateArr = Object.entries(revenueByState)
      .map(([state, revenue]) => ({ state, revenue }))
      .sort((a, b) => b.revenue - a.revenue);

    return NextResponse.json({
      // Echo the filter so the UI can show "Last 7 days" etc.
      filter: { sinceDays, label: sinceDays ? `Last ${sinceDays}d` : 'All time' },
      overview: {
        totalConsumers: consumersInRange.length,
        totalInquiries: inquiriesInRange.length,
        // Deposit-funnel truth (Referrals — where tier_v2 money actually lands).
        depositsPaid: sales.depositsPaid,
        salesClosed: sales.salesClosed,
        // Legacy Inquiries 'Sale Completed' count, clearly named so the old
        // number never silently disappears.
        legacyInquirySales: sales.legacyInquirySales,
        totalSales: sales.totalSales,
        // NOTE: refRevenue/refCommission (Closed Won) are NOT added here —
        // they are already inside sales.totalRevenue/-Commission. The old
        // `+ refRevenue` double-counted every closed funnel deal.
        totalRevenue: sales.totalRevenue,
        totalCommission: sales.totalCommission,
        conversionRate: sales.conversionRate,
        totalSpend: spend.total,
        // BHC's OWN revenue across every rail — the honest ROAS numerator.
        bhcRevenueAllRails,
        // Blended return across all paid channels. null (never 0 / ∞ / a fake
        // ratio) when no spend has been logged for the period.
        blendedRoas: spend.total > 0 ? bhcRevenueAllRails / spend.total : null,
        blendedGmvRoas: spend.total > 0 ? sales.totalRevenue / spend.total : null,
        // CAC = ad spend ÷ paying customers (deposit landed). null when there
        // is no spend OR no customers — dividing by zero would print ∞.
        cac: spend.total > 0 && sales.depositsPaid > 0 ? spend.total / sales.depositsPaid : null,
        payingCustomers: sales.depositsPaid,
      },
      referralStats: {
        total: referralsInRange.length,
        pending: pendingReferrals,
        active: activeReferrals,
        closedWon: closedWon.length,
        closedLost: referralsInRange.filter((r: any) => r['Status'] === 'Closed Lost').length,
        revenue: refRevenue,
        commission: refCommission,
        avgDaysToClose: Math.round(avgTimeToClose),
        intentCorrelation: {
          high: { closed: highIntentClosed, total: highIntentTotal, rate: highIntentTotal > 0 ? highIntentClosed / highIntentTotal : 0 },
          medium: { closed: medIntentClosed, total: medIntentTotal, rate: medIntentTotal > 0 ? medIntentClosed / medIntentTotal : 0 },
        },
        revenueByState: revenueByStateArr,
      },
      campaigns: campaignStats,
      sourceBreakdown,
      recentActivity: recentActivity.slice(0, 20),
    });
  } catch (error: any) {
    console.error('Error fetching analytics:', error);
    return NextResponse.json({ error: error.message || 'Failed to fetch analytics' }, { status: 500 });
  }
}
