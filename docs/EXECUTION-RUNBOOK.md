# Stage-3 Execution Runbook — Subagent-Driven Tasks 2-24
**Saved:** 2026-05-25 · For controller (me) dispatching subagents per task

---

## Process per task (locked by superpowers:subagent-driven-development)

1. Dispatch IMPLEMENTER subagent with FULL TASK TEXT (don't make them read plan)
2. Wait for return. If asks questions → answer + re-dispatch
3. On DONE → dispatch SPEC REVIEWER subagent (verifies code matches spec, no more, no less)
4. If spec issues → implementer fixes → spec re-review
5. On spec ✅ → dispatch CODE QUALITY REVIEWER subagent (idiomatic, secure, tested)
6. If quality issues → implementer fixes → quality re-review
7. On both ✅ → mark complete in TodoWrite + commit + push

**Never parallel-dispatch implementer subagents on overlapping files.** Parallel-OK for reviewers + non-overlapping implementers.

---

## Dependency graph (locked execution order)

```
Phase 1 — Foundation + Stripe core (SEQUENTIAL)
  ┌─────────────────────────────────────────────┐
  │  Task 2  lib/tiers.ts                       │
  │   └─→ Task 7  Connect Express (V2 helpers)  │
  │        └─→ Task 4  Tier subscription APIs   │
  │             └─→ Task 5  Billing UI          │
  │                  └─→ Task 6a Sub webhooks   │
  │                       └─→ Task 8  Buyer dep │
  │                            └─→ Task 6b Pay  │
  │                                 └─→ Task 9  │
  │                                              │
  │  Task 11 Setup wizard (needs Tasks 4 + 7)   │
  │   └─→ Task 11.5 Legacy upgrade flow         │
  │                                              │
  │  Task 12 Admin payments (needs Task 6)      │
  │  Task 10 Add-on à la carte (needs Task 6)   │
  └─────────────────────────────────────────────┘

Phase 2 — Research-backed infra (PARALLEL after their deps)
  ┌─────────────────────────────────────────────┐
  │  Task 24 Stripe Events idempotency          │
  │  Task 17 Onboarding analytics + Mktg Deliv  │
  │  Task 18 First-payout celebration           │
  │  Task 21 Tier upgrade nudge cron            │
  │  Task 22 Abandoned recovery cron            │
  │  Task 22.5 KYC reminder cron                │
  │  Task 13.5 Fulfillment-confirm reminder     │
  │  Task 20 Airtable backup cron               │
  │  Task 23 UTM attribution (after Task 17)    │
  │  Task 13 Payout reconcile + stuck dep       │
  └─────────────────────────────────────────────┘

Phase 3 — Validation + Ship
  ┌─────────────────────────────────────────────┐
  │  Task 19 Stripe Tax + Portal branding (OPS) │
  │  Task 14 7-day soak                         │
  │  Task 15 3-pass audit                       │
  │  Task 16 Canary rollout (5-phase)           │
  └─────────────────────────────────────────────┘
```

**Phase 1 = ~12 tasks SEQUENTIAL** (each task implementer waits for prior commit)
**Phase 2 = ~10 tasks PARALLELIZABLE** (different files, no overlap)
**Phase 3 = 4 ops tasks** (mostly operator + observation)

---

## Model selection (locked per task)

| Task | Complexity | Model |
|------|-----------|-------|
| 2 lib/tiers.ts | 1 file, spec-complete | cheap (haiku) |
| 7 Connect onboarding | 2 files, Stripe V2 API | standard (sonnet) |
| 4 Tier subscription APIs | 4 files, Stripe + Airtable integration | standard |
| 5 Billing UI | 2 files, UI work | cheap |
| 6a Subscription webhooks | 1 modify + 1 new | standard |
| 8 Buyer deposit flow | 3 new + 2 modify, Stripe + UI | standard |
| 6b Payment webhooks | modify existing | standard |
| 9 Fulfillment confirm | 1 new file, payout API | standard |
| 11 Setup wizard + banners | 3 modify, UI heavy | standard |
| 11.5 Legacy upgrade | 1 new + 1 modify | standard |
| 12 Admin payments | 2 new files, UI | cheap |
| 10 Add-on purchase | 1 new file | cheap |
| 24 Stripe Events idempotency | 2 webhook modify | standard |
| 17 Onboarding analytics + Mktg Deliv | multi-file, Airtable + UI + cron | most-capable (opus) |
| 18 First-payout celebration | 1 new + 1 modify | standard |
| 21 Tier upgrade nudge cron | 1 new cron | cheap |
| 22 Abandoned recovery cron | 1 new cron | cheap |
| 22.5 KYC reminder cron | 1 new cron | cheap |
| 13.5 Fulfillment-confirm reminder | 1 new cron | cheap |
| 20 Airtable backup cron | 1 new + restore doc | cheap |
| 23 UTM attribution | modify + new dashboard tab | standard |
| 13 Payout reconcile + stuck dep | 1 new + 1 modify | cheap |
| 15 3-pass audit | observation + writeups | most-capable |

Spec reviewer + code quality reviewer for all tasks: **standard** (sonnet).

---

## Pre-flight checks (run before EACH implementer dispatch)

```bash
cd "/Users/benji.bushes/BHC/untitled folder/bhc"
git branch --show-current  # MUST be stage-3-verticals
git status --short          # should be clean before dispatch
npx tsc --noEmit 2>&1 | head -3   # clean
npx tsx tools/check-vertical-boundaries.ts 2>&1 | tail -2  # 0 violations
```

If anything fails → STOP. Investigate before dispatching subagent.

---

## Implementer subagent prompt template

Each implementer gets a self-contained prompt with:

```
You are implementing Task N of the BuyHalfCow Stage-3 Stripe Connect + Tiered Pricing plan.

## Locked context (DO NOT re-derive)

**Branch:** stage-3-verticals (already on it, never push to main)
**Repo:** /Users/benji.bushes/BHC/untitled folder/bhc

**Stripe LIVE-mode IDs (already created):**
- Pasture price: price_1Tb3IWGTWWNqassHaIvpNXeC ($150/mo)
- Ranch price: price_1Tb3IyGTWWNqassHynt7qAJn ($350/mo)
- Operator price: price_1Tb3JLGTWWNqassH0UPyua3j ($500/mo)
- Video add-on price: price_1Tb3JhGTWWNqassHXZ8nSuW5 ($2,500)
- Photo add-on price: price_1Tb3K4GTWWNqassHvTC4w9KE ($1,500)
- Founder Letter add-on price: price_1Tb3KPGTWWNqassHdBaWY8Z8 ($750)

**Airtable IDs (base appgLT4z009iwAfhs):**
- Ranchers: tbl08y9Be45zNG0OG
- Consumers: tblAbjQDnLrOtjpoE
- Referrals: tblBfimb4Gt8C0fu4
- Threads: tblIuMAlScXBTNF5w
- Thread Messages: tbl5ORgGghoqabyXr
- Funnel Events: tblpm57rUJJT103l2
- Payments: tblPfESJ4lxwtGThy
- Payouts: tbl2lEnCbz0o3VqbH
- Add-On Purchases: tblebGHKDzRMc9epT
- Stripe Events: tblPiw7jB7Mm7OxeN

**Rancher field IDs (Stage-3 additions):**
- Pricing Model: fldaIFuo7rCSQvHP6 (singleSelect: legacy / tier_v2)
- Tier: fldPY17Titdz4S0EN (None/Pasture/Ranch/Operator)
- Stripe Subscription Id: fldJaOgCoQNkHuuMl
- Subscription Status: fldapRsuf6ITnWJkV
- Subscription Started At: fldR3vip22BKA6wEV
- Subscription Next Invoice At: fldP6ZkH4QreqlFy9
- Stripe Connect Account Id: fldrUOFCKOXQBA40x
- Stripe Connect Status: fldTdzuQp2sYIlsqV
- Stripe Connect Connected At: fldaofYC2bcbhLWlX
- Fulfillment Types: fldvaMCn1ZlAP66OA
- Pickup City: fld8mbzIPdZh1NPna
- Delivery Radius Miles: fld5T3P6sR9IUgAv6
- Shipping Lead Time Days: fldk282GhxCkc1fZf
- Refund Policy: fldAxqGkbCSSTWuMX
- Fulfillment Cost Notes: fldnhUCDOBljUJX23
- First Payout Celebrated At: fld8MRiO1aRG1IUJz
- Tier Upgrade Nudge Sent At: fld2eNbxzO9AzzYPz
- Tier Abandoned Recovery Sent At: fldErK3OgWGqxTYr0

**Stripe V2 API patterns (use VERBATIM):**

Account create:
```ts
const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY || '');
const account = await stripeClient.v2.core.accounts.create({
  display_name: rancher.operatorName,
  contact_email: rancher.email,
  identity: { country: 'us' },
  dashboard: 'full',
  defaults: {
    responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' },
  },
  configuration: {
    customer: {},
    merchant: { capabilities: { card_payments: { requested: true } } },
  },
  metadata: { rancherId },
});
```

Account onboarding link:
```ts
const link = await stripeClient.v2.core.accountLinks.create({
  account: accountId,
  use_case: {
    type: 'account_onboarding',
    account_onboarding: {
      configurations: ['merchant', 'customer'],
      refresh_url: refreshUrl,
      return_url: returnUrl,
    },
  },
});
```

Subscription on connected account (V2 uses customer_account NOT customer):
```ts
const session = await stripeClient.checkout.sessions.create({
  customer_account: rancher.stripeConnectAccountId,  // acct_*
  mode: 'subscription',
  line_items: [{ price: priceId, quantity: 1 }],
  metadata: { rancherId, tier },
  success_url, cancel_url,
});
```

Direct charge for buyer deposit:
```ts
const session = await stripeClient.checkout.sessions.create({
  mode: 'payment',
  line_items: [{ price_data: {...}, quantity: 1 }],
  payment_intent_data: {
    application_fee_amount: platformFeeCents,
  },
  success_url, cancel_url,
}, {
  stripeAccount: rancher.stripeConnectAccountId,
});
```

Thin event webhook parsing:
```ts
const thinEvent = stripeClient.parseThinEvent(rawBody, sig, WEBHOOK_SECRET);
const event = await stripeClient.v2.core.events.retrieve(thinEvent.id);
```

**Architecture rules (ENFORCED by tools/check-vertical-boundaries.ts — DO NOT VIOLATE):**
- Verticals (Buyer/Rancher/Admin) MUST NOT import each other
- Cross-vertical state changes go through `lib/contracts/*`
- `app/checkout/` is buyer vertical
- `app/rancher/`, `app/ranchers/`, `app/api/rancher/`, `app/api/ranchers/`, `app/api/auth/rancher/` are rancher vertical
- `app/admin/`, `app/api/admin/`, `app/api/webhooks/telegram/`, `app/api/cron/` are admin vertical
- `lib/*` is shared, importable by all

**Stage-3 design tokens (Tailwind classes):**
- bg-bone (#F4F1EC)
- text-charcoal (#0E0E0E)
- text-saddle (#6B4F3F)
- border-dust (#A7A29A)
- border-divider (#E8E3DA)
- Use Georgia serif for h1/h2 (via inline style or font-serif class)

## Your task

[FULL TASK TEXT FROM PLAN — copy verbatim from plan section]

## What "done" looks like

1. All files created/modified per task spec
2. `npx tsc --noEmit` returns clean (no output)
3. `npx tsx tools/check-vertical-boundaries.ts` returns "0 violations"
4. Commit with message format: `feat(task-N): <one-line summary>` referencing task number + plan section
5. Push to stage-3-verticals
6. Self-review: re-read your diff, look for missed spec items, fix before reporting DONE

## Status reporting

End with ONE of:
- **DONE** + summary of what shipped + commit SHA
- **DONE_WITH_CONCERNS** + summary + list of concerns
- **NEEDS_CONTEXT** + what's missing
- **BLOCKED** + why + what would unblock

NEVER push to main. NEVER commit to main. Branch is stage-3-verticals only.
```

## Spec reviewer subagent prompt template

```
You are reviewing Task N implementation for spec compliance.

**Spec (verbatim from plan):**
[FULL TASK TEXT]

**What was shipped:**
Run `git show HEAD --stat` to see the diff. Read each touched file.

**Your job:**
1. Did every step in the spec land? List spec items + ✅ / ❌ per item
2. Did the implementer ADD anything not in the spec? Flag scope creep
3. Did the implementer SKIP anything in the spec? Flag gaps

Output format:
- ✅ APPROVED if every spec item lands AND nothing extra was added
- ❌ ISSUES if anything missing or extra. List each with file:line reference.

DO NOT review code quality (that's the next reviewer). Only spec compliance.

Be ruthless. "Close enough" is NOT approved.
```

## Code quality reviewer subagent prompt template

```
You are reviewing Task N implementation for code quality.

**Files changed in this commit:**
Run `git show HEAD --stat` then read each .ts / .tsx file.

**Quality checklist:**
1. Types: no `any` cheats where a proper type fits. Imports from @/lib/contracts where applicable.
2. Errors: every async/await wrapped in try/catch where failure isn't fatal? Telegram alert on swallowed errors per BHC convention (lib/operatorSignal)?
3. Idempotency: writes that could re-trigger via webhook retry are protected (Stripe Events table check OR field-stamp guard)?
4. Boundaries: only imports from @/lib/* or own vertical? Use `npx tsx tools/check-vertical-boundaries.ts` to verify.
5. Rate limit: write endpoints have rate limit per spec (POST endpoints typically need lib/rateLimit)?
6. Tokens: Tailwind classes use bone/charcoal/saddle/dust/divider only? No hardcoded hex?
7. Funnel emit: state mutations emit funnelRecord({stage: ...}) where appropriate?
8. Stripe V2 patterns: customer_account (NOT customer) for subscriptions on connected accounts? No top-level type:'express' on account creates?
9. Comments: complex logic explained inline? Reference plan task number?
10. Commit message: matches `feat(task-N): <summary>` format?

Output: ✅ APPROVED or ❌ ISSUES with file:line per issue + severity (CRITICAL/IMPORTANT/NIT).

CRITICAL/IMPORTANT must be fixed before approval. NITs surfaced for awareness only.
```

---

## Save-state cadence

After every 5 tasks:
1. Commit `docs/STATE-2026-05-25-resume.md` with progress note (which tasks completed)
2. Push
3. If context approaching limit → save state + recommend user reset

---

## Estimated dispatches + cost

| Phase | Code tasks | Implementer dispatches | Reviewer dispatches (2 per task) | Total dispatches |
|-------|-----------|------------------------|----------------------------------|------------------|
| Phase 1 (Tasks 2-12 sequential) | 12 | 12 | 24 | 36 |
| Phase 2 (Tasks 13-24 parallel) | 10 | 10 | 20 | 30 |
| Phase 3 (Tasks 14-16 ops + audit) | 3 | 1 (Task 15) | 0 | 1 |
| **TOTAL** | **25** | **~23** | **~44** | **~67 dispatches** |

Plus re-review loops (~+20%) → ~80-90 dispatches total.

Realistic timeline: 4-8 hours per Phase 1 task pair × 12 = 48-96 hours wall-clock OR ~3-5 days of dispatch + review. Phase 2 parallelizable cuts that by half.

---

## Dispatch START

Begin with Task 2. It has no deps. Once committed, Task 7 can begin.

**Task 2 implementer prompt is ready to fire next.**
