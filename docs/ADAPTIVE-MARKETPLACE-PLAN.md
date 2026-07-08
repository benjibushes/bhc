# Adaptive, Localized Marketplace — Build Plan

> **For the executing agent:** ship phase by phase, each its own gauntlet-green PR
> (tsc · full test suite · boundaries · real `next build`). Reuse the money-path
> and geo pieces that already exist — this is wiring, not reinvention.

**Goal:** the marketplace adapts to the buyer's location. It leads with what they
can get **immediately** (farm pickup / local delivery from ranches near them),
then what **ships to their door** nationwide, then the share ladder. No location →
the nationwide view everyone gets today, plus a prompt to localize.

**Why it's the moat:** "raised 40 miles from you, pick it up Saturday" is the one
thing Amazon and ButcherBox structurally cannot offer. Local fulfillment also =
$0 shipping + higher rancher margin + stronger trust. The data model is already
there — ranchers just can't surface it yet.

---

## The mental model (this is what "adaptive" means)

Every product, **seen through a buyer's location**, has a fulfillment profile:

| Option | Available when | What the buyer sees |
|---|---|---|
| 🚜 **Pickup** | rancher offers Local Pickup **and** buyer is local to them | "pick up at {city} — free" |
| �following **Local delivery** | rancher offers Local Delivery **and** buyer is in range | "local delivery — {city} area" |
| 📦 **Ships** | product `Ships Nationwide` (cold-chain) | "ships to your door — included" |

The marketplace renders **sectioned by proximity**:

1. **"Right near you"** — everything pickup/delivery-able to *this* buyer + any local
   share. The immediate stuff. Best trust, best margin, $0 shipping. Floats to top.
2. **"Shipped to your door"** — nationwide products. Always available, everywhere.
3. **The share ladder** — "go all in on a share" (a deposit rancher serving their state).

