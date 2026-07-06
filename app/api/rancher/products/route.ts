// app/api/rancher/products/route.ts
//
// Rancher self-serve marketplace products (journey overhaul Phase 6) — the
// supply loop. A Connect-active rancher creates/edits/hides their own
// low-ticket products from the dashboard; a created product auto-lists on
// /shop within seconds (on-demand revalidate beats the 5-min ISR window).
//
//   GET   → list MY products (each with a `live` flag = isSellableRow)
//   POST  → create (Connect-active gate → validate → derive pricing → row +
//           best-effort Stripe Product/Price on MY connected account)
//   PATCH → edit fields / toggle Active (ownership-checked)
//
// MONEY-PATH BOUNDARY: this route only decides what's ON the shelf (the
// Rancher Products row + its Display/Base). The charge itself — checkout
// session, application_fee (Display − Base), settlement, webhooks — lives in
// the existing, untouched /api/checkout/product rail. ensureStripePrice here
// is the same best-effort pre-mint the checkout does lazily; a failure never
// blocks (checkout falls back to inline price_data and self-heals the sync).
//
// Auth mirrors the landing-page editor: requireRancher → session.rancherId;
// ownership = the product's Rancher Record ID must equal the caller.

import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { requireRancher } from '@/lib/rancherAuth';
import { isRancherOnConnect } from '@/lib/rancherEligibility';
import {
  TABLES,
  createRecord,
  updateRecord,
  getRecordById,
  getAllRecords,
} from '@/lib/airtable';
import { isSellableRow } from '@/lib/marketplaceProducts';
import { deriveProductPricing, validateProductInput } from '@/lib/rancherProductInput';
import { ensureStripePrice } from '@/lib/productStripeSync';

export const dynamic = 'force-dynamic';

// Ben's kill-switch for auto-live: default OFF (products list immediately —
// founder directive 2026-07-06). Flip REQUIRE_PRODUCT_APPROVAL=true in Vercel
// to hold new products at Active=false pending review, no code change.
const requireApproval = () => process.env.REQUIRE_PRODUCT_APPROVAL === 'true';

const ownerOf = (product: any) => String(product?.['Rancher Record ID'] || '').trim();

function toClientProduct(r: any) {
  return {
    id: r.id,
    name: String(r['Product Name'] || ''),
    price: Number(r['Display Price'] || 0),
    base: Number(r['Rancher Base'] || 0),
    category: (() => { const c = r['Category']; return String((c && typeof c === 'object' ? c.name : c) || ''); })(),
    weight: String(r['Weight / Size'] || ''),
    description: String(r['Description'] || ''),
    image: String(r['Image URL'] || ''),
    shipsNationwide: r['Ships Nationwide'] !== false,
    shelfStable: !!r['Shelf Stable'],
    active: r['Active'] === true,
    live: isSellableRow(r),
  };
}

function revalidateShop(id?: string) {
  // On-demand revalidate so the marketplace reflects the change in seconds,
  // not at the 5-minute ISR boundary. Best-effort — ISR is the backstop.
  try {
    revalidatePath('/shop');
    if (id) revalidatePath(`/shop/${id}`);
  } catch {
    /* ISR backstop */
  }
}

// ── GET — my products ─────────────────────────────────────────────────────────

export async function GET(request: Request) {
  const r = await requireRancher(request);
  if (r instanceof NextResponse) return r;
  const { session } = r;

  const rows = ((await getAllRecords(TABLES.RANCHER_PRODUCTS).catch(() => [])) as any[]).filter(
    (row) => ownerOf(row) === session.rancherId,
  );
  return NextResponse.json({ products: rows.map(toClientProduct) });
}

