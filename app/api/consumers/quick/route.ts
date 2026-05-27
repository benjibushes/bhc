import { NextResponse } from 'next/server';
import base, { createRecord, TABLES } from '@/lib/airtable';
import { rateLimit, getRequestIp } from '@/lib/rateLimit';
import { getSuppressionList } from '@/lib/email';
import { funnelRecord } from '@/lib/funnelMetrics';
import { fireCapi, buildUserData, getMetaCookiesFromRequest } from '@/lib/metaCapi';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

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

    // Suppression check — silently pretend success for suppressed emails so
    // scrapers can't probe suppression state. Log locally for diagnostics.
    try {
      const suppressed = await getSuppressionList();
      if (suppressed.has(email)) {
        console.log(`[quick-signup] SKIPPED ${email} (suppressed: unsubscribed/bounced/complained)`);
        // Still fire funnel event so analytics capture the attempt
        try {
          await funnelRecord({ stage: 'exit_intent_capture_suppressed', metadata: { email } });
        } catch (e) {
          console.error('funnel record (suppressed) failed:', e);
        }
        return NextResponse.json({ ok: true });
      }
    } catch (e) {
      console.error('[quick-signup] suppression check failed:', e);
      // Fall through and create the record anyway — better to send than to block
    }

    // Dedupe by email — silently skip if already exists. This prevents duplicate
    // Consumer rows and idempotent retries.
    let isNewRecord = false;
    let consumerId: string | null = null;
    try {
      const existing = await base(TABLES.CONSUMERS)
        .select({
          filterByFormula: `LOWER({Email})="${email.replace(/"/g, '\\"')}"`,
          maxRecords: 1,
          fields: ['Email'],
        })
        .all();

      if (existing.length === 0) {
        isNewRecord = true;
        const created = await createRecord(TABLES.CONSUMERS, {
          'Email': email,
          'Full Name': firstName || 'Quick Signup',
          'Source': source,
          'Status': 'Pending',
          'Buyer Stage': 'NEW',
          'Buyer Stage Updated At': new Date().toISOString(),
          'Notes': `[quick-signup ${new Date().toISOString().slice(0, 10)} via ${source}]`,
          'Created': new Date().toISOString(),
        });
        consumerId = created.id;
      } else {
        consumerId = existing[0].id;
      }
    } catch (e) {
      console.error('[quick-signup] dedupe/create failed:', e);
      // If the record operation fails, still report success to the client so
      // the modal closes gracefully. We log it here so the operator can retry.
      return NextResponse.json({ ok: false, error: 'Save failed. We logged it.' }, { status: 200 });
    }

    // Funnel event (analytics — fire regardless of whether row was new, so we
    // capture all attempts including deduped retries)
    try {
      await funnelRecord({ stage: 'exit_intent_capture', metadata: { email } });
    } catch (e) {
      console.error('[quick-signup] funnel record failed:', e);
      // Don't fail the whole request — funnel is non-critical
    }

    // ── Meta Conversions API: server-side `Lead` event ──────────────────
    // P0 audit I-3. exit-intent modal was firing client pixel only —
    // ios 14.5+ ATT blocked → exit-intent attribution lost. server capi
    // mirrors w/ event_id=consumerId so meta dedupes client+server fires.
    // fbp/fbc cookies threaded through for ad-click match (i-1).
    if (consumerId) {
      const { fbp: capiFbp, fbc: capiFbc } = getMetaCookiesFromRequest(request);
      const capiUserAgent = request.headers.get('user-agent') || undefined;
      fireCapi([{
        event_name: 'Lead',
        event_time: Math.floor(Date.now() / 1000),
        event_id: consumerId,
        event_source_url: `${SITE_URL}/access`,
        action_source: 'website',
        user_data: buildUserData({
          email,
          firstName: firstName || undefined,
          ip,
          userAgent: capiUserAgent,
          fbp: capiFbp,
          fbc: capiFbc,
        }),
        custom_data: {
          content_name: 'BHC Exit-Intent Capture',
          content_category: source,
        },
      }]).catch((e) => console.error('[meta-capi] exit-intent fire failed:', e));
    }

    // Return eventId so client ExitIntentModal can pass to trackEvent for
    // pixel+capi dedup.
    return NextResponse.json({ ok: true, eventId: consumerId || undefined });
  } catch (error: any) {
    console.error('[quick-signup] failed:', error?.message);
    // Don't 500 — the modal will graceful-close. Return ok so it doesn't loop.
    return NextResponse.json({ ok: false, error: 'Save failed. We logged it.' }, { status: 200 });
  }
}
