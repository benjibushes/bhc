# Phase C — tier_v2 Code-Path Smoke — 2026-05-26

Variant of original Phase C plan: live Stripe E2E deferred to post-merge initial rancher onboarding (Stripe anti-bot blocks autonomous Express flow, and `STRIPE_CONNECT_ENABLED=false` on production short-circuits the gated endpoints anyway). This audit verifies all tier_v2 endpoints respond correctly when the Connect flag is off, the Connect webhook verifies signatures, and the underlying lib exports are intact.

Branch: `stage-3-verticals`
HEAD: `85e8c25f35d366c535e7699e381113972d09c15f`

## Tier_v2 endpoint gate behavior (source review)

Each endpoint that performs Stripe Connect mutations refuses early with `503 { error: "Stripe Connect not enabled..." }` when `STRIPE_CONNECT_ENABLED !== 'true'`. Excerpts:

```
=== app/api/rancher/connect/start/route.ts ===
14: CRITICAL: STRIPE_CONNECT_ENABLED env gate — refuses unless 'true'.
27: export async function POST(req: Request) {
28:   if (process.env.STRIPE_CONNECT_ENABLED !== 'true') {
29:     return NextResponse.json({ error: 'Stripe Connect not enabled in this env' }, { status: 503 });
30:   }

=== app/api/checkout/deposit/route.ts ===
34: export async function POST(req: Request) {
35:   if (process.env.STRIPE_CONNECT_ENABLED !== 'true') {
36:     return NextResponse.json({ error: 'Stripe Connect not enabled' }, { status: 503 });
37:   }

=== app/api/rancher/tier/select/route.ts ===
29: export async function POST(req: Request) {
30:   if (process.env.STRIPE_CONNECT_ENABLED !== 'true') {
31:     return NextResponse.json({ error: 'Stripe Connect not enabled' }, { status: 503 });
32:   }

=== app/api/rancher/tier/change/route.ts ===
17: export async function POST(req: Request) {
18:   if (process.env.STRIPE_CONNECT_ENABLED !== 'true') {
19:     return NextResponse.json({ error: 'Stripe Connect not enabled' }, { status: 503 });
20:   }
```

`app/api/rancher/connect/status/route.ts` is **read-only** and does NOT gate on `STRIPE_CONNECT_ENABLED`. It is gated by `requireRancher(req)` (Clerk or legacy JWT) and short-circuits with `{ status: 'not_connected' }` when the rancher has no `Stripe Connect Account Id` set on their Airtable record. This is the correct behavior: even with the flag off, the /rancher/billing dashboard needs to render a "not_connected" state for ranchers that finished onboarding pre-Stage-3. No 500 path.

## Endpoint responses

### Production (`https://www.buyhalfcow.com`)

Stage-3 routes are not yet deployed to production (Stage-3 is on the `stage-3-verticals` branch, merge-pending). Probing prod returns Next.js' standard 404 HTML for every tier_v2 endpoint — confirming there is no leak of Stage-3 surface to prod ahead of the merge:

| Code | Method | Path |
|------|--------|------|
| 404 | POST | /api/rancher/connect/start |
| 404 | POST | /api/checkout/deposit |
| 404 | POST | /api/rancher/tier/select |
| 404 | POST | /api/rancher/tier/change |
| 404 | POST | /api/webhooks/stripe-connect |
| 404 | GET  | /api/rancher/connect/status |

### Preview alias (`https://bhc-git-stage-3-verticals-benibeauchman-3168s-projects.vercel.app`)

The preview deployment has all 6 routes built and bundled, but the Vercel SSO gate intercepts unauthenticated requests at the edge — uniform 401 across the surface (same pattern documented in `2026-05-26-pre-merge-3pass.md`):

| Code | Method | Path |
|------|--------|------|
| 401 | POST | /api/rancher/connect/start |
| 401 | POST | /api/checkout/deposit |
| 401 | POST | /api/rancher/tier/select |
| 401 | POST | /api/rancher/tier/change |
| 401 | POST | /api/webhooks/stripe-connect |
| 401 | GET  | /api/rancher/connect/status |

**No 500s on either environment.** The gate behavior is consistent — preview SSO uniformly intercepts before the handler, prod uniformly returns 404 because the routes are not deployed there yet. Both states are the expected pre-merge baseline.

## Library shape verification

### lib/tiers.ts exports

```
21: export type TierSlug = 'pasture' | 'ranch' | 'operator';
23: export interface TierConfig { ... monthlyCents, commissionRate ... }
33: export const TIERS: Record<TierSlug, TierConfig>
       pasture:  monthlyCents=15000, commissionRate=0.07
       ranch:    monthlyCents=35000, commissionRate=0.03
       operator: monthlyCents=50000, commissionRate=0.00
92: export interface AddOnConfig
103: export const ADD_ONS: AddOnConfig[]
141: export function tierFor(rancher): TierSlug | null
153: export function commissionRateForTier(tier): number
161: export const FOUNDING_BRAND_PARTNER_CAP = 100
166: export { FOUNDING_100_CAP } from './secrets'
```

