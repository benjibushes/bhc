// app/api/admin/callbacks/[id]/handled/route.ts
//
// Ben called them back. Stamp it and clear the row off the top of the desk.
//
// Mirrors app/api/admin/referrals/[id]/stage/route.ts — admin cookie, JSON
// body, validate, updateRecord, structured JSON out — so the desk's mutation
// idiom stays the same everywhere.
//
// DELIBERATELY NOT gated on CALLBACK_RAIL_ENABLED. The flag governs what
// BUYERS can see; the desk must be able to work whatever rows exist, including
// after the flag is turned back off. An operator who cannot close out a
// request is left with a queue that only grows.
//
// One-way: this stamps Callback Handled At and never clears Callback Requested
// At. Keeping the request stamp is what lets the desk tell a first-time ask
// from a buyer coming back a second time (lib/callbackQueue's re-ask case),
// and it preserves the history of who asked and when.

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { hasOpenCallbackRequest } from '@/lib/callbackQueue';

export const dynamic = 'force-dynamic';

const F_REQUESTED_AT = 'Callback Requested At';
const F_HANDLED_AT = 'Callback Handled At';

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

  const consumer: any = await getRecordById(TABLES.CONSUMERS, id).catch(() => null);
  if (!consumer) {
    return NextResponse.json({ ok: false, error: 'buyer not found' }, { status: 404 });
  }

  // Nothing to close is not an error — two taps on a flaky connection, or two
  // operators on the same queue, should both land somewhere sane rather than
  // showing a red toast for work that is already done.
  if (
    !hasOpenCallbackRequest({
      callbackRequestedAt: consumer[F_REQUESTED_AT],
      callbackHandledAt: consumer[F_HANDLED_AT],
    })
  ) {
    return NextResponse.json({ ok: true, alreadyHandled: true });
  }

  const handledAt = new Date().toISOString();
  try {
    await updateRecord(TABLES.CONSUMERS, id, { [F_HANDLED_AT]: handledAt });
  } catch (e: any) {
    console.error('[admin/callbacks/handled] write failed:', e?.message || e);
    return NextResponse.json({ ok: false, error: 'write failed' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, handledAt });
}
