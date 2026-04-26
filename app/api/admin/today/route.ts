import { NextResponse } from 'next/server';
import { getAllRecords, TABLES } from '@/lib/airtable';
import { requireAdmin } from '@/lib/adminAuth';

// GET /api/admin/today — aggregates action items across the platform so the
// operator can see the highest-value next actions in one glance.
// Returns counts + top-N samples for each category.
export async function GET(request: Request) {
  try {
    const __authResp = await requireAdmin(request);
    if (__authResp) return __authResp;
    const [referrals, consumers, ranchers] = await Promise.all([
      getAllRecords(TABLES.REFERRALS).catch(() => [] as any[]),
      getAllRecords(TABLES.CONSUMERS).catch(() => [] as any[]),
      getAllRecords(TABLES.RANCHERS).catch(() => [] as any[]),
    ]) as any[][];

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

    // Ranchers who need attention: Live but at 0 active referrals (underused)
    // OR signed agreement but not live yet
    const underused = ranchers.filter((r: any) => {
      const live = !!r['Page Live'];
      const active = Number(r['Current Active Referrals']) || 0;
      return live && active === 0;
    });
    const pendingGoLive = ranchers.filter((r: any) => {
      const status = str(r['Onboarding Status']);
      const live = !!r['Page Live'];
      return !live && (status === 'Verification Complete' || status === 'Agreement Signed');
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
          suggested_rancher: r['Suggested Rancher Name'] || '',
        })),
        stalled: sample(stalled, 5, (r: any) => ({
          id: r.id,
          buyer_name: r['Buyer Name'] || '',
          rancher_name: r['Suggested Rancher Name'] || '',
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
            rancher_name: r['Suggested Rancher Name'] || '',
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
