# BHC Rancher Commerce Platform — Research + Plan (2026-06-20)

Source: 7-agent research+architecture workflow (Barn2Door / GrazeCart / Local Line / Shopify / Square / Stripe + BHC code & schema audit). Goal: turn BHC from a marketplace listing into the rancher's whole commerce platform — their site, products, inventory, invoicing, payments — competitive enough to replace Barn2Door / a Squarespace / a Facebook page.

## Market verdict
**BHC is NOT a commerce platform today — it's a high-converting discovery+qualification funnel with a single-tier deposit bolted on.** Honest scorecard:
- **Payments ≈ 80% of a real marketplace already** (Stripe Connect V2 direct charge + application_fee, automatic_tax, multi-line Checkout half-built) — ahead of GrazeCart/Local Line on deposit plumbing.
- **Everything else is below bar:** no product catalog (3 hardcoded beef columns + a non-purchasable JSON list), no unit inventory ("inventory" = a Redis lead-throttle), the storefront is one frozen 1,026-line template, the public share cards don't even check out (they email a lead), invoicing is a custom email + Checkout link (no Stripe Invoice/PDF/dunning), no buyer subscriptions, no custom domains.

**Where BHC WINS (and incumbents structurally can't):** DISCOVERY (Barn2Door explicitly does not bring buyers; BHC's funnel does) + FEE TRANSPARENCY (Barn2Door's loudest gripes = 3.9%+$0.30 & $399–599 setup; BHC = commission, no setup fee, same-day payout).

**Strategy: do NOT out-feature Barn2Door breadth** (POS, routing, multi-location, SMS = the bloat small ranchers leave over). Win by being the **done-FOR-them premium storefront** (generated from onboarding, zero build burden) that ALSO brings buyers, on a transparent model, with the cleanest deposit→invoice loop in the category.

## Competitive matrix (gap)
| Capability | BHC today | Gap |
|---|---|---|
| Discovery / new buyers | The quiz funnel + map + matching | **none (moat)** |
| Fee transparency | commission, no setup fee, same-day payout | **none (edge)** |
| Deposits / pre-orders | direct charge + app_fee on full sale, automatic_tax | minor (near parity) |
| Storefront builder | 1 frozen template, every ranch identical | major |
| Products + variants | 3 hardcoded tiers + non-purchasable JSON list | major |
| Cart / multi-item checkout | none (cards email a lead); line_items[] half-built | major |
| Invoicing | Resend email + Checkout link, no Stripe Invoice | major |
| Inventory / stock | none (Redis lead-throttle only) | missing |
| Custom domain | none (no middleware.ts) | missing |
| Subscriptions / CSA | none buyer-facing | missing |
| Customer accounts | member session, no order history | major |

## Architecture (the forks)
- **DATA MODEL → adopt Supabase (already installed, 0 usages) as the commerce system-of-record:** `products / product_variants / inventory / orders / order_line_items / page_blocks / domains`, RLS by `rancher_id`. **Airtable stays the CRM/ops/marketing cockpit; Stripe stays money-truth.** Forced by Airtable's real limits (50k records/table, 5 req/s, no transactions → can't atomically reserve stock — the exact wall that pushed capacity to Redis). Cow-share tiers (incl. the dormant `EIGHTH_MULT`) become variant ROWS.
- **PRODUCTS → build catalog/variant engine on Supabase**, each variant a real Stripe Price. Custom products become first-class purchasable variants (so BHC finally earns commission on them, not a link-out).
- **INVENTORY → build per-variant stock on Supabase** with atomic decrement at checkout (Postgres row locks), real sold-out + JSON-LD availability. Keep the Redis lead-throttle as a SEPARATE concept.
- **PAYMENTS → do NOT rebuild** (strongest axis). Extend `createDepositCheckout`'s existing `line_items[]` to a real cart ({variant,qty}[], one app_fee across the cart, single-rancher direct charge). Refunds MUST pass `refund_application_fee:true`.
- **INVOICING → native Stripe Invoicing** on the connected account via `on_behalf_of` (central cadence — per-account settings aren't API-configurable): hosted PDF, auto reminders, Smart-Retries dunning (~38% recovery), payment plans / "use as deposit" = the exact half-cow deposit→balance pattern. Replaces the Resend-link final invoice.
- **STOREFRONT → block renderer** over `page_blocks` + a BRAND-LOCKED component registry (hero/about/gallery/pricing/testimonials/process/cta/note). Token-level theming only (logo, cover, accent-in-palette, approved Playfair/Inter) — NO raw CSS (protects the brand). Migrate today's 12 sections into default blocks. Keep ISR + JSON-LD.
- **CUSTOM DOMAIN → Vercel-for-Platforms:** free `ranch.buyhalfcow.com` (wildcard) + bring-your-own via Vercel Domains API + a new `middleware.ts` host→slug rewrite. Heaviest ops item; gate BYO to paid tier.
- **SUBSCRIPTIONS/CSA → Stripe Billing + Customer Portal** on the connected account (`application_fee_percent`). Future.

## Phased plan
- **Phase 0 — Supabase foundation (L, build-dark):** activate `@supabase/supabase-js`; create the tables + RLS + a thin `lib/commerce/*` repository; one-time ETL of cow-share columns + Custom Products JSON → variant rows (quarantine bad JSON). No user-visible change.
- **Phase 1 — catalog + cart + inventory + on-page checkout (XL):** Stripe Price per variant; extend `createDepositCheckout` to a real cart; wire public ranch-page cards to ACTUALLY check out for Connected ranchers; per-variant inventory + sold-out; dashboard catalog editor. Custom products now transact + earn commission.
- **Phase 2 — native Stripe Invoicing (M):** real Invoices for deposit→balance (payment plans), app-fee statement for ranchers.
- **Phase 3 — storefront block model (L):** replaceable site within the brand.
- **Phase 4 — custom domains (L):** middleware + free subdomain + BYO (paid-gated).
- **Phase 5 — buyer accounts + CSA subscriptions (L).**

## LOCKED decisions (Ben, 2026-06-20)
1. **Scope = FULL platform** — replace their website. All 6 phases. ✅
2. **Supabase = YES** — commerce system-of-record (catalog/inventory/orders/blocks/domains); Airtable stays CRM/ops; Stripe stays money. ✅
3. **Commission on EVERYTHING sold on-platform** — custom products + the invoiced balance carry the rancher's commission, not just the cow-share deposit. ✅ (Commission rate stays the existing tier model: Legacy Connect 10% / Pasture 7% / Ranch 3% / Operator 0% — "10%" = the Legacy/default tier. Ben can revisit the public-promise number later.)
4. **Custom domains = free `ranch.buyhalfcow.com` subdomain for all + bring-your-own (`renickranch.com`) gated to paid/Operator tier**, self-serve with guided DNS. ✅
5. **Tier-gating (default, Ben can override):** cart + native invoicing = all Connected (tier_v2) ranchers; CSA subscriptions + BYO-custom-domain = paid/Operator tier. Legacy Payment-Link ranchers get NONE of the Connect-only features → reinforces the v2 migration push.
6. **Don't-build (confirmed default):** skip POS, delivery routing, multi-location, SMS — the bloat small ranchers flee Barn2Door over.

## Status
- Plan APPROVED 2026-06-20. **Phase 0 in progress (build-dark).**
- Supabase: SDK installed (`@supabase/supabase-js` ^2.91.1), but NO project/env/code yet.
- **OWNER ACTION (gates Phase 0 run + all downstream):** create a Supabase project → set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` in Vercel → then we run the migration + ETL.

## Top risks
Stripe preview-API pin (`2025-09-30.preview`); Airtable scale cliff (forces the Supabase move); overselling without transactions (Postgres row locks mandatory); brand drift from "customizable sites" (mitigate = blocks+tokens, never raw CSS); custom-domain DNS support load on a non-technical ICP; two-class platform until v2 migration completes; refund commission leakage (`refund_application_fee:true` everywhere).