// ── POST — create ─────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  const r = await requireRancher(request);
  if (r instanceof NextResponse) return r;
  const { session } = r;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Connect-active gate — you can't sell without a Stripe account to be paid on.
  const rancher: any = await getRecordById(TABLES.RANCHERS, session.rancherId).catch(() => null);
  if (!rancher) return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });
  if (!isRancherOnConnect(rancher)) {
    return NextResponse.json(
      { error: 'finish your Stripe setup to sell products — head to Billing to complete it.' },
      { status: 403 },
    );
  }
  const connectAccountId = String(rancher['Stripe Connect Account Id'] || '').trim();
  if (!connectAccountId) {
    return NextResponse.json(
      { error: 'finish your Stripe setup to sell products — head to Billing to complete it.' },
      { status: 403 },
    );
  }

  const v = validateProductInput(body);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

  // Rancher entered RETAIL; derive their net via the category margin. The
  // margin becomes the application_fee at checkout (Display − Base) — computed
  // there, not here.
  const pricing = deriveProductPricing({
    displayCents: v.displayCents,
    category: String(v.fields['Category']),
  });

  const active = !requireApproval();
  const created: any = await createRecord(TABLES.RANCHER_PRODUCTS, {
    ...v.fields,
    'Rancher Base': pricing.baseCents / 100,
    'Rancher Name': String(rancher['Ranch Name'] || session.ranchName || session.name || ''),
    'Rancher Record ID': session.rancherId,
    Active: active,
  });
  if (!created?.id) {
    return NextResponse.json({ error: 'could not save the product — try again.' }, { status: 500 });
  }

  // Pre-mint the Stripe Product + Price on the rancher's connected account so
  // the first checkout is instant. Best-effort: checkout mints lazily + falls
  // back to inline price_data, so a sync blip never blocks a sale.
  try {
    const sync = await ensureStripePrice({
      productRecordId: created.id,
      productName: String(v.fields['Product Name']),
      displayCents: pricing.displayCents,
      connectAccountId,
    });
    await updateRecord(TABLES.RANCHER_PRODUCTS, created.id, {
      'Stripe Product Id': sync.productId,
      'Stripe Price Id': sync.priceId,
      'Stripe Price Cents': sync.priceCents,
    }).catch(() => {});
  } catch (e: any) {
    console.warn('[rancher/products] pre-mint skipped (checkout self-heals):', e?.message);
  }

  if (active) {
    revalidateShop(created.id);
  } else {
    // Held for review — ping Ben so a pending product never sits silent.
    try {
      const { sendOperatorSignal } = await import('@/lib/operatorSignal');
      await sendOperatorSignal({
        urgency: 'normal',
        kind: 'sale',
        summary: `New product pending approval: ${v.fields['Product Name']} — ${rancher['Ranch Name'] || 'rancher'}`,
        detail: `$${(pricing.displayCents / 100).toFixed(2)} · flip Active in Rancher Products to list it.`,
        dedupeKey: `product-approval-${created.id}`,
      });
    } catch {
      /* non-fatal */
    }
  }

  const fresh: any = await getRecordById(TABLES.RANCHER_PRODUCTS, created.id).catch(() => null);
  return NextResponse.json({
    product: fresh ? toClientProduct(fresh) : { id: created.id },
    pricing: {
      display: pricing.displayCents / 100,
      yourNet: pricing.baseCents / 100,
      bhcCut: pricing.marginCents / 100,
      marginRate: pricing.marginRate,
    },
    pendingApproval: !active,
  });
}

// ── PATCH — edit / hide / show ────────────────────────────────────────────────

export async function PATCH(request: Request) {
  const r = await requireRancher(request);
  if (r instanceof NextResponse) return r;
  const { session } = r;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const productId = String(body?.productId || '').trim();
  if (!/^rec[A-Za-z0-9]{14}$/.test(productId)) {
    return NextResponse.json({ error: 'Invalid product id' }, { status: 400 });
  }

  const product: any = await getRecordById(TABLES.RANCHER_PRODUCTS, productId).catch(() => null);
  if (!product) return NextResponse.json({ error: 'Product not found' }, { status: 404 });

  // Ownership — same 403 shape as the referral routes.
  if (ownerOf(product) !== session.rancherId) {
    return NextResponse.json({ error: 'This product does not belong to you.' }, { status: 403 });
  }

  const patch: Record<string, any> = {};

  // Hide/show is the one non-content field a rancher may toggle. Re-showing
  // while approval mode is on goes back through review.
  if (typeof body.active === 'boolean') {
    patch['Active'] = body.active && requireApproval() && product['Active'] !== true ? false : body.active;
  }

  // Content edits ride the same validator as create (all-or-nothing).
  const editing = ['name', 'displayPrice', 'category', 'description', 'weight', 'imageUrl', 'shipsNationwide', 'shelfStable']
    .some((k) => k in body);
  if (editing) {
    const merged = {
      name: body.name ?? String(product['Product Name'] || ''),
      displayPrice: body.displayPrice ?? Number(product['Display Price'] || 0),
      category: body.category ?? String((product['Category'] && typeof product['Category'] === 'object' ? product['Category'].name : product['Category']) || ''),
      description: body.description ?? String(product['Description'] || ''),
      weight: body.weight ?? String(product['Weight / Size'] || ''),
      imageUrl: body.imageUrl ?? String(product['Image URL'] || ''),
      shipsNationwide: body.shipsNationwide ?? product['Ships Nationwide'] !== false,
      shelfStable: body.shelfStable ?? !!product['Shelf Stable'],
    };
    const v = validateProductInput(merged);
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
    Object.assign(patch, v.fields);
    // Any price change re-derives the net so Base can never drift from the
    // margin policy. Stripe price sync self-heals on next checkout.
    const pricing = deriveProductPricing({
      displayCents: v.displayCents,
      category: String(v.fields['Category']),
    });
    patch['Rancher Base'] = pricing.baseCents / 100;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
  }

  await updateRecord(TABLES.RANCHER_PRODUCTS, productId, patch);
  revalidateShop(productId);

  const fresh: any = await getRecordById(TABLES.RANCHER_PRODUCTS, productId).catch(() => null);
  return NextResponse.json({ product: fresh ? toClientProduct(fresh) : { id: productId } });
}
