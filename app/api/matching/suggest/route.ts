import { NextResponse } from 'next/server';
import { getAllRecords, createRecord, updateRecord, getRecordById } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { sendEmail, sendBuyerIntroNotification } from '@/lib/email';
import { normalizeState, normalizeStates } from '@/lib/states';
import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';
import { getMaxActiveReferrals } from '@/lib/rancherCapacity';
import { isRancherOperationalForBuyers } from '@/lib/rancherEligibility';

export const maxDuration = 60;

import { JWT_SECRET } from '@/lib/secrets';
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

    // Auth: admin cookie, internal-secret header, or admin password header.
    // Adding x-admin-password matches the convention in lib/adminAuth.ts so
    // operational scripts can run against prod with the same credential they
    // use for every other admin endpoint (no separate INTERNAL_API_SECRET
    // setup required).
    const internalSecret = process.env.INTERNAL_API_SECRET || '';
    const adminPassword = process.env.ADMIN_PASSWORD || '';
    const authHeader = request.headers.get('x-internal-secret') || '';
    const adminPwHeader = request.headers.get('x-admin-password') || '';
    const cookieStore = await cookies();
    const adminCookie = cookieStore.get('bhc-admin-auth');
    const isAdmin = adminCookie?.value === 'authenticated';
    const isInternal = internalSecret && authHeader === internalSecret;
    const isAdminPw = adminPassword && adminPwHeader === adminPassword;

    if (!isAdmin && !isInternal && !isAdminPw) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
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
    } = body;
    const excludeIds = new Set<string>(Array.isArray(excludeRancherIds) ? excludeRancherIds : []);
    const isHotLead = !!warmupEngaged;

    if (!buyerState || !buyerId) {
      return NextResponse.json({ error: 'buyerState and buyerId are required' }, { status: 400 });
    }

    // Normalize buyer state to canonical 2-letter code (handles "Montana" → "MT")
    const normalizedBuyerState = normalizeState(buyerState);
    if (!normalizedBuyerState) {
      return NextResponse.json({ error: `Unrecognized buyer state: ${buyerState}` }, { status: 400 });
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
          `{Buyer Email} = "${buyerEmail.trim().toLowerCase()}"`
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
          return NextResponse.json({
            success: true,
            matchFound: true,
            alreadyActive: true,
            referralId: active.id,
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

    // Helper: check if rancher is active, signed, and under capacity.
    // Also excludes any rancher in `excludeRancherIds` — used when re-routing
    // a lead that a rancher just passed on, so the same rancher doesn't get
    // the lead bounced right back to them.
    //
    // CAPACITY BYPASS for hot leads: when the buyer has explicitly opted in via
    // warmup engagement, we route to a state-matched rancher even if they're at
    // capacity. The cap exists to prevent "lead overload"; for a rare hand-raised
    // buyer, sitting in queue means going cold. We do enforce a 2× hard ceiling
    // so even hot-lead bypass can't unboundedly flood a rancher.
    const HARD_CEILING_MULTIPLIER = 2;
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

    // ── 5 BAR BEEF (FRANK FITZPATRICK) PER-RANCHER POLICY ────────────────
    // Frank only wants higher-commitment leads in CA: Half or Whole share
    // AND budget over $2000. Other CA ranchers are unaffected — non-
    // qualifying CA buyers still route to whoever else is available;
    // Frank's record just gets excluded from the candidate pool.
    //
    // Identifier: Slug is the canonical ID used everywhere else for
    // rancher lookup (see directMatchRancher below), so we match on it
    // first. We also fall back to a Ranch Name match on "5 Bar Beef" so
    // a slug rename for marketing doesn't silently undo this filter.
    // Operator Name is intentionally NOT used — nicknames and name
    // formatting drift more than business identity. If Frank's slug or
    // brand changes, update the two constants below.
    //
    // Only "$2000+" represents a budget strictly greater than $2000; the
    // other ranges all top out at or below $2000. "Unsure"/blank doesn't
    // qualify either — no committed budget = no Frank.
    const FIVE_BAR_BEEF_SLUG = '5-bar-beef';
    const FIVE_BAR_BEEF_NAME_REGEX = /5\s*bar\s*beef/i;
    const isFiveBarBeefRancher = (r: any): boolean => {
      const slug = (r['Slug'] || '').toString().trim().toLowerCase();
      const ranchName = (r['Ranch Name'] || '').toString();
      return slug === FIVE_BAR_BEEF_SLUG || FIVE_BAR_BEEF_NAME_REGEX.test(ranchName);
    };
    const buyerBudgetOver2k = (() => {
      const r = (budgetRange || '').trim().toLowerCase().replace(/\s/g, '');
      return r === '$2000+' || r === '2000+';
    })();
    const buyerTierIsHalfOrWhole = buyerTier === 'Half' || buyerTier === 'Whole';
    const buyerQualifiesForFiveBarBeef = buyerTierIsHalfOrWhole && buyerBudgetOver2k;
    const passesFiveBarBeefPolicy = (r: any): boolean => {
      if (!isFiveBarBeefRancher(r)) return true;
      return buyerQualifiesForFiveBarBeef;
    };

    // ── PRIORITY: If lead came from a specific rancher's page, assign to THAT rancher ──
    // Always assign to the page rancher — even at capacity. They clicked "Buy" on THIS rancher.
    // Only require Active + Agreement Signed (skip capacity check for direct page leads).
    let directMatchRancher: any = null;
    let matchType: string | null = null;
    if (campaign && campaign.startsWith('rancher-')) {
      const rancherSlug = campaign.replace('rancher-', '');
      directMatchRancher = allRanchers.find((r: any) => {
        const slug = r['Slug'] || '';
        const activeStatus = r['Active Status'] || '';
        const agreementSigned = r['Agreement Signed'] || false;
        const onboardingStatus = r['Onboarding Status'] || '';
        return slug === rancherSlug && activeStatus === 'Active' && agreementSigned &&
          (!onboardingStatus || onboardingStatus === 'Live');
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
        const routingRaw = (r['Routing States'] || '').toString().trim();
        const served = normalizeStates(routingRaw || r['States Served']);
        if (!(rState === normalizedBuyerState || served.includes(normalizedBuyerState))) return false;
        // Tier Specialty filter — see definition above. Quarter buyers won't
        // get routed to Half/Whole-only ranchers, etc. Empty Tier Specialty =
        // no filter applied (legacy default).
        if (!isTierFit(r)) return false;
        // 5 Bar Beef per-rancher policy — see helper above. Excludes Frank
        // from the candidate pool when the buyer doesn't meet his Half/Whole
        // + budget>$2000 bar. Other CA ranchers are unaffected.
        if (!passesFiveBarBeefPolicy(r)) return false;
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
      'Buyer Email': buyerEmail || '',
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
      'Match Type': matchType === 'direct' ? 'Direct (Rancher Page)' : 'Local',
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
    if (topMatch) {
      try {
        const currentRefs = topMatch['Current Active Referrals'] || 0;
        const newRefs = currentRefs + 1;
        await updateRecord(TABLES.RANCHERS, topMatch.id, {
          'Current Active Referrals': newRefs,
          'Last Assigned At': now,
        });

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
              await sendTelegramMessage(
                TELEGRAM_ADMIN_CHAT_ID,
                `🔥 <b>HOT-LEAD CAP BYPASS:</b> ${rancherName} (${rancherState}) is OVER cap at ${newRefs}/${maxRefs} — routed warmup-engaged buyer ${buyerName || ''} anyway. Hot opt-ins shouldn't sit in queue.\n<i>If ${rancherName} isn't responding, consider Pause from admin.</i>`
              );
            } catch (e) {
              console.error('Error sending hot-lead bypass alert:', e);
            }
          } else if (newRefs >= maxRefs) {
            // 100% — at capacity
            try {
              await sendTelegramMessage(
                TELEGRAM_ADMIN_CHAT_ID,
                `🔴 <b>AT CAPACITY:</b> ${rancherName} in ${rancherState} is FULL (${newRefs}/${maxRefs}). New <i>cold</i> leads will waitlist; warmup-engaged hot leads will continue routing.`
              );
            } catch (e) {
              console.error('Error sending capacity-full Telegram alert:', e);
            }
          } else if (capacityPct >= 0.8) {
            // 80%+ — warning
            try {
              await sendTelegramMessage(
                TELEGRAM_ADMIN_CHAT_ID,
                `⚠️ <b>CAPACITY ALERT:</b> ${rancherName} in ${rancherState} is at ${newRefs}/${maxRefs} referrals (80%+). Consider recruiting another rancher in ${rancherState}.`
              );
            } catch (e) {
              console.error('Error sending capacity-warning Telegram alert:', e);
            }
          }
        }
      } catch (e) {
        console.error('Error incrementing rancher referral count:', e);
      }
    }

    // ── AUTO-APPROVE: ALL matches get instant intro (no Telegram wait) ──
    // If a rancher matched, fire intros immediately. No manual approval friction.
    if (topMatch) {
      try {
        // Update referral to Intro Sent immediately
        await updateRecord(TABLES.REFERRALS, referral.id, {
          'Status': 'Intro Sent',
          'Rancher': [topMatch.id],
          'Approved At': now,
          'Intro Sent At': now,
        });

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
        let buyerReadyToBuy = false;
        try {
          const buyerRec: any = await getRecordById(TABLES.CONSUMERS, buyerId);
          buyerReadyToBuy = !!buyerRec['Ready to Buy'];
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
          try {
            await sendEmail({
              to: rancherEmail,
              subject: `${subjectPrefix}BuyHalfCow Introduction: ${buyerName} in ${buyerState}`,
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
          } catch (e: any) {
            console.error('Rancher intro email failed:', e?.message);
            try {
              await sendTelegramMessage(
                TELEGRAM_ADMIN_CHAT_ID,
                `⚠️ <b>RANCHER INTRO EMAIL FAILED</b>\n\n` +
                `Buyer: ${buyerName} (${buyerEmail})\n` +
                `Rancher: ${rancherName} (${rancherEmail})\n` +
                `Error: ${e?.message || 'unknown'}\n\n` +
                `<i>Referral was created in Airtable but the rancher never got the intro. Resend manually via /admin or paste the buyer info to ${rancherEmail} directly.</i>`
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
          // Same try/catch + Telegram alert pattern as the rancher email.
          // The buyer-side intro is what actually shows them rancher contact
          // info in the dashboard email — a silent send failure here makes
          // the dashboard banner say "we just fired your intro" while the
          // buyer's inbox stays empty.
          try {
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
        }

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

      // Telegram noise reduction: routine no-match events roll into the
      // morning digest. Only ping in real-time when the buyer is high-intent
      // (score >= 70) — that's when "no rancher available" is actually a
      // problem worth waking Ben up about.
      const isHighIntentNoMatch = (intentScore || 0) >= 70;
      try {
        if (isHighIntentNoMatch) {
          await sendTelegramMessage(
            TELEGRAM_ADMIN_CHAT_ID,
            `⏳ <b>HIGH-INTENT BUYER WAITLISTED</b>\n\n` +
          `👤 ${buyerName} in ${buyerState}\n` +
          `📦 ${orderType || 'Not specified'}\n` +
          `Buyer waitlisted — will auto-match when a rancher goes live in ${buyerState}.`
          );
        }
      } catch (e) {
        console.error('Error sending no-match Telegram notification:', e);
      }
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
        activeReferrals: topMatch['Current Active Referrals'] || 0,
        maxReferrals: getMaxActiveReferrals(topMatch),
      } : null,
    });
  } catch (error: any) {
    console.error('Matching engine error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
