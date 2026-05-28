# Resume Checkpoint — Stage-3 Stripe Connect + Tiered Pricing
**Saved:** 2026-05-25 (after mockup tour shipped)
**Branch:** `stage-3-verticals` (NEVER merged to main)
**Last commit on branch:** `994d5f8` — feat(mockups): storybook tour — 18 static HTML mockups
**Last commit on main:** `e322064` — docs: stage-3 platform vertical architecture plan

---

## ⏱ Execution progress checkpoint (auto-updated)

**Tasks shipped via subagent-driven dispatch:**

| # | Task | Commits |
|---|------|---------|
| 2 | lib/tiers.ts source of truth | `21a54f8` + `42d4b30` fix |
| 7 | Stripe Connect V2 onboarding | `37f252a` |
| 4 | Tier subscription endpoints | `9f33ffa` |
| 5 | Tier checkout + /rancher/billing UI | `baf717a` + `85868b1` fix |

**Up next:** Task 6a (subscription webhooks) → Task 8 (buyer deposit) → Task 6b (payment webhooks) → Task 9 (fulfillment confirm + payout) → Task 11 (setup wizard + banners) → Task 11.5 (legacy opt-in) → Task 12 (admin payments) → Task 10 (add-ons). Then Phase 2 infra parallel.

**Process per task:** implementer → spec-reviewer → code-quality-reviewer → mark complete. Deferred NITs (rate limits, funnel emits) tracked for end-of-Phase-1 cleanup pass.

---

## 30-second resume orientation

Read this section first if picking up cold.

**Mission:** Build BuyHalfCow's 3-tier rancher subscription model (Pasture $150/7%, Ranch $350/3%, Operator $500/0%) on Stripe Connect V2 API, layered on a 4-vertical architecture refactor. Legacy 64 ranchers grandfathered on old 10%-post-close model. Existing performers protected. New signups required to pick tier.

**Where we are RIGHT NOW:**
- ✅ Architecture baseline complete (Tasks 0-10 + hardening): 4 verticals, contracts module, funnel telemetry, in-platform messaging (Threads + buyer ask + rancher inbox + inbound email routing)
- ✅ Stripe products + prices created (6 prices LIVE in Stripe — see "Stripe IDs" below)
- ✅ Airtable schema additions (18 new Ranchers fields + 4 new tables — see "Airtable IDs" below)
- ✅ 64 existing ranchers backfilled `Pricing Model='legacy'` — protected from new flow
- ✅ Storybook mockup tour (18 screens) shipped for visual review

**Where we GO NEXT:**
- Awaiting user review of mockups at `docs/mockups/2026-05-25-stripe-flow/index.html`
- After mockup approval → Task 2 (lib/tiers.ts source of truth) via subagent
- Then Tasks 3-16 sequentially via subagents
- Tasks 17-24 are research-backed infra (onboarding analytics, peak-end celebration, loss-aversion nudge, abandoned recovery, UTM attribution, webhook idempotency, backup cron, Stripe Tax)

**Production state:** Untouched. `main` has zero stage-3 code. `STRIPE_CONNECT_ENABLED=false` everywhere. Buyers + ranchers see the OLD flow exactly as last week.

---

## Critical IDs (locked for downstream code)

### Stripe — LIVE mode on `acct_1TSn5PGTWWNqassH` (BUYHALFCOW)

**Tier subscriptions (recurring monthly):**
- Pasture · `prod_UaDjcxTLJgoblh` · price **`price_1Tb3IWGTWWNqassHaIvpNXeC`** · $150/mo
- Ranch · `prod_UaDkkVbIpp1ceb` · price **`price_1Tb3IyGTWWNqassHynt7qAJn`** · $350/mo
- Operator · `prod_UaDkDg1aeV38mO` · price **`price_1Tb3JLGTWWNqassH0UPyua3j`** · $500/mo

**Add-on one-off products:**
- Video Shoot · `prod_UaDlkbPgjnQmOj` · price **`price_1Tb3JhGTWWNqassHXZ8nSuW5`** · $2,500
- Photo Refresh · `prod_UaDlRFwseE37T8` · price **`price_1Tb3K4GTWWNqassHvTC4w9KE`** · $1,500
- Founder Letter · `prod_UaDljHPDbVVmSF` · price **`price_1Tb3KPGTWWNqassHdBaWY8Z8`** · $750

**3 perm-test products to delete during cleanup:** `prod_URhMlTT4gOV6IO`, `prod_URh8Ib9Edjglxf`, `prod_URh61K4OzhZJGD`

