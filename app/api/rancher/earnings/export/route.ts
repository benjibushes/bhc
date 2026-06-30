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
import { TABLES, getAllRecords } from '@/lib/airtable';
import { requireRancher } from '@/lib/rancherAuth';
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

  // Load + filter to this rancher's Closed Won deals. Mirror the dashboard's
  // client-side ownership filter (ARRAYJOIN can't match record ids — see the
  // long comment in /api/rancher/dashboard/route.ts).
  let rows: EarningsRow[] = [];
  try {
    const allRefs = (await getAllRecords(TABLES.REFERRALS)) as any[];
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
      }));
  } catch (e: any) {
    console.error('[rancher/earnings/export] referrals load failed:', e?.message || e);
    return NextResponse.json({ error: 'Could not load earnings.' }, { status: 500 });
  }

  const ranged = filterByClosedDate(rows, from, to)
    // Newest closed first for a readable sheet.
    .sort((a, b) => Date.parse(b.closedAt || '') - Date.parse(a.closedAt || ''));

  const csv = buildEarningsCsv(ranged);
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
