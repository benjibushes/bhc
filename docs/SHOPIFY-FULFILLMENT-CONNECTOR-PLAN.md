# Shopify Fulfillment Connector — build plan (2026-07-21)

Status: APPROVED by Ben 2026-07-21 (all §7 recommendations accepted; business
model locked: BHC brings customers + charges margin upfront on the existing
direct-charge rail; distributor fulfills; per-operation choice of full store
sync OR manual SKU entry). **Execution-grade task-level plan with complete
code lives at `docs/plans/2026-07-21-shopify-fulfillment-connector.md` —
build from THAT document.** This file remains the concept/architecture
overview.

## 1. Concept

BHC owns demand + payment (existing product rail: BHC checkout, Stripe Connect
direct charge to rancher). At settlement, BHC injects a **pre-paid order into
the rancher's own Shopify store** so their existing SKU/inventory/shipping
stack fulfills it. Their store never touches money; BHC never touches
logistics. Built as an adapter (`FulfillmentConnector`) so Shopify is
implementation #1, not a hard dependency.

**Vehicle = the PRODUCT rail** (Rancher Products / Rancher Orders). The
referral rail (quarter/half/whole) is one-deal-per-record butcher-date
fulfillment — no SKU/address/quantity to map; explicitly deferred.

## 2. Verified platform facts (Shopify docs, 2026-07)

- `orderCreate` (GraphQL Admin) with `financialStatus: PAID` creates a paid
  order with real line items — requires `write_orders` scope + offline token.
  A merchant-created **custom-app Admin token (`shpat_`)** satisfies this; no
  public app / app review needed for v1.
- `options.inventoryBehaviour: DECREMENT_OBEYING_POLICY` burns their stock
  (default is BYPASS — must set explicitly).
- `options.sendReceipt` / `sendFulfillmentReceipt` control Shopify's buyer
  emails (default false) — prevents double receipts.
- Shopify auto-creates FulfillmentOrders on order creation → merchant's
  normal pick/pack/3PL flow runs.
- Tracking back: webhook topics `FULFILLMENTS_CREATE` / `FULFILLMENTS_UPDATE`
  (HMAC `X-Shopify-Hmac-Sha256` verification).
- SKU→variant resolution: `productVariants(first:1, query:"sku:<sku>")`.
- Rate limit note: 5 orders/min applies to trial/dev stores only.

## 3. Repo hook points (verified by investigation, file:line)

- Settlement: `settleProductPurchase` `lib/productSettlement.ts:52`, dispatched
  from Connect webhook `app/api/webhooks/stripe-connect/route.ts:440-478`.
  Side effects are inline best-effort try/catch blocks after row creation
  (:194-:407) — push block attaches there.
- Retry pattern (repo canon, no queue exists): inline best-effort + net cron
  sweep. Clone `app/api/cron/product-settlement-net/route.ts`.
- Refund: `reconcileProductOrderRefund` `lib/productSettlement.ts:447` —
  cancel leg goes here. Partial-refund branch (:472) leaves order LIVE — must
  NOT cancel externally. Status==='Refunded' early-return (:465) = idempotency.
- Mark-shipped (to be superseded for connected orders):
  `app/api/rancher/orders/route.ts:100`; SLA cron
  `lib/productFulfillmentSla.ts` + `app/api/cron/product-fulfillment-sla`.
- Per-rancher structured config precedent: JSON-in-multiline-text
  (`Push Subscriptions` — `lib/rancherPush.ts:34`; `Gallery Photos`).
- Deposit/pickup markers live ONLY as `Order Ref` string prefixes
  (`orderKind` `lib/productFulfillmentSla.ts:35`) — push gates must reuse that
  helper, not re-parse.
- **No encryption helpers exist in repo**; `lib/secrets.ts` is env-only.
  Airtable base is shared with ~/bhc-prospects-dashboard → per-rancher tokens
  MUST be encrypted at rest (new AES-GCM helper + `INTEGRATION_TOKEN_KEY` env).

## 4. Flow

```
Buyer pays (BHC checkout, direct charge — rancher paid instantly)
→ settleProductPurchase (idempotent, existing)
  → push gates: rancher integration configured + product has External SKU
    + not deposit-style + not pickup
  → Shopify orderCreate: PAID, line item by SKU, ship-to, tags ['BHC'],
    note = BHC Order Ref, sendReceipt:false, inventory decremented
  → stamp Rancher Orders: External Order Id / Push Status / Pushed At
→ rancher's store fulfills like any order
→ FULFILLMENTS_CREATE webhook → BHC stamps Tracking Number + Shipped At +
  Status 'Shipped' (existing product_shipped email + SLA stop, free)
Refund (full) on BHC → connector cancels Shopify order. Partial → leave live.
```

## 5. Build order — 4 PRs

