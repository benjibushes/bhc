import { NextResponse } from 'next/server';
import {
  getRecordById,
  getAllRecords,
  referralsByRancherFormula,
  isInvalidFilterFormulaError,
  isUnknownFieldNameError,
} from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { getMaxActiveReferrals } from '@/lib/rancherCapacity';
import { requireRancher } from '@/lib/rancherAuth';

export const maxDuration = 60;

import { getRancherCommissionRate } from '@/lib/commission';

// Pure: total commission the rancher still owes BHC on closed-won deals.
// tier_v2 ranchers NEVER owe a post-close invoice — BHC's cut was taken at
// deposit time via Stripe Connect application_fee_amount, and the close handler
// (referrals/[id]/route.ts) deliberately SKIPS createCommissionInvoice for them.
// Counting their Closed Won rows here surfaces a phantom "Invoice pending"
// balance + a dead "Pay now" link the rancher can never satisfy. So tier_v2
// always returns 0; legacy sums the unpaid Commission Due across closed-won.
// Exported (non-handler export — ignored by the Next router) so it can be
// unit-tested without spinning the route.
export function computeUnpaidCommission(
  closedWon: Array<Record<string, any>>,
  pricingModel: string,
): number {
  if (pricingModel === 'tier_v2') return 0;
  return closedWon
    .filter((r) => !r['Commission Paid'])
    .reduce((sum, r) => sum + (Number(r['Commission Due']) || 0), 0);
}

// ── Referrals read path (audit slice 9: kill the full-table scan) ────────
//
// Every Referrals field this route's payload maps — verified against the
// LIVE schema 2026-07-01. Projecting trims the per-record payload from ~86
// table fields to these 38 (bandwidth/latency; request count is governed by
// pagination). 'Created At' is deliberately ABSENT: Referrals has no such
// field (R3 note below) and an unknown name in fields[] errors the whole
// query — created_at falls back to _createdTime metadata, which the
// projection always preserves.
const REFERRAL_DASHBOARD_FIELDS = [
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
  // deposit + final invoice rail
  'Deposit Paid At', 'Deposit Amount', 'Deposit Requested At',
  'Final Invoice URL', 'Final Invoice Sent At', 'Final Invoice Amount',
  'Final Paid At', 'Total Sale Amount', 'Processing Fee', 'Processing Date',
];

// Per-instance circuit breakers. The optimized read depends on Airtable
// schema the founder controls (the two lookup fields; projection field
// names), and a formula/projection naming a nonexistent field ERRORS the
// whole query. On that error class we fall back seamlessly AND remember the
// breakage for 5 minutes so steady-state traffic doesn't pay a doomed probe
// request per load. After the window we probe again — so when Ben adds the
// lookup fields the filtered read engages by itself, zero deploy.
const READ_PATH_BREAKER_MS = 5 * 60 * 1000;
let lookupFilterBrokenUntil = 0;
let projectionBrokenUntil = 0;

// One Referrals read with graceful projection: try fields[]-projected,
// degrade to unprojected on UNKNOWN_FIELD_NAME (schema drift), rethrow
// anything else (incl. INVALID_FILTER_BY_FORMULA — the caller owns that).
async function readReferrals(formula?: string): Promise<any[]> {
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
    console.warn('[rancher/dashboard] Referrals projection rejected (schema drift?); retrying unprojected');
    return (await getAllRecords(TABLES.REFERRALS, formula)) as any[];
  }
}

// Rancher-scoped Referrals fetch. Optimized path is a server-side filter on
// the 'Rancher Record Id' / 'Suggested Rancher Record Id' LOOKUP fields —
// O(this rancher's referrals) instead of O(all referrals platform-wide).
// Those lookups may not exist yet (the founder must add them manually; the
// API can't create lookups). A formula referencing a nonexistent field
// ERRORS the whole query, so on that exact error class we fall back to the
// legacy full scan and fire a once-per-day operator signal telling Ben the
// 30-second Airtable fix. NEVER throws that path's error at the request.
// Downstream ALWAYS re-applies the JS ownership filter as a belt.
async function fetchReferralRowsForRancher(rancherId: string): Promise<any[]> {
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
          '[rancher/dashboard] filtered Referrals read failed; falling back to full scan:',
          e?.message || e,
        );
      }
      // fall through to the legacy scan
    }
  }
  return readReferrals();
}

