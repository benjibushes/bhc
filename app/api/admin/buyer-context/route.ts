// GET /api/admin/buyer-context?email=x — sell-console omniscience (Phase 10).
//
// Ben types a buyer's email on the phone and instantly sees the WHOLE
// relationship across all three systems before he pitches:
//   consumer  — name / state / Buyer Stage (demand engine identity)
//   referrals — share journey summary (statuses, deposit paid?)
//   orders    — marketplace product orders (what they've tasted)
//
// Read-only, admin-gated. Unknown email → { found: false } (a brand-new
// lead — the console sells to them anyway and the rails create the record).

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';
import { getAllRecords, escapeAirtableValue, referralsByBuyerEmailFormula, TABLES } from '@/lib/airtable';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const unauthorized = await requireAdmin(request);
  if (unauthorized) return unauthorized;

  const email = (new URL(request.url).searchParams.get('email') || '').trim().toLowerCase();
  if (!email.includes('@')) {
    return NextResponse.json({ error: 'email required' }, { status: 400 });
  }
  const safe = escapeAirtableValue(email);

  const [consumers, orders] = await Promise.all([
    getAllRecords(TABLES.CONSUMERS, `LOWER({Email}) = "${safe}"`).catch(() => [] as any[]),
    getAllRecords(TABLES.RANCHER_ORDERS, `LOWER({Buyer Email}) = "${safe}"`).catch(() => [] as any[]),
  ]);

  const consumer: any = Array.isArray(consumers) && consumers[0] ? consumers[0] : null;

  // Referrals: the canonical by-email formula (lib/airtable) — the same
  // lookup the deposit rail uses, so console truth = rail truth.
  let referrals: any[] = [];
  const refFormula = referralsByBuyerEmailFormula(email);
  if (refFormula) {
    try {
      const all = (await getAllRecords(TABLES.REFERRALS, refFormula)) as any[];
      referrals = Array.isArray(all) ? all : [];
    } catch {
      referrals = [];
    }
  }

  return NextResponse.json({
    found: !!consumer || (Array.isArray(orders) && orders.length > 0),
    consumer: consumer
      ? {
          id: consumer.id,
          name: String(consumer['Full Name'] || ''),
          state: String(consumer['State'] || ''),
          stage: String(consumer['Buyer Stage'] || ''),
          smsOptIn: consumer['SMS Opt-In'] === true,
        }
      : null,
    referrals: referrals.slice(0, 5).map((r: any) => ({
      id: r.id,
      status: String(r['Status'] || ''),
      rancher: String(r['Rancher Name'] || r['Assigned Rancher Name'] || ''),
      depositPaidAt: String(r['Deposit Paid At'] || ''),
    })),
    orders: (orders as any[]).slice(0, 5).map((o: any) => ({
      id: o.id,
      product: String(o['Product Name'] || ''),
      paid: Number(o['Buyer Paid'] || 0),
      status: String(o['Status'] || ''),
      orderedAt: String(o['Ordered At'] || ''),
      deposit: String(o['Order Ref'] || '').startsWith('DEPOSIT — '),
    })),
  });
}
