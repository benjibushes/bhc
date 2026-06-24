import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendConsumerApproval, sendWaitlistEmail, sendBackfillEmail, sendRancherGoLiveEmail } from '@/lib/email';
import { sendTelegramUpdate, sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { sendOperatorSignal } from '@/lib/operatorSignal';
import { bulkRouteStateToRancher } from '@/lib/bulkRoute';
import { getOperationalServedStates } from '@/lib/rancherEligibility';
import { isQualifiedForRouting } from '@/lib/qualification';
import { HELD_REFERRAL_STATUSES } from '@/lib/capacityCount';
import { withCronRun } from '@/lib/cronRun';
import { triggerLaunchWarmup } from '@/lib/triggerLaunchWarmup';
import jwt from 'jsonwebtoken';

export const maxDuration = 120;

import { JWT_SECRET } from '@/lib/secrets';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Runs daily at 9 UTC (3 AM MT, before daily-digest at 14 UTC) — processes
// pending consumers who qualify for auto-approval and kicks off rancher
// matching for approved Beef Buyers.
//
// Cadence history: was `0 */2 * * *` (every 2h, 12 runs/day) through
// 2026-05-19. Audit found 11 of 12 daily runs wasted re-scanning the same
// stuck waitlist cohort (~33 buyers) — none ever qualified, none ever
// matched. Dropped to daily; re-warm-cohort cron now handles the stuck
// cohort reanimation that the 2h cadence was implicitly trying (and failing)
// to do.
async function realHandler(_request: Request): Promise<{ status: 'success' | 'partial' | 'maintenance-blocked'; recordsTouched: number; notes: string; skipReasonBreakdown?: Record<string, number> }> {
  // Maintenance short-circuit: do nothing while the platform is paused.
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }

  // ── CAPACITY COUNTER SELF-HEAL ──────────────────────────────────────────
    // The increment/decrement counter on ranchers can drift (missed decrements,
    // manual Airtable edits, etc.). Reconcile from actual active referrals so
    // the matching engine uses correct capacity numbers.
    let capacityFixed = 0;
    try {
      const allRanchers = await getAllRecords(TABLES.RANCHERS) as any[];
      const allReferrals = await getAllRecords(TABLES.REFERRALS) as any[];
      // Count held referrals per rancher using the CANONICAL rule (shared via
      // lib/capacityCount with capacity-drift-check, the admin-health readout,
      // and the Redis bootstrap): Status ∈ HELD_REFERRAL_STATUSES AND the
      // `Rancher` link includes the rancher id. Previously this billed
      // `(Rancher||Suggested)[0]` over a local status list — a DIFFERENT rule
      // than drift-check, so on any Suggested-linked or multi-id referral the
      // two reconcilers computed different numbers and overwrote each other
      // daily. Now they compute identically. Pending Approval stays excluded
      // (pre-INCR); Suggested-only rows are not billed (a held referral has
      // `Rancher` set once introduced).
      const actualCounts: Record<string, number> = {};
      for (const ref of allReferrals) {
        if (!HELD_REFERRAL_STATUSES.has(ref['Status'])) continue;
        const link = ref['Rancher'];
        if (!Array.isArray(link)) continue;
        for (const rId of link) {
          if (typeof rId === 'string') actualCounts[rId] = (actualCounts[rId] || 0) + 1;
        }
      }

      // Fix any rancher where the stored counter doesn't match reality
      for (const rancher of allRanchers) {
        const stored = rancher['Current Active Referrals'] || 0;
        const actual = actualCounts[rancher.id] || 0;
        if (stored !== actual) {
          try {
            await updateRecord(TABLES.RANCHERS, rancher.id, {
              'Current Active Referrals': actual,
            });
            capacityFixed++;
            console.log(`Capacity fix: ${rancher['Operator Name'] || rancher['Ranch Name']} ${stored} → ${actual}`);
          } catch (e: any) {
            console.error(`Capacity fix error for ${rancher.id}:`, e.message);
          }
        }
      }
      if (capacityFixed > 0) {
        await sendOperatorSignal({
          urgency: 'normal',
          kind: 'capacity',
          summary: `Capacity Self-Heal: fixed ${capacityFixed} rancher(s) with drifted referral counters.`,
        });
      }
    } catch (e: any) {
      console.error('Capacity self-heal error:', e.message);
    }

    // Get all unprocessed consumers — both explicit "Pending" AND blank-status
    // records. New signups arrive with no Status value and were previously being
    // silently skipped, stranding customers in a "can't log in" state.
    //
    // EXCLUDE abandoned-application stubs (they're handled by the email-sequences
    // cron which sends recovery emails — they should NEVER be auto-approved into
    // the network without finishing the real signup form).
    //
    // EXCLUDE quick-signup leads (Source='quick-signup'). They arrive with NO
    // State / Order Type / Phone — auto-approving them flips Status=Approved +
    // Buyer Stage=WAITING, but the warmup cron query requires a State predicate
    // so they stick at WAITING permanently and never get re-engaged. Better to
    // leave them in Status=Pending until they complete /access (which calls the
    // upgrade-stub path in /api/consumers and elevates them properly).
    const pending = await getAllRecords(
      TABLES.CONSUMERS,
      `AND(OR({Status} = "Pending", {Status} = "", {Status} = BLANK()), {Source} != "abandoned_application", {Source} != "quick-signup")`
    );

    if (pending.length === 0) {
      await sendTelegramUpdate('⏳ Batch approve ran — no pending consumers.');
      // Don't return yet — still need to retry waitlisted consumers below
    }

    // ── PRE-FIRE TELEGRAM (2026-06-05 hardening) ──────────────────────
    // Loud alert BEFORE the primary loop processes if the cohort is big.
    // Operator sees the planned scope + can flip MATCHING_ENABLED=false
    // to halt before emails go out. >10 pending = the "this might cascade"
    // threshold.
    if (pending.length > 10) {
      try {
        await sendTelegramUpdate(
          `📣 <b>BATCH-APPROVE PRE-FIRE</b>\n\n` +
            `About to process <b>${pending.length}</b> pending consumers.\n` +
            `Each may trigger matching/suggest → rancher intro email.\n\n` +
            `<i>If this is unexpected, set MATCHING_ENABLED=false in Vercel env NOW to halt. Otherwise this proceeds.</i>`,
        );
      } catch {}
    }

    // Kill-switch evaluated at loop entry. Lets operator halt mid-cron run.
    if (process.env.MATCHING_ENABLED === 'false') {
      await sendTelegramUpdate('⛔ batch-approve HALTED — MATCHING_ENABLED=false in env.');
      return {
        status: 'partial' as const,
        recordsTouched: 0,
        notes: 'halted via MATCHING_ENABLED=false kill switch',
      };
    }

    let approved = 0;
    let matched = 0;
    const errors: string[] = [];

    for (const consumer of pending as any[]) {
      try {
        const intentClassification = consumer['Intent Classification'] || '';
        // Derive segment: use stored Segment field if present, otherwise infer from Order Type/Budget
        // (existing records pre-date the Segment field being added to Airtable)
        const rawSegment = consumer['Segment'] || '';
        const hasBeefBuyerSignals = !!(consumer['Order Type'] || consumer['Budget']);
        const segment = rawSegment || (hasBeefBuyerSignals ? 'Beef Buyer' : 'Community');
        const email = consumer['Email'];
        const firstName = (consumer['Full Name'] || '').split(' ')[0];
        const consumerId = consumer['id'];

        // Approve ALL consumers — no intent gate
        const now = new Date().toISOString();
        // Default Buyer Stage to WAITING on approval — matching/suggest below
        // overrides to MATCHED if it routes successfully, or keeps WAITING if no
        // rancher available. Without this default, batch-approved buyers enter
        // the system with empty Buyer Stage and the state-machine cron skips
        // them. Safe default: every approved buyer has SOME stage assigned.
        await updateRecord(TABLES.CONSUMERS, consumerId, {
          'Status': 'Approved',
          'Approved At': now,
          'Buyer Stage': 'WAITING',
          'Buyer Stage Updated At': now,
        });

        // Generate login URL for all consumers with email
        const loginUrl = email ? `${SITE_URL}/member/verify?token=${jwt.sign(
          { type: 'member-login', consumerId, email: email.trim().toLowerCase() },
          JWT_SECRET,
          { expiresIn: '7d' }
        )}` : '';

        // Send magic link email + backfill survey for anyone missing order details
        if (email) {
          try {
            await sendConsumerApproval({ firstName, email, loginUrl, segment });
          } catch (emailErr) {
            console.error(`Failed to send approval email to ${email}:`, emailErr);
          }

          // Send backfill survey if we don't know what they want yet
          const missingOrderDetails = !consumer['Order Type'] && !consumer['Budget'];
          if (missingOrderDetails) {
            try {
              await sendBackfillEmail({ firstName, email, loginUrl });
            } catch (emailErr) {
              console.error(`Failed to send backfill email to ${email}:`, emailErr);
            }
          }
        }

        approved++;

        // Trigger matching for Beef Buyers
        if (segment === 'Beef Buyer' && consumer['State']) {
          try {
            const matchRes = await fetch(`${SITE_URL}/api/matching/suggest`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(process.env.INTERNAL_API_SECRET ? { 'x-internal-secret': process.env.INTERNAL_API_SECRET } : {}),
              },
              body: JSON.stringify({
                buyerState: consumer['State'],
                buyerId: consumerId,
                buyerName: consumer['Full Name'],
                buyerEmail: email,
                buyerPhone: consumer['Phone'],
                orderType: consumer['Order Type'],
                budgetRange: consumer['Budget'],
                intentScore: consumer['Intent Score'],
                intentClassification,
                notes: consumer['Notes'],
              }),
            });
            if (matchRes.ok) {
              const matchData = await matchRes.json().catch(() => ({}));
              // MISMATCH FIX: prior heuristic counted referralId presence
              // as "matched". But matching/suggest creates a Status=Waitlisted
              // referral row even when no rancher accepts the lead — so
              // referralId was set in BOTH match AND waitlist outcomes.
              // Result: Telegram digest claimed "X matched" while Airtable
              // had X waitlisted rows. Use matching/suggest's canonical
              // response shape: matchFound=true AND !waitlisted.
              const didMatch = !!(matchData.matchFound && !matchData.waitlisted);
              if (didMatch) {
                matched++;
              } else {
                // No rancher available in their state — waitlist them.
                // MISMATCH FIX: stamp Sequence Stage='waitlisted' BEFORE the
                // email send. Prior order sent email then stamped; if the
                // stamp write threw, the next cron run saw stage != waitlisted
                // and re-sent the same waitlist email → buyer received the
                // "we're looking for a rancher" letter on consecutive days.
                const currentStage = consumer['Sequence Stage'] || 'none';
                if (currentStage !== 'waitlisted' && email) {
                  await updateRecord(TABLES.CONSUMERS, consumerId, { 'Sequence Stage': 'waitlisted' });
                  await sendWaitlistEmail({ firstName, email, state: consumer['State'], loginUrl });
                }
              }
            } else {
              // Match API error — still no rancher, notify via waitlist
              const currentStage = consumer['Sequence Stage'] || 'none';
              if (currentStage !== 'waitlisted' && email) {
                await updateRecord(TABLES.CONSUMERS, consumerId, { 'Sequence Stage': 'waitlisted' });
                await sendWaitlistEmail({ firstName, email, state: consumer['State'], loginUrl });
              }
            }
          } catch (matchErr: any) {
            // 2026-06-09 P1 fix (audit BUG #2): matching/suggest failures
            // were swallowed silently. Buyer stayed in Waitlisted forever,
            // ops never noticed until a manual audit. Now: Telegram alert
            // per-failure (debounced via errors array) so ops sees stuck
            // cohorts immediately.
            console.error(`Matching error for consumer ${consumerId}:`, matchErr);
            errors.push(`${consumer['Full Name'] || consumerId}: ${matchErr?.message || 'unknown'}`);
          }
        }
      } catch (err: any) {
        console.error(`Error processing consumer ${consumer['id']}:`, err);
        errors.push(consumer['Full Name'] || consumer['id']);
      }

      // Respect Airtable's 5 req/sec limit — each consumer makes ~3-4 calls
      await sleep(250);
    }

    // ── Auto-go-live for verified ranchers with complete pages ──────────────
    let ranchersGoLive = 0;
    try {
      const allRanchers = await getAllRecords(TABLES.RANCHERS) as any[];
      const readyToGoLive = allRanchers.filter((r: any) => {
        if (r['Onboarding Status'] !== 'Verification Complete') return false;
        if (r['Page Live'] === true) return false;
        // Required: Slug + a way to collect payment. About Text is NOT required —
        // the wizard never makes it mandatory and rancher-go-live-sync doesn't gate
        // on it, so requiring it here silently stranded ranchers who finished
        // everything else but left About blank.
        if (!r['Slug']) return false;
        // tier_v2 ranchers collect via Stripe Connect deposits, not a legacy
        // Payment Link — accept an active Connect account as equivalent, else
        // every tier_v2 rancher is permanently blocked from auto-go-live.
        const hasPaymentLink = !!(r['Quarter Payment Link'] || r['Half Payment Link'] || r['Whole Payment Link']);
        const pricingModel = String(r['Pricing Model'] || 'legacy').toLowerCase();
        const connectStatus = String(r['Stripe Connect Status'] || '').toLowerCase();
        const canCollectPayment =
          hasPaymentLink || (pricingModel === 'tier_v2' && connectStatus === 'active');
        if (!canCollectPayment) return false;
        return true;
      });

      for (const rancher of readyToGoLive) {
        try {
          await updateRecord(TABLES.RANCHERS, rancher.id, {
            'Page Live': true,
            'Onboarding Status': 'Live',
            'Active Status': 'Active',
          });
          triggerLaunchWarmup(`batch-approve-auto-go-live:${rancher.id}`);

          const email = rancher['Email'];
          const operatorName = rancher['Operator Name'] || rancher['Ranch Name'] || 'Partner';
          const ranchName = rancher['Ranch Name'] || '';
          if (email) {
            await sendRancherGoLiveEmail({
              operatorName,
              ranchName,
              email,
              dashboardUrl: `${SITE_URL}/rancher`,
            });
          }
          ranchersGoLive++;

          // ── AUTO-ROUTE STUCK BUYERS to this newly-live rancher ─────────
          // For every state this rancher serves, find stuck buyers and connect them.
          // Schedules emails for 9am MT next morning so we never spam buyers at 3am.
          try {
            // Admin-gated served states (home-only by default; multi-state only
            // when Admin Approved Multi-State=true) — NOT the rancher-editable
            // States Served, which would let a rancher self-route cross-state.
            const servedStates = getOperationalServedStates(rancher);
            const tomorrow9amMT = (() => {
              const d = new Date();
              // 9am MT = 15:00 UTC (MDT) or 16:00 UTC (MST). Use 15:00 UTC as the safe slot.
              d.setUTCDate(d.getUTCDate() + 1);
              d.setUTCHours(15, 0, 0, 0);
              return d.toISOString();
            })();
            for (const stateCode of servedStates) {
              try {
                const result = await bulkRouteStateToRancher({
                  state: stateCode,
                  rancherSlug: rancher['Slug'] || '',
                  dryRun: false,
                  scheduledAt: tomorrow9amMT,
                });
                if (result.ok && (result.summary.processed > 0)) {
                  await sendTelegramMessage(
                    TELEGRAM_ADMIN_CHAT_ID,
                    `🚀 <b>AUTO-ROUTED on go-live</b>\n\n` +
                    `${operatorName} (${ranchName}) just went LIVE in ${stateCode}\n\n` +
                    `✅ Processed: ${result.summary.processed} stuck buyers\n` +
                    `🔄 Updated stuck refs: ${result.summary.updated_stuck_referral}\n` +
                    `🆕 New refs: ${result.summary.created_new_referral}\n` +
                    `📧 Emails scheduled for 9am MT tomorrow\n` +
                    `${result.summary.errors.length > 0 ? `⚠️ Errors: ${result.summary.errors.length}` : '✨ No errors'}`
                  );
                }
              } catch (e: any) {
                console.error(`Auto-route on go-live (${stateCode}) error:`, e.message);
              }
            }
          } catch (e: any) {
            console.error('Auto-route on go-live (outer) error:', e.message);
          }
        } catch (e: any) {
          console.error('Auto-go-live error:', e.message);
        }
      }
    } catch (e: any) {
      console.error('Auto-go-live query error:', e.message);
    }

    // ── WAITLISTED CONSUMER RETRY (THROTTLED + WARMUP-PRIORITIZED) ─────────
    // Hard caps keep ranchers from getting flooded when many waitlisted buyers
    // become eligible at once. Priority order:
    //   1. Buyers who clicked the warmup engagement link (already said YES)
    //   2. Buyers warmed 3+ days ago (had time to react)
    //   3. Brand-new buyers (no warmup needed — their state was always served)
    //   4. Waitlisted buyers in newly-served states whose warmup hasn't fired yet
    //      get SKIPPED here — they belong to the rancher-launch-warmup cron.
    const DAILY_INTRO_CAP = 25;
    const PER_RANCHER_DAILY_CAP = 5;
    const WARMUP_GRACE_DAYS = 3;
    let waitlistedRetried = 0;
    let waitlistedMatched = 0;
    let cappedSkipped = 0;
    let unqualifiedSkipped = 0;
    const unqualifiedReasons: Record<string, number> = {};
    try {
      // Pull broader candidate set than before — Segment may be empty even when
      // a buyer has Order Type/Budget signals (the silent-exclusion bug we just
      // fixed in lib/qualification.ts via inference). Filter strictly using
      // isQualifiedForRouting() below.
      const waitlisted = await getAllRecords(
        TABLES.CONSUMERS,
        `AND({Status} = "Approved", OR({Referral Status} = "Waitlisted", {Referral Status} = "Unmatched"))`
      ) as any[];

      const tier = (c: any): number => {
        // Priority 0: explicitly engaged with warmup. Hot.
        if (c['Warmup Engaged At']) return 0;
        // Priority 1: brand-new high-intent buyer (signed up in last 14 days).
        // Their signup IS consent. The qualification gate already verified.
        const created = c['Created'] || c['Created Time'] || c['createdTime'] || c._createdTime;
        if (created) {
          const ageMs = Date.now() - new Date(created).getTime();
          if (ageMs >= 0 && ageMs <= 14 * 24 * 60 * 60 * 1000) return 1;
        }
        // Anyone else passing the qualification gate is priority 2 (last).
        return 2;
      };

      // Sort by tier (lower = higher priority), then intent score desc
      const queue = waitlisted
        .map((c: any) => ({ c, t: tier(c) }))
        .sort((a, b) => a.t - b.t || (b.c['Intent Score'] || 0) - (a.c['Intent Score'] || 0));

      const perRancherToday = new Map<string, number>();

      for (let qIdx = 0; qIdx < queue.length; qIdx++) {
        const consumer = queue[qIdx].c;
        if (waitlistedMatched >= DAILY_INTRO_CAP) {
          // FIX 2026-05-19: previously computed `cappedSkipped = queue.length
          // - waitlistedRetried - unqualifiedSkipped`. That mixed buckets —
          // unreached unqualified buyers (later in the queue) got counted as
          // "cap-deferred" instead of "no consent signal". Count ONLY the
          // remaining buyers who WOULD have qualified.
          for (let j = qIdx; j < queue.length; j++) {
            const q = isQualifiedForRouting(queue[j].c);
            if (q.ok) cappedSkipped++;
          }
          break;
        }
        const cState = consumer['State'];
        if (!cState) continue;
        const existingRefStatus = consumer['Referral Status'] || '';
        if (['Intro Sent', 'Rancher Contacted', 'Negotiation'].includes(existingRefStatus)) continue;

        // ── QUALIFICATION GATE ──────────────────────────────────────────
        // Only buyers who have actively raised their hand get routed.
        // No more "matched on day 3 because warmup was sent" — we route ONLY
        // engaged buyers + fresh hot signups.
        const qual = isQualifiedForRouting(consumer);
        if (!qual.ok) {
          unqualifiedSkipped++;
          const r = qual.reason || 'unknown';
          unqualifiedReasons[r] = (unqualifiedReasons[r] || 0) + 1;
          continue;
        }

        waitlistedRetried++;
        // Hot-lead override: warmup-engaged buyers (clicked YES on a launch
        // warmup) are time-sensitive and rare. They bypass the rancher's soft
        // capacity cap AND the per-rancher daily cap, so they don't sit in
        // queue going cold. matching/suggest still enforces a 2× hard ceiling
        // and fires a Telegram alert when the bypass triggers.
        const isHotLead = !!consumer['Warmup Engaged At'];
        try {
          const matchRes = await fetch(`${SITE_URL}/api/matching/suggest`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(process.env.INTERNAL_API_SECRET ? { 'x-internal-secret': process.env.INTERNAL_API_SECRET } : {}),
            },
            body: JSON.stringify({
              buyerState: cState,
              buyerId: consumer.id,
              buyerName: consumer['Full Name'],
              buyerEmail: consumer['Email'],
              buyerPhone: consumer['Phone'],
              orderType: consumer['Order Type'],
              budgetRange: consumer['Budget'],
              intentScore: consumer['Intent Score'],
              intentClassification: consumer['Intent Classification'] || '',
              notes: consumer['Notes'],
              warmupEngaged: isHotLead,
              // Cold leads honor the per-rancher daily cap; hot leads bypass it
              // (we want every YES-clicker connected the morning the cron runs,
              // not throttled across days).
              excludeRancherIds: isHotLead
                ? []
                : Array.from(perRancherToday.entries())
                    .filter(([, n]) => n >= PER_RANCHER_DAILY_CAP)
                    .map(([id]) => id),
            }),
          });
          if (matchRes.ok) {
            const matchData = await matchRes.json().catch(() => ({}));
            if (matchData.matchFound || matchData.referralId) {
              waitlistedMatched++;
              const rid = matchData.suggestedRancher?.id;
              if (rid) perRancherToday.set(rid, (perRancherToday.get(rid) || 0) + 1);
              // Mark warmup as matched so we don't re-warm
              if (consumer['Warmup Sent At']) {
                try {
                  await updateRecord(TABLES.CONSUMERS, consumer.id, { 'Warmup Stage': 'matched' });
                } catch { /* non-fatal */ }
              }
            }
          }
        } catch (e: any) {
          console.error(`Waitlist retry error for ${consumer.id}:`, e.message);
        }
        await sleep(300);
      }

      if (waitlistedRetried > 0 || cappedSkipped > 0 || unqualifiedSkipped > 0) {
        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          `🔄 <b>Waitlist Retry (throttled)</b>\n\n` +
          `Processed: ${waitlistedRetried} of ${queue.length} eligible\n` +
          `✅ Matched: ${waitlistedMatched} (cap ${DAILY_INTRO_CAP}/day)\n` +
          `⏳ Still waiting: ${waitlistedRetried - waitlistedMatched}\n` +
          (cappedSkipped > 0 ? `🛑 Deferred to tomorrow: ${cappedSkipped}\n` : '') +
          (unqualifiedSkipped > 0
            ? `🚫 Skipped (no engagement signal): ${unqualifiedSkipped}\n` +
              `   ${Object.entries(unqualifiedReasons).slice(0, 3).map(([r, n]) => `${r}=${n}`).join(' · ')}`
            : '')
        );
      }
    } catch (e: any) {
      console.error('Waitlisted retry error:', e.message);
    }

    const summary = `✅ <b>Batch Approval Complete</b>

📥 Pending reviewed: ${pending.length}
✅ Approved: ${approved}
🤝 Matched to ranchers: ${matched}${ranchersGoLive > 0 ? `\n🚀 Ranchers auto-published: ${ranchersGoLive}` : ''}${waitlistedMatched > 0 ? `\n🔄 Waitlisted re-matched: ${waitlistedMatched}/${waitlistedRetried}` : ''}${capacityFixed > 0 ? `\n🔧 Capacity counters fixed: ${capacityFixed}` : ''}${errors.length > 0 ? `\n⚠️ Errors: ${errors.length} (${errors.slice(0, 3).join(', ')})` : ''}`;

    await sendTelegramUpdate(summary);

  return {
    status: errors.length > 0 ? 'partial' : 'success',
    recordsTouched: approved + matched + ranchersGoLive + waitlistedMatched + capacityFixed,
    notes: `approved=${approved} matched=${matched} live=${ranchersGoLive} waitlist=${waitlistedMatched}/${waitlistedRetried} capFix=${capacityFixed} errs=${errors.length} unqualified=${unqualifiedSkipped} capped=${cappedSkipped}`,
    skipReasonBreakdown: Object.keys(unqualifiedReasons).length > 0 ? unqualifiedReasons : undefined,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${cronSecret}`) {
      const { searchParams } = new URL(request.url);
      const secret = searchParams.get('secret');
      if (secret !== cronSecret) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }
  }
  return withCronRun('batch-approve', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
