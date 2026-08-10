# Adaptive Marketing System — design (draft v1, 2026-08-08)

Goal: the marketing machine fires itself (autopilot), measures itself
(existing scoreboard), and improves its own conversion over time
(adaptive layer) — with Ben holding only kill switches and approvals.
This doc must survive adversarial review BEFORE any build.

## 0 · The decision inventory

Every choice the funnel makes, classified:

| Decision | Today | Target | Why |
|---|---|---|---|
| WHO gets email | Lane engine + windows + sunset (fixed policy, panel-validated) | UNCHANGED | Eligibility is policy, not experiment |
| WHEN a wave fires | Ben's word | **Autopilot cron** (fixed sequencing policy) | Removes the human trigger |
| WHEN in the day a send goes | Cron hour | **Adaptive: per-recipient send hour** | Cheap, safe, compounds |
| WHICH subject line | Single baked | **Adaptive: 2-arm bandit per template** | Only knob with volume to learn on |
| WHICH cut is preselected | Decision helper's static order | **Adaptive: state-level conversion prior** | Zero-risk (any cut link works) |
| Follow-up cadence | Intent windows (7d/14d, panel-validated) | FIXED — explicit non-goal | Cadence experiments need months at our n |
| Copy body | Baked in repo | FIXED runtime; **evolves via weekly synthesis → human-approved PR** | Brand + CAN-SPAM: no machine-sent prose, ever |
| Budget allocation across lanes | 120/day flat | FIXED v1; adaptive DEFERRED until ≥2 full waves of outcomes | No data yet to allocate on |

## 1 · Autopilot (the trigger removal)

Daily cron `campaign-autopilot` (date-guarded pattern):
- Works a **wave queue** derived at runtime: for each served state
  (shared `getServedStates` helper), one-tap-eligible uncampaigned
  buyers first (ordered by engagement recency), then quiz-CTA
  remainder. No stored queue to drift — recomputed each run,
  idempotent because campaign stamps (`Campaign Last Sent At`) are
  claim-before-send.
- Budget: `DAILY_CAMPAIGN_BUDGET` (120) unchanged; **ramp rule**: first
  3 autopilot days cap at 30/day (complaint-signal warmup at the exact
  moment volume character changes).
- Fires through the EXISTING `/api/campaign/requalify-send` internals
  (baked template, guarded rail, per-recipient resolution, reply
  threading) — autopilot adds zero new send code, only scheduling.
- **Auto-pause conditions** (checked before every run, fail-closed):
  complaint telemetry ≥3/7d · send-failure rate >10% previous run ·
  bounce spike (>5 hard bounces/24h) · `CAMPAIGN_AUTOPILOT_ENABLED`
  not `true` (tri-state: false / dry-run / true; dry-run logs the
  would-send plan to Cron Runs).
- Every run writes counts + first/last recipient hash to Cron Runs.

## 2 · Adaptive knob A — per-recipient send hour

- **Input**: recipient's historical CLICK timestamps (preferred), else
  opens with the MPP filter below; ≥3 events required, else lane
  default (16:00 UTC).
- **MPP poisoning defense** (the trap): Apple Mail prefetch fires
  "opens" near delivery, so learning send-time from raw opens just
  confirms whatever hour we already send. Rule: **discard opens within
  15 minutes of delivery** for the histogram; clicks are always
  trusted. If filtering leaves <3 events, fall back to default. Never
  learn from a single event.
