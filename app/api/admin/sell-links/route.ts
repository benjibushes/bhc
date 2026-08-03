// POST /api/admin/sell-links — mint a 1-tap DEPOSIT link for a phone-call buyer.
//
// Ben is selling a share live on the phone: he picks a rancher + cut in the
// sell console, enters the buyer's email, and this mints the same
// campaign-reserve link the nurture rail uses (/r/d/<token>) — the buyer taps
// it and lands straight on the deposit checkout for that rancher + cut, no
// quiz, no magic-link wall. Security model unchanged from lib/campaignReserve:
// the token names {consumerId, rancherSlug, cut}; the /r/d route exchanges it
// for a referral-scoped deposit grant (never a member session), so a forwarded
// link can at worst pay ONE deposit.
//
// Consumer find-or-create mirrors app/api/orders/request (upsert by email) so
// a brand-new phone lead gets a Consumers row and an existing buyer reuses
// theirs — the deposit then settles onto the right person either way.
//
// Product checkout links are NOT minted here — the console calls the existing
// admin-gated POST /api/checkout/product for those. Admin-gated.
//
// TWO RAILS (2026-07-31). The caller picks exactly one:
//   • `rancherSlug` → CONNECT rail. Mints /r/d/<campaign-reserve token>. The
//     buyer pays deposit + BHC's fee on top; the rancher keeps 100% of price.
//   • `rancherId`   → BROKER rail. Mints /r/b/<broker-reserve token> for a
//     REPRESENTED ranch (no Connect, no page, no slug — hence the record id).
//     The buyer's deposit goes 100% to BHC and IS the commission; the rancher
//     collects price − deposit direct. See docs/BUSINESS-MODEL.md model 3.
// Passing both is refused rather than resolved — they are different money
// models and guessing which one Ben meant is not a decision code should make.

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';
import { getAllRecords, createRecord, getRancherBySlug, getRecordById, escapeAirtableValue, TABLES } from '@/lib/airtable';
import { isRancherOnConnect, isRancherOperationalForBuyers } from '@/lib/rancherEligibility';
import { mintCampaignReserveToken, mintBrokerReserveToken } from '@/lib/campaignReserve';
import { assertBrokerEligible } from '@/lib/brokerRail';
import { deriveDeposit, MIN_TIER_PRICE } from '@/lib/pricing';
import { CUT_LABELS, type Cut } from '@/lib/reserveDeposit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

const TIER_FIELD: Record<Cut, string> = {
  quarter: 'Quarter Price',
  half: 'Half Price',
  whole: 'Whole Price',
};

// ---------------------------------------------------------------------------
// Pure request decisions — exported so the rail choice and the broker money
// gate are unit-testable without Airtable, Stripe or an admin session.
// ---------------------------------------------------------------------------

export interface SellLinkRequest {
  rail: 'connect' | 'broker';
  rancherSlug: string;
  rancherId: string;
  cut: Cut;
  buyerEmail: string;
  buyerName: string;
  buyerState: string;
}

export type SellLinkRailChoice =
  | { ok: true; request: SellLinkRequest }
  | { ok: false; status: number; error: string };

/**
 * Normalize the body and pick EXACTLY ONE rail.
 *
 * The invariant this function exists to hold: `rancherSlug` and `rancherId`
 * name different money models, so both-at-once is refused rather than resolved.
 * Guessing which one the operator meant is not a decision code should make —
 * one choice bills the buyer BHC's fee on top, the other hands BHC the whole
 * deposit as commission.
 */
export function resolveSellLinkRail(body: any): SellLinkRailChoice {
  const rancherSlug = String(body?.rancherSlug || '').trim().toLowerCase();
  // BROKER RAIL (2026-07-31): a REPRESENTED ranch is addressed by RECORD ID,
  // not slug — it has no public page and no slug by design. Passing
  // `rancherId` selects the broker branch.
  const rancherId = String(body?.rancherId || '').trim();
  const cut = String(body?.cut || '').trim().toLowerCase() as Cut;
  const buyerEmail = String(body?.buyerEmail || '').trim().toLowerCase();
  const buyerName = String(body?.buyerName || '').trim();
  const buyerState = String(body?.buyerState || '').trim().toUpperCase();

  if (!CUT_LABELS[cut] || !buyerEmail.includes('@')) {
    return {
      ok: false,
      status: 400,
      error: 'a valid cut (quarter/half/whole) and buyerEmail are required',
    };
  }
  if (!rancherSlug && !rancherId) {
    return {
      ok: false,
      status: 400,
      error: 'rancherSlug (Connect rail) or rancherId (broker rail) is required',
    };
  }
  if (rancherSlug && rancherId) {
    // Refuse rather than pick — the two names select DIFFERENT money models.
    return {
      ok: false,
      status: 400,
      error: 'pass rancherSlug OR rancherId, never both — they select different rails',
    };
  }

  return {
    ok: true,
    request: {
      rail: rancherId ? 'broker' : 'connect',
      rancherSlug,
      rancherId,
      cut,
      buyerEmail,
      buyerName,
      buyerState,
    },
  };
}

/**
 * The broker mint gate: assertBrokerEligible, with the ranch name prefixed so
 * the console can surface the refusal verbatim and the operator knows WHICH
 * ranch to go fix. Pure.
 *
 * Deliberately thin — every actual rule (represented / no Connect footprint /
 * priced / explicit deposit / deposit < price) lives in lib/brokerRail and is
 * re-run at tap time by lib/brokerReferral. Duplicating any of it here would
 * let the mint gate drift from the redemption gate, which is how you text a
 * buyer a link that bounces.
 */
