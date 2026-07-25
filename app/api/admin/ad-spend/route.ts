import { NextResponse } from 'next/server';
import { getAllRecords, createRecord, TABLES } from '@/lib/airtable';
import { requireRole } from '@/lib/adminAuth';
import { sendOperatorSignal } from '@/lib/operatorSignal';

export const maxDuration = 30;

// Ad-spend log behind the ROAS view on /admin/analytics.
// Opened to the 'ads' partner (and admin) — same scope as the analytics read.

const ALLOWED_CHANNELS = ['Meta', 'Google', 'TikTok', 'Other'];

// GET — recent spend entries (newest first) for the log table under the form.
export async function GET(request: Request) {
  const authResp = await requireRole(request, ['admin', 'ads']);
  if (authResp) return authResp;

  try {
    const rows = (await getAllRecords(TABLES.AD_SPEND)) as any[];
    const entries = rows
      .map((r: any) => ({
        id: r.id,
        source: r['Source'] || '',
        amount: Number(r['Amount'] || 0),
        date: r['Date'] || '',
        channel: r['Channel'] || '',
        note: r['Note'] || '',
      }))
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .slice(0, 50);
    return NextResponse.json({ entries });
  } catch (error: any) {
    console.error('[ad-spend] GET failed:', error?.message);
    return NextResponse.json({ error: 'Failed to load ad spend' }, { status: 500 });
  }
}

// POST — log one spend entry.
export async function POST(request: Request) {
  const authResp = await requireRole(request, ['admin', 'ads']);
  if (authResp) return authResp;

  try {
    const body = await request.json();
    const source = String(body.source || '').trim();
    const amount = Number(body.amount);
    const date = String(body.date || '').trim();
    const channel = String(body.channel || 'Other').trim();
    const note = String(body.note || '').trim();

    if (!source) {
      return NextResponse.json({ error: 'Source is required' }, { status: 400 });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ error: 'Amount must be a positive number' }, { status: 400 });
    }
    if (!date || !/^\d{4}-\d{2}-\d{2}/.test(date)) {
      return NextResponse.json({ error: 'Date must be YYYY-MM-DD' }, { status: 400 });
    }
    const safeChannel = ALLOWED_CHANNELS.includes(channel) ? channel : 'Other';

    const fields: Record<string, any> = {
      Source: source,
      Amount: amount,
      Date: date,
      Channel: safeChannel,
    };
    if (note) fields.Note = note;

    const rec = await createRecord(TABLES.AD_SPEND, fields);
    return NextResponse.json({ ok: true, id: rec.id });
  } catch (error: any) {
    // A dropped spend row is silent money-truth corruption: CAC and ROAS keep
    // rendering off an incomplete denominator and every channel looks cheaper
    // than it is. Alert loudly rather than leaving it in the logs.
    console.error('[ad-spend] POST failed:', error?.message);
    try {
      await sendOperatorSignal({
        urgency: 'normal',
        kind: 'other',
        summary: 'Ad spend NOT logged — CAC/ROAS will under-report',
        detail: `Airtable write to "Ad Spend" failed: ${error?.message || 'unknown error'}\nRe-enter the spend on /admin/analytics.`,
        dedupeKey: 'ad-spend-write-failed',
      });
    } catch {
      /* never let the alert mask the original error */
    }
    return NextResponse.json({ error: error?.message || 'Failed to log spend' }, { status: 500 });
  }
}
