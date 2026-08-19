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
import { adminSnapshotTable } from '@/lib/adminSnapshot';
import { requireAdmin } from '@/lib/adminAuth';
import { getAdminConfig } from '@/lib/adminConfig';
import { getMaxActiveReferrals } from '@/lib/rancherCapacity';
import {
  isRancherOperationalForBuyers,
  getOperationalServedStates,
} from '@/lib/rancherEligibility';
import { getSpendInRange } from '@/lib/adSpend';
import { normalizeState } from '@/lib/states';
import {
  legacyClosedWon,
  computeConnectFeeCaptured,
  countConnectFeePayments,
  computeProductMargin,
} from '@/lib/commissionStats';
import { selectOwedDepositPayments } from '@/lib/owedDeposits';
import {
  computeBhcRevenue,
  revenueCoverageNote,
  REVENUE_RAILS,
  REVENUE_RAIL_LABELS,
  UNMEASURED_REVENUE_RAILS,
} from '@/lib/bhcRevenue';

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

  // Scale audit 2026-07-07: the Funnel Events full scan was DEAD WEIGHT —
  // the funnel section uses the state-snapshot model and the read ended in
  // `void funnelEvents;`. Dropping it cut ~16 paginated requests per open.
  //
  // Airtable diet 2026-07-28: all six reads now ride lib/adminSnapshot
  // (module-scope + shared-Redis, 3-min TTL) — health / analytics /
  // referrals-stats scan the same big tables, so the whole admin surface now
  // shares ONE set of scans per TTL window instead of 4-5 independent ones.
  const [consumers, ranchers, referrals, payments, conversations, rancherOrders, brands] =
    await Promise.all([
      safe(() => adminSnapshotTable(TABLES.CONSUMERS) as Promise<any[]>, 'consumers'),
      safe(() => adminSnapshotTable(TABLES.RANCHERS) as Promise<any[]>, 'ranchers'),
      safe(() => adminSnapshotTable(TABLES.REFERRALS) as Promise<any[]>, 'referrals'),
      safe(() => adminSnapshotTable(TABLES.PAYMENTS) as Promise<any[]>, 'payments'),
      safe(() => adminSnapshotTable(TABLES.CONVERSATIONS) as Promise<any[]>, 'conversations'),
      safe(() => adminSnapshotTable(TABLES.RANCHER_ORDERS) as Promise<any[]>, 'rancherOrders'),
      // Brand-partner rail — same shared snapshot, no new pipeline. Needed so
      // this screen's revenue total covers the same rails /admin/today's does.
      safe(() => adminSnapshotTable(TABLES.BRANDS) as Promise<any[]>, 'brands'),
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

      // LEGACY commission earned vs unpaid (all Closed Won, not just this
      // month) — RAIL-AWARE since 2026-07-24. `Commission Due`/`Commission
      // Paid` exist only on the deprecated "rancher owes BHC 10%, invoiced
      // monthly after close" rail. A Connect close had its fee ADDED to the
      // buyer and captured at deposit via application_fee, so it owes nothing;
      // summing it here showed the founder a receivable Stripe already banked
      // while the rancher dashboard (same rail filter) called it settled.
      // Connect-rail revenue is its own figure below — never folded in here.
      const closedWonAll = legacyClosedWon(referrals as any[]);
      const commissionEarned = closedWonAll.reduce((s: number, r: any) => s + num(r['Commission Due']), 0);
      const commissionUnpaid = closedWonAll
        .filter((r: any) => !r['Commission Paid'])
        .reduce((s: number, r: any) => s + num(r['Commission Due']), 0);

      // Deposits collected vs outstanding (Payments table — same fields as
      // /api/admin/payments/data). Collected = succeeded.
      //
      // OUTSTANDING — ONE SHARED RULE (money-truth audit, 2026-08-19). This was
      // a raw `pending || abandoned` reduce with no settled check and no retry
      // dedupe, so it counted a referral that had SINCE PAID and counted every
      // failed checkout attempt separately. Live: $3,750 across 6 rows here
      // against /admin/today's corrected $500 across 1 — the same table, 7.5x
      // apart, with nothing on either screen explaining the gap. Both screens
      // now call lib/owedDeposits.selectOwedDepositPayments, whose rule is
      // written once and unit-tested against these very rows.
      //
      // The REFERRAL side of the ask (Awaiting Payment, deposit not landed) is
      // added here too, exactly as /admin/today adds it, so "outstanding" means
      // the same thing on both screens.
      let depositsCollected: number | null = null;
      let depositsOutstanding: number | null = null;
      let depositsCollectedCount: number | null = null;
      let depositsOutstandingCount: number | null = null;
      if (payments) {
        const succeeded = payments.filter((p: any) => str(p['Status']) === 'succeeded');
        // Net of any partial refunds, in dollars.
        depositsCollected = round2(
          succeeded.reduce(
            (s: number, p: any) => s + (num(p['Amount Cents']) - num(p['Refunded Amount Cents'])) / 100,
            0,
          ),
        );
        depositsCollectedCount = succeeded.length;

        const awaitingUnpaid = (referrals as any[]).filter(
          (r: any) => str(r['Status']) === 'Awaiting Payment' && !r['Deposit Paid At'],
        );
        const awaitingUnpaidIds = new Set(awaitingUnpaid.map((r: any) => String(r.id)));
        const openRows = selectOwedDepositPayments(
          payments as any[],
          referrals as any[],
          awaitingUnpaidIds,
        );
        depositsOutstanding = round2(
          awaitingUnpaid.reduce((s: number, r: any) => s + num(r['Deposit Amount']), 0) +
            openRows.reduce((s: number, p: any) => s + num(p['Amount Cents']) / 100, 0),
        );
        depositsOutstandingCount = awaitingUnpaid.length + openRows.length;
      }

      // CONNECT-RAIL FEE REVENUE — the half of BHC's income that does not
      // exist in Referrals. It's the marketplace fee added on top of the
      // buyer's price and taken atomically at deposit, persisted as
      // Payments['Platform Fee Cents']. Reuses the Payments read already
      // performed above for deposits — no extra table scan.
      const connectFeeCaptured = payments ? computeConnectFeeCaptured(payments as any[]) : null;
      const connectFeeCount = payments ? countConnectFeePayments(payments as any[]) : null;

      // Blended ROAS — BHC revenue / ad spend. The numerator must span BOTH
      // rails: legacy invoiced commission PLUS Connect fees captured at
      // deposit. Pre-2026-07-24 it used the (unfiltered) Commission Due sum
      // alone, which is now legacy-only — leaving it there would understate
      // ROAS by every dollar Connect earns, and worsen as Connect scales.
      // null when no spend logged (don't fabricate a ratio).
      let blendedRoas: number | null = null;
      let adSpend: number | null = null;

      // Product rail (Rancher Orders — the low-ticket shop). The money view
      // was blind to this rail: shop sales counted nowhere on /admin. Fields
      // come from lib/productSettlement.ts (Buyer Paid / BHC Margin dollars,
      // Status New → Shipped). null when the table read failed.
      let productOrders: number | null = null;
      let productRevenue: number | null = null;
      let productMarginBHC: number | null = null;
      let productUnshipped: number | null = null;
      let productOrdersThisMonth: number | null = null;
      if (rancherOrders) {
        productOrders = rancherOrders.length;
        productRevenue = round2(rancherOrders.reduce((s: number, o: any) => s + num(o['Buyer Paid']), 0));
        // Shared helper (lib/commissionStats) — same math the /admin/today
        // cockpit uses, so the two surfaces can never disagree on shop margin.
        productMarginBHC = computeProductMargin(rancherOrders as any[]);
        productUnshipped = rancherOrders.filter((o: any) => str(o['Status']) === 'New').length;
        productOrdersThisMonth = rancherOrders.filter((o: any) => {
          const t = o['Ordered At'];
          return t && new Date(t).getTime() >= startOfMonth;
        }).length;
      }

      // BHC REVENUE — ONE SHARED DEFINITION (money-truth audit, 2026-08-19).
      //
      // History: this was `commissionEarned + connectFeeCaptured` labelled "all
      // rails" (it omitted shop margin), then a hand-rolled three-way split
      // here — while /admin/today totalled a DIFFERENT pair and the analytics
      // route a THIRD. Five live definitions of one number, none of which named
      // its rails on screen.
      //
      // lib/bhcRevenue is now the authority for both admin screens: it names
      // every rail it counts (Connect fee, broker deposit, shop margin, legacy
      // commission, founders, brand partners), keeps a rail at `null` rather
      // than 0 when its table failed to read, and ships the list of rails that
      // take money with NO amount recorded in Airtable so "all rails" is never
      // read as "all money". The current/legacy split below is preserved — Ben
      // uses it to separate live-model income from the deprecated receivable —
      // but it is now DERIVED from the shared breakdown, not recomputed.
      const revenue = computeBhcRevenue(
        { payments, rancherOrders, referrals, consumers, brands },
        () => true, // all-time
      );
      const railDollars = (rail: (typeof REVENUE_RAILS)[number]) => revenue.byRail[rail] ?? 0;
      const bhcRevenueCurrentRails = round2(
        railDollars('connectFee') +
          railDollars('brokerDeposit') +
          railDollars('shopMargin') +
          railDollars('founders') +
          railDollars('brandPartner'),
      );
      const bhcRevenueLegacyRail = round2(railDollars('legacyCommission'));
      const bhcRevenueAllRails = revenue.total;
      try {
        const spend = await getSpendInRange(0); // all-time
        adSpend = round2(spend.total);
        blendedRoas = spend.total > 0 ? round2(bhcRevenueAllRails / spend.total) : null;
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
        // LEGACY rail only — the pre-Connect invoice-after-close receivable.
        commissionEarned: round2(commissionEarned),
        commissionUnpaid: round2(commissionUnpaid),
        // CONNECT rail — marketplace fee captured at deposit (Payments).
        // null ⇒ Payments read failed; render "—", never $0.
        connectFeeCaptured,
        connectFeeCount,
        // What BHC earns on the models it sells today: Connect fee + broker
        // deposit + shop margin + founders + brand partners.
        bhcRevenueCurrentRails,
        // The deprecated invoice-after-close receivable, shown separately so
        // it can never be mistaken for current-rail earnings.
        bhcRevenueLegacyRail,
        // EVERY measurable rail — what ROAS is measured against, and the same
        // definition /admin/today's "Earned" uses (lib/bhcRevenue).
        bhcRevenueAllRails,
        // Per-rail breakdown + provenance. null on a rail ⇒ its table failed to
        // read, so the total is a FLOOR — the screen says so rather than render
        // a confident number that quietly lost a rail.
        bhcRevenueByRail: revenue.byRail,
        bhcRevenueRails: REVENUE_RAILS.map((rail) => ({ rail, label: REVENUE_RAIL_LABELS[rail] })),
        bhcRevenueCoverage: revenueCoverageNote(revenue),
        bhcRevenueComplete: revenue.complete,
        bhcRevenueOmits: UNMEASURED_REVENUE_RAILS,
        // Legacy commission BILLED but not collected — outside the revenue
        // total on purpose (money owed to BHC, not money BHC has).
        legacyReceivable: revenue.legacyReceivable,
        legacyReceivableCoverage:
          'Closed Won legacy-rail referrals whose Commission Paid is not true — billed, not collected',
        // What the outstanding figure counts — same rule as /admin/today.
        depositsOutstandingCoverage:
          'Unpaid Awaiting-Payment referrals + open deposit checkouts (abandoned or pending), one per referral',
        blendedRoas,
        adSpend,
        productOrders,
        productRevenue,
        productMarginBHC,
        productUnshipped,
        productOrdersThisMonth,
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
      // MATCHED must be a SUBSET of Qualified or the funnel renders >100%.
      // Counting every buyer with any referral swept in ~1,400 legacy imports
      // that never passed through the quiz, so this stage rendered a 196%
      // conversion rate — the exact failure the stage list below says it was
      // designed to avoid. Intersect with the qualified set.
      const qualifiedIds = new Set(
        approved.filter((c: any) => c['Qualified At']).map((c: any) => c.id),
      );
      const matchedBuyers = new Set(
        referrals
          .flatMap((r: any) => (Array.isArray(r['Buyer']) ? r['Buyer'] : []))
          .filter((id: any) => id && qualifiedIds.has(id)),
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
      // Bounded to 30 days — engagement rates are a recent-health metric;
      // the unbounded scan was 46 pages and growing with every send.
      const sends = await safe(
        () => getAllRecords(
          TABLES.EMAIL_SENDS,
          "IS_AFTER(CREATED_TIME(), DATEADD(NOW(), -30, 'days'))",
        ) as Promise<any[]>,
        'emailSends',
      );
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
      //     (idle capacity). (The retired today-v1 API called this "underused".)
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
