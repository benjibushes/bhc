// app/api/admin/ranchers-tier-v2/route.ts
//
// Tiny lookup endpoint for SendDepositModal: list active tier_v2 ranchers
// (optionally state-filtered) w/ enough fields to compute deposit/full sale
// values inline without round-tripping per cut tier change.

import { NextResponse } from 'next/server';
import { getAllRecords, TABLES } from '@/lib/airtable';
import { requireAdmin } from '@/lib/adminAuth';

export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export async function GET(req: Request) {
  const a = await requireAdmin(req);
  if (a) return a;

  const url = new URL(req.url);
  const state = url.searchParams.get('state') || '';

  const filter = state
    ? `AND({Pricing Model}='tier_v2',{Active Status}='Active',OR(UPPER({State})='${state.toUpperCase()}',FIND(UPPER('${state.toUpperCase()}'),UPPER(ARRAYJOIN({States Served},',')))>0))`
    : `AND({Pricing Model}='tier_v2',{Active Status}='Active')`;

  const records = await getAllRecords(TABLES.RANCHERS, filter).catch(() => []);
  return NextResponse.json({
    ranchers: records.map((r: any) => ({
      id: r.id,
      name: String(r['Ranch Name'] || r['Operator Name'] || 'Unnamed'),
      state: String(r['State'] || ''),
      tier: String(r['Tier'] || 'Legacy Connect'),
      connectStatus: String(r['Stripe Connect Status'] || 'unknown'),
      quarterPrice: Number(r['Quarter Price'] || 0),
      halfPrice: Number(r['Half Price'] || 0),
      wholePrice: Number(r['Whole Price'] || 0),
      quarterDeposit: Number(r['Quarter Deposit'] || 0) || Number(r['Quarter Price'] || 0),
      halfDeposit: Number(r['Half Deposit'] || 0) || Number(r['Half Price'] || 0),
      wholeDeposit: Number(r['Whole Deposit'] || 0) || Number(r['Whole Price'] || 0),
    })),
  });
}
