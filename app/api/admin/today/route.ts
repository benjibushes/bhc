import { NextResponse } from 'next/server';
import { getAllRecords, TABLES } from '@/lib/airtable';
import { requireAdmin } from '@/lib/adminAuth';
import { isRancherOperationalForBuyers } from '@/lib/rancherEligibility';
import { getAdminConfig } from '@/lib/adminConfig';

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
    // Load operator config first (never throws — falls back to defaults)
    const adminCfg = await getAdminConfig();

    let referrals: any[] = [];
    let consumers: any[] = [];
    let ranchers: any[] = [];
    let inquiries: any[] = [];
    const fetchErrors: string[] = [];
    try { referrals = await getAllRecords(TABLES.REFERRALS) as any[]; }
    catch (e: any) { fetchErrors.push(`Referrals: ${e?.message || 'unknown'}`); console.error('Today/Referrals fetch:', e); }
    try { consumers = await getAllRecords(TABLES.CONSUMERS) as any[]; }
    catch (e: any) { fetchErrors.push(`Consumers: ${e?.message || 'unknown'}`); console.error('Today/Consumers fetch:', e); }
    try { ranchers = await getAllRecords(TABLES.RANCHERS) as any[]; }
    catch (e: any) { fetchErrors.push(`Ranchers: ${e?.message || 'unknown'}`); console.error('Today/Ranchers fetch:', e); }
    // Inquiries fetch is non-fatal for the rest of the dashboard — if it
    // fails, wholesale category just renders as 0 with a soft warning in
    // fetchErrors instead of nuking referrals/consumers cards.
    try { inquiries = await getAllRecords(TABLES.INQUIRIES) as any[]; }
    catch (e: any) { fetchErrors.push(`Inquiries: ${e?.message || 'unknown'}`); console.error('Today/Inquiries fetch:', e); }
    if (fetchErrors.length >= 3 && referrals.length === 0 && consumers.length === 0 && ranchers.length === 0) {
      // Core reads all failed — definitely a DB connectivity issue, fail loudly
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

    // Stalled — Intro Sent for more than adminCfg.stallThresholdDays, not yet closed.
    // Threshold is operator-tunable via /admin/settings (default: 5 days).
    const stalled = referrals.filter((r: any) => {
      if (str(r['Status']) !== 'Intro Sent') return false;
      const t = r['Intro Sent At'] || r['Approved At'];
      if (!t) return false;
      return (now - new Date(t).getTime()) >= adminCfg.stallThresholdDays * DAY;
    });

    // Unpaid commissions — Closed Won, Commission Paid = false, sorted by oldest
    const unpaid = referrals.filter((r: any) =>
      str(r['Status']) === 'Closed Won' && !r['Commission Paid']
    );
    const unpaidTotal = unpaid.reduce((s: number, r: any) => s + (Number(r['Commission Due']) || 0), 0);

    // High-intent buyers who are Waitlisted/Unmatched (ready to route if rancher appears).
    // Cutoff is operator-tunable via /admin/settings (default: 70).
    const highIntentWaiting = consumers.filter((c: any) => {
      const refStatus = str(c['Referral Status']);
      if (refStatus !== 'Waitlisted' && refStatus !== 'Unmatched') return false;
      if (c['Unsubscribed'] || c['Bounced']) return false;
      return (Number(c['Intent Score']) || 0) >= adminCfg.highIntentCutoff;
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

    // ── Wholesale inquiries needing action ──────────────────────────────
    // Wholesale rows live in the Inquiries table with Interest Type='Wholesale'.
    // We surface anything not yet terminal so the operator sees the full
    // active queue at a glance — "New" rows are the highest priority
    // (haven't been matched yet) and the count drives the urgency dot.
    const wholesaleAll = inquiries.filter((i: any) => str(i['Interest Type']) === 'Wholesale');
    const wholesaleNew = wholesaleAll.filter((i: any) => str(i['Status']) === 'New');
    const wholesaleActive = wholesaleAll.filter((i: any) => {
      const s = str(i['Status']);
      return s !== 'Closed Won' && s !== 'Closed Lost';
    });
    // Parse "State: TX" out of the structured Notes payload — best signal
    // we have for buyer location until the schema adds a clean column.
    const parseWholesaleState = (notes: any): string => {
      if (!notes) return '';
      const m = String(notes).match(/^State:\s*(.+)$/m);
      return m ? m[1].trim() : '';
    };

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
        // Wholesale funnel — "new" is the urgent count (unmatched applicants),
        // "active" is the broader work-in-progress queue ($5-15k AOV deals
        // that haven't terminally won/lost yet).
        wholesaleNew: wholesaleNew.length,
        wholesaleActive: wholesaleActive.length,
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
          // Emit so the drawer's Resume / Resync-Connect affordances can render
          // for a paused or Connect-stuck rancher sitting in the go-live queue.
          active_status: str(r['Active Status']),
          stripe_connect_status: str(r['Stripe Connect Status']),
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
        // Wholesale samples — newest-first so freshly-arrived applicants
        // don't get buried under stale rows. We surface "active" (not yet
        // terminally closed) instead of just "new" so admin sees in-flight
        // deals too (Routed/Quoted) and can chase a stalled quote.
        wholesaleActive: sample(
          wholesaleActive.sort((a: any, b: any) =>
            new Date(b['Created'] || b._createdTime || 0).getTime() - new Date(a['Created'] || a._createdTime || 0).getTime()
          ),
          5,
          (i: any) => ({
            id: i.id,
            business_name: i['Ranch Name'] || '(unknown)',
            contact_name: i['Consumer Name'] || '',
            state: parseWholesaleState(i['Notes']),
            status: str(i['Status']) || 'New',
            created_at: i['Created'] || i._createdTime || '',
          })
        ),
      },
    });
  } catch (error: any) {
    console.error('Today endpoint error:', error);
    return NextResponse.json({ error: error.message || 'Failed to load today dashboard' }, { status: 500 });
  }
}
