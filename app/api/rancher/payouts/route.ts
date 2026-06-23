// app/api/rancher/payouts/route.ts
//
// Rancher Cockpit — "did I get paid?" surface (Wave A, 2026-06-22).
//
// The single biggest free-data win: ranchers are Stripe Connect accounts with
// dashboard:'full', so Stripe already runs a compliant money dashboard for
// them. This route surfaces the ONE fact a rancher should never have to "go
// check Stripe" for — whether money has landed — and deep-links the detail.
//
// Returns (all best-effort, never throws to the client):
//   {
//     loginUrl: string | null,        // one-time Express/Connect dashboard link
//     availableCents: number | null,  // current available balance (USD)
//     pendingCents: number | null,    // balance still settling
//     paidCents: number | null,       // most-recent completed payout amount
//     nextPayoutDateISO: string | null
//   }
//
// BUILD-DARK CONTRACT: if STRIPE_CONNECT_ENABLED !== 'true', or the rancher has
// no Connect account yet, or any Stripe read fails, we degrade to a safe empty
// shape ({ loginUrl: null, ... nulls }) with a 200 so the Home money strip /
// Money nav simply render nothing extra. Same session guard as every other
// /api/rancher route (requireRancher → 401 when unauthed).

import { NextResponse } from 'next/server';
import { getRecordById, TABLES } from '@/lib/airtable';
import { getStripe } from '@/lib/stripe';
import { requireRancher } from '@/lib/rancherAuth';

export const dynamic = 'force-dynamic';
export const maxDuration = 20;

interface PayoutsResponse {
  loginUrl: string | null;
  availableCents: number | null;
  pendingCents: number | null;
  paidCents: number | null;
  nextPayoutDateISO: string | null;
}

const EMPTY: PayoutsResponse = {
  loginUrl: null,
  availableCents: null,
  pendingCents: null,
  paidCents: null,
  nextPayoutDateISO: null,
};

export async function GET(req: Request) {
  const r = await requireRancher(req);
  if (r instanceof NextResponse) return r;
  const { session } = r;

  // Build-dark gate — Connect not turned on in this environment.
  if (process.env.STRIPE_CONNECT_ENABLED !== 'true') {
    return NextResponse.json(EMPTY);
  }

  let accountId = '';
  try {
    const rancher: any = await getRecordById(TABLES.RANCHERS, session.rancherId);
    accountId = String(rancher?.['Stripe Connect Account Id'] || '').trim();
  } catch (e: any) {
    console.warn('[rancher payouts] rancher lookup failed:', e?.message);
    return NextResponse.json(EMPTY);
  }

  // No Connect account yet → nothing to surface, degrade safely.
  if (!accountId) {
    return NextResponse.json(EMPTY);
  }

  const stripe = getStripe();
  const out: PayoutsResponse = { ...EMPTY };

  // 1) Balance — the "did money land?" fact. Scoped to the rancher's Connect
  //    account via the Stripe-Account header. usd buckets summed across the
  //    (rarely >1) currency entries.
  try {
    const balance = await stripe.balance.retrieve({ stripeAccount: accountId });
    const sumUsd = (arr: Array<{ amount: number; currency: string }> | undefined) =>
      (arr || [])
        .filter((b) => b.currency === 'usd')
        .reduce((s, b) => s + (b.amount || 0), 0);
    out.availableCents = sumUsd(balance.available as any);
    out.pendingCents = sumUsd(balance.pending as any);
  } catch (e: any) {
    console.warn('[rancher payouts] balance.retrieve failed:', e?.message);
  }

  // 2) Recent + upcoming payout. payouts.list returns most-recent first; the
  //    first 'paid' one is the last money that hit their bank, and a 'pending'
  //    or 'in_transit' one carries the next arrival date. Cheap single call.
  try {
    const payouts = await stripe.payouts.list(
      { limit: 5 },
      { stripeAccount: accountId },
    );
    const data = payouts.data || [];
    const lastPaid = data.find((p) => p.status === 'paid');
    if (lastPaid) out.paidCents = lastPaid.amount || 0;
    const upcoming = data.find(
      (p) => p.status === 'pending' || p.status === 'in_transit',
    );
    if (upcoming?.arrival_date) {
      out.nextPayoutDateISO = new Date(upcoming.arrival_date * 1000).toISOString();
    }
  } catch (e: any) {
    console.warn('[rancher payouts] payouts.list failed:', e?.message);
  }

  // 3) One-time dashboard login link. Express login links only exist for
  //    Express-dashboard accounts; BHC's V2 accounts use dashboard:'full', so
  //    this can legitimately reject — that's fine, we just return loginUrl:null
  //    and the UI shows the balance fact without a "View my payouts" button.
  try {
    const link = await stripe.accounts.createLoginLink(accountId);
    out.loginUrl = link?.url || null;
  } catch (e: any) {
    console.warn('[rancher payouts] createLoginLink unavailable (expected for full-dashboard accounts):', e?.message);
  }
  // Full-dashboard (Standard) Connect accounts can't get a platform login link —
  // the rancher signs into their OWN Stripe. Send them to the real payouts page
  // rather than bouncing to /rancher/billing, so "View my payouts" always lands
  // somewhere useful. (The in-app "you've been paid $X" fact already shows above.)
  if (!out.loginUrl) out.loginUrl = 'https://dashboard.stripe.com/payouts';

  return NextResponse.json(out);
}
