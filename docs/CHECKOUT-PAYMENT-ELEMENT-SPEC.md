# Brand-Owned Checkout: Payment Element Migration Spec

> Produced by the checkout-perfection workflow 2026-07-07 (3 recon agents + adversarial verify).
> Status: SPEC — PRs A-D below not yet built. Quick wins + gate fixes shipped in #316; embedded deposit shipped in #315.

# STRIPE RE-ARCHITECTURE MAP — Product rail: Embedded Checkout iframe → on-domain Payment Element

Repo: `/Users/benji.bushes/BHC/untitled folder/bhc`. Read-only audit + implementation spec. Money model stays byte-identical: direct charge on the rancher's Connect account, `application_fee_amount = (display − base) × qty`, shipping 100% passthrough, settlement untouched.

---

## 0. Verified ground truth (what the code actually does today)

**Mint path** — `app/api/checkout/product/buy/route.ts` (public, rate-limited 12/min/IP) → `createProductCheckout()` in `lib/productCheckout.ts`: `stripe.checkout.sessions.create({ ui_mode:'embedded', expires_at: now+30min, shipping_address_collection:{US}, shipping_options (flat rate when shippingCents>0), line_items (real Stripe Price via ensureStripePrice, else inline price_data), payment_intent_data:{ application_fee_amount, metadata:{13 keys} } }, { stripeAccount })`. Client `app/shop/checkout/[id]/CheckoutMount.tsx` mounts `<EmbeddedCheckout>` with `loadStripe(pk, { stripeAccount })`; hosted redirect fallback when `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` absent; demo mode returns fake secrets with no Stripe call.

**Metadata keys stamped on the PI today** (`lib/productCheckout.ts:228-246`): `type='product_purchase'`, `productId`, `productName`, `rancherId`, `rancherName`, `buyerEmail` (blank self-serve), `buyerName` (blank), `displayCents`, `baseCents`, `marginCents`, `shippingCents`, `quantity`, `depositStyle`.

**Settlement** — `lib/productSettlement.ts::settleProductPurchase(pi, connectedAccountId?)` reads **only** `pi.metadata.*`, `pi.shipping`, `pi.charges.data[0]` (charges-less on modern payloads), `pi.receipt_email`, `pi.latest_charge`, `pi.id`. Money fields come from metadata, never from `pi.amount` (`paidCents = displayCents×qty + shippingCents`, line 79). Ship-to: `formatShipping()` line 38 = `pi.charges.data[0].shipping || pi.shipping`. Email chain lines 59-63: `metadata.buyerEmail → charge0.billing_details.email → pi.receipt_email`. Name chain line 65-68: `metadata.buyerName → pi.shipping.name → charge0.shipping.name → charge0.billing_details.name`. `latest_charge` recovery block lines 130-144 fetches the charge **only when `connectedAccountId` is passed**.

**Webhook** — `app/api/webhooks/stripe-connect/route.ts:440-459`: `payment_intent.succeeded` + `metadata.type==='product_purchase'` → `settleProductPurchase(pi)`; 5xx on transient, 200 on `PermanentSettlementError`. Direct-charge PIs deliver here regardless of how the PI was minted (session or raw) — routing is purely `metadata.type`.

**🔴 LIVE DEFECT FOUND (pre-existing, fix in this migration):** line 449 calls `settleProductPurchase(pi)` **without the second argument**, so the `latest_charge` recovery for blank ship-to/email is **dead code in production**. `accountId` is already computed at line 175 (`event.account` for V1 events). One-line fix: `settleProductPurchase(pi, accountId)`. Today's self-serve embedded buys likely settle with blank ship-to (rancher gets "(see BuyHalfCow order)" + the NO SHIP-TO operator alarm) whenever the charges-less payload path is hit.

**ZERO-settlement-change claim: VERIFIED, with two conditions.** A raw PI minted with the same 13 metadata keys settles identically **provided**: (1) shipping lands on `pi.shipping` — the Payment Element + AddressElement(mode:'shipping') flow attaches the collected address to the PaymentIntent at confirm, and `pi.shipping` is a top-level PI field present in the webhook payload (unlike charges), so `formatShipping()` fallback #2 hits — this is *more* reliable than today's Checkout path, which the file's own audit comment (line 36-38) flags as flaky; (2) email lands on `metadata.buyerEmail` — we collect it ourselves and stamp it at mint, hitting fallback #1 (today's self-serve blanks it and depends on the dead charge-fetch). buyerName resolves via `pi.shipping.name` (fallback #2). Refund path `reconcileProductOrderRefund` keys on PI id only — unaffected.

**Deposit rail contrast** (`lib/stripeConnect.ts::createDepositCheckout`, client `app/checkout/[refId]/deposit/DepositCheckoutMount.tsx`): hosted + embedded Checkout Session, commission on FULL sale price, referral-keyed settlement, session-gated. **Untouched by this migration.** The share-deposit qualification gate lives upstream (buyer session + referral required at `/api/checkout/deposit`) — nothing here changes that; the Payment Element work is scoped to `/shop` only.

**Stripe client** — `lib/stripeConnect.ts::getStripeClient()`: pinned `apiVersion: '2025-09-30.preview'` (required for V2 Connect accounts). v1 `paymentIntents.create` is stable under this header — same client already mints sessions, so no new version exposure. SDK: `stripe@^20.4.1`, `@stripe/stripe-js@^9.9.0`, `@stripe/react-stripe-js@^6.7.0` (all support deferred-intent Elements).

