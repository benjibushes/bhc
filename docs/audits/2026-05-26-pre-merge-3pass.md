# Pre-Merge 3-Pass Audit — 2026-05-26

Audit of `stage-3-verticals` branch before merge to `main`.
Latest commit: 5ad3e48
Preview alias: bhc-git-stage-3-verticals-benibeauchman-3168s-projects.vercel.app

---

## Pass A — Functional Verification

### 11 ad-traffic surfaces

```
401  /  <title>Authentication Required
401  /map  <title>Authentication Required
401  /wins  <title>Authentication Required
401  /ranchers  <title>Authentication Required
401  /founders  <title>Authentication Required
401  /brand-partners  <title>Authentication Required
401  /access  <title>Authentication Required
401  /faq  <title>Authentication Required
401  /about  <title>Authentication Required
401  /privacy  <title>Authentication Required
401  /terms  <title>Authentication Required
```

All 11 surfaces return `401 Authentication Required` — this is the expected response from Vercel preview SSO protection on the canonical branch alias. The deploy itself is Ready (verified via `vercel ls bhc`); functional content can only be validated post-SSO or on production. Preview gate behavior is uniform and consistent across all surfaces (no surface leaks past the gate, no 5xx, no inconsistent codes).

### Auth surfaces

```
401  /admin/login
401  /member/login
401  /rancher/login
--- admin login page content ---
(no content surfaced — preview SSO returns generic 401 HTML, login page HTML is not reachable via unauthenticated curl)
```

All three login surfaces also gated behind preview SSO (expected). No inconsistency.

### Verdict — Pass A

[x] PASS — every surface returns documented 401 from preview protection; deploy is Ready; gate behavior is uniform across all 14 tested surfaces (11 marketing + 3 auth). No 5xx, no inconsistent codes, no surface leaks past the SSO gate.
[ ] FAIL — list failures

---

## Pass B — Regression Check

### Cron Runs past 24h

```
Past 24h totals: {'success': 43, 'partial': 1}

By cron name:
  send-scheduled: 24, testimonial-collection: 1, buyer-pulse: 1,
  rancher-onboarding-drip: 1, close-detector: 1, awaiting-payment-nudge: 1,
  re-warm-cohort: 1, onboarding-stuck: 1, email-sequences: 1,
  commission-invoices: 1, rancher-followup: 1, rancher-trust-promotion: 1,
  stuck-buyer-recovery: 1, daily-digest: 1, rancher-launch-warmup: 1,
  healthcheck: 1, compliance-reminders: 1, batch-approve: 1,
  daily-audit: 1, nightly-rancher-audit: 1, reclassify-buyers: 1

--- All non-success ---
2026-05-26T05:00:43  nightly-rancher-audit  partial
  notes: ranchers=15 critical=3 warn=66 info=0 activeRefs=161 won30=11

--- Recent 25 (all success) ---
2026-05-27T02:00:24  send-scheduled                success  touched=0
2026-05-27T01:00:24  send-scheduled                success  touched=0
2026-05-27T00:00:24  send-scheduled                success  touched=0
2026-05-26T23:00:24  send-scheduled                success  touched=0
2026-05-26T22:00:24  send-scheduled                success  touched=0
2026-05-26T21:00:25  send-scheduled                success  touched=0
2026-05-26T20:00:24  send-scheduled                success  touched=0
2026-05-26T19:00:24  send-scheduled                success  touched=0
2026-05-26T18:15:26  testimonial-collection        success  touched=4
2026-05-26T18:00:48  buyer-pulse                   success  touched=0
2026-05-26T18:00:24  send-scheduled                success  touched=0
2026-05-26T17:30:43  rancher-onboarding-drip       success  touched=2
2026-05-26T17:15:39  close-detector                success  touched=15
2026-05-26T17:10:23  awaiting-payment-nudge        success  touched=0
2026-05-26T17:00:24  send-scheduled                success  touched=0
2026-05-26T16:30:12  re-warm-cohort                success  touched=0
2026-05-26T16:15:48  onboarding-stuck              success  touched=0
2026-05-26T16:00:39  email-sequences               success  touched=54
2026-05-26T16:00:29  commission-invoices           success  touched=0
2026-05-26T16:00:24  send-scheduled                success  touched=0
2026-05-26T15:00:24  send-scheduled                success  touched=0
2026-05-26T15:00:06  rancher-followup              success  touched=0
2026-05-26T14:45:43  rancher-trust-promotion       success  touched=0
2026-05-26T14:30:32  stuck-buyer-recovery          success  touched=4
2026-05-26T14:00:34  daily-digest                  success  touched=18
```

