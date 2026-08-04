// POST /api/rancher/referrals — "My Leads": rancher-entered lead create.
//
// The rancher types in a person they met (farmers market, phone call,
// neighbor) and manages them like a CRM. TRACK-AS-DEAL (2026-08-03): the
// same POST also accepts { orderId } — promote a shop-order customer
// (Rancher Orders row, e.g. a purchase through the ranch's own site) into
// the SAME kind of lead. Contact fields then come from the ORDER ROW
// (server truth, ownership-checked), never the client body; the decision
// logic is pure in lib/rancherLeads.decideOrderPromote. Everything below
// the input branch — consumer upsert, referral create, the NO-side-effects
// contract — is one shared path. Architecture (2026-07-29, DO NOT
// redesign): the lead is a normal Referrals row with
//   'Referral Source' = 'rancher-added'  (fldC5pUi90WDpBTsa)
// plus a Consumers row with 'Lead Source' = 'rancher-crm' — NOT a new table,
// so Ben's admin, close tracking, and the deposit rail work unchanged.
//
// What this route deliberately does NOT do:
//   - NO emails. No intro email, no operator Telegram, nothing — the rancher
//     entered the lead themselves; any message from BHC here would be noise
//     (or worse, marketing to a buyer who never consented).
//   - NO capacity INCR. The lead was never routed; lib/capacityCount skips
//     'rancher-added' rows everywhere so the counters never see them.
//   - NO routing fields. Consumer gets Buyer Stage=MATCHED (spoken-for) with
//     NO Status / Qualified At / Intent Score — invisible to every pool.
//
// Double-deal fence: if the email already belongs to a consumer with an
// ACTIVE referral (isActiveDealReferral) we 409 — with a different message
// depending on whose deal it is. Never silently double-deal a buyer.
//
// Auth mirrors the sibling routes ([id]/fulfillment, products): requireRancher
// session; rancherId comes from the SESSION, never the body.

import { NextResponse } from 'next/server';
import {
  TABLES,
  getRecordById,
  getAllRecords,
  createRecord,
  createReferral,
  updateRecord,
  referralsByBuyerEmailFormula,
  escapeAirtableValue,
} from '@/lib/airtable';
import { requireRancher } from '@/lib/rancherAuth';
import { isActiveDealReferral } from '@/lib/capacityCount';
import { fetchReferralRowsForRancher } from '@/lib/referralReads';
import {
  validateLeadInput,
  decideOrderPromote,
  buildLeadConsumerFields,
  buildLeadReferralFields,
  type LeadInput,
} from '@/lib/rancherLeads';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// GET /api/rancher/referrals?reviews=1 — the rancher's buyer reviews.
//
// Wave 2 rancher-UX: Buyer Review / Buyer Rating / Review Submitted At live
// on Referrals, the PUBLIC page filters to rating ≥ 4, and no rancher surface
// projected any of it — so a rancher could take a 2-star review, have it
// silently hidden from their page, and never be told. This read returns ALL
// of their reviews, including the low-rated ones, so they can see (and fix)
// the cause. Read-only; the ownership JS re-filter is the belt, same as every
// referral read.
export async function GET(req: Request) {
  const r = await requireRancher(req);
  if (r instanceof NextResponse) return r;
  const { session } = r;
  const rancherId = String(session.rancherId || '');
  if (!rancherId) {
    return NextResponse.json({ error: 'Session missing rancher id' }, { status: 401 });
  }

  let rows: any[];
  try {
    rows = await fetchReferralRowsForRancher(rancherId);
  } catch (e: any) {
    console.error('[rancher/referrals GET] read failed:', e?.message || e);
    return NextResponse.json(
      { error: "Couldn't load your reviews just now — try again in a moment." },
      { status: 503 },
    );
  }

  // Ownership belt — never trust the filter alone.
  const mine = rows.filter((row) => {
    const links = [
      ...((row['Rancher'] as string[]) || []),
      ...((row['Suggested Rancher'] as string[]) || []),
    ];
    return links.includes(rancherId);
  });

  const reviews = mine
    .filter((row) => row['Review Submitted At'] || Number(row['Buyer Rating']) >= 1)
    .map((row) => {
      const rating = Math.min(5, Math.max(0, Number(row['Buyer Rating']) || 0));
      return {
        id: row.id,
        buyerName: String(row['Buyer Name'] || 'Buyer'),
        rating,
        review: String(row['Buyer Review'] || '').trim(),
        submittedAt: row['Review Submitted At'] || null,
        // Mirrors the public-page filter (rating ≥ 4 shows on /ranchers/[slug]).
        publiclyVisible: rating >= 4,
      };
    })
    .sort(
      (a, b) => new Date(b.submittedAt || 0).getTime() - new Date(a.submittedAt || 0).getTime(),
    );

  return NextResponse.json({ reviews });
}

