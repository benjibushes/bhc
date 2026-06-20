import { NextResponse } from 'next/server';
import { getRecordById, updateRecord, getAllRecords } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { transition } from '@/lib/deal/transitionLive';
import { sendTelegramUpdate, sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID, sendTelegramSaleCelebration } from '@/lib/telegram';
import { sendRerouteNotification, sendPilotUpsellEmail, sendInstantCommissionInvoice } from '@/lib/email';
import { isQualifiedForRouting } from '@/lib/qualification';
import { createCommissionInvoice } from '@/lib/stripe-commission';
import { calcCommission, calcCommissionForRancher, hasLockedCommissionRate, getRancherCommissionRate } from '@/lib/commission';
import { decrementCapacity, syncCapacityToAirtable } from '@/lib/rancherCapacity';
import jwt from 'jsonwebtoken';
import { requireRancher } from '@/lib/rancherAuth';

// Pass reasons a rancher can give when declining a lead.
// Mutually exclusive — "Other" deliberately omitted to force a real signal.
// `no_response` is the slop signal — at 2+ consecutive no-response misses we
// auto-flag the buyer as Non-Responsive and stop routing them anywhere.
const PASS_REASONS = {
  out_of_area: 'Out of my service area',
  at_capacity: "I'm at capacity right now",
  not_a_fit: 'Not a fit (price / timing / other)',
  no_response: 'Buyer never responded',
} as const;
type PassReason = keyof typeof PASS_REASONS;

// Reasons that count as "buyer ghosted" — increments Missed Responses on the
// consumer record. Other pass reasons (out_of_area, at_capacity, not_a_fit)
// are the rancher's choice, not the buyer's behavior, so they don't penalize.
const NO_RESPONSE_PASS_REASONS: PassReason[] = ['no_response'];

// At this threshold of consecutive no-response misses, the buyer is auto-flagged
// Non-Responsive and excluded from all future routing.
const NON_RESPONSIVE_THRESHOLD = 2;

export const maxDuration = 60;

