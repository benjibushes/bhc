import { NextResponse } from 'next/server';
import { getRecordById, getAllRecords, escapeAirtableValue, TABLES } from '@/lib/airtable';
import { depositPathFor, type Cut } from '@/lib/reserveDeposit';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { resolveBuyerSession } from '@/lib/buyerAuth';
import { funnelRecord } from '@/lib/funnelMetrics';
import { checkOriginGuard } from '@/lib/csrfGuard';

export const maxDuration = 30;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

// Repeat-customer reorder flow — fixes the largest revenue leak in the
// platform today. Without this, a buyer who closes a deal with rancher X
// has the rancher's contact info and goes direct on the next order. We
// see $0 commission on the reorder.
//
// This endpoint creates a fresh referral routed to the same rancher via
// the matching engine's "direct page lead" code path (campaign=rancher-{slug}).
// The rancher gets re-introduced, the platform stays in the loop, and the
// commission applies to the next sale.
//
// Body:
//   { previousReferralId?: string, rancherId?: string }
// Either identifies which rancher to reorder from. If both are missing,
// we look at the buyer's most recent Closed Won referral.
export async function POST(request: Request) {
  try {
    const originCheck = checkOriginGuard(request);
    if (!originCheck.ok && originCheck.response) return originCheck.response;
    const session = await resolveBuyerSession(request);
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    const memberId = session.consumerId;
    const memberEmail = session.email;

    const body = await request.json().catch(() => ({}));
    const { previousReferralId, rancherId: explicitRancherId } = body || {};

    const consumer: any = await getRecordById(TABLES.CONSUMERS, memberId);
    if (!consumer) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }
    const buyerName = consumer['Full Name'] || '';
    const buyerState = consumer['State'] || '';
    const buyerPhone = consumer['Phone'] || '';
    const orderType = consumer['Order Type'] || '';
    const budget = consumer['Budget'] || '';
    const intentScore = consumer['Intent Score'] || 75; // Returning buyer ⇒ high intent

    // Resolve target rancher. Three paths in priority order:
    //   1. Explicit rancherId from request body
    //   2. previousReferralId → look up its rancher
    //   3. Buyer's most-recent Closed Won → that rancher
    //
    // Paths 1 + 2 take caller-supplied ids, and the downstream matching call
    // (campaign=rancher-{slug}) bypasses the soft capacity cap — so BOTH must
    // be proven to belong to THIS buyer's own order history. Otherwise any
    // logged-in member could enumerate rancher/referral ids and route
    // themselves to an arbitrary rancher cap-free.
    let rancherId: string | null = null;

    // Buyer's own Closed Won history — ownership source of truth for paths 1+3.
    let myClosedWon: any[] = [];
    try {
      myClosedWon = await getAllRecords(
        TABLES.REFERRALS,
        `AND({Buyer Email} = "${escapeAirtableValue((memberEmail || '').toLowerCase())}", {Status} = "Closed Won")`
      ) as any[];
    } catch (e) {
      console.error('Reorder: closed-won lookup error:', e);
    }
    const myRancherIds = new Set<string>(
      myClosedWon.flatMap((r: any) => {
        const links = r['Rancher'] || r['Suggested Rancher'] || [];
        return Array.isArray(links) ? links : [];
      })
    );

    if (explicitRancherId) {
      if (!myRancherIds.has(explicitRancherId)) {
        return NextResponse.json({
          error: 'No previous order with this rancher found on your account.',
        }, { status: 403 });
      }
      rancherId = explicitRancherId;
    } else if (previousReferralId) {
      try {
        const ref: any = await getRecordById(TABLES.REFERRALS, previousReferralId);
        const refEmail = String(ref?.['Buyer Email'] || '').trim().toLowerCase();
        if (refEmail !== (memberEmail || '').trim().toLowerCase()) {
          return NextResponse.json({
            error: 'That order does not belong to this account.',
          }, { status: 403 });
        }
        const links = ref?.['Rancher'] || ref?.['Suggested Rancher'] || [];
        rancherId = Array.isArray(links) ? links[0] : null;
      } catch (e) {
        console.error('Reorder: previous referral lookup error:', e);
      }
    } else {
      const sorted = myClosedWon.sort((a, b) => {
        const at = new Date(a['Closed At'] || 0).getTime();
        const bt = new Date(b['Closed At'] || 0).getTime();
        return bt - at;
      });
      const links = sorted[0]?.['Rancher'] || sorted[0]?.['Suggested Rancher'] || [];
      rancherId = Array.isArray(links) ? links[0] : null;
    }

    if (!rancherId) {
      return NextResponse.json({
        error: 'No previous order found. Use the regular matching flow to find a rancher.',
      }, { status: 404 });
    }

    // Verify rancher is still operational before re-introducing. Use the
    // shared eligibility helper — same rule as signup + match engine + warmup.
    const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);
    if (!rancher) {
      return NextResponse.json({ error: 'Previous rancher no longer in network' }, { status: 404 });
    }
    const { isRancherOperationalForBuyers } = await import('@/lib/rancherEligibility');
    if (!isRancherOperationalForBuyers(rancher)) {
      return NextResponse.json({
        error: `${rancher['Operator Name'] || rancher['Ranch Name']} is currently paused. We'll match you with another rancher in your state.`,
        fallbackToMatch: true,
      }, { status: 409 });
    }

    const rancherSlug = rancher['Slug'] || '';
    if (!rancherSlug) {
      return NextResponse.json({ error: 'Rancher profile incomplete' }, { status: 409 });
    }

    // Fire matching with campaign=rancher-{slug} so the matching engine routes
    // directly to this rancher (its "direct page lead" code path). This bypasses
    // capacity for direct-pick reorders since the buyer is asking for THIS rancher.
    const matchRes = await fetch(`${SITE_URL}/api/matching/suggest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.INTERNAL_API_SECRET ? { 'x-internal-secret': process.env.INTERNAL_API_SECRET } : {}),
      },
      body: JSON.stringify({
        buyerState,
        buyerId: memberId,
        buyerName,
        buyerEmail: memberEmail,
        buyerPhone,
        orderType,
        budgetRange: budget,
        intentScore,
        intentClassification: 'High',
        notes: '[REORDER] Returning customer requesting another order from this rancher.',
        campaign: `rancher-${rancherSlug}`,
      }),
    });

    let referralId: string | null = null;
    let matchOk = false;
    if (matchRes.ok) {
      const data = await matchRes.json();
      referralId = data.referralId || null;
      matchOk = !!data.matchFound;
    }

    // H-2 audit fix: funnel event for the reorder moment. Pre-fix, repeat
    // purchases were the largest unmeasured revenue stream — buyers came
    // back, hit reorder, no telemetry. Now: /admin/funnel sees the actual
    // lifetime value signal.
    try {
      await funnelRecord({
        stage: 'repeat_purchase_requested',
        buyerId: memberId,
        rancherId,
        referralId: referralId || undefined,
        metadata: {
          state: buyerState,
          rancherSlug,
          rematchOk: matchOk,
          previousReferralId: previousReferralId || null,
        },
      });
    } catch (e) { console.error('[funnel] repeat_purchase_requested failed:', e); }

    // Telegram so Ben knows a reorder is in flight
    try {
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `🔁 <b>REORDER REQUESTED</b>\n\n` +
        `👤 ${buyerName} (${buyerState})\n` +
        `🤠 Wants another order from: <b>${rancher['Operator Name'] || rancher['Ranch Name']}</b>\n` +
        `📦 ${orderType || 'Same as before'} · ${budget || 'Same budget'}\n\n` +
        (matchOk
          ? `✅ Re-introduction sent — both parties notified`
          : `⚠️ Re-introduction failed — manual reconnect needed`)
      );
    } catch (e) {
      console.error('Reorder: telegram alert error:', e);
    }

    // tier_v2 + Connect-active rancher → the returning buyer (already authed,
    // referral pinned) goes straight to a 1-tap deposit instead of waiting on
    // another re-intro email. Legacy/ineligible → depositUrl null, existing
    // re-intro path stands.
    const { isRancherOnConnect } = await import('@/lib/rancherEligibility');
    const reorderCut: Cut = /whole/i.test(orderType) ? 'whole' : /quarter/i.test(orderType) ? 'quarter' : 'half';
    const depositUrl =
      matchOk && referralId && isRancherOnConnect(rancher)
        ? depositPathFor(referralId, reorderCut)
        : null;

    return NextResponse.json({
      success: true,
      matched: matchOk,
      referralId,
      depositUrl,
      rancherName: rancher['Operator Name'] || rancher['Ranch Name'],
    });
  } catch (error: any) {
    console.error('Reorder error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
