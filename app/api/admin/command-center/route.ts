// app/api/admin/command-center/route.ts
//
// Phase 2 — Admin "Command Center" aggregator. READ-ONLY, BUILD-DARK-SAFE.
//
// This is a RE-ORG/compose of data that already powers the existing admin
// endpoints — it does NOT introduce a new data pipeline. It reads the same
// Airtable tables (Consumers / Ranchers / Referrals / Payments / Funnel
// Events / Conversations / Email Sends) and applies the SAME field logic the
// detail endpoints use, then returns a single lifeblood overview shaped for
// the top of /admin.
//
// Composes the logic of:
//   - /api/admin/referrals/stats   (pipeline, closed-this-month, commission, stalled)
//   - /api/admin/analytics         (per-Source breakdown + blended ROAS via ad spend)
//   - /api/admin/funnel-conversion (state-snapshot per-stage funnel)
//   - /api/admin/payments/data     (deposits collected vs outstanding)
//   - /api/admin/deliverability    (inbound replies + Resend config flags)
//   - /api/admin/cal/bookings      (calls booked — Cal config flag)
//   - lib/rancherEligibility       ("where to unlock" demand-vs-supply cross)
//
// CONTRACT: every section is independently fail-soft. A failed read degrades
// THAT section to `null` (the client renders a soft "unavailable" note) — it
// never throws and never 500s the whole overview. The only hard failure is an
// auth rejection.

import { NextResponse } from 'next/server';
import { getAllRecords, TABLES } from '@/lib/airtable';
import { requireAdmin } from '@/lib/adminAuth';
import { getAdminConfig } from '@/lib/adminConfig';
import { getMaxActiveReferrals } from '@/lib/rancherCapacity';
import {
  isRancherOperationalForBuyers,
  getOperationalServedStates,
} from '@/lib/rancherEligibility';
import { getSpendInRange } from '@/lib/adSpend';
import { normalizeState } from '@/lib/states';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const FUNNEL_TABLE = 'Funnel Events';

const str = (v: any): string => (v == null ? '' : typeof v === 'object' && 'name' in v ? String(v.name ?? '') : String(v));
const num = (v: any): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round2 = (n: number): number => Math.round(n * 100) / 100;