// Network Benefits = brands flagged Featured + Status approved/active.
// BRANDS fields that actually exist (per schema): Brand Name, Contact Name,
// Email, Phone, Website, Product Category, Proposed Discount, Partnership Goals,
// Featured, Status. Older code referenced "Product Type", "Discount Offered (%)",
// and "Payment Status" — none of which exist — so the filter silently returned
// zero brands forever. Also: Status is multilineText (free text), so we do a
// truthy/contains check instead of strict equality. Never throws — the Brands
// table may not be accessible, in which case the dashboard renders no benefits
// (same as the old inline try/catch).
async function loadNetworkBenefits(): Promise<any[]> {
  try {
    const allBrands = await getAllRecords(TABLES.BRANDS);
    return allBrands
      .filter((b: any) => {
        const status = String(b['Status'] || '').toLowerCase();
        const featured = !!b['Featured'];
        return featured && (status.includes('approv') || status.includes('active') || status.includes('paid'));
      })
      .map((b: any) => ({
        id: b.id,
        brand_name: b['Brand Name'] || '',
        product_type: b['Product Category'] || '',
        discount_offered: Number(b['Proposed Discount']) || 0,
        description: b['Partnership Goals'] || '',
        website: b['Website'] || '',
        contact_email: b['Email'] || '',
      }));
  } catch {
    // Brands table may not be accessible
    return [];
  }
}

