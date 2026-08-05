# RAIL MATRIX — the four ways a rancher takes business

**Status:** canonical operator reference · verified adversarially 2026-08-04 (branch `rail-matrix`)
**Ground truth for the money models:** `docs/BUSINESS-MODEL.md` ⭐ (this doc maps the *code*, that doc owns the *why*)
**Rule of this doc:** counts and mechanics only — no buyer or rancher names, ever (public repo).

A deal must **resolve under the rail it was opened on**. Every table below ends in the field
stamps and gates that make that true, and the last section lists exactly what wins when
rails collide.

---

## 0 · How code decides the rail

| Level | Signal | Decider | Values |
|---|---|---|---|
| Rancher (charge time) | `Broker Rail` checkbox vs Connect footprint (`Stripe Connect Account Id` / non-empty `Stripe Connect Status` / `Pricing Model=tier_v2`) | `referralRailForRancher` (`lib/brokerRail.ts`) | `broker` · `connect` · **`ambiguous` → always refuse** |
| Stripe object (settle time) | `metadata.rail === 'broker'` (exact) · `metadata.type` (`buyer_deposit` / `final_invoice` / `broker_deposit`) | webhook branch (`app/api/webhooks/stripe*/route.ts`) | tamper-proof — written at session create, held by Stripe |
| Referral row (post-close economics) | `Deposit Paid At` (paid ⇒ fee was captured at deposit) · `Match Type = 'Broker — Deposit'` (stamped at referral **creation**) | `referralRail` + `isBrokerReferralRow` + `isPostCloseInvoiceRail` (`lib/commission.ts`) | tier_v2 · legacy · broker |

`isPostCloseInvoiceRail(row)` is the ONE question every close-time invoice site asks:
**true only for a legacy row that is not broker.** (confirm-payment, dashboard close,
quick-action, Telegram close, monthly cron, lazy mint — all route through it or its
`commissionOwed` equivalents.)

---

## 1 · CONNECT / tier_v2 — the core rail

