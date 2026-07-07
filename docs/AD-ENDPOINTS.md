# AD ENDPOINTS — every URL money can point at (2026-07-06)

The definitive manifest of ad-safe cashflow endpoints. Every row: what the
visitor lands on, what converts, what protects it, and what tracking fires.
Build campaigns from this table; anything NOT listed here is not an ad
destination.

## Prerequisite (Ben, once): the 6 Meta env vars
Pixel + CAPI are WIRED in code but dark until the Meta envs are set in Vercel
(task #99). Until then ads still convert — you just can't retarget or optimize
on the events. Set them before scaling spend.

## Tier 1 — direct product cashflow (lowest friction)

| URL | Offer | Converts via | Protection | Events |
|---|---|---|---|---|
| `/shop` | whole marketplace (10 live products $13.59–749) | ProductCard → on-domain Stripe | sellability gate: inactive / un-shippable / **sold-out auto-hide** | PageView; per-product events downstream |
| `/shop/<recId>` (PDP) | one product — THE per-product ad target | BuyButton → `/shop/checkout/<id>` | sold-out shows honest "sold out" state, **never a 404** (ad clicks never waste); OutOfStock JSON-LD | ViewContent (ProductViewTracker) |
| `/shop/checkout/<recId>` | sealed on-domain checkout | embedded Stripe (hosted fallback) | noindex; 404 on unsellable; **409 at charge-time if sold out** | InitiateCheckout (server) → Purchase (CAPI on settle) |
| Ground box `/shop/recLQdfYMnP1NxRgL` | $95–355 range, **$95 deposit** | same rail; deposit-truthful end-to-end | AggregateOffer JSON-LD; rancher confirms balance before shipping | same |

## Tier 2 — share deposits (high ticket)

| URL | Offer | Converts via | Notes |
|---|---|---|---|
| `/access` | the quiz → rancher match → deposit | Mode-0 reveal one-tap deposit | every non-deposit outcome now carries the low-ticket rail — **no wasted click** |
| `/access?state=XX` / geo pages | state-targeted quiz | same | seed the state, one less step |
| `/ranchers/<slug>` | one ranch's page + share ladder | reserve → deposit | point local ads at local ranchers |
| `/map` | discovery → ranch pages | downstream | softer intent; retarget pool builder |

## Tier 3 — affiliate (passive)

| URL | Offer | Converts via | Notes |
|---|---|---|---|
| `/gear` | 16 Amazon picks | `/go/product/<id>` click-tracked → Amazon | commission passive; needs Image URLs for ad-worthy cards |

## The flow-integrity guarantees (why ads can't break anything)
1. **Inventory**: `Orders Left` per product — blank = unlimited, decrements on
   every settled order, 0 = auto-hidden + un-chargeable on every route
   (storefront, operator links, stale URLs). Ads can never oversell a rancher.
2. **Real scarcity only**: "N left" renders only from true counts (≤10).
3. **Money truth**: deposit-style products say deposit at card, PDP, Stripe,
   receipt, rancher email, Telegram. Fixed-price products say paid/ship.
4. **Monthly human loop**: `product-stock-checkin` cron (1st of month, 16:00
   UTC) emails every rancher their listed products + orders left — confirm or
   fix in the dashboard. Env: `PRODUCT_STOCK_CHECKIN_ENABLED` (dry-run → true).
5. **No dead ends**: every funnel outcome, sold-out page, and cancel page has
   a priced next step.

## Campaign starters (per endpoint tier)
- **Cold, nationwide**: `/shop` + the 3 cheapest PDPs (snack sticks $13.59,
  jerky $25) — lowest CAC proof of purchase; buyers auto-enter the ladder-up
  engine (PRODUCT_BUYER → cross-sell cron).
- **Cold, state-targeted (supply states)**: `/access?state=XX` + that state's
  rancher pages — share deposits.
- **Retargeting** (needs Meta envs): ViewContent-but-no-Purchase → PDP;
  InitiateCheckout-abandon → checkout; PRODUCT_BUYER lookalikes → /shop.
