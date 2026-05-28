import { NextResponse } from 'next/server';
import { getAllRecords, getRecordById, updateRecord, createRecord, TABLES } from '@/lib/airtable';
import { isRancherOperationalForBuyers, getOperationalServedStates } from '@/lib/rancherEligibility';
import { normalizeState } from '@/lib/states';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import jwt from 'jsonwebtoken';

import { JWT_SECRET } from '@/lib/secrets';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

// Statuses that count toward the rancher's "first week" intro budget.
// Includes terminal closes so the gate doesn't stay shut for an
// already-busy rancher that closed early winners — they've earned the
// next intro.
const ONBOARDING_INTRO_STATUSES = ['Intro Sent', 'Rancher Contacted', 'Negotiation', 'Closed Won', 'Closed Lost'];

// Find the operationally-Live rancher serving this buyer's state. Local-only
// routing — Ships Nationwide isn't honored. If multiple ranchers serve the
// state, picks the first match (matching/suggest runs the real ranking
// downstream when the gate releases the buyer).
async function findInStateRancher(buyerState: unknown): Promise<any | null> {
  const stateNorm = normalizeState(buyerState);
  if (!stateNorm) return null;
  const allRanchers = await getAllRecords(TABLES.RANCHERS) as any[];
  for (const r of allRanchers) {
    if (!isRancherOperationalForBuyers(r)) continue;
    const served = getOperationalServedStates(r);
    if (served.includes(stateNorm)) return r;
  }
  return null;
}

// Count referrals matching the rancher + status set, optionally filtered
// to those created since `sinceISO`. Used to gate the founder-approval
// flow: in the first week, every intro to a new rancher needs Ben's eyes.
async function countOnboardingIntros(rancherId: string, sinceISO?: string | null): Promise<number> {
  const refs = await getAllRecords(TABLES.REFERRALS) as any[];
  let count = 0;
  const sinceMs = sinceISO ? new Date(sinceISO).getTime() : 0;
  for (const ref of refs) {
    const linked: string[] = ref['Rancher'] || [];
    if (!linked.includes(rancherId)) continue;
    const status = ref['Status'] || '';
    if (!ONBOARDING_INTRO_STATUSES.includes(status)) continue;
    if (sinceMs > 0) {
      const ts = ref['Approved At'] || ref['Intro Sent At'] || ref['Created'] || ref.createdTime;
      const tsMs = ts ? new Date(ts).getTime() : 0;
      if (tsMs > 0 && tsMs < sinceMs) continue;
    }
    count++;
  }
  return count;
}