| | |
|---|---|
| **Money flow** | Buyer's card charged **deposit + BHC fee** in one Stripe Checkout — **direct charge on the rancher's connected account** with `application_fee_amount` = fee (`lib/stripeConnect.createDepositCheckout`). Fee = locked `Commission Rate` (else tier rate) × **full sale price**, captured **entirely at deposit**. Final invoice (`send-final-invoice`) carries **fee = 0**. Net-your-number: `absorbStripeFee` shrinks the application fee so the rancher's payout equals the exact deposit. |
| **Fields stamped** | Referral: `Deposit Paid At`, `Deposit Amount`, `Total Sale Amount`, **`BHC Fee Cents` = the buyer-paid fee**, `Fee Captured At`, Status→`Awaiting Payment`. Payments row: `Type` buyer deposit, `Amount Cents`, `Platform Fee Cents`, `Total Charged Cents`, `Captured At`. Final: `Final Paid At`, `Final Paid Amount`, Status→`Closed Won`. |
| **Buyer sees** | One "due now" number (fee folded in, never itemized — founder directive). Refund promise: *"fully refundable until your rancher accepts your slot"* (`REFUND_POLICY_SHORT`) + BHC Promise (connect variant: slot-locked email on accept). |
| **Rancher sees** | "You keep 100% of your price — the buyer covers our fee on top." Dashboard: deposit-rail rows net = **full revenue** (`netEarningsFor('tier_v2')`); fee shown from `BHC Fee Cents`; **never** an invoice for these rows. |
| **Notifications** | Settle: buyer confirmation, rancher new-order, operator Telegram celebration. Accept → slot-locked email. SLA chases on unaccepted paid deposits. |
| **Refund story** | Admin console `POST /api/admin/payments/refund/[paymentId]` — refund created **on the connected account** with `reverse_transfer` + `refund_application_fee` (BHC's fee clawed back too). **NRD lock:** after `Rancher Accepted At`, refund blocked unless `nrdOverride` + reason (audited + loud Telegram). Partial refunds capped against `Total Charged Cents`. |
| **Exclusions/gates** | Routable only when Active + agreement + Onboarding Live + subscription healthy + **Connect status active** (`isRancherOperationalForBuyers`). Deposit route additionally re-gates ZIP territory, price floor, subscription, and (new) the rail itself. |

## 2 · PRODUCT / shop

| | |
|---|---|
| **Money flow** | Buyer pays **Display Price × qty + shipping**. Direct charge on the rancher's connected account; **BHC margin = display − Rancher Base**, taken as the `application_fee` (net-your-number applies). **Locked `Commission Rate` wins over category margin** for the spread (#550). Shipping is 100% passthrough — never in BHC's margin. BHC never holds the money. |
| **Fields stamped** | `Rancher Orders` row: order ref (dedup tag `BHC-oid:<rowid>` — Order Ref is NOT unique), `BHC Margin`, `Ordered At`, push state (`External Push Status`/`External Order Id`), `Status` New→pushed→Shipped + `Tracking Number`. |
| **Buyer sees** | Retail price, no fee line at all (margin is inside the price). Shopify sends the tracking email when the ranch has Shopify (BHC suppresses its own). |
| **Rancher sees** | Nets exactly Rancher Base + shipping per unit, split atomically at charge. |
| **Refund story** | Verified: refund → `orderCancel` + restock → order `cancelled`; refunded order can no longer ship. |
| **Exclusions/gates** | Listing requires operator `Marketplace Approved`. Products pointing at a **Broker Rail rancher are dropped from every listing surface** (`lib/marketplaceProducts`), and the buy route re-gates. |

## 3 · BROKER / represented — money model 3

| | |
|---|---|
| **Money flow** | Plain Checkout Session on **BHC's OWN Stripe account** — no `stripeAccount` header, no `application_fee`, no transfer (`lib/brokerCheckout`). **The deposit goes 100% to BHC and IS the entire commission.** Buyer total = the ranch's plain price (unchanged vs buying direct). Rancher collects price − deposit directly, off-platform, and **nets price − deposit**. Deposit never derived — explicit per-cut or the cut is unsellable; deposit ≥ price refused. |
| **Fields stamped** | At referral **creation** (`lib/brokerReferral`): `Match Type='Broker — Deposit'`, money truth (`Total Sale Amount`, `Deposit Amount`). At settle (`lib/brokerSettlement`): `Deposit Paid At`, **`BHC Fee Cents` = the whole deposit**, `Fee Captured At`, Status→`Awaiting Payment` (balance owed to the **ranch**, never BHC). Payments row: `Type='broker_deposit'`, `Platform Fee Cents` = deposit. |
| **Buyer sees** | Deposit toward the share + exact balance paid to the ranch. **Never** any mention of BHC keeping anything (pinned by tests). Refund promise (fixed this branch): *"fully refundable until the ranch confirms your animal — refunded by BuyHalfCow"* (`BROKER_REFUND_POLICY_*`, broker `BHCPromiseBadge`, receipt refund line). No slot-locked email is promised — that machinery does not exist on this rail. |
| **Rancher sees** | ONE email — the fulfillment sheet: buyer contact, the money table, and plainly that the deposit was BHC's commission and he nets price − deposit (agreed at `/partner/represent` before any order). **Never invoiced, ever.** No login, no dashboard. |
| **Notifications** | Settle: rancher fulfillment sheet + buyer receipt + operator Telegram card (all behind the idempotency anchor). Referral-stamp failure → loud operator signal with fix-by-hand fields. |
| **Weight-priced cuts** (2026-08-05) | When `Quarter/Half/Whole Price Max` is set **strictly above** the cut's `… Price`, the cut is **WEIGHT-PRICED**: the Price field is the range FLOOR, Max the ceiling, and the exact share price is set by **hanging weight** after processing. Max missing / ≤ floor → exact mode, byte-identical to before (pinned); malformed Max → treated as absent + noted on the quote. **The deposit stays EXACT and untouched** — it is still 100% BHC's commission, and nothing in range mode alters deposit math, fee stamps, or settlement amounts (pinned). Buyer surfaces (checkout, receipt) state *"estimated $floor–$max — final price set by hanging weight"* + the `Broker Pricing Note` ($/lb basis) and **never an exact balance**; split silence holds. Rancher email: deposit kept (exact) + balance as the range, *"exact balance set by hanging weight"*. **Stamps:** `Total Sale Amount` ← the **FLOOR** (conservative — the ex-represented dashboard net read can only understate, never overstate); `Deposit Amount` / `BHC Fee Cents` unchanged; the range + weight-priced flag recorded in the referral Notes, the Stripe metadata (`priceMaxCents` etc.), and the balance-note composition (leads with the range). |
| **Refund story — mechanics** | The money sits in **BHC's own balance — a refund is Ben's money going back**. ⚠️ The admin refund console **cannot** process it today (it 422s: "no Connect account"); a broker refund is manual in the Stripe Dashboard on the platform account. See *Ben decides* #1. |
| **Exclusions** | Invisible platform-wide: routing, state coverage, map, `/ranchers`, sitemap, `/shop`, onboarding/chase/reactivation crons, broadcasts, go-live paths, payable-rancher counts (`brokerGuardrails` tests). **Not a payable rancher** for the north-star metric. |

## 4 · LEGACY lead-send

| | |
|---|---|
| **Money flow** | BHC routes the lead; the rancher closes **off-platform** (cash/check/their own links) and owes the locked commission % **after** close. Receivable = `Commission Due`; collected via a Stripe **invoice from BHC's account** (`lib/stripe-commission.createCommissionInvoice`, idempotency `invoice-<referralId>`; floor $50 / ceiling $25k / ratio 3–20% guards). |
| **Touchpoints (end-to-end)** | ① route/intro (`matching/suggest` → intro email) → ② rancher works it (dashboard/Telegram) → ③ close: dashboard PATCH close, `confirm-payment` (off-platform money), quick-action, or Telegram close-reply — each computes `Commission Due` via the **locked rate** and fires the close-time invoice **only if `isPostCloseInvoiceRail`** → ④ `Stripe Invoice ID/URL` stamped; instant email carries the pay link (#551: **no commission email ever ships without one**) → ⑤ monthly cron `commission-invoices` (1st): mints missing invoices for owed rows, statements per rancher (double dedup: Email Sends + Redis claim) → ⑥ dashboard "Commission owed" block + lazy mint `POST …/commission-invoice` → ⑦ `invoice.paid` webhook stamps `Commission Paid` + `Commission Paid At`. |
| **The guard (post-#551 sanity)** | `confirmPaymentGuard.hasPendingStripeDeposit` — `Deposit Requested At` set + `Deposit Paid At` empty blocks manual "confirm payment": a live Stripe deposit link must confirm itself via webhook, or the deal closes (and legacy-invoices) before money moved. Still coherent: request-deposit stamps exactly those fields; settlement clears the condition. |
| **Who's on it** | Legacy `Pricing Model` ranchers, **plus any tier_v2 rancher's off-rail close** (deal closed on a call with no deposit ever paid) — rail-per-row, never per-rancher. 20-of-22 legacy closes capturing no fee = ranchers paying directly, intentional. |

---

## 5 · CROSS-RAIL PRECEDENCE — what wins when flags collide (all verified)

| Situation | Entry point | What wins | Where |
|---|---|---|---|
| **Broker flag + Connect footprint (dual-flag / "ambiguous")** | routing / coverage / counts | **Broker wins → dark.** Never routed, serves no states | `isRancherOperationalForBuyers` (broker check is FIRST), `getOperationalServedStates` |
| | broker checkout (mint + tap + POST) | **Refused** — `ambiguous_rail` / `connect_rancher` | `assertBrokerEligible` GATE 2, `loadBrokerRancher` |
| | Connect deposit checkout (POST + GET) | **Refused** — `ambiguous_rail` *(FIXED this branch — previously charged Connect economics silently)* | `app/api/checkout/deposit/route.ts` rail gate |
| | sell-link mint (either branch) | **Refused both ways** (#548 held) | `sell-links` route: broker branch → GATE 2; Connect branch → operational gate |
| | campaign `/r/d` and broker `/r/b` links | **Refused both ways**; tokens have distinct purposes and reject each other | `campaignReferral` (assertReserveEligible), `brokerReferral` (fail-closed rail check) |
| | rancher-dashboard "Request deposit" | **Refused** *(FIXED this branch — dual-flag rancher could previously email a Connect link)* | `decideDepositRequest` broker gate |
| **Pure broker rancher reaches Connect deposit URL** | `/checkout/[refId]/deposit` | 409 + redirect to `/checkout/[refId]/broker` *(FIXED — was a broken `/ranchers/` redirect)* | same rail gate |
| **Broker token after rancher migrated onto Connect** | `/r/b` tap | **Refused** (`not-broker-rail` fail-closed re-check at tap) | `lib/brokerReferral` |
| **Settlement** | platform + Connect webhooks | `rail='broker'` exact-match branches **before** `buyer_deposit`; a broker PI (`type=broker_deposit`) can never reach `settleBuyerDeposit`, and a Connect PI never reaches `settleBrokerDeposit` | `app/api/webhooks/stripe/route.ts` |
| **Legacy rancher mid-migration to tier_v2, open deal on old rail** | close + invoicing + earnings | **The row's own rail wins — rancher's current `Pricing Model` is never consulted.** No deposit paid ⇒ legacy economics (invoice fires) even under a tier_v2 rancher; deposit paid ⇒ skimmed-at-deposit even if flipped back to legacy | `referralRail` / `partitionUnpaidByRail` / `isPostCloseInvoiceRail` (#356 rail-per-row; pinned by the mid-migration test) |
| **Commission invoice vs Connect row (fee already buyer-paid)** | cron, lazy mint, dashboard, all 4 close sites | **Refused** — `Deposit Paid At` wins over any phantom `Commission Due` (data error cannot double-bill) | `isCommissionOwedRow`, `commissionInvoiceEligibility`, `partitionUnpaidByRail` |
| **Commission invoice vs broker row — paid deposit** | same | **Refused** (deposit-rail path; the deposit WAS the captured fee) | same |
| **Commission invoice vs broker row — deposit never paid, hand-closed Won** | same | **Refused** *(FIXED this branch — previously invoice-eligible: a represented rancher could be billed on a model he never signed).* Cron now skips + surfaces the count; nothing is stamped paid (nothing was collected) | `isBrokerReferralRow` belt on `Match Type` (stamped at creation, so it holds where `Deposit Paid At` doesn't) |
| **`BHC Fee Cents` meaning per rail** | BHC-revenue readers (cockpit money band, command-center, health-digest MTD) | Treated **uniformly as BHC revenue — correct on both rails** (Connect: buyer-paid fee; broker: the kept deposit; Payments `Platform Fee Cents` mirrors it) | `computeConnectFeeCaptured*`, `aggregateMonthToDate` |
| | rancher-facing earnings (dashboard) | **Must distinguish — now does** *(FIXED: broker rows net = sale − fee kept, not full sale; broker rows excluded from "unpaid commission")*. A pure represented rancher has **no dashboard at all** (no login) — this matters only for a migrated ex-represented rancher | `app/api/rancher/dashboard/route.ts` |

---

## 6 · Boundary verdicts (adversarial pass, 2026-08-04)

| Boundary | Verdict |
|---|---|
| **A — dual-flag ranchers** | Mint/tap/routing/settlement all HELD; **Connect charge path + dashboard deposit-request FIXED** (were the two doors that fail-opened for ambiguous ranchers). Mid-migration rail-per-row HELD + pinned. |
| **B — commission invoices legacy-only** | Connect rows HELD (Deposit Paid At wins over phantom receivables — pinned). Paid broker rows HELD. **Unpaid broker Closed Won FIXED** (Match Type belt in every selection gate + all 4 close-time invoice sites + the receivable writer). |
| **C — fee-stamp semantics** | All BHC-revenue readers HELD (uniform is correct). **Rancher dashboard FIXED** (broker rows no longer inflate net earnings / owed). |
| **D — refunds per rail** | Connect + product HELD. **Broker copy FIXED** (checkout checkbox, security line, Promise badge variant, receipt line now state the truth: refundable until the ranch confirms the animal, refunded by BuyHalfCow). Mechanics gap documented below. |
| **E — legacy rail completeness** | HELD — walked end to end (§4); `confirmPaymentGuard` still coherent post-#551. |

## 7 · Ben decides (design questions, not bugs)

1. **Broker refunds have no tooling.** The admin refund console requires a Connect account, so a broker deposit refund is a manual Stripe-Dashboard action on the platform account today. Build a `broker_deposit` branch into `/api/admin/payments/refund` (plain platform refund, flip the Payments row)? The buyer-facing promise now says "refunded by BuyHalfCow", so the manual path is the only fulfillment mechanism until then.
2. **Unpaid broker Closed Won rows** are now skipped by the cron and surfaced in its report — BHC collected nothing on them and never invoices. Whether to chase the ranch for a lost-deposit deal is a per-relationship phone call; if these accumulate, decide a policy.
3. **Migrated ex-represented ranchers:** broker-era rows still appear in their dashboard deal *lists* (money aggregates are now truthful). Hide broker-era rows entirely, or label them? Cosmetic either way.
4. **Pre-existing, unrelated to this pass:** `sign-agreement` + `/terms` still describe the deprecated invoice money model (flagged since the 2026-07-24 supply-funnel audit) — legal wording is Ben's call.
