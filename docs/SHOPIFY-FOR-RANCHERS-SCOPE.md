# Shopify-for-Ranchers — Scope + Effort Analysis
**Saved:** 2026-05-25 · For execution after Stage-3 ships

---

## TL;DR

**~80% of the plumbing is already in Stage-3.** Stripe Connect + V2 accounts + Checkout w/ destination charge + product-on-connected-account headers all exist or are scheduled in Stage-3 Tasks 2-16. Replicating Shopify's per-merchant catalog model for ranchers is a **Phase B (~2 weeks)** + **Phase C (~1 week)** extension on top of Stage-3.

Total Stage-3 → full Shopify-like: **~4-6 weeks subagent-driven**.

---

## What Stage-3 already gives us (locked in plan Tasks 2-16)

These pieces are direct prerequisites for a per-rancher product catalog. Stage-3 ships them for the 3-tier (Quarter/Half/Whole) use case but architecturally they generalize to N products:

| Stage-3 piece | Generalizes to |
|---------------|----------------|
| `lib/stripeConnect.ts` w/ Connect account create + onboarding | Per-rancher Stripe account = per-rancher merchant identity |
| `stripeAccount` header pattern on direct charges | Same header creates/lists/retrieves products + checkout on rancher's account |
| `application_fee_amount` for per-tier commission | Same field per-product (BHC commission scales with product price) |
| Buyer deposit page `/checkout/[refId]/deposit` | Becomes `/checkout/[refId]/cart` w/ multi-line-item support |
| Stripe Checkout Session `line_items` array | Already supports N products in one session — change is UI-side |
| Payments + Payouts Airtable tables | Already keyed by payment intent — N-product orders write N line items into one Payment row OR split rows |
| Webhook `payment_intent.succeeded` handler | Same handler captures multi-product orders |
| Rancher dashboard `/rancher/billing` | Add Products tab + Orders tab |
| Per-rancher fulfillment data (Fulfillment Types + Pickup City + etc.) | Per-rancher remains; PER-PRODUCT lead-time + shipping override added |

**What this means:** Stage-3's 3-tier checkout is a degenerate case of a 2-product catalog. Same code paths handle N-product catalog with UI + schema extensions.

---

## What's left to build (Phase B + Phase C)

### Phase B: Multi-product catalog + cart (~2 weeks, 10-15 tasks)

