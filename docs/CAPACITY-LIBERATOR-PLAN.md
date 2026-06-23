# Capacity Liberator — Implementation Plan

**Goal:** Make sure every rancher who can still *fulfill* more orders keeps getting buyers. Stop dead leads from silently throttling routing. Capacity is gated on **committed orders**, not lead count.

**Problem (confirmed in code):** `Current Active Referrals` increments on `Intro Sent` (`matching/suggest:708`) and only decrements on Closed Won/Lost/Refunded (`lib/contracts/rancher.ts:66`). Eligibility excludes a rancher at `currentReferrals >= maxReferrals` (`matching/suggest:356`). Nothing ever expires a stale lead. → A rancher with 5 ghosted intros and 0 sales shows "5/5 At Capacity" and is routed zero new buyers.

**Decisions (locked 2026-06-12):**
1. **Hybrid** capacity — fulfillment cap is the hard ceiling; live-lead count is a softer attention cap; dead leads auto-expire.
2. Release a stale slot after **14 days** of no activity (and no money on it).
3. **Auto-run** — deterministic cron, reversible, audit-logged, daily Telegram summary.
4. Add a **`Monthly Order Capacity`** field per rancher.

---

## Data model

**Ranchers table — add field:**
- `Monthly Order Capacity` (number) — how many orders the rancher can fulfill per cycle. Source of truth for the ceiling.
  - **Backfill:** blank for all existing ranchers. Fallback when blank = `Max Active Referalls` (current value, default 5). Add an input on the rancher dashboard so they can set their real number; optional outreach to collect it.

**Existing fields used (no change):** `Max Active Referalls` (now repurposed as the *live-lead attention cap*), `Current Active Referrals`, `Active Status` (Active/At Capacity/Paused), `Next Processing Date`, `State Capacity Override`.

**Referrals — add field for reversibility + idempotency:**
- `Auto Released At` (dateTime) + `Auto Released From` (text, prior status) — stamped when the liberator releases a slot, so a revert can restore exactly, and so we never re-process.

**Status buckets (from the code):**
- **Lead (holds slot, no money):** `Intro Sent`, `Rancher Contacted`, `Negotiation`
- **Committed (counts as an order):** `Awaiting Payment` with `Deposit Paid At` set, `Slot Locked`, `Closed Won`
- **Terminal:** `Closed Won`, `Closed Lost`, `Refunded`

---

## The cron — `app/api/cron/capacity-liberator/route.ts`

Runs **daily, after `capacity-drift-check`** (so the counter is already reconciled). Gated by `CAPACITY_LIBERATOR_ENABLED` env + supports `?dryRun=1`. Wrapped in `withCronRun` (Cron Runs log) like the others.

For each rancher where `Active Status ∈ {Active, At Capacity}` (skip **Paused**) and `Page Live`:

**Step 1 — Free dead slots (per-record, idempotent):**
Query their referrals in `{Intro Sent, Rancher Contacted, Negotiation}` where ALL of:
- `max(Last Rancher Activity At, Last Buyer Activity At, Intro Sent At)` > **14 days** ago, AND
- `Deposit Paid At` is blank, AND `Rancher Accepted At` is blank, AND `Auto Released At` is blank.

For each match:
- Set `Status='Closed Lost'`, `Close Reason='no_response'`, stamp `Closed At` + `Auto Released At` + `Auto Released From=<prior status>`, note "auto-released (stale 14d) by capacity-liberator".
- This triggers the existing `recordClose()` → **decrements capacity** (Redis + Airtable mirror).
- Restore the buyer's Consumer `Buyer Stage → READY` (reuse the existing F-2 "auto-restore READY on Closed Lost" path) so they re-route to a responsive rancher.
- **SIDE-EFFECT GUARD (verify before live):** audit the Closed-Lost path for any buyer-facing email or per-close Telegram. Auto-release must **suppress** buyer email (pass an `autoReleased` flag) and roll close-events into the daily summary, not fire 1 alert per release. (bhc-mutation-guardrails Rule 1 + 2.)

**Step 2 — Recompute true headroom (order-based, not lead-based):**
- `committedOrders` = count of this rancher's referrals in `{Awaiting Payment w/ Deposit Paid At, Slot Locked, Closed Won}` with the commit timestamp within the current cycle. Cycle = since last `Next Processing Date`, else rolling 30 days.
- `orderCap` = `Monthly Order Capacity` || `Max Active Referalls` (fallback).
- `headroom = orderCap − committedOrders`.

**Step 3 — Reopen the capable:**
- If `headroom > 0` AND `Active Status='At Capacity'` AND live-lead count < attention ceiling (`Max Active Referalls` × 1.2) → flip `Active Status='Active'` and `triggerLaunchWarmup()` to waitlisted buyers in served states. (Mirror `landing-page:108-110`.)

**Step 4 — Report:**
- One audit row per mutation. Aggregate into a **daily Telegram summary**: "Freed N slots across M ranchers · reopened K · headroom map." No per-action spam.

---

## Routing change (Phase 3 — fully honors Hybrid)

`matching/suggest` `isEligibleBase()` (`:343-368`): change the "full" test from pure lead-count to:
- **Hard ceiling:** `committedOrders >= orderCap` → excluded (true fulfillment limit).
- **Attention cap:** `liveLeads >= Max Active Referalls × 1.2` → excluded (prevents flooding).
A rancher is "full" only if they've committed their order cap **or** are drowning in live threads — not because old leads pile up.

---

## Guardrails / reversibility
- **Kill switch:** `CAPACITY_LIBERATOR_ENABLED` (default off until verified).
- **Dry-run first:** ship with `?dryRun=1`; run several days, eyeball the Telegram summary, before enabling writes.
- **Reversible:** `Auto Released At` + `Auto Released From` let a revert script restore released referrals to prior status + re-increment. Keep a per-run JSON of released IDs.
- **Idempotent:** `Auto Released At` blank-check prevents double-processing.
- **Conservative:** never Paused ranchers, never a referral with deposit/acceptance, never exceed cap.
- Governed by `bhc-mutation-guardrails` (side-effect inventory + per-record gates).

## Rollout
- **Phase 0:** add `Monthly Order Capacity` + `Auto Released At`/`Auto Released From` fields; dashboard input + blank-fallback.
- **Phase 1:** build cron in **dry-run**; vercel.json daily entry after capacity-drift-check; verify summaries.
- **Phase 2:** flip `CAPACITY_LIBERATOR_ENABLED=true` (live, reversible).
- **Phase 3:** matching/suggest hybrid eligibility.

## Files touched
- NEW `app/api/cron/capacity-liberator/route.ts`
- `vercel.json` (cron entry)
- `lib/rancherCapacity.ts` (headroom/committed-order helper)
- `lib/contracts/rancher.ts` or close path (`autoReleased` flag to suppress buyer email)
- `app/api/matching/suggest/route.ts` (Phase 3 eligibility)
- Rancher dashboard (Monthly Order Capacity input)
- Airtable schema (3 fields via meta API)
