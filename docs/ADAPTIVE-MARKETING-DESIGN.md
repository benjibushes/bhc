# Adaptive Marketing System — design (v2 FINAL, 2026-08-08 — two-panel adversarial review folded)

Goal: the marketing machine fires itself (autopilot), measures itself
(existing scoreboard), and improves its own conversion over time
(adaptive layer) — with Ben holding only kill switches and approvals.
This doc must survive adversarial review BEFORE any build.

**Panel verdict summary:** the autopilot skeleton, safety invariants, and
non-goals SURVIVED. The adaptive knobs mostly DIED — underpowered by
40-60x at current volume (stats panel) — and the idempotency premise was
FALSE (eng panel: nothing writes `Campaign Last Sent At` on this rail).
v2 is the honest system: autopilot + measurement substrate + a gated
report that is allowed to find nothing. Adaptive knobs return at their
recorded volume triggers.

## 0 · What v2 builds (three PRs, sequential)

### PR 1 — Measurement substrate (the part learning stands on later)
- **Message-id attribution**: `guardedSend` captures `result.data.id`,
  stores it on the Email Sends row; the Resend webhook matches events by
  id instead of the latest-row-within-7d heuristic (which lets any
  intervening send steal the click stamp). Every future experiment
  label depends on this.
- **`Variant` field on Email Sends** + deterministic 50/50 hash split
  (`hash(consumerId+templateName) % 2`) between two REPO-VERSIONED
  subject variants (`lib/campaignVariants.ts`). Instrumentation only:
  no epsilon, no commit rule, no explore loop. ONE prespecified
  Fisher's exact test per template when its wave exhausts the eligible
  pool; report the CI; "inconclusive" is the expected result.
  (Stats panel: detecting +20% at our click rate needs ~8-17k/arm;
  the pool caps at ~239/arm. A real bandit's volume trigger:
  sustained ≥1,000 sends/day or eligible pool ≥10k.)
- **Campaign-rail claim stamps** — the false-premise fix: the send loop
  stamps `Campaign Last Sent At` + `Campaign Rail` claim-BEFORE-send
  with the demand-router revert-on-failure pattern
  (demand-router/route.ts:383-390, :519-533 is the template). Without
  this, any scheduled fire re-sends its cohort daily.

### PR 2 — Autopilot (the trigger removal)
- **New `lib/campaignWaves.ts`** (the derivation that previously lived
  nowhere): Consumers scan → mailable + lane + state ∈ servedStates +
  unclaimed (per PR 1 stamps) → **rancher-for-state policy** (exclusivity
  sort from lib/demandRouter; explicit per-state slug table, Ben-visible
  in the doc) → engagement-recency order → chunks of MAX_BATCH=60.
  Full TDD; pure function over injected rows.
- **Cron `campaign-autopilot`** (daily, gate INSIDE realHandler so
  dark/dry-run still writes Cron Runs rows; EXPECTED_CRONS_24H): works
  the derived queue through the requalify-send internals (extracted to
  lib, or self-call with CRON_SECRET — implementation's choice, no new
  Resend-facing code either way). Tri-state
  `CAMPAIGN_AUTOPILOT_ENABLED` (false/dry-run/true), ramp 30/day × 3
  days on any volume-character change, budget 120/day.
- **Rail coordination — the two-autopilots fix**: campaign rail owns
  FIRST TOUCH of never-campaigned buyers; demand-router owns
  post-engagement arcs (its own claims, unchanged). Mutual exclusion:
  autopilot skips any buyer the demand-router touched <7d ago (reads
  its stamps); demand-router already ignores campaign stamps by design
  — acceptable because the shared 3/week frequency cap is the backstop
  fuse and the rails now target disjoint cohorts by construction.