---

## 1. Architecture decision: DEFERRED INTENT CREATION (mint at pay-click, not page load)

Initialize Elements with `{ mode:'payment', amount, currency:'usd' }` and **no PI**. On pay-click: `elements.submit()` → `POST /api/checkout/product/intent` (server re-runs every gate + mints the PI) → `stripe.confirmPayment({ elements, clientSecret })`.

This single choice answers three of the hard questions at once:

- **(7) 30-min-expiry equivalent:** the stock/Active/Ships-Nationwide/rancher-active gates run **at confirm time** — the strongest possible version of the "confirm-guard". No long-lived payable object exists before the click, so the oversell window collapses from 30 minutes to the ~2s between mint and confirm. The existing settle-time OVERSOLD alarm (`productSettlement.ts:293-303`) stays as the backstop for that residual race.
- **(5) Abandoned-PI hygiene:** page-load abandons mint **nothing**. Only declined-then-abandoned attempts leave a `requires_payment_method` PI — no funds held, no stock reserved, harmless. No reaper extension needed (`orphan-checkout-reaper` stays deposit-Payments-only). Stamp `metadata.mintedAt` for future forensics. No update-on-qty problem: qty is fixed in the URL before the checkout page loads (picker is on the PDP).
- **Idempotency:** client generates one `attemptId` (uuid) per checkout page mount → PI create uses `idempotencyKey: product-pi-${attemptId}`. Double-click can't double-mint. On decline, client **reuses the cached clientSecret** (re-confirm same PI) instead of re-POSTing.

---

## 2. Exact file structure

**NEW**
| File | Purpose |
|---|---|
| `lib/productPaymentIntent.ts` | `createProductPaymentIntent(input)` — server mint. Reuses `computeProductCharge()` verbatim. Mirrors `createProductCheckout`'s demo guard + metadata block. |
| `app/api/checkout/product/intent/route.ts` | Public POST. Rate limit, all buy-route gates, mint, CAPI. |
| `lib/productBuyGates.ts` | Extracted shared gate helper (see §3) so buy + intent routes can never drift. |
| `lib/stripeAppearance.ts` | Exported `appearance` + `fonts` (shared later with a deposit-rail Element migration). |
| `app/shop/checkout/[id]/PaymentForm.tsx` | Client form: email input + AddressElement + PaymentElement + pay button + confirm flow. |
| `lib/applePayDomain.ts` | `ensurePaymentMethodDomain(acct)` — per-connected-account wallet domain registration. |
| `public/.well-known/apple-developer-merchantid-domain-association` | Stripe's Apple Pay domain file (static, served by Vercel). |

**MODIFIED**
| File | Change |
|---|---|
| `app/api/webhooks/stripe-connect/route.ts` | Line 449: `settleProductPurchase(pi, accountId)` — resurrects the latest_charge recovery. |
| `app/shop/checkout/[id]/CheckoutMount.tsx` | Embedded-checkout branch → `<Elements>` + `PaymentForm`; hosted fallback + demo + skeleton + error states preserved verbatim. Env-flag switch for rollback (§7). |
| `app/shop/checkout/[id]/page.tsx` | Pass `connectAccountId`, `amountCents` (server-computed via `computeProductCharge`), `productName` to CheckoutMount; optionally move the InitiateCheckout CAPI fire here (§5). |
| `app/order/success/page.tsx` | Read `searchParams.redirect_status`: `'failed'` → honest retry state (link back to `/shop/checkout/[id]?qty=`; needs `pid` in return_url). All other cases render today's copy. |
| `app/api/checkout/product/buy/route.ts` | Refactor onto `lib/productBuyGates.ts`; hosted branch unchanged; embedded branch kept until flag removal. |

**UNCHANGED (by contract):** `lib/productSettlement.ts` (zero edits — the whole point), `lib/productCheckout.ts` (hosted fallback + operator links still use it), `lib/stripeConnect.ts`, deposit rail, `app/api/checkout/product` (admin/operator links), orphan-checkout-reaper, refund reconcile.

---

## 3. Route contract — `POST /api/checkout/product/intent`

**Request** `{ productId: string, quantity?: number, email?: string, attemptId: string, expectedTotalCents?: number }`
Client-supplied money is NEVER trusted; `expectedTotalCents` is only an equality check against the server-computed total (drift → 409 `price_changed`, client shows "price updated — refresh"). `connectAccountId` is NOT accepted from the client — re-derived from the product row.

