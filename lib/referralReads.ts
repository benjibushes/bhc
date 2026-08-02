// lib/referralReads.ts
//
// THE rancher-scoped Referrals read (extracted verbatim from
// app/api/rancher/dashboard/route.ts, scale audit 2026-07-07). The dashboard
// had the optimized read — a server-side filter on the 'Rancher Record Id' /
// 'Suggested Rancher Record Id' denorm fields, O(this rancher's referrals)
// instead of O(all referrals platform-wide) — while its sibling routes
// (customers, earnings CSV, quick-action + referral-detail close stats) each
// kept their own FULL-TABLE scan behind a stale "lookups don't exist"
// rationale. Referrals is 1,636 rows (17 paginated requests per scan) and
// grows with every buyer; the full scans burned the shared Airtable
// 5 req/s budget on every dashboard open + close action. One helper, every
// caller, same graceful degradation:
//
//   filtered+projected → (UNKNOWN_FIELD_NAME) → filtered unprojected
//                      → (INVALID_FILTER_BY_FORMULA) → full scan + operator
//                        signal telling Ben the 30-second Airtable fix
//
// Per-instance circuit breakers remember a broken path for 5 minutes so
// steady-state traffic doesn't pay a doomed probe per load. Callers MUST
// keep their JS ownership re-filter as the belt — the filter is bandwidth
// optimization, never the security boundary.

import {
  getAllRecords,
  referralsByRancherFormula,
  isInvalidFilterFormulaError,
  isUnknownFieldNameError,
  TABLES,
} from '@/lib/airtable';

// Fields the rancher surfaces actually render. Projection cuts bytes +
// latency (request COUNT is governed by pagination). created_at falls back
// to _createdTime metadata, which the projection always preserves.
export const REFERRAL_DASHBOARD_FIELDS = [
  // ownership belt
  'Rancher', 'Suggested Rancher',
  // status + money
  'Status', 'Sale Amount', 'Commission Due', 'Commission Paid',
  // activity / rot badges + leadQuality window
  'Last Rancher Activity At', 'Last Buyer Activity At', 'Rancher Accepted At',
  'Intro Sent At', 'Approved At', 'Closed At',
  // buyer card
  'Buyer Name', 'Buyer Email', 'Buyer Phone', 'Buyer State',
  'Order Type', 'Budget Range', 'Notes',
  // flags + invoices
  'Rancher Engaged Flag', 'Stripe Invoice URL',
  // fulfillment tracker (WAVE 3b)
  'Fulfillment Confirmed At', 'Fulfillment Status', 'Cut Sheet Note',
  'Fulfillment Method', 'Shipping Carrier', 'Tracking Number',
  'Fulfillment Updated At',
  // Wave 2 (2026-07-29): buyer-facing pickup/delivery date (fldZpGyngRdeBq5y0)
  // — distinct from Processing Date (the abattoir date).
  'Handoff Date',
  // Wave 2 (2026-07-29): the buyer's cut sheet. Stamped by
  // /api/checkout/[refId]/preferences — these were stripped from every
  // rancher projection, so the rancher dashboard could never show what the
  // buyer asked for.
  'Buyer Cut Notes', 'Buyer Fulfillment Pref', 'Buyer Window Pref',
  'Buyer Preferences Set At',
  // deposit + final invoice rail
  'Deposit Paid At', 'Deposit Amount', 'Deposit Requested At', 'Deposit Link Opened At',
  'Final Invoice URL', 'Final Invoice Sent At', 'Final Invoice Amount',
  'Final Paid At', 'Total Sale Amount', 'Processing Fee', 'Processing Date',
  // money-truth trail (2026-07-28) — rancher dashboards were structurally
  // BLIND to these: settled final amount, manual off-platform payment
  // confirmation, and commission-paid stamp all existed in Airtable but were
  // stripped by this projection. Display-only readers; the projection
  // breaker above degrades gracefully if a field is ever renamed.
  'Final Paid Amount', 'Payment Confirmed At', 'Payment Confirmation Method',
  'Commission Paid At',
  // Wave 1A (2026-08-01) — the TRUE Connect-rail fee, stamped in cents at
  // deposit settle (lib/stripeSettlement.ts). 'Commission Due' above is the
  // DEPRECATED legacy-invoice receivable — deliberately never written on
  // Connect closes — so without this field every Connect rancher read
  // "Commission $0" on their own earnings.
  'BHC Fee Cents',
  // My Leads (2026-07-29) — provenance marker (fldC5pUi90WDpBTsa). The
  // dashboard splits rancher-entered leads ('rancher-added') into the My
  // Leads CRM block and keeps them out of the routed Deals lists.
  'Referral Source',
];