export async function GET(request: Request) {
  try {
    const r = await requireRancher(request);
    if (r instanceof NextResponse) return r;
    const { session } = r;

    // The three reads are order-independent — run them in parallel instead
    // of serially (rancher row → referrals scan → brands scan tripled
    // worst-case latency for zero ordering need). The referrals + brands
    // promises swallow their own failures exactly like the old inline
    // try/catch blocks did; a rancher-row failure still throws to the outer
    // catch → 500, unchanged.
    const [rancher, referralRows, networkBenefits] = await Promise.all([
      getRecordById(TABLES.RANCHERS, session.rancherId) as Promise<any>,
      fetchReferralRowsForRancher(session.rancherId).catch(() => {
        console.warn('Referrals table not accessible, returning empty referrals');
        return [] as any[];
      }),
      loadNetworkBenefits(),
    ]);
    if (!rancher) {
      return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });
    }

    // Ownership belt — ALWAYS applied, filtered read or full-scan fallback.
    // When the lookup-filtered read worked these rows are already
    // rancher-scoped (the lookup mirrors the link), so this is a cheap
    // re-check; on the fallback it is the real filter. Direct link-id
    // filtering server-side is impossible: the filterByFormula optimization
    // attempted in PR #36 (audit #30) used FIND(rancherId,
    // ARRAYJOIN({Rancher})) — but ARRAYJOIN on a linked-record field renders
    // the linked record's PRIMARY FIELD VALUE (e.g. "Sackett Ranch"), not
    // its record ID, so FIND could never match and every rancher saw 0
    // referrals. Hence the Lookup-field read + this JS belt.
    const myId = session.rancherId;
    const myReferrals = referralRows.filter((r: any) => {
      const rancherLinks = Array.isArray(r['Rancher']) ? r['Rancher'] : [];
      const suggested = Array.isArray(r['Suggested Rancher']) ? r['Suggested Rancher'] : [];
      return rancherLinks.includes(myId) || suggested.includes(myId);
    });

    const activeReferrals = myReferrals.filter((r: any) =>
      ['Intro Sent', 'Rancher Contacted', 'Negotiation'].includes(r['Status'])
    );

    const closedWon = myReferrals.filter((r: any) => r['Status'] === 'Closed Won');
    const closedLost = myReferrals.filter((r: any) => r['Status'] === 'Closed Lost');

    const totalRevenue = closedWon.reduce((sum: number, r: any) => sum + (r['Sale Amount'] || 0), 0);
    const totalCommission = closedWon.reduce((sum: number, r: any) => sum + (r['Commission Due'] || 0), 0);
    // tier_v2 ranchers never owe a post-close commission invoice (see
    // computeUnpaidCommission). Forced to 0 so the dashboard doesn't show a
    // phantom "Invoice pending" balance + dead "Pay now" link.
    const pricingModel = String(rancher['Pricing Model'] || 'legacy');
    const unpaidCommission = computeUnpaidCommission(closedWon, pricingModel);

    // Parity with admin desk F12 — compute days-since-activity per referral
    // so rancher cards can show rot badges. Source of truth: max of
    // last activity timestamps (rancher, buyer, accept) + Airtable
    // metadata createdTime.
    // R3 (2026-06-10): Referrals has NO `Created At` field — use
    // _rawJson.createdTime metadata.
    const referralsList = myReferrals.map((r: any) => {
      const candidates = [
        r['Last Rancher Activity At'],
        r['Last Buyer Activity At'],
        r['Rancher Accepted At'],
        r['Intro Sent At'],
        r._createdTime,
      ]
        .filter(Boolean)
        .map((s: any) => {
          const t = new Date(String(s)).getTime();
          return isNaN(t) ? 0 : t;
        });
      const lastActivityMs = candidates.length ? Math.max(...candidates) : 0;
      const days_since_activity = lastActivityMs > 0
        ? Math.floor((Date.now() - lastActivityMs) / (1000 * 60 * 60 * 24))
        : null;
      return {
      id: r.id,
      status: r['Status'] || '',
      buyer_name: r['Buyer Name'] || '',
      buyer_email: r['Buyer Email'] || '',
      buyer_phone: r['Buyer Phone'] || '',
      buyer_state: r['Buyer State'] || '',
      order_type: r['Order Type'] || '',
      budget_range: r['Budget Range'] || '',
      notes: r['Notes'] || '',
      sale_amount: r['Sale Amount'] || 0,
      commission_due: r['Commission Due'] || 0,
      commission_paid: r['Commission Paid'] || false,
      created_at: r['Created At'] || r._createdTime || '',
      intro_sent_at: r['Intro Sent At'] || '',
      closed_at: r['Closed At'] || '',
      last_rancher_activity_at: r['Last Rancher Activity At'] || '',
      last_buyer_activity_at: r['Last Buyer Activity At'] || '',
      days_since_activity,
      rancher_engaged_flag: !!r['Rancher Engaged Flag'],
      stripe_invoice_url: r['Stripe Invoice URL'] || '',
      // Stage-3 Audit B4 — surface fulfillment status so the dashboard
      // can render the green pill on already-confirmed Closed Won deals
      // and gate the "Mark beef delivered" CTA on the missing field.
      fulfillment_confirmed_at: r['Fulfillment Confirmed At'] || '',
      // WAVE 3b (2026-06-30) — richer per-order fulfillment tracker fields.
      // These are NEW Airtable fields the founder creates; until they exist
      // Airtable returns undefined and these read as '' so the UI degrades to
      // the binary confirm flow. See lib/fulfillmentTracking.
      fulfillment_status: r['Fulfillment Status'] || '',
      cut_sheet_note: r['Cut Sheet Note'] || '',
      fulfillment_method: r['Fulfillment Method'] || '',
      shipping_carrier: r['Shipping Carrier'] || '',
      tracking_number: r['Tracking Number'] || '',
      fulfillment_updated_at: r['Fulfillment Updated At'] || '',
      // FINAL-5 (2026-05-31) — deposit + final invoice tracking so the
      // "Send Final Invoice" button can render on Awaiting Payment rows
      // (tier_v2 Stripe Connect flow).
      deposit_paid_at: r['Deposit Paid At'] || '',
      deposit_amount: Number(r['Deposit Amount'] || 0),
      // WAVE 1 (2026-06-30) — stamped by /request-deposit when the rancher
      // self-serves a deposit ask. Drives the amber "deposit requested" badge +
      // the re-request label before the buyer pays.
      deposit_requested_at: r['Deposit Requested At'] || '',
      // NRD (2026-06-05): non-refundable lock cutoff. Set when rancher hits
      // "Accept Slot" — POST /api/rancher/referrals/[id]/accept. Refund
      // endpoint guards against post-accept refunds without operator override.
      rancher_accepted_at: r['Rancher Accepted At'] || '',
      final_invoice_url: r['Final Invoice URL'] || '',
      final_invoice_sent_at: r['Final Invoice Sent At'] || '',
      final_invoice_amount: Number(r['Final Invoice Amount'] || 0),
      final_paid_at: r['Final Paid At'] || '',
      total_sale_amount: Number(r['Total Sale Amount'] || 0),
      // Processing Fee is stamped per-referral by send-final-invoice when the
      // rancher submits the invoice (Airtable field 'Processing Fee'). It's the
      // rancher's own USDA out-of-pocket cost, recorded for their books — it is
      // NOT part of the buyer balance (balance = total_sale_amount −
      // deposit_amount, matching the send-final-invoice server charge).
      processing_fee: Number(r['Processing Fee'] || 0),
      processing_date: r['Processing Date'] || '',
      };
    });

    // Sort: active first, then by date
    referralsList.sort((a: any, b: any) => {
      const activeStatuses = ['Intro Sent', 'In Progress', 'Rancher Contacted', 'Negotiation', 'Awaiting Payment', 'Slot Locked'];
      const aActive = activeStatuses.includes(a.status) ? 0 : 1;
      const bActive = activeStatuses.includes(b.status) ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });

    return NextResponse.json({
      rancher: {
        id: rancher.id,
        name: rancher['Operator Name'] || '',
        ranchName: rancher['Ranch Name'] || '',
        state: rancher['State'] || '',
        // WAVE 3b (2026-06-30): surface the editable account contact fields so
        // the dashboard "account" settings section can prefill them. Email is
        // the rancher's login + where leads land; Phone is operator contact.
        email: rancher['Email'] || '',
        phone: rancher['Phone'] || '',
        activeStatus: rancher['Active Status'] || 'Pending',
        onboardingStatus: rancher['Onboarding Status'] || '',
        agreementSigned: rancher['Agreement Signed'] || false,
        // Per-rancher commission rate, locked at sign-agreement time
        // (PR #35). Surfaces to the dashboard UI so the close-deal modal
        // + earnings tab show the correct rate instead of hardcoded 10%.
        // Audit finding 2026-05-20 #29.
        commissionRate: getRancherCommissionRate(rancher),
        currentActiveReferrals: rancher['Current Active Referrals'] || 0,
        maxActiveReferrals: getMaxActiveReferrals(rancher),
        monthlyCapacity: rancher['Monthly Capacity'] || 0,
        beefTypes: rancher['Beef Types'] || '',
        calComSlug: rancher['Cal.com Slug'] || '',
        statesServed: rancher['States Served'] || '',
        // Preferred States = rancher's requested service area (editable).
        // Routing States = admin-controlled, drives actual matching. We
        // surface both so the UI can show "you asked for X, we're routing Y".
        preferredStates: rancher['Preferred States'] || rancher['States Served'] || '',
        routingStates: rancher['Routing States'] || rancher['States Served'] || '',
        shipsNationwide: rancher['Ships Nationwide'] || false,
        certifications: rancher['Certifications'] || '',
        // Landing page fields
        slug: rancher['Slug'] || '',
        pageLive: rancher['Page Live'] || false,
        logoUrl: rancher['Logo URL'] || '',
        tagline: rancher['Tagline'] || '',
        aboutText: rancher['About Text'] || '',
        videoUrl: rancher['Video URL'] || '',
        quarterPrice: rancher['Quarter Price'] || '',
        quarterDeposit: rancher['Quarter Deposit'] || '',
        quarterProcessingFee: rancher['Quarter Processing Fee'] || '',
        quarterLbs: rancher['Quarter lbs'] || '',
        quarterPaymentLink: rancher['Quarter Payment Link'] || '',
        halfPrice: rancher['Half Price'] || '',
        halfDeposit: rancher['Half Deposit'] || '',
        halfProcessingFee: rancher['Half Processing Fee'] || '',
        halfLbs: rancher['Half lbs'] || '',
        halfPaymentLink: rancher['Half Payment Link'] || '',
        wholePrice: rancher['Whole Price'] || '',
        wholeDeposit: rancher['Whole Deposit'] || '',
        wholeProcessingFee: rancher['Whole Processing Fee'] || '',
        wholeLbs: rancher['Whole lbs'] || '',
        wholePaymentLink: rancher['Whole Payment Link'] || '',
        // P1-4: surface tier specialty so the dashboard can render a
        // no-pricing alarm card. Buyers picking a Quarter/Half/Whole that
        // the rancher's Tier Specialty includes but has no price set get
        // 409'd at /api/checkout/deposit — silent buyer bounce. The
        // dashboard needs both fields to compute the missing-cut list.
        tierSpecialty: Array.isArray(rancher['Tier Specialty'])
          ? (rancher['Tier Specialty'] as string[])
          : [],
        nextProcessingDate: rancher['Next Processing Date'] || '',
        reserveLink: rancher['Reserve Link'] || '',
        customNotes: rancher['Custom Notes'] || '',
        customProducts: rancher['Custom Products'] || '',
        // Multi-user: additional emails allowed to log into this dashboard.
        teamEmails: rancher['Team Emails'] || '',
        // Required by /rancher optimization checklist (Gallery + Testimonials
        // were missing → checklist permanently nagged ranchers who had filled
        // those out).
        galleryPhotos: rancher['Gallery Photos'] || '',
        testimonials: rancher['Testimonials'] || '',
        // Click tracking stats
        quarterClicks: rancher['Quarter Clicks'] || 0,
        halfClicks: rancher['Half Clicks'] || 0,
        wholeClicks: rancher['Whole Clicks'] || 0,
        // Stage-3 Task 11C — fields the dashboard banner cascade needs.
        // Pricing Model gates legacy vs tier_v2 ranchers. Tier is the
        // singleSelect string (Airtable returns either a string or
        // {id,name,color} — coerce to string here). Connect status is
        // the Airtable cache; the /api/rancher/billing/data endpoint
        // refreshes it live. Banner cascade is OK with the cache.
        pricingModel: String(rancher['Pricing Model'] || 'legacy'),
        tier: (() => {
          const raw = rancher['Tier'];
          if (raw && typeof raw === 'object' && 'name' in (raw as any)) return String((raw as any).name);
          return raw ? String(raw) : null;
        })(),
        subscriptionStatus: String(rancher['Subscription Status'] || ''),
        connectStatus: String(rancher['Stripe Connect Status'] || 'not_connected'),
      },
      stats: {
        totalReferrals: myReferrals.length,
        activeReferrals: activeReferrals.length,
        closedWon: closedWon.length,
        closedLost: closedLost.length,
        totalRevenue,
        totalCommission,
        unpaidCommission,
        netEarnings: totalRevenue - totalCommission,
        // Lead Quality metrics — recent-window summary so ranchers can see
        // what proportion of their leads convert vs ghost. Builds trust that
        // the platform protects them from "slop" and is worth a retainer.
        leadQuality: (() => {
          const lastN = [...myReferrals]
            .sort((a: any, b: any) => {
              const ta = new Date(a['Intro Sent At'] || a['Approved At'] || 0).getTime();
              const tb = new Date(b['Intro Sent At'] || b['Approved At'] || 0).getTime();
              return tb - ta;
            })
            .slice(0, 10);
          const closed = lastN.filter((r: any) => ['Closed Won', 'Closed Lost'].includes(r['Status']));
          const won = lastN.filter((r: any) => r['Status'] === 'Closed Won');
          const inProgress = lastN.filter((r: any) => ['Rancher Contacted', 'Negotiation'].includes(r['Status']));
          const intro = lastN.filter((r: any) => r['Status'] === 'Intro Sent');
          const closeRate = closed.length > 0 ? Math.round((won.length / closed.length) * 100) : 0;
          return {
            recentWindowSize: lastN.length,
            closedRecent: closed.length,
            wonRecent: won.length,
            inProgressRecent: inProgress.length,
            introRecent: intro.length,
            closeRatePct: closeRate,
          };
        })(),
      },
      referrals: referralsList,
      networkBenefits,
    });
  } catch (error: any) {
    console.error('Rancher dashboard error:', error);
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}