// Stage a pending-approval referral and ping Ben on Telegram with
// approve / hold / skip buttons. The referral row is created with
// Status=Pending Approval AND Approval Status=pending-approval so it
// shows up in audit + admin queries. Telegram callback handlers in
// app/api/webhooks/telegram/route.ts (firstweek_*) flip Approval Status
// to approved/held/skipped and either fire matching/suggest, requeue
// 7d later, or move to next-best.
async function stageOnboardingApproval(args: {
  rancherId: string;
  buyer: any;
}): Promise<{ stagedRefId: string | null }> {
  const { rancherId, buyer } = args;
  let rancher: any = null;
  try { rancher = await getRecordById(TABLES.RANCHERS, rancherId); } catch {}
  const ranchName = rancher?.['Operator Name'] || rancher?.['Ranch Name'] || 'rancher';

  // Idempotency guard. Audit finding 2026-05-20 #19: warmup/engage fires
  // every YES click, and previously this function created a NEW
  // Pending Approval referral + Telegram ping on every click → duplicate
  // alerts to Ben + orphan referrals. Skip if a Pending Approval row
  // already exists for this buyer-rancher pair.
  //
  // Filter client-side because Airtable filterByFormula's ARRAYJOIN
  // on linked-record fields renders the primary-field VALUE, not the
  // record ID — so FIND(id, ARRAYJOIN({Rancher})) silently never
  // matches. Same bug as the rancher dashboard (PR #36 audit #30).
  try {
    const allRefs = (await getAllRecords(TABLES.REFERRALS)) as any[];
    const existing = allRefs.filter((r: any) => {
      if (r['Status'] !== 'Pending Approval') return false;
      const buyers = Array.isArray(r['Buyer']) ? r['Buyer'] : [];
      if (!buyers.includes(buyer.id)) return false;
      const rancher = Array.isArray(r['Rancher']) ? r['Rancher'] : [];
      const suggested = Array.isArray(r['Suggested Rancher']) ? r['Suggested Rancher'] : [];
      return rancher.includes(rancherId) || suggested.includes(rancherId);
    });
    if (existing.length > 0) {
      console.log(`[firstweek] skip — pending approval already exists: ${existing[0].id}`);
      return { stagedRefId: existing[0].id };
    }
  } catch (e: any) {
    console.warn('[firstweek] dedupe check failed; staging anyway:', e?.message);
  }

  let stagedRefId: string | null = null;
  try {
    const ref: any = await createRecord(TABLES.REFERRALS, {
      'Buyer': [buyer.id],
      'Suggested Rancher': [rancherId],
      'Suggested Rancher Name': ranchName,
      'Suggested Rancher State': rancher?.['State'] || '',
      'Status': 'Pending Approval',
      'Approval Status': 'pending-approval',
      'Buyer Name': buyer['Full Name'] || '',
      'Buyer Email': buyer['Email'] || '',
      'Buyer Phone': buyer['Phone'] || '',
      'Buyer State': normalizeState(buyer['State']) || (buyer['State'] || ''),
      'Order Type': buyer['Order Type'] || '',
      'Budget Range': buyer['Budget'] || buyer['Budget Range'] || '',
      'Intent Score': buyer['Intent Score'] || 0,
      'Intent Classification': buyer['Intent Classification'] || '',
      'Notes': buyer['Notes'] || '',
      'Match Type': 'Local',
    });
    stagedRefId = ref.id;
  } catch (e: any) {
    console.error('[firstweek] failed to stage referral:', e?.message);
  }

  if (stagedRefId) {
    try {
      const buyerLine = `${buyer['Full Name'] || 'Buyer'} (${normalizeState(buyer['State']) || buyer['State'] || '?'}) — ${buyer['Order Type'] || '?'}, intent ${buyer['Intent Score'] || 0}`;
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `🛂 <b>FIRST-WEEK APPROVAL</b>\n\n` +
        `New buyer wants to match with <b>${ranchName}</b> but they're still in onboarding (&lt;5 intros so far).\n\n` +
        `${buyerLine}\n\n` +
        `<i>Approve fires matching/suggest now. Hold re-queues 7d. Skip moves to next-best or back to WAITING.</i>`,
        {
          inline_keyboard: [[
            { text: '✅ Approve', callback_data: `firstweek_approve_${stagedRefId}` },
            { text: '⏸️ Hold 7d', callback_data: `firstweek_hold_${stagedRefId}` },
            { text: '⏭️ Skip', callback_data: `firstweek_skip_${stagedRefId}` },
          ]],
        }
      );
    } catch (e: any) {
      console.error('[firstweek] telegram alert failed:', e?.message);
    }
  }

  return { stagedRefId };
}

