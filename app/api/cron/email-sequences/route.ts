import { NextResponse } from 'next/server';
import { getAllRecords, getRecordById, updateRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendTelegramUpdate } from '@/lib/telegram';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import {
  sendAbandonedRecoveryEmail,
  sendEmail,
  sendFounderLetterWaiting,
  sendMatchedDay4CheckIn,
  sendCutsEducation,
  sendClosedMonthlyLetter,
  sendRepeatPurchaseAsk,
  sendMatchNowRescue,
  sendBuyerIntroNotification,
  sendNudgeToEngage,
  sendWarmLeadReadyCheck,
  sendNoBudgetFounderPitch,
  sendStateWaitlistLetter,
  sendIncompleteProfileAsk,
} from '@/lib/email';
import { sendOperatorSignal } from '@/lib/operatorSignal';
import { normalizeState, normalizeStates } from '@/lib/states';
import { isRancherOperationalForBuyers } from '@/lib/rancherEligibility';

import jwt from 'jsonwebtoken';

// Bumped from 60s — the cron iterates 1200+ approved consumers and was
// timing out daily for a week, leaving 955 buyers stuck in 'none' stage.
// 180s leaves headroom for ~75 emails + Airtable updates per run.
export const maxDuration = 180;

import { JWT_SECRET, generateMemberLoginToken } from '@/lib/secrets';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
const DAY_MS = 24 * 60 * 60 * 1000;

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function makeLoginUrl(consumerId: string, email: string) {
  const token = jwt.sign(
    { type: 'member-login', consumerId, email: email.trim().toLowerCase() },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  return `${SITE_URL}/member/verify?token=${token}`;
}

// Runs daily at 10am MT (16:00 UTC) — after batch-approve at 9am MT
// Sends drip emails to consumers based on how long they've been approved
async function realHandler(_request: Request): Promise<{ status: 'success' | 'partial' | 'maintenance-blocked'; recordsTouched: number; notes: string; skipReasonBreakdown?: Record<string, number> }> {
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }

  const skipReasons: Record<string, number> = {};
  const now = Date.now();

    // ── ABANDONED APPLICATION RECOVERY ────────────────────────────────────
    // 3-email recapture sequence for visitors who entered email on /access
    // but didn't complete the form. Industry recovery rate: 8-15%.
    // Records are created by /api/abandoned-app with Source='abandoned_application'
    // and Sequence Stage='abandoned_pending'.
    let abandonedRecovered = 0;
    try {
      const abandoned = await getAllRecords(
        TABLES.CONSUMERS,
        `AND({Source} = "abandoned_application", {Status} != "Approved")`
      ) as any[];
      const ABANDON_LIMIT_PER_RUN = 30;
      let abandonSent = 0;
      for (const rec of abandoned) {
        if (abandonSent >= ABANDON_LIMIT_PER_RUN) break;
        if (rec['Unsubscribed']) {
          skipReasons['unsubscribed'] = (skipReasons['unsubscribed'] || 0) + 1;
          continue;
        }
        const email = (rec['Email'] || '').trim().toLowerCase();
        if (!email) continue;
        const stage = rec['Sequence Stage'] || 'abandoned_pending';
        const createdAt = new Date(rec.createdTime || rec._createdTime || 0).getTime();
        const lastSent = rec['Sequence Sent At'] ? new Date(rec['Sequence Sent At']).getTime() : 0;
        const ageHours = (now - createdAt) / (60 * 60 * 1000);
        const hoursSinceLast = lastSent ? (now - lastSent) / (60 * 60 * 1000) : Infinity;
        const firstName = (rec['Full Name'] || '').replace('(abandoned signup)', '').split(' ')[0] || '';

        let send: 1 | 2 | 3 | null = null;
        let nextStage = '';
        if (stage === 'abandoned_pending' && ageHours >= 24) {
          send = 1; nextStage = 'abandoned_email1_sent';
        } else if (stage === 'abandoned_email1_sent' && hoursSinceLast >= 72) {
          send = 2; nextStage = 'abandoned_email2_sent';
        } else if (stage === 'abandoned_email2_sent' && hoursSinceLast >= 7 * 24) {
          send = 3; nextStage = 'abandoned_email3_sent';
        }

        if (!send) {
          skipReasons['cadence-not-due'] = (skipReasons['cadence-not-due'] || 0) + 1;
          continue;
        }

        try {
          // MISMATCH FIX: stamp Sequence Stage + Sent At BEFORE send. Prior
          // order sent email first → if Airtable stamp threw, next run repeated
          // the same email (buyer received "abandoned cart" reminder twice).
          await updateRecord(TABLES.CONSUMERS, rec.id, {
            'Sequence Stage': nextStage,
            'Sequence Sent At': new Date().toISOString(),
          });
          await sendAbandonedRecoveryEmail({ email, firstName, stage: send });
          abandonedRecovered++;
          abandonSent++;
        } catch (e: any) {
          console.error('Abandoned recovery email error:', e?.message);
        }
      }
    } catch (e: any) {
      console.error('Abandoned recovery query error:', e?.message);
    }

    // Fetch all approved consumers + active ranchers once
    const approvedRaw = await getAllRecords(TABLES.CONSUMERS, '{Status} = "Approved"') as any[];
    // Skip unsubscribed consumers
    const approved = approvedRaw.filter((c: any) => !c['Unsubscribed']);
    const activeRanchers = await getAllRecords(TABLES.RANCHERS, '{Active Status} = "Active"') as any[];

    // Cache active referrals ONCE (was re-fetched per Day-7 buyer inside the
    // loop — turned a 500ms call into 50 × 500ms = 25s per cron run, the
    // primary timeout cause). Now indexed by buyer ID for O(1) lookup.
    const activeReferralsRaw = await getAllRecords(
      TABLES.REFERRALS,
      'OR({Status} = "Intro Sent", {Status} = "Rancher Contacted")'
    ) as any[];
    const referralsByBuyer = new Map<string, any>();
    for (const r of activeReferralsRaw) {
      const buyerIds = r['Buyer'] || [];
      const id = Array.isArray(buyerIds) ? buyerIds[0] : null;
      if (id && !referralsByBuyer.has(id)) referralsByBuyer.set(id, r);
    }

    // Helper: does this consumer have a rancher available IN THEIR STATE?
    // Local-only routing policy — Ships Nationwide is no longer honored.
    // Checks both primary State and States Served (multi-state ranchers).
    //
    // Uses normalizeState() so "Montana" (full name) and "MT" (abbreviation)
    // both resolve to the same canonical 2-letter code. Without this, buyers
    // who entered their state as "Montana" got compared against rancher states
    // stored as "MT" and silently failed — stranded in nurture forever.
    //
    // Also enforces the unified rancher-eligibility check, NOT just Active
    // Status. Otherwise a rancher who's Active but hasn't signed/onboarded
    // would qualify here while being rejected by the actual matching engine.
    function hasRancherAvailable(consumerState: string): boolean {
      const target = normalizeState(consumerState || '');
      if (!target) return false;
      return activeRanchers.some((r: any) => {
        if (!isRancherOperationalForBuyers(r)) return false;
        const primary = normalizeState(r['State'] || '');
        if (primary === target) return true;
        const served = normalizeStates(r['States Served'] || '');
        return served.includes(target);
      });
    }

    // ── Buyer Stage state-machine driver (the rebuilt cron heart) ────────────
    // Replaces the prior parallel nurture/segment/intro-checkin tangle. One
    // pass over `approved`, branches by Buyer Stage, fires the stage-relative
    // milestone email when it's due AND not already sent. Sequence Stage is
    // reused as the per-stage progress marker (legacy values are ignored
    // because new ones are stage-prefixed: WAITING_L1, READY_NUDGE,
    // MATCHED_D4, CLOSED_CUTS, CLOSED_REPEAT, etc).
    //
    // Buyer Stage Updated At anchors days-in-stage. Buyers entered the system
    // via the migration script all share the migration timestamp — gives a
    // clean baseline so no one gets day-7 emails on day 0 of cutover.

    const counters = {
      waiting_l1: 0, waiting_l2: 0, waiting_monthly: 0,
      ready_nudge: 0,
      matched_d4: 0,
      closed_cuts: 0, closed_monthly: 0, closed_repeat: 0,
    };
    let errors = 0;
    const MAX_EMAILS_PER_RUN = 50;
    let totalSent = 0;
    let sentBeforeIter = 0;

    // Pre-compute: which buyers have a Closed Won referral (for CLOSED-purchased branch)
    // and what's their rancher's name (for re-engagement copy)
    const buyerClosedWonRancher = new Map<string, string>(); // consumerId -> rancherName
    const buyerActiveRancher = new Map<string, string>();    // consumerId -> rancherName
    {
      const allRefs = await getAllRecords(TABLES.REFERRALS) as any[];
      for (const ref of allRefs) {
        const buyerIds = ref['Buyer'] || [];
        if (!buyerIds.length) continue;
        const bid = buyerIds[0];
        const status = ref['Status'] || '';
        const rancherName = ref['Suggested Rancher Name'] || 'your rancher';
        if (status === 'Closed Won' && !buyerClosedWonRancher.has(bid)) {
          buyerClosedWonRancher.set(bid, rancherName);
        }
        if (
          (status === 'Intro Sent' || status === 'Rancher Contacted' ||
           status === 'Negotiation' || status === 'Pending Approval') &&
          !buyerActiveRancher.has(bid)
        ) {
          buyerActiveRancher.set(bid, rancherName);
        }
      }
    }

    // Routing-segment counters (added 2026-05-22). Separate from the legacy
    // stage counters because these emails branch on Routing Segment (set
    // nightly by reclassify-buyers), not on Buyer Stage.
    const segmentCounters: Record<string, number> = {
      match_now_rescue: 0,
      nudge_to_engage: 0,
      warm_lead_check: 0,
      no_budget_founder_pitch: 0,
      state_waitlist: 0,
      incomplete_profile: 0,
      // LOCK-aware skip counter (2026-06-06): buyers w/ locked active
      // referral elsewhere skipped to avoid double-routing.
      match_now_locked_skip: 0,
    };

    for (const consumer of approved) {
      if (totalSent >= MAX_EMAILS_PER_RUN) break;
      try {
        const email = consumer['Email'];
        if (!email) continue;
        const consumerId = consumer.id;
        const firstName = (consumer['Full Name'] || '').split(' ')[0] || 'there';
        const stateLabel = consumer['State'] || 'your state';
        const buyerStage = (consumer['Buyer Stage'] || '').toString();
        const seqStage = (consumer['Sequence Stage'] || '').toString();
        const stageEnteredRaw = consumer['Buyer Stage Updated At'];
        if (!buyerStage || !stageEnteredRaw) {
          skipReasons['segment-mismatch'] = (skipReasons['segment-mismatch'] || 0) + 1;
          continue; // not migrated yet — skip safely
        }
        const daysInStage = (now - new Date(stageEnteredRaw).getTime()) / DAY_MS;

        // 24h frequency gate — never two automated emails to same buyer in 1 day
        const lastSentAt = consumer['Sequence Sent At'];
        if (lastSentAt && (now - new Date(lastSentAt).getTime()) < DAY_MS) {
          skipReasons['cap-suppressed'] = (skipReasons['cap-suppressed'] || 0) + 1;
          continue;
        }

        let fired = false;

        // ── ROUTING-SEGMENT BRANCH ──────────────────────────────────────────
        // Pre-stage email driven by lib/routingSegment.ts classification.
        // Runs BEFORE the legacy stage-machine branch so segment-specific
        // emails take priority when applicable. Each segment caps its own
        // send count + cadence via Routing Segment Send Count + Routing
        // Segment Last Sent At fields.
        const segmentRaw = consumer['Routing Segment'];
        const segment =
          typeof segmentRaw === 'object' && segmentRaw !== null && 'name' in segmentRaw
            ? String((segmentRaw as any).name || '')
            : String(segmentRaw || '');
        const segmentCount = Number(consumer['Routing Segment Send Count'] || 0);
        const segmentLastSentRaw = consumer['Routing Segment Last Sent At'];
        const segmentLastSent = segmentLastSentRaw ? new Date(segmentLastSentRaw).getTime() : 0;
        const daysSinceSegmentSend = segmentLastSent ? (now - segmentLastSent) / DAY_MS : Infinity;
        const buyerStateNorm = (consumer['State'] || '').toString().toUpperCase().slice(0, 2);

        if (segment === 'MATCH_NOW' && segmentCount < 1) {
          // LOCK pre-check (2026-06-06): if buyer has a locked active
          // referral (Rancher Contacted / Negotiation / Awaiting Payment)
          // elsewhere, skip MATCH_NOW entirely. They're already in real
          // conversation w/ a rancher — auto-routing them now overlaps
          // leads + frustrates everyone. Operator can revisit via /admin.
          try {
            const { LOCKED_STATUSES } = await import('@/lib/referralLock');
            const allRefsForLockCheck = (await getAllRecords(TABLES.REFERRALS)) as any[];
            const hasLockedActive = allRefsForLockCheck.some((r: any) => {
              const buyers = Array.isArray(r['Buyer']) ? r['Buyer'] : [];
              if (!buyers.includes(consumerId)) return false;
              return LOCKED_STATUSES.has(String(r['Status'] || ''));
            });
            if (hasLockedActive) {
              console.log(`[match-now] LOCK skip — ${consumerId} (${email}) has a locked active referral elsewhere`);
              segmentCounters.match_now_locked_skip = (segmentCounters.match_now_locked_skip || 0) + 1;
              continue;
            }
          } catch (e: any) {
            console.warn('[match-now LOCK check] failed:', e?.message);
          }

          // AUTO-ROUTE: fire matching/suggest directly. If a rancher is
          // available the endpoint auto-stages a referral + fires intro
          // emails to both sides — no operator tap, zero gate. If no
          // rancher available (state uncovered, all over cap), fall back
          // to sendMatchNowRescue + Telegram alert w/ /match selector
          // suggestion so the operator can pick an alternative.
          let autoRouted = false;

          // PRE-CHECK: existing Pending Approval rows. matching/suggest
          // returns alreadyActive for any buyer w/ a non-closed referral
          // and won't promote Pending Approval to Intro Sent — so the
          // referral would stay stuck forever. Catch + promote here
          // (mirrors /bulkfire telegram command logic) before falling
          // through to matching/suggest.
          try {
            const allRefs = (await getAllRecords(TABLES.REFERRALS)) as any[];
            const stuckRef = allRefs.find((r: any) => {
              if (r['Status'] !== 'Pending Approval') return false;
              const buyers = Array.isArray(r['Buyer']) ? r['Buyer'] : [];
              return buyers.includes(consumerId);
            });
            if (stuckRef) {
              const rancherId = stuckRef['Rancher']?.[0] || stuckRef['Suggested Rancher']?.[0];
              if (rancherId) {
                const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);
                const rancherEmail = rancher['Email'];
                const rancherName = rancher['Operator Name'] || rancher['Ranch Name'] || 'Rancher';
                if (rancherEmail && consumer['Email']) {
                  // tier_v2 ranchers route deposits through Stripe Connect
                  // direct charge at /checkout/<refId>/deposit, which requires
                  // the bhc-member-auth cookie. Wrap the deposit deep-link in
                  // a magic-link verify URL. Legacy ranchers stay on the tap-
                  // any-tier Payment Link copy (depositMagicLinkUrl stays
                  // undefined).
                  const promotePricingModel = String(rancher['Pricing Model'] || 'legacy');
                  let promoteDepositMagicLinkUrl: string | undefined;
                  if (promotePricingModel === 'tier_v2') {
                    const magicToken = generateMemberLoginToken(consumerId, consumer['Email']);
                    const nextPath = `/checkout/${stuckRef.id}/deposit`;
                    promoteDepositMagicLinkUrl = `${SITE_URL}/api/auth/member/verify?token=${magicToken}&next=${encodeURIComponent(nextPath)}`;
                  }
                  // Buyer-side intro (w/ rancher pricing + contact)
                  await sendBuyerIntroNotification({
                    firstName,
                    email: consumer['Email'],
                    rancherName,
                    rancherEmail,
                    rancherPhone: rancher['Phone'] || '',
                    rancherSlug: rancher['Slug'] || '',
                    loginUrl: `${SITE_URL}/member`,
                    quarterPrice: Number(rancher['Quarter Price']) || undefined,
                    quarterLbs: rancher['Quarter lbs'] || '',
                    halfPrice: Number(rancher['Half Price']) || undefined,
                    halfLbs: rancher['Half lbs'] || '',
                    wholePrice: Number(rancher['Whole Price']) || undefined,
                    wholeLbs: rancher['Whole lbs'] || '',
                    nextProcessingDate: rancher['Next Processing Date'] || '',
                    depositMagicLinkUrl: promoteDepositMagicLinkUrl,
                  }).catch((e: any) => console.warn('[promote-pa] buyer intro failed:', e?.message));
                  // Rancher-side intro
                  await sendEmail({
                    to: rancherEmail,
                    subject: `BuyHalfCow Introduction: ${stuckRef['Buyer Name'] || firstName} in ${stuckRef['Buyer State'] || ''}`,
                    html: `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;">
<h1 style="font-family:Georgia,serif;">New buyer lead</h1>
<p>Hi ${rancherName},</p>
<p>You have a new buyer matched to you on BuyHalfCow. Reach out today:</p>
<div style="background:#F4F1EC;padding:20px;margin:20px 0;">
  <p><strong>Buyer:</strong> ${stuckRef['Buyer Name'] || firstName}</p>
  <p><strong>Email:</strong> ${stuckRef['Buyer Email'] || consumer['Email']}</p>
  <p><strong>Phone:</strong> ${stuckRef['Buyer Phone'] || consumer['Phone'] || ''}</p>
  <p><strong>Location:</strong> ${stuckRef['Buyer State'] || ''}</p>
  <p><strong>Order:</strong> ${stuckRef['Order Type'] || ''}</p>
  <p><strong>Budget:</strong> ${stuckRef['Budget Range'] || ''}</p>
  ${stuckRef['Notes'] ? `<p><strong>Notes:</strong> ${stuckRef['Notes']}</p>` : ''}
</div>
<p>— Ben, BuyHalfCow</p>
</body></html>`,
                  }).catch((e: any) => console.warn('[promote-pa] rancher intro failed:', e?.message));
                }
                await updateRecord(TABLES.REFERRALS, stuckRef.id, {
                  'Status': 'Intro Sent',
                  'Approval Status': 'approved',
                  'Intro Sent At': new Date().toISOString(),
                });
                // Promote-PA flips Pending Approval → Intro Sent. The slot
                // was never atomically claimed (matching/suggest only INCRs
                // when CREATING a referral). Increment rancher capacity now
                // so /api/cron/capacity-drift-check doesn't have to self-heal
                // on next run. PA-MATCH audit (2026-05-28) flagged.
                try {
                  const { incrementCapacity, syncCapacityToAirtable } = await import('@/lib/rancherCapacity');
                  const newCount = await incrementCapacity(rancherId);
                  await syncCapacityToAirtable(rancherId, newCount);
                } catch (capErr: any) {
                  console.warn('[promote-pa] capacity INCR failed (self-heals daily):', capErr?.message);
                }
                autoRouted = true;
                await updateRecord(TABLES.CONSUMERS, consumerId, {
                  'Routing Segment Send Count': segmentCount + 1,
                  'Routing Segment Last Sent At': new Date().toISOString(),
                  'Sequence Sent At': new Date().toISOString(),
                  'Buyer Stage': 'MATCHED',
                  'Buyer Stage Updated At': new Date().toISOString(),
                });
                segmentCounters.match_now_rescue++; totalSent++; fired = true;
              }
            }
          } catch (e: any) {
            console.warn(`[match-now promote-PA] failed for ${consumerId}:`, e?.message);
          }

          if (autoRouted) {
            continue;
          }

          // PERFECT-D (2026-06-05): GUARD-2 412s matching/suggest when Qualified
          // At is blank. MATCH_NOW segment is computed from Ready to Buy=true,
          // which can be set BEFORE the quiz (legacy data healed via auto-route
          // bypass, etc.). Without this gate the auto-route silently 412s
          // every cron run, the rescue email still fires, and the buyer
          // churns. Skip routing + fall through to the operator-rescue path
          // below so the buyer still gets a human touch.
          const skipRoutingNotQualified = !consumer['Qualified At'];
          if (skipRoutingNotQualified) {
            console.log(`[match-now] skip routing — ${consumerId} (${email}) has no Qualified At`);
          }
          if (!skipRoutingNotQualified) try {
            const matchRes = await fetch(`${SITE_URL}/api/matching/suggest`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(process.env.INTERNAL_API_SECRET ? { 'x-internal-secret': process.env.INTERNAL_API_SECRET } : {}),
              },
              body: JSON.stringify({
                buyerState: consumer['State'],
                buyerId: consumerId,
                buyerName: consumer['Full Name'] || '',
                buyerEmail: email,
                buyerPhone: consumer['Phone'] || '',
                orderType: consumer['Order Type'] || '',
                budgetRange: consumer['Budget'] || '',
                intentScore: consumer['Intent Score'] || 0,
                intentClassification: consumer['Intent Classification'] || '',
                notes: consumer['Notes'] || '',
                // hot-lead bypass: R2B buyer can route to over-cap rancher
                warmupEngaged: true,
              }),
            });
            if (matchRes.ok) {
              const j = await matchRes.json().catch(() => ({}));
              if (j.matchFound || j.alreadyActive) {
                autoRouted = true;
                await updateRecord(TABLES.CONSUMERS, consumerId, {
                  'Routing Segment Send Count': segmentCount + 1,
                  'Routing Segment Last Sent At': new Date().toISOString(),
                  'Sequence Sent At': new Date().toISOString(),
                  'Buyer Stage': 'MATCHED',
                  'Buyer Stage Updated At': new Date().toISOString(),
                });
                segmentCounters.match_now_rescue++; totalSent++; fired = true;
              }
            }
          } catch (e: any) {
            console.warn(`[match-now auto-route] failed for ${consumerId}:`, e?.message);
          }

          if (!autoRouted) {
            // Auto-route failed (no available rancher) — soft fallback w/
            // rescue email + Telegram /match suggestion. Operator picks an
            // alternative rancher manually via the inline-button selector.
            // MISMATCH FIX (all segment branches): stamp throttle BEFORE send.
            // Prior order sent email then stamped; if stamp threw, next cron
            // run re-sent the same email → buyer received duplicate marketing.
            await updateRecord(TABLES.CONSUMERS, consumerId, {
              'Routing Segment Send Count': segmentCount + 1,
              'Routing Segment Last Sent At': new Date().toISOString(),
              'Sequence Sent At': new Date().toISOString(),
            });
            await sendMatchNowRescue({ email, firstName, buyerState: buyerStateNorm || stateLabel });
            try {
              await sendOperatorSignal({
                urgency: 'normal',
                kind: 'recovery-suggestion',
                summary: `MATCH_NOW buyer needs manual route — ${firstName} (${buyerStateNorm || stateLabel})`,
                detail: `${email}\nAuto-route failed (no rancher w/ capacity in state). Run <code>/match ${firstName.toLowerCase().split(' ')[0]} &lt;rancher-name&gt;</code> to pick an alternative + fire intro.`,
                refs: [{ type: 'consumer', id: consumerId, label: firstName }],
                dedupeKey: `match-now-${consumerId}`,
                dedupeWindowMs: 86400000,
              });
            } catch {}
            segmentCounters.match_now_rescue++; totalSent++; fired = true;
          }
        }
        else if (segment === 'NUDGE_TO_ENGAGE' && segmentCount < 2 && daysSinceSegmentSend >= 7) {
          const engageToken = jwt.sign({ type: 'warmup-engage', consumerId }, JWT_SECRET, { expiresIn: '30d' });
          const engageUrl = `${SITE_URL}/api/warmup/engage?token=${engageToken}`;
          await updateRecord(TABLES.CONSUMERS, consumerId, {
            'Routing Segment Send Count': segmentCount + 1,
            'Routing Segment Last Sent At': new Date().toISOString(),
            'Sequence Sent At': new Date().toISOString(),
          });
          await sendNudgeToEngage({ email, firstName, buyerState: buyerStateNorm || stateLabel, engageUrl });
          segmentCounters.nudge_to_engage++; totalSent++; fired = true;
        }
        else if (segment === 'WARM_LEAD' && segmentCount < 4 && daysSinceSegmentSend >= 14) {
          const engageToken = jwt.sign({ type: 'warmup-engage', consumerId, r2b: true }, JWT_SECRET, { expiresIn: '30d' });
          const engageUrl = `${SITE_URL}/api/warmup/engage?token=${engageToken}`;
          await updateRecord(TABLES.CONSUMERS, consumerId, {
            'Routing Segment Send Count': segmentCount + 1,
            'Routing Segment Last Sent At': new Date().toISOString(),
            'Sequence Sent At': new Date().toISOString(),
          });
          await sendWarmLeadReadyCheck({ email, firstName, buyerState: buyerStateNorm || stateLabel, engageUrl });
          segmentCounters.warm_lead_check++; totalSent++; fired = true;
        }
        else if (segment === 'NO_BUDGET_FOUNDER_PITCH' && segmentCount < 1) {
          await updateRecord(TABLES.CONSUMERS, consumerId, {
            'Routing Segment Send Count': segmentCount + 1,
            'Routing Segment Last Sent At': new Date().toISOString(),
            'Sequence Sent At': new Date().toISOString(),
          });
          await sendNoBudgetFounderPitch({ email, firstName, buyerState: buyerStateNorm || stateLabel });
          segmentCounters.no_budget_founder_pitch++; totalSent++; fired = true;
        }
        else if (segment === 'STATE_WAITLIST' && segmentCount < 1) {
          await updateRecord(TABLES.CONSUMERS, consumerId, {
            'Routing Segment Send Count': segmentCount + 1,
            'Routing Segment Last Sent At': new Date().toISOString(),
            'Sequence Sent At': new Date().toISOString(),
          });
          await sendStateWaitlistLetter({ email, firstName, buyerState: buyerStateNorm || stateLabel });
          segmentCounters.state_waitlist++; totalSent++; fired = true;
        }
        // i-6 audit P0: incomplete_profile cap 1→3 w/ 14d cadence.
        // ~69% of buyers (1088/1579 as of 2026-05-27) sat in this segment
        // w/ a 1-email-lifetime cap → funnel hemorrhage. Now 3 progressive
        // letters over 28d (d0, d14, d28). Subject escalates: gentle → check
        // → close-the-loop. After 3 sends, drops to drip-only nurture.
        else if (segment === 'INCOMPLETE_PROFILE' && segmentCount < 3 && daysSinceSegmentSend >= 14) {
          const subjectVariants = [
            'two questions on your beef — 30 seconds',
            'still want beef from your area? — quick check',
            "last note from me — close your loop or i'll stop",
          ];
          const subject = subjectVariants[Math.min(segmentCount, 2)];
          await updateRecord(TABLES.CONSUMERS, consumerId, {
            'Routing Segment Send Count': segmentCount + 1,
            'Routing Segment Last Sent At': new Date().toISOString(),
            'Sequence Sent At': new Date().toISOString(),
          });
          await sendIncompleteProfileAsk({
            email,
            firstName,
            buyerState: buyerStateNorm || stateLabel,
            subject,
          });
          segmentCounters.incomplete_profile++; totalSent++; fired = true;
        }

        // If segment branch fired, skip the legacy stage-machine branch this
        // run. Each buyer gets at most one automated email per day.
        if (fired) continue;

        if (buyerStage === 'WAITING') {
          // Letter 1 at Day 7
          if (daysInStage >= 7 && !seqStage.startsWith('WAITING_')) {
            await updateRecord(TABLES.CONSUMERS, consumerId, {
              'Sequence Stage': 'WAITING_L1',
              'Sequence Sent At': new Date().toISOString(),
            });
            await sendFounderLetterWaiting({ firstName, email, state: stateLabel, letterNumber: 1 });
            counters.waiting_l1++; fired = true;
          }
          // Letter 2 at Day 30
          else if (daysInStage >= 30 && seqStage === 'WAITING_L1') {
            await updateRecord(TABLES.CONSUMERS, consumerId, {
              'Sequence Stage': 'WAITING_L2',
              'Sequence Sent At': new Date().toISOString(),
            });
            await sendFounderLetterWaiting({ firstName, email, state: stateLabel, letterNumber: 2 });
            counters.waiting_l2++; fired = true;
          }
          // Letters 3+ rolling monthly: Day 60, 90, 120, ...
          else if (seqStage.startsWith('WAITING_L')) {
            const lastN = parseInt(seqStage.replace('WAITING_L', ''), 10) || 1;
            const expectedDays = (lastN + 1 === 3 ? 60 : 30 * (lastN + 1));
            if (daysInStage >= expectedDays) {
              await updateRecord(TABLES.CONSUMERS, consumerId, {
                'Sequence Stage': `WAITING_L${lastN + 1}`,
                'Sequence Sent At': new Date().toISOString(),
              });
              await sendFounderLetterWaiting({ firstName, email, state: stateLabel, letterNumber: lastN + 1 });
              counters.waiting_monthly++; fired = true;
            }
          }
        }

        else if (buyerStage === 'READY') {
          // Day 7 last-call nudge (uses existing rancher-launch nudge template — same
          // single-CTA YES button mechanic, fires once per READY tenure)
          if (daysInStage >= 7 && seqStage !== 'READY_NUDGE') {
            const rancherName = buyerActiveRancher.get(consumerId) || 'a rancher in your area';
            const engageToken = jwt.sign({ type: 'warmup-engage', consumerId }, JWT_SECRET, { expiresIn: '30d' });
            const engageUrl = `${SITE_URL}/api/warmup/engage?token=${engageToken}`;
            // Nudge template — same shape as sendRancherLaunchWarmupNudge but inline
            // here so we don't have to import yet another email function. Kept short.
            await updateRecord(TABLES.CONSUMERS, consumerId, {
              'Sequence Stage': 'READY_NUDGE',
              'Sequence Sent At': new Date().toISOString(),
            });
            await sendEmail({
              to: email,
              subject: `last call — ${rancherName} is open in ${stateLabel}`,
              html: `<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:36px;border:1px solid #A7A29A;background:#fff;line-height:1.7;">
                <p>Hey ${firstName},</p>
                <p>I introduced you to <strong>${rancherName}</strong> last week — didn't hear back, so this is my last nudge.</p>
                <p><strong>Are you ready to buy in the next 1–2 months?</strong> If yes, click below and I'll send their full info. If not, I'll drop you off the active list and check back when timing fits.</p>
                <p style="text-align:center;margin:28px 0;"><a href="${engageUrl}" style="display:inline-block;padding:14px 32px;background:#0E0E0E;color:#F4F1EC;text-decoration:none;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;font-size:14px;">Yes — Ready to Buy</a></p>
                <p style="font-size:12px;color:#A7A29A;">— Ben</p>
              </div>`,
            });
            counters.ready_nudge++; fired = true;
          }
        }

        else if (buyerStage === 'MATCHED') {
          // Day 4 check-in
          if (daysInStage >= 4 && seqStage !== 'MATCHED_D4') {
            const rancherName = buyerActiveRancher.get(consumerId) || 'your rancher';
            await updateRecord(TABLES.CONSUMERS, consumerId, {
              'Sequence Stage': 'MATCHED_D4',
              'Sequence Sent At': new Date().toISOString(),
            });
            await sendMatchedDay4CheckIn({ firstName, email, rancherName });
            counters.matched_d4++; fired = true;
          }
        }

        else if (buyerStage === 'CLOSED') {
          // Only run post-purchase sequence for buyers who actually bought —
          // CLOSED also includes suppressed/non-responsive (no further outreach).
          const purchased = buyerClosedWonRancher.has(consumerId);
          if (!purchased) {
            skipReasons['closed-or-terminal'] = (skipReasons['closed-or-terminal'] || 0) + 1;
            continue;
          }
          const rancherName = buyerClosedWonRancher.get(consumerId) || 'your rancher';
          const orderType = consumer['Order Type'] || 'Not Sure';

          // Day 14 cuts education (Day 0 fires from the close-handler event,
          // not from this cron — see app/api/rancher/referrals/[id]/route.ts)
          if (daysInStage >= 14 && seqStage !== 'CLOSED_CUTS' && !seqStage.startsWith('CLOSED_M') && seqStage !== 'CLOSED_REPEAT') {
            await updateRecord(TABLES.CONSUMERS, consumerId, {
              'Sequence Stage': 'CLOSED_CUTS',
              'Sequence Sent At': new Date().toISOString(),
            });
            await sendCutsEducation({ firstName, email, orderType });
            counters.closed_cuts++; fired = true;
          }
          // Monthly letters at Day 60, 90, 120 (months 2, 3, 4 post-purchase)
          else if (seqStage === 'CLOSED_CUTS' && daysInStage >= 60) {
            await updateRecord(TABLES.CONSUMERS, consumerId, {
              'Sequence Stage': 'CLOSED_M2',
              'Sequence Sent At': new Date().toISOString(),
            });
            await sendClosedMonthlyLetter({ firstName, email, monthNumber: 2 });
            counters.closed_monthly++; fired = true;
          }
          else if (seqStage === 'CLOSED_M2' && daysInStage >= 90) {
            await updateRecord(TABLES.CONSUMERS, consumerId, {
              'Sequence Stage': 'CLOSED_M3',
              'Sequence Sent At': new Date().toISOString(),
            });
            await sendClosedMonthlyLetter({ firstName, email, monthNumber: 3 });
            counters.closed_monthly++; fired = true;
          }
          else if (seqStage === 'CLOSED_M3' && daysInStage >= 120) {
            await updateRecord(TABLES.CONSUMERS, consumerId, {
              'Sequence Stage': 'CLOSED_M4',
              'Sequence Sent At': new Date().toISOString(),
            });
            await sendClosedMonthlyLetter({ firstName, email, monthNumber: 4 });
            counters.closed_monthly++; fired = true;
          }
          // Month 5 re-engagement ask
          else if ((seqStage === 'CLOSED_M4' || seqStage === 'CLOSED_M3') && daysInStage >= 150) {
            await updateRecord(TABLES.CONSUMERS, consumerId, {
              'Sequence Stage': 'CLOSED_REPEAT',
              'Sequence Sent At': new Date().toISOString(),
            });
            await sendRepeatPurchaseAsk({ firstName, email, rancherName });
            counters.closed_repeat++; fired = true;
          }
        }

        if (fired) totalSent++;
      } catch (err: any) {
        console.error(`Buyer-stage error for consumer ${consumer.id}:`, err.message);
        errors++;
      }
      // Pace only after actual sends — empty iterations are ~free
      if (totalSent > sentBeforeIter) {
        sentBeforeIter = totalSent;
        await sleep(250);
      }
    }

    const total = counters.waiting_l1 + counters.waiting_l2 + counters.waiting_monthly +
      counters.ready_nudge + counters.matched_d4 +
      counters.closed_cuts + counters.closed_monthly + counters.closed_repeat;

    if (total > 0) {
      const lines = [
        `📧 <b>Email Sequences</b>`,
        ``,
        `✅ ${total} email${total > 1 ? 's' : ''} sent`,
      ];
      if (counters.waiting_l1 + counters.waiting_l2 + counters.waiting_monthly > 0) {
        lines.push(`🌱 WAITING: L1 ${counters.waiting_l1} · L2 ${counters.waiting_l2} · monthly ${counters.waiting_monthly}`);
      }
      if (counters.ready_nudge > 0) lines.push(`👋 READY nudge: ${counters.ready_nudge}`);
      if (counters.matched_d4 > 0) lines.push(`🤝 MATCHED check-in: ${counters.matched_d4}`);
      if (counters.closed_cuts + counters.closed_monthly + counters.closed_repeat > 0) {
        lines.push(`💰 CLOSED: cuts ${counters.closed_cuts} · monthly ${counters.closed_monthly} · repeat ${counters.closed_repeat}`);
      }
      if (errors > 0) lines.push(`⚠️ ${errors} errors`);
      await sendTelegramUpdate(lines.join('\n'));
    }

    // ── Rancher agreement reminder drip ─────────────────────────────────────
    // Day 3, 7, 14 after docs sent — nudge to sign agreement
    let rancherReminders = 0;
    try {
      const pipelineRanchers = await getAllRecords(TABLES.RANCHERS, '{Onboarding Status} = "Docs Sent"') as any[];

      for (const rancher of pipelineRanchers) {
        if (totalSent >= MAX_EMAILS_PER_RUN) break;
        const email = rancher['Email'];
        const docsSentAt = rancher['Docs Sent At'];
        if (!email || !docsSentAt) continue;
        if (rancher['Agreement Signed']) continue;

        const daysSinceDocsSent = (now - new Date(docsSentAt).getTime()) / DAY_MS;
        const firstName = (rancher['Operator Name'] || rancher['Ranch Name'] || '').split(' ')[0] || 'there';
        const ranchName = rancher['Ranch Name'] || rancher['Operator Name'] || 'your ranch';
        const rancherState = rancher['State'] || '';

        // Only send at day 3, 7, 14 milestones (check if already sent via Rancher Sequence Stage)
        const stage = rancher['Rancher Sequence Stage'] || 'none';
        let shouldSend = false;
        let subject = '';
        let bodyHtml = '';
        let newStage = '';

        if (daysSinceDocsSent >= 3 && daysSinceDocsSent < 7 && stage === 'none') {
          shouldSend = true;
          newStage = 'reminder_day3';
          subject = `${firstName}, your agreement is ready to sign`;
          bodyHtml = `<p>Hi ${firstName},</p>
            <p>Just a quick reminder — your BuyHalfCow Commission Agreement for <strong>${ranchName}</strong> is ready for your signature.</p>
            <p>Once signed, you can immediately start setting up your ranch page and we can begin sending buyers your way.</p>
            <p><strong>Quick recap:</strong> 10% commission on referred sales only. No upfront fees. Buyers pay you directly.</p>
            <p>If you have any questions, just reply to this email.</p>`;
        } else if (daysSinceDocsSent >= 7 && daysSinceDocsSent < 14 && stage === 'reminder_day3') {
          shouldSend = true;
          newStage = 'reminder_day7';
          subject = `Need help with your agreement, ${firstName}?`;
          bodyHtml = `<p>Hi ${firstName},</p>
            <p>I noticed you haven't signed the BuyHalfCow agreement yet for <strong>${ranchName}</strong>. No pressure — just want to make sure everything makes sense.</p>
            <p>If you have questions about the commission structure, the process, or anything else, just reply to this email and I'll get back to you personally.</p>
            <p>We have buyers actively looking for ranch-direct beef${rancherState ? ` in ${rancherState}` : ''}, and I'd love to get you connected with them.</p>`;
        } else if (daysSinceDocsSent >= 14 && stage === 'reminder_day7') {
          shouldSend = true;
          newStage = 'reminder_day14';
          subject = `Last check-in — buyers waiting in ${rancherState || 'your area'}`;
          bodyHtml = `<p>Hi ${firstName},</p>
            <p>This is my last follow-up about the BuyHalfCow partnership for <strong>${ranchName}</strong>.</p>
            <p>We currently have buyers looking for ranch-direct beef${rancherState ? ` in ${rancherState}` : ''} and your operation would be a great fit. The agreement takes about 2 minutes to review and sign.</p>
            <p>If now isn't the right time, no worries at all. Just reply and let me know, and I'll reach out again when it makes sense.</p>`;
        }

        if (shouldSend) {
          try {
            // 2026-06-09 P1 fix (audit BUG #1): pass templateName + replyContext
            // so guardedSend's suppression check + frequency cap + Email Sends
            // audit log all fire. Without this, rancher reminders bypass every
            // safety gate — could spam an unsubscribed rancher silently.
            await sendEmail({
              to: email,
              subject,
              html: `<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;">
                ${bodyHtml}
                <p style="font-size:12px;color:#A7A29A;margin-top:30px;">— Benjamin, Founder<br>BuyHalfCow</p>
              </div>`,
              templateName: `rancher_docs_reminder_${newStage}`,
              _replyContext: { type: 'rnc', recordId: rancher.id },
            });
            await updateRecord(TABLES.RANCHERS, rancher.id, {
              'Rancher Sequence Stage': newStage,
            });
            rancherReminders++;
            totalSent++;
          } catch (e: any) {
            console.error('Rancher reminder error:', e.message);
          }
        }
      }
    } catch (e: any) {
      console.error('Rancher drip query error:', e.message);
    }

    if (rancherReminders > 0) {
      await sendTelegramUpdate(`📋 <b>Rancher Agreement Reminders</b>: ${rancherReminders} sent`);
    }

  const segmentTotal =
    segmentCounters.match_now_rescue +
    segmentCounters.nudge_to_engage +
    segmentCounters.warm_lead_check +
    segmentCounters.no_budget_founder_pitch +
    segmentCounters.state_waitlist +
    segmentCounters.incomplete_profile;
  const grandTotal = total + rancherReminders + abandonedRecovered + segmentTotal;
  const segmentNote =
    segmentTotal > 0
      ? ` segment=${segmentTotal}(match_now=${segmentCounters.match_now_rescue} nudge=${segmentCounters.nudge_to_engage} warm=${segmentCounters.warm_lead_check} no_budget=${segmentCounters.no_budget_founder_pitch} waitlist=${segmentCounters.state_waitlist} incomplete=${segmentCounters.incomplete_profile})`
      : '';
  return {
    status: errors > 0 ? 'partial' : 'success',
    recordsTouched: grandTotal,
    notes: `sent=${grandTotal} (stage=${total} rancherReminders=${rancherReminders} abandoned=${abandonedRecovered}${segmentNote}) errors=${errors}`,
    skipReasonBreakdown: Object.keys(skipReasons).length ? skipReasons : undefined,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;

  // 2026-06-09 sales-floor pivot: drip pipeline killed in favor of Cal-as-funnel.
  // Flag `EMAIL_SEQUENCES_ENABLED=true` re-enables (rollback path) if buyer
  // conversion drops post-pivot. Cron remains scheduled in vercel.json so
  // re-enabling doesn't require code change — just env flip + redeploy.
  if (process.env.EMAIL_SEQUENCES_ENABLED !== 'true') {
    return NextResponse.json({
      ok: true,
      skipped: 'EMAIL_SEQUENCES_ENABLED=false — drip paused per sales-floor pivot 2026-06-09',
    });
  }

  return withCronRun('email-sequences', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