- **Auto-pause, fail-closed** (checked before every run): complaints
  ≥3/7d · send-failure >10% prior run · >5 hard bounces/24h · env not
  true. Plus a **cancel-scheduled sweep**: pause cancels any
  still-pending `scheduledAt` sends via Resend's cancel API (submit-time
  suppression semantics are otherwise acknowledged: an unsubscribe
  between submit and delivery still delivers ONE email — bounded by
  same-day scheduling only).
- **Domain-warmup interaction**: while `MARKETING_SEND_DOMAIN` is in
  DKIM warmup, autopilot holds at ramp volume (30/day) regardless of
  gates.
- Timing: same-day `scheduledAt` per recipient is available cheaply
  (lib/email.ts:4293) but v1 sends at cron hour — per-recipient
  send-hour optimization is KILLED at this volume (stats panel: ~95%
  of the list can't reach a 3-click history; the rest is coin-flip
  personalization). Volume trigger to revisit: >500 recipients with
  ≥10 lifetime clicks.

**PR 2 — SHIPPED (branch adaptive-pr2).** Implementation record:
- `lib/campaignWaves.ts` (pure, unit-tested) + cron
  `campaign-autopilot` (daily 15:10 UTC, gate INSIDE realHandler,
  EXPECTED_CRONS_24H). Live dispatch = self-call POST
  /api/campaign/requalify-send with CRON_SECRET (the
  triggerLaunchWarmup precedent) — zero new Resend-facing code; the
  endpoint's claim stamps now record `Campaign Rail`='autopilot' via a
  validated optional `rail` body field (default 'requalify').
- **Rancher-for-state policy (the Ben-visible table):** computed each
  run from live supply, logged in every Cron Runs row as
  `states: TX→<slug> …`. Rule, in order: operational
  (isRancherOperationalForBuyers) + has a Slug; NO exclusive-ZIP
  rancher takes a whole state while a non-gated rancher serves it (a
  Service ZIP Prefixes territory is sub-state — Thomas/Houston);
  primary state beats routing-states coverage; fewer Current Active
  Referrals; slug ascending. Pin a state manually by firing the
  operator script — the autopilot only touches never-campaigned
  buyers, so hand waves and machine waves cannot double-send.
- First-touch pool = NO campaign claim of any kind (Campaign Last Sent
  At / Campaign Rail / Campaign Stage all empty) + 7d cross-rail belt
  over the demand-router's Consumer-side stamps (incl. SMS recovery) +
  referral-truth mid-deal exclusion (activeDealBuyerKeys) + lane gate
  on stored Routing Segment ONLY (reclassify-buyers stays the only
  lane engine) + P5′ sunset-suppression marker respected.
- Budget: ramp 30/day until 3 distinct live-send days (Email Sends
  truth, `campaign_autopilot*` templates), then 120/day; the endpoint
  re-enforces the domain ceiling server-side. Warmup hold: while
  MARKETING_SEND_DOMAIN is set and MARKETING_DOMAIN_WARMED≠'true',
  ceiling stays 30.
- Auto-pause implemented as specified (complaints ≥3/7d via
  complaintTelemetry · >5 hard bounces/24h via webhook Notes stamps ·
  prior-run failure >10% at ≥10 attempts via a machine-readable
  stats[] token in Cron Runs notes · any telemetry read failure =
  alarm). NOT built: the cancel-scheduled sweep — this rail never uses
  Resend `scheduledAt` (v1 sends at cron hour), so there is nothing to
  cancel; revisit with the send-hour knob at its volume trigger.

### PR 3 — Gated weekly report (the founder-protection layer)
Cron `learning-report`, DAILY + Monday-guard inside realHandler (a true
weekly slot is watchdog-blind; EXCLUDED crons never alarm), EXPECTED
registry. Content rules — each one a hard gate, not a style note:
1. Counts, never bare rates: every finding shows raw x/n with a Wilson
   95% CI; percentages forbidden below n=50.
2. Evidence gate: no finding enters the ranked list under 10 outcome
   events. Ranking noisy metrics and reading the top is winner's curse.
