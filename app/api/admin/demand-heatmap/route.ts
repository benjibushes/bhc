// GET /api/admin/demand-heatmap — the rancher-RECRUITING weapon (backlog #114).
//
// Supply is the platform's only real constraint, and rancher onboarding is
// proven — what's missing is the top of ITS funnel. This endpoint turns the
// demand data into the pitch no cold recruiter can match: per-state counts of
// qualified WAITING buyers vs. the ranchers who can actually serve them, so
// Ben walks into any state with "N buyers are waiting in your radius right
// now — you fill them, we already found them."
//
// Read-only, admin-gated. Coverage uses the same precedence as the routing
// engine (Routing States → States Served → home state), so the gap numbers
// here agree with what routing would actually do.

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';
import { getAllRecords, TABLES } from '@/lib/airtable';
import { isRancherOnConnect, isRancherOperationalForBuyers } from '@/lib/rancherEligibility';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const unauthorized = await requireAdmin(request);
  if (unauthorized) return unauthorized;

  const [waiting, ranchers] = await Promise.all([
    getAllRecords(
      TABLES.CONSUMERS,
      `AND({Buyer Stage}="WAITING", NOT({Email}=""), {Unsubscribed}!=1)`,
    ).catch(() => [] as any[]),
    getAllRecords(TABLES.RANCHERS).catch(() => [] as any[]),
  ]);

  // Demand: WAITING buyers per state.
  const demand = new Map<string, number>();
  for (const c of waiting as any[]) {
    const st = String(c['State'] || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(st)) continue;
    demand.set(st, (demand.get(st) || 0) + 1);
  }

  // Supply: deposit-capable ranchers COVERING each state (routing precedence).
  const supply = new Map<string, number>();
  for (const r of ranchers as any[]) {
    if (!isRancherOnConnect(r) || !isRancherOperationalForBuyers(r)) continue;
    const covered = new Set<string>(
      String(r['Routing States'] || r['States Served'] || '')
        .toUpperCase()
        .split(/[,\s]+/)
        .filter((s) => /^[A-Z]{2}$/.test(s)),
    );
    const home = String(r['State'] || '').trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(home)) covered.add(home);
    for (const st of covered) supply.set(st, (supply.get(st) || 0) + 1);
  }

  // The board: every state with demand, gap-sorted (most starved first).
  const rows = [...demand.entries()]
    .map(([state, buyers]) => ({
      state,
      waitingBuyers: buyers,
      activeRanchers: supply.get(state) || 0,
      // The recruiting line, ready to paste into a DM/text.
      pitch: `${buyers} qualified buyers are waiting for ranch beef in ${state} right now — you fill them, we already found them. buyhalfcow.com/sell`,
    }))
    .sort((a, b) => b.waitingBuyers - a.waitingBuyers || a.activeRanchers - b.activeRanchers);

  return NextResponse.json({
    totalWaiting: (waiting as any[]).length,
    statesWithDemand: rows.length,
    rows,
  });
}