const READ_PATH_BREAKER_MS = 5 * 60 * 1000;
let lookupFilterBrokenUntil = 0;
let projectionBrokenUntil = 0;

// One Referrals read with graceful projection: try fields[]-projected,
// degrade to unprojected on UNKNOWN_FIELD_NAME (schema drift), rethrow
// anything else (incl. INVALID_FILTER_BY_FORMULA — the caller owns that).
export async function readReferrals(formula?: string): Promise<any[]> {
  if (Date.now() < projectionBrokenUntil) {
    return (await getAllRecords(TABLES.REFERRALS, formula)) as any[];
  }
  try {
    return (await getAllRecords(TABLES.REFERRALS, formula, {
      fields: REFERRAL_DASHBOARD_FIELDS,
    })) as any[];
  } catch (e) {
    if (!isUnknownFieldNameError(e)) throw e;
    projectionBrokenUntil = Date.now() + READ_PATH_BREAKER_MS;
    console.warn('[referralReads] Referrals projection rejected (schema drift?); retrying unprojected');
    return (await getAllRecords(TABLES.REFERRALS, formula)) as any[];
  }
}

// Rancher-scoped Referrals fetch. Optimized path is a server-side filter on
// the 'Rancher Record Id' / 'Suggested Rancher Record Id' denorm fields —
// O(this rancher's referrals) instead of O(all referrals platform-wide).
// A formula referencing a nonexistent field ERRORS the whole query, so on
// that exact error class we fall back to the legacy full scan and fire a
// once-per-day operator signal. NEVER throws that path's error at the
// request. Downstream ALWAYS re-applies the JS ownership filter as a belt.
export async function fetchReferralRowsForRancher(rancherId: string): Promise<any[]> {
  if (Date.now() >= lookupFilterBrokenUntil) {
    try {
      return await readReferrals(referralsByRancherFormula(rancherId));
    } catch (e: any) {
      if (isInvalidFilterFormulaError(e)) {
        lookupFilterBrokenUntil = Date.now() + READ_PATH_BREAKER_MS;
        try {
          const { sendOperatorSignal } = await import('@/lib/operatorSignal');
          await sendOperatorSignal({
            urgency: 'normal',
            kind: 'system-error',
            summary: 'Add lookup fields on Referrals to kill the dashboard full-scan',
            detail:
              'Every /rancher dashboard load is full-scanning the Referrals table. ' +
              '30-second fix in the Airtable UI — on Referrals add TWO Lookup fields: ' +
              '1) "Rancher Record Id" (via the Rancher link, showing Ranchers → Rancher Record Id), ' +
              '2) "Suggested Rancher Record Id" (via the Suggested Rancher link, same source field). ' +
              'The filtered read then engages automatically — no deploy needed.',
            dedupeKey: 'referrals-rancher-lookup-missing',
            dedupeWindowMs: 24 * 60 * 60 * 1000, // once per day
          });
        } catch {}
      } else {
        console.warn(
          '[referralReads] filtered Referrals read failed; falling back to full scan:',
          e?.message || e,
        );
      }
      // fall through to the legacy scan
    }
  }
  return readReferrals();
}
