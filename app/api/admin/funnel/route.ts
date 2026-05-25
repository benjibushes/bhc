import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';
import { getAllRecords } from '@/lib/airtable';

// Funnel conversion dashboard API.
// Reads Funnel Events table populated by lib/funnelMetrics + the buyer/rancher
// contracts. Computes stage counts + conversion rates over a configurable
// time window so the operator can see exactly where buyers drop off.
//
// Output shape (consumed by app/admin/funnel/page.tsx):
//   sinceDays: number
//   events: total count in window
//   byStage: Record<stage, count>
//   rates: { signupToEngaged, engagedToMatched, matchedToClosedWon, overallSignupToWon }
//   revenueCents: sum of Amount Cents on close:won events

const FUNNEL_TABLE = 'Funnel Events';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (auth) return auth;

  const url = new URL(request.url);
  const sinceDays = Math.max(1, Math.min(365, Number(url.searchParams.get('sinceDays') || '30')));
  const cutoff = Date.now() - sinceDays * 24 * 60 * 60 * 1000;

  let events: any[] = [];
  try {
    events = await getAllRecords(FUNNEL_TABLE);
  } catch (e: any) {
    // Table doesn't exist yet — surface a friendly error to the dashboard
    // instead of 500ing. Operator adds the table per the plan spec.
    return NextResponse.json({
      error: `Funnel Events table not found in Airtable. Add it per the stage-3 plan to enable this dashboard. (${e?.message?.slice(0, 100) || 'unknown'})`,
      events: 0,
      byStage: {},
      rates: { signupToEngaged: 0, engagedToMatched: 0, matchedToClosedWon: 0, overallSignupToWon: 0 },
      revenueCents: 0,
      sinceDays,
    });
  }

  const recent = events.filter((e: any) => {
    const ts = new Date(e['Created At']).getTime();
    return Number.isFinite(ts) && ts >= cutoff;
  });

  const byStage: Record<string, number> = {};
  let totalRevenue = 0;
  for (const e of recent) {
    const stage = String(e['Stage'] || 'unknown');
    byStage[stage] = (byStage[stage] || 0) + 1;
    if (stage === 'close:won' && typeof e['Amount Cents'] === 'number') {
      totalRevenue += e['Amount Cents'];
    }
  }

  const signups = byStage['signup'] || 0;
  const engaged = byStage['engaged'] || 0;
  const matched = byStage['transition:MATCHED'] || 0;
  const closedWon = byStage['close:won'] || 0;
  const closedLost = byStage['close:lost'] || 0;
  const depositPaid = byStage['deposit_paid'] || 0;

  const rates = {
    signupToEngaged: signups > 0 ? engaged / signups : 0,
    engagedToMatched: engaged > 0 ? matched / engaged : 0,
    matchedToClosedWon: matched > 0 ? closedWon / matched : 0,
    overallSignupToWon: signups > 0 ? closedWon / signups : 0,
  };

  return NextResponse.json({
    sinceDays,
    events: recent.length,
    byStage,
    rates,
    revenueCents: totalRevenue,
    summary: {
      signups,
      engaged,
      matched,
      closedWon,
      closedLost,
      depositPaid,
    },
  });
}