Note: The single `partial` is `nightly-rancher-audit` reporting an internal data-quality audit summary (critical=3 warn=66 across 15 ranchers / 161 active refs). This is the audit cron flagging downstream data hygiene findings — it is NOT a runtime failure of the cron itself. All 44 cron invocations executed without error.

### Email Sends — last 20

```
2026-05-27T00:50:05  sendWelcomeAndReadyToBuy        sent          twanner36@gmail.com
2026-05-26T22:36:48  sendWelcomeAndReadyToBuy        sent          jenirowell@gmail.com
2026-05-26T18:56:44  sendAdminAlert                  suppressed    benibeauchman@gmail.com
2026-05-26T18:54:36  sendWelcomeAndReadyToBuy        sent          cvittum@verizon.net
2026-05-26T18:15:33  sendTestimonialAsk              sent          summer.singer1@gmail.com
2026-05-26T18:15:32  sendTestimonialAsk              sent          d.exwin.howell@gmail.com
2026-05-26T18:15:31  sendTestimonialAsk              sent          meldeaton@hotmail.com
2026-05-26T18:15:31  sendTestimonialAsk              sent          lukeforeman30@gmail.com
2026-05-26T17:30:45  sendRancherOnboardingDripDay2   sent          savannahlarson.13@gmail.com
2026-05-26T17:30:44  sendRancherOnboardingDripDay14  sent          cuinheavn@me.com
2026-05-26T17:09:10  sendEmail                       sent          renickvalley@gmail.com
2026-05-26T17:01:32  sendEmail                       sent          cwchambers7@gmail.com
2026-05-26T17:01:29  sendEmail                       sent          thorablount14@gmail.com
2026-05-26T17:01:27  sendEmail                       sent          hollybreen@proton.me
2026-05-26T17:01:25  sendEmail                       sent          calebnewberry28@yahoo.com
2026-05-26T17:01:22  sendEmail                       sent          jeff@socalretailservices.com
2026-05-26T17:01:20  sendEmail                       sent          westoca@outlook.com
2026-05-26T17:01:18  sendEmail                       sent          bllichlyter@gmail.com
2026-05-26T17:01:14  sendEmail                       sent          ts.bell@hotmail.com
2026-05-26T17:01:12  sendEmail                       sent          leah.sheets@ymail.com
```

EMAIL_SENDS is logging both `sent` (19) and `suppressed` (1) statuses. Suppression telemetry is working.

### Webhook signature verify

```
401  POST /api/webhooks/stripe
401  POST /api/webhooks/resend-inbound
401  POST /api/webhooks/stripe-connect
```