**Env vars to set on Vercel Preview (NOT prod) before Task 4 ships:**
- `STRIPE_PASTURE_PRICE_ID=price_1Tb3IWGTWWNqassHaIvpNXeC`
- `STRIPE_RANCH_PRICE_ID=price_1Tb3IyGTWWNqassHynt7qAJn`
- `STRIPE_OPERATOR_PRICE_ID=price_1Tb3JLGTWWNqassH0UPyua3j`
- `STRIPE_ADDON_VIDEO_PRICE_ID=price_1Tb3JhGTWWNqassHXZ8nSuW5`
- `STRIPE_ADDON_PHOTO_PRICE_ID=price_1Tb3K4GTWWNqassHvTC4w9KE`
- `STRIPE_ADDON_FOUNDER_LETTER_PRICE_ID=price_1Tb3KPGTWWNqassHdBaWY8Z8`
- `STRIPE_CONNECT_WEBHOOK_SECRET=<from Stripe Dashboard after Connect endpoint created>`
- `STRIPE_CONNECT_ENABLED=true` (PREVIEW ONLY — keep prod at `false` until Task 16 canary phase 3)

### Airtable — base `appgLT4z009iwAfhs`

**Existing tables:**
- Ranchers: `tbl08y9Be45zNG0OG`
- Consumers: `tblAbjQDnLrOtjpoE`
- Referrals: `tblBfimb4Gt8C0fu4`

**Pre-Stage-3 tables (already wired):**
- Threads: `tblIuMAlScXBTNF5w`
- Thread Messages: `tbl5ORgGghoqabyXr`
- Funnel Events: `tblpm57rUJJT103l2`

**New Stage-3 tables (Task 1):**
- Payments: `tblPfESJ4lxwtGThy`
- Payouts: `tbl2lEnCbz0o3VqbH`
- Add-On Purchases: `tblebGHKDzRMc9epT`
- Stripe Events: `tblPiw7jB7Mm7OxeN`

**18 new Ranchers field IDs:**
- Pricing Model · `fldaIFuo7rCSQvHP6`
- Tier · `fldPY17Titdz4S0EN`
- Stripe Subscription Id · `fldJaOgCoQNkHuuMl`
- Subscription Status · `fldapRsuf6ITnWJkV`
- Subscription Started At · `fldR3vip22BKA6wEV`
- Subscription Next Invoice At · `fldP6ZkH4QreqlFy9`
- Stripe Connect Account Id · `fldrUOFCKOXQBA40x`
- Stripe Connect Status · `fldTdzuQp2sYIlsqV`
- Stripe Connect Connected At · `fldaofYC2bcbhLWlX`
- Fulfillment Types · `fldvaMCn1ZlAP66OA`
- Pickup City · `fld8mbzIPdZh1NPna`
- Delivery Radius Miles · `fld5T3P6sR9IUgAv6`
- Shipping Lead Time Days · `fldk282GhxCkc1fZf`
- Refund Policy · `fldAxqGkbCSSTWuMX`
- Fulfillment Cost Notes · `fldnhUCDOBljUJX23`
- First Payout Celebrated At · `fld8MRiO1aRG1IUJz`
- Tier Upgrade Nudge Sent At · `fld2eNbxzO9AzzYPz`
- Tier Abandoned Recovery Sent At · `fldErK3OgWGqxTYr0`

**Backfill state:** 64/64 existing ranchers set `Pricing Model='legacy'`. New signups will get `tier_v2` automatically when Task 11 ships.

### Vercel
- Project: `prj_UiTlxTHcMl277z0QyrAVz82nclVA`
- Team: `team_LtooF0XS8M8oDBUwxphrC1RJ`
- Preview alias: `bhc-git-stage-3-verticals-benibeauchman-3168s-projects.vercel.app`
- Latest preview deploy `dpl_3NCAE85YzEPenYeEoedvrm3KnayF` is READY (commit 414756f)
- Newer commits after that deploy: `35f4658`, `35913e6`, `c30e95b`, `7badbc9`, `186f1a4`, `09e7482`, `994d5f8` — Vercel auto-deploys each push, latest will be READY when resuming.

---

## Plan + spec locations

**Primary plan (READ THIS FIRST on resume):**
- `docs/superpowers/plans/2026-05-25-stripe-connect-tiered-pricing.md` (2,200+ lines, 24 tasks)
- Header has `<!-- AIRTABLE-IDS -->` and `<!-- STRIPE-IDS -->` comment blocks with all locked IDs
- Self-review section at bottom confirms spec coverage

**Mockup tour (USER REVIEWING THIS):**
- `docs/mockups/2026-05-25-stripe-flow/index.html` — open in browser
- 18 screens across rancher/buyer/legacy/admin/emails subdirs

**Architecture baseline (already shipped Tasks 0-10):**
- `lib/contracts/*` — typed state-mutation contracts (buyer, rancher, admin, threads, payments)
- `lib/funnelMetrics.ts` — non-fatal Funnel Events emit
- `lib/rancherCapacity.ts` — atomic Redis INCR/DECR + `getLiveCapacity()`
- `tools/check-vertical-boundaries.ts` — fails CI on cross-vertical imports
- `app/admin/funnel/` — conversion rate dashboard
- `app/checkout/[refId]/ask/` — buyer pre-purchase question form
- `app/rancher/inbox/` — rancher message inbox
- `app/api/webhooks/resend-inbound/route.ts` — extended for `thread-` reply routing

