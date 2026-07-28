# Rancher Demand-Activation Playbook

*The repeatable per-rancher campaign that put Champion Valley's day-1 batch out
on 2026-07-28 (50/50 sent, 0 suppressed, 0 failed). Run this for every rancher
we owe service delivery to. Nothing here sends without Ben's per-campaign GO.*

## The machine
`POST /api/campaign/requalify-send` — CRON_SECRET Bearer, prod-side (the live
Resend key only exists in Vercel). Body: `{campaign, rancher:{name,slug},
recipients:[{email,name,state}], dryRun?}`. Template is baked server-side (the
approved quiz-resume copy, quiz-pinned CTA — requalification is mandatory, per
the quiz-required rule). Hard caps: **60/call**, **120/day domain-wide across
ALL campaigns** (enforced in the endpoint against Email Sends truth; fails
closed). Every send rides the guarded rail: suppression re-check, frequency
cap, tokenized unsubscribe, Email Sends log with delivered/opened/clicked.

## The procedure (per rancher)
1. **Rancher readiness** — Active + Connect `active` + prices set + capacity
   free (`Max Active Referalls` vs current; note the single-L typo). No prices
   → fix that first; the campaign lands on a page that can't take money.
2. **Dry-run selection** — served states (`getOperationalServedStates`:
   home state + Ship To States when `Admin Approved Multi-State`), stages
   WAITING/READY, then the six gates IN ORDER: suppression-clean → dedupe by
   email → no live referral (never campaign a mid-deal buyer) → off Ben's call
   list (qualified buyers get PHONE CALLS, not emails) → not emailed in 7 days
   → newest-first ramp batches of ≤50.
3. **Ben's GO** — show the gate funnel, final count, batch split, 5 samples,
   and the side-effect statement. No GO, no send.
4. **Fire day 1** via the endpoint. Day N+1 fires only if the stop-loss holds:
   **complaints <0.3%, hard bounces <5%** on the prior day (read Email Sends
   webhook truth). Never "catch up" a paused day.
5. **The close is the phone** — responders finish the pinned quiz → qualified →
   Ben's desk Call Queue. Deposit link goes out mid-call from the desk.
6. **Sunset** — two touches, no open → suppressed from future marketing.

## Queue (state of 2026-07-28 — re-verify before each run)
| Rancher | States | Pool est. | Blocker |
|---|---|---|---|
| Champion Valley | NE+CO+KS | day1 SENT, day2=49 armed | stop-loss check |
| Foodstead | MT (+ID/WA if approved) | small | none — honest-urgency page |
| Silverline | MO | TBD | stale processing date on page |
| Renick Valley | WV (+VA) | TBD | none |
| DD Ranch | OR | TBD | none |
| Lazy Bar 3 | TX (266 waiting!) | biggest pool | NO PRICES — Ben's call first |
| Gift Farms / JC's | OK / NC | TBD | legacy rail — no auto fee capture |

## Hard rules
- One campaign email per buyer per rancher, ever (frequency guard + sunset).
- Never campaign a buyer holding a live referral.
- The 120/day domain ceiling is shared — queue campaigns, don't parallelize.
- Copy claims must be true at send time (live share counters, no fake urgency).