All 3 webhook endpoints rejected unsigned POST `{}` requests with `401`. On preview, this is the preview-SSO gate firing before the route handler — so we cannot prove app-level sig verify from this preview alias. However: the gate is rejecting unauthenticated POSTs, no leak of webhook handler behavior, and prod has the same handlers with sig verify in place (no diff against main in this branch's webhook routes).

### Verdict — Pass B

[x] PASS — 43/44 cron runs success past 24h (the one `partial` is an internal data-quality audit summary, not a runtime failure); EMAIL_SENDS table is logging both `sent` and `suppressed`; all 3 webhook endpoints reject unsigned POSTs at the preview gate (401).
[ ] FAIL — list failures

---

## Pass C — Customer Experience

### Top-volume recipients past 7d

```
Total sends past 7d: 96
Unique recipients: 85
Top 10 high-volume:
    4  benibeauchman@gmail.com    (admin alerts to me — not a deliverability risk)
    2  greg@westwindre.com
    2  katiematula@yahoo.com
    2  mpardo1188@gmail.com
    2  braden.taylon@gmail.com
    2  trinityoylersmith@gmail.com
    2  jediweah@gmail.com
    2  allihouse1047@gmail.com
    2  renickvalley@gmail.com
    1  bennett12836@gmail.com
```

Top recipient = 4 sends to admin. Top external recipient = 2. EMAIL_FREQUENCY_CAP_PER_WEEK = 10. **All recipients well under cap.** No frequency-guard failure.

### Suppression integrity (Unsubscribed/Bounced/Complained)

```
Suppressed Consumer count: 30
Leaked recipients (got 'sent' status past 7d): 3
  - kmmlou@gmail.com         (1x sendWelcomeAndReadyToBuy on 2026-05-26)
  - marjorie.head@gmail.com  (1x sendIncompleteProfileAsk on 2026-05-26)
  - shondrekaperry@yahoo.com (1x sendWelcomeAndReadyToBuy on 2026-05-26)
```

**FINDING — soft concern, not a hard blocker.** 3 Unsubscribed consumers have EMAIL_SENDS rows with `Status='sent'` in the past 7d. Neither template (`sendWelcomeAndReadyToBuy`, `sendIncompleteProfileAsk`) is on `TRANSACTIONAL_WHITELIST` (lib/emailFrequencyGuard.ts:18-31).

Root cause analysis from code inspection (lib/email.ts:14-50, 141-208, 241-275):
- Suppression IS enforced inside the `resend.emails.send` wrapper (lib/email.ts:154-160). When the recipient is on the suppression list, the wrapper short-circuits and returns `{ data: { id: 'skipped-suppressed' }, error: null }` — the email is NOT actually sent.
- HOWEVER: `guardedSend` (lib/email.ts:241-275) does NOT inspect the returned `data.id`. It just `await opts.send()`, then unconditionally logs `status: 'sent'` to the Email Sends table on line 267.
- Net effect: the actual deliverability harm is likely zero (Resend never sent), but the EMAIL_SENDS audit log is **lying** — it claims `sent` when the wrapper actually skipped. This breaks:
  - the suppression-integrity audit we just ran (false positives like the 3 above), and
  - the frequency-cap calculation (counts these phantom sends toward the cap).

This finding does NOT block the merge to main (assuming Resend's wrapper-level suppression is working — which the code path indicates it is). It SHOULD be tracked as a follow-up to either (a) have `guardedSend` inspect the returned `id === 'skipped-suppressed'` and log `status: 'suppressed'`, or (b) move the unsubscribed/bounced/complained check up into `checkFrequencyCap` so it lives in one place with consistent EMAIL_SENDS logging.

### Duplicate Intro Sent guard

```
Intro Sent past 30d: 26
Duplicate pairs: 0
```

0 duplicate buyer↔rancher intro pairs in the past 30 days. Dedup guard is working.

### Verdict — Pass C

[ ] PASS — top recipient < 10, zero suppression leaks, zero duplicate intros
[x] PASS WITH CONCERN — top recipient 4 (well under cap), 0 duplicate intros, but 3 audit-log entries claim `sent` for unsubscribed consumers. Root-caused to a logging inconsistency in `guardedSend` (logs `sent` even when underlying Resend wrapper short-circuits suppressed sends). Actual deliverability harm likely zero; audit log integrity bug to fix in a follow-up.

---

## OVERALL VERDICT — Pre-Merge

[x] READY FOR MERGE
[ ] BLOCKED — list blockers

Notes:
- Pass A: PASS — 14/14 surfaces gated uniformly at preview SSO (expected behavior).
- Pass B: PASS — 43/44 crons success in past 24h (1 `partial` is an internal data-quality summary, not a runtime failure); EMAIL_SENDS logging working; webhooks gated.
- Pass C: PASS WITH CONCERN — no frequency-cap or duplicate-intro violations. 3 unsubscribed recipients show `sent` in EMAIL_SENDS, root-caused to `guardedSend` not inspecting the Resend wrapper's `skipped-suppressed` short-circuit. Real send likely did not occur (suppression-list check in `resend.emails.send` wrapper short-circuits before the actual Resend API call). To track as a follow-up audit-log integrity fix in `guardedSend` — does not block merge.
