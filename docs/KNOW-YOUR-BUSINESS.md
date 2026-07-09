# BuyHalfCow — Know Your Business (the study bible)

*Every detail, current as of 2026-07-09 (post-pivot). Read it until you can
answer any question cold. Numbers marked [LIVE] change — re-pull before
quoting on a call (endpoints listed in §14).*

---

## 1. What the business IS (say it three ways)

- **One sentence:** BuyHalfCow aggregates families who want real beef and
  routes them to verified ranchers near them until each rancher's capacity is
  sold out.
- **The wedge:** every other rancher tool sells *software*. BHC sells
  *demand* — we bring the buyer. "They sell you a cash register. We show up
  with the line of customers."
- **The mechanism:** content + our 40k following pull buyers → a quiz
  qualifies them → we match them to the nearest verified ranch → they put a
  refundable deposit down → the rancher raises/cuts/hands over the beef →
  money lands in the rancher's own Stripe account, we take a cut.

**You are a demand-aggregation marketplace with a payments + storefront layer
bolted on.** You replaced two vendors for the rancher: their marketer and
their checkout.

---

## 2. The three revenue ladders (how you make money)

| ladder | ticket | how you earn | who it's for |
|---|---|---|---|
| **Shares** (whole/half/quarter cow) | $1,000–$2,500 | commission on the deposit, tier-based (10/7/3/0%) | the core — freezer-filling families |
| **Products** (jerky, boxes, ground) | $13–$355 | marketplace margin (display − rancher base) | cold browse / impulse / gateway |
| **Operator tier** (rancher SaaS) | $500/mo flat | subscription; 0% commission; you close for them | ranchers who want it fully done |

**Blended platform take ≈ 8–12% of GMV + flat Operator revenue,** at near-zero
marginal cost (Vercel + Airtable + Stripe). A $100k GMV month ≈ ~$10k to you.

---

## 3. Money mechanics — EXACTLY how a dollar flows

**Shares (deposit rail, tier_v2):**
1. Buyer pays a deposit through the rancher's page — a **Stripe Connect
   direct charge on the rancher's account**.
2. Commission is calculated on the **full sale price** (not the deposit) at
   the rancher's tier rate, and collected **up front** as the Stripe
   `application_fee_amount` → lands in the BHC platform account.
3. The rancher receives the deposit into **their own Stripe account** and
   collects the balance at fulfillment, outside BHC.
4. **Net-your-number (live):** BHC shrinks its application fee by the
   estimated Stripe processing (~2.9% + 30¢), so the rancher nets their
   promised number. Stripe's fee comes out of BHC's cut, not theirs.
   - Sayable: *"card processing is on us — the number you set is the number
     you get."* NEVER say "no Stripe fees" (Stripe is paid, by us). NOT true
     for Operator *deposits* (0% commission = nothing to absorb from).

