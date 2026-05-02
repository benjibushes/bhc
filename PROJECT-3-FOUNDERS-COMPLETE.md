# Project 3 — Founding Herd Capital Raise · Handoff

Branch: `stage-2-founders`
Status: code complete, typecheck + build clean.

This is the operator's runbook to ship `/founders`. Read it top to bottom
once, then execute. Every step is locked to the spec from
`/Users/benji.bushes/.claude/plans/groovy-scribbling-sky.md` and the
constraints in `STAGE-1-REBUILD-CHANGELOG.md` Sections 2, 7, 10, 13.

---

## 1. Schema fields added to Consumers (`tblAbjQDnLrOtjpoE`)

All 13 fields exist in the Airtable Consumers table. Field IDs captured for
auditability — they're stable across renames.

| Field | Type | Field ID | Notes |
|---|---|---|---|
| `Founder Tier` | singleSelect | `fldpwFnTx4aTtDczJ` | Options: `Herd`, `Outlaw`, `Steward`, `Founding 100`, `Title Founder` |
| `Founder Number` | number (precision 0) | `fldCb1gYbwTj3sONs` | 1–100 / 1–10. Auto-assigned in webhook for capped tiers. |
| `Stripe Customer ID` | singleLineText | `fldh0k6xnazyAy7jz` | |
| `Stripe Subscription ID` | singleLineText | `fldbhch3crBNMDbgn` | |
| `Stripe Session ID` | singleLineText | `fldOO7RKTbFSSjjyj` | **Idempotency dedup key.** Webhook checks this BEFORE any writes. |
| `Subscription Status` | singleSelect | `flde4RKFg8EvtqXya` | Options: `active`, `cancelled`, `past_due` |
| `Subscribed At` | dateTime | `fldKc9b2rZICVbbuU` | |
| `Tier Amount Paid` | currency (USD) | `fldrLxOlCrwVohbMv` | |
| `Backer Type` | singleSelect | `fldlEaq3aYbIoyFIC` | Options: `Individual`, `Brand` |
| `Wall Opt-In` | checkbox (greenBright/check) | `fldEoVupGMz9ESjMC` | Default-true for Outlaw+ tiers; explicit checkout custom field for Herd. |
| `Founder Welcome Sent At` | dateTime | `flddMYrgXPo3YpOxh` | Set LAST in webhook so retries skip the email. |
| `Warm List` | checkbox (greenBright/check) | `fldhMUFE53Gx2s62y` | Manual outreach view filter. |
| `Last Contacted At` | date | `fldPIn36SShCdEQB2` | |

Existing buyer-stage fields (`Buyer Stage`, `Buyer Stage Updated At`,
`Status`, `Email`, `Full Name`, etc.) are **untouched**. The two state
machines are orthogonal — a Founder can also be a Buyer with `Buyer Stage =
MATCHED`. Founder code never reads or writes Buyer Stage.

---

## 2. Stripe products & Payment Links (you create these manually)

Per spec, the user creates these in the Stripe dashboard. Code consumes the
resulting Payment Link URLs and price IDs via env vars.

### 2.1 Subscription products + prices (6 total)

Create one Product per subscription tier with two recurring prices each
(monthly + annual). Each price needs `metadata = { type:
"founder-subscription", tier: "<slug>" }`.

| Product | Price | Recurrence | Metadata `tier` |
|---|---|---|---|
| Herd | $9 | month | `herd-monthly` |
| Herd | $90 | year | `herd-annual` |
| Outlaw | $25 | month | `outlaw-monthly` |
| Outlaw | $250 | year | `outlaw-annual` |
| Steward | $75 | month | `steward-monthly` |
| Steward | $750 | year | `steward-annual` |

### 2.2 One-time products (2 total)

- **Founding 100** — single product, dynamic price. The page reads
  `FOUNDING_100_PRICE_CENTS` (default `100000` = $1,000). Flip to `150000`
  via env on Day 7 by setting `FOUNDING_100_EARLY_BIRD_END` to a past
  timestamp OR updating `FOUNDING_100_PRICE_CENTS` directly. **NOT exposed
  as a Payment Link** — uses `/api/founders/checkout` for cap enforcement.
- **Title Founder** — single product, fixed $15,000 price.

### 2.3 Payment Links (7 total)

Create a Payment Link for each of the 7 fixed-price tiers. Set redirect to
`https://buyhalfcow.com/founders?success=1&session_id={CHECKOUT_SESSION_ID}`.
Each Payment Link needs metadata pinned on the Payment Link object itself
(not on the price). Stripe propagates Payment-Link metadata to the
underlying `checkout.session`.

