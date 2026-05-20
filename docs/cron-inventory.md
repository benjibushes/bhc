# Cron Inventory

Generated 2026-05-19. Source: `app/api/cron/*` + `vercel.json`.

19 cron route files, all scheduled in `vercel.json`. All times UTC unless noted. MT = America/Denver. Active months 2026-04 to 2026-05; UTC-MT offset = 6h (MDT).

## Observability

Every cron is wrapped by `lib/cronRun.ts::withCronRun(name, handler)`. Wrapper:
1. **Pause gate** — short-circuits with `status='paused'` if a row in `Cron Pauses` matches the cron name with `Paused=true` (set by Telegram `/pausecron`).
2. **Run** the handler; catch exceptions → `status='error'`.
3. **Log** to `Cron Runs` table: Name · Started At · Ended At · Duration ms · Status · Records Touched · Notes · (optional) Skip Reason Breakdown JSON.

Inspect last 24h via Telegram `/cronstatus` (`/runs`). Missing cron names from the expected-24h list surface as `🚨 No run in 24h: <names>`.

## Schedule Audit (2026-05-19)

Three known Vercel Hobby-tier limitations identified + worked around:
- **Monthly slots silently dropped.** `compliance-reminders` + `commission-invoices` had 0 runs in 60 days under `0 X 1 * *` schedules. Fix: schedule daily, exit early with `status='success' notes='skipped — not 1st'` unless `today.getUTCDate() === 1`.
- **Day-of-week slots dropped.** `rancher-followup` had 0 runs in 14 days under `0 15 * * 1`. Fix: same pattern — daily schedule, in-handler Monday guard.
- **Groq tool-schema validator rejected integer literal as string** ("/minDays expected number got string") on `daily-audit` 2026-05-19. Fix: added `forceProvider:'anthropic'` param to `callClaudeWithTools`; daily-audit pinned to Anthropic.

---

## batch-approve

| Field | Value |
|---|---|
| Purpose | Auto-approve pending consumers, self-heal rancher capacity counters, kick off matching for Beef Buyers, retry waitlisted with qualification gate. |
| Schedule | `0 9 * * *` — daily 9 UTC (3 AM MT). |
| Reads | RANCHERS, REFERRALS, CONSUMERS. |
| Writes | Rancher `Current Active Referrals` reconciled; consumers approved; new REFERRALS rows via matching; consumer `Warmup Stage=matched` on hit. |
| Telegram output | `sendTelegramUpdate` summary card. Waitlist retry card with `unqualified=N capped=M` breakdown. |
| Cron Runs notes | `approved=N matched=N live=N waitlist=N/N capFix=N errs=N unqualified=N capped=N`. |
| Skip Reason Breakdown | JSON `{reason: count}` of qualification gate failures (e.g. `{"no explicit consent click yet": 33}`). |
| Known issues | Capacity-counter drift fixed symptomatically each run; root cause (missed decrements) unfixed. Was `0 */2 * * *` (every 2h) through 2026-05-19; dropped to daily after audit found 11 of 12 daily runs wasted re-scanning a static stuck cohort. |
| Knobs | `DAILY_INTRO_CAP=25`, `PER_RANCHER_DAILY_CAP=5`, `WARMUP_GRACE_DAYS=3`. |
| `maxDuration` | 120s. |

## buyer-pulse

| Field | Value |
|---|---|
| Purpose | Buyer-side "did rancher reach out?" email with 3-button click flow (Yes/No/Stop). |
| Schedule | `0 18 * * *` — daily 18 UTC. |
| Reads | REFERRALS, CONSUMERS, RANCHERS. |
| Writes | `Buyer Pulse Sent At` + `Buyer Pulse Response` on REFERRALS. |
| Telegram output | Summary card with `sent=N failed=N candidates=N`. |
| Known issues | None as of 2026-05-19. |

## close-detector

| Field | Value |
|---|---|
| Purpose | Posts Telegram 4-button "Did this close?" cards for stale active referrals. |
| Schedule | `0 17 * * *` — daily 17 UTC. |
| Reads | REFERRALS, RANCHERS. |
| Writes | `Close Check Sent At` on REFERRALS. |
| Telegram output | Per-referral interactive card (Won / Lost / Working / Stop Asking). |
| Known issues | None as of 2026-05-19. |

## commission-invoices

| Field | Value |
|---|---|
| Purpose | Monthly Stripe invoice email to ranchers with unpaid commissions. |
| Schedule | `0 16 * * *` — daily 16 UTC; in-handler date-1 guard. Was `0 16 1 * *`; Vercel silently dropped monthly slot (0 runs in 60d). |
| Reads | REFERRALS (unpaid Closed Won), RANCHERS. |
| Writes | `Stripe Invoice URL` + `Stripe Invoice ID` on REFERRALS. |
| Telegram output | Summary. |
| Known issues | Monthly schedule unreliable on Vercel Hobby — daily + date-1 guard workaround. |

