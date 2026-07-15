// GET /api/rancher/earnings/export?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// WAVE 3b (2026-06-30) — rancher-scoped CSV export of closed-won deals for
// taxes / bookkeeping. The Earnings dashboard view is otherwise static cards;
// this lets a rancher pull a date-ranged spreadsheet of their closed sales
// (buyer, cut, sale amount, commission, net, intro/closed dates).
//
// NOT a money endpoint — read-only. Loads the rancher's OWN referrals (same
// ownership filter as /api/rancher/dashboard), keeps Closed Won, applies the
// optional inclusive date range on the closed date, and streams a CSV.
//
// Auth: requireRancher. Ownership: only referrals linked to this rancher
// (Rancher or Suggested Rancher).

import { NextResponse } from 'next/server';
import { TABLES, getAllRecords, getRecordById, escapeAirtableValue } from '@/lib/airtable';
import { requireRancher } from '@/lib/rancherAuth';
import { fetchReferralRowsForRancher } from '@/lib/referralReads';
import {
  buildEarningsCsv,
  filterByClosedDate,
  earningsCsvFilename,
  type EarningsRow,
} from '@/lib/earningsCsv';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: Request) {
  const r = await requireRancher(request);
  if (r instanceof NextResponse) return r;
  const { session } = r;
  const rancherId = String(session.rancherId || '');
  if (!rancherId) {
    return NextResponse.json({ error: 'Session missing rancher id' }, { status: 401 });
  }

  const url = new URL(request.url);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');

  // SLICE E — the "Net to You" column is rail-split (tier_v2 keeps 100% of
  // their price; legacy nets out the commission). Load the rancher's Pricing
  // Model; FAIL LOUD if we can't — a bookkeeping file with the wrong net is
  // worse than no file.
  let rail = 'legacy';
  try {
    const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);
    if (!rancher) {
      return NextResponse.json({ error: 'Could not load earnings.' }, { status: 500 });
    }
    rail = String(rancher['Pricing Model'] || 'legacy');
  } catch (e: any) {
    console.error('[rancher/earnings/export] rancher load failed:', e?.message || e);
    return NextResponse.json({ error: 'Could not load earnings.' }, { status: 500 });
  }

  // Load + filter to this rancher's Closed Won deals. Mirror the dashboard's
  // client-side ownership filter (ARRAYJOIN can't match record ids — see the
  // long comment in /api/rancher/dashboard/route.ts).
  let rows: EarningsRow[] = [];
  try {
    // Scale audit 2026-07-07: rancher-scoped filtered read (JS filter below = belt).
    const allRefs = (await fetchReferralRowsForRancher(rancherId)) as any[];
    rows = allRefs
      .filter((ref: any) => {
        const owns = Array.isArray(ref['Rancher']) ? ref['Rancher'] : [];
        const suggested = Array.isArray(ref['Suggested Rancher']) ? ref['Suggested Rancher'] : [];
        return owns.includes(rancherId) || suggested.includes(rancherId);
      })
      .filter((ref: any) => ref['Status'] === 'Closed Won')
      .map((ref: any) => ({
        id: ref.id,
        buyerName: String(ref['Buyer Name'] || ''),
        orderType: String(ref['Order Type'] || ''),
        saleAmount: Number(ref['Sale Amount'] || 0),
        commissionDue: Number(ref['Commission Due'] || 0),
        closedAt: String(ref['Closed At'] || ref['_createdTime'] || ''),
        introSentAt: String(ref['Intro Sent At'] || ''),
        // RAIL-PER-ROW (audit fix #3): lets buildEarningsCsv decide net per
        // row so a migrated rancher's legacy/off-rail history isn't overstated.
        depositPaidAt: String(ref['Deposit Paid At'] || ''),
      }));
  } catch (e: any) {
    console.error('[rancher/earnings/export] referrals load failed:', e?.message || e);
    return NextResponse.json({ error: 'Could not load earnings.' }, { status: 500 });
  }

  // Wave C (2026-07-14): blend PRODUCT orders into the bookkeeping file.
  // Rancher Orders money previously existed only as per-order lines inside
  // the Products tab — deposit-style product orders never create a Referral,
  // so a jerky/box-heavy rancher downloaded an EMPTY "export for taxes" CSV
  // while Stripe showed real payouts. Same ownership filter as
  // /api/rancher/orders GET; Refunded rows excluded (money went back).
  // FAIL LOUD like the loads above — a bookkeeping file silently missing the
  // product side is worse than no file.
  try {
    const orderRows = (await getAllRecords(
      TABLES.RANCHER_ORDERS,
      `{Rancher Record ID} = "${escapeAirtableValue(rancherId)}"`,
    )) as any[];
    for (const o of orderRows) {
      if (String(o['Rancher Record ID'] || '').trim() !== rancherId) continue;
      if (String(o['Status'] || '') === 'Refunded') continue;
      const buyerPaid = Number(o['Buyer Paid'] || 0);
      const payout = Number(o['Rancher Payout'] || 0);
      rows.push({
        id: String(o['Order Ref'] || o.id),
        buyerName: String(o['Buyer Name'] || ''),
        orderType: String(o['Product Name'] || ''),
        saleAmount: buyerPaid,
        // BHC margin — kept in the Commission column so Sale − Commission =
        // Net holds for product rows exactly like share rows.
        commissionDue: Math.max(0, buyerPaid - payout),
        closedAt: String(o['Ordered At'] || o['_createdTime'] || ''),
        introSentAt: '',
        kind: 'product',
        // Exact settlement-stamped payout — wins over any rail computation.
        netOverride: payout,
      });
    }
  } catch (e: any) {
    console.error('[rancher/earnings/export] orders load failed:', e?.message || e);
    return NextResponse.json({ error: 'Could not load earnings.' }, { status: 500 });
  }

  const ranged = filterByClosedDate(rows, from, to)
    // Newest closed first for a readable sheet.
    .sort((a, b) => Date.parse(b.closedAt || '') - Date.parse(a.closedAt || ''));

  const csv = buildEarningsCsv(ranged, rail);
  const filename = earningsCsvFilename(rancherId, from, to);

  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