// GET /api/warmup/engage?token=...
// Marks a waitlisted buyer as engaged with the rancher launch-warmup email,
// then redirects to a confirmation page. Token is a signed JWT so the link
// can't be enumerated.
//
// First-week founder-approval gate (Project 2 — Onboarding Throttle):
// If the in-state rancher is still in onboarding (Trust Mode=false AND
// fewer than 5 onboarding-window intros so far), the YES click stages a
// pending-approval referral and pings Ben on Telegram instead of firing
// matching/suggest immediately. Buyer redirects to /matched?pending=true
// with copy that explains the 24-48h vetting window.
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const token = searchParams.get('token');

    if (!token) {
      return NextResponse.redirect(`${SITE_URL}/access?error=missing-token`);
    }

    let payload: any;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch {
      return NextResponse.redirect(`${SITE_URL}/access?error=expired-token`);
    }

    if (payload.type !== 'warmup-engage' || !payload.consumerId) {
      return NextResponse.redirect(`${SITE_URL}/access?error=bad-token`);
    }

    const consumer: any = await getRecordById(TABLES.CONSUMERS, payload.consumerId);
    if (!consumer) {
      return NextResponse.redirect(`${SITE_URL}/access?error=not-found`);
    }

    const wasAlreadyEngaged = !!consumer['Warmup Engaged At'];
    if (!wasAlreadyEngaged) {
      // Setting Ready to Buy = true here. The warmup/ready-to-buy email's
      // CTA copy explicitly asks "Ready to buy in the next 1-2 months?" —
      // clicking YES is affirmation of both engagement AND purchase intent.
      //
      // Buyer Stage transition: WAITING/READY → MATCHED. matching/suggest
      // below fires the actual referral. If matching fails (no rancher),
      // the post-match catch lower in this handler reverts the stage to
      // READY since the YES click implies they want to be matched ASAP.
      //
      // Note: when the first-week founder-approval gate intercepts, we
      // still mark Warmup Engaged At + Ready to Buy because the buyer DID
      // click YES — but we hold off flipping Buyer Stage to MATCHED until
      // Ben approves on Telegram (callback handler does that flip).
      //
      // recordBuyerEngagement contract stamps Warmup Engaged At + Ready to Buy
      // AND emits an 'engaged' Funnel Event for the conversion dashboard.
      // Warmup Stage is BHC-internal and not part of the contract; keep direct
      // updateRecord for that field only.
      const { recordBuyerEngagement } = await import('@/lib/contracts');
      await recordBuyerEngagement(payload.consumerId);
      await updateRecord(TABLES.CONSUMERS, payload.consumerId, {
        'Warmup Stage': 'engaged',
      });
    }

    // ── FIRST-WEEK FOUNDER APPROVAL GATE — REMOVED 2026-05-22 ─────────────
    // Per ops directive: "Customers identify if they get contacted by the
    // rancher based on if they're Ready to Buy." Clicking YES on the warmup
    // email already flips Ready to Buy = true (above) — that IS the consent
    // gate. Inserting a second human-approval gate behind it forced manual
    // taps in Telegram for every R2B buyer, defeating the autonomous
    // routing engine. Removed.
    //
    // The stageOnboardingApproval function is preserved in this file in
    // case a future scenario (e.g. brand-new rancher's first-ever buyer
    // needs a different vetting policy) wants to re-enable selectively.
    const gateActive = false;
    const gateRancherName = '';
    const gateRancherState = '';

    let matchedRancherName = '';
    let matchedRancherState = '';

    if (!gateActive) {
      // ── IMMEDIATE ROUTE on YES click ──────────────────────────────────
      // The user's vision: signup → welcome → ready-to-buy prompt → click →
      // intro fires within seconds. We trigger matching/suggest synchronously
      // here so the buyer + rancher get the intro emails before they even
      // close their browser tab. matching/suggest is idempotent — if they
      // already have an active referral it returns the existing one cleanly.
      //
      // NOTE: this fires on EVERY click, not just the first. Previously we
      // gated on `!wasAlreadyEngaged` — but that left a hole where a buyer
      // who engaged when no rancher was live (or rancher was at capacity)
      // could click again later and have nothing happen. Re-attempting is
      // safe because matching/suggest is idempotent.
      //
      // Buyer Stage flip happens AFTER matching/suggest returns. Previously
      // we pre-emptively flipped to MATCHED before firing matching, which
      // stranded buyers in MATCHED stage with no referral when matching
      // failed (no rancher available, all at capacity, etc.). Now:
      //   - matchFound      → MATCHED
      //   - alreadyActive   → MATCHED (idempotent re-click, prior match holds)
      //   - no match        → READY (engaged, waiting for capacity to open)
      //   - matching errored → READY (recovery cron will retry)
      let matchOutcome: 'matched' | 'ready' = 'ready';
      if (consumer['Email'] && consumer['State']) {
        try {
          const matchRes = await fetch(`${SITE_URL}/api/matching/suggest`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(process.env.INTERNAL_API_SECRET ? { 'x-internal-secret': process.env.INTERNAL_API_SECRET } : {}),
            },
            body: JSON.stringify({
              buyerState: consumer['State'],
              buyerId: payload.consumerId,
              buyerName: consumer['Full Name'] || '',
              buyerEmail: consumer['Email'],
              buyerPhone: consumer['Phone'] || '',
              orderType: consumer['Order Type'] || '',
              budgetRange: consumer['Budget'] || '',
              intentScore: consumer['Intent Score'] || 0,
              intentClassification: consumer['Intent Classification'] || '',
              notes: consumer['Notes'] || '',
              // Hot-lead bypass: warmup-engaged buyers can route to over-cap
              // ranchers. Matching/suggest will fire a Telegram alert if the
              // bypass triggers.
              warmupEngaged: true,
            }),
          });
          if (matchRes.ok) {
            try {
              const j = await matchRes.json();
              if (j.suggestedRancher?.name) {
                matchedRancherName = j.suggestedRancher.name;
                matchedRancherState = j.suggestedRancher.state || '';
              }
              if (j.matchFound || j.alreadyActive) {
                matchOutcome = 'matched';
              }
            } catch { /* non-fatal: redirect to /member fallback below */ }
          } else {
            console.warn(`Immediate route attempt for ${payload.consumerId} returned ${matchRes.status} — buyer flagged Ready to Buy, will route on next opportunity`);
          }
        } catch (e: any) {
          console.error('Immediate route on YES click failed:', e?.message);
        }
      }

      // Now flip stage based on outcome. READY means "engaged + waiting for
      // capacity"; the stuck-buyer-recovery cron retries READY buyers daily.
      //
      // MISMATCH FIX: prior version swallowed errors silently. Buyer's
      // Warmup Engaged At was already stamped (line 254 above), so on a
      // stage-flip failure the buyer entered a half-engaged state: cron
      // can't see them in MATCHED/READY and skips, but Warmup Engaged At=true
      // marks them as "already engaged" for re-warm-cohort. Now: surface to
      // Telegram so operator can manually fix the stage.
      try {
        const { transitionBuyerStage } = await import('@/lib/contracts');
        await transitionBuyerStage(
          payload.consumerId,
          matchOutcome === 'matched' ? 'MATCHED' : 'READY',
          `engage:${matchOutcome}`,
        );
      } catch (e: any) {
        console.error('[warmup/engage] stage flip failed:', e?.message);
        try {
          const { sendOperatorSignal } = await import('@/lib/operatorSignal');
          await sendOperatorSignal({
            urgency: 'loud',
            kind: 'system-error',
            summary: `🚨 ENGAGE STAGE FLIP FAILED: ${consumer['Full Name'] || consumer['Email'] || payload.consumerId} clicked YES but Buyer Stage write threw`,
            detail: `Warmup Engaged At stamped (Ready to Buy=true). Manually set Buyer Stage='${matchOutcome === 'matched' ? 'MATCHED' : 'READY'}' in Airtable so cron picks them up. Error: ${(e?.message || 'unknown').slice(0, 200)}`,
            refs: [{ type: 'consumer', id: payload.consumerId, label: consumer['Full Name'] || consumer['Email'] || '?' }],
            dedupeKey: `engage-stage-fail:${payload.consumerId}`,
          });
        } catch {}
      }
    }

    // Auto-login: the warmup JWT already verified this person owns the
    // consumerId (only they have the email-issued token). That's enough auth
    // to grant them a member session. Without this cookie, /member's
    // MemberAuthGuard would bounce them to /member/login — making it look
    // like the YES click did nothing and dumping them on a signup-style
    // form. Mint a 30-day session cookie so they land logged in.
    //
    // CRITICAL: include state and name fields. /api/member/content reads
    // decoded.state to filter ranchers by the buyer's state. Without it
    // the dashboard would show "0 ranchers in your state" even after a
    // successful match.
    const sessionToken = jwt.sign(
      {
        type: 'member-session',
        consumerId: payload.consumerId,
        email: (consumer['Email'] || '').trim().toLowerCase(),
        state: consumer['State'] || '',
        name: consumer['Full Name'] || '',
      },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    // Ceremonial handoff page —
    //   • gateActive  → /matched?rancher=...&state=...&pending=true (vetting copy)
    //   • match found → /matched?rancher=...&state=...           (standard handoff)
    //   • no match    → /member?warmup=engaged                    (logged-in fallback)
    let handoffUrl: string;
    if (gateActive && gateRancherName) {
      handoffUrl = `${SITE_URL}/matched?rancher=${encodeURIComponent(gateRancherName)}&state=${encodeURIComponent(gateRancherState)}&pending=true`;
    } else if (matchedRancherName) {
      handoffUrl = `${SITE_URL}/matched?rancher=${encodeURIComponent(matchedRancherName)}&state=${encodeURIComponent(matchedRancherState)}`;
    } else {
      handoffUrl = `${SITE_URL}/member?warmup=engaged`;
    }
    const response = NextResponse.redirect(handoffUrl);
    response.cookies.set('bhc-member-auth', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60, // 30 days
      path: '/',
    });
    return response;
  } catch (error: any) {
    console.error('Warmup engage error:', error);
    return NextResponse.redirect(`${SITE_URL}/access?error=server`);
  }
}
