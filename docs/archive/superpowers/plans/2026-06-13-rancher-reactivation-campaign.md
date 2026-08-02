# Rancher Reactivation Campaign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
>
> **NO TEST FRAMEWORK EXISTS IN THIS REPO** (confirmed: package.json has only dev/build/start/lint/boundaries:check; no jest/vitest/playwright). Classic TDD is impossible. Each task's verification step is therefore: (a) `npm run build` typecheck passes, and (b) a concrete manual/preview check. Do NOT invent a test runner.

**Goal:** Send a staggered, sanity-paced "book a v2 call or remove yourself" email campaign to ~44 dormant legacy ranchers (not live / not getting leads), driving them to Ben's Cal link, and auto-cleaning the list of non-responders.

**Architecture:** Reuse existing infra wherever possible. "Remove me" = the EXISTING `/api/unsubscribe` one-click flow (already sets `Unsubscribed: true`, already suppressed by the send layer). New code is only: two whitelisted email templates + one daily campaign cron that segments, spaces, sends, and reconciles removed/dormant ranchers. No new public endpoint.

**Tech Stack:** Next.js 15 (app router), Airtable (`lib/airtable.ts`), Resend via `sendEmail`/`guardedSend` (`lib/email.ts`), Vercel cron (`vercel.json` + `app/api/cron/*`), Telegram alerts, audit log.

**Hard rollout gates (no-mistakes discipline):** branch → `npm run build` green → Vercel PREVIEW deploy → codex review of the diff → live smoke (send 1 to Ben, click Remove, confirm `Unsubscribed`) → promote to prod → arm Monday start behind a flag. NO overnight blind prod deploy. The 44-rancher send is gated on Ben's explicit "launch."

---

## Segment definition (the campaign audience)

Source: `getAllRecords(TABLES.RANCHERS)`, filter in-memory.

INCLUDE (legacy, not live, not getting leads), split two tiers:
- **Tier A (warm, ~30):** `Pricing Model = legacy` AND Onboarding Status in {`Call Complete`, `Docs Sent`, `Verification Complete`} AND NOT (Active Status = Active AND Onboarding = Live).
- **Tier B (cold, ~14):** `Pricing Model = legacy` AND Onboarding Status empty/blank.

