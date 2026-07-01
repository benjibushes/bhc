import { NextResponse } from 'next/server';
import { getAllRecords, getRecordById, updateRecord, createRecord, TABLES } from '@/lib/airtable';
import { isRancherOperationalForBuyers, getOperationalServedStates } from '@/lib/rancherEligibility';
import { normalizeState } from '@/lib/states';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import jwt from 'jsonwebtoken';

import { JWT_SECRET } from '@/lib/secrets';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

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
      const ts = ref['Approved At'] || ref['Intro Sent At'] || ref['Created'] || ref.createdTime || ref._createdTime;
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

    // ── QUALIFICATION GATE INTERSTITIAL (2026-06-03) ─────────────────────
    // YES click NO LONGER fires matching/suggest synchronously. Instead the
    // buyer is redirected to /qualify/<consumerId>?token=<qualifyJwt> where
    // a gamified 4-question quiz validates real intent (tier, timing, storage,
    // ack). Only after the quiz passes does /api/qualify fire matching/suggest
    // and either route to the rancher OR (for tier_v2 ranchers) jump straight
    // to /checkout/<refId>/deposit.
    //
    // Rancher value: only QUALIFIED buyers (cleared all 4 questions + ack'd
    // commitment) reach their inbox. Eliminates window-shoppers + bot YES
    // clicks. Buyer value: clearer expectations + ability to skip the call
    // and pay deposit immediately if they know what they want.
    //
    // Stage transition: still flip to MATCHED inside /api/qualify (after
    // routing succeeds). Here we just stamp engagement (already done above)
    // and prepare the auth session for the /qualify page.
    //
    // Backwards-compat: if the buyer already passed quiz and re-clicks YES
    // (rare — they got a duplicate RTB email), /qualify GET will detect
    // Qualification Path is set and skip straight to /matched.

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

    // Qualification gate handoff —
    //   • already-qualified (rare re-click) → /matched
    //   • first-time YES click             → /qualify/<consumerId>?token=<qualifyJwt>
    //
    // The qualify JWT is short-lived (24h) and scoped to ONE consumerId. It's
    // what /api/qualify verifies on quiz submission. Separate from the member-
    // session cookie because we want the page to be one-shot (refreshes after
    // quiz pass redirect to /matched naturally).
    const alreadyQualified =
      !!consumer['Qualified At'] &&
      String(consumer['Qualification Path'] || '') !== 'incomplete';
    let handoffUrl: string;
    if (alreadyQualified) {
      // Buyer already passed the quiz once — skip to /matched. Their existing
      // referral is still in play; matching/suggest was already fired by the
      // first /api/qualify call.
      handoffUrl = `${SITE_URL}/matched?already=qualified`;
    } else {
      const qualifyJwt = jwt.sign(
        {
          type: 'qualify-access',
          consumerId: payload.consumerId,
          email: (consumer['Email'] || '').trim().toLowerCase(),
        },
        JWT_SECRET,
        { expiresIn: '24h' }
      );
      handoffUrl = `${SITE_URL}/qualify/${encodeURIComponent(payload.consumerId)}?token=${encodeURIComponent(qualifyJwt)}`;
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