## compliance-reminders

| Field | Value |
|---|---|
| Purpose | Monthly sales-report email to active ranchers; auto-flag non-compliant. |
| Schedule | `0 9 * * *` — daily 9 UTC; in-handler date-1 guard. Was `0 9 1 * *`; same Hobby-tier issue as commission-invoices. |
| Reads | RANCHERS. |
| Writes | Marks ranchers as Non-Compliant after missed cycles. |
| Telegram output | Send count summary. |
| Known issues | See commission-invoices. |

## daily-audit

| Field | Value |
|---|---|
| Purpose | Autonomous morning audit via Anthropic tool-use; produces a prioritized issue list for Telegram. |
| Schedule | `45 5 * * *` — daily 5:45 UTC. |
| Reads | All read-only tools registered in `lib/aiTools.ts`. |
| Writes | None directly; surfaces issues for Ben to act on. |
| Telegram output | Telegram card with 🚨 / 🟡 / 🟢 sections. |
| Known issues | Was Groq → failed on tool-schema validation 2026-05-19 ("/minDays expected number got string"). Now pinned to Anthropic via `forceProvider:'anthropic'`. |
| AI provider | Anthropic (`claude-sonnet-4-6`), max 8 iterations. |

## daily-digest

| Field | Value |
|---|---|
| Purpose | Pipeline KPI Telegram brief with AI top-3 priorities. |
| Schedule | `0 14 * * *` — daily 14 UTC. |
| Reads | CONSUMERS, RANCHERS, REFERRALS. |
| Telegram output | Daily card with drill-down buttons (`brief_leads / brief_stalled / brief_money / brief_pipeline`). |
| Known issues | None as of 2026-05-19. |

## email-sequences

| Field | Value |
|---|---|
| Purpose | Buyer-stage drip emails (WAITING / READY / MATCHED / CLOSED), abandoned-recovery, rancher agreement reminders. |
| Schedule | `0 16 * * *` — daily 16 UTC. |
| Reads | CONSUMERS, RANCHERS. |
| Writes | `Sequence Stage` + `Sequence Sent At` on CONSUMERS; rancher reminder timestamps. |
| Telegram output | Send count summary. |
| Known issues | READY_NUDGE is one-shot (sets `Sequence Stage='READY_NUDGE'` then never re-fires). Stuck-buyer reanimation now handled by `re-warm-cohort`. |

## healthcheck