| Payment Link | Metadata |
|---|---|
| Herd Monthly | `{ "type": "founder-subscription", "tier": "herd-monthly" }` |
| Herd Annual | `{ "type": "founder-subscription", "tier": "herd-annual" }` |
| Outlaw Monthly | `{ "type": "founder-subscription", "tier": "outlaw-monthly" }` |
| Outlaw Annual | `{ "type": "founder-subscription", "tier": "outlaw-annual" }` |
| Steward Monthly | `{ "type": "founder-subscription", "tier": "steward-monthly" }` |
| Steward Annual | `{ "type": "founder-subscription", "tier": "steward-annual" }` |
| Title Founder | `{ "type": "founder-lifetime", "tier": "title-founder" }` |

**Founding 100 is NOT a Payment Link.** It goes through
`/api/founders/checkout` so the cap (`FOUNDING_100_CAP=100`) is enforced
pre-checkout.

### 2.4 Stripe webhook endpoint

Already exists at `https://buyhalfcow.com/api/webhooks/stripe`. Verify in
Stripe dashboard that the endpoint is subscribed to:

- `checkout.session.completed` ✅ (existing)
- `customer.subscription.deleted` ← ADD if not subscribed
- `invoice.payment_failed` ← ADD if not subscribed

`STRIPE_WEBHOOK_SECRET` must be the secret for this single endpoint.

---

## 3. Env vars to set on Vercel

```bash
# ── Founding Herd pricing + caps ──
FOUNDING_100_PRICE_CENTS=100000
FOUNDING_100_EARLY_BIRD_END=2026-XX-XXT05:00:00Z   # set to actual flip date in UTC
FOUNDING_100_CAP=100
TITLE_FOUNDER_CAP=10

# ── Stripe Payment Link URLs (paste from Stripe dashboard) ──
STRIPE_PAYMENT_LINK_HERD_MONTHLY=https://buy.stripe.com/...
STRIPE_PAYMENT_LINK_HERD_ANNUAL=https://buy.stripe.com/...
STRIPE_PAYMENT_LINK_OUTLAW_MONTHLY=https://buy.stripe.com/...
STRIPE_PAYMENT_LINK_OUTLAW_ANNUAL=https://buy.stripe.com/...
STRIPE_PAYMENT_LINK_STEWARD_MONTHLY=https://buy.stripe.com/...
STRIPE_PAYMENT_LINK_STEWARD_ANNUAL=https://buy.stripe.com/...
STRIPE_PAYMENT_LINK_TITLE_FOUNDER=https://buy.stripe.com/...

# ── Verification mode toggle ──
FOUNDERS_TEST_MODE=false                       # flip to true for the $1 smoke test
FOUNDERS_TELEGRAM_URL=https://t.me/+xxxxxxxxxx # the actual Founding Herd group invite

# ── Existing prerequisites already wired ──
# STRIPE_SECRET_KEY=sk_live_...                  (Stage 1)
# STRIPE_WEBHOOK_SECRET=whsec_...                (Stage 1)
# RESEND_API_KEY=re_...                          (Stage 1)
# AIRTABLE_API_KEY=pat...                        (Stage 1)
# AIRTABLE_BASE_ID=appgLT4z009iwAfhs             (Stage 1)
# JWT_SECRET=...                                 (Stage 1)
# CALENDLY_LINK=https://...                      (Stage 1)
# TELEGRAM_BOT_TOKEN / TELEGRAM_ADMIN_CHAT_ID    (Stage 1)
```

The cap + price env vars default to safe values in `lib/secrets.ts`, so
forgetting them in CI will never crash the build — but real Vercel needs
the real values to drive the page + checkout cleanly.

---

## 4. $1 verification test sequence

The single most important pre-launch ritual. Real card, real webhook, real
email, real refund. Catches every system failure end-to-end.

1. **Set `FOUNDERS_TEST_MODE=true` on Vercel** + redeploy.
2. Visit `https://buyhalfcow.com/founders` → scroll to tier table → the
   `$1 verification` tier appears as the 6th card.
3. Click `$1 verification charge`. The button POSTs to
   `/api/founders/checkout` with `tier=test-1`, redirects to Stripe Checkout.
