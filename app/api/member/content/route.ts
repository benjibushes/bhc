import { NextResponse } from 'next/server';
import { getAllRecords, getRecordById, referralsByBuyerEmailFormula } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { normalizeState, normalizeStates } from '@/lib/states';
import { resolveBuyerSession } from '@/lib/buyerAuth';
import { FULFILLMENT_FIELDS } from '@/lib/fulfillmentTracking';

export const maxDuration = 60;

export async function GET(request: Request) {
  try {
    const session = await resolveBuyerSession(request);
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    let memberState = session.state || '';
    const memberId = session.consumerId;
    let memberSegment = '';
    let memberOrderType = '';

    // Buyer-scoped Referrals read (audit slice 9). 'Buyer Email' is a
    // long-standing Referrals field (email type, same field
    // findReferralByBuyerEmail filters on), so this is a direct swap from
    // "pull the ENTIRE Referrals table, filter by Buyer link in JS" to a
    // server-side LOWER(TRIM({Buyer Email})) match — O(this buyer's rows)
    // instead of O(all referrals platform-wide). Still guarded: any
    // filtered-read failure falls back to the legacy full scan, sessions
    // minted without an email skip straight to the scan, and the Buyer-link
    // ownership filter below stays as the belt either way.
    const fetchBuyerReferralRows = async (): Promise<any[]> => {
      const formula = referralsByBuyerEmailFormula(session.email);
      if (formula) {
        try {
          return (await getAllRecords(TABLES.REFERRALS, formula)) as any[];
        } catch (e: any) {
          console.warn(
            '[member/content] filtered Referrals read failed; falling back to full scan:',
            e?.message || e,
          );
        }
      }
      return (await getAllRecords(TABLES.REFERRALS)) as any[];
    };

    // All five reads are independent — one parallel round instead of three
    // serial rounds (consumer row → ranchers/deals/brands → referrals). Each
    // promise preserves its old failure semantics: consumer row is non-fatal
    // (segment stays empty), everything else degrades to [].
    const [memberConsumer, ranchers, landDeals, brands, referrals] = await Promise.all([
      // Rehydrates memberState if the JWT didn't carry it — older session
      // tokens minted by /api/warmup/engage didn't include state, which made
      // the dashboard show "0 ranchers" even after a successful match.
      // Defense-in-depth so any future token shape change can't strand the
      // buyer.
      memberId
        ? (getRecordById(TABLES.CONSUMERS, memberId) as Promise<any>).catch(() => null)
        : Promise.resolve<any>(null),
      getAllRecords(TABLES.RANCHERS, "{Certified} = TRUE()").catch(() => []),
      getAllRecords(TABLES.LAND_DEALS, "{Status} = 'Approved'").catch(() => []),
      // NOTE: Brands schema has no "Payment Status" field — the old filter
      // was always returning [] silently. Featured/Status are multilineText,
      // so use truthy-string checks. Brands are curated before being added.
      getAllRecords(TABLES.BRANDS, "{Featured}").catch(() => []),
      fetchBuyerReferralRows().catch(() => {
        console.warn('Referrals table not accessible, returning empty referrals');
        return [] as any[];
      }),
    ]);

    if (memberConsumer) {
      memberSegment = memberConsumer['Segment'] || '';
      memberOrderType = memberConsumer['Order Type'] || '';
      if (!memberState && memberConsumer['State']) memberState = String(memberConsumer['State']);
    }

    // Filter ranchers by member's state. Use normalizeState so "Montana" and
    // "MT" are both recognized (this comparison was buggy before — same root
    // cause as the matching engine state bug).
    const memberStateCode = normalizeState(memberState);
    const stateRanchers = ranchers.filter((r: any) => {
      const rState = normalizeState(r['State']);
      const served = normalizeStates(r['States Served']);
      return rState === memberStateCode || served.includes(memberStateCode);
    });
    const otherRanchers = ranchers.filter((r: any) => !stateRanchers.some((sr: any) => sr.id === r.id));

    // Get member's referral status — include rancher_id, sale_amount, and
    // closed_at so the UI can render the "Your Match" hero AND a "Past Orders
    // → Reorder" section for repeat customers.
    //
    // Resolve rancher name LIVE from the linked record (not the stale
    // "Suggested Rancher Name" text cache). Same drift bug class that
    // produced "Jose at High Lonesome" in chase-up emails — when ranchers
    // get renamed or replaced, the cache lags.
    const ranchersById = new Map<string, any>();
    for (const r of ranchers) ranchersById.set((r as any).id, r);
    const memberReferrals = referrals.filter((r: any) => {
      const buyerIds = r['Buyer'] || [];
      return Array.isArray(buyerIds) ? buyerIds.includes(memberId) : buyerIds === memberId;
    }).map((r: any) => {
      const rancherLinks = r['Rancher'] || r['Suggested Rancher'] || [];
      const rancherId = Array.isArray(rancherLinks) ? rancherLinks[0] : null;
      let rancherName = r['Suggested Rancher Name'] || '';
      let rancherEmail = '';
      let rancherPhone = '';
      let rancherSlug = '';
      if (rancherId && ranchersById.has(rancherId)) {
        const rr: any = ranchersById.get(rancherId);
        rancherName = rr['Operator Name'] || rr['Ranch Name'] || rancherName;
        rancherEmail = rr['Email'] || '';
        rancherPhone = rr['Phone'] || '';
        rancherSlug = rr['Slug'] || '';
      }
      return {
        id: r.id,
        status: r['Status'] || '',
        rancher_id: rancherId,
        rancher_name: rancherName,
        rancher_email: rancherEmail,
        rancher_phone: rancherPhone,
        rancher_slug: rancherSlug,
        order_type: r['Order Type'] || '',
        sale_amount: r['Sale Amount'] || 0,
        closed_at: r['Closed At'] || '',
        created_at: r['Created At'] || '',
        // F16 — engagement loop fields surfaced on /member status branches
        deposit_amount: Number(r['Deposit Amount'] || 0),
        deposit_paid_at: r['Deposit Paid At'] || '',
        rancher_accepted_at: r['Rancher Accepted At'] || '',
        final_invoice_url: r['Final Invoice URL'] || '',
        final_paid_at: r['Final Paid At'] || '',
        stripe_invoice_url: r['Stripe Invoice URL'] || '',
        fulfillment_confirmed_at: r['Fulfillment Confirmed At'] || '',
        processing_date: r['Processing Date'] || '',
        // D3 — surface the rancher-typed shipment fields (WAVE 3b fulfillment
        // tracker) to the buyer. Field names come from FULFILLMENT_FIELDS —
        // never hand-typed. Additive keys only; empty string when the rancher
        // hasn't filled them (or the founder hasn't created the Airtable
        // fields yet), which the UI treats as "render nothing".
        fulfillment_status: r[FULFILLMENT_FIELDS.status] || '',
        fulfillment_method: r[FULFILLMENT_FIELDS.method] || '',
        shipping_carrier: r[FULFILLMENT_FIELDS.carrier] || '',
        tracking_number: r[FULFILLMENT_FIELDS.trackingNumber] || '',
        fulfillment_updated_at: r[FULFILLMENT_FIELDS.updatedAt] || '',
      };
    });

    // F17 — surface affiliate code on member portal so Closed Won
    // buyers (auto-enrolled per I-9) can refer friends + earn.
    const affiliateCode = String((memberConsumer as any)?.['Affiliate Code'] || '');

    return NextResponse.json({
      memberState,
      memberSegment,
      affiliateCode,
      hasOrderDetails: !!memberOrderType,
      stateRanchers,
      otherRanchers,
      landDeals,
      brands,
      memberReferrals,
    });
  } catch (error: any) {
    console.error('API error fetching member content:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
