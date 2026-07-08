# BuyHalfCow — Operating Manual

*Written 2026-07-08, the day everything went live. This is the one document
that says what the business is, how the machine runs itself, what Ben reads,
and what Ben does. If you only keep one doc open, keep this one.*

---

## 1. The business model, one page

**BHC aggregates demand for real ranch beef and routes it to verified
ranchers until their capacity is sold out.** Ranchers get customers without
becoming marketers; buyers get the ranch nearest them without cold-calling
ranches. BHC takes ~10% on closed share deals (application fee on the
deposit + settlement rail) and margin on the product marketplace.

Three revenue ladders, one funnel:

| Ladder | Ticket | Rail | State |
|---|---|---|---|
| Shares (whole/half/quarter) | $1,000–$2,500 | quiz → qualify → route → deposit → settle | LIVE (needs supply) |
| Products (jerky/boxes/ground) | $13–$355 | /shop → brand checkout (Payment Element) | LIVE |
| Rancher SaaS (Operator tier) | $500/mo | sell page → call → onboard | LIVE (sell it on calls) |

The flywheel: content (40k followers) → /shop + /access → buyers waitlisted
by state → rancher calls convert supply → routing activates waitlist →
closes fund more supply calls.

**The single constraint is supply.** 1,981 waitlisted buyers (TX 253, CA 202,
CO 86). Demand is proven; every activated rancher unlocks their state's
backlog. Everything else in this document exists so that supply calls are
the only thing requiring Ben's hours.

## 2. The machine — what now runs itself

Five closed loops, all live as of today:

1. **Demand capture** — /access quiz qualifies (quiz-required rule: funnel +
   quiz, never Intent Score alone) → WAITING/READY by state.
2. **Routing** — batch-approve 09:00 UTC routes qualified buyers to
   operational ranchers (food-miles adjacency, ≤2 hops; capacity =
   held-referral truth). stuck-buyer-recovery 14:30 retries READY buyers.
   waiting-activation (dry-run, see §4) activates waitlist where capacity
   appears.
3. **Slot hygiene** — stale-hold expiry 13:10 (21d-silent intros → Dormant →
   buyer back to READY → counters resynced → recovery re-routes same day).
   Drift-check every 6h. Reaper crons chase orphaned checkouts, frozen
   deposits, unpaid finals.
4. **Money** — deposit (embedded, on-domain) → rancher accepts → final
   invoice → settle (rancher paid, commission held out). Products: brand
   Payment Element → direct charge → rancher paid minus fee + shipping
   passthrough. Commission invoices for legacy closes: 1st of month.
5. **Retention/expansion** — replenishment (cut-aware reorder asks),
   review asks post-delivery, product-recovery (abandoned checkout),
   orphan rewarm, rancher reactivation. All flipped live today.

Watchdogs: cron registry screams on any expected cron missing 24h (loud
Telegram, falls back SMS/email). Monday scorecard cron. Nightly rancher
audit digest. Kill switch: `MATCHING_ENABLED=false` halts routing instantly;
`MAINTENANCE_MODE=true` pauses the platform.

## 3. Switch states (as of 2026-07-08)

**Flipped TRUE today:** stale-hold expiry · log retention · product
recovery · review asks · stock check-ins · replenishment · orphan rewarm ·
rancher reactivation · admin Connect tools (`STRIPE_CONNECT_ENABLED`).
Payment Element was already live.

**Armed at dry-run:** `WAITING_ACTIVATION_ENABLED` — it emails the
1,981-buyer waitlist surface and has never produced a report. It runs and
reports to Telegram daily from tomorrow; after the first sane report, flip
to `true` (or tell Claude "flip waiting activation"). This is deliberate:
one day of evidence before the largest send surface goes hot.

