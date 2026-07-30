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
import { carrierTrackingUrl } from '@/lib/trackingLink';
import { sendBuyerShippingNotification, sendBuyerHandoffScheduled } from '@/lib/email';
import { confirmFulfillmentForReferral } from '@/lib/fulfillmentConfirm';

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
      handoffDate: body?.handoffDate,
      clearProcessingDate: body?.clearProcessingDate,
      clearHandoffDate: body?.clearHandoffDate,
    },
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  // Write. updateRecord self-heals unknown (not-yet-created) fields by
  // stripping them + signalling the operator — so this is best-effort until
  // the founder adds the new fields. Known fields persist regardless.
  let updated: any = null;
  try {
    updated = await updateRecord(TABLES.REFERRALS, referralId, result.fields);
  } catch (e: any) {
    console.error('[rancher/fulfillment] update failed:', e?.message || e);
    return NextResponse.json({ error: 'Could not save fulfillment details. Please try again.' }, { status: 500 });
  }

  // Lazy one-shot buyer/rancher loads shared by the side-effect blocks below.
  let _buyer: any | undefined;
  let _rancher: any | undefined;
  const loadBuyer = async () => {
    if (_buyer === undefined) {
      const buyerLinks: string[] = (referral['Buyer'] || []) as string[];
      const buyerId = Array.isArray(buyerLinks) ? buyerLinks[0] : null;
      _buyer = buyerId ? await getRecordById(TABLES.CONSUMERS, buyerId).catch(() => null) : null;
    }
    return _buyer;
  };
  const loadRancher = async () => {
    if (_rancher === undefined) {
      _rancher = await getRecordById(TABLES.RANCHERS, rancherId).catch(() => null);
    }
    return _rancher;
  };

  // ── D3: FIRST tracking-number save → buyer "your beef is on the way" email ──
  // Idempotent by construction: fires only when the referral had NO tracking
  // number before this write AND has one after it, so edits/corrections never
  // re-send. We check the PERSISTED value from updateRecord's returned record
  // (not result.fields) — if the founder hasn't created the Tracking Number
  // Airtable field yet, updateRecord strips it, the buyer-facing surface can't
  // show it, and re-sends on every save would be spam; skipping keeps the
  // email in lockstep with what actually stuck. Best-effort try/catch — email
  // infra can never fail or block the rancher's save.
  try {
    const priorTracking = String(referral[FULFILLMENT_FIELDS.trackingNumber] || '').trim();
    const savedTracking = String(updated?.[FULFILLMENT_FIELDS.trackingNumber] || '').trim();
    if (!priorTracking && savedTracking) {
      const buyer: any = await loadBuyer();
      const rancher: any = await loadRancher();
      if (buyer?.['Email']) {
        const carrier = String(updated?.[FULFILLMENT_FIELDS.carrier] || '').trim();
        await sendBuyerShippingNotification({
          email: String(buyer['Email']),
          firstName: String(buyer['Full Name'] || '').split(' ')[0] || '',
          rancherName: String(rancher?.['Operator Name'] || rancher?.['Ranch Name'] || 'Your rancher'),
          ranchName: String(rancher?.['Ranch Name'] || rancher?.['Operator Name'] || 'the ranch'),
          orderType: String(referral['Order Type'] || ''),
          carrier,
          trackingNumber: savedTracking,
          trackingUrl: carrierTrackingUrl(carrier, savedTracking),
        });
      }
    }
  } catch (e: any) {
    console.warn('[rancher/fulfillment] buyer shipping email failed:', e?.message);
  }

  // ── Wave 2 (2026-07-29): Handoff Date SET or CHANGED → buyer schedule email ──
  // Same persisted-value discipline as the tracking email: compare the stored
  // Handoff Date before this write with what updateRecord actually returned.
  // Equal (including a re-save of the same date) → no send. Field stripped by
  // Airtable (not yet in schema) → savedHandoff empty → no send. Best-effort.
  try {
    const priorHandoff = String(referral[FULFILLMENT_FIELDS.handoffDate] || '').trim();
    const savedHandoff = String(updated?.[FULFILLMENT_FIELDS.handoffDate] || '').trim();
    if (savedHandoff && savedHandoff !== priorHandoff) {
      const buyer: any = await loadBuyer();
      const rancher: any = await loadRancher();
      if (buyer?.['Email']) {
        // Word pickup vs delivery: the rancher's own Fulfillment Method wins
        // (pickup→pickup, ship→delivery), else the buyer's stated pref
        // (Buyer Fulfillment Pref: 'Pickup'|'Delivery'), else generic.
        const method = String(updated?.[FULFILLMENT_FIELDS.method] || referral[FULFILLMENT_FIELDS.method] || '').toLowerCase();
        const pref = String(referral['Buyer Fulfillment Pref'] || '').toLowerCase();
        const mode: 'pickup' | 'delivery' | null =
          method === 'pickup' ? 'pickup'
          : method === 'ship' ? 'delivery'
          : pref === 'pickup' ? 'pickup'
          : pref === 'delivery' ? 'delivery'
          : null;
        await sendBuyerHandoffScheduled({
          email: String(buyer['Email']),
          firstName: String(buyer['Full Name'] || '').split(' ')[0] || '',
          rancherName: String(rancher?.['Operator Name'] || rancher?.['Ranch Name'] || 'Your rancher'),
          ranchName: String(rancher?.['Ranch Name'] || rancher?.['Operator Name'] || 'the ranch'),
          orderType: String(referral['Order Type'] || ''),
          handoffDate: savedHandoff,
          mode,
          isReschedule: !!priorHandoff,
        });
      }
    }
  } catch (e: any) {
    console.warn('[rancher/fulfillment] buyer handoff email failed:', e?.message);
  }

  // ── Wave 2 (2026-07-29): transition TO 'fulfilled' → the shared confirm rail ──
  // The tracker's `fulfilled` used to be a dead end: no Fulfillment Confirmed
  // At stamp, no buyer email, no funnel/Telegram — so the chase cron kept
  // nagging deals the rancher had already marked delivered, and the two
  // delivered-systems disagreed forever. Route through the SAME helper the
  // binary confirm row uses (lib/fulfillmentConfirm) — idempotent (skips when
  // Fulfillment Confirmed At already set) and best-effort: a payment-gate
  // refusal (409) must not fail the tracker save that already persisted; it's
  // surfaced in the response + logs instead.
  let fulfillmentConfirmedAt: string | null = null;
  let confirmSkipReason: string | null = null;
  const priorStatus = String(referral[FULFILLMENT_FIELDS.status] || '').toLowerCase();
  if (result.status === 'fulfilled' && priorStatus !== 'fulfilled') {
    try {
      const confirm = await confirmFulfillmentForReferral({
        referralId,
        rancherId,
        referral,
      });
      if (confirm.ok) {
        fulfillmentConfirmedAt = confirm.fulfillmentConfirmedAt;
      } else {
        confirmSkipReason = confirm.error;
        console.warn('[rancher/fulfillment] fulfilled sync skipped:', confirm.status, confirm.error);
      }
    } catch (e: any) {
      confirmSkipReason = 'confirm rail errored';
      console.warn('[rancher/fulfillment] fulfilled sync failed:', e?.message);
    }
  }

  return NextResponse.json({
    ok: true,
    status: result.status,
    fields: result.fields,
    ...(fulfillmentConfirmedAt ? { fulfillmentConfirmedAt } : {}),
    ...(confirmSkipReason ? { confirmSkipped: confirmSkipReason } : {}),
  });
}
