// POST /api/admin/referrals/[id]/confirm-fulfillment
//
// THE COMPLETION PATH FOR A DEAL WITH NO RANCHER SESSION.
//
// `Fulfillment Confirmed At` is written in exactly one place —
// lib/fulfillmentConfirm confirmFulfillmentForReferral — and until this route
// existed it was reachable only from two rancher-SESSION endpoints. A
// REPRESENTED ranch (broker rail) has no session by construction: it signed no
// agreement, has no dashboard login, and never onboarded to Stripe Connect.
// So a paid broker deposit had no way to ever be marked delivered, and parked
// at Status 'Awaiting Payment' forever.
//
// What this route does, rail-aware (decision + close live in
// lib/fulfillmentConfirm so both branches are unit-pinned):
//   BROKER  — stamp the confirmation AND close the deal 'Closed Won' via
//             recordClose (which also frees the ranch's held capacity slot).
//             NO commission-rate gate: a represented rancher has no rate and
//             never needed one. NO 'Commission Due': the fee was collected in
//             full at deposit and this ranch is never invoiced.
//   CONNECT — stamp the confirmation and nothing else, byte-identical to what
//             the rancher-session routes already do. That rail's terminal
//             close arrives with the final invoice payment.
//
// Auth: requireAdmin() — the bhc-admin-auth cookie for browser admins OR the
// x-admin-password header for server-to-server, exactly like every sibling
// route under /api/admin/referrals/[id]/.
//
// Body (all optional):
//   { note?: string, saleAmount?: number }
//   note      — handoff note, mirrored into the buyer's "beef received" email.
//   saleAmount — the EXACT price, for a WEIGHT-PRICED represented ranch whose
//                real number only exists once the carcass is weighed. Absent →
//                the referral's own Sale Amount, else Total Sale Amount (the
//                range floor stamped at settlement).

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';
import { getRecordById, TABLES } from '@/lib/airtable';
import { confirmFulfillmentAsAdmin } from '@/lib/fulfillmentConfirm';
import { logAuditEntry } from '@/lib/auditLog';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const unauthorized = await requireAdmin(request);
  if (unauthorized) return unauthorized;

  const { id } = await context.params;
  if (!id || !id.startsWith('rec')) {
    return NextResponse.json({ error: 'Invalid referral id' }, { status: 400 });
  }

  const body = await request.json().catch(() => ({} as any));
  const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 500) : '';

  // A supplied sale amount must be a real positive number or the request is
  // refused outright — silently dropping a malformed price would close the
  // deal at the settlement floor and understate the sale with no signal.
  let saleAmountOverride: number | undefined;
  if (body?.saleAmount != null) {
    const n = Number(body.saleAmount);
    if (!Number.isFinite(n) || n <= 0) {
      return NextResponse.json(
        { error: 'saleAmount must be a positive number when supplied' },
        { status: 400 },
      );
    }
    saleAmountOverride = n;
  }

  const referral: any = await getRecordById(TABLES.REFERRALS, id).catch(() => null);
  if (!referral) {
    return NextResponse.json({ error: 'Referral not found' }, { status: 404 });
  }

  const result = await confirmFulfillmentAsAdmin({
    referralId: id,
    referral,
    note,
    saleAmountOverride,
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, ...(result.rail ? { rail: result.rail } : {}) },
      { status: result.status },
    );
  }

  // Audit trail — an operator marking someone else's beef delivered is exactly
  // the kind of write that must be attributable later. Best-effort: never fail
  // a landed confirmation on the log.
  try {
    await logAuditEntry({
      actor: 'manual',
      tool: 'admin-confirm-fulfillment',
      targetType: 'Referral',
      targetId: id,
      args: { referralId: id, rail: result.rail, saleAmountOverride, hasNote: !!note },
      result: {
        alreadyConfirmed: result.alreadyConfirmed,
        fulfillmentConfirmedAt: result.fulfillmentConfirmedAt,
        closed: result.closed,
        closeSkippedReason: result.closeSkippedReason,
      },
      reverseAction: {
        type: 'noop',
        reason:
          'Fulfillment confirmation emails the buyer and (broker rail) closes the deal — reverse by hand.',
      },
    });
  } catch (e: any) {
    console.warn('[admin/confirm-fulfillment] audit log failed:', e?.message);
  }

  return NextResponse.json({
    ok: true,
    rail: result.rail,
    alreadyConfirmed: result.alreadyConfirmed,
    fulfillmentConfirmedAt: result.fulfillmentConfirmedAt,
    closed: result.closed,
    ...(result.saleAmount != null ? { saleAmount: result.saleAmount } : {}),
    ...(result.closeSkippedReason ? { closeSkippedReason: result.closeSkippedReason } : {}),
  });
}
