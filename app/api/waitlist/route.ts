import { NextResponse } from 'next/server';
import { createRecord, updateRecord, getAllRecords, escapeAirtableValue, TABLES } from '@/lib/airtable';

export const maxDuration = 15;

// Waitlist capture. The simplest possible lead-save: write to Airtable and
// STOP. No emails, no telegram, no matching, no crons will process these
// records (they're tagged Source='relaunch_waitlist' and every downstream
// system filters them out).
//
// Purpose: during a platform pause/rework, every visitor still gets captured
// so we don't lose growth while we rebuild. When we're ready to relaunch,
// these records can be processed in bulk with a proper sequence.
//
// Idempotent — same email submitted twice updates the existing record's
// Notes field instead of creating a duplicate.
export async function POST(request: Request) {
  try {
    let body: any;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const rawEmail = (body?.email || '').toString().trim().toLowerCase();
    if (!rawEmail) {
      return NextResponse.json({ error: 'Email is required' }, { status: 400 });
    }

    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!emailRegex.test(rawEmail)) {
      return NextResponse.json({ error: 'Please enter a valid email' }, { status: 400 });
    }

    // Optional fields — keep the form short + friction-free
    const fullName = (body?.fullName || body?.name || '').toString().trim().slice(0, 100);
    const state = (body?.state || '').toString().trim().toUpperCase().slice(0, 2);
    const interest = (body?.interest || '').toString().trim().slice(0, 50); // e.g. "beef", "land", "rancher"
    const notes = (body?.notes || '').toString().trim().slice(0, 500);
    const referrer = (body?.referrer || '').toString().trim().slice(0, 200);

    const timestamp = new Date().toISOString();
    const noteEntry = `[WAITLIST ${timestamp.slice(0, 10)}]${interest ? ` interest=${interest}` : ''}${referrer ? ` referrer=${referrer}` : ''}${notes ? ` — ${notes}` : ''}`;

    // Check if this email already exists in CONSUMERS. If yes, append to Notes
    // (so we have history of every waitlist interaction) rather than creating
    // a duplicate. Idempotent by design.
    try {
      const existing = await getAllRecords(
        TABLES.CONSUMERS,
        `LOWER({Email}) = "${escapeAirtableValue(rawEmail)}"`
      ) as any[];

      if (existing.length > 0) {
        const rec = existing[0];
        const newNotes = `${rec['Notes'] || ''}\n${noteEntry}`.trim();
        try {
          await updateRecord(TABLES.CONSUMERS, rec.id, { 'Notes': newNotes });
        } catch (e) {
          // Non-fatal — the original record is safe either way.
          console.error('Waitlist: failed to update existing record notes:', e);
        }
        return NextResponse.json({ ok: true, captured: true, returning: true });
      }
    } catch (e) {
      console.error('Waitlist: duplicate check error:', e);
      // Fall through to create — better to write twice than not at all.
    }

    // Create a fresh stub. Status stays BLANK (not "Approved" — these records
    // haven't been through proper qualification) so crons skip them, and
    // Source='relaunch_waitlist' tags them for a future bulk relaunch process.
    try {
      await createRecord(TABLES.CONSUMERS, {
        'Full Name': fullName || '(waitlist signup)',
        'Email': rawEmail,
        'State': state,
        'Source': 'relaunch_waitlist',
        'Notes': noteEntry,
      });
    } catch (e: any) {
      console.error('Waitlist: create error:', e?.message);
      // Still return success — if Airtable is flaky we don't want to reject
      // the user, and most duplicates at this point are races.
      return NextResponse.json({ ok: true, captured: false, warning: 'retry_later' });
    }

    return NextResponse.json({ ok: true, captured: true });
  } catch (error: any) {
    console.error('Waitlist endpoint error:', error);
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}