4. Pay with a **real card you'll refund** (Ben's personal card is fine).
5. After Stripe redirects back to `/founders?success=1&...`, verify all six:

   **A. Stripe webhook fires** — Stripe dashboard → Webhooks → endpoint →
   recent attempts → see `checkout.session.completed` with status 200.

   **B. Consumer row created** — Airtable Consumers → filter by
   `Email = <your test email>`. Should show: `Founder Tier = "Founding 100"`,
   `Founder Number` populated (next integer in Founding 100 sequence),
   `Stripe Session ID = cs_...`, `Tier Amount Paid = $1`, `Subscribed At`
   populated, `Founder Welcome Sent At` populated, `Source = "founders-page"`,
   `Status = "Approved"`. **Verify `Buyer Stage` is unchanged from before
   the test** (it should still be whatever it was — most likely empty for
   a brand-new email).

   **C. Welcome email arrives** — check the test email inbox. Voice
   verification:
   - subject is lowercase: `welcome to the founding herd, founder #N`
   - opener is `Hey <First>,`
   - signed `— Ben`
   - footer line: `BuyHalfCow · 1001 S. Main St. Ste 600 · Kalispell, MT 59901`
   - has the `/unsubscribe` link
   - **does NOT contain** "Private Network", "The HERD", "10,000 families",
     emoji subject prefix, multiple competing CTAs

   **D. Telegram alert arrives** — chat with `🪙 Founding Herd Backer`
   header, tier `Founding 100`, founder number, email, `$1`,
   `founder-lifetime`.

   **E. `/founders` Wall shows the test record** — the `Founders Wall`
   section should show your number tile filled. NOTE: the wall hides test
   purchases (`Tier Amount Paid <= $5` AND tier ∈ {Founding 100, Title
   Founder}), so by design **the test row should NOT appear**. If it does
   appear, the test-row filter in `FoundersWall.tsx` is wrong.

   **F. Refund via Stripe dashboard** — Stripe → Payments → find the $1 →
   Refund. After ~30s, run a manual cleanup:
   - Set `Founder Tier = ''`, `Founder Number = (empty)`, `Stripe Session
     ID = ''`, `Tier Amount Paid = 0` on the Consumer row, OR delete the
     test row entirely.

6. **Set `FOUNDERS_TEST_MODE=false`** on Vercel + redeploy. The $1 tier
   disappears from the page, and the checkout route refuses `tier=test-1`.

7. **Re-run idempotency proof** — copy the Stripe webhook delivery for the
   $1 charge → "Resend" from the Stripe dashboard. The webhook should
   return 200 + `idempotent: true` in the body. No second email, no second
   Telegram, no second Consumer row.

---

## 5. Cap enforcement test

Validates Founding 100 closes at #100 and Title Founder at #10.

1. **Manually populate** Airtable Consumers with 99 fake `Founding 100` rows
   (just need `Founder Tier = "Founding 100"`; the count query reads the
   tier, nothing else).
2. Visit `/founders`. Counter shows `99 of 100`. Button says
   `Claim a Founding 100 spot · $1,000 early bird`.
3. Click button → completes checkout → 100th row created (the page count
   refreshes within 10 minutes due to `revalidate = 600`, but Airtable shows
   it instantly).
4. Reload `/founders`. Counter shows `100 of 100`. Button is greyed out —
   `Sold out`.
5. Manually POST to `/api/founders/checkout` with `tier=founding-100` →
   should return `409 { error: "Founding 100 is sold out (100/100)." }`.
6. **Cleanup**: delete the 99 fake rows + the test row.

Repeat with 9 fake `Title Founder` rows for the 10-spot cap. Note: Title
Founder is a Stripe Payment Link (not the cap-enforced route), so the cap
is enforced post-checkout via the webhook's pre-write count → if Stripe
fires the 11th purchase before any of the prior 10 finished writing,
**there's a small race window**. Mitigation: refund the 11th from Stripe
dashboard and email the buyer a $15k apology + a custom Title Founder
arrangement. (Tracked in spec section P3.5; acceptable for v1.)

---

## 6. Full launch sequence

```bash
[ ] Stripe dashboard: create 8 products, 6 subscription prices, 1 dynamic
    Founding 100, 1 fixed Title Founder, 7 Payment Links with metadata
[ ] Stripe dashboard: subscribe webhook endpoint to
    customer.subscription.deleted + invoice.payment_failed
[ ] Vercel: set the 11 env vars from §3 above
[ ] Vercel: deploy stage-2-founders → preview URL
[ ] Smoke-test the $1 verification flow on the preview URL (§4)
[ ] FOUNDERS_TEST_MODE=false on Vercel + redeploy
[ ] git checkout main && git merge stage-2-founders --no-ff
[ ] git push origin main → Vercel auto-deploys production
[ ] Visit https://buyhalfcow.com/founders → all 5 tiers visible, counter
    shows real counts (0 of 100 etc.), no $1 tier
[ ] Hit /sitemap.xml → /founders is in there
[ ] Re-run the idempotency proof on production (resend a Stripe webhook
    to confirm the dedup branch)
[ ] Announce to existing list (broadcast script or manual email)
[ ] Watch Telegram for first paid backer, confirm everything fires once
```

### When the early-bird flips (Day 7)

```bash
[ ] Vercel: set FOUNDING_100_EARLY_BIRD_END to a past timestamp (or
    current time) OR set FOUNDING_100_PRICE_CENTS=150000 directly
[ ] Vercel: redeploy
[ ] /founders shows "$1,500" + "(early bird ended)"
```

