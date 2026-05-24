import { NextResponse } from 'next/server';
import { createRecord, TABLES } from '@/lib/airtable';
import { rateLimit, getRequestIp } from '@/lib/rateLimit';

export const maxDuration = 30;

// Lightweight email-only signup. Used by the exit-intent modal +
// any other "just get the email + we'll figure out the rest later"
// surface. Writes a minimal Consumer row + lets the existing nurture
// flows (re-warm cohort, monthly founder letter) pick them up.
//
// Differs from /api/consumers POST in:
// - No required name/state/order-type/budget
// - No full intent score calculation
// - No matching/suggest fire
// - Just: email + source + optional first name → Airtable Consumer row
//
// Rate-limited 5/min/IP + 30/hr/IP same as /api/consumers.
export async function POST(request: Request) {
  try {
    const ip = getRequestIp(request);

    const minuteCheck = await rateLimit(`quicksignup-min:${ip}`, { requests: 5, window: '1m' });
    if (!minuteCheck.ok) {
      return NextResponse.json({ error: 'Too many signups. Try again in a minute.' }, { status: 429 });
    }
    const hourCheck = await rateLimit(`quicksignup-hour:${ip}`, { requests: 30, window: '1h' });
    if (!hourCheck.ok) {
      return NextResponse.json({ error: 'Too many signups today. Try again later.' }, { status: 429 });
    }

    const body = await request.json().catch(() => ({}));
    const email = String(body?.email || '').trim().toLowerCase();
    const source = String(body?.source || 'quick-signup').slice(0, 50);
    const firstName = String(body?.firstName || '').trim().slice(0, 100);

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: 'Valid email required.' }, { status: 400 });
    }

    // Idempotency — skip create if email already exists. Don't reveal whether
    // it existed; just return success.
    // (We could do an exists-check but the rate limit + idempotent-ok response
    // means the cost of a duplicate row is one extra Airtable record that the
    // operator can dedupe via Airtable UI. Acceptable for v1.)

    await createRecord(TABLES.CONSUMERS, {
      'Email': email,
      'Full Name': firstName || 'Quick Signup',
      'Source': source,
      'Status': 'Pending',
      'Buyer Stage': 'NEW',
      'Buyer Stage Updated At': new Date().toISOString(),
      'Notes': `[quick-signup ${new Date().toISOString().slice(0, 10)} via ${source}]`,
      'Created': new Date().toISOString(),
    });

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error('[quick-signup] failed:', error?.message);
    // Don't 500 — the modal will graceful-close. Return ok so it doesn't loop.
    return NextResponse.json({ ok: false, error: 'Save failed. We logged it.' }, { status: 200 });
  }
}