**Gates, in order (all in `lib/productBuyGates.ts`, byte-parity with today's buy route):** rate limit `product-intent:${ip}` 12/min → `rec[A-Za-z0-9]{14}` id regex → product `Active` → `Ships Nationwide !== false` → `hasStock` → qty clamp 1–5 (deposit-style forced 1) + `Orders Left >= qty` → rancher `Stripe Connect Status === 'active'` + acct id present → `displayCents>0, baseCents>0, base<=display` (also re-thrown by `computeProductCharge`). Deposit-style forces `shippingCents=0`.

**Mint:**
```ts
stripe.paymentIntents.create({
  amount: charge.totalChargedCents,              // display×qty + shipping
  currency: 'usd',
  application_fee_amount: charge.applicationFeeCents,  // (display−base)×qty — shipping never skimmed
  automatic_payment_methods: { enabled: true },
  description: `${qty>1?`${qty}× `:''}${productName} — ${rancherName}`,
  shipping: undefined,                            // confirmPayment + AddressElement attaches it
  // receipt_email deliberately OMITTED — see risk R9
  metadata: {
    type: 'product_purchase', productId, productName, rancherId, rancherName,
    buyerEmail: email?.trim().toLowerCase() || '',   // ← now populated for self-serve (upgrade vs today)
    buyerName: '',
    displayCents: String(displayCents), baseCents: String(baseCents),
    marginCents: String(charge.applicationFeeCents),
    shippingCents: String(charge.shippingCents), quantity: String(charge.quantity),
    depositStyle: depositStyle ? 'true' : 'false',
    mintedAt: new Date().toISOString(),           // additive; settlement ignores unknown keys
  },
}, { stripeAccount: connectAccountId, idempotencyKey: `product-pi-${attemptId}` })
```
`ensureStripePrice` is **skipped** (raw PIs have no line items; `description` carries the label). Tradeoff: rancher's Stripe dashboard loses the Product-object linkage on Element sales — note for Ben, not a money change.

**Responses:** `200 { clientSecret, totalCents }` · `400` invalid · `404` unavailable/not-nationwide · `409` sold-out / qty>left / ranch-not-active / price_changed · `429` rate · `502` Stripe failure. Demo mode: `200 { demoUrl: '/checkout/DEMO/product' }` (client redirects, no Stripe call). Fire-and-forget `ensurePaymentMethodDomain(acct)` after mint.

**Client confirm flow (`PaymentForm.tsx`):** `elements.submit()` → POST intent → `stripe.confirmPayment({ elements, clientSecret, confirmParams: { return_url: `${SITE}/order/success?pid=${productId}` }, redirect: 'if_required' })` → success: `router.push('/order/success')`; error: inline message in `weathered` red, cached clientSecret reused on retry.

---

## 4. Appearance API — real brand values (from `app/globals.css` + `Card.tsx`)

Tokens confirmed: bone `#F4F1EC`, bone-warm `#ECE8E0`, bone-deep `#E5E2DC`, charcoal `#0E0E0E`, saddle `#6B4F3F`, dust `#A7A29A`, weathered `#8C2F2F`, sage `#4F7A3F`. Fonts: Inter (sans, `--font-inter`), Playfair (serif headings — headings stay OUR DOM, Elements never renders headings). Surfaces are square-bordered (`border border-dust`, no radius; only the skeleton uses `rounded-[3px]`). Focus ring: `2px solid` charcoal (globals.css:78).

```ts
// lib/stripeAppearance.ts
export const bhcFonts = [{ cssSrc: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap' }];
export const bhcAppearance = {
  theme: 'stripe' as const,
  variables: {
    colorPrimary: '#0E0E0E', colorBackground: '#FFFFFF', colorText: '#0E0E0E',
    colorTextSecondary: '#6B4F3F', colorTextPlaceholder: '#A7A29A', colorDanger: '#8C2F2F',
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSizeBase: '15px', borderRadius: '0px', spacingUnit: '4px',
    focusOutline: '2px solid #0E0E0E', focusBoxShadow: 'none',
  },
  rules: {
    '.Input': { border: '1px solid #A7A29A', boxShadow: 'none' },
    '.Input:focus': { border: '1px solid #0E0E0E', boxShadow: 'none' },
    '.Input--invalid': { border: '1px solid #8C2F2F', boxShadow: 'none' },
    '.Label': { color: '#6B4F3F', fontSize: '13px', textTransform: 'lowercase' as const },
    '.Error': { color: '#8C2F2F', fontSize: '13px' },
    '.Tab': { border: '1px solid #A7A29A', boxShadow: 'none' },
    '.Tab--selected': { border: '1px solid #0E0E0E', backgroundColor: '#ECE8E0' },
    '.Block': { border: '1px solid #A7A29A', boxShadow: 'none' },
  },
};
```
Elements options: `{ mode:'payment', amount, currency:'usd', appearance: bhcAppearance, fonts: bhcFonts }`. PaymentElement options: `{ layout: { type: 'accordion', radios: true }, wallets: { applePay: 'auto', googlePay: 'auto' } }` — accordion reads editorial, not SaaS-tabs. AddressElement: `{ mode: 'shipping', allowedCountries: ['US'] }` (deposit-style products still collect it — parity with today's session, and settlement stores it as "ship to once confirmed"). Google-fonts cssSrc loads inside Stripe's iframe, not our page — no CSP interaction.

**(3) Email capture:** OWN brand-styled input (lowercase label "email — for your receipt + tracking"), not LinkAuthenticationElement — full brand control, no Stripe-branded "pay faster with Link" banner at the top of a premium checkout (founder bar). Value → intent POST → `metadata.buyerEmail` → settlement fallback #1. Link still appears as a method inside PaymentElement if the connected account has it enabled; acceptable. If Ben later wants Link one-tap, swap the input for LinkAuthenticationElement — settlement is covered either way once the webhook accountId fix lands (billing_details.email via latest_charge).

Page composition stays: `page.tsx` branded order summary Card → deposit-style disclosure line → PaymentForm (white Card, `bg-white border border-dust p-5`) → TrustStrip. The visible seams of the iframe die; the page finally reads as one surface.

---

## 5. Meta CAPI

Move the server-side `InitiateCheckout` fire from the buy route into **`page.tsx`** (server component; `headers()`/`cookies()` give ip/ua/fbp/fbc) with `event_id: product_ic_${randomUUID()}` — this keeps today's exact timing (fires at checkout-page land, when the session mint happens now), instead of the semantically-late pay-click. Today's session-keyed event_id has no browser-pixel dedupe pairing anyway, so uuid is equivalent. Purchase CAPI is settlement-side — untouched.

---

## 6. Wallets on DIRECT charges — the real constraints

- **Platform-level Apple Pay registration is NOT enough.** For direct charges the connected account is the merchant of record; the payment-method domain must exist **per connected account**. Register on their behalf: `stripe.paymentMethodDomains.create({ domain_name: 'www.buyhalfcow.com' }, { stripeAccount: acct })` — plus apex `buyhalfcow.com`. Requires Stripe's association file served at `/.well-known/apple-developer-merchantid-domain-association` (one shared file covers all accounts; add to `public/`).
- **Call sites:** lazily fire-and-forget at intent mint + at Connect-activation in the webhook; cache a `Apple Pay Domain Registered` flag on the Ranchers row to avoid re-calls (mirror the `ensureStripePrice` mint-on-first-sell pattern).
- **Graceful degradation is automatic and silent:** unvalidated domain → PaymentElement simply doesn't render Apple Pay; Google Pay + Link + card unaffected (Google Pay needs no file validation). Checkout never breaks — worst case is card-only, exactly today's baseline.
- Note: today's *hosted* fallback needed none of this (checkout.stripe.com is Stripe's domain) — so the hosted path remains the wallet-guaranteed rail during rollout. Ben's existing go-live checklist already includes Apple Pay domain work (memory: #275 gates).

---

## 7. What stays (verified against current code)

- **Hosted fallback:** no `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` → CheckoutMount POSTs `mode:'hosted'` to `/api/checkout/product/buy` and redirects — byte-identical path, untouched.
- **Demo mode:** `isDemoMode()` short-circuits in both mint helpers; intent route returns `demoUrl` and the client redirects — no Stripe call, prod byte-identical when off.
- **Rate limit:** same `rateLimit()` helper, same 12/min/IP budget, new key namespace.
- **Stock gates:** all seven buy-route gates, now shared via `lib/productBuyGates.ts` and executed at pay-click (stronger than today).
- **Operator links** (`/api/checkout/product`, admin-texted): hosted sessions, untouched.
- **Deposit rail:** fully untouched; share deposits stay gated behind qualification — nothing in this migration creates a cold one-click path to a $1k+ deposit.

## 8. Risk list (ranked)

1. **R1 — blank ship-to/email on settled orders.** Triple mitigation: `pi.shipping` stamped by AddressElement at confirm (webhook payload carries it); `metadata.buyerEmail` stamped at mint; webhook line-449 fix resurrects the latest_charge recovery. **Test:** settlement unit fixture = charges-less PI with only `metadata` + `shipping` → asserts full receipt + rancher email + ship-to.
2. **R2 — metadata drift between the two mint paths.** A parity unit test snapshot-asserts `createProductPaymentIntent` metadata keys/values === `createProductCheckout`'s `payment_intent_data.metadata` for identical input. This test IS the zero-settlement-change contract.
3. **R3 — 3DS/redirect returns with `redirect_status=failed` landing on a success page that says "you're set".** Handled: `/order/success` reads `redirect_status` + `pid`, renders honest retry state on failure.
4. **R4 — price/qty drift** between Elements init amount and mint amount (Airtable edit mid-session) → wallet sheet showed stale total. `expectedTotalCents` equality check → 409 → refresh prompt.
5. **R5 — double-mint on double-click** → `attemptId` idempotency key + client single-flight ref + clientSecret reuse on decline.
6. **R6 — Apple Pay absent** until per-account domains validate → silent card-only degrade (= today's baseline). Verify file serves with curl post-deploy.
7. **R7 — preview API version** (`2025-09-30.preview`): same client that mints sessions today; v1 PI create stable under it. No Clover-style trap: raw PIs have a clientSecret at create by definition (the Clover bug was session-deferred PI creation — structurally impossible here).
8. **R8 — Stripe auto-receipt parity:** `receipt_email` deliberately omitted so the rancher's connected-account Stripe receipt can't double-send against BHC's branded settlement receipt. Settlement email chain is covered by metadata. (Today's hosted flow may auto-send a ranch-named Stripe receipt — this migration removes that off-brand artifact.)
9. **R9 — oversell residual race** (seconds between gate and confirm) → existing OVERSOLD operator alarm is the designed backstop; unchanged.
10. **R10 — rollback:** `NEXT_PUBLIC_PRODUCT_PAYMENT_ELEMENT` flag in CheckoutMount flips Elements ↔ old EmbeddedCheckout instantly (both branches ship until first live Element sale settles clean end-to-end; then delete the embedded branch + buy-route embedded mode).

## 9. Build order (each step lands green: `npm test` quoted-glob direct tsx, `tsc`, **real `next build`** — memory: build gate; never `npm --legacy-peer-deps`)

1. **PR A — server foundations, zero UI change:** `lib/productBuyGates.ts` extraction (+ refactor buy route onto it) · `lib/productPaymentIntent.ts` + unit tests incl. the R2 metadata-parity snapshot + R1 charges-less settlement fixture · webhook line-449 `accountId` fix (also hardens today's live rail on its own).
2. **PR B — intent route:** `app/api/checkout/product/intent/route.ts` (gates, demo, idempotency, 409 taxonomy, CAPI move to page.tsx) + route tests.
3. **PR C — client cutover behind flag:** `lib/stripeAppearance.ts` · `PaymentForm.tsx` · `CheckoutMount.tsx` rewrite (flagged) · `page.tsx` props + CAPI · `/order/success` redirect_status handling.
4. **PR D — wallets:** `public/.well-known/` file · `lib/applePayDomain.ts` + lazy registration + Ranchers-row cache flag.
5. **Ops (Ben gates, per memory):** pk_live env present · flag ON in prod · **one real test buy** (card, then Apple Pay) · watch settlement: order row + ship-to + receipt + rancher email + margin → then delete embedded branch.

Key file references: `lib/productCheckout.ts` · `app/api/checkout/product/buy/route.ts` · `app/shop/checkout/[id]/{page,CheckoutMount}.tsx` · `lib/productSettlement.ts:34-48,52-144` · `app/api/webhooks/stripe-connect/route.ts:175,440-459` · `lib/stripeConnect.ts:59-69,292-460` · `app/globals.css:15-51` (all under `/Users/benji.bushes/BHC/untitled folder/bhc/`).

---

# Appendix: Competitive Checkout Teardown

# BHC Checkout Competitive Teardown — vs ButcherBox / Crowd Cow / Porter Road / Shopify-class
**Read-only audit, 2026-07-07.** Repo: `/Users/benji.bushes/BHC/untitled folder/bhc`. Surfaces read: `app/shop/checkout/[id]/page.tsx` + `CheckoutMount.tsx`, `app/checkout/[refId]/deposit/page.tsx`, `app/checkout/[refId]/success/page.tsx`, `app/order/success/page.tsx`, `app/order/cancelled/page.tsx`, PDP `app/shop/[id]/page.tsx` + `QtyBuy.tsx`/`BuyButton.tsx`, `lib/productCheckout.ts`, `app/api/checkout/product/buy/route.ts`, `lib/stripeConnect.ts` (deposit session), `lib/marketplaceProducts.ts`, `app/components/TrustStrip.tsx`.

**Headline:** the trust/honesty layer is already above Shopify-class. The conversion leaks are concentrated on the **low-ticket product rail**: wallets not yet live (ops gate), no delivery date at checkout, a generic success page that can't see the order (missing `{CHECKOUT_SESSION_ID}`), a cancel page that loses the product, and two chained round-trips of dead time before the card form. The deposit rail is near-flawless; its one structural gap is the full-page redirect off-domain at the $1k+ moment.

---

## RANKED GAPS (by conversion impact)

### 1. Express wallets (Apple Pay / Google Pay / Link) — code-ready, operationally dark  — **HIGHEST impact**
- **Best-in-class:** Apple Pay visible the moment the payment form renders (and often on the PDP as an express button). For cold mobile ad traffic this is routinely the single biggest checkout lever — no address typing, Face ID done.
- **What we do:** the code is already correct on BOTH rails — dynamic payment methods are enabled by *omitting* `payment_method_types` (`lib/stripeConnect.ts:396-404`, verified against Stripe docs in-code; `lib/productCheckout.ts:172-255` same). But wallets won't render until the **Apple Pay domain is registered for the direct-charge funds flow (per connected account) and `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is live** — both are known Ben gates. Worse: with no publishable key, `CheckoutMount.tsx:32-44` silently downgrades every shop buy to a **hosted redirect off-domain**, so today the whitelabel embedded rail may not even be running in prod.
- **Fix:** (a) Ben: set `pk_live` env + register `www.buyhalfcow.com` for Apple Pay on the platform AND verify wallet render on a rancher direct charge; (b) after live: screenshot-verify Apple Pay shows in the embedded iframe on iPhone; (c) later ambition: Express Checkout Element on the PDP itself (`app/shop/[id]/page.tsx:408-422`) so the wallet button appears one screen earlier. Zero code for (a)/(b).

### 2. No "ships in ~N days" at the product checkout — data exists, one-line fix
- **Best-in-class:** delivery expectation restated AT the payment moment ("Ships within 2 business days"), because delivery anxiety peaks at card entry.
- **What we do:** PDP shows it (`app/shop/[id]/page.tsx:357,370` — "ships within ~N days"), but the checkout order summary says only "ships direct from the ranch" (`app/shop/checkout/[id]/page.tsx:93`). The field is ALREADY on the loaded product — `loadMarketplaceProductAnyStock` returns `shipsInDays` (`lib/marketplaceProducts.ts:199`).
- **Fix:** at `page.tsx:93` render `ships in ~${p.shipsInDays} days · direct from the ranch` when set. Same for `ordersLeft` honest scarcity (shown on PDP at `[id]/page.tsx:391-395`, absent at checkout). Deposit rail already does both (fulfillment block `deposit/page.tsx:394-420`, processing-date line `:508-512`).

### 3. Guarantee/risk-reversal is BELOW the payment form on the product rail
- **Best-in-class:** the make-it-right guarantee sits beside/above the pay button, visible while the card is being typed.
- **What we do:** the excellent "if a cut shows up wrong or freezer-burned, we make it right — no forms, no runaround" line lives only on the PDP (`app/shop/[id]/page.tsx:427-436`). At checkout, the only trust copy is `TrustStrip` rendered AFTER the Stripe iframe (`app/shop/checkout/[id]/page.tsx:123`) — below the fold on mobile while paying. The deposit rail gets this exactly right (trust line directly under the CTA, `deposit/page.tsx:552-554`, BHC Promise above it `:425-450`).
- **Fix:** add one 12.5px line between the summary card and `<CheckoutMount>` (~`page.tsx:120`): "wrong or freezer-burned? we make it right — and a real person answers your receipt. — ben". Keep TrustStrip below as the second touch.

### 4. Product success page is blind — `return_url` drops the session id
- **Best-in-class:** order number, what you bought, where receipt went, personalized next step + cross-sell.
- **What we do:** `/order/success` is fully static/generic (`app/order/success/page.tsx`) — no order details, no email echo, a deposit-note paragraph shown to everyone, and cross-sell to generic `/map` + `/gear`. Root cause: the buy route mints `returnUrl`/`successUrl` as bare `${SITE_URL}/order/success` (`app/api/checkout/product/buy/route.ts:147-148`) — **no `?session_id={CHECKOUT_SESSION_ID}`**, so the page CAN'T look anything up. The deposit rail does this correctly (`app/api/checkout/deposit/route.ts:324`) and its success page is genuinely best-in-class (poll-to-confirmed, preferences capture, attributed share hook — `app/checkout/[refId]/success/page.tsx`).
- **Fix:** (a) append `?session_id={CHECKOUT_SESSION_ID}&acct=<connectAccountId>` to both URLs; (b) tiny GET endpoint retrieving the session (scoped `stripeAccount`, id-format-validated, rate-limited) returning name/qty/total/email/productId/rancherId; (c) success page renders the real order + "more from {ranch}" via the existing `loadProductsForRancher` (already used on PDP `app/shop/[id]/page.tsx:197`) + a share hook (the deposit page's pattern at `success/page.tsx:288-325` is right there to copy). This is the post-purchase LTV moment the low-ticket rail exists for (ladder-up to shares) — today it's a dead-end card.

### 5. Cancelled page loses the product — recovery path goes cold
- **Best-in-class:** cancel returns you to the cart/PDP with state intact, one tap from resuming.
- **What we do:** `cancel_url` is a static `${SITE_URL}/order/cancelled` (`buy/route.ts:149`); the page (`app/order/cancelled/page.tsx`) is warm and honest but its only CTA is generic "back to the shop" — the buyer must re-find the product. The deposit rail again does it right: cancel returns to the deposit page itself with `?canceled=1` (`deposit/route.ts:325` → banner at `deposit/page.tsx:337-341`).
- **Fix:** `cancelUrl: ${SITE_URL}/shop/${product.id}?canceled=1` (PDP keeps qty picker, reviews, trust — the ideal resume surface; optionally render a quiet "no charge — pick up where you left off" banner on `canceled=1`). Also: the embedded-mode escape link "back to shop" (`CheckoutMount.tsx:81-88`) should point at `/shop/${productId}` (the PDP), not `/shop`.

### 6. Perceived speed: two chained round-trips of dead time before the card form
- **Best-in-class:** instant skeleton, payment form interactive <1.5s.
- **What we do:** PDP "buy" → (1) force-dynamic server render blocks on Airtable with **no loading UI** — `app/shop/checkout/[id]/` has no `loading.tsx` (deposit rail has one: `app/checkout/[refId]/loading.tsx`), so the click feels dead for the Airtable RTT; then (2) client mounts and only THEN POSTs `/api/checkout/product/buy` (`CheckoutMount.tsx:25-58`) which does Airtable reads + `ensureStripePrice` + session create; then (3) Stripe.js + iframe load. The skeleton in `CheckoutMount.tsx:93-102` only covers phase 2-3.
- **Fix:** (a) add `app/shop/checkout/[id]/loading.tsx` (copy the CheckoutMount skeleton) — 10 minutes; (b) `<link rel="preconnect" href="https://js.stripe.com">` — none exists in `app/layout.tsx`; (c) bigger: mint the session **server-side in page.tsx** (it's already force-dynamic and holds the product) and pass `clientSecret`+`connectAccountId` as props, deleting a full client RTT + session-create wait; sessions already expire in 30 min (`productCheckout.ts:178`) so bot-minted sessions are disposable. Keep the client path as fallback.

### 7. Deposit rail leaves the domain at the $1k+ moment
- **Best-in-class:** single-page, on-brand payment (Shopify checkout never feels like leaving the store).
- **What we do:** the deposit page itself is superb, then `continueToCheckout` does `window.location.href = j.url` → full-page redirect to `checkout.stripe.com` with a "redirecting to stripe…" button state (`deposit/page.tsx:162-163,545`). The branded summary, ranch identity, and the BHC Promise all vanish at card entry; Stripe shows one ranch-named line item (`stripeConnect.ts:340-348`).
- **Fix (post-wallets, medium effort):** port the product rail's embedded mode to `createDepositCheckout` (`ui_mode: 'embedded'` + `return_url`, exactly the `productCheckout.ts:181,250-252` pattern) and mount it under the existing summary/promise blocks. Counterweight: hosted is battle-tested and Link-optimized — ship this only after one real embedded deposit test settles.

### 8. Support human invisible at product checkout until failure
- **Best-in-class:** persistent "questions? chat/email" at checkout.
- **What we do:** deposit rail is exemplary (message-your-rancher header link `deposit/page.tsx:314`, book-a-call escape `:557-566`, `/support?ref=` in every error state `:195-199`). Product checkout has a human only inside TrustStrip's "a real person answers your receipt" (post-purchase framing) — no live `/support` link pre-purchase; the error card (`CheckoutMount.tsx:62-71`) offers only "back to the shop".
- **Fix:** add "questions first? ask a real person →" (`/support`) under the checkout summary and in the CheckoutMount error card.

### 9. Minor polish
- Deposit initial load is plain text "loading your reservation…" (`deposit/page.tsx:176-180`) vs the shop rail's skeleton — unify on the skeleton.
- No cart: each checkout is single-product (qty only, `QtyBuy.tsx`). Architecturally defensible (direct charges can't span rancher accounts) — but a **per-ranch 2-item bundle** ("add jerky to this box, one shipping fee") is the one cart-shaped win worth considering later; the cross-sell rows already exist on the PDP.
- Mobile ergonomics: verified GOOD — deposit sticky thumb-zone pay block with consent-banner offset (`deposit/page.tsx:502`) beats most competitors; embedded Stripe iframe auto-sizes (no double-scroll), `p-1` wrapper at `CheckoutMount.tsx:76`.

---

## WHERE WE'RE ALREADY BETTER THAN THE COMPETITORS
1. **Fee-invisible one-number pricing** — no fee lines, no surprise tax (`automatic_tax` deliberately off after the surprise-tax abandonment discovery, `stripeConnect.ts:406-418`); PDP promises "that's the whole total, no surprises at checkout" and the checkout keeps it.
2. **Honesty stack ButcherBox can't match:** real scarcity only (true `Orders Left` ≤10, real processing dates — never counters); honest sold-out states at every layer (PDP stays alive for ad clicks, fresh-truth sold-out at checkout `shop/checkout/[id]/page.tsx:51-71`, charge-time 409s `buy/route.ts:63-91`); verified-purchase reviews only with an explicit FTC note in-code.
3. **Error-state UX above Shopify-class** — the deposit page maps every machine error to warm copy + a live forward path (dead-reservation honesty vs "already reserved ✓" split, auth → sign-in round-trip with `next=`, retry + human on generic failure; `deposit/page.tsx:184-277`). Nobody's checkout does this.
4. **Refund policy AT the payment point, consent recorded** — BHC Promise + required ToS/refund checkbox enforced server-side (`400 terms_required`), plus Stripe-side `consent_collection` env-gated for chargeback evidence.
5. **Deposit post-purchase page** — poll-until-confirmed with an honest terminal state (never a false "confirmed" or infinite spinner), preferences capture, ATTRIBUTED refer-a-friend ("split your cow") share hook, gear cross-sell, account discoverability. This is the page competitors should be tearing down.
6. **Oversell protection** — 30-min session expiry + charge-time stock/qty checks; a stale ad link can't oversell a batch.
7. **Brand-owned order summary above the embedded Stripe form** — reclaims the checkout from the ranch-named Stripe form; a $20 jerky buy and an $1,800 deposit read as one company.
8. **A human with a name** — "— Ben" signature and "a real person answers" at the money moment; competitors have a helpdesk.

## SUGGESTED SHIP ORDER
1. **Ben ops (no code): wallets live** — pk_live + Apple Pay domain + verify render (Gap 1).
2. **One-day copy/wiring PR:** ships-in-N + scarcity at checkout (2), guarantee above iframe (3), cancel→PDP with `?canceled=1` (5), support links (8), `loading.tsx` + preconnect (6a/6b).
3. **Success-page PR:** `{CHECKOUT_SESSION_ID}` on return/success URLs + session-lookup GET + real order render + ranch cross-sell + share hook (4).
4. **Speed PR:** server-side session mint for embedded checkout (6c).
5. **Embedded deposit checkout** (7) — after one real embedded product purchase settles cleanly in prod.


---

# Appendix: Share-Gate Map (verified 2026-07-07)

SHARE-DEPOSIT CHARGE CREATORS — exactly 3 code sites call createDepositCheckout; every share charge flows through one of them:

[A] POST /api/checkout/deposit (app/api/checkout/deposit/route.ts) — THE buyer charge gate. Stacked gates, in order: STRIPE_CONNECT_ENABLED env (:41) → origin guard (:48) → explicit ToS/refund consent, termsAccepted strict-boolean (:64) → resolveDepositAuth = full member session OR referral-PINNED deposit-grant cookie (:75, lib/buyerAuth.ts:81-101) → referral.Buyer must contain session.consumerId (:87-89) → terminal/re-pay guard: Deposit Paid At, Awaiting Payment, Slot Locked, Closed Won/Lost all 409 (:97-117) → legacy rancher 409-redirect (:132) → tier set (:145) + Stripe Connect Status='active' (:149) + Connect acct id present (:152) → subscription not past_due/unpaid/canceled (:184) → cut price ≥ MIN_TIER_PRICE=$100 per-lb-typo floor (:220) → deposit ≤ price else derive 25% (:233) → per-referral claimOnce serialization (:292). Fee = locked Commission Rate. Every buyer-facing path below terminates here, so its gates apply to all of them.

ENTRY PATHS INTO [A]:
1. QUIZ FUNNEL (/access → BuyerFunnel → /api/qualify mints bhc-member-auth session → referral minted via /api/matching/suggest, which is x-internal-secret OR requireAdmin gated — not publicly callable). Gate = quiz qualification + session + referral ownership. The intended front door.
2. RANCHER-PAGE SELF-SERVE RESERVE (app/ranchers/[slug]/page.tsx:786 renders DepositReserveForm ONLY when isRancherOnConnect; legacy ranchers get the 48h-callback lead form or their off-platform Reserve Link — no BHC charge). POST /api/checkout/reserve gates: origin guard (:61) → 5/min + 30/hr per-IP rate limits (:67-74) → phone required (:92) → email format + disposable-domain block (:105) → assertReserveEligible (lib/reserveDeposit.ts:59-101): Connect-active + operational + valid tier + cut price ≥ $100 → SESSION SECURITY: brand-new consumer only is auto-sessioned; an EXISTING email gets a one-tap magic link (proof of ownership) instead — no identity adoption from unverified email (:248-301). DESIGN-FACT: this rail bypasses the quiz BY DESIGN (Connect-active ranchers only); Notes field stamps '[Source] Self-serve deposit (rancher page, no quiz)'.
3. CAMPAIGN 1-TAP /r/d/[token] (app/r/d/[token]/route.ts): signed purpose-pinned campaign-reserve JWT (30d) verified (:81); minted ONLY by (a) admin-gated POST /api/admin/sell-links (requireAdmin; mint gate mirrors redemption gate incl. price floor) and (b) demand-router cron targeting already-quiz-qualified buyers (Qualified At + score ≥75, lib/demandRouter.ts:306-309). Exchanged for a referral-SCOPED deposit-grant cookie (2d TTL, purpose:'deposit-grant', lib/campaignReserve.ts) that resolveDepositAuth pins to that one referralId — a forwarded link can at worst pay ONE deposit and can NEVER reach /member/reorder (member-session-only surfaces). 10/min/IP rate limit; every failure 302s, never 500s. All of [A]'s gates still run.
4. MEMBER REORDER (app/api/member/reorder/route.ts): member session required (:31) → caller-supplied rancherId/referralId proven against the buyer's OWN Closed Won history (:62-110, 403 otherwise) → rancher operational check → new referral via internal-secret matching call → depositUrl returned only if Connect-active. Gate = prior completed purchase with that exact rancher.
5. GET /checkout/[refId]/deposit page + GET [A] — read-only, same auth + ownership + terminal gates; fee-invisible display matches charge math.

[B] POST /api/admin/send-deposit-invoice — requireAdmin (:29); operator-initiated close (fine by definition); finds-or-creates referral; tier_v2 + Connect acct required, but tolerates status='onboarding' (minor leak #2); emails Stripe link to buyer.

[C] POST /api/rancher/referrals/[id]/request-deposit — requireRancher session; rancherId from SESSION never body (:78); decideDepositRequest (lib/depositRequest.ts) pure gate: referral must link to THIS rancher → tier_v2 → Connect status='active' → acct present → cut price saved → $25 ≤ deposit ≤ full sale ≤ $25k → alreadyPaid guard (:143) → idempotent resend. Rancher can only request on their own referred buyer; buyer still pays via emailed Stripe link.

CROSS-RAIL (product rail → share money): the product rail CANNOT reach createDepositCheckout. Public POST /api/checkout/product/buy charges only trusted Rancher Products rows (never client prices), capped at $2,000 by validateProductInput, margin invariant 0 < Base ≤ Display enforced at listing (isSellableRow) AND at charge (computeProductCharge throws). Operator product links (/api/checkout/product) are requireAdmin. 'Eighth Share' one-click ≤ $2,000 = ALLOWED BY DESIGN (tier product, 15% margin); ops-managed Deposit-Style rows are content-fenced from rancher edits (route.ts:249). THE HOLE: nothing stops a rancher naming a Bundle/Eighth-Share row 'Half Beef Share $1,900' and selling share-size money one-click with zero qualification and zero operator review (leak #1) — the $2,000 cap is the only fence and it is above real half-share deposit territory.

## Gate clean bill

The share-deposit rail itself is tight: only 3 code sites can create a deposit charge and all are properly gated. Verified clean: (1) /api/checkout/deposit — auth, referral.Buyer ownership, consent, terminal/re-pay guard, tier + Connect-active + subscription gates, $100 price floor, 25% deposit derivation, per-referral serialization; no way to pay someone else's referral or re-pay a settled one. (2) /api/checkout/reserve — the by-design no-quiz rail is correctly fenced to Connect-active + operational + valid-tier + priced ranchers, never mints a session from an unverified existing email (magic-link wall), rate-limited, and voids its own orphan holds on email failure. (3) /r/d/[token] campaign grants — signed purpose-pinned tokens minted only by admin console or the cron that targets already-quiz-qualified buyers; the deposit-grant cookie is referral-scoped, 2-day, and inert on /member, reorder, and every member-session surface (confirmed lib/buyerAuth.ts keeps the two credentials separate). (4) Member reorder — ownership proven against the buyer's own Closed Won history; enumeration of rancher/referral ids is 403'd. (5) Operator rails (admin sell-links, send-deposit-invoice, /api/checkout/product) are requireAdmin with constant-time password compare; rancher request-deposit is session-scoped with a pure unit-tested money gate ($25-$25k, ≤ full sale, active Connect only). (6) matching/suggest (referral minting) is internal-secret/admin gated — not publicly callable. (7) Product-rail money invariants hold at both listing and charge time (0 < Base ≤ Display, stock, ships-nationwide re-checked at charge); client can never supply a price. (8) Legacy ranchers expose no BHC charge path — lead form or off-platform link only. The only cross-rail gap is the missing share-name/price fence on rancher self-serve listings (leak #1); everything else met the founder bar: share deposits stay behind qualification or an explicit operator/rancher action on a known referral.