- **Rule**: mode of 2-hour buckets over trusted events → the send is
  scheduled into that bucket (within the same day's budget window).
- **Blast radius**: an email arrives at a different hour. Worst case ≈
  baseline. No cap, suppression, or eligibility logic touched.

## 3 · Adaptive knob B — subject-line bandit (per template)

- **Arms**: exactly 2, both **repo-versioned** (`lib/campaignVariants.ts`),
  both brand-checked at PR time. Runtime cannot mint arms.
- **Assignment**: deterministic — `hash(consumerId + templateName) % 2`
  offset by an epsilon coin (ε=0.2 exploration). Deterministic base
  prevents assignment drift on retries; the assigned arm is stamped on
  the Email Sends row (`Variant` field) at send time.
- **Outcome**: click within 72h of send (never opens — MPP). Attribution
  by the existing Resend webhook → Email Sends `Clicked At`.
- **Decision rule**: no commitment below **200 sends/arm**. At
  threshold: two-proportion z-test; commit winner only if relative
  lift ≥20% AND p<0.05; otherwise keep exploring. Committed winner
  takes 100% until a new challenger ships (via weekly synthesis → PR).
- **Why not Thompson/multi-arm**: at our volume, 2 arms + hard
  thresholds is the honest ceiling; more arms = sample starvation.
- **Blast radius**: a subject line underperforms for ≤200 sends ≈ a
  few lost clicks. Copy itself is pre-approved.

## 4 · Adaptive knob C — cut preselect (state-level)

- **Input**: all-time deposit conversions by (state, cut) from Referral
  stamps — pooled, not campaign-only.
- **Rule**: Beta(1,1) posterior mean per cut; state uses own data at
  n≥5 else national aggregate. Preselect argmax on the one-tap link.
- **Blast radius**: none — every cut link lands on the same deposit
  page with the cut switchable.

## 5 · Weekly synthesis (the copy-evolution loop)

Cron `learning-report` (weekly, Monday 14:00 UTC):
- Aggregates: per-template sends/clicks/deposit-events by lane · funnel
  drop-points · wave outcomes · **objection categories + sentiment from
  Conversations rows** (already AI-classified on ingest).
- Produces ONE report (Telegram + scoreboard block): ranked findings,
  each with evidence counts, and — where the evidence is copy-shaped —
  a **drafted challenger variant** included as a diff-ready snippet.
- **Hard rule: the report never sends anything and never writes
  templates.** Promotion path is exclusively: Ben approves → variant
  lands in `lib/campaignVariants.ts` via PR → bandit judges it.
- The report includes its own sample-size caveats (event-count gates
  from P6′) so a lucky week can't masquerade as signal.

## 6 · Safety invariants (each testable, each with an owner)

1. **No runtime-generated prose is ever sent.** Only repo-versioned,
   PR-reviewed templates/variants. (Test: send path imports only from
   static variant module; no LLM call in any send path.)
2. Adaptive choices select only among pre-approved artifacts and
   timing inside existing caps. Eligibility/suppression/sunset logic
   sits UPSTREAM of every adaptive choice and is untouched by it.
3. Complaint alarm (≥3/7d) pauses autopilot before the next run.
   Fail-closed: telemetry read error ⇒ treated as alarm.
4. Every adaptive decision logs its inputs snapshot (Cron Runs notes /
   Email Sends Variant field) — full audit trail, reproducible.
5. Per-subsystem kill switches, env-gated, default OFF:
   `CAMPAIGN_AUTOPILOT_ENABLED`, `ADAPTIVE_SEND_TIME_ENABLED`,
   `ADAPTIVE_SUBJECT_ENABLED`, `ADAPTIVE_CUT_ENABLED` (all tri-state
   with dry-run).
6. Claim-before-send idempotency preserved everywhere; autopilot adds
   no new send primitives.
7. The adaptive layer is read-only on money tables (Referrals/Stripe
   stamps are inputs, never outputs).
8. Ramp rule on any volume-character change (30/day × 3 days).

## 7 · Failure-mode table

| Failure | Detection | Blast radius | Auto-response |
|---|---|---|---|
| MPP inflates opens → bad send hours | Design: opens near delivery discarded; clicks preferred | A few mistimed sends | Falls back to lane default |
| Bandit commits on noise | Hard n≥200/arm + p<0.05 + ≥20% lift | ≤200 suboptimal subjects | No commit below threshold, ever |
| Autopilot fires during complaint spike | Telemetry check pre-run, fail-closed | Zero (pauses before sending) | Pause + loud operatorSignal |
| Airtable outage mid-wave | Claim-before-send stamps | Partial wave, no duplicates | Next run resumes unsent remainder |
| Double-fire (cron overlap/retry) | Date-guard + per-consumer claim | Zero duplicate sends | Claim loses → skip |
| Variant module missing/malformed | Import-time validation test | Send falls back to base subject | Alert; base copy always exists |
| Survivorship skew (learning only on the engaged) | Synthesis reports per-lane denominators | Analytical only | Report labels cohort explicitly |
| Env misconfiguration | Tri-state parse: anything ≠ true ⇒ off/dry-run | Zero sends | Fail-to-off |

## 8 · Rollout gates (no phase starts before the prior's gate)

- **L0 — Shadow (1 week min):** all four subsystems in dry-run.
  Decisions computed + logged, nothing applied, nothing sent by
  autopilot. Gate: 7 clean days of logged plans matching expectations.
- **L1 — Apply timing + cut** (lowest risk knobs). Gate: 200 sends with
  zero guard violations in logs.
- **L2 — Subject bandit live.** Gate: first commit-or-keep decision
  reached honestly (no early commits in logs).
- **L3 — Autopilot full budget** (ramp done). Gate: complaint rate
  stable <2/7d across two consecutive weeks.
- **L4 (deferred, needs ≥2 waves of outcomes):** adaptive budget
  allocation across lanes. Not designed here; separate doc + panel.

## 9 · Explicit non-goals (rejected, with reasons)

- Per-user ML / propensity scores: sample starvation at 22 lifetime
  conversions; would fit noise and look impressive doing it.
- Runtime LLM copywriting into live sends: brand voice + CAN-SPAM +
  auditability. The synthesis DRAFTS; humans promote.
- Adaptive cadence/windows: panel-validated policy; changing it by
  bandit needs months of arcs we don't have.
- Dynamic pricing/deposit amounts: rancher relationships + trust; money
  terms are policy, never experiments.
- Cross-channel (SMS) adaptation: blocked on TCPA opt-in anyway.

## 10 · Build shape (only after this doc survives review)

Three PRs, sequential: (1) `lib/adaptiveDecisions.ts` (pure: histogram,
bandit, prior — full TDD) + variant module + Email Sends `Variant`
field wiring; (2) `campaign-autopilot` cron + tri-state envs + ramp +
pause checks; (3) `learning-report` cron + scoreboard block. Shadow
mode ships dark in all three.
