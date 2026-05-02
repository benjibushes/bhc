# Stage 1 — Pipeline Rebuild Ship Runbook

**Branch:** `pipeline-rebuild`
**Goal:** force cashflow from existing leads · replace 3 parallel state machines with one · single founder voice across every customer-facing email

---

## What ships

### Code changes (in branch, ready to merge)
- **15 dead email functions deleted** from `lib/email.ts` (-755 lines)
- **6 dead cron branches stripped** from `app/api/cron/email-sequences/route.ts` (-200 lines)
- **`/update-profile` page deleted** + `WaitlistLanding.tsx` component deleted + maintenance-mode homepage fork removed
- **Homepage**: 4-audience grid → single buyer-focused CTA + small partner footer link
- **24+ "Private Network for American Ranch Beef" footers purged** across 6 files
- **13 "The HERD" / "BHC Network" instances purged** across emails + pages
- **7 new founder-voice email functions** in `lib/email.ts`:
  - `sendWelcomeAndReadyToBuy` (replaces 3-email signup flow)
  - `sendFounderLetterWaiting` (rolling monthly for WAITING buyers)
  - `sendMatchedDay4CheckIn` (replaces duplicate intro check-ins)
  - `sendPostPurchaseWelcome` (Day 0 — handshake moment)
  - `sendCutsEducation` (Day 14 — cuts cheat sheet)
  - `sendClosedMonthlyLetter` (Day 60+ — long-quiet content)
  - `sendRepeatPurchaseAsk` (Month 5 — re-engagement)
- **Consolidated state-machine cron** in `app/api/cron/email-sequences/route.ts` — single Buyer Stage-driven loop replaces the 3 parallel machines
- **Buyer Stage transitions wired** into:
  - `app/api/consumers/route.ts` (signup → NEW/WAITING/READY/MATCHED)
  - `app/api/warmup/engage/route.ts` (YES click → MATCHED + ceremonial handoff redirect)
  - `app/api/matching/suggest/route.ts` (match → MATCHED, no match → WAITING)
  - `app/api/rancher/referrals/[id]/route.ts` (Closed Won → CLOSED + Day 0 welcome)
  - `app/api/referrals/[id]/route.ts` (admin Closed Won → CLOSED + Day 0 welcome)
- **NEW `/matched` page** — ceremonial handoff after YES click, shows rancher name + "expect a call" copy

### Airtable schema changes (already live)
- **`Buyer Stage`** singleSelect (NEW / WAITING / READY / MATCHED / CLOSED) — id `fld8j9SRKgel89QaM`
- **`Buyer Stage Updated At`** dateTime — id `fldKJBNxrgk3Am9pH`

---

## Ship sequence (executed in this order on ship-day)

### 1. Pre-flight checks (~2 min)
```bash
cd "/Users/benji.bushes/BHC/untitled folder/bhc"
git checkout pipeline-rebuild
npx tsc --noEmit                  # expect: clean
npm run build                     # expect: clean
node scripts/buyer-stage-migration.mjs   # DRY-RUN — verify distribution looks sane
```

Distribution should match expected: roughly **442 READY / 480 WAITING / 357 MATCHED / 22 CLOSED / 44 SKIPPED (not approved)**.

### 2. Pause crons (~1 min)
Set Vercel env var `MAINTENANCE_MODE=true` and redeploy main (current production). All customer-facing crons short-circuit on `isMaintenanceMode()`. Buys ~10–15 min of quiet to run migration without race conditions.

### 3. Run migration (~2-5 min)
```bash
node scripts/buyer-stage-migration.mjs --execute
```

Writes `Buyer Stage` + `Buyer Stage Updated At` on every approved Consumer. Idempotent — re-running is safe.

### 4. Merge branch → main (~1 min)
```bash
git checkout main
git merge pipeline-rebuild --no-ff
git push origin main
```

Vercel auto-deploys main within ~60s.

### 5. Unpause crons (~30s)
Remove `MAINTENANCE_MODE` env var (or set to `false`) and redeploy. Crons resume; new state-machine logic runs on next cron tick.

### 6. Re-relaunch broadcast (~5 min for ~922 emails @ 350ms pacing)
```bash
node scripts/relaunch-broadcast.mjs           # DRY-RUN first
node scripts/relaunch-broadcast.mjs --execute # send
```

