import { NextResponse } from 'next/server';
import { resolveBuyerSession } from '@/lib/buyerAuth';
import { getOrdersByBuyer } from '@/lib/commerce/repository';
import { getRecordById, TABLES } from '@/lib/airtable';

export const maxDuration = 30;

// Buyer order history (commerce / Supabase). The /member surface is a CLIENT
// component, so it can't call the server-only commerce repository directly
// (the Supabase service-role key must never reach the browser). This route is
// the server-side bridge: it resolves the buyer session, calls
// getOrdersByBuyer(consumerId), and returns a lean, money-rounded shape the
// dashboard renders.
//
// BUILD-DARK: getOrdersByBuyer returns [] when the commerce DB is unconfigured
// (no SUPABASE env) OR the buyer has no linkable orders. In both cases we
// return { orders: [] } and the member page shows a calm empty state — never
// an error. Money lives in integer CENTS in Supabase; we round to whole
// dollars here so the client only displays.

interface MemberOrderLine {
  label: string;
  qty: number;
}

interface MemberOrder {
  id: string;
  rancherName: string;
  status: string;
  createdAt: string;
  items: MemberOrderLine[];
  paidDollars: number; // deposit captured (deposit_cents → dollars)
  balanceDollars: number; // remaining (subtotal_cents − deposit_cents → dollars)
}

const centsToDollars = (cents: number): number => Math.round((cents || 0) / 100);

export async function GET(request: Request) {
  try {
    const session = await resolveBuyerSession(request);
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    // getOrdersByBuyer null-checks the commerce DB internally and returns []
    // when unconfigured — so this is safe to call before Supabase is provisioned.
    const orders = await getOrdersByBuyer(session.consumerId);
    if (orders.length === 0) {
      return NextResponse.json({ orders: [] });
    }

    // Resolve rancher display names from Airtable (orders store rancher_id as an
    // Airtable record id). Dedupe ids so a buyer with several orders from one
    // ranch only triggers one lookup. A failed lookup degrades to a neutral
    // label rather than breaking the response.
    const rancherIds = Array.from(
      new Set(orders.map((o) => o.rancher_id).filter((id): id is string => !!id)),
    );
    const nameById = new Map<string, string>();
    await Promise.all(
      rancherIds.map(async (id) => {
        try {
          const r: any = await getRecordById(TABLES.RANCHERS, id);
          nameById.set(id, r?.['Ranch Name'] || r?.['Operator Name'] || 'Your rancher');
        } catch {
          nameById.set(id, 'Your rancher');
        }
      }),
    );

    const serialized: MemberOrder[] = orders.map((o) => {
      const paid = centsToDollars(o.deposit_cents);
      // Balance remaining = subtotal − deposit, floored at 0 so a fully-paid or
      // deposit-only-equals-subtotal order never shows a negative balance.
      const balance = Math.max(0, centsToDollars(o.subtotal_cents) - paid);
      const items: MemberOrderLine[] = (o.order_line_items || []).map((l) => ({
        label: l.label,
        qty: l.qty,
      }));
      return {
        id: o.id,
        rancherName: (o.rancher_id && nameById.get(o.rancher_id)) || 'Your rancher',
        status: o.status,
        createdAt: o.created_at,
        items,
        paidDollars: paid,
        balanceDollars: balance,
      };
    });

    return NextResponse.json({ orders: serialized });
  } catch (error: any) {
    // Never surface a commerce-layer error to the member page — log it and
    // return an empty set so the dashboard stays calm (build-dark contract).
    console.error('API error fetching member orders:', error);
    return NextResponse.json({ orders: [] });
  }
}