No Stripe surgery, no Stripe dashboard edits. The dynamic-price product
reads the env on every checkout.

### Rollback plan

If the founders page or webhook misfires on launch day:

1. Vercel → revert deployment to last-good (one click).
2. Founders Airtable rows are additive — no Buyer Stage / existing field
   was touched, so a code rollback leaves the buyer pipeline intact.
3. Refund any successful Stripe charges from the last 24h via the Stripe
   dashboard. The Consumer rows for those refunds: clear `Founder Tier` +
   `Tier Amount Paid` manually, OR delete the rows entirely.

---

## 7. Files in this project

### Created

- `app/api/founders/checkout/route.ts` — open checkout endpoint, cap-enforced
- `app/founders/page.tsx` — public landing page
- `app/founders/components/FoundersWall.tsx` — server-rendered wall
- `app/founders/components/FounderCheckoutButton.tsx` — client button → checkout
- `PROJECT-3-FOUNDERS-COMPLETE.md` — this doc

### Modified

- `app/api/webhooks/stripe/route.ts` — flat-if → switch + 2 founder branches
  + idempotency check + churn / payment-failed handlers. Brand-listing
  branch ISOLATED in its own helper, completely unchanged in behavior.
- `lib/email.ts` — added `sendFoundingHerdWelcome`. Did NOT modify any of
  the 7 Stage 1 founder-voice email functions.
- `lib/secrets.ts` — added 8 founder env vars + `getFounding100PriceCents()`
  + `getFounding100PriceLabel()` helpers.
- `app/sitemap.ts` — added `/founders` at priority 0.9.

### Untouched (per spec — sibling worktrees / Stage 1 territory)

- The 7 Stage 1 founder-voice email functions in `lib/email.ts`
- `app/api/cron/email-sequences/route.ts`
- `app/api/cron/rancher-launch-warmup/route.ts` (Agent A)
- `app/api/warmup/engage/route.ts` (Agent A)
- `app/api/webhooks/telegram/route.ts` (Agent A)
- `app/api/cron/batch-approve/route.ts`
- `app/api/consumers/route.ts`
- `app/api/matching/suggest/route.ts`
- `app/r/*` (Agent B)
- `app/map/*` (Agent B)
- `app/matched/page.tsx`
- `scripts/buyer-stage-migration.mjs`, `scripts/relaunch-broadcast.mjs`
- The `brand-listing` branch behavior in the Stripe webhook

---

## 8. Idempotency contract (the single biggest launch-day defense)

The Stripe webhook will retry on any non-2xx response. Stripe ALSO sometimes
fires the same event twice during regional failovers, network weirdness, or
when an event is replayed from the dashboard. Without idempotency, a single
button click can produce:

- 2+ Consumer rows
- 2+ welcome emails
- 2+ Telegram alerts
- 2 different Founder Numbers issued for the same person

Our defense, in order:

1. **Primary**: every founder webhook starts with a query for any Consumer
   with the matching `Stripe Session ID`. If found → return 200 immediately
   with `{ idempotent: true }`.
2. **Secondary**: when upserting by email, we read the existing row's
   `Founder Welcome Sent At`. If set → skip the email send.
3. **Tertiary**: `Founder Welcome Sent At` is set LAST in the webhook flow,
   so even a write that crashes between the Stripe Session ID write and the
   Welcome Sent timestamp leaves the system in a state where retries hit
   primary defense (1) first.

**Do not refactor the webhook to remove (1).** It is the single most
important 5 LOC in this entire project.

---

## 9. Voice anchors (mandatory for every email or page string)

`STAGE-1-REBUILD-CHANGELOG.md` Section 10 is the canonical rule set. Quick
reference for any future founder-tier copy edits:

- Lowercase opener: `Hey <First>,` or `Hi <First>,`
- Lowercase conversational subjects: `welcome to the founding herd,
  founder #47`
- Single primary CTA per email
- Sign `— Ben` or `— Benjamin`
- Footer line: `BuyHalfCow · 1001 S. Main St. Ste 600 · Kalispell, MT 59901`
- Mission line for occasional anchor (already in
  `sendFoundingHerdWelcome`): *"We're gonna take back American ranching and
  agriculture."*

**Forbidden** (audit will reject):
- emoji prefixes on subject lines
- "10,000 families" / "Private Network for American Ranch Beef" /
  "The HERD" / "BHC Network"
- multiple competing CTAs
- gamification (points, badges)
- fake scarcity (real cap progress on Founding 100 is fine)

`/founders` page copy was written from the same anchor set — if you
re-style it, hold the line on lowercase + first-person + single mission line.

---

End of handoff.
