# War-Ready Funnel + Sales Floor v1 — Design Spec

**Status:** Locked 2026-06-09. Approved by user.

**Goal:** Build bulletproof end-to-end buyer funnel + ad-readiness + missing CRM features + unit-economics fix. Zero broken features. Per-task verify before next. Output a GO_TO_MARKET.md when done so user can ship paid ads w/o gaps.

**Mission (shared):** Connect every household to a ranch they trust.

**Voice (locked dual):**
- Buyer-facing (`/access`, `/qualify`, `/`, `/matched`, buyer emails): product-led — "Buy half a cow. Direct from the rancher."
- Rancher-facing (`/partner`, `/founders`, `/rancher`, `/rancher/setup`, rancher emails): infra-led — "Modern sales infrastructure for DTC ranchers."

## Decisions locked

| # | Decision | Effect |
|---|---|---|
| A | Dual voice + shared mission | Drives all copy across buyer + rancher surfaces |
| B | $49 Reservation Hold = feature-flagged stub, default OFF | Architecture stub in place. Flip env var when tire-kicker filter needed. |
| C | No Featured tier add-on | Ranch + Operator carry placement value already |
| D | $497 White Glove Onboarding = optional wizard upsell | Stripe Payment Link, presented at agreement step |
| E | SMS gates = feature-flagged stubs, default OFF | Wire stubs for 7 gates. Flip on when Twilio provisioned. |
| F | Pixel placement = audit + wire existing pixels to every conversion event | No rebuild. Just verify + place. |

## Features to ship (13, in 4 phases)

### Phase 1 — Foundation
- **F1**: Brand voice + mission lock across `/access`, `/qualify`, `/`, `/matched`, buyer emails
- **F2**: Pixel placement audit — verify Meta Pixel + CAPI + GA4 + Google Ads + TikTok fire on every conversion event
- **F3**: Funnel observability — UTM admin viz + funnel-stage analytics

### Phase 2 — CRM essentials
- **F4**: Composite lead score on Consumers + surface on /admin/today/v2 cards
- **F5**: Resend open/click webhook → Email Sends Airtable per Consumer
- **F6**: Next-best-action widget on /admin/today/v2 (top 5 to call sorted by score × recency × engagement)

### Phase 3 — Conversion gates
- **F7**: $49 Reservation Hold stub + Cal book gate (feature-flagged)
- **F8**: $497 White Glove Onboarding upsell + wizard sign step
- **F9**: SMS gate stubs for 7 events (feature-flagged)
- **F10**: Funnel friction polish — phone optional toggle, stale JWT recovery, abandoned-quiz nudge

### Phase 4 — Sales floor v3.5
- **F11**: Click-to-call + auto-record + Whisper transcribe per Consumer
- **F12**: Deal-rot indicator + drag-to-stage on /admin/today/v2
- **F13**: Email open/click telemetry surfaced on desk cards

## Per-feature sub-plan structure

Every F-task follows 5 stages:

1. **Pre-flight** — read existing code touchpoints, deep-research best practices where uncertain, draft 200-word sub-spec w/ files, env vars, schema deltas, side-effect inventory, user approval gate
2. **Build** — Airtable schema changes via API (typecast=true), env vars in Vercel, smallest passing slice, isolated commits, typecheck + lint clean each commit
3. **Verify** — systematic-debugging Phase 1-4, Chrome MCP browser E2E, post-deploy canary 15 min monitoring
4. **Document** — BUILD_LOG.md entry, GO_TO_MARKET.md user-facing delta, BHC-OPERATIONS-MANUAL.md if ops surface changed
5. **Gate** — user reviews working state, says "ship next" or "rollback"

No feature starts before previous is shipped + verified + documented.

## Build cadence

- 1 feature per session unless trivial (F2 polish, F12 UI tweak)
- Each session: 1-3 hrs total (build + verify + docs)
- User check-in after every feature
- Telegram alert "F[N] live, verified" at each ship

## Deliverables (per feature + end of project)

### Per feature
- Commit + push to main
- BUILD_LOG.md row appended
- GO_TO_MARKET.md updated section
- Working URL or test cmd to validate

### End of project (GO_TO_MARKET.md final)
- What was built (each F1-F13 summary)
- How user uses it (ops playbook per surface)
- How user verifies it (test commands)
- How user rolls it back (rollback per feature)
- Env vars in play (full inventory)
- Critical paths (Telegram alerts to watch)
- Known limitations + future polish list
- Cohort-1 launch checklist (Day 0, Day 1, Week 1, Week 4)

## Risk mitigations

- **Feature flags everywhere** — every new behavior behind env flag, default OFF for risky paths
- **Rollback script per feature** — every BUILD_LOG.md row includes literal rollback cmd
- **No batched commits** — one concern per commit, easy to git revert
- **Synthetic test rancher reused** — recBVR538JW2ZfTuX for E2E sweeps
- **Telegram pre-fire on every prod mutation** — per bhc-mutation-guardrails Rule 2
- **Post-deploy canary** — 15 min monitoring after every ship before declaring success
- **No prod data touch without inventory** — Rule 2: count emails, webhooks, Airtable writes before firing

## Verification gates (red/green per feature)

Feature ships GREEN only if:
- ✅ Typecheck passes
- ✅ Build deploys to prod (verified via /api/version)
- ✅ Chrome MCP E2E for new UI surfaces passes
- ✅ No new error logs in Vercel for 15 min post-deploy
- ✅ No Cron Runs failures in next cron cycle
- ✅ Synthetic test confirms data writes flow correctly
- ✅ Telegram alert fires for "F[N] verified"

Any RED gate = rollback, root-cause investigate, re-ship.

## Out of scope (defer)

- AI SDR (Close.com Chloe pattern) — defer until F11 transcripts give substrate
- Rancher outbound (Apollo/Clay pattern) — separate workstream, separate plan
- iOS app — defer
- Subscription billing for buyers — defer

## Open questions resolved during brainstorming

- Q: Brand voice unified or split? A: Split dual (decision A)
- Q: Reservation hold required at launch? A: No, feature-flag stub (decision B)
- Q: Featured rancher SKU? A: No, lean into Ranch + Operator (decision C)
- Q: Rancher setup fee mandatory or optional? A: Optional $497 white-glove upsell (decision D)
- Q: SMS gates at launch? A: No, stub for later (decision E)
- Q: Rebuild pixels or place existing? A: Place existing (decision F)

## Next step

Invoke `superpowers:writing-plans` to generate implementation plan per feature.
