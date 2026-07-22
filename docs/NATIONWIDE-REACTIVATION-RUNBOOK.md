# NATIONWIDE REACTIVATION RUNBOOK — requalify + route the WAITING pool

*Written 2026-07-22, alongside the 42-finding reactivation audit + fix wave.
This is the launch-day sequence for waking ~2,000 WAITING buyers as nationwide
rancher supply comes online. Every step is ordered — do not skip ahead.*

**The one rule: supply first, demand second.** Never activate a state's buyers
until that state has at least one PAYABLE rancher (Active + rail live — check
`/admin` or run the payable count). The activation cron enforces this per-run
(live supply gate), but the campaign plan should respect it too.

---

## Phase 0 — pre-flight (do once, before any flip)

1. **Fix wave merged + deployed.** Confirm prod `/api/version` sha matches main
   and `docs/HANDOFF-*.md` says the reactivation fix wave (42 findings) shipped.
2. **Airtable fields that must exist** (updateRecord silently strips unknown
   fields — the crons abort loudly if the stamp fields are missing, but check):
   - Consumers: `Waiting Nudge Last Sent At` (dateTime), `Waiting Nudge Count`
     (number), `Campaign Stage`, `Campaign Last Sent At`, `Campaign Waitlist State`.
3. **Run the dry-run and READ it.** With `WAITING_ACTIVATION_ENABLED=dry-run`,
   the daily run Telegrams: pool size, would-nudge count, per-state breakdown,
   and (post-fix) a **stamp-schema probe result** — `stamp schema OK` must
   appear. `MISSING` = create the fields before going live.
4. **Resend + suppression health:** email-canary green the last 3 days; Resend
   dashboard shows no elevated bounce rate; the 3 suppression rails (bounce /
   unsub / complaint) spot-checked on a known-bounced address.
5. **Capacity truth:** run capacity-drift-check once manually and confirm zero
   drift rows before the blast (Redis counters == referral truth).

## Phase 1 — supply switch-on (per state, Ben's calls)

For each newly-signed rancher: flip `Active Status=Active` + `Migration
Status=completed` **together** (auto-pause bites otherwise), assign the rail
(tier_v2 Connect active OR legacy payment link), then confirm the go-live
payment-path smoke passed (the go-live doors run it automatically now — a 409
means fix the listed gate, `?force=true` only with eyes open).

Keep a running list of LIVE states. That list drives Phase 2 pacing.

## Phase 2 — waiting-activation goes live (the tap, not the flood)

1. First live day, run small: set `WAITING_NUDGE_MAX_PER_RUN=15` (env knob —
   post-fix it honors any value including 0) and flip
   `WAITING_ACTIVATION_ENABLED=true`.
2. The cron (16:20 UTC post-fix — SMS window open in all four US zones) will:
   select oldest-first WAITING buyers **only in states with live supply**,
   3-touch lifetime cap, 14-day cooldown, claim-before-send, email via the
   whitelisted template + optional SMS. Failed sends now count as errors (red
   Telegram), not silent suppressions.
3. Watch the daily Telegram report for 3 days: sent vs suppressed vs failed,
   and the funnel: nudged → re-entered funnel → qualified → routed. Then raise
   the cap 15 → 35 → 50.
4. Buyers with prior funnel progress get a **real resume link**
   (`/qualify/<id>?token=`); fresh-quiz buyers get `/access?state=` prefill.
   Legacy timing answers ("1-3 months") now map to current vocab — nobody gets
   auto-held for speaking 2026-February.

## Phase 3 — campaign router nationwide (the megaphone)

Only after Phase 2 is stable:
1. Set `DEMAND_CAMPAIGN_RANCHER_IDS` to the full payable-rancher id list
   (post-fix: N ranchers, state→eligible-rancher index, Routing-States-gated —
   a buyer can no longer be pooled to a rancher that doesn't serve them).
2. Leave `CAMPAIGN_LIVE` unset for one full day — read the dry-run plan
   Telegram (pool sizes per rancher, open slots, would-send counts).
3. Flip `CAMPAIGN_LIVE=true`. Daily cap is now a true per-DAY cap. The two
   rails cross-suppress (a buyer in the campaign arc won't also get a
   waiting-nudge the same week).
4. Reserve links: `/r/<token>` (30d, durable). Reserve-time capacity check
   post-fix — concurrent 1-taps can't oversell a rancher's slots.

## Phase 4 — watch these, daily

- **Telegram:** waiting-activation report (sent/failed/suppressed), campaign
  report, capacity-drift, deploy-drift, email-canary, morning pulse.
- **Failure smells:** `failed:` count > 0 two days running = Resend problem —
  stop raising caps. `capacity_race` fallthroughs spiking = a hot state needs
  more supply, good problem. Waitlisted counts growing in a state = recruit
  there (demand heatmap).
- **Abort switch:** set `WAITING_ACTIVATION_ENABLED=dry-run` and unset
  `CAMPAIGN_LIVE`. Both rails go dark instantly; no state is lost (stamps are
  the state, and they live in Airtable).

## The conversion path after the nudge (all automated, verified this wave)

nudge → click → (resume or fresh) quiz → qualified → routed (Closed-Won-gated
capacity, next-candidate fallback) → intro → no-action nudge (per-referral,
capped, paced) → reserve → deposit (durable link, watchdogged, dunned) →
final invoice (durable, self-healing, alarmed) → settled → review/replenish.

Buyers who stall at any step now have a chase rail — including the two that
never existed before this wave: READY-never-matched (waiting-activation stage
2) and reserve-abandons outside the campaign.
