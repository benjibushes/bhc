# Money Truth & Data Integrity — build spec

*Written 2026-07-19 after a live incident: rancher Champion Valley couldn't
collect $650 from buyer Dave. Root cause was NOT Stripe. This spec makes that
class of failure impossible, and makes the tables provably honest — payments
first.*

---

## What actually happened (the incident, for context)

Verified healthy and ruled out: Champion Valley's Stripe account
(`charges_enabled: true`, no requirements, bank attached), `STRIPE_CONNECT_ENABLED`
(live probe returned `400 referralId required`, not `503`), the deposit route,
the direct-charge + `application_fee_amount` pattern (correct for a Standard
account), and state eligibility (serves NE/CO/KS, multi-state approved).

**Live probe result** — `POST /api/checkout/deposit {referralId, cutSize:'half'}`
returned `terms_required`, meaning it passed EVERY gate: Connect, CSRF, buyer
ownership, already-paid, rancher/tier/bank/Connect-account, price floor. And
`GET /checkout/<refId>/deposit` returned **200**.

**So the rail works.** The failure was that the referral was stamped
`Awaiting Payment` while `Deposit Link` was never minted, stored, or sent —
a half-finished state. 8 of 8 Awaiting Payment referrals had no link;
the oldest sat 17 days; one (Bonnie, $300) already died to Closed Lost.
~$5,000 of requested deposits were sitting undeliverable.

---

## Part 1 — The invariant

> **No referral may be in `Awaiting Payment` without a payment link that was
> minted, stored, AND sent.**

### 1a. Prevention — make the bad state uncreatable
`request-deposit` becomes atomic, in this order:
1. mint durable link (`/r/[token]` rail — NEVER a raw Stripe URL, they expire in 24h)
2. send it to the buyer
3. write `Deposit Link` + `Deposit Link Sent At`
4. **only then** stamp `Status = 'Awaiting Payment'` + `Deposit Requested At`

If any step fails: **stamp nothing**, roll back, alert Telegram. Half-states
must be unrepresentable.

### 1b. Detection — watchdog cron
Any referral where `Status = 'Awaiting Payment'` AND (`Deposit Link` blank OR
`Deposit Link Sent At` blank OR unpaid > 2h) → 🚨 Telegram with a one-tap
**"Send link now"** that mints + sends. Self-healing. This would have caught
all 8 on July 2 instead of 17 days later.

### 1c. Per-partner proof at go-live ← prevents the partner nightmare
**Every rancher runs a live payment-path smoke test before being marked live.**
Replay the probe above against their account and assert it reaches
`terms_required`. Pass → live. Fail → **not live**, and the operator is told
exactly which gate failed (no tier / no bank / no price / Connect inactive).
No partner ever again discovers a broken payment path via a lost customer.

### 1d. Daily canary
Run 1c across every live rancher nightly. A rancher who silently breaks later
(bank removed, Connect deauthorized, price cleared) trips an alarm instead of
a lost sale.

---

## Part 2 — Table read/write integrity

Nightly `money-truth` cron asserts these and Telegrams every violation.
**Payments first — these are the ones that decide whether you've been paid.**

### Money invariants (highest severity)
| # | Invariant | Real violation found 2026-07-19 |
|---|---|---|
| M1 | `Commission Paid At` set ⇒ `Commission Paid` > 0 | **11 violations** — dates set, amount $0 |
| M2 | `Commission Paid` > 0 ⇒ `Commission Paid At` set | check |
| M3 | `Status = Closed Won` ⇒ `Sale Amount` > 0 AND `Commission Due` > 0 | 18 rows had amounts; verify going forward |
| M4 | `Deposit Paid At` set ⇒ a matching Stripe PaymentIntent exists | reconcile vs Stripe |
| M5 | Every succeeded Stripe charge maps to exactly one referral | reconcile vs Stripe |
| M6 | `Awaiting Payment` ⇒ link minted + stored + sent (Part 1) | **8 violations** |
| M7 | `Commission Due` ≈ `Sale Amount` × rancher `Commission Rate` (±$1) | catches rate drift |

**M1/M2 matter most: today your books cannot tell you whether $2,920 of earned
commission was collected.** That must be unambiguous.

### Hygiene invariants
| # | Invariant | Real violation found |
|---|---|---|
| H1 | No timestamp in the future | **82 rows stamped `2099-12`** |
| H2 | One canonical field per fact — kill `Cut Size` vs `Order Type` duplication | Dave had `Order Type` only |
| H3 | `Status = Closed Lost` ⇒ has a `Loss Reason` (or explicit `auto-reaped` flag) | **1,391 blank** |
| H4 | Rancher `Stripe Connect Status` matches live Stripe (`charges_enabled`) | Airtable is a cache; Stripe is truth |
| H5 | Rancher marked live ⇒ passes the 1c smoke test | |

### Write-side discipline (prevents violations at the source)
- **Atomic multi-field writes** — never leave a record half-updated. Same
  pattern as Part 1a.
- **Required-field guards** — a status transition that needs context (Closed
  Lost → reason; Awaiting Payment → link) refuses the write without it.
- **One canonical field per fact.** Pick `Order Type` OR `Cut Size`, migrate,
  delete the loser. Two fields for one fact WILL drift.
- **Stripe is the source of truth for money.** Airtable mirrors it. On any
  conflict, Stripe wins and Airtable gets corrected + logged.

---

## Part 3 — Reporting

Daily Telegram: `🧾 money truth: 47 checks · 0 violations` — or the list, with
one-tap fixes where a fix is safe and deterministic.

Silence must mean *verified healthy*, never *never ran*. The cron reports even
on a clean run (a missing report is itself an alarm).

---

## Build order (highest value first)
1. **1a + 1b** — atomic request-deposit + watchdog. Stops the active bleeding.
2. **1c** — go-live smoke test. Protects every future partner.
3. **M1–M6** — money invariants + Stripe reconciliation. Makes the books honest.
4. **1d + Part 3** — canary + daily report.
5. **H1–H3 + write discipline** — hygiene and the field-duplication cleanup.

## Immediate manual action (not code)
- Send Dave his link: `https://www.buyhalfcow.com/checkout/recbnzdZB4MixIyh5/deposit`
- Same for the other 7 Awaiting Payment (~$4,350 total, oldest 17 days)
- Resolve M1: was the $2,920 of commission actually collected? Only Ben knows.
