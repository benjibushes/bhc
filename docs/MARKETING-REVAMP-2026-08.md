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

## 5 · BUILD PHASES — v2, panel-amended (one PR each; tracks may run in
parallel ONLY where file sets are disjoint; within a track, sequential)

- **P0 — SHIPPED 2026-08-08:** `Deposit Invite Sent At` stamped by all 8
  intro senders (#570).

**Track 1 — lanes + pressure (sequential):**
- **P1′ — Lane projection, NOT a new engine.** The lane engine already
  exists: `app/api/cron/reclassify-buyers` + `lib/routingSegment.ts`
  (nightly, delta-writes, stored `Routing Segment`). Lane = 3-way
  projection of the existing segments. Work: fix the
  INCOMPLETE_PROFILE-before-state ordering bug (routingSegment.ts ~:100 —
  this alone kills the 179/wk profile-asks to stranded buyers); extract
  ONE shared `servedStates()` helper (capacity-OUT definition — at-capacity
  ranchers still count as coverage, so states never lane-flap when one
  rancher fills; defend the `Max Active Referalls` single-L field);
  widen `state-coverage-notify/selection.ts` beyond `relaunch_waitlist`
  to lane-2→1 flips, KEEPING its Redis+Notes once-ever guards. NO new
  field, NO new cron, NO new sender.
- **P2′ — Gate the actually-ungated.** Panel finding: 3 of 5 suspected
  senders are already supply-gated. Real targets: `nurture-drip` (no
  Ranchers fetch at all — the ~220/wk), `matching/suggest`'s
  still-looking branch (request path — gate around operatorOverride
  carefully), and migrate the 5 copy-paste served-states loops onto the
  P1′ helper. Delete dead `hasRancherAvailable` (email-sequences:237).
- **P5′ — Tiered intent windows + sunset.** Quiz-complete = 7d/3-touch.
  Deposit-link-opened / product-carted = 14d/4-5-touch + decay week
  (median quiz→close is 2-21d; ~90% of considered conversions land by
  day 12 — the old flat 7d closed before our own median buyer decides).
  Sunset: 6 clickless digests OR 180d zero engagement (clicks + site
  activity, not opens — MPP) → ONE re-permission email → suppress.
  12mo+ never-engaged: suppress without contact. Lane 3 gets a longer
  leash (purchase = engagement).

**Track 2 — email stream infra (sequential; parallel-safe vs Track 1):**
- **P2.5 — SHIPPED 2026-08-08 (#575).** Stream-keyed sending live:
  round-robin dead, every send resolves transactional|marketing from its
  guardedSend template name (lib/emailStreams.ts — 44 marketing / 62
  transactional / unknown fails safe to transactional), both streams on
  apex until Ben sets `MARKETING_SEND_DOMAIN` (ENV-REGISTRY + env.example);
  List-Unsubscribe/one-click forced on ALL marketing sends in the central
  wrapper (existing JWT builder reused); complaint telemetry counts the
  webhook's dated Notes stamps and alarms loud at 3+/7d (deduped 24h).
  Original spec: Kill the `SEND_DOMAINS` round-robin
  (lib/email.ts:462-469) — replace with per-stream domain selection:
  transactional stays on the apex; ALL marketing lanes ride the
  marketing subdomain once Ben verifies it in Resend (until then, both
  streams map to apex — the mapping ships first, the DNS flip is
  config). Centralize List-Unsubscribe/one-click headers into the send
  wrapper (per-caller opt-in today = a future sender can silently drop
  them); explicit transactional bypass. Complaint telemetry: count
  `email.complained`/wk, alert at 3+ (the kill line at this list size is
  ~5/wk).
- **P4 — Operation-type labels.** Shared helper renders "ships frozen,
  nationwide" vs "local share — serves [state]" on shop cards, PDPs,
  digest blocks, intro/receipt emails. Panel: no existing competitor,
  low risk.

**Convergence (after P1′ + P2.5):**
- **P3′ — Ranch Stand Digest.** DAILY cron + date-1 guard registered in
  EXPECTED_CRONS_24H (Vercel has silently dropped monthly slots on this
  project; the watchdog test forces classification). First send
  engagement-tiered over 3-4 days, most-engaged first — never one
  2,744-send day. Re-permission gate: 180d+ never-engaged get ONE
  re-permission email instead of the digest; 12mo+ suppressed. v1 layout
  = exactly two blocks (ships-nationwide + your-state-if-any) — the
  per-state stall layout was YAGNI. skip-if-thin applies ONLY to the
  product section; a restock/ranch-story fallback guarantees Lane 2 is
  never silent a full month (cadence consistency is itself a
  deliverability input). Own cap lane; `Digest Last Sent At` stamps.
- **P6′ — Scoreboard.** Lane sizes seeded free from reclassify-buyers'
  Cron Runs notes; sends by lane; deposit invites → opens → paid; digest
  clicks (weekly manual revenue count — attribution plumbing at tens of
  clicks/month measures noise, cut as YAGNI); complaint rate/wk with the
  3+ alert; weekly closes. Evaluation gates are EVENT-COUNT based
  ("evaluate after 200 digest deliveries / 20 sprint entries"), never
  fixed 2-week windows — at current volume a fortnight can't tell a
  working phase from a dead one.
- **P7 — Teardown execution** per ledger verdicts (verify-then-kill),
  dead gauges deleted, caps retuned to lane policy.

**Wave 2 (after Wave 1 ships + first campaign fires — the revenue flows
the panel ranked highest for Lane 2, needing event instrumentation):**
- **W2a — Triggered product flows:** browse-abandon, back-in-stock,
  price-drop (highest revenue-per-send flow class in 2025-26 benchmarks;
  back-in-stock = honest scarcity by construction).
- **W2b — Ladder bridge rung:** product buyer → large-box rung →
  "graduate to a share" deposit, triggered within days of delivery while
  warm (a $14→$3,000 jump violates every price-delta heuristic).
- **W2c — SMS deposit nudge** on opened-unpaid links (asset half-built;
  blocked on TCPA opt-in capture — Ben dependency).

## 6 · BEN-SIDE DEPENDENCIES (the machine can't do these)

1. **Finish Gila River Cattle's record** — AZ's 139 buyers are one
   record away from addressable (largest single unlock in the base).
2. **Lazy Bar 3 + JC's price calls** — unlocks TX's 333.
3. **Fire the staged 300-campaign** (fresh dry-run first — standing).
4. **Meta env vars + budget** — ads into /shop, not /access.
5. **Content cadence + food photography** — no code substitute exists.
6. **Marketing subdomain in Resend** — add + verify DKIM for
   `updates.buyhalfcow.com` (DMARC is `sp=quarantine`: an unverified
   subdomain send quarantines day one). Then 3-6 weeks warmup riding all
   marketing lanes before any volume increase.
7. **Flip `STATE_COVERAGE_NOTIFY_ENABLED`** — the state-opened letter
   rail is built, guarded, and DARK by default.
8. **TCPA SMS opt-in capture** — unblocks W2c.

## 7 · WHAT "WORKED" MEANS

Weekly, from the P6 scoreboard: deposit invites sent, invite→paid %,
digest CTR and attributed shop revenue, Lane 2 first-purchases, closes.
Success = consistent weekly closes from BOTH lanes within 30 days of
P1-P5 landing + campaign fire. If a phase doesn't move its metric in two
weeks, it gets the same teardown treatment as everything else.

## 8 · VALIDATION RECORD (2026-08-08 panel — 3 independent lenses)

Growth, deliverability, and engineering-risk agents each researched
current best practice and attempted to break the v1 plan. 24 verdicts
folded into v2 above. Highlights: state-supply axis CONFIRMED (RFM
impossible at 22 closes); flat 7d sprint REJECTED against our own 2-21d
close median; "full consented list" digest REJECTED as a complaint-spike
risk (re-permission + tiered rollout instead); v1's P1 lane engine
REJECTED as a duplicate of the live `reclassify-buyers`/`Routing
Segment` machine; sunset policy ADDED (both marketing lenses converged
on it independently); SEND_DOMAINS rotation flagged as a
reputation-cross-contamination footgun and scheduled for death in P2.5.
Full agent reports in the session transcript, 2026-08-08.
