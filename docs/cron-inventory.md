# Cron Inventory

Generated 2026-05-18. Source: `app/api/cron/*` + `vercel.json`.

18 cron route files. 15 scheduled in `vercel.json`. 3 UNSCHEDULED: `buyer-pulse`, `close-detector`, `daily-audit`.

All times below are UTC unless noted. MT = America/Denver. Active months 2026-04 to 2026-05; UTC-MT offset = 6h (MDT).

---

## batch-approve

| Field | Value |
|---|---|
| Purpose | Auto-approve pending consumers, self-heal rancher capacity counters, kick off matching for Beef Buyers. |
| Schedule | `0 */2 * * *` — every 2h on the hour UTC. |
| Reads | Airtable: RANCHERS, REFERRALS, CONSUMERS. |
| Writes | Airtable: rancher `Current Active Referrals` reconciled; consumers approved; new REFERRALS rows via matching. Sends emails (approval, waitlist, backfill, rancher go-live). |
| Telegram output | `sendTelegramUpdate` / `sendTelegramMessage` to admin chat — batch summary + rancher go-live alerts. |
| Known issues | Capacity-counter drift is treated symptomatically every 2h; root cause (missed decrements) still unfixed. Runs 12x/day — heaviest cron in the rotation. `maxDuration=120`. |

## buyer-pulse

| Field | Value |
|---|---|
| Purpose | Email buyers 5+ days post-intro a 3-button pulse (yes/no/stalled) to detect rancher ghosting from the buyer side. |
| Schedule | UNSCHEDULED — no `vercel.json` entry. |
| Reads | Airtable: REFERRALS (Intro Sent), RANCHERS. |
| Writes | Airtable: REFERRALS `Buyer Pulse Sent At`. Sends pulse email via `sendEmail`. |
| Telegram output | `sendTelegramMessage` to admin on each send. |
| Known issues | Not in vercel.json — dead code unless triggered manually. `MAX_PULSES_PER_RUN=25`. Idempotent via `Buyer Pulse Sent At`. |

## close-detector

| Field | Value |
|---|---|
| Purpose | Post Telegram one-tap card asking Ben "did this close?" for referrals stuck 7+ days. Unlocks Closed Won visibility. |
| Schedule | UNSCHEDULED — no `vercel.json` entry. |
| Reads | Airtable: REFERRALS (active statuses), RANCHERS. |
| Writes | Read-only (Telegram callback handlers do the writes). Field `Close Check Sent At` needs creation in Airtable. |
| Telegram output | `sendTelegramMessage` to admin — one card per stale referral, max 15/run. |
| Known issues | Not in vercel.json. Header comment says callback handlers `clcheck_won_*` etc. need wiring in `webhooks/telegram/route.ts` — verify done. |

## commission-invoices

| Field | Value |
|---|---|
| Purpose | Monthly: send commission invoices to ranchers with unpaid Closed Won referrals. |
| Schedule | `0 16 1 * *` — 1st of month 16:00 UTC (10am MT). |
| Reads | Airtable: REFERRALS (Closed Won, unpaid), RANCHERS. |
| Writes | Sends invoice email via `sendMonthlyCommissionInvoice`. No direct Airtable writes in top section (invoice marking may happen later in handler). |
| Telegram output | `sendTelegramUpdate` to admin with run summary. |
| Known issues | None visible in top 80 lines. |

## compliance-reminders

| Field | Value |
|---|---|
| Purpose | Monthly reminder to active+signed ranchers to report any off-platform sales. |
| Schedule | `0 9 1 * *` — 1st of month 09:00 UTC (3am MT — odd hour). |
| Reads | Airtable: RANCHERS. |
| Writes | Sends email to each active rancher with `Agreement Signed=true`. |
| Telegram output | None visible in top 80 lines (likely summary further down). |
| Known issues | 09:00 UTC = 3am MT — bad delivery window; consider moving to MT business hours. Auth path has explicit comment about historical bypass bug now fixed. |

## daily-audit

| Field | Value |
|---|---|
| Purpose | AI-powered morning sweep — Claude tool-use against full BHC state. Prioritized issue list. |
| Schedule | UNSCHEDULED — no `vercel.json` entry. |
| Reads | Airtable: read-only via AI tools (`get_stalled_referrals`, `get_pending_consumers`, etc.). |
| Writes | None (read-only by design). All AI tool calls log to AI_AUDIT_LOG. |
| Telegram output | `sendTelegramMessage` to admin — under 2500 chars, three sections (NEEDS YOU NOW / WORTH A LOOK / HEALTHY). |
| Known issues | Not in vercel.json — fully orphaned. Header says runs 8am MT (14:00 UTC) but nothing schedules it. `maxDuration=120`. |

## daily-digest

