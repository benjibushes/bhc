// app/api/admin/funnel-conversion/route.ts
//
// F3 — Funnel observability. State-snapshot read across Consumers + Referrals.
// Separate from /api/admin/funnel which reads a Funnel Events log table.
// This one is simpler: counts buyers at each pipeline stage by UTM source.
//
// Stages (in order, all derived from existing Airtable state):
//   signup    — Consumers w/ Status=Approved
//   qualified — Consumers w/ Qualified At
//   booked    — Referrals w/ Sales Call Booked At
//   invoiced  — Referrals w/ Status=Awaiting Payment
//   locked    — Referrals w/ Status=Slot Locked
//   closed    — Referrals w/ Status=Closed Won
//
// Window: ?since=7d|30d|90d|all (default 30d).
// Returns: totals, conv (rates between stages), bySource (sorted by signup desc).

import { NextResponse } from 'next/server';
import { getAllRecords, TABLES } from '@/lib/airtable';
import { requireAdmin } from '@/lib/adminAuth';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const STAGES = ['signup', 'qualified', 'booked', 'invoiced', 'locked', 'closed'] as const;
type Stage = (typeof STAGES)[number];

export async function GET(req: Request) {
  const a = await requireAdmin(req);
  if (a) return a;

  const url = new URL(req.url);
  const since = url.searchParams.get('since') || '30d';
  const daysBack = since === '7d' ? 7 : since === '90d' ? 90 : since === 'all' ? 9999 : 30;
  const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();

  // Fix 6 — neither Consumers nor Referrals has a `Created Time`/`Created At`
  // FIELD; filtering on them 422'd, .catch(()=>[]) swallowed it, and the
  // whole panel rendered zeros. Airtable's CREATED_TIME() formula function
  // reads record metadata instead.
  const [consumers, referrals] = await Promise.all([
    getAllRecords(
      TABLES.CONSUMERS,
      since === 'all' ? '{Status}="Approved"' : `AND({Status}="Approved",IS_AFTER(CREATED_TIME(),'${cutoff}'))`,
    ).catch(() => []),
    getAllRecords(
      TABLES.REFERRALS,
      since === 'all' ? '' : `IS_AFTER(CREATED_TIME(),'${cutoff}')`,
    ).catch(() => []),
  ]);

  const totals: Record<Stage, number> = {
    signup: consumers.length,
    qualified: consumers.filter((c: any) => c['Qualified At']).length,
    booked: referrals.filter((r: any) => r['Sales Call Booked At']).length,
    invoiced: referrals.filter((r: any) => String(r['Status'] || '') === 'Awaiting Payment').length,
    locked: referrals.filter((r: any) => String(r['Status'] || '') === 'Slot Locked').length,
    closed: referrals.filter((r: any) => String(r['Status'] || '') === 'Closed Won').length,
  };

  // Group by UTM Source on Consumers
  const bySource: Record<string, Record<Stage, number>> = {};
  const consumerById = new Map<string, any>();
  for (const c of consumers as any[]) {
    consumerById.set(c.id, c);
    const src = String(c['Source'] || c['UTM Source'] || 'direct').toLowerCase() || 'direct';
    if (!bySource[src]) {
      bySource[src] = { signup: 0, qualified: 0, booked: 0, invoiced: 0, locked: 0, closed: 0 };
    }
    bySource[src].signup++;
    if (c['Qualified At']) bySource[src].qualified++;
  }
  // Tie referrals back to source via Buyer link → Consumer's Source
  for (const r of referrals as any[]) {
    const buyerLink = Array.isArray(r['Buyer']) ? r['Buyer'][0] : null;
    const c = buyerLink ? consumerById.get(buyerLink) : null;
    const src = String(c?.['Source'] || c?.['UTM Source'] || 'direct').toLowerCase() || 'direct';
    if (!bySource[src]) {
      bySource[src] = { signup: 0, qualified: 0, booked: 0, invoiced: 0, locked: 0, closed: 0 };
    }
    if (r['Sales Call Booked At']) bySource[src].booked++;
    const st = String(r['Status'] || '');
    if (st === 'Awaiting Payment') bySource[src].invoiced++;
    if (st === 'Slot Locked') bySource[src].locked++;
    if (st === 'Closed Won') bySource[src].closed++;
  }

  const conv = computeConversions(totals);
  const sourcesList = Object.entries(bySource)
    .map(([source, stages]) => ({
      source,
      ...stages,
      conv: computeConversions(stages),
    }))
    .sort((a, b) => b.signup - a.signup);

  return NextResponse.json({
    since,
    daysBack,
    totals,
    conv,
    bySource: sourcesList,
  });
}

function computeConversions(stages: Record<Stage, number>) {
  const pct = (num: number, den: number) =>
    den > 0 ? Math.round((num / den) * 1000) / 10 : 0;
  return {
    signup_to_qualified: pct(stages.qualified, stages.signup),
    qualified_to_booked: pct(stages.booked, stages.qualified),
    booked_to_invoiced: pct(stages.invoiced, stages.booked),
    invoiced_to_locked: pct(stages.locked, stages.invoiced),
    locked_to_closed: pct(stages.closed, stages.locked),
    signup_to_closed: pct(stages.closed, stages.signup),
  };
}