Sends ONE founder-voice email to every approved buyer in WAITING or READY:
- READY (~442 buyers): "your state has a rancher — ready to buy?" with YES button
- WAITING (~480 buyers): "what's coming in your state" founder letter

MATCHED + CLOSED buyers are NOT touched — no disruption to in-flight deals or post-purchase customers.

### 7. Watch first 24h
- Telegram: every YES click fires `🔥 READY-TO-BUY MATCH`
- Telegram: every Closed Won fires sale celebration
- Telegram: nightly rancher audit reports any orphans / drift / bugs
- Manually check 5 random buyer records in Airtable to confirm Buyer Stage looks right

---

## Rollback plan

If anything is on fire and we need to revert:

### Code rollback
```bash
git checkout main
git revert <merge-commit-hash>     # creates inverse merge
git push origin main
```

Vercel auto-deploys the revert. Old (pre-rebuild) cron logic resumes on next tick.

### Data rollback
The migration adds `Buyer Stage` + `Buyer Stage Updated At` but doesn't delete or modify any prior fields. `Sequence Stage` retains its old values throughout — the new cron just doesn't read them. If we revert the code, the old cron resumes reading Sequence Stage normally.

To clear `Buyer Stage` if needed: run the migration with all values set to empty (one-line script change). But there's no reason to — leaving the field populated is harmless under reverted code.

---

## What if mid-ship something breaks

- **Build fails on merge:** branch wasn't fully green. Roll back branch, fix locally, re-test, re-merge.
- **Migration fails part-way:** rerun. Idempotent — only writes for Consumers without `Buyer Stage` set, or overwrites with same value if already set.
- **Re-relaunch broadcast fails part-way:** the Resend rate limit will throttle, not fail. If it crashes, rerun — currently no idempotency on the broadcast (would re-email everyone). To make idempotent, add a `Relaunch Broadcast Sent At` Airtable field check before sending.
- **YES clicks not routing:** verify `INTERNAL_API_SECRET` env var on Vercel. If missing, /api/warmup/engage can't call /api/matching/suggest. Set it + redeploy.

---

## What's deferred to Stage 2 / Stage 3

Don't try to ship these in Stage 1:

- **Founding Herd capital raise** — Stage 2, separate branch (`founding-herd`), 4 sprints / ~13h
- **Rancher onboarding tier-page rebuild** — Stage 3, after case studies prove the marketing service
- **60-second rancher intro videos** — defer to phase B; placeholders work for ship
- **Tag-a-rancher referral mechanic** — Stage 2 / Stage 3 territory
- **Brand new homepage design** — current one is buyer-focused enough for ship; full rewrite later
- **Podcast outreach pipeline** — separate workstream, no code involvement

---

## Smoke-test checklist (run before merge)

- [ ] `npx tsc --noEmit` clean
- [ ] `npm run build` clean
- [ ] Migration dry-run shows sensible distribution
- [ ] Manually trigger `/api/cron/email-sequences?secret=$CRON_SECRET` against a preview deploy — verify it runs without errors and Telegram digest looks right
- [ ] Visit `/` — homepage renders with single buyer CTA
- [ ] Visit `/matched?rancher=Test%20Rancher&state=MT` — handoff page renders correctly
- [ ] Visit `/access` — signup form renders, "Get Access" branding everywhere (no "Join The HERD")
- [ ] Test signup with a fake address — verify single welcome email fires (not 3)
- [ ] No "Private Network" / "The HERD" / "BHC Network" anywhere in code grep

---

## Post-ship metrics to watch (first 7 days)

- READY → MATCHED conversion: target 8-15% of READY buyers click YES within 7 days of broadcast
- WAITING → MATCHED conversion via new rancher launches: should keep working (rancher-launch-warmup cron unchanged)
- MATCHED → Closed Won conversion: target 30-50% within 30 days (depends on rancher follow-through)
- Email open rate: target 30-40%+ for the broadcast (founder-voice premium)
- Unsubscribe rate: target <2% on the broadcast

If READY → MATCHED is below 5% at Day 7, the founder-voice copy needs more of an edge OR the YES button isn't standing out. Iterate.
