// Pure decision + shape logic for the self-serve deposit ("reserve") path.
// The thin route (app/api/checkout/reserve/route.ts) does the Airtable I/O
// and session minting; everything testable lives here.

import { isRancherOnConnect, isRancherOperationalForBuyers } from '@/lib/rancherEligibility';
import { MIN_TIER_PRICE } from '@/lib/pricing';

export type Cut = 'quarter' | 'half' | 'whole';

export const CUT_LABELS: Record<Cut, string> = {
  quarter: 'Quarter Cow',
  half: 'Half Cow',
  whole: 'Whole Cow',
};

const CUT_PRICE_FIELD: Record<Cut, string> = {
  quarter: 'Quarter Price',
  half: 'Half Price',
  whole: 'Whole Price',
};

export type ReserveEligibility =
  | { ok: true }
  | { ok: false; status: number; error: string; fallback?: boolean };

/**
 * Gate a reserve attempt so the buyer never bounces at the deposit page.
 * Mirrors the deposit route's own gates (app/api/checkout/deposit/route.ts:
 * 108-126, 183-193) but fails BEFORE we create anything.
 */
export function assertReserveEligible(rancher: any, cut: Cut): ReserveEligibility {
  if (!CUT_LABELS[cut]) {
    return { ok: false, status: 400, error: 'cut must be quarter|half|whole' };
  }
  if (!isRancherOnConnect(rancher)) {
    return {
      ok: false,
      status: 409,
      error: 'This rancher takes orders through our standard flow.',
      fallback: true, // client falls back to the lead form / quiz
    };
  }
  if (!isRancherOperationalForBuyers(rancher)) {
    return {
      ok: false,
      status: 409,
      error: 'This rancher is not taking orders right now.',
      fallback: true,
    };
  }
  const price = Number(rancher[CUT_PRICE_FIELD[cut]]) || 0;
  if (price < MIN_TIER_PRICE) {
    return {
      ok: false,
      status: 409,
      error: 'That share is not priced for online deposit yet.',
      fallback: true,
    };
  }
  return { ok: true };
}

/**
 * Airtable field set for a deposit-intent referral. Pins Rancher + Buyer so
 * the deposit route's ownership + rancher lookup succeed. Deliberately omits
 * 'Approval Status' so it is NOT treated as a callback lead.
 */
export function buildReserveReferralFields(args: {
  rancher: any;
  consumerId: string;
  buyerName: string;
  buyerEmail: string;
  cut: Cut;
}): Record<string, any> {
  const ranchName = String(args.rancher['Ranch Name'] || args.rancher['Operator Name'] || 'Rancher');
  const who = args.buyerName || args.buyerEmail;
  return {
    Name: `${who} → ${ranchName} · ${CUT_LABELS[args.cut]}`,
    Status: 'Pending',
    'Match Type': 'Direct (Rancher Page) — Deposit',
    'Buyer Name': args.buyerName || '',
    'Buyer Email': args.buyerEmail,
    'Order Type': CUT_LABELS[args.cut],
    'Intent Score': 90,
    'Intent Classification': 'High',
    Notes: '[Source] Self-serve deposit (rancher page, no quiz)',
    Rancher: [args.rancher.id],
    Buyer: [args.consumerId],
  };
}

export function depositPathFor(referralId: string, cut: Cut): string {
  return `/checkout/${referralId}/deposit?cut=${cut}`;
}
