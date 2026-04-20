import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getRecordById, getAllRecords, escapeAirtableValue, TABLES } from '@/lib/airtable';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import jwt from 'jsonwebtoken';

export const maxDuration = 30;

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-member-secret-change-me';
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
    const cookieStore = await cookies();
    const sessionCookie = cookieStore.get('bhc-member-auth');
    if (!sessionCookie?.value) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    let memberId = '';
    let memberEmail = '';
    try {
      const decoded: any = jwt.verify(sessionCookie.value, JWT_SECRET);
      if (decoded.type === 'member-session') {
        memberId = decoded.consumerId || '';
        memberEmail = decoded.email || '';
      }
    } catch {
      return NextResponse.json({ error: 'Session expired' }, { status: 401 });
    }
    if (!memberId) {
      return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
    }

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
    let rancherId: string | null = null;
    if (explicitRancherId) {
      rancherId = explicitRancherId;
    } else if (previousReferralId) {
      try {
        const ref: any = await getRecordById(TABLES.REFERRALS, previousReferralId);
        const links = ref?.['Rancher'] || ref?.['Suggested Rancher'] || [];
        rancherId = Array.isArray(links) ? links[0] : null;
      } catch (e) {
        console.error('Reorder: previous referral lookup error:', e);
      }
    } else {
      try {
        const myReferrals = await getAllRecords(
          TABLES.REFERRALS,
          `AND({Buyer Email} = "${escapeAirtableValue((memberEmail || '').toLowerCase())}", {Status} = "Closed Won")`
        ) as any[];
        const sorted = myReferrals.sort((a, b) => {
          const at = new Date(a['Closed At'] || 0).getTime();
          const bt = new Date(b['Closed At'] || 0).getTime();
          return bt - at;
        });
        const links = sorted[0]?.['Rancher'] || sorted[0]?.['Suggested Rancher'] || [];
        rancherId = Array.isArray(links) ? links[0] : null;
      } catch (e) {
        console.error('Reorder: closed-won lookup error:', e);
      }
    }

    if (!rancherId) {
      return NextResponse.json({
        error: 'No previous order found. Use the regular matching flow to find a rancher.',
      }, { status: 404 });
    }

    // Verify rancher is still active before re-introducing
    const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);
    if (!rancher) {
      return NextResponse.json({ error: 'Previous rancher no longer in network' }, { status: 404 });
    }
    if (rancher['Active Status'] !== 'Active') {
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

    return NextResponse.json({
      success: true,
      matched: matchOk,
      referralId,
      rancherName: rancher['Operator Name'] || rancher['Ranch Name'],
    });
  } catch (error: any) {
    console.error('Reorder error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
