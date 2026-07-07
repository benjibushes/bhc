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

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';
import { getAllRecords, createRecord, getRancherBySlug, escapeAirtableValue, TABLES } from '@/lib/airtable';
import { isRancherOnConnect, isRancherOperationalForBuyers } from '@/lib/rancherEligibility';
import { mintCampaignReserveToken } from '@/lib/campaignReserve';
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

export async function POST(request: Request) {
  const unauthorized = await requireAdmin(request);
  if (unauthorized) return unauthorized;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const rancherSlug = String(body?.rancherSlug || '').trim().toLowerCase();
  const cut = String(body?.cut || '').trim().toLowerCase() as Cut;
  const buyerEmail = String(body?.buyerEmail || '').trim().toLowerCase();
  const buyerName = String(body?.buyerName || '').trim();
  const buyerState = String(body?.buyerState || '').trim().toUpperCase();

  if (!rancherSlug || !CUT_LABELS[cut] || !buyerEmail.includes('@')) {
    return NextResponse.json(
      { error: 'rancherSlug, a valid cut (quarter/half/whole), and buyerEmail are required' },
      { status: 400 },
    );
  }

  // Rancher must be deposit-capable RIGHT NOW — same gates the buyer-facing
  // reserve path enforces, checked at mint time so Ben never texts a link
  // that bounces to a fallback page.
  const rancher: any = await getRancherBySlug(rancherSlug).catch(() => null);
  if (!rancher) return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });
  if (!isRancherOnConnect(rancher) || !isRancherOperationalForBuyers(rancher)) {
    return NextResponse.json(
      { error: `${rancher['Ranch Name'] || 'This rancher'} cannot take a deposit right now (Connect/operational gate).` },
      { status: 409 },
    );
  }
  // GTM-hardening F1: the mint gate must MATCH the redemption gate.
  // /r/d → assertReserveEligible rejects price < MIN_TIER_PRICE, so minting
  // below the floor produces a link that bounces on tap (and deriveDeposit on
  // a mis-keyed $50 yields a nonsense $0 deposit). `>=` is NaN-safe: a
  // non-numeric Airtable value fails the comparison and 409s here.
  const tierPrice = Number(rancher[TIER_FIELD[cut]] || 0);
  if (!(tierPrice >= MIN_TIER_PRICE)) {
    return NextResponse.json(
      { error: `${rancher['Ranch Name']} has no valid ${cut} price (must be at least $${MIN_TIER_PRICE} — check the Airtable field).` },
      { status: 409 },
    );
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

  const token = mintCampaignReserveToken({ consumerId, rancherSlug, cut });
  const url = `${SITE_URL}/r/d/${token}`;
  const deposit = deriveDeposit(tierPrice);

  return NextResponse.json({
    url,
    rancher: String(rancher['Ranch Name'] || rancherSlug),
    cut,
    cutLabel: CUT_LABELS[cut],
    tierPrice,
    deposit,
  });
}
