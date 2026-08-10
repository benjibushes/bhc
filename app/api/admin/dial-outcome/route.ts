// app/api/admin/dial-outcome/route.ts
//
// C1 — the outcome buttons on every cockpit dial row (cockpit CRM-parity,
// docs/ADAPTIVE-MARKETING-DESIGN.md §3.5). One thin POST: the field matrix
// lives in lib/dialOutcome (pure, tested); this route only resolves records
// and applies the plan.
//
// Body: { kind: 'buyer'|'promise'|'deal'|'rancher', id: '<record id>',
//         outcome: 'no-answer'|'talked'|'skip',
//         followUpDays?: 3|7,          // talked only
//         referralId?: '<referral id>' } // buyer rows from the deposit-opened tier
//
// Mirrors the desk's mutation idiom (app/api/admin/follow-ups/[id]): admin
// auth, JSON body, validate, updateRecord, structured JSON out. Money-truth:
// every outcome persists a stamp — that tap is what re-ranks tomorrow's queue.

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { hasOpenCallbackRequest } from '@/lib/callbackQueue';
import { operatorToday } from '@/lib/followUpQueue';
import { planDialOutcome, type DialOutcomeKind, type DialOutcome } from '@/lib/dialOutcome';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const a = await requireAdmin(req);
  if (a) return a;

  const body = await req.json().catch(() => ({}) as any);
  const kind = String(body?.kind || '').trim() as DialOutcomeKind;
  const id = String(body?.id || '').trim();
  const outcome = String(body?.outcome || '').trim() as DialOutcome;
  const followUpDays = body?.followUpDays == null ? undefined : Number(body.followUpDays);
  const referralIdRaw = String(body?.referralId || '').trim();

  if (!id) {
    return NextResponse.json({ ok: false, error: 'missing id' }, { status: 400 });
  }

  const nowIso = new Date().toISOString();
  const today = operatorToday();

  // ── Resolve the record(s) the plan will stamp ───────────────────────────
  let hasOpenCallback = false;
  let consumerId = '';
  let referralId = '';
  let rancherId = '';

  if (kind === 'buyer' || kind === 'promise') {
    const consumer: any = await getRecordById(TABLES.CONSUMERS, id).catch(() => null);
    if (!consumer) {
      return NextResponse.json({ ok: false, error: 'buyer not found' }, { status: 404 });
    }
    consumerId = id;
    hasOpenCallback = hasOpenCallbackRequest({
      callbackRequestedAt: consumer['Callback Requested At'],
      callbackHandledAt: consumer['Callback Handled At'],
    });
    if (kind === 'buyer' && referralIdRaw) {
      const referral: any = await getRecordById(TABLES.REFERRALS, referralIdRaw).catch(() => null);
      if (referral) referralId = referralIdRaw; // missing referral is non-fatal
    }
  } else if (kind === 'deal') {
    const referral: any = await getRecordById(TABLES.REFERRALS, id).catch(() => null);
    if (!referral) {
      return NextResponse.json({ ok: false, error: 'deal not found' }, { status: 404 });
    }
    referralId = id;
    // "Talked, follow up in N days" on a deal writes the promise on the
    // linked buyer — only possible when the link exists.
    consumerId = Array.isArray(referral['Buyer']) ? String(referral['Buyer'][0] || '') : '';
  } else if (kind === 'rancher') {
    const rancher: any = await getRecordById(TABLES.RANCHERS, id).catch(() => null);
    if (!rancher) {
      return NextResponse.json({ ok: false, error: 'rancher not found' }, { status: 404 });
    }
    rancherId = id;
  }

  const planned = planDialOutcome({
    kind,
    outcome,
    nowIso,
    today,
    hasOpenCallback,
    followUpDays,
    hasReferral: kind === 'buyer' && !!referralId,
  });
  if (!planned.ok) {
    return NextResponse.json({ ok: false, error: planned.error }, { status: 400 });
  }
  const { plan } = planned;

  // A deal follow-up promise needs a linked buyer to land on. Degrade
  // honestly rather than 500: stamp the chase clock, report the miss.
  let followUpSkipped = false;
  if (plan.consumer && kind === 'deal' && !consumerId) {
    delete plan.consumer;
    followUpSkipped = true;
  }

  // ── Apply — each write surfaced, none silently dropped ──────────────────
  try {
    if (plan.consumer && consumerId) {
      await updateRecord(TABLES.CONSUMERS, consumerId, plan.consumer);
    }
    if (plan.referral && referralId) {
      await updateRecord(TABLES.REFERRALS, referralId, plan.referral);
    }
    if (plan.rancher && rancherId) {
      await updateRecord(TABLES.RANCHERS, rancherId, plan.rancher);
    }
  } catch (e: any) {
    console.error('[admin/dial-outcome] write failed:', e?.message || e);
    return NextResponse.json({ ok: false, error: 'write failed' }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    kind,
    outcome,
    stampedAt: nowIso,
    summary: plan.summary + (followUpSkipped ? ' (follow-up skipped — no linked buyer)' : ''),
  });
}