**PR-A — connector core (pure, unwired).**
`lib/integrationCrypto.ts` (AES-GCM, `INTEGRATION_TOKEN_KEY`),
`lib/fulfillmentConnector.ts` (interface: pushOrder/cancelOrder/validateConfig),
`lib/shopifyConnector.ts` (orderCreate push, SKU resolve, cancel, validate,
permanent-vs-transient error taxonomy), tests.
Airtable fields to CREATE FIRST (rule 1): Ranchers `Fulfillment Integration`
(multilineText JSON: {provider, shop, encToken, locationId?}); Rancher
Products `External SKU` (text); Rancher Orders `External Order Id`,
`External Push Status`, `External Pushed At`.

**PR-B — push wiring.**
Side-effect block at end of `settleProductPurchase` (fire-and-forget, keyed on
Stripe PI id — Redis claimOnce fails open, so dedupe on stamped
`External Order Id` too), `shopify-push-net` sweep cron (paid + integration +
unpushed → retry), cancel leg in `reconcileProductOrderRefund` (full refund
only).

**PR-C — reverse leg.**
`app/api/webhooks/shopify/route.ts` (per-rancher HMAC secret, verify like
`lib/svixVerify` pattern), FULFILLMENTS_CREATE/UPDATE → idempotent tracking/
shipped stamps. Webhook subscriptions auto-registered at connect time.
Fallback poll inside the net cron.

**PR-D — onboarding + proof.**
Telegram `/connectstore` (or admin UI): shop domain + token → live
validateConfig (shop query, scope check, SKU dry-run match report) → encrypt +
store → register webhooks. Extend `lib/paymentPathSmoke` (PR #419) with a
Shopify auth+SKU gate for connected ranchers.

**Pilot: merch.buyhalfcow.com (Ben's own Shopify store)** — full end-to-end
incl. a real refund-cancel before any rancher store is touched.

## 6. Landmines (addressed in design)

1. Refund → live external order (cancel leg; partial-refund exemption).
2. Double-push on webhook redelivery / Redis-open claims (PI-id keying +
   stamp check in cron).
3. SLA cron nagging ranchers whose store shipped (reverse leg).
4. Deposit-style/pickup must never push (shared orderKind gate).
5. Rancher's Shopify analytics show revenue not collected there — disclose;
   'BHC' tag makes it filterable.
6. Plaintext tokens in shared Airtable base — forbidden; AES-GCM at rest.

## 7. Ben decisions pending

1. Shipment email owner: Shopify (`sendFulfillmentReceipt:true`, BHC
   suppresses product_shipped for connected orders — RECOMMENDED) vs BHC-only.
2. v1 auth = per-store custom-app token (RECOMMENDED, 5-min merchant setup) vs
   public OAuth app (only if dozens of stores; layerable later, no rework).
3. Pilot rancher after merch-store proof.

## 8. ONE-CLICK MILESTONE (researched + approved direction, 2026-07-21 PM)

Ben requirement: connection must be click-button, no merchant API steps.
Verified against current Shopify docs (docs/apps/launch/distribution):

**Custom-distribution apps (Partner Dashboard) = click-button TODAY, no
App Store review.** Ben generates an install link per distributor (app is
single-store; multi-store only within one Plus org); merchant clicks →
Shopify consent screen → installed. OAuth authorization-code grant (non-
embedded) → BHC callback exchanges code for the OFFLINE token automatically.

### Phase 1 (next build, ~1 PR): OAuth rail
- `GET /api/shopify/oauth/install?d=<distributorAppId>` → 302 to
  `https://{shop}/admin/oauth/authorize?client_id&scope=write_orders,read_orders,read_products&redirect_uri&state`
  (state = signed JWT pinning distributorAppId + nonce).
- `GET /api/shopify/oauth/callback` → verify HMAC + state → POST
  `/admin/oauth/access_token` (client_id, client_secret, code) → encrypt
  token → write Fulfillment Integration (webhook HMAC secret = the app's
  client secret) → register webhooks → sync dry-run → success page.
- Small admin surface: Ben pastes per-app client_id/client_secret + shop
  domain (from Partner Dashboard, ~3 min/distributor) → BHC returns the
  install link to send. Per-app creds stored encrypted (Admin Config or a
  small table).
- Token-paste card (PR-F) stays as fallback door.

### Phase 2 (at 2-3 live distributors): public "BuyHalfCow" app
Same routes, ONE client_id forever, universal install link, Ben per-
distributor steps → zero. Adds: Shopify App Store review (~1-2 wks) + the 3
mandatory compliance webhooks (customers/data_request, customers/redact,
shop/redact — small build). "Must sync certain data with Shopify" per
public-distribution requirements — review at build time.

### Phase 3: packaging, not plumbing
Money rail unchanged (Standard Connect + direct charges — proven live).
One "Get connected" surface: [Connect your bank] (Stripe hosted onboarding
link) + [Connect your store] (install link) with status checks. Distributor
total: two clicks + Stripe's one bank form.

Pilot note: run the merch-store pilot THROUGH Phase 1's flow as its first
real install (pilot rancher rec4pnnjfp2nTaS1V, shop 3gapis-dx.myshopify.com).

