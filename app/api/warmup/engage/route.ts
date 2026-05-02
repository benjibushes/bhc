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
      await updateRecord(TABLES.CONSUMERS, payload.consumerId, {
        'Warmup Engaged At': new Date().toISOString(),
        'Warmup Stage': 'engaged',
        'Ready to Buy': true,
      });
    }

    // ── FIRST-WEEK FOUNDER APPROVAL GATE (Project 2) ─────────────────────
    // Sits IN FRONT of matching/suggest. Local-only — find an
    // operationally-Live rancher serving the buyer's state. If they're
    // still in their onboarding window (Trust Mode=false AND <5 intros
    // since they went live), stage a pending-approval referral + ping
    // Telegram, redirect with ?pending=true, and SKIP matching/suggest.
    //
    // If Trust Mode=true OR intro budget already met, gate releases and
    // we fall through to the normal immediate-route block below.
    let gateActive = false;
    let gateRancherName = '';
    let gateRancherState = '';
    if (consumer['Email'] && consumer['State']) {
      try {
        const inStateRancher = await findInStateRancher(consumer['State']);
        if (inStateRancher && !inStateRancher['Trust Mode']) {
          // Approved At is the closest "rancher went live" timestamp we
          // have without adding new schema. Falls back to created/null
          // (counts all-time) which is fine — the threshold still gates.
          const sinceISO: string | null = inStateRancher['Approved At']
            || inStateRancher['Agreement Signed At']
            || null;
          const onboardingIntros = await countOnboardingIntros(inStateRancher.id, sinceISO);
          if (onboardingIntros < 5) {
            await stageOnboardingApproval({ rancherId: inStateRancher.id, buyer: consumer });
            gateActive = true;
            gateRancherName = inStateRancher['Operator Name'] || inStateRancher['Ranch Name'] || '';
            gateRancherState = inStateRancher['State'] || normalizeState(consumer['State']);
          }
        }
      } catch (e: any) {
        // Fail open: if the gate logic errors, fall through to immediate
        // route. Better to ship the buyer than to strand them on an error.
        console.error('[firstweek-gate] error, failing open:', e?.message);
      }
    }

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
      // Buyer Stage flip to MATCHED happens ONLY when the gate is open OR
      // when matching/suggest succeeds. Pending-approval buyers stay at
      // their prior stage (READY) until Ben taps Approve on Telegram.
      try {
        await updateRecord(TABLES.CONSUMERS, payload.consumerId, {
          'Buyer Stage': 'MATCHED',
          'Buyer Stage Updated At': new Date().toISOString(),
        });
      } catch (e: any) {
        console.error('[warmup/engage] stage flip failed:', e?.message);
      }
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
            // Capture rancher info for the ceremonial handoff page redirect.
            // Even if matching returned alreadyActive (idempotent re-click), we
            // pull the rancher name from the response so the buyer sees the
            // right handoff content.
            try {
              const j = await matchRes.json();
              if (j.suggestedRancher?.name) {
                matchedRancherName = j.suggestedRancher.name;
                matchedRancherState = j.suggestedRancher.state || '';
              }
            } catch { /* non-fatal: redirect to /member fallback below */ }
          } else {
            console.warn(`Immediate route attempt for ${payload.consumerId} returned ${matchRes.status} — buyer flagged Ready to Buy, will route on next opportunity`);
          }
        } catch (e: any) {
          console.error('Immediate route on YES click failed:', e?.message);
        }
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
