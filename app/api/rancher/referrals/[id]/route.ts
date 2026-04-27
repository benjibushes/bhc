import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getRecordById, updateRecord, getAllRecords } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendTelegramUpdate, sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID, sendTelegramSaleCelebration } from '@/lib/telegram';
import { sendRerouteNotification } from '@/lib/email';
import { isQualifiedForRouting } from '@/lib/qualification';
import jwt from 'jsonwebtoken';

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

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-member-secret-change-me';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const cookieStore = await cookies();
    const sessionCookie = cookieStore.get('bhc-rancher-auth');

    if (!sessionCookie?.value) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    let decoded: any;
    try {
      decoded = jwt.verify(sessionCookie.value, JWT_SECRET);
    } catch {
      return NextResponse.json({ error: 'Session expired' }, { status: 401 });
    }

    if (decoded.type !== 'rancher-session') {
      return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
    }

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
      await updateRecord(TABLES.REFERRALS, id, {
        'Status': 'Closed Lost',
        'Closed At': new Date().toISOString(),
        'Notes': `${passNote}\n${referral['Notes'] || ''}`.trim(),
      });

      // 2. Decrement rancher's active referral count
      try {
        const rancher = await getRecordById(TABLES.RANCHERS, decoded.rancherId) as any;
        const currentCount = rancher['Current Active Referrals'] || 0;
        await updateRecord(TABLES.RANCHERS, decoded.rancherId, {
          'Current Active Referrals': Math.max(0, currentCount - 1),
        });
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

    const fields: Record<string, any> = {};

    // Ranchers can update to these statuses
    const allowedStatuses = ['Rancher Contacted', 'Negotiation', 'Closed Won', 'Closed Lost'];
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

      if (status === 'Closed Won' || status === 'Closed Lost') {
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
              await updateRecord(TABLES.CONSUMERS, buyerId, {
                'Referral Status': 'Closed Won',
                'Sequence Stage': 'purchased',
                'Buyer Health': 'Closed Won',
                'Missed Responses': 0,
              });
            } catch (e) {
              console.error('Closed Won buyer status sync error:', e);
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

        // Decrement active referral count
        try {
          const rancher = await getRecordById(TABLES.RANCHERS, decoded.rancherId) as any;
          const currentCount = rancher['Current Active Referrals'] || 0;
          await updateRecord(TABLES.RANCHERS, decoded.rancherId, {
            'Current Active Referrals': Math.max(0, currentCount - 1),
          });

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

          // ── CLOSED WON or LOST: Auto-match waiting consumers to freed-up capacity ──
          // Use isQualifiedForRouting to ensure only opted-in buyers (warmup-engaged
          // OR fresh hot signups) get auto-matched. Without this, every freed slot
          // would route an unqualified buyer to the rancher who just closed a deal.
          if (rancherState) {
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

    if (saleAmount !== undefined && saleAmount > 0) {
      fields['Sale Amount'] = saleAmount;
      const commissionRate = Number(process.env.NEXT_PUBLIC_COMMISSION_RATE || '0.10');
      fields['Commission Due'] = Math.round(saleAmount * commissionRate * 100) / 100;
    }

    if (notes !== undefined) {
      fields['Notes'] = notes;
    }

    if (Object.keys(fields).length === 0) {
      return NextResponse.json({ error: 'No valid updates provided' }, { status: 400 });
    }

    await updateRecord(TABLES.REFERRALS, id, fields);

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
        const commission = Math.round((saleAmount || 0) * 0.10 * 100) / 100;

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
              `<b>Time to pitch the marketing retainer.</b> Pilot proven — they're closing leads, you're delivering. Ride the momentum.`
            );
            await updateRecord(TABLES.RANCHERS, decoded.rancherId, {
              'Pilot Upsell Notified At': new Date().toISOString(),
            });
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