---

## Tasks remaining (in execution order)

**Code tasks 2-16 from plan + infra 17-24 = 22 tasks.**

| # | Task | Dependency | Files to create/modify |
|---|------|-----------|------------------------|
| 2 | `lib/tiers.ts` source of truth | none | 1 new file |
| 3 | `/partner` public page | Task 2 | 1 new file + boundary checker update |
| 4 | Tier subscription endpoints | Task 2, 7 | 4 new files (lib + 3 routes) |
| 5 | Tier checkout landing + `/rancher/billing` | Task 4 | 2 new files |
| 6 | Stripe webhooks (V2 thin events) | Task 4, 7 | 1 modify + 1 new + Stripe Events idempotency |
| 7 | Connect Express onboarding | Task 4 | 2 new files |
| 8 | Buyer deposit flow + fulfillment-aware page | Task 6, 7 | 3 new + 2 modify |
| 9 | Fulfillment confirm + payout release | Task 7, 8 | 1 new file |
| 10 | Add-on à la carte purchase | Task 6 | 1 new file |
| 11 | Setup wizard tier + fulfillment + dashboard banners | Task 4, 7 | 3 modify |
| 11.5 | Legacy rancher opt-in upgrade | Task 11 | 1 new + 1 modify |
| 12 | Admin payments dashboard | Task 6 | 2 new files |
| 13 | Payout reconcile + stuck-deposit guards | Task 9 | 1 new cron + 1 modify |
| 14 | 7-day soak | All above | Observation log |
| 15 | 3-pass audit (functional/regression/CX) | Task 14 | 3 audit docs |
| 16 | Canary ship (5-phase ladder) | Task 15 | 1 ship doc + cherry-pick to main |
| 17 | Onboarding stage-time analytics | Task 2 | 1 modify + 1 dashboard update |
| 18 | Activation-moment automation (first payout celebration) | Task 9 | 1 new + 1 modify |
| 19 | Stripe Tax + branded Customer Portal | none (config) | Operator step only |
| 20 | Airtable daily backup to Vercel Blob | none | 1 new cron + restore doc |
| 21 | Tier upgrade nudge cron | Task 6 | 1 new cron + 1 modify (email template) |
| 22 | Abandoned tier-select recovery cron | Task 4 | 1 new cron |
| 23 | UTM attribution through funnel | Task 17 | 1 modify + 1 new dashboard tab |
| 24 | Stripe Events idempotency wrap | Task 1 | 2 modify (both webhook handlers) |

**Dispatch strategy:** Subagent-driven, fresh agent per task, two-stage review (spec compliance → code quality) before merging. Tasks 2-3 can run in parallel (independent). Tasks 4-11 have dependency chain. Tasks 17-24 can mostly run in parallel after their dependencies.

---

## Self-learning notes (key gotchas + decisions for future me)

**Stripe V2 API gotchas:**
1. NO `type: 'express'` at top level of `accounts.create` — V2 unifies via `dashboard: 'full'` + `defaults.responsibilities` + `configuration.{customer,merchant}` blocks
2. Subscription on connected account uses `customer_account: 'acct_*'` (NOT `customer: 'cus_*'`) — V2 unifies customer + connected-account into single acct_*
3. `subscription.customer_account` returns acct_* on webhook payload — `subscription.customer` doesn't exist
4. Connect webhook events are THIN — parse via `client.parseThinEvent()` then retrieve full data via `client.v2.core.events.retrieve(thinEvent.id)`
5. Account retrieve requires `include[]` array: `['configuration.merchant', 'requirements']` to get capability + requirements data
6. Status check: `account.configuration.merchant.capabilities.card_payments.status === 'active'` (not legacy `charges_enabled`)
7. Onboarding complete = `requirements.summary.minimum_deadline.status !== 'currently_due' && !== 'past_due'`
8. SDK auto-sets API version `2026-04-22.dahlia` — don't override

**Architecture decisions locked:**
- Buyer/Rancher verticals NEVER import each other — all cross-vertical state changes go through `lib/contracts/*`
- `app/checkout/` is buyer vertical (added to boundary checker after Task 8)
- Contracts emit funnel events for every transition — telemetry is free + non-fatal
- Threads schema replaces ad-hoc email-only conversations — buyer + rancher both post via `postMessage()` contract
- Inbound emails route via `thread-<id>@replies.<domain>` tag → `parseReplyAddress` → contract postMessage
- Capacity counter is atomic Redis INCR/DECR — Airtable is eventually-consistent mirror via `syncCapacityToAirtable`; reads use `getLiveCapacity()` not Airtable directly