| Field | Value |
|---|---|
| Purpose | Morning summary: 24h signups, intros, monthly wins, capacity warnings, stalled referrals. |
| Schedule | `0 14 * * *` — 14:00 UTC (8am MT). |
| Reads | Airtable: CONSUMERS, RANCHERS, REFERRALS. |
| Writes | None — pure read + Telegram emit. AI synthesizes opening blurb via `callClaude`. |
| Telegram output | `sendTelegramMessage` / `sendTelegramUpdate` — HTML-formatted multi-section digest. |
| Known issues | **CONFLICT**: same minute (14:00 UTC) as `rancher-trust-promotion`. Three reads of full tables — costly on Airtable rate limits if it overlaps. |

## email-sequences

| Field | Value |
|---|---|
| Purpose | Daily drip emails to approved consumers + abandoned-application 3-email recovery sequence. |
| Schedule | `0 16 * * *` — 16:00 UTC (10am MT). |
| Reads | Airtable: CONSUMERS (filtered by Source/Status). |
| Writes | Airtable: CONSUMERS `Sequence Stage` advances. Sends 7+ email types (abandoned recovery, founder waiting, match check-in, cuts edu, monthly letter, repeat-purchase ask). |
| Telegram output | `sendTelegramUpdate` for run summary. |
| Known issues | **CONFLICT**: same minute (16:00 UTC) as `onboarding-stuck`. Header comment says was timing out at 60s, bumped to 180s. 1200+ consumer iterations per run. |

## healthcheck

| Field | Value |
|---|---|
| Purpose | Pre-business-cron sanity check — hit `/api/health`, Telegram pass/fail. |
| Schedule | `0 13 * * *` — 13:00 UTC (7am MT, BEFORE other crons). |
| Reads | Internal `/api/health` (which probes Airtable, Resend, Telegram, AI). |
| Writes | None. |
| Telegram output | `sendTelegramMessage` — green "All Systems Go" with per-service ms, OR red "SYSTEM DOWN/DEGRADED" with failure details. |
| Known issues | None — clean and minimal. `maxDuration=30`. |

## nightly-rancher-audit

| Field | Value |
|---|---|
| Purpose | Per-rancher pipeline summary + 10 system-wide bug checks (capacity drift, tier mismatches, stalled referrals, etc.). |
| Schedule | `0 5 * * *` — 05:00 UTC (11pm MT prior day). |
| Reads | Airtable: RANCHERS, REFERRALS, CONSUMERS (all three full tables). |
| Writes | Read-only audit; surfaces issues only. |
| Telegram output | `sendTelegramMessage` — digest of per-rancher pipeline + system issues. |
| Known issues | Reads three full tables. `maxDuration=180`. Audit-only; doesn't fix anything it finds — overlaps philosophically with `daily-audit`. |

## onboarding-stuck

| Field | Value |
|---|---|
| Purpose | Nudge ranchers stuck mid-onboarding (Call Complete / Docs Sent / signed-but-not-live) at day 3/7/14. |
| Schedule | `0 16 * * *` — 16:00 UTC (10am MT). |
| Reads | Airtable: RANCHERS. |
| Writes | Airtable: RANCHERS `Last Onboarding Nudge At`. Sends nudge email with setup-link JWT. |
| Telegram output | `sendTelegramMessage` — admin ping after day-14 final nudge for manual outreach. |
| Known issues | **CONFLICT**: same minute (16:00 UTC) as `email-sequences`. Both walk RANCHERS / CONSUMERS — Airtable 5 req/sec/base limit could trip. |

## rancher-followup

| Field | Value |
|---|---|
| Purpose | Weekly Monday alert for ranchers stalled at each onboarding stage with action buttons. |
| Schedule | `0 15 * * 1` — Mondays 15:00 UTC (9am MT). |
| Reads | Airtable: RANCHERS. |
| Writes | Sends `sendRancherLeadNudge` email. |
| Telegram output | `sendTelegramMessage` — stage-by-stage stalled-rancher digest with action buttons. |
| Known issues | Stage thresholds hardcoded in route file — drift risk vs. `onboarding-stuck`. Two overlapping nudge crons (this + onboarding-stuck). |

## rancher-launch-warmup

| Field | Value |
|---|---|
| Purpose | Send buyer-warmup emails to consumers in a rancher's state. Two paths: Trust Mode → drain; non-Trust → throttled batch. Day-7 nudge phase too. |
| Schedule | `30 13 * * *` — 13:30 UTC (7:30am MT). |
| Reads | Airtable: RANCHERS, CONSUMERS, REFERRALS (full-table scans likely below line 80). |
| Writes | Airtable: CONSUMERS `Warmup Engaged At`/stage. RANCHERS `Warmup Last Batch At`. Sends `sendRancherLaunchWarmup` + `sendRancherLaunchWarmupNudge` emails. |
| Telegram output | `sendTelegramUpdate` for batch summary. |
| Known issues | Hardcoded caps `WARMUP_CAP_PER_RUN=100`, `NUDGE_CAP_PER_RUN=50` — sender-reputation guardrail. Complex priority scoring. |

