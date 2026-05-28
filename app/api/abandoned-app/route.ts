import { NextResponse } from 'next/server';
import { createRecord, getAllRecords, escapeAirtableValue, TABLES } from '@/lib/airtable';
import { normalizeState } from '@/lib/states';
import { getSuppressionList } from '@/lib/email';

export const maxDuration = 15;

// Lightweight email-only capture for visitors who start the /access form
// but don't finish. Industry recovery rate on a 3-email recapture sequence
// is 8-15% — at our scale that's 16-30 extra approved buyers per month.
//
// Called from the /access form's email-field onBlur after a valid email is
// typed. Creates a minimal CONSUMERS record marked with Source = 'abandoned_application'
// + Sequence Stage = 'abandoned_pending'. The email-sequences cron then
// triggers the recovery flow (one email at +24h, +72h, +7d).
//
// Safe to call repeatedly — duplicate emails are silently ignored.
// Failure modes are non-fatal — we never block the user's UI.
export async function POST(request: Request) {
  try {
    let body: any;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ ok: false, error: 'invalid body' }, { status: 400 });
    }

    const rawEmail = (body?.email || '').toString().trim().toLowerCase();
    if (!rawEmail) {
      return NextResponse.json({ ok: false, error: 'email required' }, { status: 400 });
    }

    // Cheap email validity check — same regex as the main signup endpoint.
    const re = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!re.test(rawEmail)) {
      return NextResponse.json({ ok: false, error: 'invalid email' }, { status: 400 });
    }

    // Suppression check — silently pretend success for bounced/unsubscribed
    // emails so scrapers can't probe suppression state and so re-submitted
    // dead addresses don't re-enter nurture flows. Fail-open on error.
    try {
      const suppressionList = await getSuppressionList();
      if (suppressionList.has(rawEmail)) {
        console.log(`[abandoned-app] SKIPPED ${rawEmail} (suppressed: unsubscribed/bounced/complained)`);
        return NextResponse.json({ ok: true, captured: true });
      }
    } catch (e) {
      console.warn('[abandoned-app] suppression check failed, allowing through:', e);
      // Fall through — fail-open on suppression check failure
    }

    // CRITICAL: normalizeState handles full names ("Montana" → "MT") + codes.
    // Old `.slice(0,2)` turned "Montana" into "MO" (Missouri!) — silent
    // misrouting of every typed-out-state buyer.
    const state = normalizeState(body?.state);
    const fullName = (body?.fullName || '').toString().trim().slice(0, 100);

    // Skip if already in CONSUMERS — we don't want to overwrite a real record
    // with a half-finished one, and we don't need a duplicate abandon entry.
    try {
      const existing = await getAllRecords(
        TABLES.CONSUMERS,
        `LOWER({Email}) = "${escapeAirtableValue(rawEmail)}"`
      );
      if (existing.length > 0) {
        return NextResponse.json({ ok: true, captured: false, reason: 'already_exists' });
      }
    } catch (e) {
      console.error('Abandoned-app duplicate check error:', e);
    }

    // Create a minimal stub. Status stays empty (the main batch-approve cron
    // ignores anything tagged with Source = 'abandoned_application' so these
    // don't get auto-approved into the network without finishing the form).
    try {
      await createRecord(TABLES.CONSUMERS, {
        'Full Name': fullName || '(abandoned signup)',
        'Email': rawEmail,
        'State': state,
        'Source': 'abandoned_application',
        'Sequence Stage': 'abandoned_pending',
        'Notes': `[ABANDONED ${new Date().toISOString()}] Started /access form but didn't submit.`,
      });
    } catch (e: any) {
      console.error('Abandoned-app create error:', e?.message);
      // Don't 500 — abandons are best-effort
      return NextResponse.json({ ok: true, captured: false, reason: 'create_failed' });
    }

    return NextResponse.json({ ok: true, captured: true });
  } catch (error: any) {
    console.error('Abandoned-app endpoint error:', error);
    return NextResponse.json({ ok: false, error: 'internal' }, { status: 500 });
  }
}