**Business model decisions locked:**
- BHC IS: marketing engine, lead capture, deposit holder (Stripe direct charge), trust intermediary, communication routing
- BHC is NOT: shipping logistics, processing scheduling, pickup coordination, refunds, customer service post-deposit, tax forms
- Rancher self-reports Fulfillment Types + Pickup City + Lead Time + Refund Policy → shown verbatim on buyer deposit page
- Legacy ranchers grandfathered — one-way opt-in upgrade only (tier_v2 → legacy not supported)
- Money flow: Stripe destination charge splits 93/97/100% to rancher Connect, 7/3/0% to BHC commission balance; monthly subscription on customer_account separately

**Research-backed UX moments:**
- KYC step needs explainer card BEFORE the Account Link (trust transfer + authority bias)
- First payout = peak-end memory anchor — celebration email w/ Stripe screenshot drives retention
- Tier upgrade nudge = loss-aversion framing ("you paid $X · would have been $Y") beats gain framing
- Default-bias: pre-select Pasture in tier picker
- Anchoring: show Operator $500 first so $150 looks cheap
- Stripe Tax + branded Customer Portal close the cognitive consistency gap when buyer/rancher hits Stripe surfaces

**Pitfalls to avoid (from this session):**
- Don't subscribe a connected account before it exists — order is: createConnectAccount first, persist acct_*, THEN create subscription Checkout w/ customer_account
- Don't trust cached Airtable fields for Connect status — always re-retrieve via `v2.core.accounts.retrieve()`
- Don't create Stripe webhooks with default payload mode — must explicitly select THIN for V2 events
- Don't fire activation effects without idempotency guards — use `First Payout Celebrated At` style stamps
- Stage-3 Stripe prices are in LIVE mode — only `STRIPE_CONNECT_ENABLED=true` exposes them; keep prod flag false until canary
- Rancher Refund Policy field is REQUIRED at signup (min 20 chars) — don't let blanks through validation

---

## Resume instructions for next session

**Cold-start prompt for next session:**

> Read `docs/STATE-2026-05-25-resume.md` to orient. We're mid-execution of Stage-3 Stripe Connect + Tiered Pricing on `stage-3-verticals` branch. Tasks 0-1 done, mockup tour shipped. User is reviewing mockups at `docs/mockups/2026-05-25-stripe-flow/index.html` before approving Task 2 execution.
>
> Pick up by: (a) asking user if mockups approved, (b) if yes, dispatching subagent for Task 2 (`lib/tiers.ts` source-of-truth module per plan section "Task 2: Tier source-of-truth module"), (c) if user wants tweaks first, accept feedback then dispatch single-screen subagents to revise.
>
> Continue subagent-driven for Tasks 2-16. Two-stage review per task (spec compliance → code quality). Commit per task with reference to plan section. Push each commit to `stage-3-verticals` (NEVER to main).
>
> If user asks "what's done so far": pull the task list from end of `docs/STATE-2026-05-25-resume.md` and report.

**One-line summary for the user when they return:**

> Stage-3 baseline + mockups shipped on stage-3-verticals branch. Production untouched. 64 ranchers safely grandfathered. 18 mockup screens ready for review at `docs/mockups/2026-05-25-stripe-flow/index.html`. Awaiting your sign-off to start Task 2 (code wiring).

**To verify state immediately on resume:**

```bash
cd "/Users/benji.bushes/BHC/untitled folder/bhc"
git branch --show-current  # expect: stage-3-verticals
git log --oneline -5       # expect: 994d5f8 mockups commit at top
ls docs/mockups/2026-05-25-stripe-flow/  # expect: 5 subdirs + index.html
npx tsc --noEmit 2>&1 | head -3          # expect: clean (no output)
npx tsx tools/check-vertical-boundaries.ts 2>&1 | tail -2  # expect: 0 violations
```

If all 5 commands pass, state is intact. Proceed.

If type-check fails or boundary check shows violations, STOP — something happened to the branch between sessions. Investigate before touching code.

---

## Open questions for next session

These are deferred decisions — user should weigh in before code lands:

1. **Operator add-ons billed manually vs auto:** Brand Intro (15% of deal) + PPC Management (15% + $500/mo min) — too complex to auto-bill in v1. Plan says manual for v1. Confirm OK with user.

2. **Pilot ranchers for Phase 3 canary:** Plan suggests Sackett Ranches + High Lonesome. Confirm both willing + available before Task 16 phase 3 kicks off.

3. **First-month tier proration:** Default Stripe behavior is full first-month charge. Consider 14-day free trial on Pasture only as growth lever? Defer to user.

4. **Connect onboarding: Express or full V2 dashboard?** Plan uses `dashboard: 'full'`. Express has less friction. Verify user wants the full Stripe dashboard or prefers Express embedded experience.

5. **Refund flow scoping:** Plan defers to manual via Stripe Dashboard for v1. Confirm user accepts this — alternative is building a refund-request UI on `/rancher/billing` (~Task 25).

---

## Files modified/created on stage-3-verticals (not on main)

Run this to see the full delta if needed:
```bash
git diff main..stage-3-verticals --stat
```