| Field | Value |
|---|---|
| Purpose | `/api/health` smoke + green/red Telegram card. |
| Schedule | `0 13 * * *` — daily 13 UTC. |
| Reads | Airtable, Resend, Telegram, AI provider. |
| Telegram output | One-line status card. |
| Known issues | Returns `partial`/`error` for degraded states but HTTP 200 (Vercel doesn't mark cron failed). |

## nightly-rancher-audit

| Field | Value |
|---|---|
| Purpose | Per-rancher pipeline summary + 10 system checks (capacity drift, tier mismatches, pilot complete, etc). |
| Schedule | `0 5 * * *` — daily 5 UTC. |
| Reads | RANCHERS, REFERRALS, CONSUMERS. |
| Writes | `Pilot Upsell Notified At` when pilot goal reached (added 2026-05-19). |
| Telegram output | Multi-chunk audit card with `🚨 critical / 🟡 warn / 🟢 info` issues. |
| Known issues | Used to bury pilot-complete in critical list; now fires celebration alert + stamps notified-at as a side-effect. |

## onboarding-stuck

| Field | Value |
|---|---|
| Purpose | Day 3/7/14 nudges for ranchers stuck at Call Complete / Docs Sent / signed-no-page. |
| Schedule | `15 16 * * *` — daily 16:15 UTC. |
| Reads | RANCHERS. |
| Writes | `Last Onboarding Nudge At`. |
| Telegram output | Summary card. |
| Known issues | None as of 2026-05-19. |

## rancher-followup

| Field | Value |
|---|---|
| Purpose | Weekly stalled-stage rancher Telegram alerts + stale-lead nudge emails. |
| Schedule | `0 15 * * *` — daily 15 UTC; in-handler Monday guard. Was `0 15 * * 1`; Vercel dropped day-of-week (0 runs in 14d). |
| Reads | RANCHERS. |
| Telegram output | Stalled-rancher cards with action buttons. |
| Known issues | See schedule note. |

## rancher-launch-warmup

| Field | Value |
|---|---|
| Purpose | Throttled/trust-mode warmup emails to waitlisted buyers when a rancher goes live, plus Day-7 nudge. |
| Schedule | `30 13 * * *` — daily 13:30 UTC. |
| Reads | RANCHERS, CONSUMERS. |
| Writes | `Warmup Sent At`, `Warmup Stage`, `Buyer Stage=READY`, `Launch Warmup Triggered`, `Warmup Last Batch At` on RANCHERS. |
| Telegram output | Per-rancher batch summary + global daily total. |
| Known issues | Phase 1 filter `NOT({Warmup Sent At})` stranded ~679 buyers forever; `re-warm-cohort` cron now reanimates after 60 days (cap 2 lifetime). |
| Knobs | `WARMUP_CAP_PER_RUN`, per-rancher `Onboarding Intro Pace` (default 5/week), 24h `COOLDOWN_MS`. |

## rancher-onboarding-drip

| Field | Value |
|---|---|
| Purpose | Self-submit Day 2/5/14 drip emails. |
| Schedule | `30 17 * * *` — daily 17:30 UTC. |
| Reads | RANCHERS. |
| Writes | `Self-Submit Drip Stage`. |
| Telegram output | Summary. |
| Known issues | None as of 2026-05-19. |

## rancher-trust-promotion

| Field | Value |
|---|---|
| Purpose | Flip `Trust Mode=true` for ranchers who've graduated (5+ closed won OR `Onboarding Phase Until` passed). |
| Schedule | `45 14 * * *` — daily 14:45 UTC. |
| Reads | RANCHERS, REFERRALS. |
| Writes | `Trust Mode` on RANCHERS. |
| Telegram output | Promotion announcements. |
| Known issues | None as of 2026-05-19. |

## referral-chasup

| Field | Value |
|---|---|
| Purpose | AI re-engagement emails for stale referrals, ghost auto-close, stalled-rancher Telegram nudges. |
| Schedule | `0 17 * * *` — daily 17 UTC. |
| Reads | REFERRALS, RANCHERS, CONSUMERS. |
| Writes | `Last Chased At`, `Chase Count`, `Stalled Alert Sent At`, `Rancher Reminded At`, `AI Chase Draft`, `Repeat Outreach Sent`, status flips to Closed Lost on 30-day ghost. |
| Telegram output | Multi-section summary: stale chases, rancher reminders, stalled alerts, reassignments. |
| Known issues | Has its own inline "stalled" definition; new canonical helper `lib/stalledReferrals.ts` exists but not yet folded in here (separate refactor pass). |

## re-warm-cohort

| Field | Value |
|---|---|
| Purpose | Reanimate buyers warmed >60 days ago with no engagement by clearing `Warmup Sent At` so `rancher-launch-warmup` Phase 1 re-picks them up. |
| Schedule | `30 16 * * *` — daily 16:30 UTC (added 2026-05-19). |
| Reads | CONSUMERS. |
| Writes | Clears `Warmup Sent At` + `Warmup Stage`; stamps `Warmup Reanimated At`; increments `Re-Warm Attempts`. |
| Telegram output | "Reanimated N buyers" heads-up so the next launch-warmup batch isn't surprising. |
| Known issues | None yet. Lifetime cap 2 per buyer; daily cap 50 to bleed cohort in over ~2 weeks. |

## send-scheduled

| Field | Value |
|---|---|
| Purpose | Drain due `Campaigns` table rows. |
| Schedule | `0 * * * *` — hourly. |
| Reads | CAMPAIGNS. |
| Writes | Marks campaigns sent + emits emails. |
| Telegram output | Per-batch send summary. |
| Known issues | Mostly idle (`no campaigns due` daily). |

## stuck-buyer-recovery

| Field | Value |
|---|---|
| Purpose | Retry matching for buyers stuck at `Buyer Stage=READY` with `Ready to Buy=true` and no active referral. |
| Schedule | `30 14 * * *` — daily 14:30 UTC. |
| Reads | CONSUMERS, REFERRALS. |
| Writes | `Last Match Attempt At` (24h cooldown); on match: `Buyer Stage=MATCHED`. |
| Telegram output | Summary card. |
| Known issues | None as of 2026-05-19. |

---

## Operator Surfaces (Telegram)

Added 2026-05-19 — see `lib/cronIntrospection.ts`:

| Command | Purpose |
|---|---|
| `/cronstatus`, `/runs` | Last-24h per-cron status + missing-run alerts. |
| `/pausecron <name>` | Write a `Cron Pauses` row so `withCronRun` short-circuits the cron. |
| `/resumecron <name>` | Clear the Paused flag (preserves audit trail). |
| `/forcematch <email-or-recId>` | Direct call to `/api/matching/suggest` with `warmupEngaged=true` bypass. |
| `/stuckbuyers` | Waitlisted >14d, grouped by state. |
| `/stuckranchers` | Signed-not-Live + Live-but-quiet (30d). |
| `/ghostranchers` | Ranchers with 2+ buyer-pulse ghost reports. |
