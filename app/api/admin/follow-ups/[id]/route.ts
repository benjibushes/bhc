// app/api/admin/follow-ups/[id]/route.ts
//
// The two buttons on a "⏰ Follow up today" desk row.
//
//   done        — the call happened. Clear Next Follow Up At (the promise is
//                 kept, so it stops coming due) and stamp Last Contacted.
//   snooze      — not today. Push the promise out by `days` (+3d / +1w).
//
// Mirrors app/api/admin/callbacks/[id]/handled — admin cookie, JSON body,
// validate, updateRecord, structured JSON out — so the desk's mutation idiom
// stays the same everywhere.
//
// OPERATOR-ONLY RAIL. This endpoint never emails, texts, or otherwise touches
// the buyer: Ben's follow-ups are phone calls, and a reminder system that
// silently mails people on his behalf is a different (and much worse) product.
// The only writes are the two Consumers fields named below.
//
// LANDMINE — there are TWO similarly named fields on Consumers:
//   'Last Contacted'    fldRT9Tu9E96NbzYp  dateTime  ← what we stamp
//   'Last Contacted At' fldPIn36SShCdEQB2  date      ← the demand-router's
// lib/demandRouter reads BOTH for cooldown (max wins), so stamping the wrong
// one still suppresses marketing but writes a shape the wrong field can't hold.
// Stamp 'Last Contacted', which is the dateTime and the one the admin consumer
// surfaces already read/write.

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import {
  validateFollowUpDate,
  snoozeFollowUpDate,
  operatorToday,
  FOLLOW_UP_SNOOZE_DAYS,
} from '@/lib/followUpQueue';

export const dynamic = 'force-dynamic';

const F_NEXT_FOLLOW_UP_AT = 'Next Follow Up At';
const F_LAST_CONTACTED = 'Last Contacted';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const a = await requireAdmin(req);
  if (a) return a;

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ ok: false, error: 'missing id' }, { status: 400 });
  }

  const body = await req.json().catch(() => ({} as any));
  const action = String(body?.action || '').trim().toLowerCase();

  const consumer: any = await getRecordById(TABLES.CONSUMERS, id).catch(() => null);
  if (!consumer) {
    return NextResponse.json({ ok: false, error: 'buyer not found' }, { status: 404 });
  }

  // ── done ────────────────────────────────────────────────────────────────
  if (action === 'done') {
    // Nothing to clear is not an error — two taps on a flaky connection, or a
    // second tab holding a stale desk, should both land somewhere sane rather
    // than showing a red toast for work that is already finished.
    if (!String(consumer[F_NEXT_FOLLOW_UP_AT] ?? '').trim()) {
      return NextResponse.json({ ok: true, alreadyDone: true });
    }
    const contactedAt = new Date().toISOString();
    try {
      await updateRecord(TABLES.CONSUMERS, id, {
        [F_NEXT_FOLLOW_UP_AT]: null,
        [F_LAST_CONTACTED]: contactedAt,
      });
    } catch (e: any) {
      console.error('[admin/follow-ups] done write failed:', e?.message || e);
      return NextResponse.json({ ok: false, error: 'write failed' }, { status: 500 });
    }
    return NextResponse.json({ ok: true, action: 'done', contactedAt });
  }

  // ── snooze ──────────────────────────────────────────────────────────────
  if (action === 'snooze') {
    const days = Number(body?.days);
    if (!(FOLLOW_UP_SNOOZE_DAYS as readonly number[]).includes(days)) {
      return NextResponse.json(
        { ok: false, error: `days must be one of ${FOLLOW_UP_SNOOZE_DAYS.join(', ')}` },
        { status: 400 },
      );
    }

    // Advance from TODAY, never from the date that was missed. Snoozing +3d on
    // a three-week-old promise would write a date still in the past, and the
    // row would sit there having visibly ignored the button.
    const today = operatorToday();
    const next = snoozeFollowUpDate(today, days);
    // Re-validate rather than trust the arithmetic: this is the same gate the
    // operator's manual edit goes through, so there is exactly one definition
    // of a writable follow-up date.
    const v = validateFollowUpDate(next, today);
    if (!v.ok) {
      console.error('[admin/follow-ups] snooze produced an invalid date:', next, v.error);
      return NextResponse.json({ ok: false, error: v.error }, { status: 500 });
    }

    try {
      await updateRecord(TABLES.CONSUMERS, id, { [F_NEXT_FOLLOW_UP_AT]: v.value });
    } catch (e: any) {
      console.error('[admin/follow-ups] snooze write failed:', e?.message || e);
      return NextResponse.json({ ok: false, error: 'write failed' }, { status: 500 });
    }
    return NextResponse.json({ ok: true, action: 'snooze', nextFollowUpAt: v.value });
  }

  return NextResponse.json(
    { ok: false, error: "action must be 'done' or 'snooze'" },
    { status: 400 },
  );
}