Expected ~40+ files including lib/contracts/*, lib/funnelMetrics.ts, lib/rancherCapacity.ts, app/api/threads/*, app/api/rancher/inbox/*, app/checkout/*, app/rancher/inbox/*, app/admin/funnel/*, tools/check-vertical-boundaries.ts, docs/superpowers/plans/2026-05-25-stripe-connect-tiered-pricing.md, docs/mockups/2026-05-25-stripe-flow/* (19 files), .branch-baseline, vercel.json (canary env block).

---

## Shopify-for-ranchers scope (post-Stage-3 roadmap)

Separate doc: `docs/SHOPIFY-FOR-RANCHERS-SCOPE.md`. Read after Stage-3 ships.

TL;DR: 80% of plumbing is in Stage-3. Multi-product catalog + cart + variants + inventory + cut sheets = **2-3 weeks subagent-driven** on top of Stage-3.

Phases:
- **Phase A (Stage-3, in progress):** 3 hardcoded tiers (Quarter/Half/Whole) via Stripe Connect direct charge
- **Phase B (~2 weeks after Stage-3):** unlimited products per rancher + buyer cart + product/order management UIs + multi-line Checkout
- **Phase C (~1 week after Phase B):** variants + inventory tracking + cut sheets

Total Stage-3 → full Shopify-for-ranchers w/ marketing engine + tiered commission: **~5-6 weeks subagent-driven**.

Killer differentiator vs Shopify: cut sheets (50 decisions per cow) + 0% Operator commission + qualified lead matching. Shopify gives a store; BHC gives a store + qualified buyers + marketing-as-service.

Ship Stage-3 first. Validate w/ 5-10 tier_v2 ranchers. Then write a Phase B plan referencing the scope doc as spec.

---

## Buyer qualification + routing gates (locked)

Tier_v2 ranchers pay $150-500/mo + commission. **Only qualified buyers get routed.** Same qualification gates that protect legacy ranchers also apply to tier_v2. NO new gates added — existing routing engine is the source of truth. Tier_v2 inherits.

### Buyer qualification fields (Consumers table)

| Field | What it means | Set by | Gates routing? |
|-------|---------------|--------|----------------|
| `Intent Score` | 0-100 server-computed at signup | `/api/consumers` POST | Yes — low score (<30) waits longer in queue |
| `Intent Classification` | High / Medium / Low | Derived from Intent Score | Yes — Low can be deprioritized |
| `Ready to Buy` | Buyer clicked YES on warmup OR signed up with Within 30 days timing | `/api/warmup/engage` + signup form | Yes — REQUIRED for immediate routing |
| `Warmup Engaged At` | Timestamp of YES click | `/api/warmup/engage` | Yes — proves active intent |
| `Buyer Health` | Active / Non-Responsive (terminal) | Auto-flagged after 2+ Closed Lost w/ no_response reason | YES — Non-Responsive excluded from ALL routing |
| `Buyer Stage` | NEW / WAITING / READY / MATCHED / CLOSED | Contract `transitionBuyerStage` | Yes — only READY + MATCHED enter matching queue |
| `Missed Responses` | Count of consecutive ghosted closes | Auto-increments on Closed Lost no_response | Yes — at ≥2 auto-flags Non-Responsive |
| `Unsubscribed` | Email opt-out flag | Resend webhook + manual unsubscribe link | Yes — excludes from all email + routing |
| `Bounced` | Hard bounce flag | Resend `email.bounced` webhook | Yes — excludes from email + routing |
| `Complained` | Marked-as-spam flag | Resend `email.complained` webhook | Yes — excludes from email + routing |
| `Routing Segment` | MATCH_NOW / WARM_LEAD / NUDGE / etc | Nightly `reclassify-buyers` cron | Yes — drives `email-sequences` branch + match priority |

### What "qualified buyer" means at routing time

`/api/matching/suggest` runs these filters before considering a rancher match (logic already shipped in production):

1. **Consent gate (3 paths — any one passes):**
   - `Ready to Buy = true` (signup-time intent OR warmup YES click), OR
   - `Warmup Engaged At` set within last 90d, OR
   - Fresh signup (`Created` < 7d ago) with `Intent Score ≥ 60`

2. **Health gate:**
   - `Buyer Health` ≠ Non-Responsive
   - `Missed Responses` < 2

3. **Suppression gate:**
   - `Unsubscribed` = false
   - `Bounced` = false
   - `Complained` = false

4. **Lifecycle gate:**
   - `Buyer Stage` in {READY, MATCHED}
   - `Referral Status` ≠ Closed Won (active referral guard — no double-routing)
   - No active referral row already open for this buyer

5. **Targeting gate:**
   - Buyer's `State` is in rancher's `Routing States` (or rancher's home `State` if Admin Approved Multi-State = false)
   - Buyer's `Order Type` matches rancher's `Tier Specialty` (Quarter buyer → Quarter-or-omnivore rancher only)
   - `excludeRancherIds` (no re-routing buyer to a rancher who already Closed Lost them)

All 5 gates must pass before a buyer enters the matching pool for any rancher.

### NEW gates added by Stage-3 (rancher-side, protecting buyer experience)

Tier_v2 ranchers get matches ONLY if these conditions hold (added in Task 6 webhook + Task 4 matching/suggest extend):

1. `Pricing Model` = tier_v2 OR legacy (legacy keeps existing gates; tier_v2 adds the next 3)
2. `Subscription Status` = active (no past_due / canceled ranchers receive new matches)
3. `Stripe Connect Status` = active (can't receive a deposit if Connect isn't activated)
4. `Tier` ∈ {Pasture, Ranch, Operator} (not None)
5. `Fulfillment Types` is non-empty (rancher must have specced how they deliver, else buyer can't make informed deposit)
6. `Refund Policy` is non-empty (rancher must have written their policy, else buyer can't make informed deposit)

If any of 5+6 missing → rancher is hidden from matching engine until they complete the fulfillment step. Dashboard banner #4 (yellow) surfaces this gate to the rancher.

### Rancher quality protection (existing, applies to all tiers)

These already exist + protect the rancher experience. Tier_v2 inherits unchanged:

- **Capacity hard cap:** `getLiveCapacity()` from `lib/rancherCapacity` — atomic Redis counter, clamps at `Max Active Referalls` field. Hot-lead bypass at 1.2× ceiling.
- **At-capacity skip:** matching/suggest skips ranchers at cap; waitlists buyer until capacity opens
- **Tier specialty filter:** Quarter buyer routed only to Quarter-eligible ranchers
- **State match:** buyer's state must be in rancher's Routing States
- **Trust Mode + Onboarding Phase pacing:** during first 30d of going live, rancher gets throttled warmup batches (5/wk default) to avoid first-impression overload

### Re-qualification on tier upgrade/downgrade

When rancher changes tier (Task 4 Step 3):
- No buyer-side change — existing qualification gates continue
- Capacity setting unchanged
- Routing priority increases on Ranch (priority over Pasture in same state)
- Operator → 0% commission applied to NEW deposits only; existing pre-tier-change deposits keep their original split

### Stage-3 routing change for legacy vs tier_v2

In `/api/matching/suggest` (existing endpoint, extend in Task 6):

```ts
// Pseudocode of the new branch
const candidates = await getEligibleRanchers(buyerState, buyerOrderType);

// Within-state ranchers split by Pricing Model
const tier_v2_candidates = candidates.filter(r =>
  r['Pricing Model'] === 'tier_v2'
  && r['Subscription Status'] === 'active'
  && r['Stripe Connect Status'] === 'active'
  && r['Tier']
  && (r['Fulfillment Types']?.length || 0) > 0
  && r['Refund Policy']
);
const legacy_candidates = candidates.filter(r => r['Pricing Model'] === 'legacy');

// Priority order: Ranch+ tier_v2 → Pasture tier_v2 → legacy
// Within each: existing sort by Performance Score + capacity + state-match + round-robin
const prioritized = [
  ...sortByExistingRules(tier_v2_candidates.filter(r => r['Tier'] === 'Operator')),
  ...sortByExistingRules(tier_v2_candidates.filter(r => r['Tier'] === 'Ranch')),
  ...sortByExistingRules(tier_v2_candidates.filter(r => r['Tier'] === 'Pasture')),
  ...sortByExistingRules(legacy_candidates),
];

const topMatch = prioritized.find(r => atomic_capacity_check(r));
```

This guarantees:
- Ranch tier ranchers get FIRST CRACK at buyers in their state (the "priority routing" perk they pay for)
- Operator ranchers get even higher priority (they pay most + get 0% commission)
- Legacy ranchers still get matches when no tier_v2 rancher is available — no abandonment
- All ranchers still receive only buyers passing the 5-gate qualification

### Buyer-side experience NEVER degrades

Buyer doesn't see or care about tier. They see:
- Quality matches (qualification gates protect them from mismatched ranchers)
- Rancher's fulfillment + refund policy on deposit page (tier_v2) OR rancher's external Payment Link (legacy) — both work
- Same /access flow, same matching email, same dashboard, same Threads

Tier system is rancher-facing only. Buyer experience is unified.

### Routing audit log (already shipped)

Every match attempt is logged to:
- `Funnel Events` table (signup → engaged → transition:MATCHED → close events)
- `AI Audit Log` table (every state mutation via contracts emits an audit row)
- Telegram operator alerts on every match (existing)

If a routing decision is questioned later, full trail exists.

---

## Marketing delivery game plan

Separate doc: `docs/MARKETING-DELIVERY-GAMEPLAN.md`. Read alongside this resume.

Covers what fires marketing-wise when a rancher subscribes to a tier:
- Per-tier ritual matrix (Pasture autopilot, Ranch active, Operator managed)
- Capacity math: ~60 hr/mo Ben-time → max 4 Operators OR 15 Ranches OR 120 Pastures
- New Marketing Deliverables Airtable table + weekly Monday digest cron
- Onboarding launch sequence (Day 0/1/3-7/14/30/90 per new rancher)
- Hiring trigger thresholds (3 Operators = video editor, 5 = VA, 30 Ranches = writer)
- 5 AI-automation candidates deferred to Stage-4
- Quality gates: human-in-the-loop on every deliverable
- Anti-patterns blocked

Action item folded into Task 17 (Onboarding stage-time analytics) — when
that subagent ships, include the Marketing Deliverables table + digest
cron + close-handler auto-insert logic per the game plan doc.

---

## Endpoint inventory — what stays / changes / dies / gets added

### Endpoints that need Pricing Model branch (legacy vs tier_v2)

Each must check the rancher's `Pricing Model` field and route accordingly. List + behavior delta:

| Endpoint | Legacy behavior (unchanged) | Tier_v2 behavior (new) |
|----------|------------------------------|------------------------|
| `/api/cron/commission-invoices` | Sends 10% Stripe Invoice post-close | SKIP — commission already taken via `application_fee_amount` on deposit |
| `/api/rancher/quick-action` (won) | Fires `createCommissionInvoice` | SKIP invoice — already taken; just record close + payout-pending |
| `/api/rancher/referrals/[id]` PATCH (close path) | Existing post-close invoice via `sendInstantCommissionInvoice` | SKIP invoice — fire payout-pending email instead |
| `/api/orders/request` (direct rancher-page) | Create Referral + email rancher (current flow) | Create Referral + redirect to `/checkout/[refId]/deposit` |
| `/api/matching/suggest` | No Connect status gate | If `Pricing Model=tier_v2` AND `Stripe Connect Status !== 'active'`: skip routing to this rancher |
| `/api/cron/nightly-rancher-audit` | Audits all ranchers w/ same checks | Split digest by Pricing Model; add tier_v2-specific checks (Connect status drift, subscription status, stuck payouts) |
| `/api/cron/awaiting-payment-nudge` | Nudges Awaiting Payment referrals 14d+ | SKIP tier_v2 ranchers (their deposit happens pre-fulfillment, no Awaiting Payment state) |
| `/api/stats/public` | Existing counters | Add tier_v2 metrics: # tier subscribers per tier, MRR, total platform fees retained, # paid out to ranchers this month |

### Endpoints that go fully obsolete (delete after Phase 4 ships)

NONE for v1. All legacy ranchers stay on old model indefinitely. Only obsolete IF/WHEN every legacy rancher upgrades — defer cleanup to a future stage-4.

### NEW endpoints to add (beyond plan Tasks 2-16)

Tasks 2-16 cover the canonical flow. These extras surfaced during planning:

1. **`/api/rancher/connect/status` GET** — already in plan Task 7 Step 3. Live Stripe Connect status read (never cached). Used by `/rancher/billing` dashboard.

2. **`/api/rancher/billing/data` GET** — JSON for `/rancher/billing` page. Returns: tier, subscription status, connect status, last 30d payouts, add-on history, next invoice date. Implicit in Task 5 but make explicit.

3. **`/api/rancher/fulfillment/update` PATCH** — let rancher edit Fulfillment Types / Pickup City / Lead Time / Refund Policy AFTER onboarding. Currently captured only in setup wizard (Task 11). Need post-onboarding edit surface on `/rancher` dashboard. Add as **Task 11.6**.

4. **`/api/admin/ranchers/[id]/comp-tier` POST** — operator one-tap comp a tier subscription for pilot ranchers (Task 16 phase 3). Uses Stripe coupon w/ 100% discount applied to subscription. Add as **Task 16.5**.

5. **`/api/admin/ranchers/[id]/migrate-to-tier` POST** — admin-initiated forced migration override (legacy → tier_v2) in case the rancher self-serve opt-in flow (Task 11.5) breaks. Add as **Task 11.7**.

6. **`/api/admin/payments/refund/[paymentId]` POST** — one-click refund a deposit via Stripe API. Calls `stripe.refunds.create(...)` + updates Payments row + nudges rancher via Telegram. Currently "manual via Stripe Dashboard" — make it ergonomic. Defer to **Task 25** (Phase 2).

7. **`/api/rancher/payout/manual-trigger` POST** — rancher manually triggers payout from their Connect balance to bank (otherwise Stripe's schedule controls timing). Optional but high-trust for first-payout celebration moment. Add as **Task 9.5**.

### Telegram callback handlers to add

New `callbackData` prefixes:
- `tcomp_<rancherId>_<tier>` — Telegram one-tap comp a tier for pilot rancher (Task 16.5)
- `tabandon_<rancherId>` — manually re-fire abandoned tier recovery email (Task 22)
- `payoutreview_<paymentId>` — operator reviews stuck payout (Task 13)
- `tiermigrate_<rancherId>_<tier>` — admin force-migrate a legacy rancher (Task 11.7)
- `kycremind_<rancherId>` — operator re-fires KYC reminder email (new Task 22.5 or fold into existing nudge cron)

### Email helpers to add (`lib/email.ts`)

| Helper | Trigger | Task |
|--------|---------|------|
| `sendTierWelcome` | Stripe Checkout subscription success | Task 5 |
| `sendKycReminder` | 24h after subscription start w/o Connect activate | NEW Task 22.5 |
| `sendFirstPayoutCelebration` | First successful payout to rancher | Task 18 |
| `sendTierUpgradeNudge` | Loss-aversion cron weekly Monday | Task 21 |
| `sendTierAbandonedRecovery` | Abandoned tier-select recovery cron daily | Task 22 |
| `sendBuyerDepositConfirmation` | Stripe `payment_intent.succeeded` for deposit | Task 8 |
| `sendRancherFulfillmentReminder` | 7d after deposit if no fulfillment confirm | NEW Task 13.5 |
| `sendBuyerFulfillmentNotification` | Rancher confirms fulfillment | Task 9 |

### Email helpers that need branching (legacy vs tier_v2)

- `sendInstantCommissionInvoice` — only fires for legacy ranchers post-close. Tier_v2 skips.
- `sendPilotUpsellEmail` — copy mentions "retainer / Operator tier" instead of generic upsell.
- `sendRancherLeadNudge` (stale-lead cron) — same copy works for both; no branch needed.
- `sendCompletedRancherIntro` — same copy; no branch.

### CRONs to add

Beyond Tasks 17-24 plan:
- **Task 22.5: KYC reminder cron** — daily 14 UTC. Find ranchers w/ subscription active >24h + Connect status != active. Fire `sendKycReminder` (max 3 reminders 24h apart, then escalate to Telegram).
- **Task 13.5: Fulfillment-confirm reminder cron** — daily 17 UTC. Find Payments w/ Status=succeeded + no Payout row + Captured At > 7d. Email rancher reminder + Telegram operator.

### Existing CRONs to gate by Pricing Model

These already exist + work fine for legacy. They need a Pricing Model filter to avoid double-processing tier_v2 ranchers:

- `commission-invoices` (1st of month, post-close invoicing) → `Pricing Model = 'legacy'` only
- `awaiting-payment-nudge` (14d Awaiting Payment chase) → `Pricing Model = 'legacy'` only
- `nightly-rancher-audit` (per-rancher health check) → both, but split audit sections

### Stripe Webhook event handlers to ADD

In `app/api/webhooks/stripe/route.ts` (platform endpoint):
- `customer.subscription.created` → write tier + sub id to Ranchers
- `customer.subscription.updated` → update tier on upgrade/downgrade
- `customer.subscription.deleted` → clear tier, set Subscription Status=canceled
- `invoice.paid` (subscription) → no-op (sub renewal)
- `invoice.paid` (add-on) → flip Add-On Purchases row to paid
- `invoice.payment_failed` → Telegram alert + email rancher to update card
- `payment_intent.succeeded` (deposit) → mark Payment row succeeded + funnel emit
- `application_fee.created` → audit log
- `charge.refunded` → flip Payments row to refunded + Telegram alert

In `app/api/webhooks/stripe-connect/route.ts` (Connect endpoint, THIN events):
- `v2.core.account[requirements].updated` → re-retrieve account, update Status
- `v2.core.account[configuration.merchant].capability_status_updated` → check card_payments status, flip Active if appropriate, fire launch warmup
- `v2.core.account[configuration.customer].capability_status_updated` → no-op for now
- `v2.core.account[.recipient].capability_status_updated` → audit log

### V1 webhook events to KEEP handling (legacy + founders + brands)

These are unchanged from current production:
- `checkout.session.completed` (Founders Herd + Brand Partner Stripe Payment Links) → existing handler stays
- `invoice.paid` (legacy commission invoices) → existing handler stays
- `invoice.payment_failed` (legacy commission) → existing handler stays

All existing handlers must check `event.account` — if present (Connect event), route to stripe-connect handler logic; if absent (platform event), process as before.

### Rate-limit additions

Already locked in plan:
- POST `/api/threads/[id]/message` → 10/min per sender (shipped Task 33)

New ones needed:
- POST `/api/rancher/tier/select` → 5/min per rancher (anti-spam tier flip)
- POST `/api/rancher/connect/start` → 5/min per rancher (anti-spam Connect link gen)
- POST `/api/checkout/deposit` → 10/min per buyer (anti-spam Checkout Session creation)
- POST `/api/rancher/addons/purchase` → 5/min per rancher (anti-spam invoice creation)

Add to each task's implementation. Update `tools/check-vertical-boundaries.ts` allowed shared prefix to confirm `@/lib/rateLimit` is on the list (it is).

---

## Caveman mode note for next session

User is on Caveman mode (terse responses, fragments OK). Maintain in next session unless user says "stop caveman" or "normal mode". Code/commits/security write normal.