EXCLUDE always:
- `Pricing Model = tier_v2` (the 8 cohort + tests).
- Wave-1 closers: recUpqF6yUAULpbPG, recawSbn7dhszHQl5, recVTmaMqVw191TQv, recBkfqjMQ2txI8AM, recy4vT2788bxLTkD, rec2ni15F7NXtY9Ij.
- Active+Live legacy already getting leads (Gift, JC's, Rafter S7, High Lonesome, Foodstead, Brimstone, Rocky Ridge, DD).
- Left Hand Cattle (recj1xWIDMaooGxFQ — Onboarding = Call Scheduled, mid-funnel).
- Hold-outs (manual): Matula (recvtFXpo6FJ2l9XI), ZK (recPG2ZQ4q0PnANba), AU Beef (recPSwo6VMkmBNVl5), Next Horizon (recUJmcAdyLgLCMzi), Carters American Beef (recKIK3MyGxJ5cQx1).
- `Unsubscribed = TRUE` / `Bounced = TRUE` / `Complained = TRUE` (suppression — the send layer also enforces this).
- Test rows: "Synthetic E2E Test Ranch", "Demo Cattle Co", and the duplicate Renick (rec3K0LsDGQKONNnb).

The cleanest implementation is an explicit exclude-id allowlist constant for Wave-1 + hold-outs + active-live + Left Hand, plus the field-based tier filters.

---

## File structure

- Modify `lib/email.ts` — add `sendRancherReactivationWarm()` + `sendRancherReactivationCold()` (mirror `sendRancherApproval` shape, lines ~1325–1378). Each includes Book CTA (Cal) + Remove CTA (= `getUnsubscribeUrl(email)`).
- Modify `lib/emailFrequencyGuard.ts` — add both template names to `TRANSACTIONAL_WHITELIST` (~line 73) so the campaign isn't dropped by the 3/week cap.
- Create `app/api/cron/rancher-reactivation/route.ts` — the daily campaign engine (mirror `app/api/cron/migration-deadline/route.ts` pattern: `getAllRecords` → filter → sequential send with per-record try/catch → Telegram digest → CRON_SECRET auth → `withCronRun`).
- Create `lib/rancherReactivationSegment.ts` — pure segmentation + exclude-list constants (testable-by-reading, importable by the cron). One responsibility: "given all ranchers + today, return {tierAToSend, tierBToSend, reminders, toMarkDormant}".
- Modify `vercel.json` — add cron `{ "path": "/api/cron/rancher-reactivation", "schedule": "0 16 * * 1-5" }` (16:00 UTC = 10:00 MT weekdays; matches the 10am send rhythm).
- Airtable (Ranchers table tbl08y9Be45zNG0OG): add fields `Last Campaign Email Sent At` (dateTime), `Campaign Tier` (singleSelect: A, B), `Campaign Touch Count` (number). Confirm `Unsubscribed` + `Unsubscribed At` exist on Ranchers (scout: present on Consumers, wrapped try/catch for Ranchers — verify and add if missing).

---

### Task 1: Airtable field prep

**Files:** none (Airtable schema via MCP `create_field` or Airtable UI).

- [ ] **Step 1:** Confirm/add on Ranchers (tbl08y9Be45zNG0OG): `Unsubscribed` (checkbox), `Unsubscribed At` (dateTime), `Last Campaign Email Sent At` (dateTime), `Campaign Tier` (singleSelect: A,B), `Campaign Touch Count` (number). Use Airtable MCP `create_field` for any missing; verify with `get_table_schema`.
- [ ] **Step 2 (verify):** `get_table_schema` shows all 5 fields with correct types. Record their field IDs in this plan.

### Task 2: Two reactivation email templates

**Files:** Modify `lib/email.ts` (add two functions near other rancher templates); Modify `lib/emailFrequencyGuard.ts` (`TRANSACTIONAL_WHITELIST`).

- [ ] **Step 1:** Add `sendRancherReactivationWarm({ firstName, ranchName, state, email })` mirroring `sendRancherApproval` (guardedSend, getFromEmail, getUnsubscribeHeaders, footer). Body = the approved Tier-A copy; Book CTA → `https://cal.com/ben-beauchman-1itnsg/15min`; Remove CTA → `getUnsubscribeUrl(email)`. `templateName: 'sendRancherReactivationWarm'`. Subject: `still want buyers from us, ${firstName}?`
- [ ] **Step 2:** Add `sendRancherReactivationCold({ firstName, ranchName, email })` — approved Tier-B copy. Subject: `closing your BuyHalfCow listing unless…` `templateName: 'sendRancherReactivationCold'`.
- [ ] **Step 3:** Add both template names to `TRANSACTIONAL_WHITELIST` in `lib/emailFrequencyGuard.ts`.
- [ ] **Step 4 (verify):** `npm run build` passes. Add a temporary dev-only script (or use an existing one) to render the HTML to a file and eyeball it; or rely on the preview smoke in Task 5.
- [ ] **Step 5:** Commit: `feat(email): rancher reactivation templates (warm + cold) + whitelist`.

### Task 3: Segmentation module

**Files:** Create `lib/rancherReactivationSegment.ts`.

- [ ] **Step 1:** Export `EXCLUDE_RANCHER_IDS` (Wave-1 + hold-outs + active-live + Left Hand + dup-Renick, exact recIds above) and `segmentRanchers(allRanchers, now)` returning `{ tierAToSend, tierBToSend, reminders, toMarkDormant }` per the segment definition + spacing rules (Task 4).
- [ ] **Step 2 (verify):** `npm run build` passes; add a one-off `tsx` script `scripts/_preview-reactivation-segment.ts` that prints counts + names per bucket from live Airtable (read-only) and confirm the numbers match this plan (~30 A, ~14 B, 0 to-send for excluded). Commit the script.
- [ ] **Step 3:** Commit: `feat(campaign): rancher reactivation segmentation + exclude list`.

### Task 4: Campaign cron

**Files:** Create `app/api/cron/rancher-reactivation/route.ts`; Modify `vercel.json`.

Spacing/cadence rules (sanity): per run (daily 10am MT weekdays) — send to at most **8** un-touched ranchers (Tier A first, then B); a rancher with `Last Campaign Email Sent At` < 5 days ago is skipped; at **+5 days** with no Cal booking and not unsubscribed → send ONE reminder (Touch Count → 2); at **+10 days** silent (Touch Count ≥ 2) → mark dormant: `Claim Status = removed-on-request`, stop. Booking detection: rancher's Migration Status = `call_scheduled` OR a Cal booking stamp present.

- [ ] **Step 1:** Implement `realHandler` mirroring `migration-deadline/route.ts`: `getAllRecords(TABLES.RANCHERS)` → `segmentRanchers` → sequential for-loop send (check `result?.suppressed`) → after each send `updateRecord` sets `Last Campaign Email Sent At`, `Campaign Tier`, increments `Campaign Touch Count` → `logAuditEntry({actor:'cron',tool:'rancher-reactivation',...})` per send → Telegram digest. Daily cap 8. RESPECT a global flag `process.env.RANCHER_REACTIVATION_ENABLED === 'true'` AND `today >= CAMPAIGN_START_DATE` (env, set to Monday) — else no-op and return early.
- [ ] **Step 2:** Auth gate via CRON_SECRET (Bearer header or `?secret=`), wrap in `withCronRun('rancher-reactivation', realHandler)`. Export GET + POST. `maxDuration = 180`.
- [ ] **Step 3:** Add to `vercel.json` crons: `{ "path": "/api/cron/rancher-reactivation", "schedule": "0 16 * * 1-5" }`.
- [ ] **Step 4 (verify):** `npm run build` passes. With `RANCHER_REACTIVATION_ENABLED` unset, hitting the route returns the no-op early-return (verify on preview in Task 5).
- [ ] **Step 5:** Commit: `feat(campaign): rancher reactivation cron (flag-gated, staggered, 8/day)`.

### Task 5: Preview deploy + live smoke (NO prod yet)

- [ ] **Step 1:** Push the branch; let Vercel build a PREVIEW deployment (do not promote). Confirm READY via Vercel MCP `list_deployments`.
- [ ] **Step 2:** On preview, with a temporary `RANCHER_REACTIVATION_ENABLED=true` + a 1-record allowlist pointing only at a Ben-owned test address, trigger the cron once (`?secret=$CRON_SECRET`). Verify exactly one email arrives, renders correctly, has working Book + Remove links.
- [ ] **Step 3:** Click the Remove link → confirm it lands on the existing unsubscribe page and sets `Unsubscribed: true` on the test record (check Airtable). Re-trigger cron → confirm that record is now skipped (suppressed).
- [ ] **Step 4:** Revert the temp test allowlist + env. Commit any fixes.

### Task 6: Independent review

- [ ] **Step 1:** Run `/codex review` (codex skill) on the full branch diff. Address every correctness finding. Re-run until clean.
- [ ] **Step 2:** Commit fixes.

### Task 7: Promote to prod + arm Monday

- [ ] **Step 1:** Merge branch → main (auto-deploys prod). Confirm prod deploy READY.
- [ ] **Step 2:** In Vercel prod env, set `CAMPAIGN_START_DATE` = Monday 2026-06-15, leave `RANCHER_REACTIVATION_ENABLED=false` until Ben's explicit "launch." Confirm the cron no-ops in the meantime (Telegram/Cron Runs shows early-return).
- [ ] **Step 3:** On Ben's "launch": set `RANCHER_REACTIVATION_ENABLED=true`. The cron begins Monday 10am MT, 8/day, Tier A first.

### Task 8: Launch monitoring

- [ ] **Step 1:** Day 1: watch the Telegram digest + Resend bounce/complaint rate. If bounces spike (cold Tier B addresses), pause Tier B (flag) and clean addresses.
- [ ] **Step 2:** Log a daily summary row to the Agent Log; surface bookings into START-HERE / COMMAND-CENTER.

---

## Self-review notes
- Spec coverage: book-or-remove ✔ (Book=Cal, Remove=existing unsubscribe), staggered/sanity cadence ✔ (8/day + 5d spacing + Cal 4/day cap), auto-clean ✔ (+10d dormant), show-before-run ✔ (flag-gated, Ben launches), no-mistakes ✔ (preview + codex + smoke before prod).
- No test runner: every verify step is build + manual/preview, explicitly.
- Held-outs + Wave-1 + active-live hardcoded by recId to prevent double-contact.