export function brokerMintGate(
  rancher: any,
  cut: Cut,
): { ok: true; tierPrice: number; deposit: number } | { ok: false; status: number; error: string } {
  const gate = assertBrokerEligible(rancher, cut);
  if (!gate.ok) {
    return {
      ok: false,
      status: gate.status,
      error: `${rancher?.['Ranch Name'] || 'This ranch'}: ${gate.error}`,
    };
  }
  return { ok: true, tierPrice: gate.quote.priceCents / 100, deposit: gate.quote.depositCents / 100 };
}

/**
 * Compose the buyer-facing link. Separate token PURPOSES and separate
 * redemption paths — a link for one rail can never redeem on the other (see
 * lib/campaignReserve).
 */
export function sellLinkUrlFor(
  args:
    | { rail: 'broker'; consumerId: string; rancherId: string; cut: Cut }
    | { rail: 'connect'; consumerId: string; rancherSlug: string; cut: Cut },
): string {
  return args.rail === 'broker'
    ? `${SITE_URL}/r/b/${mintBrokerReserveToken({
        consumerId: args.consumerId,
        rancherId: args.rancherId,
        cut: args.cut,
      })}`
    : `${SITE_URL}/r/d/${mintCampaignReserveToken({
        consumerId: args.consumerId,
        rancherSlug: args.rancherSlug,
        cut: args.cut,
      })}`;
}

export async function POST(request: Request) {
  const unauthorized = await requireAdmin(request);
  if (unauthorized) return unauthorized;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const choice = resolveSellLinkRail(body);
  if (!choice.ok) {
    return NextResponse.json({ error: choice.error }, { status: choice.status });
  }
  const { rancherSlug, rancherId: brokerRancherId, cut, buyerEmail, buyerName, buyerState } =
    choice.request;

  // ── Resolve the rancher + gate the mint, per rail ────────────────────────
  // In BOTH rails the mint gate must MATCH the redemption gate exactly, so Ben
  // never texts a link that bounces when the buyer taps it.
  let rancher: any = null;
  let tierPrice = 0;
  let deposit = 0;
  const rail = choice.request.rail;

  if (rail === 'broker') {
    // ── BROKER RAIL ────────────────────────────────────────────────────────
    // The deposit here is the WHOLE commission and goes 100% to BHC's own
    // Stripe account. It is never derived — assertBrokerEligible requires an
    // explicit per-cut deposit, because deriving one would invent Ben's fee
    // and silently change what the rancher nets.
    rancher = await getRecordById(TABLES.RANCHERS, brokerRancherId).catch(() => null);
    if (!rancher) return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });
    // Same gate lib/brokerReferral re-runs at tap time.
    const gate = brokerMintGate(rancher, cut);
    if (!gate.ok) {
      return NextResponse.json({ error: gate.error }, { status: gate.status });
    }
    tierPrice = gate.tierPrice;
    deposit = gate.deposit;
  } else {
    // ── CONNECT RAIL (unchanged) ───────────────────────────────────────────
    rancher = await getRancherBySlug(rancherSlug).catch(() => null);
    if (!rancher) return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });
    if (!isRancherOnConnect(rancher) || !isRancherOperationalForBuyers(rancher)) {
      return NextResponse.json(
        { error: `${rancher['Ranch Name'] || 'This rancher'} cannot take a deposit right now (Connect/operational gate).` },
        { status: 409 },
      );
    }
    // GTM-hardening F1: /r/d → assertReserveEligible rejects price <
    // MIN_TIER_PRICE, so minting below the floor produces a link that bounces
    // on tap (and deriveDeposit on a mis-keyed $50 yields a nonsense $0
    // deposit). `>=` is NaN-safe: a non-numeric Airtable value fails here.
    tierPrice = Number(rancher[TIER_FIELD[cut]] || 0);
    if (!(tierPrice >= MIN_TIER_PRICE)) {
      return NextResponse.json(
        { error: `${rancher['Ranch Name']} has no valid ${cut} price (must be at least $${MIN_TIER_PRICE} — check the Airtable field).` },
        { status: 409 },
      );
    }
    deposit = deriveDeposit(tierPrice);
  }

  // Find-or-create the Consumer (mirrors app/api/orders/request).
  let consumerId = '';
  try {
    const existing: any[] = await getAllRecords(
      TABLES.CONSUMERS,
      `LOWER({Email}) = "${escapeAirtableValue(buyerEmail)}"`,
    );
    if (existing.length > 0) {
      consumerId = existing[0].id;
    } else {
      const created: any = await createRecord(TABLES.CONSUMERS, {
        'Full Name': buyerName || buyerEmail.split('@')[0],
        Email: buyerEmail,
        State: buyerState || '',
        Segment: 'Beef Buyer',
        'Lead Source': 'operator-sell',
      });
      consumerId = created?.id || '';
    }
  } catch (e: any) {
    return NextResponse.json({ error: `consumer upsert failed: ${e?.message || 'unknown'}` }, { status: 502 });
  }
  if (!consumerId) {
    return NextResponse.json({ error: 'could not resolve the buyer record' }, { status: 502 });
  }

  const url =
    rail === 'broker'
      ? sellLinkUrlFor({ rail, consumerId, rancherId: brokerRancherId, cut })
      : sellLinkUrlFor({ rail, consumerId, rancherSlug, cut });

  return NextResponse.json({
    url,
    rail,
    rancher: String(rancher['Ranch Name'] || rancherSlug || brokerRancherId),
    cut,
    cutLabel: CUT_LABELS[cut],
    tierPrice,
    deposit,
    // On the broker rail the deposit IS the commission; on Connect the fee is
    // added on top of the deposit at checkout. Surfaced so the sell console
    // can state Ben's take honestly without re-deriving it.
    bhcTake: rail === 'broker' ? deposit : null,
    rancherNets: rail === 'broker' ? tierPrice - deposit : null,
  });
}
