// Stage-3 Task 12 — admin payments console data feed.
// Returns latest N Payments + Payouts joined with rancher + buyer names so
// the /admin/payments page can render a single chronological list w/ all
// the context an operator needs to spot anomalies.

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';
import { getAllRecords, getRecordById, TABLES } from '@/lib/airtable';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const PAYMENTS_TABLE = 'Payments';
const PAYOUTS_TABLE = 'Payouts';
const PAGE_LIMIT = 100;

export async function GET(request: Request) {
  const unauthorized = await requireAdmin(request);
  if (unauthorized) return unauthorized;

  // Pull all recent payments + payouts. Cap at 100 to keep the dashboard fast.
  let payments: any[] = [];
  let payouts: any[] = [];
  try {
    [payments, payouts] = await Promise.all([
      getAllRecords(PAYMENTS_TABLE, ''),
      getAllRecords(PAYOUTS_TABLE, ''),
    ]);
  } catch (e: any) {
    console.error('[admin/payments/data] table fetch failed:', e?.message);
    return NextResponse.json({ error: 'Could not load payments tables.' }, { status: 500 });
  }

  // Sort by created date desc (Created At for payments, Released At for payouts).
  payments.sort((a, b) => {
    const aT = String(a['Created At'] || '');
    const bT = String(b['Created At'] || '');
    return bT.localeCompare(aT);
  });
  payouts.sort((a, b) => {
    const aT = String(a['Released At'] || '');
    const bT = String(b['Released At'] || '');
    return bT.localeCompare(aT);
  });

  // Hydrate rancher + buyer names. Build a record-id → name cache to avoid N+1 lookups.
  const rancherIds = new Set<string>();
  const buyerIds = new Set<string>();
  for (const p of payments.slice(0, PAGE_LIMIT)) {
    const rIds = (p['Rancher'] || []) as string[];
    const bIds = (p['Buyer'] || []) as string[];
    for (const id of rIds) rancherIds.add(id);
    for (const id of bIds) buyerIds.add(id);
  }
  for (const p of payouts.slice(0, PAGE_LIMIT)) {
    const rIds = (p['Rancher'] || []) as string[];
    for (const id of rIds) rancherIds.add(id);
  }

  const rancherNames: Record<string, string> = {};
  const buyerNames: Record<string, string> = {};
  await Promise.all([
    ...Array.from(rancherIds).map(async (id) => {
      try {
        const r: any = await getRecordById(TABLES.RANCHERS, id);
        rancherNames[id] = String(r?.['Ranch Name'] || r?.['Operator Name'] || id);
      } catch {
        rancherNames[id] = id;
      }
    }),
    ...Array.from(buyerIds).map(async (id) => {
      try {
        const c: any = await getRecordById(TABLES.CONSUMERS, id);
        buyerNames[id] = String(c?.['Full Name'] || c?.['Email'] || id);
      } catch {
        buyerNames[id] = id;
      }
    }),
  ]);

  // Shape for the UI.
  const paymentsOut = payments.slice(0, PAGE_LIMIT).map((p) => {
    const rId = (p['Rancher'] || [])[0] || '';
    const bId = (p['Buyer'] || [])[0] || '';
    const tier = typeof p['Tier'] === 'object' && p['Tier']?.name ? p['Tier'].name : p['Tier'];
    return {
      id: p.id,
      stripePaymentIntentId: String(p['Stripe Payment Intent Id'] || ''),
      rancherId: rId,
      rancherName: rancherNames[rId] || rId,
      buyerId: bId,
      buyerName: buyerNames[bId] || bId,
      tier: tier ? String(tier) : '',
      amountCents: Number(p['Amount Cents'] || 0),
      platformFeeCents: Number(p['Platform Fee Cents'] || 0),
      // Refunded Amount Cents tracks cumulative partial refunds. Fall back to
      // 0 if the field is absent (older schema / not-yet-refunded rows).
      refundedAmountCents: Number(p['Refunded Amount Cents'] || 0),
      status: String(p['Status'] || 'pending'),
      createdAt: String(p['Created At'] || ''),
      capturedAt: String(p['Captured At'] || ''),
      refundedAt: String(p['Refunded At'] || ''),
    };
  });

  const payoutsOut = payouts.slice(0, PAGE_LIMIT).map((p) => {
    const rId = (p['Rancher'] || [])[0] || '';
    return {
      id: p.id,
      stripeTransferId: String(p['Stripe Transfer Id'] || ''),
      rancherId: rId,
      rancherName: rancherNames[rId] || rId,
      amountCents: Number(p['Amount Cents'] || 0),
      status: String(p['Status'] || 'paid'),
      reason: String(p['Reason'] || ''),
      releasedAt: String(p['Released At'] || ''),
    };
  });

  return NextResponse.json({
    payments: paymentsOut,
    payouts: payoutsOut,
    counts: { payments: payments.length, payouts: payouts.length },
  });
}