## rancher-onboarding-drip

| Field | Value |
|---|---|
| Purpose | Day 2 / Day 5 / Day 14 nudges for self-submitted ranchers from `/map/add-a-rancher`. |
| Schedule | `30 17 * * *` — 17:30 UTC (11:30am MT). |
| Reads | Airtable: RANCHERS (all, filtered in code). |
| Writes | Airtable: RANCHERS `Self-Submit Drip Stage`. Sends three day-bucketed onboarding emails. |
| Telegram output | `sendTelegramMessage` — admin summary of sent + stopped. |
| Known issues | Filters in JS not formula — fine while ranchers table is small; will get slow at scale. |

## rancher-trust-promotion

| Field | Value |
|---|---|
| Purpose | Flip Trust Mode = TRUE on ranchers who hit 5 Closed Won OR whose Onboarding Phase Until expired. Removes warmup throttle + first-week gate. |
| Schedule | `0 14 * * *` — 14:00 UTC (8am MT). |
| Reads | Airtable: RANCHERS, REFERRALS (Closed Won). |
| Writes | Airtable: RANCHERS `Trust Mode=true`. |
| Telegram output | `sendTelegramMessage` per promotion + run summary. |
| Known issues | **CONFLICT**: same minute (14:00 UTC) as `daily-digest`. Both pull full RANCHERS+REFERRALS — guaranteed Airtable rate-limit pressure. |

## referral-chasup

| Field | Value |
|---|---|
| Purpose | AI-driven re-engagement emails (max 3/referral) to buyers on stale Intro Sent / Rancher Contacted referrals; auto-close very-stale ones. |
| Schedule | `0 17 * * *` — 17:00 UTC (11am MT). |
| Reads | Airtable: REFERRALS (active), CONSUMERS (for unsubscribe set). |
| Writes | Airtable: REFERRALS `Chase Count`/`Last Chased At`, status flips for auto-close. Sends `sendRepeatPurchaseEmail`/`sendRancherLeadReminder` etc. |
| Telegram output | `sendTelegramMessage` / `sendTelegramUpdate`. |
| Known issues | Hard-bails if neither OLLAMA nor Anthropic key set. Recency check uses multiple newer activity fields — must stay in sync with pipeline code. |

## send-scheduled

| Field | Value |
|---|---|
| Purpose | Drain `Campaigns` table where Status=scheduled. Bulk send broadcast emails to filtered audience (consumers/ranchers/state-targeted). |
| Schedule | `0 * * * *` — every hour on the hour. |
| Reads | Airtable: CAMPAIGNS, CONSUMERS / RANCHERS depending on audience. |
| Writes | Airtable: CAMPAIGNS status updates. Sends `sendBroadcastEmail` in batches of 10 (1s delay). |
| Telegram output | `sendTelegramUpdate` per campaign send. |
| Known issues | Hourly — only cron that runs every hour. Honors Unsubscribed/Bounced/Complained filter — CAN-SPAM compliance critical. |

## stuck-buyer-recovery

| Field | Value |
|---|---|
| Purpose | Retry matching for buyers stuck at Buyer Stage=READY + Ready to Buy=true with no active referral. |
| Schedule | `30 14 * * *` — 14:30 UTC (8:30am MT). |
| Reads | Airtable: CONSUMERS, REFERRALS. |
| Writes | Calls `/api/matching/suggest` with `warmupEngaged=true` — that endpoint writes REFERRALS + flips buyer stage. |
| Telegram output | `sendTelegramMessage` — digest of retried + outcomes. |
| Known issues | Has explicit `BUG-FIX 2026-05-09` comment about Pending Approval orphan handling — fragile area. Cascade calls `/api/matching/suggest`, so downstream errors propagate here. |

---

## Schedule Conflicts (same minute UTC)

| Minute (UTC) | Crons | Risk |
|---|---|---|
| **14:00** | `daily-digest`, `rancher-trust-promotion` | Both read full RANCHERS+REFERRALS — Airtable rate-limit pressure. |
| **16:00** | `email-sequences`, `onboarding-stuck` | Both walk CONSUMERS / RANCHERS — email-sequences also bumped to 180s because of past timeouts. |

Other 13 schedules sit on unique minutes.

## Unscheduled cron files

These have route files but no `vercel.json` entry — they run only on manual trigger:

- `buyer-pulse`
- `close-detector`
- `daily-audit`

## Files-vs-schedule reconciliation

- Files NOT in vercel.json: `buyer-pulse`, `close-detector`, `daily-audit`
- Schedule entries with NO file: none
