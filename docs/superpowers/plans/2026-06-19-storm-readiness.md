# BHC Storm-Readiness Plan

> Source: storm-readiness workflow (7 agents) 2026-06-19. The execution bible for ad-launch P0s + closed-loop integration. Owner setup tagged [OWNER]; eng builds [ENG].

---

Report #5's break #2 confirmed exactly: the Connect webhook handles `account.updated`, disputes, `payout.failed`, `charge.refunded` — but has **NO** `payment_intent.succeeded` / `checkout.session.completed` / `buyer_deposit` / `final_invoice` case. Direct charges fire PI on the connected account (line 331 `stripeAccount` header), yet the only handler lives in the platform webhook. The `orphan-checkout-reaper` safety net exists. So this is a real, fragile, config-only single-point-of-failure on every dollar.

I have enough verified ground truth to synthesize decisively. All six reports cross-checked; the contradictions are resolved (slugs are live, not dead; the Purchase gap is real; the cron is genuinely missing). Writing the plan now.

# BHC STORM-READINESS PLAN
**Synthesis of 6 verification reports · prepared 2026-06-19 · for $6k ad push + merch + 2 equity partners**

Mandate: a closed-loop, internally-integrated, mobile-first platform that controls money flow. Below is the decisive build queue. I independently verified every load-bearing claim against the code before ranking it — where reports disagreed, the verdict reflects what the code actually says, noted inline.

**Owner-setup items (accounts/credentials/DNS) are tagged `[OWNER]`. Engineering builds are tagged `[ENG]`.** Nothing else is fluff — every line moves money or readiness.

---

## 1. STORM-READINESS SCORECARD

**Verdict: CONDITIONAL GO — do NOT turn on the $6k until the 4 P0s in §2 land.** The platform is far more built than a typical pre-ad startup (live Pixel+CAPI, a real Stripe Connect closed loop for tier_v2, a never-throw booking resolver, strong cron safety nets). But the ad money will optimize against the wrong signals and leak through known holes until the critical path is closed.

| Area | RAG | One-line reason (verified) |
|---|---|---|
| **Closed-loop integration** | 🟠 AMBER | Front half (ad→qualify→match→intro→call) is well-closed on-platform. Money half leaks: legacy Payment Links (off-platform, $0 commission, zero signal) + 5 hardcoded `cal.com` anchors bypassing the SSOT resolver. Centralization primitives (`/go`, `/r`, `getOperatorBookingUrl`) exist but booking/pay aren't wrapped. |
| **Cal native embed** | 🟡 AMBER-GREEN | ~70% plumbed: `@calcom/atoms@2.11.0` installed, `CalAtomsProvider` built, OAuth start/callback/refresh routes live, webhook HMAC+dedup+tie-back done. Blocked on ONE owner confirmation (Platform vs standard OAuth) + mounting `<Booker>`. Current iframe is a defensible interim — buyer never navigates away. |
| **Ad tracking** | 🔴 RED | Pixel+CAPI live and correct, BUT (a) Closed-Won fires **no Purchase** (verified: `recordClose` at `stripe/route.ts:366` has no `fireCapi`; only deposit/brand/founder fire it) → true ROAS under-reported by the balance on every won deal; (b) the **ad landing page (BuyerFunnel) fires zero client Pixel** (verified: 0 imports of `lib/analytics`). Meta optimizes blind on your highest-value event. |
| **Money flow** | 🟠 AMBER | tier_v2 Connect direct-charge loop is real and has flipped referrals in prod. BUT deposit + final-invoice settlement depends on an **undocumented webhook-routing config with no in-code guard** (verified: Connect webhook has no `payment_intent.succeeded` case — only platform webhook does; direct charges fire PI on the *connected* account). Single point of failure on every dollar. Legacy Payment Links leak entirely. |
| **Partner tooling** | 🔴 RED (ads) / 🟡 AMBER-GREEN (onboarding) | **Shared blocker: no scoped access** — single `ADMIN_PASSWORD` → `{role:'admin'}` (verified `adminAuth.ts:58`). Giving either partner access hands them refund power + email blaster + all buyer PII. Onboarding is ~80% tooled (Kanban + migration tracker + impersonate). Ads partner can't attribute below a 5-value Source bucket and has zero spend/ROAS. |
| **Verified stability** | 🟢 GREEN | Both prior "revenue-killing" alarms are FALSE on impact once consuming code is traced: Q8 gate killed **0** buyers; counter-drift is real (Ashcraft 1 vs 38) but Redis is the authoritative cap and self-heals daily — harm is over-route risk + wrong dashboards, not stranded buyers. No new silent money break. **The slugs are LIVE (200s), not dead** — the "41 ranchers 404'd" incident is resolved. |