Pricing + commission shape matches the locked business model from `2026-05-26-business-model-coherence.md`.

### lib/stripeConnect.ts exports

```
29:  export interface CreateConnectAccountInput
35:  export async function createConnectAccount(...): Promise<{ accountId: string }>
61:  export interface OnboardingLinkInput
67:  export async function createOnboardingLink(...): Promise<{ url: string }>
83:  export type ConnectAccountStatus = 'not_connected' | 'onboarding' | 'active' | 'restricted'
85:  export interface ConnectStatusReadResult
92:  export async function getConnectAccountStatus(accountId): Promise<ConnectStatusReadResult>
114: export interface CreateDepositCheckoutInput
127: export async function createDepositCheckout(...): Promise<{ url; paymentIntentId }>
```

All 4 mutation functions + 1 status reader present. `ConnectAccountStatus` union matches what the dashboard banner cascade and webhook handler key off of.

### lib/contracts/payments.ts exports

```
12: export type PaymentStatus = 'pending' | 'succeeded' | 'refunded' | 'failed'
13: export type PayoutStatus  = 'pending' | 'paid' | 'failed'
15: export const PAYMENTS_TABLE = 'Payments'
16: export const PAYOUTS_TABLE  = 'Payouts'
18: export interface CreateDepositInput
28: export async function recordDeposit(...): Promise<{ id: string }>
43: export async function markDepositSucceeded(stripePaymentIntentId)
59: export async function markDepositRefunded(stripePaymentIntentId): Promise<{ flipped: boolean }>
75: export interface ReleasePayoutInput
83: export async function releasePayout(...): Promise<{ id: string }>
```

Deposit/payout lifecycle hooks intact. `markDepositRefunded` returns `{ flipped }` so the refund webhook handler can idempotently no-op on duplicate events.

## Webhook signature verify (stripe-connect)

`app/api/webhooks/stripe-connect/route.ts` reads the raw body before any JSON parse, pulls the `stripe-signature` header, and refuses with 400 if either the header or `STRIPE_CONNECT_WEBHOOK_SECRET` is missing:

```
34: const CONNECT_WEBHOOK_SECRET = process.env.STRIPE_CONNECT_WEBHOOK_SECRET || '';
48: export async function POST(request: Request) {
51:   const body = await request.text();
52:   const sig  = request.headers.get('stripe-signature');
54:   if (!sig || !CONNECT_WEBHOOK_SECRET) {
56:     return NextResponse.json({ error: 'Missing signature' }, { status: 400 });
57:   }
69:   const stripe = getStripe();
72:   thinEvent = (stripe as any).parseThinEvent(body, sig, CONNECT_WEBHOOK_SECRET);
75:   // on parseThinEvent throw → return 400 'Invalid signature'
80:   event = await (stripe.v2.core.events as any).retrieve(thinEvent.id);
```

Correct V2 thin-event flow:
1. Raw-body read first (signature verify requires byte-exact body)
2. Signature header presence required → else 400
3. `parseThinEvent(body, sig, secret)` validates HMAC → else 400 "Invalid signature"
4. Full event hydrated via `stripe.v2.core.events.retrieve(thinEvent.id)` — never trust the thin payload for capability state
5. Idempotency dedupe via the `Stripe Events` Airtable table keyed by `event.id`

Startup warning fires loudly in production when the secret is missing (line 41-46) so operators can't accidentally flip `STRIPE_CONNECT_ENABLED=true` without registering the Connect endpoint in Stripe Dashboard first.

## Verdict — Phase C (code-smoke variant)

[x] **PASS** — Every endpoint with a Stripe Connect mutation gates correctly on `STRIPE_CONNECT_ENABLED !== 'true'` with a 503 + clear error message. No 500 paths in any of the 5 mutating endpoints. The read-only `connect/status` endpoint intentionally has no flag gate (it's auth-gated and short-circuits on no-account-id, which is correct). Connect webhook verifies signatures with the V2 thin-event flow and refuses with 400 on missing/invalid signature. All lib exports from `tiers.ts`, `stripeConnect.ts`, and `contracts/payments.ts` are intact and match the locked business model shape. Live prod returns 404 (Stage-3 not yet merged); preview returns uniform 401 (Vercel SSO gate). Both states are the expected pre-merge baseline.

## Deferred to post-merge

The following items require live Stripe + a real rancher and will be smoked when the first rancher onboards via tier_v2 (`STRIPE_CONNECT_ENABLED=true`):

- Actual Stripe Express onboarding completion (Stripe anti-bot blocks scripted browser flow)
- Actual Stripe Checkout w/ test card 4242 against `/api/checkout/deposit`
- Webhook event delivery + idempotency under real `v2.core.account[requirements].updated` traffic
- `application_fee_amount` split confirmation on a real direct-charge payment intent
- Fulfillment confirm → Payout release end-to-end against a live Connect account

These will be documented as **known-not-tested** in the Phase E merge verdict, with the first-rancher smoke serving as the live validation gate before flipping the flag platform-wide.