3. **A null report is a normal report.** "Nothing passed the gate this
   week" ships as-is. A synthesis that always finds something is a
   noise generator.
4. Replication ledger: last week's top finding gets a mandatory
   follow-up line (held / reversed / insufficient). The reversal rate
   is the report's own honesty meter.
5. Objection/sentiment categories under 10 rows: quote the
   conversations verbatim instead of counting them.
6. Every drafted challenger variant states the n required to judge it.
   At current volume that line often reads "not judgeable before the
   list is ~20x larger" — that IS the decision information.
Promotion path unchanged: report drafts → Ben approves → variant lands
in the repo via PR → judged by PR 1's instrumentation.

**PR 3 — SHIPPED (branch adaptive-pr3).** Implementation record:
- `lib/learningReport.ts` (pure, 50 unit tests incl. hand-computable
  Fisher's-exact known answers and every null path) + cron
  `learning-report` (daily 14:10 UTC, Monday guard INSIDE realHandler,
  EXPECTED_CRONS_24H — exactly as specified above). Delivery = Telegram
  admin chat, the weekly-scorecard idiom; Mondays it lands 10 minutes
  after the scoreboard.
- The prespecified test (deferred from PR 2's record): ONE two-sided
  Fisher's exact per `campaign_*` template, α=0.05, clicked/sent per
  arm, cumulative. HARD gates as content rules 1-3: below 10 outcome
  events the type system carries no p-value at all ("insufficient
  data: n=X of 10 needed"); bare point-percentages render only at
  n≥50 (Wilson 95% CI always); the null report is a first-class
  render. Opens are reported per arm but labeled MPP-inflated and
  never enter a test or verdict.
- Replication ledger (rule 4): the top finding is frozen as a
  machine-readable `ledger[…]` token in the report's own Cron Runs
  note (the autopilot `stats[]` precedent — the report's ONLY write
  surface); next Monday's run grades held/reversed/insufficient on
  the WEEK-DELTA counts (cumulative minus token), never on
  overlapping data.
- Volume triggers (§1) restated every week with live distances:
  sends/day 7d avg + autopilot eligible pool (parsed from its Cron
  Runs note) vs the bandit's 1,000/day · 10k-pool; recipients with
  ≥10 lifetime clicks vs the send-hour 500; top-state clicks vs the
  state-cut 25 (+ the not-built exploration share); opens NEVER.
  Rule 6 ships as the pooled required-n line (~n/arm for +20% at the
  observed click rate, power 0.8, with the ×-more-data multiplier).
- Read-only over Airtable (Email Sends, Consumers, Cron Runs) except
  its own Cron Runs row; a failed CORE read sends no report (partial +
  named reason) — a report over unknown data would fabricate
  conclusions; auxiliary read failures degrade named-and-visible.
- DEVIATION from rule 5: verbatim conversation quotes are BANNED from
  the report body (public-repo/PII rule — the report aggregates counts
  only). No objection/sentiment source exists yet anyway; when one
  lands, under-10-row categories must POINT to the raw conversations
  (Airtable/admin) instead of quoting them into the report.

## 1 · Killed knobs and their return triggers (recorded so we don't re-litigate)
- Subject bandit (ε-greedy/commit): return at ≥1,000 sends/day.
- Per-recipient send-hour: return at >500 recipients w/ ≥10 clicks.
- State-level cut preselect: return at ≥25 outcomes/state AND a 10%
  random-exploration share (the argmax feedback loop manufactures its
  own evidence). Until then: NATIONAL default cut only, labeled
  "default", banned from the report as a "learning".
- Opens as ANY learning signal: never. Click-only. (MPP prefetch fires
  25min-to-hours after delivery; no discard window survives that.)

## 2 · Safety invariants (v2, each testable)
1. No runtime-generated prose is ever sent. Scoped precisely: the
   autopilot/campaign module import graph contains no `lib/ai` (the
   repo-wide version is already false — the inbound reply classifier
   legitimately selects baked autoresponses; that path is out of
   scope and unchanged).
2. Adaptive/scheduling choices select only among pre-approved artifacts
   and timing inside existing caps; eligibility, suppression, and
   sunset sit upstream, untouched.
3. Complaint alarm pauses autopilot before the next run + cancels
   pending scheduled sends; telemetry read failure ⇒ treated as alarm.
4. Every run logs its decision inputs (Cron Runs notes; Variant +
   message-id on Email Sends). Full audit trail.
5. Kill switches per subsystem, tri-state, fail-to-off:
   CAMPAIGN_AUTOPILOT_ENABLED, ADAPTIVE_VARIANTS_ENABLED.
6. Claim-before-send everywhere (PR 1 closes the campaign-rail hole);
   idempotent by stamps, not by memory.
7. Read-only on money tables.
8. Ramp on volume-character change; warmup-capped while the marketing
   domain warms.
9. Rail disjointness: first-touch (autopilot) vs arcs (demand-router),
   with the 7d cross-rail skip and the 3/week cap as fuse.

## 3 · Rollout gates
- L0 Shadow: all tri-states at dry-run ≥1 week; logged plans reviewed;
  gate = 7 clean days, zero guard violations, plans match expectation.
- L1 Live at ramp (30/day): gate = 200 sends, zero violations,
  complaint rate <2/7d.
- L2 Full budget (120/day): gate = two consecutive clean weeks.
- L3 (future, at volume triggers): the killed knobs, each with its own
  doc + panel.

## 3.5 · CRM-parity layer (2026-08-08 research + gap-map)

Two-agent finding: 7 of 8 standard automated-CRM capability classes
already exist in this stack (scoring, NBA engine, deal-rot/SLA layer,
behavior-triggered enrollment, buyer timeline, task generation, AI
reply staging). The gaps are DELIVERY, not capability — computed
outputs that never reach /admin/today, and one missing join. Rule
inherited from the gap-map: extend the cockpit, never build a second
engine.

Four builds (C1-C3 = one cohesive cockpit PR; C4 separate):
- **C1 Dial-outcome write-back (S)** — 3 buttons per dial card (No
  answer / Talked, follow up in N days / Drop) → thin POST → existing
  `Last Chased At` + `Next Follow Up At` writers (the telegram `skip`
  handler and /api/admin/follow-ups are the templates). Closes the
  fire-and-forget leak that starves closeQueue staleness and
  followUpQueue promises.
- **C2 Cockpit queue fusion (S/M)** — merge `followUpsDue` +
  `rankCloseQueue` rows (already computed server-side in the desk API)
  into `buildCockpitDialList` as `promise` and `deal` row kinds, each
  with its NBA one-liner — the orphaned lib/nextBestAction output
  finally rendered on the one screen Ben opens. No new ranker.
- **C3 Replies-waiting band (S)** — cockpit block listing Conversations
  with Reply Status staged/escalated + one-tap Send; lift the telegram
  `bsend` claim/sanitize/thread logic into a shared lib. Kills the
  scrolled-away-Telegram-card failure mode.
- **C4 Per-flow revenue stamp (M, once sends scale)** — at Deposit
  Paid, last-touch lookback over Email Sends (5-day window) stamps
  `Attributed Campaign` on the Referral; one scoreboard row. The cheap
  80% of flow attribution; full cohort plumbing stays YAGNI.

Deferred with recorded trigger: missed-call text-back (62% of SMB calls
missed; 25-45% recoverable) — rides the TCPA/SMS wave W2c. Rejected on
2025-26 evidence: autonomous AI SDRs (50-70% churn, fabricated-metrics
scandals) — never build.

## 4 · Explicit non-goals (unchanged from v1, panel-confirmed)
Per-user ML at 22 lifetime conversions · runtime LLM copywriting into
sends · adaptive cadence/windows · dynamic pricing/deposits · SMS
adaptation before TCPA capture.