**Deliberately OFF (not forgotten):**
- `EMAIL_SEQUENCES_ENABLED` — old nurture engine is dead; nurture is a
  scoped REBUILD (backlog #111, say "turn nurture on").
- `NATIONWIDE_ROUTING_ENABLED` — strategy lock: local-first until supply.
- `CAMPAIGN_LIVE` / `CAMPAIGN_ROUTER_ENABLED` — drop-day levers.
- `CAPACITY_LIBERATOR_ENABLED` — overlaps stale-hold expiry (would
  double-act on the same rows with a different terminal state). Stays
  report-only unless expiry proves insufficient.

**Blocked on Ben (values only Ben has):**
- Meta pixel ID + CAPI token (3 envs) → flip after the test buy.
- `RESEND_INBOUND_WEBHOOK_SECRET` → from Resend dashboard.
- Outreach `OUTREACH_FROM` → needs buyhalfcow.co + Google Workspace inbox
  (cold email NEVER rides buyhalfcow.com). Phone is set: (720) 491-7819.
  Engine drafts daily at dry-run; sends stay approval-gated regardless.

## 4. What Ben reads (the 10-minute daily loop)

Telegram, in order:
1. **09:0x batch-approve summary** — approved/matched/waitlist counts. If it
   says "Time-boxed", that's honest truncation, not failure (remainder runs
   tomorrow).
2. **13:1x stale-hold expiry** — slots freed, buyers restored, counters
   resynced. First LIVE run tomorrow.
3. **14:3x recovery** — stuck buyers retried/matched.
4. **15:0x outreach drafts** (prospects dashboard) — approve the good ones.
5. **Loud alerts** (any time) — cron watchdog, money anomalies. These are
   the only messages that demand action; everything else is pulse.

Weekly: Monday scorecard (revenue truth) + nightly-audit digest skim for
relationship flags (stalled intros, ranchers with zero closes in 30d).

## 5. Focus stack (in order, nothing above supply)

1. **Twelve rancher calls** — scripts in docs/RANCHER-CALL-SCRIPTS.md. Lead
   with the $500/mo Operator tier. Every Connect-active rancher in TX/CA/CO
   activates hundreds of waitlisted buyers.
2. **One test buy** ($13.59 product + one self-deposit) — proves the money
   rail end-to-end; unblocks Meta flip. Ping Claude to watch it settle.
3. **Content → /shop and /links** — the 40k following points at the $13
   door, not the $2k quiz. Shop drop when gear photos land.
4. **Ops table stakes** — buyhalfcow.co + outreach inbox; Resend inbound
   secret; Airtable data entry (Ships In Days ×10, product photos).
5. **After first closes** — flip Meta envs, start ads $50/day in the one
   state with ≥3 active ranchers. Not before.

## 6. Decision gates (pre-decided so war-time Ben doesn't re-litigate)

- **Ads on?** Only after: test buy settled + ≥3 Connect-active ranchers in
  one state + Meta envs live.
- **Nationwide routing on?** Only when a state's waitlist outstrips its
  supply *and* a shipping-capable rancher exists (flip is per-rancher in
  /admin/ranchers → Multi-State Routing).
- **Waitlist blast?** Never. waiting-activation activates exactly where
  capacity exists; that's the only sanctioned waitlist touch.
- **Payment plans?** Parked, researched, ready:
  docs/PAYMENT-PLANS-BACKUP-BUILD.md. Say "build payment plans".
- **Nurture?** Say "turn nurture on" — it ships dark, then dry-run, then
  live, same 3-state pattern as everything else.

## 7. Break-glass

| Symptom | Move |
|---|---|
| Routing doing something wrong | `MATCHING_ENABLED=false` (halts in ≤1 run) |
| Platform-wide problem | `MAINTENANCE_MODE=true` |
| A cron misbehaving | its `*_ENABLED` env → `dry-run` (reports, writes nothing) |
| Money looks wrong | /admin/health + ping Claude; never hand-edit counters (drift-check heals them) |
| Prod stale after a merge | Vercel dashboard → Promote latest READY deploy |

Full setup values + step-by-steps: docs/GO-LIVE-SETUP.md. Brand truth:
docs/BHC.md. Call scripts: docs/RANCHER-CALL-SCRIPTS.md.