import { JWT_SECRET } from '@/lib/secrets';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireRancher(request);
    if (auth instanceof NextResponse) return auth;
    // Keep the legacy variable name `decoded` to minimize churn through the
    // ~800-line handler below. Shape mirrors the prior JWT payload's hot
    // fields (rancherId, name) plus everything else requireRancher exposes.
    const decoded = {
      rancherId: auth.session.rancherId,
      name: auth.session.name,
      email: auth.session.email,
      ranchName: auth.session.ranchName,
    };

    const { id } = await params;
    const body = await request.json();
    const { status, saleAmount, notes, closeReason } = body;

    // Verify this referral belongs to this rancher
    const referral = await getRecordById(TABLES.REFERRALS, id) as any;
    if (!referral) {
      return NextResponse.json({ error: 'Referral not found' }, { status: 404 });
    }

    const assignedIds = referral['Rancher'] || [];
    const suggestedIds = referral['Suggested Rancher'] || [];
    const isOwner = (Array.isArray(assignedIds) && assignedIds.includes(decoded.rancherId)) ||
                    (Array.isArray(suggestedIds) && suggestedIds.includes(decoded.rancherId));

    if (!isOwner) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    // ── PASS-ON-LEAD ACTION ──────────────────────────────────────────────
    // Rancher explicitly passes on this lead from their dashboard. We:
    //   1) close the current referral as Closed Lost with a structured note
    //   2) free the rancher's capacity counter
    //   3) re-fire matching for the buyer, EXCLUDING the rancher who just passed
    //   4) Telegram Ben with the outcome (reassigned to X / waitlisted)
    //
    // Different from the existing Closed Lost flow because we capture WHY they
    // passed (analytics) and explicitly exclude the passing rancher from re-match
    // — without that exclusion, the buyer could ping-pong back to the same rancher.
    if (body._action === 'pass') {
      const passReason = body.passReason as PassReason;
      if (!passReason || !PASS_REASONS[passReason]) {
        return NextResponse.json({
          error: 'passReason required: ' + Object.keys(PASS_REASONS).join(' | '),
        }, { status: 400 });
      }

      const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
      const reasonLabel = PASS_REASONS[passReason];
      const buyerName = referral['Buyer Name'] || 'Unknown';
      const buyerState = referral['Buyer State'] || '';

      // 1. Close current referral as Closed Lost with reason note
      const passNote = `[PASSED ${new Date().toISOString().slice(0, 10)} — ${decoded.name}] ${reasonLabel}`;
      const _tPass = await transition(id, {
        to: 'CLOSED_LOST',
        actor: `rancher:${decoded.rancherId}`,
        reason: `rancher passed: ${reasonLabel}`,
        extraFields: {
          'Closed At': new Date().toISOString(),
          'Notes': `${passNote}\n${referral['Notes'] || ''}`.trim(),
        },
      });
      if (!_tPass.ok && !_tPass.noop) {
        // Safety net: machine rejected — fall back to direct write + alert.
        console.error('[referrals/pass] transition rejected, falling back to direct write:', _tPass.error);
        await updateRecord(TABLES.REFERRALS, id, {
          'Status': 'Closed Lost',
          'Closed At': new Date().toISOString(),
          'Notes': `${passNote}\n${referral['Notes'] || ''}`.trim(),
        });
        try {
          const { sendOperatorSignal } = await import('@/lib/operatorSignal');
          await sendOperatorSignal({ urgency: 'normal', kind: 'system-error', summary: `Deal ${id}: state-machine rejected CLOSED_LOST on pass (used fallback). Check lib/deal.`, dedupeKey: `transition-fallback-${id}`, dedupeWindowMs: 3600_000 });
        } catch {}
      }

      // 2. Decrement rancher's active referral count via atomic Redis DECR
      // (see lib/rancherCapacity — race-safe under concurrent closes). Also
      // flip At Capacity back to Active if the decrement crossed below max
      // — same pattern as the capacity-raise flow in /api/rancher/landing-
      // page. Without this, a rancher who passes their way under cap stays
      // "At Capacity" until next manual edit or batch-approve self-heal.
      try {
        const rancher = await getRecordById(TABLES.RANCHERS, decoded.rancherId) as any;
        const newCount = await decrementCapacity(decoded.rancherId);
        const max = Number(rancher['Max Active Referalls'] || rancher['Max Active Referrals'] || 5);
        const wasAtCap = (rancher['Active Status'] || '') === 'At Capacity';
        const updates: Record<string, any> = { 'Current Active Referrals': newCount };
        if (wasAtCap && newCount < max) updates['Active Status'] = 'Active';
        await updateRecord(TABLES.RANCHERS, decoded.rancherId, updates);
        if (updates['Active Status'] === 'Active') {
          // Newly available capacity — drain Waitlisted buyers in their state.
          const { triggerLaunchWarmup } = await import('@/lib/triggerLaunchWarmup');
          triggerLaunchWarmup(`pass-action-resume:${decoded.rancherId}`);
        }
      } catch (e) {
        console.error('Pass: capacity decrement error:', e);
      }

      // 3. Re-fire matching for the buyer with this rancher excluded
      const buyerIds = referral['Buyer'] || [];
      const buyerId = Array.isArray(buyerIds) ? buyerIds[0] : null;
      let rematchOutcome: 'rematched' | 'waitlisted' | 'error' = 'error';
      let newRancherName = '';
      let buyerForReroute: any = null;

      if (buyerId) {
        try {
          // Reset buyer status + sequence stage so re-engagement nurture restarts
          await updateRecord(TABLES.CONSUMERS, buyerId, {
            'Referral Status': 'Unmatched',
            'Sequence Stage': 'rerouted_after_pass',
          });
          buyerForReroute = await getRecordById(TABLES.CONSUMERS, buyerId) as any;

          // ── BUYER HEALTH: track no-response misses ──────────────────────
          // If the rancher passed because the buyer never responded, count it
          // against the buyer. After NON_RESPONSIVE_THRESHOLD consecutive misses
          // we auto-flag them Non-Responsive — they exit the routing pool.
          // Other pass reasons (out_of_area, at_capacity, not_a_fit) reflect the
          // rancher's situation, not the buyer's behavior, so they don't count.
          if (NO_RESPONSE_PASS_REASONS.includes(passReason) && buyerForReroute) {
            try {
              const prevMisses = Number(buyerForReroute['Missed Responses'] || 0);
              const newMisses = prevMisses + 1;
              const updates: Record<string, any> = { 'Missed Responses': newMisses };
              const becameNonResponsive = newMisses >= NON_RESPONSIVE_THRESHOLD &&
                String(buyerForReroute['Buyer Health']?.name || buyerForReroute['Buyer Health'] || '') !== 'Non-Responsive';
              if (becameNonResponsive) {
                updates['Buyer Health'] = 'Non-Responsive';
              }
              await updateRecord(TABLES.CONSUMERS, buyerId, updates);
              if (becameNonResponsive) {
                try {
                  await sendTelegramMessage(
                    TELEGRAM_ADMIN_CHAT_ID,
                    `🚫 <b>Buyer auto-flagged Non-Responsive</b>\n\n` +
                    `👤 ${buyerForReroute['Full Name'] || 'Unknown'} (${buyerForReroute['State'] || '?'})\n` +
                    `📧 ${buyerForReroute['Email'] || '?'}\n` +
                    `Misses: ${newMisses} consecutive no-response closes\n` +
                    `<i>Excluded from future routing until reactivated. Admin can manually flip Buyer Health back to Active if they re-engage.</i>`
                  );
                } catch { /* non-fatal */ }
              }
            } catch (healthErr: any) {
              console.error('Buyer Health update error:', healthErr.message);
            }
          }

          if (buyerForReroute && buyerForReroute['Email']) {
            const matchRes = await fetch(`${SITE_URL}/api/matching/suggest`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(process.env.INTERNAL_API_SECRET ? { 'x-internal-secret': process.env.INTERNAL_API_SECRET } : {}),
              },
              body: JSON.stringify({
                buyerState: buyerForReroute['State'] || buyerState,
                buyerId: buyerId,
                buyerName: buyerForReroute['Full Name'] || buyerName,
                buyerEmail: buyerForReroute['Email'],
                buyerPhone: buyerForReroute['Phone'] || '',
                orderType: buyerForReroute['Order Type'] || '',
                budgetRange: buyerForReroute['Budget'] || '',
                intentScore: buyerForReroute['Intent Score'] || 50,
                intentClassification: buyerForReroute['Intent Classification'] || 'Medium',
                notes: buyerForReroute['Notes'] || '',
                excludeRancherIds: [decoded.rancherId],
              }),
            });
            if (matchRes.ok) {
              const matchData = await matchRes.json();
              if (matchData.matchFound) {
                rematchOutcome = 'rematched';
                newRancherName = matchData.suggestedRancher?.name || 'another rancher';
              } else {
                rematchOutcome = 'waitlisted';
              }
            }
          }
        } catch (rerouteErr: any) {
          console.error('Pass: re-route error:', rerouteErr);
        }
      }

      // 3a. Send re-engagement email to the buyer so they know what's happening.
      // Frame as "we're finding you another option" — never "you got rejected".
      // The matching engine already sends a fresh intro email if rematched, so
      // this is a heads-up about the transition rather than the new contact info.
      if (buyerForReroute && buyerForReroute['Email'] && rematchOutcome !== 'error') {
        try {
          const buyerEmail = buyerForReroute['Email'];
          const firstName = (buyerForReroute['Full Name'] || '').split(' ')[0] || 'there';
          const buyerToken = jwt.sign(
            { type: 'member-login', consumerId: buyerId!, email: buyerEmail.toLowerCase() },
            JWT_SECRET,
            { expiresIn: '7d' }
          );
          const loginUrl = `${SITE_URL}/member/verify?token=${buyerToken}`;
          await sendRerouteNotification({
            firstName,
            email: buyerEmail,
            state: buyerForReroute['State'] || buyerState,
            newRancherName: rematchOutcome === 'rematched' ? newRancherName : undefined,
            loginUrl,
          });
        } catch (e) {
          console.error('Pass: re-engagement email error:', e);
        }
      }

      // 4. Telegram Ben with outcome
      try {
        const outcomeLine = rematchOutcome === 'rematched'
          ? `🔄 Reassigned to: <b>${newRancherName}</b>`
          : rematchOutcome === 'waitlisted'
            ? `⏳ No other rancher available in ${buyerState} — buyer waitlisted, re-engagement nurture restarted`
            : `⚠️ Re-match failed — manual reassignment needed`;

        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          `🚫 <b>RANCHER PASSED ON LEAD</b>\n\n` +
          `🤠 ${decoded.name} passed on:\n` +
          `👤 ${buyerName} (${buyerState})\n` +
          `📋 Reason: <i>${reasonLabel}</i>\n\n` +
          outcomeLine
        );
      } catch (e) {
        console.error('Pass: telegram alert error:', e);
      }

      return NextResponse.json({
        success: true,
        passed: true,
        rematchOutcome,
        newRancherName: rematchOutcome === 'rematched' ? newRancherName : null,
      });
    }

    // ── IDEMPOTENCY GUARD ──────────────────────────────────────────────
    // P2-D audit fix: short-circuit terminal → same-terminal PATCHes so a
    // fat-finger or retry can't double-fire side effects (Stripe invoice
    // re-create → double-bill the rancher, second post-purchase welcome
    // email, re-stamped Closed At, duplicate Telegram celebration).
    // Capacity decrement is already guarded by `shouldDecrementCapacity`,
    // but the money-moving side effects are not — this closes that gap.
    //
    // Only fires on terminal → SAME terminal. Legitimate corrections like
    // Closed Won → Closed Lost still pass through with their proper side
    // effects (capacity restore, re-route buyer, etc.).
    const currentStatus = String(referral['Status'] || '');
    const TERMINAL_STATUSES = ['Closed Won', 'Closed Lost', 'Refunded'];
    if (status && currentStatus === status && TERMINAL_STATUSES.includes(currentStatus)) {
      return NextResponse.json({
        ok: true,
        noop: true,
        reason: `Referral already in ${currentStatus} — no action taken`,
      });
    }

    const fields: Record<string, any> = {};

    // Ranchers can update to these statuses
    // Awaiting Payment added 2026-05-20: off-platform close where buyer
    // pays on delivery. Status flips but invoice deferred until rancher
    // hits /confirm-payment endpoint with actual cash received.
    const allowedStatuses = ['Rancher Contacted', 'Negotiation', 'Closed Won', 'Awaiting Payment', 'Closed Lost'];
    if (status && allowedStatuses.includes(status)) {
      fields['Status'] = status;

      // ── ENGAGEMENT RESET ────────────────────────────────────────────
      // Buyer proved responsive — clear any prior no-response misses.
      // This unblocks them if a previous rancher had flagged them as ghost.
      if (status === 'Rancher Contacted' || status === 'Negotiation') {
        const buyerIds = referral['Buyer'] || [];
        const buyerId = Array.isArray(buyerIds) ? buyerIds[0] : null;
        if (buyerId) {
          try {
            await updateRecord(TABLES.CONSUMERS, buyerId, {
              'Missed Responses': 0,
            });
          } catch (e: any) {
            console.error('Engagement reset error:', e.message);
          }
        }
      }

      // Capacity-freeing transitions. Awaiting Payment counts here too —
       // the rancher closed the deal off-platform; slot should free for new
       // leads while we wait for buyer payment confirmation. Audit finding
       // 2026-05-20 #13: previously only Closed Won/Lost decremented,
       // leaving Awaiting Payment rows blocking capacity.
       const isCapacityFreeingClose =
         status === 'Closed Won' || status === 'Closed Lost' || status === 'Awaiting Payment';
       // Track previous status so we never double-decrement if the rancher
       // PATCHes a Closed Won record back to Closed Won (re-edit), or
       // transitions Awaiting Payment → Closed Won (second close after
       // already freeing capacity at Awaiting Payment time).
       const previousStatus = String(referral['Status'] || '');
       const ACTIVE_REF_STATES_FOR_DECREMENT = new Set([
         'Intro Sent',
         'Rancher Contacted',
         'Negotiation',
         'Pending Approval',
       ]);
       const shouldDecrementCapacity =
         isCapacityFreeingClose && ACTIVE_REF_STATES_FOR_DECREMENT.has(previousStatus);

      if (status === 'Closed Won' || status === 'Closed Lost' || status === 'Awaiting Payment') {
        fields['Closed At'] = new Date().toISOString();

        // ── BUYER STATUS + HEALTH SYNC ─────────────────────────────────
        // Without this, the consumer record stays in 'Intro Sent' / 'Negotiation'
        // forever after their referral closes, and batch-approve's waitlist
        // retry filter silently skips them forever — they orphan.
        // This was the root cause of "1141 referrals → 0 closed-won data".
        if (status === 'Closed Won') {
          const buyerIds = referral['Buyer'] || [];
          const buyerId = Array.isArray(buyerIds) ? buyerIds[0] : null;
          if (buyerId) {
            try {
              // Closed Won: mark as customer + reset miss counter (they bought)
              // + transition Buyer Stage to CLOSED (the post-purchase content track).
              // Sequence Stage RESET to '' so the cron's Day 14 cuts-education check
              // fires (it gates on `seqStage !== 'CLOSED_CUTS'`, but we want the new
              // post-purchase sequence to start from a clean slate, not interleave
              // with whatever pre-purchase state the buyer left).
              await updateRecord(TABLES.CONSUMERS, buyerId, {
                'Referral Status': 'Closed Won',
                'Sequence Stage': '',
                'Buyer Health': 'Closed Won',
                'Missed Responses': 0,
                'Buyer Stage': 'CLOSED',
                'Buyer Stage Updated At': new Date().toISOString(),
              });

              // Fire Day 0 post-purchase welcome immediately. Day 14 cuts education,
              // Day 60+ monthly letters, Month 5 re-engagement all fire from the
              // email-sequences cron driven by Buyer Stage Updated At.
              try {
                const buyer = await getRecordById(TABLES.CONSUMERS, buyerId) as any;
                const buyerEmail = buyer['Email'] || '';
                const buyerFullName = buyer['Full Name'] || '';
                const orderType = buyer['Order Type'] || referral['Order Type'] || 'Not Sure';
                if (buyerEmail) {
                  const { sendPostPurchaseWelcome } = await import('@/lib/email');
                  await sendPostPurchaseWelcome({
                    firstName: (buyerFullName || '').split(' ')[0] || 'there',
                    email: buyerEmail,
                    rancherName: decoded.name,
                    orderType,
                  });
                }

                // P2-A audit: affiliate auto-enrollment + welcome email live
                // in lib/contracts/rancher.ts enrollClosedWonAffiliate() so
                // every close path (dashboard PATCH here, Stripe webhook
                // tier_v2 via recordClose, Telegram quick-action via
                // recordClose) fires the same flywheel. Idempotent via
                // ensureBuyerAffiliate's email-based lookup.
                try {
                  const { enrollClosedWonAffiliate, fireClosePurchaseIfEnabled } = await import('@/lib/contracts/rancher');
                  await enrollClosedWonAffiliate(buyerId);
                  // Meta CAPI attributed Purchase (gated). This dashboard close
                  // does NOT route through recordClose, so fire the shared helper
                  // here. previousStatus guards against re-firing on a re-close.
                  fireClosePurchaseIfEnabled({
                    referralId: id,
                    buyerId,
                    saleAmount: Number(saleAmount),
                    prevStatus: previousStatus,
                    closedAtIso: String(fields['Closed At'] || new Date().toISOString()),
                  });
                } catch (e: any) {
                  console.warn('[closed-won] affiliate enroll / Purchase fire failed (non-fatal):', e?.message);
                }
              } catch (e) {
                console.error('Post-purchase welcome send error:', e);
              }
            } catch (e) {
              console.error('Closed Won buyer status sync error:', e);
            }
          }
        }

        // ── Closed Lost → restore READY if no other active referrals ────
        // F-2 audit fix: Closed Lost is NOT terminal for the buyer when they
        // have no other active referrals. Pre-fix this branch flipped Buyer
        // Stage straight to CLOSED → stuck-buyer-recovery cron skipped them
        // (only retries READY). Dead-end. Helper in lib/contracts/rancher.ts
        // handles the lookup + branch (READY restore vs MATCHED-stay vs
        // CLOSED fail-safe) so all close paths agree.
        if (status === 'Closed Lost') {
          const buyerIds = referral['Buyer'] || [];
          const buyerId = Array.isArray(buyerIds) ? buyerIds[0] : null;
          if (buyerId) {
            try {
              const { restoreBuyerAfterClosedLost } = await import('@/lib/contracts/rancher');
              await restoreBuyerAfterClosedLost(buyerId, id);
            } catch (stageErr: any) {
              console.error('Closed Lost Buyer Stage restoration error:', stageErr?.message);
            }
          }
        }

        // ── BUYER HEALTH on Closed Lost with no_response reason ────────
        // When a rancher closes a deal Lost AND tells us the buyer never replied,
        // we count it against the buyer's health. After NON_RESPONSIVE_THRESHOLD
        // such misses, they're auto-flagged Non-Responsive and stop routing.
        // closeReason is optional — if not provided, no penalty (rancher might
        // have just closed quickly without specifying why).
        if (status === 'Closed Lost' && closeReason === 'no_response') {
          const buyerIds = referral['Buyer'] || [];
          const buyerId = Array.isArray(buyerIds) ? buyerIds[0] : null;
          if (buyerId) {
            try {
              const buyer = await getRecordById(TABLES.CONSUMERS, buyerId) as any;
              const prevMisses = Number(buyer['Missed Responses'] || 0);
              const newMisses = prevMisses + 1;
              const updates: Record<string, any> = { 'Missed Responses': newMisses };
              const becameNonResponsive = newMisses >= NON_RESPONSIVE_THRESHOLD &&
                String(buyer['Buyer Health']?.name || buyer['Buyer Health'] || '') !== 'Non-Responsive';
              if (becameNonResponsive) updates['Buyer Health'] = 'Non-Responsive';
              await updateRecord(TABLES.CONSUMERS, buyerId, updates);
              if (becameNonResponsive) {
                try {
                  await sendTelegramMessage(
                    TELEGRAM_ADMIN_CHAT_ID,
                    `🚫 <b>Buyer auto-flagged Non-Responsive</b>\n\n` +
                    `👤 ${buyer['Full Name'] || 'Unknown'} (${buyer['State'] || '?'})\n` +
                    `📧 ${buyer['Email'] || '?'}\n` +
                    `Misses: ${newMisses} consecutive no-response closes\n` +
                    `<i>Excluded from future routing until reactivated.</i>`
                  );
                } catch { /* non-fatal */ }
              }
            } catch (healthErr: any) {
              console.error('Closed Lost buyer health update error:', healthErr.message);
            }
          }
        }

        // Engagement reset: if we got a Rancher Contacted or Negotiation transition
        // (handled below in non-close path), reset Missed Responses since the buyer
        // proved responsive. We handle this by NOT incrementing on those — and
        // explicitly clearing here when the rancher reaches one of those stages.
        // Actual reset handled in the !closeStatus branch below.

        // Decrement active referral count via atomic Redis DECR — guarded
        // by previousStatus check to prevent double-decrement on re-edit OR
        // Awaiting Payment → Closed Won. Atomic counter prevents concurrent
        // closes on the same rancher from racing slots back open twice.
        try {
          const rancher = await getRecordById(TABLES.RANCHERS, decoded.rancherId) as any;
          if (shouldDecrementCapacity) {
            const newCount = await decrementCapacity(decoded.rancherId);
            await syncCapacityToAirtable(decoded.rancherId, newCount);
          }

          const rancherState = rancher['State'] || '';
          const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

          // ── CLOSED LOST: Re-route this buyer to another rancher ──
          if (status === 'Closed Lost') {
            const buyerIds = referral['Buyer'] || [];
            const buyerId = Array.isArray(buyerIds) ? buyerIds[0] : null;
            if (buyerId) {
              try {
                const buyer = await getRecordById(TABLES.CONSUMERS, buyerId) as any;
                if (buyer && buyer['Email']) {
                  // Reset buyer's referral status so matching picks them up
                  await updateRecord(TABLES.CONSUMERS, buyerId, {
                    'Referral Status': 'Unmatched',
                    'Sequence Stage': 'rerouted',
                  });
                  // Re-trigger matching for this specific buyer
                  await fetch(`${SITE_URL}/api/matching/suggest`, {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      ...(process.env.INTERNAL_API_SECRET ? { 'x-internal-secret': process.env.INTERNAL_API_SECRET } : {}),
                    },
                    body: JSON.stringify({
                      buyerState: buyer['State'] || '',
                      buyerId: buyerId,
                      buyerName: buyer['Full Name'] || '',
                      buyerEmail: buyer['Email'],
                      buyerPhone: buyer['Phone'] || '',
                      orderType: buyer['Order Type'] || '',
                      budgetRange: buyer['Budget'] || '',
                      intentScore: buyer['Intent Score'] || 50,
                      intentClassification: buyer['Intent Classification'] || 'Medium',
                      notes: buyer['Notes'] || '',
                    }),
                  });
                }
              } catch (rerouteErr) {
                console.error('Re-route buyer error:', rerouteErr);
              }
            }
          }

          // ── CLOSED WON / LOST / AWAITING PAYMENT: Auto-match waiting consumers
          // to freed-up capacity ── Use isQualifiedForRouting to ensure only
          // opted-in buyers (warmup-engaged OR fresh hot signups) get
          // auto-matched. Without this, every freed slot would route an
          // unqualified buyer to the rancher who just closed a deal.
          // Only fire when capacity actually freed (shouldDecrementCapacity)
          // so re-edit PATCHes don't trigger a routing storm.
          if (rancherState && shouldDecrementCapacity) {
            const candidates = await getAllRecords(
              TABLES.CONSUMERS,
              `AND({Status} = "Approved", {Referral Status} = "Unmatched", {State} = "${rancherState}")`,
            ) as any[];
            const sorted = candidates
              .filter((c) => isQualifiedForRouting(c).ok)
              .sort((a, b) => (b['Intent Score'] || 0) - (a['Intent Score'] || 0))
              .slice(0, 3);

            for (const consumer of sorted) {
              try {
                await fetch(`${SITE_URL}/api/matching/suggest`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    ...(process.env.INTERNAL_API_SECRET ? { 'x-internal-secret': process.env.INTERNAL_API_SECRET } : {}),
                  },
                  body: JSON.stringify({
                    buyerState: rancherState,
                    buyerId: consumer.id,
                    buyerName: consumer['Full Name'],
                    buyerEmail: consumer['Email'],
                    buyerPhone: consumer['Phone'],
                    orderType: consumer['Order Type'],
                    budgetRange: consumer['Budget'],
                    intentScore: consumer['Intent Score'],
                    intentClassification: consumer['Intent Classification'],
                    notes: consumer['Notes'],
                  }),
                });
              } catch (autoMatchErr) {
                console.error('Auto-match error:', autoMatchErr);
              }
            }
          }
        } catch (e) {
          console.error('Error updating rancher referral count:', e);
        }
      }
    }

    // HARD GATE 1: Closed Won MUST have a positive sale amount. Previous code
    // silently accepted status=Closed Won with no sale → no commission
    // computed, no Stripe invoice fired, no payment path. Money-losing
    // failure mode. Now return 400 so the dashboard re-prompts.
    if (status === 'Closed Won') {
      if (saleAmount === undefined || saleAmount === null || isNaN(saleAmount) || saleAmount <= 0) {
        return NextResponse.json({
          error: 'A positive sale amount is required to close as Won. Enter the actual sale price.',
        }, { status: 400 });
      }
      // HARD GATE 2: rancher must have a Commission Rate locked. Stops the
      // "we never agreed on a rate" disputes (Ashcraft pattern 2026-05-20).
      // Pull the rancher row defensively — close path mustn't proceed if
      // we can't read the rate.
      try {
        const rancherForCheck = await getRecordById(TABLES.RANCHERS, decoded.rancherId) as any;
        if (!hasLockedCommissionRate(rancherForCheck)) {
          return NextResponse.json({
            error: 'No Commission Rate locked on your account. Contact hello@buyhalfcow.com to set this before closing deals.',
          }, { status: 400 });
        }
      } catch (e) {
        return NextResponse.json({
          error: 'Could not verify Commission Rate. Try again or contact support.',
        }, { status: 500 });
      }
    }

    if (saleAmount !== undefined && saleAmount > 0) {
      // Reject Sale Amount edits on already-closed deals. Otherwise the
      // commission auto-recomputes but the Stripe invoice doesn't refire
      // → drift between Airtable + actual billed amount. Audit finding
      // 2026-05-20 #14. Cancel+reissue invoice path is admin-only.
      const isClosedRow =
        String(referral['Status'] || '') === 'Closed Won' && !status;
      if (isClosedRow) {
        return NextResponse.json({
          error:
            'Sale Amount cannot be edited on a closed deal — invoice would drift. Contact hello@buyhalfcow.com to cancel and reissue.',
        }, { status: 400 });
      }
      fields['Sale Amount'] = saleAmount;
      // Per-rancher commission via locked rate. Falls back to env default
      // only when rancher row has no Commission Rate set (gate above
      // should block Closed Won in that case — but keeps Awaiting Payment
      // flexible).
      try {
        const rancherForRate = await getRecordById(TABLES.RANCHERS, decoded.rancherId) as any;
        fields['Commission Due'] = calcCommissionForRancher(rancherForRate, saleAmount);
      } catch {
        fields['Commission Due'] = calcCommission(saleAmount);
      }
    }

    if (notes !== undefined) {
      fields['Notes'] = notes;
    }

    if (Object.keys(fields).length === 0) {
      return NextResponse.json({ error: 'No valid updates provided' }, { status: 400 });
    }

    // Stamp rancher activity — extends referral-chasup freshness window so the
    // cron doesn't auto-close leads the rancher is actively working from their
    // dashboard. Pre-2026-05-09 bug: cron used Intro Sent At only.
    fields['Last Rancher Activity At'] = new Date().toISOString();
    fields['Rancher Engaged Flag'] = true;

    // Route Status writes for machine-mapped states through transition() so
    // they are audited + events emitted. Unmapped states (Negotiation,
    // Awaiting Payment) continue as direct writes — no DealState for them yet.
    const STATUS_TO_DEAL_STATE: Record<string, 'CLOSED_WON' | 'CLOSED_LOST' | 'IN_CONVERSATION'> = {
      'Closed Won': 'CLOSED_WON',
      'Closed Lost': 'CLOSED_LOST',
      'Rancher Contacted': 'IN_CONVERSATION',
    };
    const dealStateTarget = status && STATUS_TO_DEAL_STATE[status];
    if (dealStateTarget) {
      // Build extraFields from everything except Status (machine writes that).
      const { Status: _omit, ...extraFields } = fields;
      const _tPatch = await transition(id, {
        to: dealStateTarget,
        actor: `rancher:${decoded.rancherId}`,
        reason: `dashboard PATCH: ${status}`,
        extraFields,
      });
      if (!_tPatch.ok && !_tPatch.noop) {
        // Safety net: machine rejected — fall back to original direct write + alert.
        console.error('[referrals/PATCH] transition rejected, falling back to direct write:', _tPatch.error);
        await updateRecord(TABLES.REFERRALS, id, fields);
        try {
          const { sendOperatorSignal } = await import('@/lib/operatorSignal');
          await sendOperatorSignal({ urgency: 'normal', kind: 'system-error', summary: `Deal ${id}: state-machine rejected ${dealStateTarget} on dashboard PATCH (used fallback). Check lib/deal.`, dedupeKey: `transition-fallback-${id}`, dedupeWindowMs: 3600_000 });
        } catch {}
      }
    } else {
      await updateRecord(TABLES.REFERRALS, id, fields);
    }

    // Funnel telemetry — emit close event so the admin dashboard sees this
    // dashboard-PATCH close in the same conversion funnel as quick-action and
    // Telegram closes. Contract recordClose() handles the canonical mutation
    // (Status, Closed At, capacity, Buyer Stage); legacy dashboard PATCH
    // already executed those inline above. funnelRecord here is the bridge
    // until a future refactor consolidates the close path through recordClose().
    if (status === 'Closed Won' || status === 'Closed Lost' || status === 'Awaiting Payment') {
      const { funnelRecord } = await import('@/lib/funnelMetrics');
      const outcomeKey = status === 'Closed Won' ? 'close:won' :
                         status === 'Closed Lost' ? 'close:lost' :
                         'close:awaiting_payment';
      await funnelRecord({
        stage: outcomeKey,
        rancherId: decoded.rancherId,
        referralId: id,
        amount: status === 'Closed Won' ? (saleAmount || 0) : undefined,
        reason: `dashboard-PATCH:${status}`,
      });
    }

    // Notify admin via Telegram
    try {
      const buyerName = referral['Buyer Name'] || 'Unknown';
      if (status === 'Closed Won') {
        // L2e: pull rancher's win history to show monthly + lifetime + first-sale milestone
        const allRefs = await getAllRecords(TABLES.REFERRALS) as any[];
        const rancherWins = allRefs.filter((r) => {
          if (r['Status'] !== 'Closed Won') return false;
          const ids = r['Rancher'] || r['Suggested Rancher'] || [];
          return Array.isArray(ids) && ids.includes(decoded.rancherId);
        });
        // The current referral is already updated above, so it's in rancherWins
        const isFirstSaleForRancher = rancherWins.length === 1;
        const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
        const monthlyWinsForRancher = rancherWins.filter((r) => new Date(r['Closed At'] || 0).getTime() >= monthStart);
        const monthlyCommission = monthlyWinsForRancher.reduce((s, r) => s + (r['Commission Due'] || 0), 0);
        const lifetimeCommission = rancherWins.reduce((s, r) => s + (r['Commission Due'] || 0), 0);
        // MISMATCH FIX: prior code computed `commission` with env-default
        // rate while the DB row was written with the per-rancher locked
        // rate (line 593). Telegram showed a different $ than what the
        // rancher would be invoiced for. Use the actual Commission Due
        // value that was just written (already in `fields['Commission Due']`).
        const commission = Number(fields['Commission Due']) || calcCommission(saleAmount || 0);

        await sendTelegramSaleCelebration({
          referralId: id,
          buyerName,
          rancherName: decoded.name,
          saleAmount: saleAmount || 0,
          commission,
          isFirstSaleForRancher,
          monthlyWins: monthlyWinsForRancher.length,
          monthlyCommission,
          lifetimeWins: rancherWins.length,
          lifetimeCommission,
        });

        // ── INSTANT COMMISSION INVOICE — fires on Closed Won so the rancher
        // gets the bill the moment they hit the button. Monthly cron is the
        // backstop for any unpaid rolling balance, but the invoice itself
        // lives here. Skip if no sale amount captured.
        //
        // Path:
        //   1. Try to create a Stripe Invoice (real, payable, hosted page).
        //      Stripe sends the hosted-invoice email itself when finalized.
        //   2. ALWAYS send our branded fallback email too (rancher might
        //      miss the Stripe email; ours has Ben's voice). When Stripe
        //      succeeded, we pass the hosted_invoice_url so the email's
        //      "pay" CTA points at the real invoice instead of "reply for
        //      a link".
        if (saleAmount && saleAmount > 0) {
          let stripeInvoiceUrl = '';
          let stripeInvoiceId = '';
          try {
            const rancherForInvoice = await getRecordById(TABLES.RANCHERS, decoded.rancherId) as any;
            const invoiceEmail = rancherForInvoice?.['Email'] || '';
            // Tier_v2 ranchers SKIP — commission already taken at deposit via
            // application_fee_amount. Legacy invoice here would double-bill.
            const pricingModel = String(rancherForInvoice?.['Pricing Model'] || 'legacy');
            const skipLegacyInvoice = pricingModel === 'tier_v2';
            if (skipLegacyInvoice) {
              console.log(`[referrals/close] rancher ${decoded.rancherId} is tier_v2 — skipping legacy commission invoice`);
            }
            if (invoiceEmail && !skipLegacyInvoice) {
              try {
                const stripeResult = await createCommissionInvoice({
                  rancher: {
                    id: decoded.rancherId,
                    operatorName: rancherForInvoice['Operator Name'] || decoded.name,
                    ranchName: rancherForInvoice['Ranch Name'] || decoded.name,
                    email: invoiceEmail,
                    stripeCustomerId: rancherForInvoice['Stripe Customer ID'] || undefined,
                  },
                  referral: {
                    id,
                    buyerName,
                    orderType: referral['Order Type'] || 'Beef order',
                    saleAmount,
                    commissionDue: commission,
                  },
                });
                stripeInvoiceUrl = stripeResult.invoiceUrl;
                stripeInvoiceId = stripeResult.invoiceId;
                // Persist back to the referral so dashboard can resurface it
                try {
                  await updateRecord(TABLES.REFERRALS, id, {
                    'Stripe Invoice ID': stripeInvoiceId,
                    'Stripe Invoice URL': stripeInvoiceUrl,
                  });
                } catch (persistErr: any) {
                  console.warn('[referrals/close] persist stripe invoice fields failed:', persistErr?.message);
                }
              } catch (stripeErr: any) {
                console.error('Stripe invoice create failed (falling back to plain email):', stripeErr?.message);
                // Alert admin — Stripe down + Closed Won = manual invoice needed
                try {
                  const { sendOperatorSignal } = await import('@/lib/operatorSignal');
                  await sendOperatorSignal({
                    urgency: 'loud',
                    kind: 'system-error',
                    summary: `Stripe invoice creation FAILED on Closed Won ${id}`,
                    detail: `Rancher: ${decoded.name}\nBuyer: ${buyerName}\nSale: $${saleAmount}\nCommission: $${commission}\nError: ${stripeErr?.message || 'unknown'}\n\nCreate invoice manually in Stripe + paste hosted_invoice_url into the referral's "Stripe Invoice URL" field. Branded fallback email still firing below.`,
                    refs: [{ type: 'referral', id, label: `${buyerName} → ${decoded.name}` }],
                  });
                } catch {}
              }

              // Branded email — always sent. If Stripe invoice succeeded,
              // pass the hosted-invoice URL so the CTA is a one-click Pay
              // button instead of the legacy "reply for a link / Venmo /
              // check" multi-option footer. (Stripe sends its own email too;
              // having both reinforces and lets rancher use whichever lands
              // first.)
              await sendInstantCommissionInvoice({
                operatorName: rancherForInvoice['Operator Name'] || decoded.name,
                ranchName: rancherForInvoice['Ranch Name'] || decoded.name,
                email: invoiceEmail,
                buyerName,
                orderType: referral['Order Type'] || 'Beef order',
                saleAmount,
                commissionDue: commission,
                closedAt: new Date().toISOString(),
                stripeInvoiceUrl: stripeInvoiceUrl || undefined,
              });
            }
          } catch (e) {
            console.error('Instant commission invoice error:', e);
            // Non-fatal — monthly cron will pick up unpaid commission
          }
        }

        // ── PILOT MILESTONE: fire one-time upsell alert when rancher hits goal ─
        // Read the rancher's Pilot Closes Goal. If their lifetime Closed Won
        // count just reached or exceeded it AND we haven't already fired the
        // alert, ping Ben so he can pivot the conversation to the marketing
        // retainer. Pilot Upsell Notified At guards against re-firing.
        try {
          const rancher = await getRecordById(TABLES.RANCHERS, decoded.rancherId) as any;
          const goal = Number(rancher['Pilot Closes Goal'] || 0);
          const alreadyNotified = !!rancher['Pilot Upsell Notified At'];
          if (goal > 0 && !alreadyNotified && rancherWins.length >= goal) {
            const ranchName = rancher['Ranch Name'] || decoded.name;
            await sendTelegramMessage(
              TELEGRAM_ADMIN_CHAT_ID,
              `🎯 <b>PILOT COMPLETE — UPSELL TIME</b>\n\n` +
              `🤠 ${ranchName} (${decoded.name}) just hit <b>${rancherWins.length} closed deals</b> — at or above the ${goal}-close pilot goal you set.\n\n` +
              `💰 Lifetime commission: $${lifetimeCommission.toFixed(2)}\n` +
              `📅 This month: ${monthlyWinsForRancher.length} wins · $${monthlyCommission.toFixed(2)}\n\n` +
              `<b>Time to pitch the marketing retainer.</b> Pilot proven — they're closing leads, you're delivering. Ride the momentum.\n\n` +
              `<i>Auto-sent the rancher a Calendly booking email too — they may book before you even reach out.</i>`
            );
            // Auto-send the rancher a "let's run it" email with Calendly link
            // — runs in parallel with the Telegram ping. Rancher can self-book
            // the upsell call, no human-in-the-loop needed.
            const rancherEmail = rancher['Email'] || '';
            if (rancherEmail) {
              try {
                await sendPilotUpsellEmail({
                  operatorName: rancher['Operator Name'] || decoded.name,
                  ranchName,
                  email: rancherEmail,
                  closesHit: rancherWins.length,
                  pilotGoal: goal,
                });
              } catch (e) {
                console.error('Pilot upsell email send error:', e);
              }
            }
            // Auto-pause rancher routing at pilot completion.
            // POC proves it works, then we pause new lead flow until the
            // upsell conversation lands. Prevents over-routing while the
            // retainer pitch is in flight + protects rancher attention.
            // Resume via Telegram or Airtable when ready.
            //
            // MISMATCH FIX: stamp the pause BEFORE the Telegram message so a
            // failed write doesn't produce a "rancher paused" alert while the
            // rancher is still Active in Airtable. Prior order: if updateRecord
            // threw, the Telegram message still fired, leaving operator believing
            // the rancher was paused (and skipping manual pause) while routing
            // happily over-saturated them.
            let pilotPauseWriteOk = false;
            let pilotPauseErr = '';
            try {
              await updateRecord(TABLES.RANCHERS, decoded.rancherId, {
                'Pilot Upsell Notified At': new Date().toISOString(),
                'Active Status': 'Paused',
              });
              pilotPauseWriteOk = true;
            } catch (pauseErr: any) {
              pilotPauseErr = pauseErr?.message || 'unknown';
              console.error('[pilot upsell] auto-pause Airtable write failed:', pauseErr?.message);
            }
            await sendTelegramMessage(
              TELEGRAM_ADMIN_CHAT_ID,
              pilotPauseWriteOk
                ? `⏸️ <b>${ranchName} auto-paused</b> at pilot goal. No new leads route to them until you unpause (Airtable Active Status → Active OR Telegram dashboard).`
                : `⚠️ <b>${ranchName} hit pilot goal but auto-pause FAILED</b> (${pilotPauseErr}). Manually flip Active Status → Paused in Airtable so leads stop routing while you pitch the retainer.`
            );
          }
        } catch (e) {
          console.error('Pilot milestone check error:', e);
        }
      } else if (status) {
        await sendTelegramUpdate(
          `${decoded.name} updated referral for ${buyerName} to: <b>${status}</b>`
        );
      }
    } catch (e) {
      console.error('Telegram notification error:', e);
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Rancher referral update error:', error);
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}
