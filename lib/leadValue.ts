// lib/leadValue.ts
//
// Modeled expected $ value of a captured lead, for Meta value-based bidding.
//
// This is NOT booked revenue — it's a RELATIVE signal so Meta's optimizer
// prefers higher-intent / higher-basket leads over the cheapest click. Sending
// `value: 0` (the prior behavior on the funnel Lead) tells Meta every lead is
// worthless, which defeats value optimization entirely.
//
// The magnitudes are a deliberately conservative BASELINE, anchored to a rough
// expected-commission-per-lead (a whole cow ~$3.5k × ~7% commission × a modest
// lead→close rate). TUNE these once real cohort CAC/close-rate data exists —
// for the optimizer, the SHAPE (higher intent + bigger basket + ready-to-buy =
// higher value) matters more than the exact dollars. Pure + unit-tested.

export interface LeadValueInput {
  intentScore?: number | null;
  orderType?: string | null;
  readyToBuy?: boolean | null;
}

export function leadValueUsd(input: LeadValueInput = {}): number {
  // Base: a captured lead with no qualifying signal yet (e.g. funnel start).
  let v = 15;

  const score = Number(input.intentScore);
  if (Number.isFinite(score)) {
    if (score >= 80) v = 45;
    else if (score >= 50) v = 30;
    else if (score >= 25) v = 20;
  }

  if (input.readyToBuy) v += 15;

  const ot = String(input.orderType || '').toLowerCase();
  if (ot.includes('whole')) v += 25;
  else if (ot.includes('half')) v += 12;
  else if (ot.includes('quarter')) v += 5;

  return v;
}
