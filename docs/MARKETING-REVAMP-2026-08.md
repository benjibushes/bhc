# MARKETING REVAMP — 2026-08-08

The systemized rebuild of the entire D2C marketing machine. Ordered by Ben
("do not tread lightly") after the 2026-08-08 money audit. This doc is the
single source of truth for the revamp: ground truth, principles, lane
architecture, teardown ledger, build phases, and the metrics that decide
whether it worked. One PR-sized phase per session; update this doc as
phases land.

---

## 1 · GROUND TRUTH (2026-08-08 money audit — all numbers live-verified)

- **2,744 consumers. Only 1,003 (37%) live in a state with an Active
  rancher.** 1,741 cannot buy a share at any price: FL 163, AZ 139*,
  CO 108, WA 82, GA 75, IL 74 top the stranded list.
  (*AZ flips addressable the day Gila River Cattle's record is completed —
  it exists as a bare shell: no Active Status, no pricing model, no
  agreement.)
- 13 Active ranchers / 11 states. TX (333 buyers) throttled behind Lazy
  Bar 3's price call + Thomas's ZIP gate; CA (305) has one ranch.
- Email program last 7d: **1,858 sends, ~0 merchandising.** 268
  abandoned-quiz nudges, 179 profile asks, 148 waiting-activation, ~220
  nurture drips, 46 ready-chases. 67 cap-exceeded suppressions in 48h =
  the cap system straining against nudge volume.
- Machine verification: 16/16 money endpoints correct, 0 prod 5xx/6h,
  410 cron runs/24h with 0 errors, synthetic signup stamps in ~1s, all
  12 revenue emails carry durable money links, deposit request→paid
  converts 1-for-1 when sent (n=1/30d — the starvation number).
- Lifetime: 22 closes, ~all operator-led or deposit-first. The
  rancher-first intro path produced ~0 unassisted closes.

**Diagnosis: the machine is functional and starved, and the email program
pressures a majority who cannot buy what it sells. Nothing converts a list
that's being sold the wrong product.**

## 2 · PRINCIPLES (every future send/page obeys these)

1. **Market what they can actually buy.** State determines the offer.
   Share pressure only where an Active rancher serves. Everyone else gets
   products that ship + honest "first in line when [state] opens."
2. **Pressure is earned by intent, never by time-on-list.** Quiz
   completed / deposit link opened / product carted = 3-touch sprint over
   7 days. 30 days cold = digest-only. No exceptions, no zombie chases.