export async function GET(request: Request) {
  const authResp = await requireAdmin(request);
  if (authResp) return authResp;

  // Operator config (stall threshold, high-intent cutoff). Never throws.
  const cfg = await getAdminConfig();

  // ── Core table reads. Each is independent + non-fatal so one bad read
  //    only nulls the sections that depend on it. ──────────────────────────
  const safe = async <T>(fn: () => Promise<T>, label: string): Promise<T | null> => {
    try {
      return await fn();
    } catch (e: any) {
      console.warn(`[command-center] ${label} read failed:`, e?.message);
      return null;
    }
  };

  const [consumers, ranchers, referrals, payments, funnelEvents, conversations] = await Promise.all([
    safe(() => getAllRecords(TABLES.CONSUMERS) as Promise<any[]>, 'consumers'),
    safe(() => getAllRecords(TABLES.RANCHERS) as Promise<any[]>, 'ranchers'),
    safe(() => getAllRecords(TABLES.REFERRALS) as Promise<any[]>, 'referrals'),
    safe(() => getAllRecords(TABLES.PAYMENTS) as Promise<any[]>, 'payments'),
    safe(() => getAllRecords(FUNNEL_TABLE) as Promise<any[]>, 'funnelEvents'),
    safe(() => getAllRecords(TABLES.CONVERSATIONS) as Promise<any[]>, 'conversations'),
  ]);

  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();

  // ════════════════════════════════════════════════════════════════════════
  // 1. MONEY — pipeline $, deposits, closed-this-month, commission, ROAS
  // ════════════════════════════════════════════════════════════════════════
  let money: any = null;
  try {
    if (referrals) {
      // Open/active referrals (mirror analytics route's "active" definition).
      const active = referrals.filter(
        (r: any) => !['Closed Won', 'Closed Lost', 'Dormant'].includes(str(r['Status'])),
      );
      const openPipelineRevenue = active.reduce((s: number, r: any) => s + num(r['Sale Amount']), 0);
      const openPipelineCount = active.length;

      // Closed Won this month (mirror referrals/stats).
      const closedThisMonth = referrals.filter((r: any) => {
        if (str(r['Status']) !== 'Closed Won') return false;
        const t = r['Closed At'];
        return t && new Date(t).getTime() >= startOfMonth;
      });
      const closedThisMonthRevenue = closedThisMonth.reduce((s: number, r: any) => s + num(r['Sale Amount']), 0);

      // Commission earned vs unpaid (all Closed Won, not just this month).
      const closedWonAll = referrals.filter((r: any) => str(r['Status']) === 'Closed Won');
      const commissionEarned = closedWonAll.reduce((s: number, r: any) => s + num(r['Commission Due']), 0);
      const commissionUnpaid = closedWonAll
        .filter((r: any) => !r['Commission Paid'])
        .reduce((s: number, r: any) => s + num(r['Commission Due']), 0);

      // Deposits collected vs outstanding (Payments table — same fields as
      // /api/admin/payments/data). Collected = succeeded; outstanding =
      // pending (invoice sent, not yet paid). Refunded/abandoned excluded.
      let depositsCollected: number | null = null;
      let depositsOutstanding: number | null = null;
      let depositsCollectedCount: number | null = null;
      let depositsOutstandingCount: number | null = null;
      if (payments) {
        const succeeded = payments.filter((p: any) => str(p['Status']) === 'succeeded');
        const pending = payments.filter((p: any) => str(p['Status']) === 'pending');
        // Net of any partial refunds, in dollars.
        depositsCollected = round2(
          succeeded.reduce(
            (s: number, p: any) => s + (num(p['Amount Cents']) - num(p['Refunded Amount Cents'])) / 100,
            0,
          ),
        );
        depositsOutstanding = round2(pending.reduce((s: number, p: any) => s + num(p['Amount Cents']) / 100, 0));
        depositsCollectedCount = succeeded.length;
        depositsOutstandingCount = pending.length;
      }

      // Blended ROAS — BHC commission / ad spend (same as analytics route).
      // null when no spend logged (don't fabricate a ratio).
      let blendedRoas: number | null = null;
      let adSpend: number | null = null;
      try {
        const spend = await getSpendInRange(0); // all-time
        adSpend = round2(spend.total);
        blendedRoas = spend.total > 0 ? round2(commissionEarned / spend.total) : null;
      } catch (e: any) {
        console.warn('[command-center] ad spend read failed:', e?.message);
      }

      money = {
        openPipelineRevenue: round2(openPipelineRevenue),
        openPipelineCount,
        depositsCollected,
        depositsOutstanding,
        depositsCollectedCount,
        depositsOutstandingCount,
        closedThisMonthRevenue: round2(closedThisMonthRevenue),
        closedThisMonthCount: closedThisMonth.length,
        commissionEarned: round2(commissionEarned),
        commissionUnpaid: round2(commissionUnpaid),
        blendedRoas,
        adSpend,
      };
    }
  } catch (e: any) {
    console.warn('[command-center] money section failed:', e?.message);
    money = null;
  }

  // ════════════════════════════════════════════════════════════════════════
  // 2. FUNNEL — per-stage counts + conversion %, biggest drop-off
  //    Prefer the state-snapshot model (funnel-conversion) — it derives from
  //    existing Airtable state and is populated today, vs the Funnel Events
  //    log which is empty until the events table fills.
  // ════════════════════════════════════════════════════════════════════════
  let funnel: any = null;
  try {
    if (consumers && referrals) {
      const approved = consumers.filter((c: any) => str(c['Status']) === 'Approved');
      // Distinct buyers that have a referral = "matched". Real + populated.
      const matchedBuyers = new Set(
        referrals.flatMap((r: any) => (Array.isArray(r['Buyer']) ? r['Buyer'] : [])).filter(Boolean),
      ).size;
      // Stages kept to fields that actually carry data today, so conversion %
      // stays honest + monotonic. "Call Booked" (Sales Call Booked At) is dead
      // until the Cal sales-event webhook is wired; "Deposit" can't be counted
      // cumulatively until the deposit rail settles a live payment (Payments
      // table populates) — both would render a fake cliff / >100% step. Re-add
      // a Deposit stage sourced from Payments once deposits flow.
      const stages = [
        { key: 'signup', label: 'Signup', count: approved.length },
        { key: 'qualified', label: 'Qualified', count: approved.filter((c: any) => c['Qualified At']).length },
        { key: 'matched', label: 'Matched', count: matchedBuyers },
        { key: 'closed', label: 'Closed Won', count: referrals.filter((r: any) => str(r['Status']) === 'Closed Won').length },
      ];

      // Step conversion % + biggest drop-off (largest absolute count lost
      // between two adjacent non-zero stages).
      let biggestDrop: { from: string; to: string; lostPct: number; lost: number } | null = null;
      const withRates = stages.map((st, i) => {
        if (i === 0) return { ...st, convFromPrev: null as number | null };
        const prev = stages[i - 1].count;
        const rate = prev > 0 ? Math.round((st.count / prev) * 1000) / 10 : null;
        if (prev > 0) {
          const lost = prev - st.count;
          const lostPct = Math.round(((prev - st.count) / prev) * 1000) / 10;
          if (lost > 0 && (!biggestDrop || lost > biggestDrop.lost)) {
            biggestDrop = { from: stages[i - 1].label, to: st.label, lostPct, lost };
          }
        }
        return { ...st, convFromPrev: rate };
      });

      const overall =
        stages[0].count > 0
          ? Math.round((stages[stages.length - 1].count / stages[0].count) * 1000) / 10
          : null;

      funnel = { stages: withRates, overallSignupToClosed: overall, biggestDrop };
    }
  } catch (e: any) {
    console.warn('[command-center] funnel section failed:', e?.message);
    funnel = null;
  }
  // Note: funnelEvents is read for parity/future use; the snapshot model above
  // is the live source. Reference it so it isn't flagged unused.
  void funnelEvents;

  // ════════════════════════════════════════════════════════════════════════
  // 3. CHANNEL — top Sources: signups → closes → commission → ROAS
  //    Mirrors the per-Source breakdown in /api/admin/analytics.
  // ════════════════════════════════════════════════════════════════════════
  let channel: any = null;
  try {
    if (consumers && referrals) {
      type Row = { source: string; signups: number; closes: number; commission: number; saleRevenue: number };
      const map = new Map<string, Row>();
      const bucket = (k: string): Row => {
        if (!map.has(k)) map.set(k, { source: k, signups: 0, closes: 0, commission: 0, saleRevenue: 0 });
        return map.get(k)!;
      };
      const sourceByConsumerId = new Map<string, string>();
      consumers.forEach((c: any) => {
        const sourceRaw = str(c['Source']).trim() || 'organic';
        bucket(sourceRaw).signups++;
        if (c.id) sourceByConsumerId.set(c.id, sourceRaw);
      });
      referrals.forEach((r: any) => {
        if (str(r['Status']) !== 'Closed Won') return;
        const buyerIds = r['Buyer'] || [];
        const buyerId = Array.isArray(buyerIds) ? buyerIds[0] : null;
        const source = buyerId ? sourceByConsumerId.get(buyerId) : null;
        if (!source) return;
        const b = bucket(source);
        b.closes++;
        b.commission += num(r['Commission Due']);
        b.saleRevenue += num(r['Sale Amount']);
      });

      // Join ad spend → per-source ROAS.
      let bySpend = new Map<string, number>();
      try {
        const spend = await getSpendInRange(0);
        bySpend = spend.bySource;
      } catch (e: any) {
        console.warn('[command-center] channel ad spend read failed:', e?.message);
      }

      const rows = Array.from(map.values())
        .map((s) => {
          const sp = bySpend.get(s.source.trim().toLowerCase()) || 0;
          return {
            source: s.source,
            signups: s.signups,
            closes: s.closes,
            commission: round2(s.commission),
            spend: round2(sp),
            roas: sp > 0 ? round2(s.commission / sp) : null,
          };
        })
        .sort((a, b) => b.commission - a.commission || b.signups - a.signups);

      // Best/worst by commission among sources that produced at least one close;
      // if none have closes, fall back to signups so the operator still sees
      // the dominant top-of-funnel channel.
      const withCloses = rows.filter((r) => r.closes > 0);
      const ranked = withCloses.length > 0 ? withCloses : [...rows].sort((a, b) => b.signups - a.signups);
      const best = ranked[0]?.source ?? null;
      const worst = ranked.length > 1 ? ranked[ranked.length - 1].source : null;

      channel = { sources: rows.slice(0, 8), best, worst };
    }
  } catch (e: any) {
    console.warn('[command-center] channel section failed:', e?.message);
    channel = null;
  }

  // ════════════════════════════════════════════════════════════════════════
  // 4. TOUCHPOINTS — email opens/clicks, calls booked, inbound replies
  //    CRITICAL: several of these read fields that stay EMPTY until the
  //    operator finishes webhook config. We emit an explicit `configured`
  //    flag per metric so the client renders a config HINT instead of a
  //    misleading "0".
  // ════════════════════════════════════════════════════════════════════════
  let touchpoints: any = null;
  try {
    // Email open/click tracking is stamped on Email Sends by the Resend
    // webhook, which only fires when RESEND_WEBHOOK_SECRET is set. Gate the
    // metric on that env flag — this is the same flag /api/admin/deliverability
    // exposes as `eventsConfigured`.
    const emailEventsConfigured = !!process.env.RESEND_WEBHOOK_SECRET;
    let emailOpens: number | null = null;
    let emailClicks: number | null = null;
    let emailDelivered: number | null = null;
    if (emailEventsConfigured) {
      // Only read the table when tracking is actually on — otherwise it's all
      // zero by definition and we'd be paying for a needless full-table scan.
      const sends = await safe(() => getAllRecords(TABLES.EMAIL_SENDS) as Promise<any[]>, 'emailSends');
      if (sends) {
        emailDelivered = sends.filter((s: any) => s['Delivered At']).length;
        emailOpens = sends.filter((s: any) => s['Opened At']).length;
        emailClicks = sends.filter((s: any) => s['Clicked At']).length;
      }
    }

    // Inbound replies — from Conversations (Direction=inbound). Gated on
    // RESEND_INBOUND_WEBHOOK_SECRET (deliverability's `inboundConfigured`).
    const inboundConfigured = !!process.env.RESEND_INBOUND_WEBHOOK_SECRET;
    let inboundTotal: number | null = null;
    let inboundLast24h: number | null = null;
    if (inboundConfigured && conversations) {
      const inbound = conversations.filter((c: any) => str(c['Direction']).toLowerCase() === 'inbound');
      inboundTotal = inbound.length;
      const dayAgo = now - DAY;
      inboundLast24h = inbound.filter((c: any) => {
        const t = Date.parse(str(c['Timestamp']));
        return !Number.isNaN(t) && t >= dayAgo;
      }).length;
    }

    // Calls booked — Cal sales-event webhook stamps `Sales Call Booked At` on
    // Referrals. Gate on CAL_API_KEY (same env the cal/bookings route checks).
    // "Done" = booked call whose time is in the past.
    const calConfigured = !!process.env.CAL_API_KEY;
    let callsBooked: number | null = null;
    let callsDone: number | null = null;
    if (calConfigured && referrals) {
      const booked = referrals.filter((r: any) => r['Sales Call Booked At']);
      callsBooked = booked.length;
      callsDone = booked.filter((r: any) => {
        const t = Date.parse(str(r['Sales Call Booked At']));
        return !Number.isNaN(t) && t < now;
      }).length;
    }

    touchpoints = {
      email: {
        // "Configured" only when events are actually FLOWING (delivered > 0) —
        // not merely when the secret is set. Open/click tracking can be off in
        // Resend even with the webhook secret present, which would otherwise
        // show a misleading "0 opens" instead of the config hint.
        configured: emailEventsConfigured && (emailDelivered || 0) > 0,
        opens: emailOpens,
        clicks: emailClicks,
        delivered: emailDelivered,
        hint: 'enable Resend open/click tracking to populate',
      },
      inbound: {
        configured: inboundConfigured,
        total: inboundTotal,
        last24h: inboundLast24h,
        hint: 'enable Resend inbound webhook to populate',
      },
      calls: {
        configured: calConfigured,
        booked: callsBooked,
        done: callsDone,
        hint: 'enable Cal sales-event webhook to populate',
      },
    };
  } catch (e: any) {
    console.warn('[command-center] touchpoints section failed:', e?.message);
    touchpoints = null;
  }

  // ════════════════════════════════════════════════════════════════════════
  // 5. WHERE TO UNLOCK — demand w/o supply, stalled ranchers, near-capacity
  // ════════════════════════════════════════════════════════════════════════
  let unlock: any = null;
  try {
    if (consumers && ranchers) {
      // (a) States with qualified buyer demand but NO operational rancher.
      //     "Qualified" mirrors the funnel: Approved + Qualified At. Cross the
      //     buyer-state demand against operational rancher coverage
      //     (isRancherOperationalForBuyers + getOperationalServedStates).
      const coveredStates = new Set<string>();
      ranchers.forEach((r: any) => {
        if (!isRancherOperationalForBuyers(r)) return;
        getOperationalServedStates(r).forEach((s) => coveredStates.add(s));
      });
      const demandByState: Record<string, number> = {};
      consumers.forEach((c: any) => {
        const qualified = str(c['Status']) === 'Approved' && !!c['Qualified At'];
        if (!qualified) return;
        const stNorm = normalizeState(c['State']);
        if (!stNorm) return;
        demandByState[stNorm] = (demandByState[stNorm] || 0) + 1;
      });
      const uncoveredDemand = Object.entries(demandByState)
        .filter(([state]) => !coveredStates.has(state))
        .map(([state, qualifiedBuyers]) => ({ state, qualifiedBuyers }))
        .sort((a, b) => b.qualifiedBuyers - a.qualifiedBuyers)
        .slice(0, 8);

      // (b) Ranchers stalled — operationally live but 0 active referrals
      //     (idle capacity). Mirrors /api/admin/today "underused".
      const stalledRanchers = ranchers
        .filter((r: any) => isRancherOperationalForBuyers(r) && num(r['Current Active Referrals']) === 0)
        .map((r: any) => ({
          id: r.id,
          name: str(r['Operator Name']) || str(r['Ranch Name']) || 'Unknown',
          state: str(r['State']),
        }))
        .slice(0, 8);

      // (c) Capacity nearly full — operational ranchers at >= 80% of max
      //     active referrals (recruit backfill before they cap out).
      const nearCapacity = ranchers
        .filter((r: any) => {
          if (!isRancherOperationalForBuyers(r)) return false;
          const max = getMaxActiveReferrals(r);
          const cur = num(r['Current Active Referrals']);
          return max > 0 && cur > 0 && cur / max >= 0.8;
        })
        .map((r: any) => ({
          id: r.id,
          name: str(r['Operator Name']) || str(r['Ranch Name']) || 'Unknown',
          state: str(r['State']),
          current: num(r['Current Active Referrals']),
          max: getMaxActiveReferrals(r),
        }))
        .sort((a, b) => b.current / b.max - a.current / a.max)
        .slice(0, 8);

      unlock = { uncoveredDemand, stalledRanchers, nearCapacity };
    }
  } catch (e: any) {
    console.warn('[command-center] unlock section failed:', e?.message);
    unlock = null;
  }

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    config: { stallThresholdDays: cfg.stallThresholdDays, highIntentCutoff: cfg.highIntentCutoff },
    money,
    funnel,
    channel,
    touchpoints,
    unlock,
  });
}
