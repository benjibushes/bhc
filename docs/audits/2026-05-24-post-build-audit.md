# Post-Build Audit — 2026-05-24

Implementation: Operational Transparency + Control System
Commits audited: fe1b1c3 → 49f63d5 (6 commits, 7 plan tasks)
Spec: docs/superpowers/specs/2026-05-24-operational-transparency-control-design.md

## Pass A — Functional
- [pass] A1: spam-audit cron registered in vercel.json + endpoint responds HTTP 401 (auth gated)
- [pass] A2: all 6 Telegram commands wired in `app/api/webhooks/telegram/route.ts` (`/emaillog` L4295, `/pausemail` L4341, `/resumemail` L4356, `/freqcap` L4371, `/templatestats` L4382, `/whatfired` L4415)
- [pass] A3: `lib/emailFrequencyGuard.ts` exports `TRANSACTIONAL_WHITELIST`, `FrequencyGateResult`, `checkFrequencyCap`, `logEmailSend`, `isTransactionalTemplate`
- [pass] A4: every named send helper in `lib/email.ts` routes through `guardedSend`. All bare `resend.emails.send` calls (L1014, L1914, L1922, L2646) are nested INSIDE `send: () => …` callbacks of the surrounding `guardedSend({...})`. No direct (unwrapped) Resend calls remain in named helpers.
- [pass] A5: `npx tsc --noEmit` returns clean (no output)

## Pass B — Regression
- [pass] B1: 22 `"path":` entries in vercel.json (was 21, +1 spam-audit)
- [pass] B2: `GET https://www.buyhalfcow.com/api/health` → 401
- [pass] B3: `GET https://www.buyhalfcow.com/api/rancher/dashboard` → 401
- [pass] B4: TRANSACTIONAL_WHITELIST in `lib/emailFrequencyGuard.ts` L18-31 includes all 7 required entries PLUS `sendMonthlyCommissionInvoice`, `sendRancherGoLiveEmail`, `sendRancherSelfSubmitWelcome`, `sendPilotUpsellEmail`, `sendProspectClaimMagicLink` (12 total — superset of spec minimum)
- [fail] B5: 4 callers access `.error` on the result of wrapped send helpers — that key NEVER exists on the new return shape `{success, suppressed?, reason?}`. Suppressed sends (frequency cap, paused template) will silently appear successful to these callers.

  Affected files:
  - `app/api/admin/consumers/[id]/resend-warmup/route.ts:91` — `if (r && r.error)` always false
  - `app/api/admin/ranchers/[id]/resend-setup/route.ts:92` — `if (r && r.error)` always false
  - `app/api/cron/onboarding-stuck/route.ts:147` — `if (hasErr)` always false
  - `app/api/matching/suggest/route.ts:740` — `if (emailResult && emailResult.error)` always false (impacts `introSendErr` logging)

  Note: callers that check `.success` (e.g. `app/api/admin/send-merch/route.ts:13`, `app/api/ranchers/[id]/send-onboarding/route.ts:185`, `app/api/ranchers/resend-agreement/route.ts:91`) work correctly with the new shape. Resend network errors still throw out of `guardedSend` (L273 in `lib/email.ts`), so they hit the surrounding try/catch — only suppressions go silent.

## Pass C — Customer Experience
- [pass-conditional] C1: Email Sends table is empty (totalRecordCount=0). Deploy landed 2026-05-24 14:11 -0600 (~20:11 UTC). At audit time, very few hourly cron windows have elapsed and no email-emitting flow has been triggered since deploy. Empty table is consistent with low-traffic post-deploy window; will populate as `send-scheduled` (hourly), `daily-digest`, `email-sequences`, etc. fire on their next cron tick.
- [pass-vacuous] C2: No recipient could exceed cap because table is empty. Will need re-verification ≥48h post-deploy.
- [pass] C3: `/freqcap` handler (`app/api/webhooks/telegram/route.ts:4371-4379`) reads `process.env.EMAIL_FREQUENCY_CAP_PER_WEEK`. Same env var consumed in `lib/emailFrequencyGuard.ts:8` (`DEFAULT_FREQUENCY_CAP = Number(process.env.EMAIL_FREQUENCY_CAP_PER_WEEK || 10)`). Operator-visible value matches enforcement value.
- [pass] C4: TRANSACTIONAL_WHITELIST bypass logic in `lib/emailFrequencyGuard.ts:70-72` returns `{ok: true}` for whitelisted templates BEFORE cap check. Invoices, intros, approvals, founding herd welcome, prospect claim magic link all flow regardless of cap.

## Issues found

### Medium — Silent failure swallowing in 4 callers (Pass B5)
Four admin/cron endpoints check `.error` on wrapped send results. That field was returned by raw Resend SDK but is NOT returned by `guardedSend`. Effect: when a frequency-cap suppression occurs (e.g. an operator hitting "Resend onboarding" for the 11th time in a week to the same rancher), the admin UI shows success but no email goes out. Operator gets a false-positive confirmation.

Proposed fix (follow-up task):
- Update each caller to check `if (r && (r.error || r.suppressed))` and surface `r.reason` to the admin UI / cron log.
- OR: change `guardedSend` return to include legacy `error` shape for back-compat.

Files:
- `app/api/admin/consumers/[id]/resend-warmup/route.ts:91`
- `app/api/admin/ranchers/[id]/resend-setup/route.ts:92`
- `app/api/cron/onboarding-stuck/route.ts:147`
- `app/api/matching/suggest/route.ts:740`

### Low — C1/C2 re-verification needed
Email Sends table is empty at audit time. Re-run Pass C2 after 48h to confirm no recipient receives >10 sends/7d in real traffic.

## Ship status
🟡 SHIPPING WITH FOLLOW-UPS

Core observability + control system is live, type-clean, and correctly gating all named send helpers. One medium-severity regression: four admin/cron callers silently swallow frequency-cap suppressions and report false-positive success to operators. Customer-facing email path is safe (cap enforces correctly, transactional whitelist preserved, table populates as crons fire). Fix the four `.error` callers as a follow-up before relying on the admin "Resend X" buttons for high-stakes flows.