#### B1: Schema — Products + Variants + Inventory
- New Airtable table `Rancher Products`:
  - Primary: Stripe Product Id (`prod_*` from rancher's Connect account)
  - Fields: Rancher (link), Name, Description, Price Cents, Image URL, Active checkbox, Cut Type (singleSelect: ground / steak / roast / variety / bulk), Variant Of (link to parent product, optional), Sort Order, Stock Available (number, optional), Lead Time Days Override (number, optional)
- New Airtable table `Rancher Product Orders`:
  - Primary: Stripe Checkout Session Id (`cs_*`)
  - Fields: Rancher (link), Buyer (link), Total Amount Cents, Platform Fee Cents, Line Items (long text JSON dump of [{productId, quantity, priceCents}]), Status, Created At, Captured At
- Migration: backfill the existing 3-tier Quarter/Half/Whole fields on Ranchers into `Rancher Products` rows so legacy still renders the same way

#### B2: Rancher product management UI
- New page `/rancher/products` — table of all products w/ "Add Product" button
- Add/edit modal: Name + Description + Price + Image upload (Vercel Blob) + Cut Type
- POST `/api/rancher/products/create` — calls `stripeClient.products.create({...}, {stripeAccount: acct_*})` on rancher's Connect account + creates Airtable row
- PATCH `/api/rancher/products/[id]` — updates name/description/price (Stripe Price is immutable, so price change = new Price object; product retains the new default)
- DELETE `/api/rancher/products/[id]` — flips `active: false` on Stripe (Stripe doesn't allow true delete on used products) + flips Airtable Active=false
- Image upload: existing Vercel Blob integration handles photo storage

#### B3: Buyer product catalog rendering
- Extend `/ranchers/[slug]` landing page to fetch + render products from rancher's Connect account
  - For `Pricing Model='tier_v2'` ranchers: render Rancher Products table OR Stripe products list
  - For `Pricing Model='legacy'` ranchers: keep existing Quarter/Half/Whole link rendering
- Buyer product detail at `/ranchers/[slug]/product/[productId]` — full product page w/ description + photo + "Add to Cart" button

#### B4: Cart state + persistence
- Cart lives in localStorage + (if logged in) syncs to a `Cart` Airtable row per buyer
- New table `Carts`:
  - Buyer (link), Rancher (link, scoped to one rancher per cart — V1 = single-rancher cart), Line Items (JSON), Updated At
- Cart drawer component (right-side slide-out) shows current line items + remove buttons + total
- Cart respects single-rancher scope: buyer can't mix products from 2 ranchers (V1 — multi-rancher cart deferred to V2; mirrors how Etsy-style works in practice)

#### B5: Multi-line-item Stripe Checkout
- Extend `/api/checkout/deposit` (renamed `/api/checkout/cart` for clarity OR add new endpoint)
- Body: `{ referralId, cartId }` instead of `{ referralId, tier, cutSize }`
- Build `line_items` array from cart contents
- `application_fee_amount` = sum of line totals × rancher's tier commission rate (Pasture 7% / Ranch 3% / Operator 0%)
- Single Checkout Session created with `stripeAccount` header
- On success webhook: write multi-line `Rancher Product Orders` row + still write a parent `Payments` row for funnel-tracking compatibility
- Funnel event `deposit_paid` includes `lineItems` array in metadata

#### B6: Order management for rancher
- New page `/rancher/orders` — list of all Rancher Product Orders w/ filter (Pending / Paid / Fulfilled / Refunded)
- Per-order detail: list of products + buyer info + fulfillment confirm button + thread link
- Confirm fulfillment flow same as Stage-3 (`/api/rancher/fulfillment/confirm`) but operates on a Rancher Product Order Id instead of a Payment Id

#### B7: Buyer order tracking
- Extend `/member` dashboard with Orders section
- Per-order page showing line items + fulfillment status + thread

#### B8: Stripe Products + Prices migration for tier-v2 existing
- For ranchers already on tier_v2 BEFORE Phase B ships: write a migration script that reads their Quarter/Half/Whole fields + creates corresponding Stripe Products on their Connect account + Rancher Products Airtable rows
- One-time backfill so existing tier_v2 ranchers don't need to re-enter products

### Phase C: Variants + Inventory + Cut Sheets (~1 week, 5-8 tasks)

#### C1: Variants (e.g. Quarter Cow with different cut sheet options)
- Product can have child Variants (parent → variant relationship in Rancher Products table)
- Variants share the parent product's name but have their own Stripe Price + their own Price Cents in Airtable
- Buyer UI: variant selector on product page (e.g., "Standard cut sheet" / "Custom cut sheet — +$50")
- Cart stores variant Stripe Price Id, not parent product Id

#### C2: Inventory tracking
- Optional `Stock Available` field on Rancher Products row
- On Checkout success: decrement Stock Available by line-item quantity
- If `Stock Available = 0`: hide product from buyer-facing catalog
- Telegram alert when product crosses below 3 units in stock (rancher restock reminder)
- Defer: bulk inventory management UI (V1 = manual edit in dashboard)

#### C3: Cut sheets (rancher-defined custom selections)
- For Quarter/Half/Whole products: rancher can attach a "Cut Sheet" PDF or define structured cut options
- New Airtable table `Cut Sheet Options`:
  - Product (link to Rancher Products), Option Name (e.g., "Roasts vs Steaks split"), Option Type (singleSelect: choice, slider, text), Choices (JSON array)
- Buyer selects cut sheet options at checkout (added to Checkout Session metadata)
- Rancher sees buyer's choices on Order detail page
- Mirrors how real beef ordering works — every Half Cow has 50+ cut decisions

---

## Stripe API patterns to use (V1 products, V2 accounts)

**Product create on connected account:**
```ts
const product = await stripeClient.products.create({
  name: input.name,
  description: input.description,
  default_price_data: {
    unit_amount: input.priceCents,
    currency: 'usd',
  },
  images: input.imageUrl ? [input.imageUrl] : undefined,
  metadata: { rancherId: input.rancherId },
}, {
  stripeAccount: rancher.stripeConnectAccountId,
});
// returns { id: 'prod_*', default_price: 'price_*', ... }
```

**Product list on connected account:**
```ts
const products = await stripeClient.products.list({
  limit: 100,
  active: true,
  expand: ['data.default_price'],
}, {
  stripeAccount: rancher.stripeConnectAccountId,
});
```

**Multi-line-item Checkout with direct charge:**
```ts
const session = await stripeClient.checkout.sessions.create({
  mode: 'payment',
  line_items: cart.items.map(item => ({
    price: item.stripePriceId,
    quantity: item.quantity,
  })),
  payment_intent_data: {
    application_fee_amount: Math.round(cart.totalCents * rancher.tierCommissionRate),
    metadata: { cartId: cart.id, rancherId: rancher.id, buyerId: buyer.id },
  },
  metadata: { cartId: cart.id },
  success_url: `${SITE_URL}/checkout/order/${cart.id}/success?session_id={CHECKOUT_SESSION_ID}`,
  cancel_url: `${SITE_URL}/ranchers/${rancher.slug}`,
}, {
  stripeAccount: rancher.stripeConnectAccountId,
});
```

Same pattern Stage-3 uses for the 3-tier flow — extends to N products with no architecture change.

---

## Effort summary

| Phase | Tasks | Weeks | What ships |
|-------|-------|-------|-----------|
| Stage-3 (current plan) | 24 | 4-6 wk | 3-tier hardcoded checkout + tier subscription + full onboarding |
| Phase B (after Stage-3) | 12 | 2 wk | Multi-product catalog + cart + rancher product management + order tracking |
| Phase C (after Phase B) | 7 | 1 wk | Variants + inventory + cut sheets |
| **TOTAL** | **~43 tasks** | **~7-9 weeks** | **Full Shopify-for-ranchers w/ marketing engine + tiered platform fee** |

**Subagent-driven execution can compress this** — Phase B + C tasks are mostly independent (different files), so parallelizable. Realistic compressed timeline: **5-6 weeks total** from now to full Shopify-like.

---

## What this UNLOCKS

Once Phase B+C ship, rancher experience matches Shopify-on-Stripe for D2C beef:

- Per-rancher product catalog (unlimited products vs hardcoded 3 tiers)
- Buyer multi-product cart + single checkout
- Inventory tracking
- Cut sheet customization (the killer feature for actual beef sales — no e-commerce platform does this natively)
- Rancher dashboard for orders + products + inventory
- 7% / 3% / 0% commission applied uniformly to all products (vs Shopify's 2.9% + 30¢)
- Marketing engine + lead matching (vs Shopify which gives you store + no traffic)
- Threads for pre-purchase Q&A (vs Shopify email)

This is **why** BHC beats Shopify-for-ranchers: Shopify is a storefront, BHC is a storefront + marketing engine + qualified-lead pipeline. Rancher who builds a Shopify store gets a $29/mo bill + must drive their own traffic. Rancher on BHC gets the same store + matching + verified buyers + 0% commission on Operator tier.

---

## Why we ship Stage-3 first (NOT Phase B directly)

Three reasons to ship Stage-3 (3-tier hardcoded) before Phase B (multi-product):

1. **Validation w/ real money.** 3-tier covers ~80% of current rancher revenue (Quarter/Half/Whole). Get the Stripe Connect plumbing battle-tested on a constrained surface before opening to N-product complexity.

2. **Schema lock-in.** Phase B needs to know what the Order table looks like in production. Stage-3 creates Payments + Payouts; Phase B extends to Rancher Product Orders w/ multi-line-items. Easier to extend a working schema than design both at once.

3. **Rancher feedback loop.** First 5-10 ranchers signing up to tier_v2 will tell us which products beyond the 3 tiers they actually want to sell. Phase B catalog reflects real demand, not vibes.

---

## Next session can ship Phase B as a fresh plan

When Stage-3 is shipped + canary'd, write `docs/superpowers/plans/2026-XX-XX-shopify-multi-product.md` referencing this scope doc as the spec. Same plan structure: tasks 1-12 + soak + audit + canary.

Subagent-driven execution. Same 3 docs structure (resume + game plan + plan).

Phase C follows naturally after Phase B is canary'd.

---

## TL;DR

- Shopify-for-ranchers is a **2-3 week extension** on top of Stage-3, not a from-scratch rebuild
- 80% of the plumbing (Stripe Connect, V2 accounts, direct charges, application_fee_amount, fulfillment confirm, payouts) lands in Stage-3
- Phase B adds: multi-product catalog + cart + product management UI + order tracking — ~2 weeks
- Phase C adds: variants + inventory + cut sheets — ~1 week
- Total Stage-3 → full Shopify-like w/ marketing engine: **~5-6 weeks subagent-driven**
- Beats Shopify on rancher economics (0% Operator vs 2.9% + 30¢) AND on lead supply (Shopify gives you nothing, BHC gives you qualified matched buyers)
- Cut sheets are the killer differentiator — no e-commerce platform supports the structured "50 decisions per cow" workflow

Ship Stage-3 first. Validate. Then ship Phase B + C as natural extensions.
