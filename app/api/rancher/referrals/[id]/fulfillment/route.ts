// POST /api/rancher/referrals/[id]/fulfillment
//
// WAVE 3b (2026-06-30) — rancher-scoped per-order fulfillment tracker.
//
// The legacy /api/rancher/fulfillment/confirm endpoint is a single binary
// "beef delivered" stamp. This route adds the richer order-tracking layer on
// top: a delivery status (scheduled → processing → ready → fulfilled), a
// cut-sheet note, pickup-vs-ship choice, and carrier + tracking number.
//
// NOT a money endpoint — no deposit/settlement/webhook involvement. It only
// writes STATUS/logistics fields on the rancher's own Referrals row.
//
// Auth: rancher session (requireRancher). rancherId is taken from the SESSION,
// never the body. Ownership: the referral must be linked to this rancher
// (Rancher or Suggested Rancher) — enforced both here and inside
// validateFulfillmentUpdate (defense in depth).
//
// GRACEFUL DEGRADATION: most of the fields this writes are NEW (the founder
// must create them — see lib/fulfillmentTracking FULFILLMENT_AIRTABLE_FIELDS_
// NEEDED). updateRecord already self-heals by STRIPPING unknown fields (and
// signalling the operator), so until the founder adds them the write is
// best-effort: known fields (e.g. the pre-existing Processing Date) persist,
// unknown ones are dropped without a 500. The dashboard UI gates the tracker
// on whether the fields read back, so it degrades to the existing binary
// confirm flow.

import { NextResponse } from 'next/server';
import { TABLES, getRecordById, updateRecord } from '@/lib/airtable';
import { requireRancher } from '@/lib/rancherAuth';
import { validateFulfillmentUpdate, FULFILLMENT_FIELDS } from '@/lib/fulfillmentTracking';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: referralId } = await params;
  if (!referralId) {
    return NextResponse.json({ error: 'Referral id required' }, { status: 400 });
  }

  // Auth
  const r = await requireRancher(req);
  if (r instanceof NextResponse) return r;
  const { session } = r;
  const rancherId = String(session.rancherId || '');
  if (!rancherId) {
    return NextResponse.json({ error: 'Session missing rancher id' }, { status: 401 });
  }

  // Body
  let body: any;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  // Load + verify ownership
  const referral: any = await getRecordById(TABLES.REFERRALS, referralId).catch(() => null);
  if (!referral) {
    return NextResponse.json({ error: 'Referral not found' }, { status: 404 });
  }
  const linked: string[] = [
    ...((referral['Rancher'] as string[]) || []),
    ...((referral['Suggested Rancher'] as string[]) || []),
  ];

  // Validate via the pure helper (ownership re-checked there too).
  const result = validateFulfillmentUpdate({
    referralLinkedRancherIds: linked,
    sessionRancherId: rancherId,
    currentStatus: referral[FULFILLMENT_FIELDS.status] || null,
    patch: {
      status: body?.status,
      cutSheetNote: body?.cutSheetNote,
      method: body?.method,
      carrier: body?.carrier,
      trackingNumber: body?.trackingNumber,
      processingDate: body?.processingDate,
    },
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  // Write. updateRecord self-heals unknown (not-yet-created) fields by
  // stripping them + signalling the operator — so this is best-effort until
  // the founder adds the new fields. Known fields persist regardless.
  try {
    await updateRecord(TABLES.REFERRALS, referralId, result.fields);
  } catch (e: any) {
    console.error('[rancher/fulfillment] update failed:', e?.message || e);
    return NextResponse.json({ error: 'Could not save fulfillment details. Please try again.' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, status: result.status, fields: result.fields });
}
