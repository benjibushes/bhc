import { NextResponse } from 'next/server';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-member-secret-change-me';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

// GET /api/warmup/engage?token=...
// Marks a waitlisted buyer as engaged with the rancher launch-warmup email,
// then redirects to a confirmation page. Token is a signed JWT so the link
// can't be enumerated.
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
      await updateRecord(TABLES.CONSUMERS, payload.consumerId, {
        'Warmup Engaged At': new Date().toISOString(),
        'Warmup Stage': 'engaged',
        'Ready to Buy': true,
      });
    }

    // ── IMMEDIATE ROUTE on first YES click ────────────────────────────
    // The user's vision: signup → welcome → ready-to-buy prompt → click →
    // intro fires within seconds. We trigger matching/suggest synchronously
    // here so the buyer + rancher get the intro emails before they even
    // close their browser tab. matching/suggest is idempotent — if they
    // already have an active referral it returns the existing one cleanly.
    if (!wasAlreadyEngaged && consumer['Email'] && consumer['State']) {
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
            // ranchers (the ship from earlier today). Matching/suggest will
            // fire a Telegram alert if the bypass triggers.
            warmupEngaged: true,
          }),
        });
        // Fire-and-forget: even if matching fails (no rancher in state, etc.),
        // the buyer is already flagged Ready to Buy. The next batch-approve
        // run + future rancher go-live will pick them up. Don't block the
        // redirect on a matching failure.
        if (!matchRes.ok) {
          console.warn(`Immediate route attempt for ${payload.consumerId} returned ${matchRes.status} — buyer flagged Ready to Buy, will route on next opportunity`);
        }
      } catch (e: any) {
        console.error('Immediate route on YES click failed:', e?.message);
      }
    }

    return NextResponse.redirect(`${SITE_URL}/access?warmup=engaged`);
  } catch (error: any) {
    console.error('Warmup engage error:', error);
    return NextResponse.redirect(`${SITE_URL}/access?error=server`);
  }
}
