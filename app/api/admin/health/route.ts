import { NextResponse } from 'next/server';
import { getAllRecords, TABLES } from '@/lib/airtable';
import { requireAdmin } from '@/lib/adminAuth';
import { countHeldReferrals } from '@/lib/capacityCount';

// GET /api/admin/health
//
// Single-shot snapshot for /admin/health dashboard. Counts:
//   - Ranchers in each Onboarding Status bucket
//   - Ranchers stuck (signed but no Page Live)
//   - Multi-state approved counts
//   - Referrals by status (active + closed)
//   - Consumers without Buyer Stage (data drift)
//   - Orphan Pending Approval rows (should be zero)
//   - Capacity counter drift
//   - Live rancher per-state coverage + uncovered buyer demand
//
// Cheap: getAllRecords(RANCHERS) is cached 10s. Other table reads pay
// once per request — admin-only endpoint, called infrequently.

export const maxDuration = 60;

export async function GET(request: Request) {
  const __authResp = await requireAdmin(request);
  if (__authResp) return __authResp;

  const [ranchers, refs, consumers, cronRuns] = await Promise.all([
    getAllRecords(TABLES.RANCHERS) as Promise<any[]>,
    getAllRecords(TABLES.REFERRALS) as Promise<any[]>,
    getAllRecords(TABLES.CONSUMERS) as Promise<any[]>,
    (getAllRecords(TABLES.CRON_RUNS) as Promise<any[]>).catch(() => [] as any[]),
  ]);

  // Cron Runs — collapse to most-recent-per-name view.
  const byName: Record<string, { lastRun: string; status: string; durationMs: number; notes: string; recordsTouched: number }> = {};
  for (const r of cronRuns) {
    const name = (r['Name'] || '').toString();
    if (!name) continue;
    const startedAt = r['Started At'] || '';
    if (!byName[name] || startedAt > byName[name].lastRun) {
      byName[name] = {
        lastRun: startedAt,
        status: (r['Status'] || '').toString(),
        durationMs: Number(r['Duration ms'] || 0),
        notes: (r['Notes'] || '').toString().slice(0, 200),
        recordsTouched: Number(r['Records Touched'] || 0),
      };
    }
  }

  // Ranchers
  const byOnboarding: Record<string, number> = {};
  for (const r of ranchers) {
    const k = (r['Onboarding Status'] || '(empty)').toString();
    byOnboarding[k] = (byOnboarding[k] || 0) + 1;
  }
  const live = ranchers.filter((r) => r['Page Live'] === true && r['Active Status'] === 'Active');
  const stuck = ranchers.filter((r) => r['Agreement Signed'] === true && !r['Page Live']);
  const verifiedNotLive = ranchers.filter((r) => r['Verification Status'] === 'Verified' && !r['Page Live']);
  const multiStateApproved = ranchers.filter((r) => !!r['Admin Approved Multi-State']);

  // Referrals
  const byRefStatus: Record<string, number> = {};
  for (const r of refs) {
    const k = (r['Status'] || '(empty)').toString();
    byRefStatus[k] = (byRefStatus[k] || 0) + 1;
  }
  const orphanPending = refs.filter(
    (r) =>
      r['Status'] === 'Pending Approval' &&
      !(r['Rancher'] || []).length &&
      !(r['Suggested Rancher'] || []).length
  ).length;

  // Capacity drift
  let drift = 0;
  const driftDetails: Array<{ name: string; stored: number; actual: number }> = [];
  for (const r of ranchers) {
    if (!r['Page Live']) continue;
    // Canonical held count (lib/capacityCount) — the SAME rule the reconcilers
    // and the Redis bootstrap use, so this drift readout matches what they
    // compute (it previously used a different status set + counted Suggested
    // Rancher, so it reported "drift" that the reconcilers didn't see).
    const myActive = countHeldReferrals(r.id, refs);
    const stored = Number(r['Current Active Referrals'] || 0);
    if (myActive !== stored) {
      drift++;
      driftDetails.push({
        name: r['Operator Name'] || r['Ranch Name'] || '?',
        stored,
        actual: myActive,
      });
    }
  }

  // Consumers
  const byStage: Record<string, number> = {};
  for (const c of consumers) {
    const k = (c['Buyer Stage'] || '(empty)').toString();
    byStage[k] = (byStage[k] || 0) + 1;
  }
  const approvedNoStage = consumers.filter((c) => c['Status'] === 'Approved' && !c['Buyer Stage']).length;
  const totalApproved = consumers.filter((c) => c['Status'] === 'Approved').length;
  const yesClickers = consumers.filter((c) => !!c['Warmup Engaged At']).length;

  // State coverage vs demand
  const liveStates = new Set<string>();
  for (const r of live) {
    if (r['State']) liveStates.add(String(r['State']).toUpperCase());
    if (r['Admin Approved Multi-State']) {
      const routing = String(r['Routing States'] || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
      for (const s of routing) liveStates.add(s);
    }
  }
  const byBuyerState: Record<string, number> = {};
  for (const c of consumers) {
    if (c['Status'] !== 'Approved') continue;
    const s = String(c['State'] || '').trim().toUpperCase();
    if (!s) continue;
    byBuyerState[s] = (byBuyerState[s] || 0) + 1;
  }
  const uncoveredDemand = Object.entries(byBuyerState)
    .filter(([s]) => !liveStates.has(s))
    .map(([s, n]) => ({ state: s, buyers: n }))
    .sort((a, b) => b.buyers - a.buyers);
  const totalUncovered = uncoveredDemand.reduce((acc, x) => acc + x.buyers, 0);

  // Revenue
  const won = refs.filter((r) => r['Status'] === 'Closed Won');
  const totalRev = won.reduce((acc, r) => acc + Number(r['Sale Amount'] || 0), 0);
  const totalComm = won.reduce((acc, r) => acc + Number(r['Commission Due'] || 0), 0);
  const D = 86400000;
  const cutoff7 = Date.now() - 7 * D;
  // Was (c as any).createdTime — undefined after getAllRecords flatten, so the
  // counter was always 0. Now uses _createdTime metadata exposed by lib/airtable.
  const recentSignups = consumers.filter((c) => new Date((c as any)._createdTime || 0).getTime() > cutoff7).length;
  const recentWon = won.filter((r) => {
    const t = r['Closed At'];
    return t && new Date(t).getTime() > cutoff7;
  }).length;
  const activeRefs = (byRefStatus['Intro Sent'] || 0) + (byRefStatus['Rancher Contacted'] || 0) + (byRefStatus['Negotiation'] || 0);

  // Supabase Auth env presence — for diagnosing rancher password login (#98).
  // BOOLEANS + matched NAMES only, never the values. Mirrors the accept-both-
  // conventions logic in lib/supabaseAuth.ts so this reflects what the route
  // actually sees. configured=false ⇒ password routes 503 (magic-link unaffected).
  const supabaseAuth: Record<string, any> = {
    url_present: !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL),
    anon_present: !!(process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    service_role_present: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    url_name: process.env.SUPABASE_URL ? 'SUPABASE_URL' : process.env.NEXT_PUBLIC_SUPABASE_URL ? 'NEXT_PUBLIC_SUPABASE_URL' : null,
    anon_name: process.env.SUPABASE_ANON_KEY ? 'SUPABASE_ANON_KEY' : process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ? 'NEXT_PUBLIC_SUPABASE_ANON_KEY' : null,
  };
  supabaseAuth.configured = supabaseAuth.url_present && supabaseAuth.anon_present && supabaseAuth.service_role_present;

  // Stripe Connect rail env presence — the deposit rail AND the auto-activation
  // of rancher Connect status depend on these. STRIPE_CONNECT_WEBHOOK_SECRET
  // unset is the silent killer: a rancher finishes Stripe but never flips to
  // 'active' (stuck on 'onboarding') until someone clicks 🔄 Resync. Booleans
  // only, never the secret values.
  const connectRail: Record<string, any> = {
    connect_enabled: process.env.STRIPE_CONNECT_ENABLED === 'true',
    webhook_secret_present: !!process.env.STRIPE_CONNECT_WEBHOOK_SECRET,
    stripe_secret_present: !!process.env.STRIPE_SECRET_KEY,
  };
  connectRail.deposit_rail_ready =
    connectRail.connect_enabled && connectRail.webhook_secret_present && connectRail.stripe_secret_present;

  // Paid-tier subscription env presence — the Pasture/Ranch/Operator UPGRADE
  // depends on these. STRIPE_PASTURE_PRICE_ID unset → the Pasture checkout
  // THROWS (lib/stripeSubscription.ts:48) → rancher gets a 500 on upgrade.
  // STRIPE_WEBHOOK_SECRET (platform, NOT the Connect one) unset → subscription
  // lifecycle events (created/updated/payment_failed) silently 400 → the Tier
  // never flips to Pasture. Booleans only, never values.
  const tierSubs: Record<string, any> = {
    pasture_price_present: !!process.env.STRIPE_PASTURE_PRICE_ID,
    ranch_price_present: !!process.env.STRIPE_RANCH_PRICE_ID,
    operator_price_present: !!process.env.STRIPE_OPERATOR_PRICE_ID,
    platform_webhook_secret_present: !!process.env.STRIPE_WEBHOOK_SECRET,
  };
  tierSubs.pasture_upgrade_ready =
    tierSubs.pasture_price_present &&
    tierSubs.platform_webhook_secret_present &&
    connectRail.connect_enabled &&
    connectRail.stripe_secret_present;

  return NextResponse.json({
    generated_at: new Date().toISOString(),
    supabase_auth: supabaseAuth,
    connect_rail: connectRail,
    tier_subscriptions: tierSubs,
    ranchers: {
      total: ranchers.length,
      live: live.length,
      verifiedNotLive: verifiedNotLive.length,
      stuck_signed_not_live: stuck.length,
      stuck_signed_details: stuck.map((r) => ({
        id: r.id,
        name: r['Operator Name'] || r['Ranch Name'] || '?',
        email: r['Email'] || '',
        onboarding: r['Onboarding Status'] || '',
        verification: r['Verification Status'] || '',
        active_status: r['Active Status'] || '',
        slug: !!r['Slug'],
        about: !!r['About Text'],
        payment: !!(r['Quarter Payment Link'] || r['Half Payment Link'] || r['Whole Payment Link']),
      })),
      multistate_approved: multiStateApproved.length,
      by_onboarding: byOnboarding,
    },
    referrals: {
      total: refs.length,
      active: activeRefs,
      by_status: byRefStatus,
      orphan_pending: orphanPending,
      counter_drift_ranchers: drift,
      counter_drift_details: driftDetails,
    },
    consumers: {
      total: consumers.length,
      approved: totalApproved,
      approved_no_stage: approvedNoStage,
      yes_click_total: yesClickers,
      by_stage: byStage,
    },
    coverage: {
      live_states: [...liveStates].sort(),
      uncovered_demand: uncoveredDemand,
      total_uncovered_buyers: totalUncovered,
    },
    revenue: {
      won_total: won.length,
      gross_sales: totalRev,
      commission_earned: totalComm,
      won_last_7d: recentWon,
      new_signups_7d: recentSignups,
    },
    crons: byName,
  });
}