**Products:** buyer pays `display + shipping` in one charge → lands on the
rancher's Connect account → BHC application fee = `(display − rancher base) ×
qty`, shrunk by processing absorption. **Shipping is never skimmed** — the
rancher keeps 100% of the shipping they set (we even eat the card fee on it).

**Who pays Stripe:** on any Connect direct charge, Stripe's fee comes from the
rancher's balance — which is why absorption exists (it moves that cost onto
BHC's fee). On charges where **BHC is the merchant** (Operator $500/mo,
Founders tiers, brand partners), BHC pays processing directly.

**Worked example — $2,500 half cow, $750 deposit, Legacy Connect 10%:**
- Buyer pays deposit + commission on the card.
- BHC gross commission = 10% of $2,500 = **$250**, minus absorbed processing
  (~$29) → **~$221 to BHC**.
- Rancher gets the full $750 deposit + collects the $1,750 balance directly.

---

## 4. The tier system (what each rancher pays)

| tier | commission | model |
|---|---|---|
| **Legacy Connect** | 10% | pay-per-close, on the deposit |
| **Pasture** | 7% | lower rate |
| **Ranch** | 3% | lowest commission tier |
| **Operator** | 0% + **$500/mo** | "we close, you ship" — Ben runs the sales calls |

Free to start on any commission tier — you pay nothing until a deposit
happens. The **locked Commission Rate** on the rancher's record always wins
over the tier default (so a close honors what they signed).

---

## 5. Capacity rule — THE correction (cap on SALES, not leads)

A rancher's `Max Active Referrals` = **how many head they have to sell.** They
keep receiving qualified buyers until they've **closed** that many sales —
NOT until that many leads sit in their pipeline.

- Cap = count of **Closed Won**. Held/in-flight leads are pipeline depth (a
  load-balance tiebreak), never the cap.
- "The limit is how many closed sales are happening, not how many leads they
  get." Flood them with qualified buyers; they close what they can.
- Dead intros auto-expire (21-day silence → freed) so pipeline never clogs.

---

## 6. Qualification rule — THE other correction (funnel = qualified)

**Completing the funnel/quiz IS qualification.** There is no hidden score
gate anymore.

- Route anyone who finishes the funnel to their in-state rancher.
- Hold ONLY explicit non-buyers: **"Not Sure" tier** (hasn't picked a share
  size) or **"Just exploring" timing**. Those stay in nurture.
- The old 75-score threshold is dead — it was a scarce-leads relic, and leads
  are free now that capacity counts sales.
- Quiz-required stays true: you route on funnel completion, never on a raw
  Intent Score alone.

---

## 7. The buyer journey (end to end)

1. **Discover** — a reel, the map, /shop, search, a friend's link.
2. **Land** — /access (the quiz funnel) or /shop (products).
3. **Qualify** — 4-question quiz: tier (quarter/half/whole), timing, freezer
   storage, commitment. Completing it stamps `Qualified At`.
4. **Match** — the matcher fires in real time (on quiz completion) → finds
   the nearest operational rancher with capacity → creates a referral +
   fires the rancher an intro. If no in-state supply → waitlisted + nurtured.
5. **Deposit** — buyer reserves a share with a **fully refundable** deposit
   (refundable until the rancher accepts the slot).
6. **Fulfill** — rancher raises/cuts, collects the balance, hands over the
   beef; buyer gets asked for a review.

Products path: /shop → PDP → brand checkout (Card / Pay by bank / Cash App /
Klarna) → rancher ships frozen → tracking auto-notifies the buyer.

---

## 8. The rancher journey (end to end)

1. **Apply** — /sell → /apply (4 fields, ~90 sec) → instant, a URL slug is
   minted, wizard link appears.
2. **Set up** — 5-minute wizard: pick tier → connect bank (Stripe Connect) →
   set prices → sign agreement → go live.
3. **Go live** — public ranch page + listed on the map + the shop; they get
   an email/push that they're live.
4. **Receive leads** — qualified in-state buyers routed to them, deposit
   already down; push notification per lead.
5. **Close** — they (or Ben, on Operator) close the sale; commission is
   already collected on the deposit, or invoiced monthly for legacy closes.
6. **Get paid** — money's in their own Stripe account the whole time; they
   keep their brand, prices, and customer list.

Chase rails catch stalls at every step (never-signed, stuck-at-Connect,
live-but-no-bank) so nobody rots silently.

---

## 9. The routing engine

- **Local-first:** nationwide routing is OFF by strategy. A buyer routes to a
  rancher whose home state matches (or an admin-approved multi-state).
- **Food-miles:** among eligible ranchers, sort prefers fewer shipping miles
  (state adjacency, ≤2 hops) so beef travels less.
- **Operational gate** (`isRancherOperationalForBuyers`): Active + Agreement
  Signed + Onboarding Live + subscription not past-due + (tier_v2 → Connect
  active). One source of truth shared by signup, matcher, and warmup.
- **Fires from:** real-time on quiz completion; batch-approve (09:00 UTC
  daily); stuck-buyer-recovery (14:30 UTC daily).

---

## 10. The tech stack (what runs it)

- **Next.js 16 App Router on Vercel** — the whole app + API + crons.
- **Airtable** (base appgLT4z009iwAfhs) — the system of record: Ranchers,
  Consumers (buyers), Referrals (the deal ledger), Rancher Products, Cron
  Runs, Conversations. ~5 requests/sec ceiling = the real scale limit.
- **Stripe Connect** (V2 accounts, direct charges) — payments + payouts +
  the rancher's own dashboard.
- **Upstash Redis** — shared cache + capacity counters (fail-open).
- **Resend** — all email (transactional + nurture); inbound webhook →
  Conversations.
- **Telegram** — your ops cockpit (every cron reports here).
- **The prospects dashboard** (separate repo/deploy) — the outreach engine.

---

## 11. The automated machine (what fires without you)

Five closed loops, all live:
1. **Capture** — quiz qualifies buyers by state.
2. **Route** — batch-approve 09:00 + recovery 14:30 connect qualified buyers.
3. **Slot hygiene** — stale-hold expiry 13:10 frees dead intros; drift-check
   every 6h keeps counters honest.
4. **Money** — deposit → accept → settle; product settlement; commission
   invoices 1st of month.
5. **Retain** — nurture drip (waitlist), replenishment (reorders), review
   asks, product recovery, rancher reactivation.

Watchdogs scream on Telegram if any expected cron misses 24h. Kill switches:
`MATCHING_ENABLED=false` halts routing; `MAINTENANCE_MODE=true` pauses the
platform.

---

## 12. The numbers (know these; re-pull before quoting) [LIVE]

- **Members / following:** ~2,346 members · ~40k social following.
- **Waitlist:** ~1,981 qualified buyers. Top states: **TX ~253 · CA ~202 · CO
  ~86** (also FL, AZ, GA demand).
- **Ranchers:** ~12 Active; **~8 operational** (can take a lead); handful
  Connect-active (can take money) — this is the constraint.
- **Proof:** first settled deposit **$750 (2026-07-04)**. ~18 closed-won
  deals historically.

---

## 13. Competitive positioning (facts you can say)

Nobody in the rancher-tools market sells demand:
- **Barn2Door** — $99–299/mo + $399–599 setup + ~6%/txn; their own FAQ:
  "teach farmers how to fish." Demand is the rancher's problem.
- **GrazeCart** — store software, zero marketing. "A cash register that puts
  nobody in line."
- **Local Line** — wholesale directory, no consumer demand.
- **ChopLocal** — Etsy-for-jerky; small boxes, no shares, no local routing.
- **Crowd Cow** — 22%, owns the customer, ships unsold product back after 90
  days. The scar every burned rancher remembers.
- **Doing it yourself** — 60–70 hr weeks, DMs, no-shows, chasing checks.

**Your open lane:** "qualified local buyer, deposit down, into your own Stripe
account" has no occupant. The moat is real until someone copies it — which is
why supply speed matters NOW.

---

## 14. The one constraint + the strategy

- **The whole game is supply** — Connect-active ranchers in demand states.
  Demand is banked; every activated rancher unlocks their state's waitlist.
- **Concentrate one state** (Texas). Don't blast the whole waitlist.
- **The multiplier:** one rancher in TX doesn't add a customer — it unlocks
  253. That's the only multiplication in the business, and it needs YOU (a
  human) — ranchers say yes to a person, not an email.
- **You sell ranchers; the machine sells beef.**

Live stat endpoints: `/api/stats/public` (network), `/api/stats/buyers-by-
state?state=XX` (per state).

---

## 15. Objections + answers (memorize for calls)

- *"Marketplaces steal customers."* → "The buyer pays into YOUR Stripe and
  lands on YOUR page. I physically can't own your customer."
- *"I've paid for leads that never close."* → "You don't pay for leads. Free
  tiers cost a cut of a deposit that already happened. No deposit, no cost."
- *"I don't do tech."* → "If you can text, you're overqualified. Five-minute
  setup, and Operator means I do the selling."
- *"What's the catch on free?"* → "I only make money when you do. That's the
  whole design."
- *"How do I know the buyers are real?"* → "Every one finished a quiz and put
  money down before you spend a minute on them."

---

## 16. Metrics that matter (watch weekly)

1. **Connect-active ranchers in demand states** — the scoreboard. Nothing
   else moves the needle like this.
2. **Deposits settled** (count + $) — money proof.
3. **Waitlist-to-routed conversion** by state — is supply keeping up.
4. **Blended take rate** (platform $ ÷ GMV) — should sit 8–12%.
5. **Processing P&L** — absorption budgeted at ~2.9% vs actual Stripe cost.
6. **Rancher activation funnel** — apply → signed → Connect-active drop-off.

---

## 17. Live vs parked vs your job

- **LIVE:** the whole platform — routing, money rail, net-your-number
  absorption, brand checkout, PWA push, nurture (dry-run), stale-expiry,
  farmers-market shop, chase rails.
- **Armed dry-run (you flip after reading one report):** waiting-activation,
  nurture, prospector sends.
- **Parked, ready on a word:** payment plans (BNPL + layaway), dunning cron,
  close-queue, nationwide routing.
- **Your job (only humans can):** the twelve rancher calls, one test buy,
  content, the outreach domain + inbox, Meta env values.

Companion docs: OPERATING-MANUAL.md (daily ops) · RANCHER-PITCH.md (the pitch)
· BHC.md (brand voice) · CONTENT-ENGINE.md (content) · GO-LIVE-SETUP.md
(setup values) · PAYMENT-PLANS-BACKUP-BUILD.md (parked fintech).
