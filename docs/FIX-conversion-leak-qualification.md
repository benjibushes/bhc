# FIX BRIEF — Buyer conversion leak (signup → close stuck at 0.83%)

**For:** the debugging agent. Self-contained; you have no prior chat context.
**Repo:** this one (Next.js App Router + TypeScript + Airtable).
**Goal:** raise signup → close conversion. Live baseline **0.83%** (16 closes / 1,921 signups). Industry 2–5%. Top of funnel is healthy (100% of closes come from Instagram); the leak is **mid-funnel** — signups that never become route-eligible and never get matched to a rancher.

> **IRON LAW: find root cause with data before changing anything.** Instrument and measure each stage drop-off first (Funnel Events table + `/admin/funnel`). Do not ship a "fix" you can't show moved a stage number. Read-only investigate, then propose, then implement behind verification.

---

> **UPDATE 2026-06-17 — partially shipped.** Suspect #1 (the qualify-quiz gate) was addressed by commit `e99024c fix(funnel): unblock the qualify quiz — "now" timing, email backup, auto-advance`. Re-measure signup→close over the next few weeks (no lift visible yet — too soon). Suspects #2–#4 below (the `$1500-$2500` budget scoring 0 intent, high-intent-only defaulting, the 60/70/75 threshold mismatch) may still apply — verify with funnel data before closing this out.

## What is ALREADY done (do NOT redo)

The commonly-cited fix — "default Order Type = Half and Budget when the quiz doesn't collect them" — is **already implemented**:

- `app/api/consumers/route.ts:130–132`
  ```ts
  const highIntentTiming = timing === 'Within 30 days' || timing === '1-3 months'
  const orderType   = orderTypeRaw   || (highIntentTiming ? 'Half' : '')
  const budgetRange = budgetRangeRaw || (highIntentTiming ? '$1500-$2500' : '')
  ```

Since this is live and conversion is still 0.83%, the leak is elsewhere. Investigate the four suspects below.

---

## Suspect #1 (highest priority) — the second-quiz gate blocks matching

`/access` signup does NOT make a buyer route-eligible. Matching is hard-blocked unless the buyer also completes a **separate** 4-question qualification quiz (`/api/qualify`) that sets `Qualified At` + `Qualification Score`.

- Gate: `app/api/matching/suggest/route.ts:125–127`
  ```ts
  const qualScore = Number(buyerRecForGate['Qualification Score'] || 0)
  const hasQualified = !!buyerRecForGate['Qualified At'] && qualScore >= 75
  if (!hasQualified && !isOperatorOverride) → 412 HARD BLOCK
  ```
- `Qualified At` / `Qualification Score` are set only in `app/api/qualify/route.ts` after the buyer finishes that quiz.

**Hypothesis:** most signups never reach or finish `/qualify`, so they can never be matched, regardless of Order Type/Budget/intent. This is likely THE dominant leak.

**Do:** measure the completion rate signup → `/qualify` started → `/qualify` finished (`Qualified At` set) → matched, using Funnel Events. If completion is low, the fix is one of: (a) reduce `/qualify` to fewer steps / merge it into `/access`, (b) auto-set `Qualified At` + a passing `Qualification Score` for clearly high-intent signups (timing = Within 30 days/1-3 months + Order Type + Budget present), (c) make the warmup "ready to buy" YES email route directly to `/qualify` with prefilled answers. Confirm the threshold `>= 75` is intentional and consistent (see #4).

---

## Suspect #2 (real bug) — the default Budget value scores 0 intent

The intent scorer (`app/api/consumers/route.ts:254–279`) scores Budget options but **`$1500-$2500` is not in the list**, so it falls through to **+0**. That's the exact value the signup defaulter writes at line 132, and it's a selectable form option. So the "defaulted Half + $1500-$2500" buyer gets +20 (Half) + timing points but **nothing for budget**, which can keep them under the qualification threshold.

- Scored today: `$5000+ +30`, `$4000-$5000 +25`, `$2000-$2500 +20`, `$1000-$1500 +15`, plus legacy buckets. `$1500-$2500` → unmatched → +0.

**Do:** add `$1500-$2500` (and audit every current `Budget` singleSelect option) to the scorer with a sane weight (~+18). Verify against `lib/qualification.ts` thresholds.

---

## Suspect #3 — defaults only fire for high-intent timing

At `consumers/route.ts:130–132`, Order Type/Budget default **only** when timing is "Within 30 days" or "1-3 months". Signups with "3-6 months", "Just exploring", or empty timing keep empty Order Type → segment becomes `Community` (`route.ts:222`) → never qualifies, never routes, and may not even get nurtured toward `/qualify`.

- `const consumerSegment = (interestBeef || interestAll) && orderType ? 'Beef Buyer' : 'Community'` (`route.ts:222`)

**Do:** decide if that's intended (lower intent = intentionally parked) or a leak. If many closers historically came from 3-6 month timing, widen the defaulting or add a nurture path that re-qualifies them rather than dead-ending at `Community`.

---

## Suspect #4 — three inconsistent thresholds

Three different bars gate the same journey:
- `lib/qualification.ts:65` — `intentScore >= 60`
- intent classification — High `>= 70`, Medium `>= 40` (`consumers/route.ts` ~281)
- matching gate — `Qualification Score >= 75` (`matching/suggest/route.ts:126`) — a **different field** from a **different quiz**

**Do:** map which threshold actually blocks the most volume (data), then reconcile. Don't lower a bar without confirming it doesn't flood ranchers with low-intent intros (capacity rules live in matching/suggest).

---

## Guardrails (do not break)

- **Timing-string trap fix** (`route.ts:104–112`, `'now'` → `'Within 30 days'`) must keep working — follow that normalization pattern for any new defaulting.
- **State-local match rule:** no nationwide fallback (disabled 2026-06-05). A buyer only matches an in-state operational rancher (`isRancherOperationalForBuyers`: Active + Signed + Live). Don't reintroduce nationwide.
- **Capacity:** respect `Current Active Referrals` / `Max Active Referalls` caps in matching.
- **Exact field values:** `Order Type` ∈ {Quarter, Half, Whole, Not Sure}; `Budget` is a singleSelect — use the exact option strings (e.g. `$1500-$2500`, with the dollar sign), don't invent new ones without adding them to the field.

## Acceptance criteria

1. A clear before/after on the funnel: stage-by-stage drop-off measured in Funnel Events / `/admin/funnel`, identifying which stage the change moved.
2. signup → matched rate improves without increasing low-intent intros sent to ranchers (watch rancher capacity + Closed Lost rate).
3. No regression to the timing trap, state-local rule, or capacity caps.
4. Every changed threshold/default is justified with the data that motivated it.

## Key files

- `app/access/page.tsx` — quiz form (collects email, state, timing; not Order Type/Budget)
- `app/api/consumers/route.ts` — signup; sets Order Type/Budget/Segment/Intent (defaults at 130–132; intent scorer 254–279; segment 222)
- `app/api/qualify/route.ts` — the second quiz; sets Qualified At + Qualification Score; fires matching
- `app/api/matching/suggest/route.ts` — the route-eligibility gate (125–127) + capacity + state rules
- `lib/qualification.ts` — `isQualifiedForRancherMatch` (thresholds, lines 49–67)
- `/admin/funnel` + Airtable **Funnel Events** table — measurement

---
*Prepared 2026-06-17 from a read-only code map. The "default Order Type/Budget" change is already shipped — start with Suspect #1 (the second-quiz gate), which is the most likely dominant leak.*