**No location known** → section 2 only (today's behavior) + a `📍 enter your zip to
see what's near you` prompt. Location known → section 1 floats up.

---

## Data — what exists vs. what's needed

**Already there (ranchers control these on the landing-page editor):**
- `Fulfillment Types` (multi-select: Local Pickup / Local Delivery / Cold-Chain Shipping)
- `Pickup City`, `Delivery Radius Miles`, `Shipping Lead Time Days`
- Rancher `State`, geocoded lat/lng (Nominatim on self-submit)
- Product `Ships Nationwide`, `Ships In Days` (Phase 12)

**Needed:** join the rancher's fulfillment data onto each product at load time
(single source of truth — do NOT denormalize onto product rows), plus buyer
location capture + a pure classifier.

---

## Phase A — the adaptive core (pure lib, TDD)

**Files:** `lib/marketplaceLocality.ts` (new), `lib/marketplaceLocality.test.ts` (new)

- [ ] `resolveBuyerLocation(input) → { state, lat?, lng? } | null` — normalize a
  buyer signal (explicit zip, `?state=`, geo lat/lng, or cookie) into a canonical
  location. `normalizeState` already exists; zip→state/latlng reuses the geocode
  helper the self-submit route uses.
- [ ] `classifyFulfillment(prod, buyerLoc) → { pickup, delivery, ship, isLocal, sameState, distanceMi? }`.
  Pure. `prod` carries the joined rancher fields (state, fulfillmentTypes,
  pickupCity, deliveryRadius, lat/lng). **v1 = state-level:** `isLocal = sameState`
  (buyer state === rancher state) AND the rancher offers pickup or delivery. `ship`
  = product `Ships Nationwide`. `pickup`/`delivery` gate on `isLocal` + the
  rancher's fulfillment types. (v2 note: swap `sameState` for haversine `distanceMi`
  vs `Delivery Radius Miles` once we want metro-precision — the field's already there.)
- [ ] `sectionMarketplace(products, buyerLoc) → { nearYou, shipsToYou, shares }`.
  nearYou = products where `classify().isLocal && (pickup||delivery)`. shipsToYou =
  products where `ship`. A product can appear in BOTH (local buyer can pick up OR
  ship) — dedupe by putting it in nearYou only when local. shares = the share-anchor
  block, flagged `localShare` if a deposit rancher serves buyerLoc.state.
- [ ] Tests: no-location → everything in shipsToYou, nearYou empty; in-state buyer +
  pickup rancher → product in nearYou with `pickup:true`; ship-only product never in
  nearYou; out-of-state buyer → shipsToYou only; the sellability + stock gates still
  apply (compose, don't duplicate `isSellableRow`).

## Phase B — location capture + persistence

**Files:** `app/shop/LocationBar.tsx` (new, client), `lib/buyerLocationCookie.ts` (new), `app/shop/page.tsx`

- [ ] `LocationBar` at the top of `/shop`: a zip input + a "📍 use my location" button
  (browser geolocation, offered not forced — privacy-first). On set, POST to a tiny
  route that writes a `bhc-loc` cookie (`{state,lat,lng}`, ~90d) and refreshes.
- [ ] Read order on the server: `?state=` param (ad/geo-landing passthrough) → `bhc-loc`
  cookie → none. Never IP-geolocate silently (privacy + accuracy). `loadMarketplaceProducts`
  gains the rancher-fulfillment join so the section fn has what it needs.
- [ ] Persisted so a returning buyer keeps their local view; changeable anytime.

## Phase C — adaptive /shop rendering

**File:** `app/shop/page.tsx`, `app/components/ProductCard.tsx`

- [ ] Shop becomes location-aware: render **"right near you — {state}"** section first
  (only when nearYou non-empty), then **"shipped to your door,"** then the share anchor.
  No location → shipsToYou only + the LocationBar prompt copy.
- [ ] ProductCard grows fulfillment badges from the classifier: `pickup · {city}` /
  `local delivery` / `ships free`. Real options only — a card in "near you" shows its
  pickup/delivery affordance; a card in "ships" shows the ship line it shows today.
- [ ] Category quick-nav stays, but scoped within each proximity section.

## Phase D — PDP fulfillment choice + checkout thread

**Files:** `app/shop/[id]/page.tsx`, `app/shop/checkout/[id]/*`, `lib/productCheckout.ts`, `lib/productSettlement.ts`

- [ ] PDP shows the buyer's **available fulfillment options** (from the classifier) as a
  choice: `pick up at {city} · free` / `local delivery` / `ship to me`. Default = ship
  (always valid); local options appear only when the buyer is local.
- [ ] The choice rides the checkout: `createProductCheckout` takes a `fulfillment`
  ('pickup'|'delivery'|'ship'); **pickup/delivery skip `shipping_address_collection`**
  (no address needed for pickup). Metadata carries it.
- [ ] Settlement branches on it (like deposit-style did): the rancher email says
  **"PICKUP at {city} — {buyer} will collect"** or **"LOCAL DELIVERY to {area}"** or the
  existing ship-to block. The order Ref + Telegram signal carry the mode. **Money
  mechanics unchanged** — same Display Price, same `application_fee`; pickup just means
  the rancher keeps the shipping cost they didn't spend (more margin) and collects no
  address. (Decision D2 below: flat price v1.)

## Phase E — state SEO pages (compounding traffic, bonus)

**Files:** `app/shop/[state]/page.tsx` (new, or `app/beef/[state]`)

- [ ] Programmatic per-state pages: "grass-fed beef in Texas — ranches near you." Same
  adaptive sections pre-seeded to that state, `generateStaticParams` over the 50 states,
  Product + LocalBusiness JSON-LD, internal-linked from `/shop`. Free organic traffic on
  real search volume ("grass fed beef {state}"), compounds forever.

---

## Locked decisions (defaults; flip before build if you disagree)

- **D1 — proximity granularity:** v1 = **state-level** (`buyer state === rancher state`
  = local). Reliable, no per-render geocode, ~80% of the value. v2 = haversine mileage vs
  `Delivery Radius Miles` for metro precision (field already exists).
- **D2 — pickup pricing:** v1 = **same Display Price** for pickup/delivery/ship. Simplest,
  protects margin, honest ("skip shipping, same price"); the rancher keeps the shipping
  cost they saved. A per-product pickup price can come later.
- **D3 — location capture:** explicit zip + offered geolocation + `?state=` passthrough,
  cookie-persisted. **Never** silent IP-geo (privacy + accuracy).
- **D4 — default state (no location):** nationwide view (today's behavior) + a localize
  prompt. Never an empty or broken page.

## What this reuses (not reinventing)

geocode helper (self-submit route) · `normalizeState` (lib/states) · rancher
fulfillment fields (landing-page editor) · `isSellableRow`/`hasStock` (compose) ·
`createProductCheckout` + settlement branching (deposit-style is the pattern) ·
`ProductCard`/`PriceTag`/`TrustStrip` · the geolocation UX already on `/map`.