**The single most important correction to the owner's mental model:** the problem is **NOT dead links** (every `cal.com/ben-beauchman-1itnsg/*` slug returns 200 — independently re-verified). The problem is **off-platform fragmentation + ad-signal blindness + a fragile money-routing config**. Build against the real problem, not the stale incident.

---

## 2. THE CRITICAL PATH TO AD-LAUNCH

These gate the $6k. Each one, left undone, directly wastes spend or leaks money. Ranked by dollar-impact. **Total: ~3–4 engineering days + 2 owner actions that can happen in parallel today.**

| # | What | Why it BLOCKS launch | Effort | Unblocks |
|---|---|---|---|---|
| **P0-1** `[ENG]` | **Fire `Purchase` (CAPI) at Closed-Won.** In `stripe/route.ts` `final_invoice` branch (after `recordClose`, ~line 388) add `fireCapi([{event_name:'Purchase', event_id: metaEventId(referralId), value: closeSaleAmount, action_source:'system_generated', ...}])`. | Your highest-value, longest-cycle conversion is **invisible to Meta**. Today Purchase fires only at the refundable deposit (a fraction of cart value). Meta will optimize toward micro-commitments and under-report ROAS by the balance on every deal. This is the exact long-cycle case CAPI exists for — and it's the one event missing. | **S** | True ROAS; correct optimization target |
| **P0-2** `[ENG]` | **Wire client Pixel into BuyerFunnel.** In `BuyerFunnel.submitStorage` after qualify-200, call `trackEvent('access_quiz_submit',{event_id:consumerId})`; add a `Lead`/`ViewContent` on mount; reuse the already-minted `eventId`/`consumerId` so it dedups with the server fire. | The page your $6k drives to fires **zero browser-side conversions** (verified). Meta's in-browser audience-building and optimization are starved; the mid-funnel retargeting pool never populates browser-side; the `access_quiz_submit→Lead` map is dead code. | **S** | Browser-side optimization + all retargeting audiences |
| **P0-3** `[ENG]` | **Pick & set ONE optimization event and make client+server agree on `event_name`+`event_id`.** Recommend the **qualified-buyer `Lead`** (fire `Lead` at `qualify/route.ts:361` alongside the existing `CompleteRegistration`; add the missing `Lead` server fire to the `quizStarted` branch that currently returns at `consumers/route.ts:230` before the Lead fire). Decide the value model: **demote deposit-Purchase to `InitiateCheckout`, make Closed-Won the sole `Purchase`** (cleanest true-ROAS) — OR keep deposit-Purchase + add Closed-Won as a separate `PurchaseComplete` custom event (balance only). Do this consciously to avoid double-counting revenue. | Without a single declared objective event firing identically on both sides, Meta either double-counts or optimizes on noise. The ads partner cannot configure the campaign objective coherently. | **S** | Coherent campaign setup; no revenue double-count |
| **P0-4** `[ENG]` | **Harden the money-routing single point of failure.** Add the `buyer_deposit`/`final_invoice` PI cases to the **Connect** webhook too (idempotent via the shared Stripe Events table + `markDepositSucceeded`'s own guard → dual delivery is safe). Document which endpoint is subscribed to `payment_intent.succeeded` on connected accounts. Surface `orphan-checkout-reaper`'s `requires_webhook_replay` count on the admin desk. | When you 3× traffic, any drift in the undocumented webhook subscription means **deposits succeed in Stripe but referrals never flip to Awaiting Payment/Closed Won** — money lands in the rancher's account with no on-platform state, silently. Today's config is correct but unguarded; ad volume is exactly when a silent break is most expensive. | **M** | Settlement survives endpoint/secret drift |

**Owner actions to start NOW (parallel, off the eng critical path):**

| # | What | Why before launch |
|---|---|---|
| **P0-O1** `[OWNER]` | **Confirm with your Cal.com contact: Platform plan (managed users + Atoms) OR standard OAuth client?** And get per-booking pricing ($0.50–$0.99/booking over quota) in writing. | Governs the entire Cal native build (§3). Platform is **closed to new signups** — your approval is the only thing keeping it open. If it's standard-OAuth-only, the native `<Booker>` collapses to the iframe fallback. This is a blocker for §3, not §2 — but the answer takes days to get, so start today. |
| **P0-O2** `[OWNER]` | **Decide the campaign channel(s).** If **Meta-only**: GA4/Google Ads being dark is a non-blocker. If the $6k touches **Google/YouTube/PMax**: set `NEXT_PUBLIC_GA4_ID` + `NEXT_PUBLIC_GOOGLE_ADS_ID` in Vercel → that becomes a P0 for that channel (today both are unset → zero Google tracking). | Determines whether 2 more items enter the critical path. TikTok pixel likewise only if TikTok is in the plan (none today). |

**Week-1 (not launch-gating, but do immediately after):** verify dedup live in Meta Events Manager Test Events (`META_CAPI_TEST_CODE` supported); one Lighthouse-mobile pass on `/access` + `/access/[state]` to confirm LCP <2.5s before scaling spend.

---

## 3. CAL NATIVE EMBED — the approved-API integration

**Governing fact:** ~70% is already in the repo. The work is mounting `<Booker>` and confirming the product. **Gate everything on P0-O1.**

### IF Platform / managed users confirmed → native build

**`[OWNER]` setup (one-time):**
1. **Env (Vercel):**
   - `NEXT_PUBLIC_CAL_OAUTH_CLIENT_ID` = your Platform OAuth client ID (public-safe; read at `CalAtomsProvider.tsx:21`)
   - `CAL_OAUTH_CLIENT_ID` = same, server-side (`lib/cal.ts:36`)
   - `CAL_OAUTH_CLIENT_SECRET` = the `x-cal-secret-key` (server-only; mints managed users + token refresh)
   - **NEW:** `CAL_OPERATOR_USERNAME`, `CAL_OPERATOR_SALES_EVENT_SLUG`, `CAL_OPERATOR_RANCHER_EVENT_SLUG` — stable identifiers so the buyer-facing `<Booker>` doesn't depend on a runtime `/me` lookup and we kill the fragile `selectEventForPurpose` slug-guessing.
   - Keep existing: `CAL_API_KEY`, `CAL_WEBHOOK_SECRET` (already set), `CAL_RANCHER_EVENT_TYPE_ID`.
2. **Cal dashboard:** in the Platform OAuth client, set Redirect URIs → `https://www.buyhalfcow.com` (+ Vercel preview wildcard); set booking/reschedule/cancel redirect URLs → BHC pages (e.g. `/book/confirmed`).
3. **Run the one-time managed-user mint** (script, below) to create the operator managed user.

**`[ENG]` build:**
- **Mint operator managed user** (one-time server script): `POST api.cal.com/v2/oauth-clients/{clientId}/users` with `x-cal-secret-key` → store `id`/`accessToken`/`refreshToken` (Airtable already has `Cal OAuth Access/Refresh Token`, `Cal User ID` fields). Provision its two event types (Sales 15-min, Rancher Onboarding 45-min) via existing `lib/cal.ts` helpers.
- **`app/book/[refId]/page.tsx`** (server): resolve consumer by `refId`; decide operator-vs-rancher; look up `username`/`eventSlug` (from `CAL_OPERATOR_*` env or the rancher's connected username); pass buyer name/email for prefill; wrap in `<CalAtomsProvider accessToken={undefined}>` for **public** bookings (no token needed — verified in Cal source: `BookerPlatformWrapper` renders regardless of session for public bookings).
- **`BookerNative.tsx`** (client): mount `<Booker username eventSlug defaultFormValues={{firstName,lastName,email}} metadata={{referralId}} onCreateBookingSuccess={...}>`. **Note the API shape change** — atoms use `defaultFormValues.firstName/lastName/email`, NOT the iframe's flat `name`/`email`; you must split the buyer's full name. Style via `customClassNames` + existing `cal-brand` token.
- **Extend `/api/auth/cal/refresh`** with an operator branch (today it only refreshes the session-rancher's token via `resolveRancherSession`; public/operator booker calls have no session → would 401).
- **Reuse as-is:** `CalAtomsProvider.tsx`, `app/api/webhooks/cal/route.ts`, `lib/cal.ts` helpers.
- **Webhook wiring:** register the webhook on the operator managed user (or at OAuth-client level so all managed users inherit one subscriber → `/api/webhooks/cal`). **Verify `metadata.referralId` survives** the atoms `metadata` prop → webhook `payload.metadata` round-trip.
- **Lazy-mount `<Booker>`** — `@calcom/atoms` pulls a heavy peer set (framer-motion, react-query, multiple radix, stripe-js). `CalAtomsProvider` already scopes it to Cal routes; do NOT wrap the whole app or buyer-funnel pages inherit Cal's CSS/JS.

**Risk flags:** 🔴 Platform plan closed to new signups (your approval is the lifeline). 🟠 AGPL-3.0 on `@calcom/atoms` — **fine as an npm consumer; do NOT self-host/modify Cal to dodge per-booking fees** (that's what actually triggers the EE license). 🟠 per-booking cost — model against the $6k. 🟡 carry the API-version split forward (`/event-types` needs `cal-api-version: 2024-06-14`; `/me`+`/bookings` use `2024-08-13`).

### IF standard-OAuth-only → keep the iframe (defensible interim)
The existing `CalInlineBooker.tsx` (Cal's `embed.js`, `layout: month_view`, prefilled `name`/`email`/`metadata[referralId]`) keeps the buyer visually on-page. The native upgrade is a branding/polish win, not a functional unlock. Still do §4 (route email/SMS links through an on-site `/book/[refId]` page that renders the iframe), which delivers the "lands back on buyhalfcow.com" business goal regardless of native vs iframe.

---

## 4. CLOSED-LOOP INTEGRATION PLAN — every external pointer → on-platform replacement

**Build the spine first, then repoint, then fix the source.** The booking analog of `/r/<code>` is the keystone: one `/book/[refId]` page kills every `cal.com` anchor in one move.

**Sequence:**

**Step 1 `[ENG]` — Build `/book/[refId]`** (same page as §3 route 2). Server-resolves the right Cal event via `getOperatorBookingUrl` (operator/discovery) or rancher slug; embeds first-party (native `<Booker>` if Platform, else iframe); prefills name/email/`metadata[referralId]`; existing `/api/webhooks/cal` ties back. **This is the centralization keystone.**

**Step 2 `[OWNER+ENG]` — Set the SSOT env immediately (ahead of page work).** Point `CAL_RANCHER_BOOKING_URL` / `CAL_SALES_BOOKING_URL` at the new `/book` page. The resolver (`overrideForPurpose`, verified at `calBooking.ts:201`) was built for exactly this and the env hooks exist but are **unset** — so today even the "centralized" path emits a raw `cal.com` URL. One env change centralizes every *email* booking link instantly. `[OWNER]` sets the env; `[ENG]` confirms the override path.

**Step 3 `[ENG]` — Repoint + delete hardcoded slugs.** These bypass the SSOT and are the literal slugs the stale incident feared:

| Surface | Current | → Replacement |
|---|---|---|
| Public ranch page CTA (`ranchers/[slug]/page.tsx:155-161`) — primary organic buyer entry | hardcoded `cal.com/.../sales` or `cal.com/<slug>` | server-resolve `getOperatorBookingUrl('sales')` → `/book` |
| Apply success (`ApplyForm.tsx:115-121`) — every new rancher | hardcoded `.../15min` iframe | `getOperatorBookingUrl('rancher')` → `/book` |
| Partner success (`partner/page.tsx:228`) | hardcoded `.../30min` new tab | resolve → `/book` |
| Setup wizard (`RancherSetupWizard.tsx:157,2376`) | `const CALENDLY_LINK='cal.com/.../30min'` | server-resolved prop → embed |
| Buyer intro email (`email.ts:1309`) | inline `cal.com/${slug}` | `/book/[refId]` on-site |
| Self-submit welcome (`email.ts:364,4051`) | env slug const | default to resolver / repoint env at `/book` |
| Admin desk (`DeskClient.tsx:293`) | hardcoded `.../sales` | low priority; read resolver for consistency |
| Qualify funnel (`CalInlineBooker.tsx`) + `BuyerFunnel.tsx:735` | iframe | native `<Booker>` (if Platform) |

**Principle:** on-site surfaces → native `<Booker>` (no redirect); email/SMS/Telegram (can't embed React) → swap raw `cal.com/...` for `https://www.buyhalfcow.com/book/<refId>`. **Keep `getOperatorBookingUrl` as the always-200 fallback** — that never-throw discipline (born from the 41-rancher incident) must survive; the native booker degrades to this link if atoms fail.

**Step 4 `[ENG]` — Bring money flow on-platform.** Extend `/pay/[tier]` → `/pay/reserve`; route the public ranch page's Reserve + product + tier CTAs through it (`ranchers/[slug]/page.tsx:866-868,910-919`); upgrade the wrapper destination from raw `buy.stripe.com` to `/checkout/[refId]/deposit` (Stripe Connect on-site) wherever the rancher is on Connect. For legacy ranchers on Connect `active`, **hide the raw Payment Link CTA**; for the rest, treat a Payment Link click as an unconfirmed-sale signal (stamp the Referral + nudge the rancher) so at least a return signal exists.

**Step 5 `[ENG]` — Fix the source of the leak.** Flip rancher payment config from "paste your `buy.stripe.com` link" to **Stripe Connect price entry** (`RancherSetupWizard.tsx:1542-1546`, `rancher/page.tsx:2106-2180`). The `/checkout/[refId]/deposit` rails already exist via `lib/stripeConnect.ts`. Make on-platform checkout the default, external link the fallback. **This stops new ranchers from re-introducing the problem.**

**Step 6 `[ENG]` — Close the fulfillment tail.** Add a real `Fulfilled`/`Delivered` Status (+ reverse mapping) so the `lib/deal/` state machine's `DELIVERED` stops colliding with `Slot Locked`; drive fulfillment-confirm through `transition()`; add a "slot-locked >N days, no Fulfillment Confirmed At" cron nudge; add a Fulfillment lane to the admin desk. Also implement the `onDealEvent` no-op stub (for "money landed → notify rancher" with Redis `last_notified_state` idempotency) and map `'Refunded'`→terminal `REFUNDED`.

**Acceptable, do-NOT-touch (verified):** `dashboard.stripe.com` admin Telegram links; `mailto:`/`tel:` degradation fallbacks; `hostedInvoiceUrl` receipts; social links; empty `STRIPE_*_LINK` envs (fall back to on-site pages — not leaking).

---

## 5. AD-TRACKING PLAN — attribution that survives the long cycle

**What's already correct (don't rebuild):** Meta Pixel + server CAPI live in prod (6s timeout, SHA-256 PII, `_fbp`/`_fbc` capture, Telegram alerting); clean `metaEventId(recordId)` dedup convention; `Lead`/`CompleteRegistration`/`InitiateCheckout`/`Schedule` + Purchase-at-deposit/brand/founder all fire; SPA PageView fix; first-touch UTM/fbclid/gclid capture site-wide; genuinely mobile-first funnel.

**The conversion-event target map (fire CAPI at each CRM milestone — Meta accepts events up to 62 days post-event; the Offline API retired May-2025, everything now goes through the main CAPI you already have):**

| Milestone | Location | Client | Server CAPI | event_id | value | Status |
|---|---|---|---|---|---|---|
| Lander view | `/access` mount | `ViewContent` | — | — | — | **ADD** (P0-2) |
| Contact captured | `consumers/route.ts:230` | `Lead` | `Lead` | `consumerId` | 0 | **ADD both** (P0-2/3) |
| **Qualified** | `qualify/route.ts:361` | `Lead` | `CompleteRegistration` (+`Lead`) | `consumerId` | est. deposit | client **missing** (P0-2) |
| Deposit paid | `stripe:511` | Purchase ✅ | Purchase ✅ | `referralId` | deposit+fee | ✅ (demote to `InitiateCheckout` per P0-3 value model) |
| **Closed Won** | `stripe:366` (final_invoice) | — | **Purchase** | `referralId` | `closeSaleAmount` | **MISSING — P0-1** |

**Persist structured attribution (ads-partner enabler, also half-day):** `UtmCapture` captures full `utm_campaign/content/term`+`fbclid`+`gclid` into localStorage `bhc_source_v2`, but signup writes only a 5-value `Source` string. Partial structured cols now exist (verified: manychat writes `utm_campaign`/`fbclid` at lines 656-657) but the main consumer-create path still collapses to `Source`. **Add `utm_campaign/utm_content/utm_medium/fbclid/gclid` columns and write `bhc_source_v2` through on signup** (`consumers/route.ts:484,538`). This unlocks ad-level breakdown + offline-conversion upload on close (P0-1 already has the click-id available once stored).

---

## 6. VERIFIED FACTS — only the confirmed items (overstated ones discarded)

**Both prior "revenue-killing" alarms are FALSE on impact. Kept as confirmed; fixes are low-priority hardening, NOT launch blockers.**

- **Q8 gate (Email/State guard) — FALSE ALARM on impact; latent bug real, blast radius ZERO.** Of 2132 consumers, 77 are qualified; only **2** are missing State, both scored <75 → hit the sub-75 nurture branch and **never reached the line-210 gate**. Score ≥75 AND missing Email/State = **0**. The "~124 killed" was a data-shape overstatement. **It has never killed a single routed buyer.** *Optional defensive fix:* at `qualify/route.ts:210`, when score≥75 but State/Email missing, set `Qualification Path='needs_profile'` + fire the existing Telegram instead of silently stamping success.

- **Counter-drift — REAL and chronic, but capacity is NOT blinded.** Confirmed against ground truth: Ashcraft `Current Active Referrals`=1 vs actual 38; `capacity-drift-check` "fixes" ~12 ranchers every run. **Root cause:** two reconcilers fight — `batch-approve` (09:00) counts 4 statuses, writes **Airtable only**; `capacity-drift-check` (12:00) counts 5 statuses, writes **Redis+Airtable** → never converge. **But the authoritative cap gate is the Redis INCR** (`suggest/route.ts:708`) with post-INCR rollback (`:753`), and Redis is force-corrected daily. Harm = mild over-route risk + wrong dashboards/Telegram counts, **NOT stranded buyers**. *Fix (real, cheap):* align `batch-approve:47` to the same 5 slot-holding statuses (`Intro Sent, Rancher Contacted, Negotiation, Awaiting Payment, Slot Locked`) and replace its Airtable-only write at `:74-76` with `setCapacityCounter(rancher.id, actual)` so Redis+Airtable can't diverge. Stops the daily fix-every-run thrash.

- **Dead links — RESOLVED, not a problem.** Independently re-verified: `cal.com/ben-beauchman-1itnsg/{30min,sales,15min}` all return **200** (control `nonexistent-xyz` → 404). The "41 ranchers 404'd" incident headers littering the repo are stale. **Build against fragmentation, not dead links.**

- **`/api/ranchers/capacity-check` — dead code** (verified: not in vercel.json crons, zero callers). Reads the drifted field but never runs. Delete or wire; not breaking anything today.

**Discarded as overstated:** "~124 qualified buyers killed" (actual 0); "capacity-blinding strands buyers" (Redis is authority, self-heals); "20 external cal links" (actual 5 hardcoded URLs); the deposit-401 concern (qualify mints `bhc-member-auth` on quiz pass — path intact). No new silent money-path break exists beyond the P0-4 routing fragility.

---

## 7. PARTNER ENABLEMENT

**THE shared blocker (build first): scoped roles.** Verified — `adminAuth.ts:58` checks only `claims.role === 'admin'`; one `ADMIN_PASSWORD` is all-or-nothing. Today the only way to give either partner access hands them refund power + the email blaster + bulk-send + every buyer's PII.

**`[ENG]` Build #0 (unblocks both):** add a second role dimension to the JWT (`role: 'ads' | 'onboarding' | 'admin'`) and per-section gating in `requireAdmin`. Minimal: ads → analytics/funnel/heatmap **read-only**; onboarding → ranchers tab + `/admin/migration` + `/admin/ranchers/[id]` + impersonate, **without** Commissions/Payments/Broadcast/refunds. Add a per-actor action log (Bulk Invite/Reactivation/impersonate currently fire real sends behind only a `confirm()`).

### Ads Partner (bigger build — they can work inside Meta/Google today, but BHC can't attribute below a 5-value bucket)
1. `[ENG]` **Persist UTM/click-id columns** (shared with §5) — half-day, unlocks everything below.
2. `[ENG]` **Ad-level breakdown** in `/admin/analytics` — pivot the existing Source table by `utm_campaign → utm_content`. Trivial once #1 lands.
3. `[ENG]` **Offline conversion export** — on Closed Won, send Purchase CAPI with stored `fbclid`/`gclid` + sale value (same code path as P0-1; `metaCapi.ts` already supports `action_source:'system_generated'`).
4. `[ENG]` **Spend input + ROAS column** — even a manual "daily spend per campaign" field computes real CAC/ROAS against closes (no spend/ROAS read exists anywhere today). Full Meta Insights API pull is v2.
5. `[ENG]` Scoped **ads role** (Build #0).

### Onboarding Partner (~80% tooled — fastest wins)
1. `[ENG]` **Surface `nightly-rancher-audit` + stalled digest as an admin UI page** — the data is already computed and returned as JSON; it just posts to the owner's Telegram, not a UI. **Highest leverage, lowest effort** — instantly gives the partner the same "what needs attention" the owner gets.
2. `[ENG]` Scoped **onboarding role** (Build #0).
3. `[ENG]` **One unified onboarding worklist** merging pre-v2 Kanban (`/admin`) + tier_v2 (`/admin/migration`) into a single "stuck ranchers, next action" board sorted by days-stuck (state is currently split across two surfaces + per-rancher page).
4. `[ENG]` **Ship `connect-stuck-nudge` cron** — verified **absent on disk**; Connect-KYC stalls (the most common tier_v2 stall) have no automated nudge. Mirror the existing `onboarding-stuck` pattern.
5. `[ENG]` **Auto-send the Express Connect link** via the existing email/SMS layer (operator currently copy-pastes a raw token URL manually — closes the "on buyhalfcow.com" loop).

---

## 8. BUILD SEQUENCE — today → storm-ready

Phases are ordered by dependency. **`∥` = parallelizable within the phase.**

### PHASE 0 — TODAY (owner, parallel, off eng critical path)
- `[OWNER]` **P0-O1**: email Cal contact — Platform vs standard OAuth? + per-booking pricing. *(governs §3)*
- `[OWNER]` **P0-O2**: decide ad channel(s). If Google in plan → set `NEXT_PUBLIC_GA4_ID`+`NEXT_PUBLIC_GOOGLE_ADS_ID` in Vercel.
- `[OWNER]` **Step-2 env**: set `CAL_RANCHER_BOOKING_URL`/`CAL_SALES_BOOKING_URL` (can point at iframe `/book` initially).

### PHASE 1 — AD-LAUNCH CRITICAL PATH (gates the $6k; ~3–4 eng days)
All four are largely independent — `∥`:
- `[ENG]` **P0-1** Purchase at Closed-Won `∥`
- `[ENG]` **P0-2** client Pixel in BuyerFunnel `∥`
- `[ENG]` **P0-3** single optimization event + value model (depends lightly on P0-1/2 landing) 
- `[ENG]` **P0-4** Connect-webhook PI cases + reaper count on desk `∥`
- `[ENG]` **UTM/click-id columns** (shared §5/§7) `∥` — do here; it's half a day and unblocks offline conversions + ads partner.

**→ GATE: verify dedup in Meta Test Events + Lighthouse-mobile LCP <2.5s → TURN ON $6k.**

### PHASE 2 — CLOSE THE LOOP (immediately after launch; runs while ads spend)
- `[ENG]` **Step 1** build `/book/[refId]` keystone *(blocked on P0-O1 only for native-vs-iframe; build the page either way)*
- `[ENG]` **Step 3** repoint + delete 5 hardcoded slugs → `/book` `∥` (after Step 1)
- `[ENG]` **Partner Build #0** scoped roles `∥` (independent — unblocks both partners)
- `[ENG]` **Onboarding #1** render nightly-audit as a page `∥` (independent, highest-ROI partner win)

### PHASE 3 — MONEY-FLOW ON-PLATFORM + PARTNER TOOLING
- `[ENG]` **Step 4** `/pay/reserve` + route ranch-page CTAs → Connect checkout
- `[ENG]` **Step 5** flip rancher config to Stripe Connect price entry *(stops the leak at source)*
- `[ENG]` **Ads #1–4** UTM breakdown → offline export → spend/ROAS `∥`
- `[ENG]` **Onboarding #3–5** unified worklist, ship `connect-stuck-nudge`, auto-send Connect link `∥`

### PHASE 4 — HARDENING (close the tail; not launch-blocking)
- `[ENG]` **Step 6** Fulfilled/Delivered state + fulfillment cron nudge + admin lane; implement `onDealEvent`; map `Refunded`
- `[ENG]` Align `batch-approve` reconciler to 5 statuses + `setCapacityCounter` *(stops daily drift thrash)*
- `[ENG]` Q8 defensive guard (`needs_profile` + Telegram); delete dead `/api/ranchers/capacity-check`

---

**Bottom line for the owner:** You are a **CONDITIONAL GO**. Four small-to-medium engineering fixes (Purchase-at-close, funnel Pixel, one optimization event, Connect-webhook hardening) + one Cal email + one channel decision stand between you and safely turning on the $6k — call it **3–4 eng days plus two things you can start this morning.** The platform is in far better shape than the "everything points elsewhere" feeling suggests: the slugs are alive, the tier_v2 money loop is real, and the stability alarms were false. The actual work is (1) make Meta see your real revenue, (2) route every link back through one on-site `/book` page, (3) flip ranchers off external Payment Links at the source, and (4) give your two partners scoped seats so you're not handing out the master key. Build it in that order.

**Key files:** `app/api/webhooks/stripe/route.ts` (final_invoice `:330-390`, Purchase fires `:511/1154/1368`) · `lib/contracts/rancher.ts` (`recordClose:41`, no internal CAPI) · `app/components/funnel/BuyerFunnel.tsx` (no client pixel) · `lib/metaCapi.ts` · `lib/analytics.ts` · `app/api/qualify/route.ts:210,361` · `app/api/consumers/route.ts:230,484,538` · `lib/calBooking.ts` (`getOperatorBookingUrl:247`, `overrideForPurpose:201`) · `app/rancher/cal/CalAtomsProvider.tsx` · `app/qualify/[consumerId]/CalInlineBooker.tsx` · `app/api/auth/cal/{start,callback,refresh}/route.ts` · `app/api/webhooks/{stripe-connect,cal}/route.ts` (Connect has no PI case) · `lib/stripeConnect.ts:331` · `app/api/cron/{batch-approve:47,capacity-drift-check:81}/route.ts` · `connect-stuck-nudge` **absent** · `lib/adminAuth.ts:58` · `app/admin/{page,migration/page,ranchers/[id]/page}.tsx` · `app/api/cron/nightly-rancher-audit/route.ts`.