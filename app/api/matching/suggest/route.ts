import { NextResponse } from 'next/server';
import { getAllRecords, createRecord, updateRecord, getRecordById } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { sendOperatorSignal } from '@/lib/operatorSignal';
import { sendEmail, sendBuyerIntroNotification, sendStateWaitlistLetter } from '@/lib/email';
import { sendSMSToConsumer } from '@/lib/twilio';
import { normalizeState, normalizeStates } from '@/lib/states';
import jwt from 'jsonwebtoken';
import { getMaxActiveReferrals, incrementCapacity, decrementCapacity, syncCapacityToAirtable } from '@/lib/rancherCapacity';
import { isRancherOperationalForBuyers } from '@/lib/rancherEligibility';
import { requireAdmin } from '@/lib/adminAuth';

export const maxDuration = 90;

import { JWT_SECRET, generateMemberLoginToken } from '@/lib/secrets';
import { funnelRecord } from '@/lib/funnelMetrics';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

export async function POST(request: Request) {
  try {
    // Maintenance short-circuit: don't match anyone while the platform is paused.
    // Callers (signup, reorder, waitlist retry) all early-return in maintenance mode,
    // so hitting this is a bug — return 503 so it's visible in logs.
    if (isMaintenanceMode()) {
      return NextResponse.json({
        success: false,
        paused: true,
        error: 'Matching is paused while the platform is in maintenance mode.',
      }, { status: 503 });
    }

    // Auth: x-internal-secret header (cron/internal callers) OR
    // requireAdmin() (admin cookie + x-admin-password).
    const internalSecret = process.env.INTERNAL_API_SECRET || '';
    const authHeader = request.headers.get('x-internal-secret') || '';
    const isInternal = internalSecret && authHeader === internalSecret;
    if (!isInternal) {
      const unauthorized = await requireAdmin(request);
      if (unauthorized) return unauthorized;
    }

    const body = await request.json();
    const {
      buyerState, buyerId, buyerName, buyerEmail, buyerPhone,
      orderType, budgetRange, intentScore, intentClassification, notes,
      campaign,
      // When re-routing a lead a rancher passed on, the calling code passes
      // the previous rancher's ID(s) so the matching engine doesn't recommend
      // them again. Without this, lead resurrection sends the same lead back
      // to the rancher who just rejected it.
      excludeRancherIds,
      // Hot-lead override: when the buyer has explicitly clicked YES on a
      // warmup email (Warmup Engaged At set), they're a rare time-sensitive
      // opt-in. Capacity caps that protect ranchers from "lead overload"
      // shouldn't apply — the buyer goes cold while we hold them in queue.
      // Callers (batch-approve waitlist retry) detect engagement and set
      // this flag. Capacity-bypass routing fires a Telegram alert so the
      // operator can see when a rancher is over-cap.
      warmupEngaged,
      // Operator-override flag (2026-06-05 hardening): allows internal
      // callers to explicitly bypass the strict Qualified-At gate, e.g.
      // for admin manual reassignment or re-route after Closed Lost. MUST
      // include a `reason` string that gets surfaced in Telegram + Notes.
      // Without this flag, missing Qualified At returns 412.
      operatorOverride,
      operatorOverrideReason,
    } = body;
    const excludeIds = new Set<string>(Array.isArray(excludeRancherIds) ? excludeRancherIds : []);
    const isHotLead = !!warmupEngaged;
    const isOperatorOverride = !!operatorOverride;

    // ── EMERGENCY KILL SWITCH (2026-06-05) ──────────────────────────────
    // env MATCHING_ENABLED=false → instant 503 for every caller. Single
    // env flip = full routing freeze (matching, intro emails, downstream).
    // Use during incidents OR when you need to quietly drain the queue
    // before relaunching with new rules. Default true (matching live).
    if (process.env.MATCHING_ENABLED === 'false') {
      return NextResponse.json({
        error: 'Matching engine paused — MATCHING_ENABLED=false',
        retryable: true,
      }, { status: 503 });
    }

    if (!buyerState || !buyerId) {
      return NextResponse.json({ error: 'buyerState and buyerId are required' }, { status: 400 });
    }

    // Normalize buyer state to canonical 2-letter code (handles "Montana" → "MT")
    const normalizedBuyerState = normalizeState(buyerState);
    if (!normalizedBuyerState) {
      return NextResponse.json({ error: `Unrecognized buyer state: ${buyerState}` }, { status: 400 });
    }

    // ── STRICT QUALIFICATION GATE (2026-06-05 hardening) ────────────────
    // /api/qualify is the SOLE buyer-initiated entry point that stamps
    // Qualified At. Any other caller hitting matching/suggest with a buyer
    // who hasn't completed the quiz is REJECTED with 412 unless they
    // explicitly pass operatorOverride=true + operatorOverrideReason.
    //
    // Previous behavior was soft-warn only — that's what let the 2026-06-05
    // incident through (179 healed buyers cascading through batch-approve
    // → matching/suggest → nationwide fallback → 39 cross-state misroutes).
    //
    // Allowed paths through:
    //   1. Quiz completed (Qualified At set, Score >= 75) — normal flow
    //   2. operatorOverride=true + reason — admin explicit override (audit-logged)
    //
    // Buyer record lookup is mandatory — no buyerId resolution = 404.
    let buyerRecForGate: any = null;
    try {
      buyerRecForGate = await getRecordById(TABLES.CONSUMERS, buyerId);
    } catch (e: any) {
      return NextResponse.json({
        error: `Buyer record not found: ${buyerId}`,
        detail: e?.message || 'lookup failed',
      }, { status: 404 });
    }
    if (!buyerRecForGate) {
      return NextResponse.json({ error: `Buyer record not found: ${buyerId}` }, { status: 404 });
    }

    const buyerLabel = buyerRecForGate['Full Name'] || buyerRecForGate['Email'] || buyerId;
    const qualScore = Number(buyerRecForGate['Qualification Score'] || 0);
    const hasQualified = !!buyerRecForGate['Qualified At'] && qualScore >= 75;
    if (!hasQualified && !isOperatorOverride) {
      // Loud Telegram so the operator sees every bypass attempt — even
      // automated cron calls that try to bypass without override.
      try {
        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          `🛑 <b>ROUTING BLOCKED — buyer not qualified</b>\n\n` +
            `Buyer: ${buyerLabel} (${buyerRecForGate['State'] || '?'})\n` +
            `Qualified At: ${buyerRecForGate['Qualified At'] || 'missing'}\n` +
            `Score: ${qualScore}/100 (need ≥75)\n\n` +
            `<i>Caller attempted matching/suggest without operatorOverride. 412 returned. Direct buyer to /qualify or pass operatorOverride={reason}.</i>`,
        );
      } catch {}
      return NextResponse.json({
        error: 'Buyer has not completed /qualify quiz — routing blocked',
        buyer: buyerLabel,
        qualifyUrl: `${process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com'}/qualify`,
        hint: 'Direct buyer to complete /qualify, OR pass operatorOverride=true + operatorOverrideReason for admin manual route.',
      }, { status: 412 });
    }

    // Operator override path — log loud Telegram so every override is visible.
    if (!hasQualified && isOperatorOverride) {
      try {
        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          `⚠️ <b>OPERATOR OVERRIDE — routing unqualified buyer</b>\n\n` +
            `Buyer: ${buyerLabel} (${buyerRecForGate['State'] || '?'})\n` +
            `Reason: ${operatorOverrideReason || '(not provided)'}\n\n` +
            `<i>Quiz NOT completed; operatorOverride=true. Audit-logged.</i>`,
        );
      } catch {}
    }

    // ── Guard: skip if buyer already has an active referral ────────────────
    // Prevents duplicate referrals when waitlisted retry re-calls this endpoint.
    //
    // Also dedups (buyer, rancher) pairs on TERMINAL outcomes — Closed Lost
    // (rancher passed / deal died) and Closed Won (buyer already bought).
    // Without this dedup the same rancher could get the same buyer re-routed
    // every retry, breaking rancher trust + buyer experience.
    //
    // BUG-FIX (2026-05-06): a "Pending Approval" referral with NO Suggested
    // Rancher attached is NOT active — it's a record of a previous failed
    // matching attempt (capacity was full, rancher excluded, etc). Treating
    // it as active blocked all retries for that buyer FOREVER. 15 TX/CA/MT/NE
    // buyers were stuck this way despite open capacity. Fix: require either a
    // linked Rancher OR a Suggested Rancher for a Pending Approval to count
    // as "active." Empty-attachment Pending Approval is treated as recoverable
    // and matching retries cleanly.
    const closedRancherIds = new Set<string>();
    if (buyerEmail) {
      try {
        const existingRefs = await getAllRecords(
          TABLES.REFERRALS,
          `LOWER({Buyer Email}) = "${buyerEmail.trim().toLowerCase()}"`
        ) as any[];
        // Active short-circuit. Pending Approval requires a linked rancher
        // — otherwise it's an orphan record from a failed match attempt and
        // should NOT block retries.
        const active = existingRefs.find((r) => {
          const status = r['Status'];
          if (!['Intro Sent', 'Rancher Contacted', 'Negotiation', 'Pending Approval'].includes(status)) {
            return false;
          }
          if (status === 'Pending Approval') {
            const hasRancher =
              (Array.isArray(r['Rancher']) && r['Rancher'].length > 0) ||
              (Array.isArray(r['Suggested Rancher']) && r['Suggested Rancher'].length > 0);
            return hasRancher;
          }
          return true;
        });
        if (active) {
          // Resolve the already-matched rancher so the funnel reveal shows the
          // MATCH (Mode 2) instead of a false "we're bringing ranches to your
          // state" waitlist (Mode 3) to a buyer who is actively matched.
          let suggestedRancher: any = null;
          try {
            const rIds = (Array.isArray(active['Rancher']) && active['Rancher'].length
              ? active['Rancher'] : active['Suggested Rancher']) || [];
            const rid = Array.isArray(rIds) ? rIds[0] : null;
            if (rid) {
              const rr: any = await getRecordById(TABLES.RANCHERS, rid);
              if (rr) suggestedRancher = {
                id: rr.id,
                name: rr['Operator Name'] || rr['Ranch Name'] || '',
                state: rr['State'] || '',
                slug: rr['Slug'] || '',
              };
            }
          } catch { /* non-fatal — falls back to no rancher */ }
          return NextResponse.json({
            success: true,
            matchFound: true,
            alreadyActive: true,
            referralId: active.id,
            suggestedRancher,
            message: `Buyer already has an active referral (${active['Status']})`,
          });
        }
        // Build terminal-outcome exclusion set.
        for (const ref of existingRefs) {
          if (['Closed Lost', 'Closed Won'].includes(ref['Status'])) {
            for (const id of (ref['Rancher'] || [])) closedRancherIds.add(id);
            for (const id of (ref['Suggested Rancher'] || [])) closedRancherIds.add(id);
          }
        }
      } catch (e) {
        console.error('Error checking existing referrals:', e);
        // Continue anyway — better a duplicate than a missed lead
      }
    }
    for (const id of closedRancherIds) excludeIds.add(id);

    const allRanchers: any[] = await getAllRecords(TABLES.RANCHERS);

    // ── Per-state fairness sub-cap (2026-05-27 multi-state fix) ─────────────
    // PROBLEM: a rancher serving multiple states (Routing States = CA, OR, WA)
    // shares ONE capacity counter. High-demand states (CA) consume the entire
    // cap; low-demand states (OR, WA) get waitlisted indefinitely with no
    // buyer ever reaching the rancher. Bigger states starve smaller ones.
    //
    // FIX: per-state sub-cap. Each routing state can claim at most
    // floor(maxReferrals / numStates) slots by default. Ranchers can override
    // with a JSON `State Capacity Override` field like {"CA": 5, "OR": 3, "WA": 2}
    // when they want a non-uniform split.
    //
    // BACKWARDS-COMPAT:
    //   - 1 routing state served → no sub-cap (old behavior preserved exactly).
    //   - Multi-state rancher with no override → equal-floor split.
    //   - Legacy referrals (no State Allocation stamp) don't count toward any
    //     sub-cap bucket — they only count toward the global cap. This is the
    //     conservative read: a referral with no allocation could belong to any
    //     state, so attributing it to one would over-count there. As fresh
    //     referrals stamp their state, the per-state buckets self-populate.
    //
    // STAMPING: at referral create below, we record State Allocation = the
    // buyer's normalized state. The sub-cap math reads this field on subsequent
    // matches to know how many slots each state has consumed.
    const rancherRoutingStates = (r: any): string[] => {
      const adminApprovedMultiState = !!r['Admin Approved Multi-State'];
      const primaryState = normalizeState(r['State']);
      if (!adminApprovedMultiState) {
        return primaryState ? [primaryState] : [];
      }
      const routingRaw = (r['Routing States'] || '').toString().trim();
      const served = normalizeStates(routingRaw || r['States Served']);
      const merged = new Set<string>();
      if (primaryState) merged.add(primaryState);
      for (const s of served) if (s) merged.add(s);
      return Array.from(merged);
    };
    const parseStateOverride = (raw: any): Record<string, number> | null => {
      if (!raw) return null;
      try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        const out: Record<string, number> = {};
        for (const [k, v] of Object.entries(parsed)) {
          const code = normalizeState(String(k));
          const n = Math.floor(Number(v));
          if (code && isFinite(n) && n >= 0) out[code] = n;
        }
        return Object.keys(out).length > 0 ? out : null;
      } catch {
        return null;
      }
    };
    // Pull all active Intro Sent referrals once so we can bucket per (rancher, state).
    // Reading-once + grouping avoids one Airtable call per rancher × state.
    let activeRefsByRancherState = new Map<string, Map<string, number>>();
    try {
      // Count the SAME slot-holding statuses the global counter holds (Current
      // Active Referrals is incremented at Intro Sent and held through later
      // statuses). Counting only 'Intro Sent' here let in-state leads that
      // progressed vanish from the per-state count while still consuming a global
      // slot — so a multi-state rancher could take 2× their per-state cap.
      const activeReferrals = (await getAllRecords(
        TABLES.REFERRALS,
        `OR({Status} = "Intro Sent", {Status} = "Rancher Contacted", {Status} = "Negotiation", {Status} = "Awaiting Payment", {Status} = "Slot Locked")`,
      )) as any[];
      for (const ref of activeReferrals) {
        const rancherIds = (Array.isArray(ref['Rancher']) ? ref['Rancher'] : []) as string[];
        if (rancherIds.length === 0) continue;
        // Prefer the State Allocation stamp (added 2026-05-27). Fall back
        // to Buyer State for legacy referrals created before this fix —
        // they still bucket correctly since the buyer's home state is the
        // source state for the sub-cap math by design.
        const allocRaw = ref['State Allocation'] || ref['Buyer State'] || '';
        const allocState = normalizeState(String(allocRaw));
        if (!allocState) continue;
        for (const rid of rancherIds) {
          let inner = activeRefsByRancherState.get(rid);
          if (!inner) {
            inner = new Map<string, number>();
            activeRefsByRancherState.set(rid, inner);
          }
          inner.set(allocState, (inner.get(allocState) || 0) + 1);
        }
      }
    } catch (e: any) {
      console.error('[matching/suggest] active-referrals-by-state load failed:', e?.message);
      // Fail open: empty map → sub-cap behaves as "no allocations yet,"
      // matching falls back to global cap (legacy behavior).
      activeRefsByRancherState = new Map();
    }
    const getStateSubCap = (
      rancher: any,
      state: string,
      maxReferrals: number,
    ): number => {
      const states = rancherRoutingStates(rancher);
      // Single-state ranchers preserve legacy behavior (no sub-cap).
      if (states.length <= 1) return maxReferrals;
      const override = parseStateOverride(rancher['State Capacity Override']);
      if (override && override[state] !== undefined) return override[state];
      // Equal-floor split. floor() can leave a slot or two unallocated
      // (e.g. 10 / 3 = 3 per state, total 9). That's intentional — the
      // global cap above stays authoritative, but the sub-cap prevents
      // any single state from hogging more than its fair share.
      return Math.max(0, Math.floor(maxReferrals / states.length));
    };
    const getActiveInState = (rancherId: string, state: string): number => {
      return activeRefsByRancherState.get(rancherId)?.get(state) || 0;
    };

    // Helper: check if rancher is active, signed, and under capacity.
    // Also excludes any rancher in `excludeRancherIds` — used when re-routing
    // a lead that a rancher just passed on, so the same rancher doesn't get
    // the lead bounced right back to them.
    //
    // CAPACITY BYPASS for hot leads: when the buyer has explicitly opted in via
    // warmup engagement, we route to a state-matched rancher even if they're at
    // capacity. The cap exists to prevent "lead overload"; for a rare hand-raised
    // buyer, sitting in queue means going cold. We enforce a 1.2× hard ceiling
    // (was 2× — produced 19/15 outcomes like Hewitson when one rancher covers
    // multiple states with no in-state competition). 1.2× keeps the safety
    // valve for hot leads but bounds the worst case to "20% over max."
    const HARD_CEILING_MULTIPLIER = 1.2;
    const isEligibleBase = (r: any) => {
      if (excludeIds.has(r.id)) return false;
      // Operational check (Active + Agreement Signed + Onboarding Live) lives
      // in lib/rancherEligibility.ts as the SINGLE source of truth shared with
      // the signup gate + warmup cron. Don't inline a copy here — drift is
      // exactly how 48 buyers got stranded in TN/OR waitlists.
      if (!isRancherOperationalForBuyers(r)) return false;
      const maxReferrals = getMaxActiveReferrals(r);
      const currentReferrals = r['Current Active Referrals'] || 0;
      if (isHotLead) {
        // Hot-lead bypass: ignore the soft cap up to 2× the configured max.
        if (currentReferrals >= maxReferrals * HARD_CEILING_MULTIPLIER) return false;
      } else {
        if (currentReferrals >= maxReferrals) return false;
      }
      // Per-state sub-cap. Cold leads only — hot leads keep the bypass
      // intent (warmup-engaged opt-ins shouldn't sit in queue waiting for
      // a state-fairness slot to free up). The global 1.2× hard ceiling
      // above is still enforced atomically post-INCR.
      if (!isHotLead) {
        const subCap = getStateSubCap(r, normalizedBuyerState, maxReferrals);
        const inState = getActiveInState(r.id, normalizedBuyerState);
        if (inState >= subCap) return false;
      }
      return true;
    };

    // ── TIER SPECIALTY FILTER ─────────────────────────────────────────────
    // Some ranchers only handle certain share sizes. High Lonesome doesn't do
    // Quarters; Homestead Beef does Quarter/Half/Whole. The Ranchers table has
    // a multipleSelects "Tier Specialty" field — when set, the rancher only
    // matches buyers whose Order Type is in the list. When EMPTY (legacy
    // ranchers), no filter is applied (matches all tiers).
    //
    // Buyer's Order Type can be "Quarter (~85 lbs)", "Half", "Whole", "Not
    // Sure", "" — we normalize to one of: "Quarter" | "Half" | "Whole" | null
    // (null = no filter, route to anyone).
    const buyerTier: 'Quarter' | 'Half' | 'Whole' | null = (() => {
      const ot = (orderType || '').toString().toLowerCase();
      if (ot.includes('quarter')) return 'Quarter';
      if (ot.includes('half')) return 'Half';
      if (ot.includes('whole')) return 'Whole';
      return null;
    })();
    const isTierFit = (r: any): boolean => {
      const specialty = r['Tier Specialty'];
      // No tier specialty configured on this rancher → matches all (legacy default)
      if (!specialty || (Array.isArray(specialty) && specialty.length === 0)) return true;
      // Buyer didn't specify a tier → don't filter
      if (!buyerTier) return true;
      const list = Array.isArray(specialty)
        ? specialty.map((s: any) => (typeof s === 'string' ? s : s?.name || ''))
        : [specialty];
      return list.includes(buyerTier);
    };

    // Parse a buyer budget range into a numeric ceiling.
    // Current brackets: $1000-$1500, $2000-$2500, $4000-$5000, $5000+, "Just exploring".
    // Legacy brackets still accepted for buyers stored before the form rework:
    // "<$500", "$500-$1000", "$1000-$2000", "$2000+", "Unsure", "Not Sure".
    //
    // Returns 0 for "Just exploring" (no rancher should match — these aren't
    // real buyers yet). Returns Infinity for "Unsure" (legacy permissive).
    const parseBudgetCeiling = (range: string): number => {
      if (!range) return Infinity;
      const r = range.trim().toLowerCase();
      if (r === '') return Infinity;
      // Hard reject: "just exploring" buyers shouldn't match any rancher.
      // Returning 0 makes isPriceFit reject every priced rancher. They'll
      // stay in nurture until they pick a real budget.
      if (r === 'just exploring') return 0;
      if (r === 'unsure' || r === 'not sure') return Infinity;
      if (r.startsWith('<')) {
        const n = parseInt(r.replace(/[^0-9]/g, ''), 10);
        return isFinite(n) ? n : Infinity;
      }
      if (r.endsWith('+')) return Infinity; // e.g. "$2000+", "$5000+"
      // Range like "$1000-$1500" — take the upper bound.
      const parts = r.split('-');
      if (parts.length === 2) {
        const upper = parseInt(parts[1].replace(/[^0-9]/g, ''), 10);
        if (isFinite(upper)) return upper;
      }
      const single = parseInt(r.replace(/[^0-9]/g, ''), 10);
      return isFinite(single) ? single : Infinity;
    };

    // Helper: does the rancher's pricing fit the buyer's order type + budget?
    // - If the rancher hasn't set prices at all, don't block (still a valid match —
    //   they handle pricing in conversation).
    // - If the buyer wants a specific tier, check THAT tier's price against their budget.
    // - If the buyer hasn't picked a tier, check the cheapest configured tier.
    // - If the buyer's budget can't fit ANY configured tier, filter the rancher out.
    const budgetCeiling = parseBudgetCeiling(budgetRange || '');
    const normalizedOrderType = (orderType || '').toString().toLowerCase();
    const isPriceFit = (r: any): boolean => {
      const q = Number(r['Quarter Price']) || 0;
      const h = Number(r['Half Price']) || 0;
      const w = Number(r['Whole Price']) || 0;
      const anyPriced = q > 0 || h > 0 || w > 0;
      // Rancher has no pricing configured yet — don't filter out.
      if (!anyPriced) return true;
      // Budget is unbounded — any priced rancher fits.
      if (!isFinite(budgetCeiling)) return true;

      const tierPrice = (() => {
        if (normalizedOrderType.includes('quarter')) return q;
        if (normalizedOrderType.includes('half')) return h;
        if (normalizedOrderType.includes('whole')) return w;
        // "Not Sure" / blank — use cheapest configured tier.
        const configured = [q, h, w].filter(p => p > 0);
        return configured.length > 0 ? Math.min(...configured) : 0;
      })();

      // If the specifically-requested tier isn't priced, fall back to cheapest configured.
      const effective = tierPrice > 0
        ? tierPrice
        : Math.min(...[q, h, w].filter(p => p > 0));
      // 10% tolerance over the budget ceiling. Buyer brackets like
      // "$1000-2000" are descriptive, not hard caps — a $2100 rancher
      // shouldn't get filtered out for being $100 over. Real conversations
      // happen between buyer and rancher to land on a final number.
      // Without this, edge cases (TX buyer at $2000 budget vs Ashcraft Half
      // at $2100) silently waitlisted otherwise-perfect matches.
      const BUDGET_TOLERANCE = 1.10;
      return effective <= budgetCeiling * BUDGET_TOLERANCE;
    };

    // ── PRIORITY: If lead came from a specific rancher's page, assign to THAT rancher ──
    // Direct page leads have explicit intent for THIS rancher, so we bypass the
    // soft capacity cap (the post-INCR 1.2× hard ceiling still applies). But we
    // MUST run the full operational gate including Subscription Status —
    // otherwise a past_due rancher gets the lead via their page and the buyer
    // hits a 409 at deposit checkout (silent revenue blackhole, bug #16 from
    // 2026-06-02 audit). Reuses the canonical operational gate from
    // lib/rancherEligibility.ts (Active + Live + Signed + Sub Status pass).
    let directMatchRancher: any = null;
    let matchType: string | null = null;
    if (campaign && campaign.startsWith('rancher-')) {
      const rancherSlug = campaign.replace('rancher-', '');
      directMatchRancher = allRanchers.find((r: any) => {
        const slug = r['Slug'] || '';
        return slug === rancherSlug && isRancherOperationalForBuyers(r);
      });
      if (directMatchRancher) {
        matchType = 'direct';
      }
    }

    let topMatch: any = null;

    if (directMatchRancher) {
      // Lead came from this rancher's page — assign directly to them
      topMatch = directMatchRancher;
    } else {
      // STATE-LOCAL ONLY. The nationwide-fallback path was removed by policy:
      // every rancher routes only to buyers in their primary State or States
      // Served. If no in-state rancher exists, the buyer is waitlisted —
      // they'll be re-engaged when a rancher in their state goes live.
      // The Ships Nationwide field is no longer read anywhere; ignore it.
      const localEligibleAll = allRanchers.filter((r: any) => {
        if (!isEligibleBase(r)) return false;
        // Normalize rancher's primary state + every "Routing States" entry to
        // 2-letter codes BEFORE comparing. Old behavior just uppercased, so
        // "Montana" never matched buyer state "MT".
        //
        // Routing States = ADMIN-controlled (Ben). Rancher edits Preferred
        // States separately to request additions. Matching does NOT fire from
        // a state until admin promotes the rancher's preference into Routing
        // States. Falls back to legacy States Served field if Routing States
        // is empty (handles pre-migration records).
        const rState = normalizeState(r['State']);
        // ── Home-state gate (2026-05-13) ─────────────────────────────────
        // RULE: ranchers route ONLY to their home state by default. Multi-
        // state routing requires explicit admin opt-in via the
        // `Admin Approved Multi-State` boolean field on the rancher record.
        // Without this gate, Routing States can drift wide (e.g. nationwide
        // shipper flags, bulk imports) and silently route cross-state leads
        // that the operator never approved. Keeping the gate at the read
        // layer means even pre-existing wide Routing States lists become
        // safe — they're ignored until Ben flips the boolean.
        const adminApprovedMultiState = !!r['Admin Approved Multi-State'];
        if (!adminApprovedMultiState) {
          // Strict home-only match.
          if (rState !== normalizedBuyerState) return false;
        } else {
          // Routing States is the ADMIN-CONTROLLED gate. Do NOT fall back to
          // States Served — that field is rancher-editable in the dashboard
          // and would let a rancher silently route cross-state by editing
          // their own profile, defeating the entire 2026-05-13 admin gate.
          // Fix from 2026-06-02 audit bug #10. If admin flipped Multi-State
          // without populating Routing States, the rancher routes home-state
          // only (same as the !adminApprovedMultiState branch).
          const routingRaw = (r['Routing States'] || '').toString().trim();
          const served = normalizeStates(routingRaw);
          if (!(rState === normalizedBuyerState || served.includes(normalizedBuyerState))) return false;
        }
        // Tier Specialty filter — see definition above. Quarter buyers won't
        // get routed to Half/Whole-only ranchers, etc. Empty Tier Specialty =
        // no filter applied (legacy default).
        if (!isTierFit(r)) return false;
        return true;
      });
      const localEligible = localEligibleAll.filter(isPriceFit);

      // If price-fit eliminated all candidates but there WERE state-eligible
      // ranchers, log so we can see the budget-gap pattern over time.
      const priceFiltered = localEligibleAll.length > 0 && localEligible.length === 0;
      if (priceFiltered) {
        console.log(`[match] Price filter removed all ${localEligibleAll.length} local ranchers for ${buyerName || buyerId} (budget=${budgetRange}, orderType=${orderType})`);
      }

      const eligible = localEligible;
      matchType = localEligible.length > 0 ? 'local' : null;

      eligible.sort((a: any, b: any) => {
        // 1. PRIMARY STATE WINS. A rancher whose Primary State === buyer's
        //    state should always beat a rancher who only "serves" the buyer's
        //    state via States Served. Otherwise a low-load multi-state
        //    rancher (e.g. Russell Gift OK serving TX,KS,NM,CO) hoovers up
        //    every TX buyer ahead of the actual TX rancher (Ashcraft),
        //    creating bad UX (longer ship time + buyer expects "local").
        const aPrimary = normalizeState(a['State']) === normalizedBuyerState;
        const bPrimary = normalizeState(b['State']) === normalizedBuyerState;
        if (aPrimary !== bPrimary) return aPrimary ? -1 : 1;

        // 2. Then by capacity (fewer active = preferred for load-balance)
        const aRefs = a['Current Active Referrals'] || 0;
        const bRefs = b['Current Active Referrals'] || 0;
        if (aRefs !== bRefs) return aRefs - bRefs;

        // 3. Then round-robin by oldest Last Assigned At
        const aDate = a['Last Assigned At'] ? new Date(a['Last Assigned At']).getTime() : 0;
        const bDate = b['Last Assigned At'] ? new Date(b['Last Assigned At']).getTime() : 0;
        if (aDate !== bDate) return aDate - bDate;

        // 4. Performance score tiebreaker
        const aScore = a['Performance Score'] || 50;
        const bScore = b['Performance Score'] || 50;
        return bScore - aScore;
      });

      topMatch = eligible.length > 0 ? eligible[0] : null;

      // ── NATIONWIDE FALLBACK — DISABLED 2026-06-05 ──────────────────────
      // BPF-1 (2026-06-02) wired `Ships Nationwide=true` as a cross-state
      // fallback when no in-state rancher matched. In prod this fired
      // through the batch-approve cron and routed 39 cross-state buyers
      // to Ashcraft (TX) and Hartsock (CO) within minutes — neither
      // rancher expected or wanted the volume, and the buyers got a
      // misrouted intro that contradicted their state.
      //
      // Reverted to STATE-LOCAL ONLY policy. No nationwide auto-route.
      // Buyers without an in-state rancher waitlist via the no-match
      // short-circuit below. If/when a specific rancher needs explicit
      // multi-state coverage, use `Admin Approved Multi-State` + populate
      // `Routing States` (handled above) — that's the controlled path.
      //
      // The Ships Nationwide field is intentionally NOT read here. Flipped
      // both Ashcraft and Hartsock to Ships Nationwide=false to be safe.
    }

    // ── NO-MATCH SHORT-CIRCUIT (2026-05-09 fix) ──
    // Pre-fix: this block created a Pending Approval Referral row regardless
    // of whether topMatch was found. When no rancher available, the row had
    // no Suggested Rancher / Match Type / Approval Status — pure garbage.
    // 452 such orphans had accumulated in production.
    //
    // Two harms:
    //   1. Buyer counted as "active" by stuck-buyer-recovery via the orphan,
    //      blocking legitimate retries (fixed separately by orphan-aware check).
    //   2. Garbage data in Referrals table grows without bound, every retry.
    //
    // Fix: if no rancher matched, DON'T create a referral. Update buyer state
    // to Waitlisted instead. Existing waitlist-blast cron catches them when
    // capacity opens. Return matchFound=false to caller.
    if (!topMatch) {
      // Update buyer Consumer record to Waitlisted state so they're
      // re-tried by stuck-buyer-recovery when capacity opens.
      try {
        await updateRecord(TABLES.CONSUMERS, buyerId, {
          'Referral Status': 'Waitlisted',
          'Last Match Attempt At': new Date().toISOString(),
        });
      } catch (e: any) {
        console.warn('[matching] consumer waitlist update failed:', e?.message);
      }
      return NextResponse.json({
        success: true,
        matchFound: false,
        matchType: null,
        suggestedRancher: null,
        message: 'No rancher available — buyer waitlisted. Will retry when capacity opens.',
      });
    }

    const referralFields: Record<string, any> = {
      'Buyer': [buyerId],
      'Status': 'Pending Approval',
      'Buyer Name': buyerName || '',
      // Store normalized so the dedup short-circuit (LOWER match) is reliable +
      // future bare-equality queries match. Prevents the same buyer being
      // double-matched to two ranchers when their email casing varies.
      'Buyer Email': (buyerEmail || '').trim().toLowerCase(),
      'Buyer Phone': buyerPhone || '',
      'Buyer State': normalizedBuyerState,
      'Order Type': orderType || '',
      'Budget Range': budgetRange || '',
      'Intent Score': intentScore || 0,
      'Intent Classification': intentClassification || '',
      'Notes': notes || '',
      'Suggested Rancher': [topMatch.id],
      'Suggested Rancher Name': topMatch['Operator Name'] || topMatch['Ranch Name'] || '',
      'Suggested Rancher State': topMatch['State'] || '',
      'Match Type': matchType === 'direct' ? 'Direct (Rancher Page)' : matchType === 'nationwide' ? 'Nationwide' : 'Local',
      // State Allocation: source state used for the per-state sub-cap math
      // on future matches. Stamped on every new referral so the activeRefs
      // grouping in subsequent calls knows which state's bucket this slot
      // belongs to. For single-state ranchers the sub-cap collapses to the
      // global cap, so this stamp is harmless but always present.
      'State Allocation': normalizedBuyerState,
    };

    let referral: any;
    try {
      referral = await createRecord(TABLES.REFERRALS, referralFields);
    } catch (e: any) {
      console.warn('Could not create referral record:', e?.message);
      return NextResponse.json({
        success: false,
        error: 'Referrals table not accessible. Please check Airtable API token permissions.',
        matchFound: !!topMatch,
        suggestedRancher: topMatch ? {
          id: topMatch.id,
          name: topMatch['Operator Name'] || topMatch['Ranch Name'],
          state: topMatch['State'],
        } : null,
      }, { status: 503 });
    }

    // Increment rancher's active referral count so capacity limit works in real-time
    const now = new Date().toISOString();
    // MISMATCH FIX: hoist newRefs so we can return the post-INCR value in
    // the response. Was: response returned `topMatch['Current Active
    // Referrals'] || 0` from the pre-INCR snapshot → Telegram + dashboard
    // showed counter one-less than reality.
    let finalActiveReferrals = topMatch ? (topMatch['Current Active Referrals'] || 0) : 0;
    if (topMatch) {
      try {
        // ── Atomic capacity bump via Upstash Redis INCR ──────────────────
        // Pre-2026-05-24: this was a check-then-write against Airtable. Two
        // concurrent buyers routed to the same rancher could both pass the
        // gate + both write N+1, overflowing capacity by 1-2 under burst.
        // Round 6 audit deferred as Tier 2 hardening; shipped now.
        //
        // New flow:
        //   1. INCR Redis counter → get atomic newRefs
        //   2. If newRefs > cap (or > hard ceiling for hot leads), DECR
        //      back to undo the slot claim, downgrade referral to
        //      Waitlisted, and short-circuit. Counter stays consistent.
        //   3. Otherwise sync the new value back to Airtable so
        //      dashboards + cron reads see it.
        //
        // Failure mode: if Redis env missing OR INCR throws, the lib falls
        // back to legacy Airtable read+1 (race-prone but functional) with
        // console.error so the regression surfaces.
        const maxRefsForGuard = getMaxActiveReferrals(topMatch);
        const HARD_CEILING = Math.ceil(maxRefsForGuard * 1.2);
        const newRefs = await incrementCapacity(topMatch.id);

        // Hot-lead hard-ceiling guard: hot leads bypass the soft cap by
        // design (warmup-engaged opt-ins shouldn't sit in queue), but a
        // burst of YES clicks shouldn't smash past the 1.2× safety valve.
        // Audit finding 2026-05-20 #18.
        if (isHotLead && maxRefsForGuard > 0 && newRefs > HARD_CEILING) {
          // Undo the slot claim — return the counter to its pre-INCR value
          // so we don't strand capacity on a referral we're about to waitlist.
          let restored = newRefs - 1;
          try {
            restored = await decrementCapacity(topMatch.id);
          } catch (e) {
            console.error('Hot-lead hard-ceiling DECR rollback failed:', e);
          }
          try {
            await syncCapacityToAirtable(topMatch.id, restored);
          } catch {}
          try {
            await updateRecord(TABLES.REFERRALS, referral.id, {
              'Status': 'Waitlisted',
              'Notes': `[capacity-race-hot] Atomic INCR hit ${newRefs}/${HARD_CEILING} hard ceiling; hot-lead waitlisted + slot released.`,
            });
            await sendOperatorSignal({
              urgency: 'loud',
              kind: 'capacity',
              summary: `HOT-LEAD HARD CEILING HIT: ${topMatch['Operator Name'] || topMatch['Ranch Name'] || 'Unknown'} (${topMatch['State'] || '?'}) at ${newRefs}/${HARD_CEILING}. Buyer waitlisted to protect rancher.`,
              detail: 'Hot-lead burst would have overflowed 1.2× safety valve.',
              refs: [{ type: 'rancher', id: topMatch.id, label: topMatch['Operator Name'] || topMatch['Ranch Name'] }],
              dedupeKey: `hard-ceiling:${topMatch.id}`,
            });
          } catch (e) {
            console.error('Hot-lead hard-ceiling downgrade failed:', e);
          }
          return NextResponse.json({
            success: true,
            matchFound: false,
            waitlisted: true,
            reason: 'hard_ceiling',
            referralId: referral.id,
          });
        }
        // Cold-lead soft-cap guard. Atomic INCR makes this the authoritative
        // gate — if we ended up over cap, exactly one buyer per overflow
        // event sees the rollback path (the others observed a safe newRefs).
        if (!isHotLead && maxRefsForGuard > 0 && newRefs > maxRefsForGuard) {
          let restored = newRefs - 1;
          try {
            restored = await decrementCapacity(topMatch.id);
          } catch (e) {
            console.error('Capacity-race DECR rollback failed:', e);
          }
          try {
            await syncCapacityToAirtable(topMatch.id, restored);
          } catch {}
          try {
            await updateRecord(TABLES.REFERRALS, referral.id, {
              'Status': 'Waitlisted',
              'Notes': `[capacity-race] Atomic INCR hit ${newRefs}/${maxRefsForGuard}; waitlisted + slot released.`,
            });
            await sendOperatorSignal({
              urgency: 'digest',
              kind: 'capacity',
              summary: `CAPACITY RACE CAUGHT: ${topMatch['Operator Name'] || topMatch['Ranch Name'] || 'Unknown'} (${topMatch['State'] || '?'}) hit cap on atomic INCR — buyer routed to Waitlisted instead of overflowing counter.`,
              detail: 'Indicates burst-traffic scenario.',
              refs: [{ type: 'rancher', id: topMatch.id, label: topMatch['Operator Name'] || topMatch['Ranch Name'] }],
              dedupeKey: `capacity-race:${topMatch.id}`,
            });
          } catch (e) {
            console.error('Capacity-race waitlist downgrade failed:', e);
          }
          return NextResponse.json({
            success: true,
            matchFound: false,
            waitlisted: true,
            reason: 'capacity_race',
            referralId: referral.id,
          });
        }
        // Within cap — sync to Airtable + stamp Last Assigned At in the same
        // write so dashboards see both fields update together. Direct
        // updateRecord (instead of syncCapacityToAirtable) lets us bundle
        // the timestamp field; the counter value is already authoritative
        // from the atomic INCR above.
        await updateRecord(TABLES.RANCHERS, topMatch.id, {
          'Current Active Referrals': newRefs,
          'Last Assigned At': now,
        });
        // MISMATCH FIX: persist newRefs for the response builder so the
        // returned activeReferrals reflects post-INCR reality, not the
        // stale pre-INCR snapshot from `topMatch['Current Active Referrals']`.
        finalActiveReferrals = newRefs;

        // Capacity alerts
        const maxRefs = getMaxActiveReferrals(topMatch);
        const rancherName = topMatch['Operator Name'] || topMatch['Ranch Name'] || 'Unknown';
        const rancherState = topMatch['State'] || 'Unknown';
        if (maxRefs > 0) {
          const capacityPct = newRefs / maxRefs;
          // Hot-lead bypass: if we routed an over-cap rancher because the
          // buyer was warmup-engaged, the operator should see it. Use a
          // distinct emoji so it's easy to triage in the Telegram feed.
          if (isHotLead && newRefs > maxRefs) {
            try {
              await sendOperatorSignal({
                urgency: 'normal',
                kind: 'capacity',
                summary: `HOT-LEAD CAP BYPASS: ${rancherName} (${rancherState}) is OVER cap at ${newRefs}/${maxRefs} — routed warmup-engaged buyer ${buyerName || ''} anyway.`,
                detail: `Hot opt-ins shouldn't sit in queue. If ${rancherName} isn't responding, consider Pause from admin.`,
                refs: [{ type: 'rancher', id: topMatch.id, label: rancherName }],
                dedupeKey: `hotlead-bypass:${topMatch.id}`,
              });
            } catch (e) {
              console.error('Error sending hot-lead bypass alert:', e);
            }
          } else if (newRefs >= maxRefs) {
            // 100% — at capacity
            try {
              await sendOperatorSignal({
                urgency: 'normal',
                kind: 'capacity',
                summary: `AT CAPACITY: ${rancherName} in ${rancherState} is FULL (${newRefs}/${maxRefs}).`,
                detail: 'New cold leads will waitlist; warmup-engaged hot leads will continue routing.',
                refs: [{ type: 'rancher', id: topMatch.id, label: rancherName }],
                dedupeKey: `at-capacity:${topMatch.id}`,
                dedupeWindowMs: 60 * 60 * 1000,
              });
            } catch (e) {
              console.error('Error sending capacity-full Telegram alert:', e);
            }
          }
          // 80% warning intentionally dropped — under burst it fires for
          // every match in a near-cap state and clogs the chat. The 100%
          // alert above is the actionable signal; the morning digest
          // surfaces 80%+ ranchers for slower planning.
        }
      } catch (e) {
        console.error('Error incrementing rancher referral count:', e);
      }
    }

    // ── AUTO-APPROVE: ALL matches get instant intro (no Telegram wait) ──
    // If a rancher matched, fire intros immediately. No manual approval friction.
    if (topMatch) {
      try {
        // MISMATCH FIX: Update referral to Intro Sent immediately.
        // If THIS write throws, we leave behind a Pending Approval orphan
        // (referral row created at L486, never linked to rancher, never
        // assigned an Intro Sent At). Pattern reproduced 2026-05-06 — the
        // capacity counter was bumped but the referral was orphaned →
        // rancher "lost" a slot to a referral they never saw. Now: on
        // failure, roll back the capacity INCR we did above so the slot
        // returns to the rancher, and surface a loud operator signal.
        try {
          await updateRecord(TABLES.REFERRALS, referral.id, {
            'Status': 'Intro Sent',
            'Rancher': [topMatch.id],
            'Approved At': now,
            'Intro Sent At': now,
          });
        } catch (introErr: any) {
          console.error('[matching/suggest] Intro Sent flip failed — rolling back capacity:', introErr?.message);
          try {
            const { decrementCapacity, syncCapacityToAirtable } = await import('@/lib/rancherCapacity');
            const rolledBack = await decrementCapacity(topMatch.id);
            await syncCapacityToAirtable(topMatch.id, rolledBack);
          } catch (rollbackErr: any) {
            console.error('[matching/suggest] capacity rollback also failed:', rollbackErr?.message);
          }
          try {
            await sendOperatorSignal({
              urgency: 'loud',
              kind: 'system-error',
              summary: `🚨 ORPHAN REFERRAL: ${referral.id} stuck Pending Approval — Intro Sent write threw`,
              detail: `Capacity rolled back on ${topMatch['Operator Name'] || topMatch['Ranch Name'] || topMatch.id}. ` +
                `Manually fix the referral in Airtable (set Rancher=[${topMatch.id}], Status=Intro Sent) OR delete it so the buyer re-routes via batch-approve. Original error: ${(introErr?.message || 'unknown').slice(0, 200)}`,
              refs: [{ type: 'rancher', id: topMatch.id, label: topMatch['Operator Name'] || '?' }],
              dedupeKey: `orphan-referral:${referral.id}`,
            });
          } catch {}
          throw introErr; // bubble to outer try so the buyer also gets re-tried via batch-approve
        }

        // Update consumer status + Buyer Stage transition to MATCHED
        await updateRecord(TABLES.CONSUMERS, buyerId, {
          'Referral Status': 'Intro Sent',
          'Buyer Stage': 'MATCHED',
          'Buyer Stage Updated At': new Date().toISOString(),
        });

        const rancherName = topMatch['Operator Name'] || topMatch['Ranch Name'] || '';
        const rancherEmail = topMatch['Email'] || '';
        const rancherPhone = topMatch['Phone'] || '';
        const matchTypeLabel = matchType === 'direct' ? 'Direct Page Lead' : matchType === 'local' ? 'Local Match' : 'Nationwide Match';

        // Look up Ready-to-Buy state on the buyer record so the rancher email
        // emphasizes urgency. Don't fail the route if Airtable hiccups.
        // Also pull qualification quiz answers so the rancher sees what the
        // buyer committed to (tier / timing / storage / ack). Qualified buyers
        // = much higher close rate; surfacing the gate they cleared signals
        // quality to the rancher.
        let buyerReadyToBuy = false;
        let qualBlock = '';
        try {
          const buyerRec: any = await getRecordById(TABLES.CONSUMERS, buyerId);
          buyerReadyToBuy = !!buyerRec['Ready to Buy'];
          const qualScore = Number(buyerRec['Qualification Score'] || 0);
          const qualRaw = String(buyerRec['Qualification Answers'] || '');
          if (qualScore >= 75 && qualRaw) {
            try {
              const qa = JSON.parse(qualRaw);
              const storageLabels: Record<string, string> = {
                have_freezer: 'Has freezer space',
                need_freezer: 'Buying a freezer',
                rancher_holds: 'Needs rancher to hold short-term',
                cuts_only: 'Pickup cuts only',
              };
              qualBlock = `<div style="background:#F4F1EC;border:2px solid #0E0E0E;padding:14px 18px;margin:16px 0;font-size:14px;color:#0E0E0E;">
                <p style="margin:0 0 8px 0;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">⭐ Qualified buyer — ${qualScore}/100</p>
                <p style="margin:4px 0;"><strong>Tier:</strong> ${qa.tier || 'unspecified'}</p>
                <p style="margin:4px 0;"><strong>Timing:</strong> ${qa.timing || 'unspecified'}</p>
                <p style="margin:4px 0;"><strong>Storage:</strong> ${storageLabels[qa.storage] || qa.storage || 'unspecified'}</p>
                <p style="margin:8px 0 0 0;font-size:12px;color:#6B4F3F;">Buyer cleared the 4-question qualification quiz and acknowledged commitment to respond within 24 hours.</p>
              </div>`;
            } catch {
              // Bad JSON — show raw fallback so the data isn't lost.
              qualBlock = `<p style="font-size:13px;color:#6B4F3F;"><strong>Qualification:</strong> ${qualScore}/100</p>`;
            }
          }
        } catch {}

        // Send rancher the buyer's info. Wrap in try/catch + Telegram alert
        // so a Resend outage doesn't silently strand the referral. Without
        // this: Airtable shows "Intro Sent" but the rancher's inbox is
        // empty → buyer waits for a call that never comes → ghost.
        if (rancherEmail) {
          const subjectPrefix = buyerReadyToBuy ? '🔥 READY TO BUY · ' : '';
          const readyBanner = buyerReadyToBuy
            ? `<div style="background:#FFF6E0;border:2px solid #C99A2E;padding:14px 18px;margin:16px 0;font-size:14px;color:#0E0E0E;"><strong>READY TO BUY in 1–2 months.</strong> Buyer just clicked YES on the Ready-to-Buy CTA. They're expecting your call within 24–48 hours.</div>`
            : '';

          // Rancher quick-action JWT — 30d. Lets the rancher mark the
          // referral status with one click from this email instead of
          // logging into the dashboard.
          const SITE = SITE_URL;
          const actionToken = jwt.sign(
            {
              type: 'rancher-quick-action',
              referralId: referral.id,
              rancherId: topMatch.id,
            },
            JWT_SECRET,
            { expiresIn: '30d' }
          );
          const actionBase = `${SITE}/api/rancher/quick-action?token=${actionToken}`;
          const actionsBlock = `
            <table cellspacing="0" cellpadding="0" style="margin:22px 0 6px;width:100%;">
              <tr>
                <td style="padding:0 6px 8px 0;width:25%;">
                  <a href="${actionBase}&action=in_talks" style="display:block;padding:11px 8px;background:#0E0E0E;color:#F4F1EC;text-decoration:none;font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:0.8px;text-align:center;">💬 In talks</a>
                </td>
                <td style="padding:0 6px 8px 0;width:25%;">
                  <a href="${actionBase}&action=won" style="display:block;padding:11px 8px;background:#0E0E0E;color:#F4F1EC;text-decoration:none;font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:0.8px;text-align:center;">✓ Closed Won</a>
                </td>
                <td style="padding:0 6px 8px 0;width:25%;">
                  <a href="${actionBase}&action=lost" style="display:block;padding:11px 8px;background:#6B4F3F;color:#F4F1EC;text-decoration:none;font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:0.8px;text-align:center;">✗ Closed Lost</a>
                </td>
                <td style="padding:0 0 8px 0;width:25%;">
                  <a href="${actionBase}&action=pass" style="display:block;padding:11px 8px;background:#A7A29A;color:#F4F1EC;text-decoration:none;font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:0.8px;text-align:center;">⏭ Pass</a>
                </td>
              </tr>
            </table>
            <p style="font-size:12px;color:#6B4F3F;margin:0 0 18px 0;">One-click status updates — no login. Closed Won button asks for sale amount + auto-generates the 10% commission invoice via Stripe.</p>`;
          // sendEmail can fail two ways: (a) throw on network/Resend SDK
          // error, (b) return a result with .error set (Resend's documented
          // shape for rate limits, suppression hits, invalid recipient). The
          // old code only caught (a) — Resend errors slipped through and the
          // referral stayed marked "Intro Sent" while the rancher inbox was
          // empty. Now we check both paths and downgrade the referral so
          // batch-approve's waitlist-retry picks it back up.
          let introSendOk = true;
          let introSendErr: string = '';
          try {
            const emailResult: any = await sendEmail({
              to: rancherEmail,
              subject: `${subjectPrefix}BuyHalfCow Introduction: ${buyerName} in ${buyerState}`,
              // P0 hotfix (2026-06-02): pin templateName to a whitelisted value
              // so the rolling 3/week frequency cap doesn't silently drop the
              // intro. Before this fix, ranchers receiving 3+ matches per
              // week hit the cap on lead #4 — Airtable showed Intro Sent At
              // stamped but Resend never sent. Caused ~60% silent drop rate
              // during the volume spike on 2026-06-01.
              templateName: 'sendRancherIntroNotification',
              // Tag Reply-To with the referral context so when the rancher
              // hits Reply (or Reply-all) the message lands in the inbound
              // webhook + Conversations table. Lets us track exactly when
              // the rancher engages, what objections come up, and whether
              // the conversation goes silent.
              _replyContext: { type: 'ref', recordId: referral.id },
              html: `<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;">
                <h1 style="font-family:Georgia,serif;">New Qualified Buyer Lead</h1>
                <p>Hi ${rancherName},</p>
                ${readyBanner}
                ${qualBlock}
                <p>A qualified buyer in your area just came through BuyHalfCow and has been connected to you:</p>
                <p><strong>Buyer:</strong> ${buyerName}</p>
                <p><strong>Email:</strong> ${buyerEmail}</p>
                ${buyerPhone ? `<p><strong>Phone:</strong> ${buyerPhone}</p>` : ''}
                <p><strong>State:</strong> ${buyerState}</p>
                <p><strong>Order:</strong> ${orderType || 'Not specified'}</p>
                ${budgetRange ? `<p><strong>Budget:</strong> ${budgetRange}</p>` : ''}
                ${notes ? `<p><strong>Notes:</strong> ${notes}</p>` : ''}
                <p>Reach out within 24 hours to close the sale. Reply-all to keep me in the loop.</p>
                ${actionsBlock}
                <p style="font-size:12px;color:#A7A29A;margin-top:30px;">— Benjamin, BuyHalfCow</p>
              </div>` as any,
            } as any);
            if (emailResult && emailResult.suppressed) {
              introSendOk = false;
              introSendErr = emailResult.reason ?? 'suppressed';
            }
          } catch (e: any) {
            introSendOk = false;
            introSendErr = e?.message || 'unknown error';
          }
          if (!introSendOk) {
            console.error('Rancher intro email failed:', introSendErr);
            // Roll BOTH the referral AND the consumer back so state stays
            // consistent. Old version only flipped the referral, leaving
            // the consumer at Buyer Stage='MATCHED' / Referral Status=
            // 'Intro Sent' even though the referral was actually Pending
            // Approval and the rancher never got the email. Inconsistent
            // state confused the dashboard + state-machine cron.
            try {
              await updateRecord(TABLES.REFERRALS, referral.id, {
                'Status': 'Pending Approval',
                'Notes': `[intro-email-failed ${new Date().toISOString().slice(0, 16)}] Resend error: ${introSendErr.slice(0, 200)}. Auto-rolled back from Intro Sent — batch-approve retry path will pick this up.`,
              });
            } catch (e) {
              console.error('Could not roll referral back after intro failure:', e);
            }
            try {
              await updateRecord(TABLES.CONSUMERS, buyerId, {
                'Referral Status': 'Pending Approval',
                'Buyer Stage': 'READY',
                'Buyer Stage Updated At': new Date().toISOString(),
              });
            } catch (e) {
              console.error('Could not roll consumer back after intro failure:', e);
            }
            try {
              await sendTelegramMessage(
                TELEGRAM_ADMIN_CHAT_ID,
                `⚠️ <b>RANCHER INTRO EMAIL FAILED</b>\n\n` +
                `Buyer: ${buyerName} (${buyerEmail})\n` +
                `Rancher: ${rancherName} (${rancherEmail})\n` +
                `Error: ${introSendErr.slice(0, 200)}\n\n` +
                `<i>Referral rolled back to Pending Approval — batch-approve will retry. If urgent, resend manually via /admin.</i>`
              );
            } catch {}
          }
        }

        // Telegram alert for Ready-to-Buy routes — highest priority lead type.
        if (buyerReadyToBuy) {
          try {
            await sendTelegramMessage(
              TELEGRAM_ADMIN_CHAT_ID,
              `🔥 <b>READY-TO-BUY MATCH</b>\n\n` +
              `👤 ${buyerName} (${buyerState})\n` +
              `🤠 Routed to: ${rancherName}\n` +
              `📧 ${buyerEmail}${buyerPhone ? ` · 📱 ${buyerPhone}` : ''}\n` +
              `${orderType ? `🥩 ${orderType}` : ''}${budgetRange ? ` · 💰 ${budgetRange}` : ''}\n\n` +
              `<i>Buyer explicitly confirmed ready-to-buy in 1–2 months. Both buyer + rancher just got intro emails. Watch for reply within 24h.</i>`
            );
          } catch (e) { console.error('Ready-to-buy Telegram alert error:', e); }
        }

        // Send buyer the rancher's info
        if (buyerEmail) {
          const buyerToken = jwt.sign(
            { type: 'member-login', consumerId: buyerId, email: buyerEmail.trim().toLowerCase() },
            JWT_SECRET,
            { expiresIn: '7d' }
          );
          const buyerLoginUrl = `${SITE_URL}/member/verify?token=${buyerToken}`;
          const buyerFirstName = (buyerName || '').split(' ')[0] || 'there';

          // tier_v2 ranchers run buyer deposits through Stripe Connect direct
          // charge at /checkout/<refId>/deposit. The deposit page requires
          // bhc-member-auth cookie, so we wrap the deep-link in a magic-link
          // verify URL — verify sets the cookie then 302s to the deposit page.
          // Legacy ranchers stay on the old per-tier Payment Link flow (the
          // depositMagicLinkUrl stays undefined so the email helper falls back
          // to its tap-any-tier copy).
          const rancherPricingModel = String(topMatch['Pricing Model'] || 'legacy');
          let depositMagicLinkUrl: string | undefined;
          // Guard empty buyerId/email — signing a token with `''` produces a
          // valid JWT that fails at getRecordById time on the verify handler,
          // surfacing as "expired link" in the buyer's UI. Better to skip the
          // CTA than ship a guaranteed-broken link.
          if (rancherPricingModel === 'tier_v2' && buyerId && buyerEmail) {
            const magicToken = generateMemberLoginToken(buyerId, buyerEmail);
            const nextPath = `/checkout/${referral.id}/deposit`;
            depositMagicLinkUrl = `${SITE_URL}/api/auth/member/verify?token=${magicToken}&next=${encodeURIComponent(nextPath)}`;
          }
          // Same try/catch + Telegram alert pattern as the rancher email.
          // The buyer-side intro is what actually shows them rancher contact
          // info in the dashboard email — a silent send failure here makes
          // the dashboard banner say "we just fired your intro" while the
          // buyer's inbox stays empty.
          //
          // 2026-06-09 sales-floor pivot: skip the buyer intro ONLY when
          // caller requested it AND the matched rancher is tier_v2 (Ben
          // handles sales calls for upgraded ranchers only). Legacy rancher
          // buyers always get the intro — they're handled off-platform.
          const matchedRancherPm = String(topMatch['Pricing Model'] || 'legacy').toLowerCase();
          const suppressBuyerIntro = !!body?.skipBuyerIntro && matchedRancherPm === 'tier_v2';
          if (!suppressBuyerIntro) try {
            await sendBuyerIntroNotification({
              firstName: buyerFirstName,
              email: buyerEmail,
              rancherName,
              rancherEmail,
              rancherPhone,
              rancherSlug: topMatch['Slug'] || '',
              loginUrl: buyerLoginUrl,
              // Pricing surfaced in-email so the buyer doesn't need to ask
              // "how much?" before reaching out. Big conversion friction remover.
              quarterPrice: Number(topMatch['Quarter Price']) || undefined,
              quarterLbs: topMatch['Quarter lbs'] || undefined,
              halfPrice: Number(topMatch['Half Price']) || undefined,
              halfLbs: topMatch['Half lbs'] || undefined,
              wholePrice: Number(topMatch['Whole Price']) || undefined,
              wholeLbs: topMatch['Whole lbs'] || undefined,
              nextProcessingDate: topMatch['Next Processing Date'] || undefined,
              readyToBuy: buyerReadyToBuy,
              // Tag Reply-To so any buyer reply lands in /api/webhooks/resend-inbound
              referralId: referral.id,
              // tier_v2 only — undefined for legacy ranchers (preserves the
              // tap-any-tier Payment Link copy in the email template).
              depositMagicLinkUrl,
              // Rancher's Cal.com slug — drives the "Schedule 15-min call" CTA.
              // Falsy → email falls back to email/phone contact box only.
              calComSlug: topMatch['Cal.com Slug'] || undefined,
              // Tier drives Cal CTA routing: 'Operator' routes buyers to Ben's
              // sales Cal instead of the rancher's slug. Airtable singleSelect
              // returns either a string or {name:string} object — handle both.
              rancherTier: (() => {
                const raw: any = topMatch['Tier'];
                if (!raw) return undefined;
                if (typeof raw === 'object' && 'name' in raw) return String(raw.name);
                return String(raw);
              })(),
            });
          } catch (e: any) {
            console.error('Buyer intro email failed:', e?.message);
            try {
              await sendTelegramMessage(
                TELEGRAM_ADMIN_CHAT_ID,
                `⚠️ <b>BUYER INTRO EMAIL FAILED</b>\n\n` +
                `Buyer: ${buyerName} (${buyerEmail})\n` +
                `Rancher: ${rancherName}\n` +
                `Error: ${e?.message || 'unknown'}\n\n` +
                `<i>Buyer is in Airtable as Intro Sent but their inbox stayed empty. Their dashboard /member will still show the rancher contact info if they log in.</i>`
              );
            } catch {}
          }

          // G14: SMS touchpoint right after buyer intro email. Industry +20-40%
          // conversion lift from SMS reminders post-intro. Fire-and-forget so a
          // Twilio outage can't block the matching pipeline.
          // F-3 / P4-D audit fix: routed through sendSMSToConsumer which gates on
          // explicit SMS Opt-In + Unsubscribed mirror. Pre-fix, every buyer w/
          // phone got SMS — TCPA exposure when TWILIO_* env vars flip on.
          // Now: no opt-in OR unsubscribed, no SMS, no exposure.
          if (buyerPhone) {
            try {
              const consumerForSms: any = await getRecordById(TABLES.CONSUMERS, buyerId);
              sendSMSToConsumer({
                consumer: consumerForSms,
                phone: buyerPhone,
                body: `hey ${buyerFirstName} — we just connected you w/ ${rancherName} for half-cow. they'll email you in the next 24h. reply STOP to opt out. — Ben @ BuyHalfCow`,
                reason: 'matching/suggest intro touchpoint',
              }).catch(() => {});
            } catch (e) {
              console.warn('[matching/suggest] SMS opt-in check failed:', e);
            }
          }
        }

        // H-2 audit fix: funnel event for the intro-fire moment. Pre-fix
        // /admin/funnel could see signup/engaged/transition but not the actual
        // "match emailed both sides" milestone — couldn't measure intro→close
        // rate. Now: every successful matching/suggest run records match_sent
        // tied to the new referral + rancher + buyer.
        try {
          await funnelRecord({
            stage: 'match_sent',
            referralId: referral.id,
            rancherId: topMatch.id,
            buyerId,
            metadata: {
              state: buyerState,
              matchType,
              rancherSlug: topMatch['Slug'] || '',
              readyToBuy: buyerReadyToBuy,
            },
          });
        } catch (e) { console.error('[funnel] match_sent failed:', e); }

        // Telegram noise reduction: per-match notifications were creating
        // dozens of pings/day with no required action. Routine matches now
        // roll into the morning digest only. The actionable moments
        // (sales, passes, hot leads, capacity issues, ready-to-buy) keep
        // their own loud alerts elsewhere in the codebase.
        // (intentionally no Telegram message here)
      } catch (e) {
        console.error('Error auto-approving match:', e);
      }
    } else {
      // No match found — waitlist the buyer. Buyer Stage falls back to WAITING
      // (no rancher available right now). The rancher-launch-warmup cron picks
      // them back up the moment a rancher activates in their state and bumps
      // them to READY.
      try {
        await updateRecord(TABLES.CONSUMERS, buyerId, {
          'Referral Status': 'Waitlisted',
          'Buyer Stage': 'WAITING',
          'Buyer Stage Updated At': new Date().toISOString(),
        });
      } catch (e) {
        console.error('Error updating consumer referral status:', e);
      }

      // F-1 audit fix: fire sendStateWaitlistLetter immediately at signup.
      // Pre-fix, buyer signed up in an uncovered state → Status=Waitlisted +
      // Buyer Stage=WAITING → NO email until reclassify-buyers cron segmented
      // them as STATE_WAITLIST + email-sequences fired the letter days later.
      // For cold paid-ad traffic this 24-48h silence was the bounce/trust hit.
      // Gate on Routing Segment Send Count == 0 so a buyer hitting the
      // endpoint twice (re-signup, retry) doesn't get the letter twice — the
      // email-sequences cron also honors this counter.
      if (buyerEmail) {
        try {
          const consumer = await getRecordById(TABLES.CONSUMERS, buyerId) as any;
          const segCount = Number(consumer?.['Routing Segment Send Count'] || 0);
          if (segCount === 0) {
            const firstName = String(buyerName || '').split(' ')[0] || 'there';
            sendStateWaitlistLetter({
              email: buyerEmail,
              firstName,
              buyerState: normalizedBuyerState,
            })
              .then(async () => {
                // Stamp the counter so email-sequences cron doesn't double-fire.
                try {
                  await updateRecord(TABLES.CONSUMERS, buyerId, {
                    'Routing Segment Send Count': 1,
                    'Routing Segment Last Sent At': new Date().toISOString(),
                  });
                } catch (e) {
                  console.error('[state-waitlist] segment counter stamp failed:', e);
                }
              })
              .catch(e => console.error('[state-waitlist] fire failed:', e));
          }
        } catch (e) {
          console.error('[state-waitlist] consumer fetch failed:', e);
        }
      }

      // Telegram noise reduction: routine no-match events roll into the
      // morning digest. Real-time pings for high-intent no-match were
      // dropped 2026-05-13 ahead of spike — at scale, every uncovered
      // state generates dozens of these per hour and clogged the chat.
      // batch-approve's waitlist-retry path re-routes them automatically
      // when a rancher comes online in the state, so the operator doesn't
      // need to act in real-time.
    }

    return NextResponse.json({
      success: true,
      referralId: referral.id,
      matchFound: !!topMatch,
      matchType,
      suggestedRancher: topMatch ? {
        id: topMatch.id,
        name: topMatch['Operator Name'] || topMatch['Ranch Name'],
        state: topMatch['State'],
        shipsNationwide: topMatch['Ships Nationwide'] === true,
        activeReferrals: finalActiveReferrals,
        maxReferrals: getMaxActiveReferrals(topMatch),
      } : null,
    });
  } catch (error: any) {
    // Sanitize: don't leak internals (Airtable record IDs, API token hints).
    console.error('Matching engine error:', error);
    return NextResponse.json({ error: 'Matching engine error — please retry.' }, { status: 500 });
  }
}
