import { NextResponse } from 'next/server';
import { getAllRecords, TABLES } from '@/lib/airtable';
import { requireAdmin } from '@/lib/adminAuth';
import { isRancherOperationalForBuyers } from '@/lib/rancherEligibility';

// GET /api/admin/today — aggregates action items across the platform so the
// operator can see the highest-value next actions in one glance.
// Returns counts + top-N samples for each category.
export async function GET(request: Request) {
  try {
    const __authResp = await requireAdmin(request);
    if (__authResp) return __authResp;
    // Don't silently swallow Airtable errors — if the DB read fails, the
    // dashboard would show all-zero counts and the operator wouldn't know
    // anything was wrong. Surface failures so they can be diagnosed.
    let referrals: any[] = [];
    let consumers: any[] = [];
    let ranchers: any[] = [];
    const fetchErrors: string[] = [];
    try { referrals = await getAllRecords(TABLES.REFERRALS) as any[]; }
    catch (e: any) { fetchErrors.push(`Referrals: ${e?.message || 'unknown'}`); console.error('Today/Referrals fetch:', e); }
    try { consumers = await getAllRecords(TABLES.CONSUMERS) as any[]; }
    catch (e: any) { fetchErrors.push(`Consumers: ${e?.message || 'unknown'}`); console.error('Today/Consumers fetch:', e); }
    try { ranchers = await getAllRecords(TABLES.RANCHERS) as any[]; }
    catch (e: any) { fetchErrors.push(`Ranchers: ${e?.message || 'unknown'}`); console.error('Today/Ranchers fetch:', e); }
    if (fetchErrors.length === 3) {
      // All 3 reads failed — definitely a DB connectivity issue, fail loudly
      return NextResponse.json({ error: 'Database read failed', details: fetchErrors }, { status: 503 });
    }

    // Build a rancher-id → operator lookup once so we don't rely on the
    // stale "Suggested Rancher Name" text cache (which drifts when ranchers
    // get renamed or replaced — caused the "Jose at High Lonesome" bug).
    const rancherById = new Map<string, any>();
    for (const r of ranchers) rancherById.set(r.id, r);
    const resolveRancherName = (referral: any): string => {
      const links = referral['Rancher'] || referral['Suggested Rancher'] || [];
      const id = Array.isArray(links) ? links[0] : null;
      if (id && rancherById.has(id)) {
        const r = rancherById.get(id);
        return r['Operator Name'] || r['Ranch Name'] || '';
      }
      // Fall back to cached text only if no link exists
      return referral['Suggested Rancher Name'] || referral['Rancher Name'] || '';
    };

    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const str = (v: any) => v?.name ?? v ?? '';

    // Pending referrals awaiting approval
    const pendingApproval = referrals.filter((r: any) => str(r['Status']) === 'Pending Approval');

    // Stalled — Intro Sent 5+ days, not yet closed
    const stalled = referrals.filter((r: any) => {
      if (str(r['Status']) !== 'Intro Sent') return false;
      const t = r['Intro Sent At'] || r['Approved At'];
      if (!t) return false;
      return (now - new Date(t).getTime()) >= 5 * DAY;
    });

    // Unpaid commissions — Closed Won, Commission Paid = false, sorted by oldest
    const unpaid = referrals.filter((r: any) =>
      str(r['Status']) === 'Closed Won' && !r['Commission Paid']
    );
    const unpaidTotal = unpaid.reduce((s: number, r: any) => s + (Number(r['Commission Due']) || 0), 0);

    // High-intent buyers who are Waitlisted/Unmatched (ready to route if rancher appears)
    const highIntentWaiting = consumers.filter((c: any) => {
      const refStatus = str(c['Referral Status']);
      if (refStatus !== 'Waitlisted' && refStatus !== 'Unmatched') return false;
      if (c['Unsubscribed'] || c['Bounced']) return false;
      return (Number(c['Intent Score']) || 0) >= 70;
    });

    // Ranchers who need attention: operationally live but at 0 active referrals.
    // Use the unified eligibility helper (Active + Agreement + Onboarding=Live)
    // — was previously gated on the "Page Live" flag which silently hid
    // routing-ready ranchers behind a UX toggle nobody flipped.
    const underused = ranchers.filter((r: any) => {
      if (!isRancherOperationalForBuyers(r)) return false;
      const active = Number(r['Current Active Referrals']) || 0;
      return active === 0;
    });
    const pendingGoLive = ranchers.filter((r: any) => {
      // Not yet operational, but in the onboarding pipeline
      if (isRancherOperationalForBuyers(r)) return false;
      const status = str(r['Onboarding Status']);
      return status === 'Verification Complete' || status === 'Agreement Signed' || status === 'Docs Sent';
    });

    // Warmup-engaged buyers not yet matched
    const warmupEngaged = consumers.filter((c: any) =>
      !!c['Warmup Engaged At'] && str(c['Warmup Stage']) !== 'matched'
    );

    const sample = (arr: any[], n: number, fn: (x: any) => any) => arr.slice(0, n).map(fn);

    return NextResponse.json({
      counts: {
        pendingApproval: pendingApproval.length,
        stalled: stalled.length,
        unpaidCommissions: unpaid.length,
        unpaidTotal,
        highIntentWaiting: highIntentWaiting.length,
        underused: underused.length,
        pendingGoLive: pendingGoLive.length,
        warmupEngaged: warmupEngaged.length,
      },
      samples: {
        pendingApproval: sample(pendingApproval, 5, (r: any) => ({
          id: r.id,
          buyer_name: r['Buyer Name'] || '',
          buyer_state: r['Buyer State'] || '',
          intent_score: r['Intent Score'] || 0,
          suggested_rancher: resolveRancherName(r),
        })),
        stalled: sample(stalled, 5, (r: any) => ({
          id: r.id,
          buyer_name: r['Buyer Name'] || '',
          rancher_name: resolveRancherName(r),
          days: Math.floor((now - new Date(r['Intro Sent At'] || r['Approved At']).getTime()) / DAY),
        })),
        unpaidCommissions: sample(
          unpaid.sort((a: any, b: any) =>
            new Date(a['Closed At'] || 0).getTime() - new Date(b['Closed At'] || 0).getTime()
          ),
          5,
          (r: any) => ({
            id: r.id,
            buyer_name: r['Buyer Name'] || '',
            rancher_name: resolveRancherName(r),
            commission_due: r['Commission Due'] || 0,
            closed_at: r['Closed At'] || '',
          })
        ),
        highIntentWaiting: sample(
          highIntentWaiting.sort((a: any, b: any) => (b['Intent Score'] || 0) - (a['Intent Score'] || 0)),
          5,
          (c: any) => ({
            id: c.id,
            name: c['Full Name'] || '',
            state: c['State'] || '',
            intent: c['Intent Score'] || 0,
            warmup: str(c['Warmup Stage']),
          })
        ),
        pendingGoLive: sample(pendingGoLive, 5, (r: any) => ({
          id: r.id,
          ranch_name: r['Ranch Name'] || '',
          operator: r['Operator Name'] || '',
          state: r['State'] || '',
          status: str(r['Onboarding Status']),
        })),
        warmupEngaged: sample(
          warmupEngaged.sort((a: any, b: any) => (b['Intent Score'] || 0) - (a['Intent Score'] || 0)),
          5,
          (c: any) => ({
            id: c.id,
            name: c['Full Name'] || '',
            state: c['State'] || '',
            engaged_at: c['Warmup Engaged At'] || '',
          })
        ),
      },
    });
  } catch (error: any) {
    console.error('Today endpoint error:', error);
    return NextResponse.json({ error: error.message || 'Failed to load today dashboard' }, { status: 500 });
  }
}