export async function POST(req: Request) {
  const r = await requireRancher(req);
  if (r instanceof NextResponse) return r;
  const { session } = r;
  const rancherId = String(session.rancherId || '');
  if (!rancherId) {
    return NextResponse.json({ error: 'Session missing rancher id' }, { status: 401 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // ── input branch: hand-typed lead OR shop-order promote ──────────────────
  let lead: LeadInput;
  // True on the { orderId } path — its dedupe + double-deal fence already ran
  // (fail-CLOSED, inside decideOrderPromote), so the hand-typed fence below is
  // skipped rather than re-read.
  let promotedFromOrder = false;
  const orderId = String(body?.orderId || '').trim();
  if (orderId) {
    // Load the order row — contact truth comes from HERE, never the body.
    let order: any = null;
    try {
      order = await getRecordById(TABLES.RANCHER_ORDERS, orderId);
    } catch (e: any) {
      const notFound =
        e?.statusCode === 404 ||
        String(e?.error || '') === 'NOT_FOUND' ||
        /not.?found/i.test(String(e?.message || ''));
      if (!notFound) {
        // Transient Airtable blip must not read as "order not found".
        return NextResponse.json(
          { error: "Couldn't load that order just now — try again in a moment." },
          { status: 503 },
        );
      }
      order = null;
    }

    // Referral matches for the dedupe + double-deal decision. Unlike the
    // hand-typed fence (fail-OPEN — never block a rancher typing at a
    // market), the one-click promote fails CLOSED on a read error: a blind
    // create here could silently duplicate an existing deal, and the rancher
    // can simply tap again.
    let existingRefs: any[] = [];
    const orderEmail = String(order?.['Buyer Email'] || '').trim().toLowerCase();
    if (order && orderEmail) {
      const formula = referralsByBuyerEmailFormula(orderEmail);
      if (formula) {
        try {
          existingRefs = (await getAllRecords(TABLES.REFERRALS, formula)) as any[];
        } catch (e: any) {
          console.warn('[rancher/referrals POST] promote dedupe read failed:', e?.message);
          return NextResponse.json(
            { error: "Couldn't check your existing deals just now — try again in a moment." },
            { status: 503 },
          );
        }
      }
    }

    const decision = decideOrderPromote({
      order,
      rancherId,
      existingReferrals: existingRefs,
    });
    if (decision.kind === 'error') {
      return NextResponse.json({ error: decision.message }, { status: decision.httpStatus });
    }
    if (decision.kind === 'duplicate') {
      // 409 + the existing referral id so the UI can deep-link to the deal.
      return NextResponse.json(
        { error: decision.message, duplicate: true, referralId: decision.referralId },
        { status: 409 },
      );
    }
    lead = decision.lead;
    promotedFromOrder = true;
  } else {
    const validated = validateLeadInput({
      name: body?.name,
      email: body?.email,
      phone: body?.phone,
      note: body?.note,
    });
    if (!validated.ok) {
      return NextResponse.json({ error: validated.error }, { status: 400 });
    }
    lead = validated.lead;
  }

  // Rancher row — State (lead's presumed state) + ranch name for the row title.
  let rancher: any = null;
  try {
    rancher = await getRecordById(TABLES.RANCHERS, rancherId);
  } catch {
    /* non-fatal — builders tolerate blanks */
  }
  const rancherState = String(rancher?.['State'] || '').toUpperCase().slice(0, 2);
  const ranchName = String(rancher?.['Ranch Name'] || rancher?.['Operator Name'] || 'Ranch');

  const nowIso = new Date().toISOString();

  // ── Double-deal fence + consumer upsert (email-keyed, like orders/request) ─
  let consumerId = '';
  // Promote path already ran its (fail-CLOSED) dedupe + fence above — never
  // re-read here.
  if (lead.email && !promotedFromOrder) {
    // Active-deal check rides the Buyer Email denorm (the reliable formula
    // key — link-field ARRAYJOIN emits names, not ids). Fail-OPEN on a read
    // error: a transient Airtable blip should not block a rancher typing in
    // a lead at a market; matching/suggest's alreadyActive guard remains the
    // routing-side belt.
    try {
      const formula = referralsByBuyerEmailFormula(lead.email);
      if (formula) {
        const existingRefs = (await getAllRecords(TABLES.REFERRALS, formula)) as any[];
        const active = existingRefs.filter((ref) => isActiveDealReferral(ref));
        const mine = active.some((ref) => {
          const links = [
            ...((ref['Rancher'] as string[]) || []),
            ...((ref['Suggested Rancher'] as string[]) || []),
          ];
          return links.includes(rancherId);
        });
        if (active.length > 0 && mine) {
          return NextResponse.json(
            { error: 'This buyer is already in your pipeline — check your Deals and My Leads lists.' },
            { status: 409 },
          );
        }
        if (active.length > 0) {
          return NextResponse.json(
            {
              error:
                'This buyer is already in an active deal on the platform, so we can’t add them as your lead right now. Reach out to hello@buyhalfcow.com if you think that’s wrong.',
            },
            { status: 409 },
          );
        }
      }
    } catch (e: any) {
      console.warn('[rancher/referrals POST] active-deal check failed (continuing):', e?.message);
    }
  }

  if (lead.email) {
    // Email-keyed consumer upsert (mirrors orders/request): reuse an existing
    // row rather than minting a duplicate pair. IMPORTANT: an EXISTING
    // consumer keeps their own provenance — we never stamp 'Lead Source' /
    // Buyer Stage over an organic buyer's record; only blanks are filled.
    try {
      const safeEmail = escapeAirtableValue(lead.email);
      const existing = (await getAllRecords(
        TABLES.CONSUMERS,
        `LOWER({Email}) = "${safeEmail.toLowerCase()}"`,
      )) as any[];
      if (existing.length > 0) {
        consumerId = existing[0].id;
        const patch: Record<string, any> = {};
        if (lead.phone && !existing[0]['Phone']) patch['Phone'] = lead.phone;
        if (Object.keys(patch).length > 0) {
          await updateRecord(TABLES.CONSUMERS, consumerId, patch);
        }
      }
    } catch (e: any) {
      console.warn('[rancher/referrals POST] consumer lookup failed (will create):', e?.message);
    }
  }

  if (!consumerId) {
    try {
      const created: any = await createRecord(
        TABLES.CONSUMERS,
        buildLeadConsumerFields(lead, { rancherState }, nowIso),
      );
      consumerId = created?.id || '';
    } catch (e: any) {
      // Non-fatal — the referral still carries the denormalized buyer fields
      // (same graceful degradation as orders/request).
      console.error('[rancher/referrals POST] consumer create failed:', e?.message);
    }
  }

  // ── Referral create — createReferral stamps the Rancher Record Id denorms
  // so the rancher-scoped dashboard read picks the row up immediately.
  let referral: any;
  try {
    referral = await createReferral(
      buildLeadReferralFields(lead, { rancherId, rancherState, ranchName, consumerId }, nowIso),
    );
  } catch (e: any) {
    console.error('[rancher/referrals POST] referral create failed:', e?.message);
    return NextResponse.json({ error: 'Could not save the lead — try again.' }, { status: 500 });
  }

  // NO capacity INCR, NO emails, NO Telegram — by design (see header).
  return NextResponse.json({ ok: true, referralId: referral.id, consumerId: consumerId || null });
}