3. **Deposit-first.** Money before rancher. The rancher's job is accept +
   fulfill. Every intro that CAN carry a deposit link carries it and
   stamps `Deposit Invite Sent At` (#570 — all 8 senders).
4. **Operation-type clarity (Ben, 2026-08-08).** Every product block,
   digest section, and ranch surface labels the operation: "ships frozen,
   nationwide" vs "local share — serves [state]". The buyer never
   guesses which kind of outfit they're buying from, because we represent
   both kinds.
5. **Honest inventory only.** Digest skips thin months. Scarcity only
   from real counts. No manufactured urgency — the brand doc's rules are
   load-bearing, not decorative.
6. **Every send writes truth.** Stamp-before-send with verify-persist
   abort where money is at stake (the #240/#568 pattern). If it can't be
   measured, it doesn't ship.

## 3 · LANE ARCHITECTURE

Lane assignment is computed, not hand-set, and recomputes as supply
changes (a rancher flipping Active migrates their state's Lane 2 into
Lane 1 and fires the existing `state_coverage_opened` letter).

| Lane | Who | Gets | Never gets |
|---|---|---|---|
| **1 · SHARE-READY** (~1,003) | State served by an Active rancher | Full lifecycle: quiz → deposit-first reveal → intent-triggered sprints → operator close-queue overflow | Blast pressure without an intent signal |
| **2 · NATIONAL** (~1,741) | No Active rancher in state | Ranch Stand Digest, ships-nationwide product marketing, state-waitlist honesty, ladder-up cron after first purchase | Share nurture, routing, "your rancher will call" |
| **3 · CUSTOMERS** | Anyone with a paid order/deposit | Replenishment, digest, review capture, ladder-up | Re-acquisition nudges for things they already did |

## 4 · TEARDOWN LEDGER — cut bad ties, with a safety catch

**Rule: nothing dies on suspicion.** This codebase's "dead-looking"
things keep turning out live (bulkRoute, Threads, email-sequences — all
previously misdiagnosed). Each candidate below gets a 2-step check in its
phase: (a) Cron Runs + Email Sends evidence of what it actually did in
the last 30d, (b) code-path read for live callers. Then: KILL / RESCOPE /
KEEP, recorded here.

| Candidate | Suspicion | Likely verdict |
|---|---|---|
| `sendIncompleteProfileAsk` (179/wk) | Chasing profile fields from people who can't buy | RESCOPE to Lane 1 |
| `sendWaitingActivationNudge` (148/wk) | Activating WAITING buyers in states with no supply | RESCOPE to Lane 1 + state gate |
| `sendReadyChaseNudge` to >30d-cold | Zombie chases | RESCOPE to intent window |
| `still_looking_reconfirm` to Lane 2 | Reconfirming interest in unavailable product | RESCOPE to Lane 1 |
| Abandoned-quiz nudges beyond stage 3 for Lane 2 | Quiz leads to a share they can't buy | RESCOPE: point Lane 2 re-entry at /shop |
| 63 dead admin gauges | Known-dead per 07-19 audit | KILL in cleanup phase |
| Dead env flags (Threads flag, etc.) | Flag dead, feature live — verify per flag | Per-item |
| Per-template caps sized for old volume | 67 cap-exceeded/48h | RETUNE with lane policy |

## 5 · BUILD PHASES (one PR each, in order)

- **P0 — SHIPPED 2026-08-08:** `Deposit Invite Sent At` stamped by all 8
  intro senders (#570). Invite-abandon rail now sees every deposit link.
- **P1 — Lane engine.** `lib/lanes.ts`: pure `laneFor(consumer,
  servedStates)` + served-states helper reading Active ranchers. Nightly
  cron stamps `Marketing Lane` on Consumers + fires
  `state_coverage_opened` migration on lane change. TDD on the pure fn.
- **P2 — Selector rescope.** Every nurture/nudge cron selector gains the
  lane gate per the teardown ledger verdicts (each verified per the
  2-step check first). This is the single biggest spam-kill.
- **P3 — Ranch Stand Digest.** Monthly cron; selector = new sellable
  products since last digest; skip-if-thin (<3); per-state layout (local
  stand → nationwide ships) with operation-type labels; own cap lane;
  `Digest Last Sent At` stamps; latest-close social proof from stats.
- **P4 — Operation-type labels.** Surface `ships nationwide` / `local
  share — [state]` on shop cards, PDPs, digest blocks, and intro/receipt
  emails from one shared helper. (Principle 4 made code.)
- **P5 — Intent-sprint windows.** Encode pressure policy: intent event
  opens a 7d/3-touch window (existing nudge rails re-pointed at window
  state instead of ad-hoc criteria); cold = digest-only.
- **P6 — Per-lane scoreboard.** /admin/today block: lane sizes, sends by
  lane, deposit invites → opens → paid, digest CTR → shop revenue,
  weekly close count. The needle Ben watches.
- **P7 — Teardown execution + cleanup.** Ledger verdicts applied; dead
  gauges deleted; caps retuned; this doc updated with what died.

## 6 · BEN-SIDE DEPENDENCIES (the machine can't do these)

1. **Finish Gila River Cattle's record** — AZ's 139 buyers are one
   record away from addressable (largest single unlock in the base).
2. **Lazy Bar 3 + JC's price calls** — unlocks TX's 333.
3. **Fire the staged 300-campaign** (fresh dry-run first — standing).
4. **Meta env vars + budget** — ads into /shop, not /access.
5. **Content cadence + food photography** — no code substitute exists.

## 7 · WHAT "WORKED" MEANS

Weekly, from the P6 scoreboard: deposit invites sent, invite→paid %,
digest CTR and attributed shop revenue, Lane 2 first-purchases, closes.
Success = consistent weekly closes from BOTH lanes within 30 days of
P1-P5 landing + campaign fire. If a phase doesn't move its metric in two
weeks, it gets the same teardown treatment as everything else.
