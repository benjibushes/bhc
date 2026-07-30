// Stage-3 Task 9 — rancher fulfillment confirmation endpoint.
//
// Rancher hits "Confirm Fulfillment" on /rancher dashboard after the buyer
// has the beef in hand (pickup / delivery / shipped + arrived). For tier_v2
// deposits the funds already settled at charge time via Connect direct
// charge — this endpoint is a STATUS marker, not a payout trigger. Stripe
// Connect pays the rancher's bank automatically per the connected account's
// payout schedule.
//
// Wave 2 (2026-07-29): the validation + stamp + side effects (payment gate,
// Fulfillment Confirmed At, buyer email, funnel, Telegram) moved verbatim to
// lib/fulfillmentConfirm.ts confirmFulfillmentForReferral so the richer
// tracker's `fulfilled` status (/api/rancher/referrals/[id]/fulfillment)
// fires the SAME rail. This route keeps: auth, body parse, ownership.

import { NextResponse } from 'next/server';
import { getRecordById, TABLES } from '@/lib/airtable';
import { requireRancher } from '@/lib/rancherAuth';
import { confirmFulfillmentForReferral } from '@/lib/fulfillmentConfirm';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(req: Request) {
  const r = await requireRancher(req);
  if (r instanceof NextResponse) return r;
  const { session } = r;
  const rancherId = String(session.rancherId || '');
  if (!rancherId) {
    return NextResponse.json({ error: 'Session missing rancher id' }, { status: 401 });
  }

  // ── Body ──
  let body: any;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const referralId = String(body?.referralId || '').trim();
  const rancherNote = typeof body?.note === 'string' ? body.note.trim().slice(0, 500) : '';
  if (!referralId) {
    return NextResponse.json({ error: 'referralId required' }, { status: 400 });
  }

  // ── Ownership ──
  const referral: any = await getRecordById(TABLES.REFERRALS, referralId).catch(() => null);
  if (!referral) {
    return NextResponse.json({ error: 'Referral not found' }, { status: 404 });
  }
  const rancherLinks: string[] = (referral['Rancher'] || []) as string[];
  if (!Array.isArray(rancherLinks) || !rancherLinks.includes(rancherId)) {
    return NextResponse.json({ error: 'Referral not assigned to this rancher' }, { status: 403 });
  }

  // ── Shared confirm rail (idempotency + payment gate + stamp + side effects) ──
  const result = await confirmFulfillmentForReferral({
    referralId,
    rancherId,
    referral,
    rancherNote,
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, ...(result.rail ? { rail: result.rail } : {}) },
      { status: result.status },
    );
  }
  if (result.alreadyConfirmed) {
    return NextResponse.json({
      ok: true,
      alreadyConfirmed: true,
      fulfillmentConfirmedAt: result.fulfillmentConfirmedAt,
    });
  }
  return NextResponse.json({ ok: true, fulfillmentConfirmedAt: result.fulfillmentConfirmedAt });
}
