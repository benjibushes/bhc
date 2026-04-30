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

    const response = NextResponse.redirect(`${SITE_URL}/member?warmup=engaged`);
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
