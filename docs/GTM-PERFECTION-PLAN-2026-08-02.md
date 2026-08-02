# GTM Perfection Plan — 2026-08-02

**Source:** four parallel deep passes (buyer surfaces · rancher dashboard · admin
console + cut list · duplicate-implementation sweep), each scored against the
UI/UX priority rubric (Accessibility → Touch → Performance → Style → Layout →
Typography → Animation → Forms → Navigation → Data). All numbers below were read
from **live production** on 2026-08-02. Counts only — no buyer names. This repo
is public.

**Purpose:** stop auditing. This is the execution order.

---

## The one-paragraph verdict

The plumbing is genuinely good — CAN-SPAM suppression, durable tokened links,
verified-purchase reviews, GPC-correct consent, a money model that held on a
real transaction. What is broken is **the seams**: a rancher who signs up on the
majority path hits a wizard loop and cannot go live; a buyer who fills in the
map-capture form is promised an email that no cron sends; and the screen Ben
would open each morning shows him gross GMV instead of his own revenue, points
him at buyers in states he cannot serve, and hides the recruiting queue behind
an unlinked URL. **Eleven buyer-facing surfaces promise something the system
doesn't do, and nine of those promises resolve to "Ben will handle it
personally"** — which is exactly the thing he is trying to stop doing.

Nothing here needs to be built from scratch. Almost every fix is re-ranking,
re-linking, re-labeling, or deleting.

---

## Wave 0 — STOP-SHIP (do before one more rancher or one more ad dollar)

Every item is XS or S. Each one either traps a user, tells a lie, or hands Ben a
wrong number. Ordered by damage.

| # | What | Where | Size |
|---|---|---|---|
| 0.1 | **Wizard step 8↔9 infinite loop.** `setField` writes to `form`, not `rancher`; step 8 saves fulfillment to Airtable but never merges it into `rancher`, so step 9 re-reads a stale mount snapshot and bounces back to 8. Forever. No error. **Legacy is the majority signup path — those ranchers cannot reach Sign and cannot go live.** Verified end-to-end. | `app/rancher/setup/RancherSetupWizard.tsx:2691,2640` · `lib/connectStepDecision.ts:174` | XS |
| 0.2 | **Broker signup silently no-ops on any existing email.** Dedupe hits the whole Ranchers table, returns `{ok:true, duplicate:true}` and returns *before* writing `Broker Rail`, the balance note, or firing Telegram. Rancher is told they're represented; nothing was written; Ben never learns. **This is the rail we are actively recruiting on (#523).** | `app/api/partner/represent/route.ts:99-111` | S |
| 0.3 | **Every dashboard path to Stripe is popup-blocked on mobile.** Five `window.open()` calls fire *after* an `await`, outside the user-gesture stack — iOS Safari and Android Chrome block them silently. Button says "Opening…", then nothing. The wizard uses `window.location.href` and works. **This is a concrete mechanism for "half of Connect starters never finish."** | `ProgressRibbon.tsx:76,100` · `app/rancher/page.tsx:7790,7816,7840` | XS |
| 0.4 | **Map waitlist capture promises three things and delivers zero** — "we'll email you the moment a rancher near {state} comes online", "we're prioritizing scouting your area", "one email when your area opens up". The route's own comment says no emails/telegram/matching/crons will process these, and it writes Status blank so crons skip it. **No cron anywhere watches for state coverage.** Worse: on an Airtable write failure it returns `{ok:true, captured:false}` and the UI still renders "you're on the list" — silent data loss behind a success screen. **This is the 2,069-stranded-buyer pipe.** | `UncoveredStateCapture.tsx:63-68` → `app/api/waitlist/route.ts:11,106,118` | M |
| 0.5 | **Next Best Action has zero supply awareness.** Ranks purely on lead score; `state` is display-only. Live right now: 3 of the top 5 priority-1 "call this buyer" items are in states with **no operational rancher**. The one feature built to answer "what's my highest-value action today" routes Ben to buyers he cannot fulfill. Its action text also still says "send invoice on close" (dead money model). | `lib/nextBestAction.ts` | S |
| 0.6 | **`bg-opacity-*` was removed in Tailwind v4** (we're on `^4`), so it's a no-op. The inquiry-modal error renders dark red on identical dark red — **1:1 contrast, completely invisible** — and the modal backdrop is fully opaque black instead of a scrim. | `app/components/InquiryModal.tsx:71,83,165` | XS |
| 0.7 | **The final-invoice email — the highest-stakes money email — says "reply goes straight to the rancher." It doesn't.** No `replyTo`, no `_replyContext`, so it defaults to `inbox@replies`. Buyer's cut/pickup/timing questions land in Ben's inbox believing they went to the ranch. | `lib/email.ts:5644` | XS |
| 0.8 | **Deposit success page says the rancher was told "by email and text."** SMS is `ENABLE_SMS`, default OFF, no provider configured. The Telegram to Ben repeats the same lie. | `app/checkout/[refId]/success/page.tsx:278` · `deposit-accept-sla:154` | XS |
| 0.9 | **Three money numbers on the admin dashboard are wrong.** (a) `bhcRevenueAllRails` = deprecated-invoice commission + Connect fee and **omits product margin** — reads $3,556 where the live-model number is ~$498. (b) `depositsOutstanding` only sums Payments with `Status='pending'`; live there are 0 pending, 4 abandoned — so it reads **$0 owed** while real uncollected money sits there. (c) `matched/qualified` renders a **196% conversion rate**. | `app/api/admin/command-center/route.ts:165,144,246` | XS ×3 |
| 0.10 | **`demand-router` Telegrams an hourly report unconditionally** — the code comment literally says "always" — while its own live note reads `no-op: kill-switch off`. **24 messages a day announcing that a dark rail did nothing. 44% of all Telegram traffic, from one cron.** | `app/api/cron/demand-router/route.ts:1283` | XS |
| 0.11 | **11 test files silently never run.** The `package.json` glob is `lib/**/*.test.ts`; five `.mjs` files and six under `app/` never execute — **including the entire `lib/deal/__tests__/` state-machine trio, a money-path invariant with zero enforcement.** CI passes because CI runs `npm test`. | `package.json` | XS |
| 0.12 | **Global 16px input rule.** 79 of 159 buyer/rancher form controls are under 16px with no CSS backstop — every one zooms iOS in and never zooms back, **including the email field immediately above the Stripe PaymentElement on the live product rail.** One global rule fixes all of them. | `app/globals.css` | XS |
| 0.13 | **"Request Go Live" is a lie in the rancher's favour.** The endpoint can self-publish; the button, the success toast, and the helper text all train the rancher to sit and wait for Ben on an action they already completed. | `app/rancher/page.tsx` (go-live block) | XS |
| 0.14 | **`route-state-to-rancher` is a loaded gun.** A cookie-authed endpoint with no UI, no caller, and no test that **bulk-routes every stuck consumer in a state to one rancher and sends intro emails to all of them.** | `app/api/admin/route-state-to-rancher` · `lib/bulkRoute.ts` | XS (delete) |
| 0.15 | **The rancher call script still teaches the dead money model.** `RANCHER_ONBOARDING_CALLS_GUIDE.md` is README-indexed, untouched since 2026-02-08, and tells Ben to say the rancher "keeps 90%" and gets "invoiced monthly." `MANYCHAT_AI_STEP_PROMPTS.md:224` is an **LLM system prompt** that would repeat it to live prospects. | docs + ManyChat prompt | XS |

**Wave 0 total: ~2 days.** Nine of the fifteen are one-to-ten-line changes.

---

## Wave 1 — make the money legible, build one cockpit (this week)

### 1A. Money the rancher can read

| # | What | Where |
|---|---|---|
| 1.1 | **Connect ranchers see "Commission $0."** The fee is correctly stamped to `BHC Fee Cents`; the dashboard projects only the legacy `commission_due`, so the Earnings card sums zeros under the sub-copy "buyers paid this on top." Correct backend, unmigrated frontend read. | `app/api/rancher/dashboard/route.ts:170` |
| 1.2 | **The rancher is never shown what the buyer's card is actually charged.** `chargedCents = deposit + fee` is computed and emailed to the buyer but not returned. Rancher says "$500 deposit"; the card is hit for ~$800; the buyer calls the rancher; the rancher calls Ben. | `request-deposit/route.ts:257` |
| 1.3 | One `formatUSD()` + `tabular-nums text-right`. Six precisions across the product, zero tabular figures anywhere in rancher surfaces, money columns left-aligned, raw floats to screen (`$2,999.5`). | rancher surfaces |
| 1.4 | `overflow-x-auto` on the payouts table — the single most important money table horizontally overflows a 375px phone. | rancher billing |
| 1.5 | "Your Net" ignores the Stripe fee the rancher eats on the final balance (~$79 on a $2,999 half). Add a persistent "how our fee works" block. | rancher money page |
| 1.6 | **The weight table contradicts itself between emails** — Quarter ≈ 90 / Half ≈ 180 / Whole ≈ 360 in one, ~85 / ~170 / ~340 in another. One exported constant. Same for time-to-match, which is stated as 90s / 60s / 30s / "about a minute" across four surfaces. | `lib/email.ts` |

### 1B. One cockpit — five bands, phone-first

Ben's answer on the two competing admin surfaces: **he doesn't use either.** So
neither gets preserved; one screen gets built from what he actually needs, and
both old surfaces get archived once their two rankers are migrated.

**BAND 1 — MONEY.** `Earned today` · `Earned MTD` · `Owed to me` · `Stuck`.
Sourced from `Payments['Platform Fee Cents']` plus `Rancher Orders['BHC Margin']`.
"Owed" = Awaiting-Payment referrals + abandoned Payments. **This band does not
exist today in any form** — the daily screen shows only gross GMV.

**BAND 2 — WHAT BROKE.** One line, green or red: the four health probes
(stripe · resend · redis · secrets) + 24h cron failures + the dead-man. Exists
only as a Telegram message today; put it on the screen.

**BAND 3 — DIAL LIST.** One merged ranked list, max 10, `tel:`/`sms:` on every
row. Merge `rankDialQueue` (25 buyers live) with `rankStuckRancherQueue`
(61 ranchers live, 58 with phones — the recruiting-phase work order that
currently renders on an unlinked page). **Supply-gate it:** a buyer in an
uncovered state is not a dial, it's a recruiting signal.

**BAND 4 — THE ONE MOVE.** A single generated sentence from the supply×demand
cross Ben already computes but never reads. Today it would say: *"FL has 40
qualified buyers and no rancher — 1 signed rancher there ≈ +$162/mo recurring."*

**BAND 5 — SUPPLY.** `Payable ranchers` (the real 6-gate count — **9**, not the
12 the desk currently shows) · `Signed but stuck` · `In onboarding`.

Everything else — today's calls, Cal bookings, quiz-complete, invoice-unpaid,
slot-locked, wholesale, closed-today, waitlist, funnel — collapses behind "More."
None of them is a first-30-seconds question.

**Supporting changes:** login lands here instead of the 2.1 MB `/admin`
(`/api/admin/consumers` returns **1.9 MB / 2,731 rows** to render ~25);
`?next=` is minted by every guard and honored by none, so expired-session
Telegram deep-links lose their destination; **one canonical
`isRancherOperationalForBuyers`** — today `/admin/health` uses a 2-gate local
copy and reports 17 covered states including CA, while `/admin` uses the 6-gate
canon and reports CA as uncovered with 93 qualified buyers. Ben gets opposite
answers to "do I have supply in CA?" depending on which page he opens, and the
more prominent one is the optimistic wrong one.

### 1C. Alert hygiene — 55 msgs/day → ~14

~55% of current Telegram traffic requires no action.

1. `demand-router` unconditional hourly report — **24/day** (Wave 0.10)
2. Zero-work "sent 0" reports: `commission-invoices`, `batch-approve`,
   `compliance-reminders`, `referral-stale-expiry` — **4–5/day**, one `if (n>0)`
3. Merge `daily-digest` into `daily-health-digest` — they fire 65 min apart and
   report the same funnel with **different filters**, so the two messages show
   conflicting numbers for the same-sounding metric — **2/day**
4. Dry-run reports for env-dark rails (`waiting-activation` pool 2,017,
   `loss-recovery` pool 1,401, nurture, replenishment, product-recovery,
   product-review-ask) — **3–5/day**, log-only until the flag flips
5. ~25 admin-UI action echoes that Telegram Ben about clicks he just made
6. **`deploy-drift` is a latent bomb** — `*/30`, raw `sendTelegramMessage`, no
   dedupe key, no cooldown. One stale deploy = **48 identical alarms/day**.

**The structural fix behind all of it:** `lib/operatorSignal.ts` has proper
cross-instance dedupe and SMS/email failover, and 129 of its 133 call sites use
it correctly — but there are **401 raw `sendTelegramMessage` + 41
`sendTelegramUpdate` call sites with no dedupe of any kind**, and that is
exactly where deploy-drift, demand-router and the Cal chatter live. A bad bot
token silently swallows money alerts. **Migrating the top 20 raw senders to
`sendOperatorSignal` is the single highest-leverage structural change in this
document.** (Note: the `urgency:'digest'` tier *claims* to roll into a daily
digest — no queue and no collector exist, so those signals are discarded. Only
3 signals use it, but the comment misleads.)

---

## Wave 2 — the buyer chain closes its own loops (week 2)

| # | What | Where |
|---|---|---|
| 2.1 | **Four buyer capture points notify Ben and never the buyer.** `/support` promises "a real person will read your report and reply within a few hours" — twice — and sends one Telegram. Same for `/callback-request` and `/inquiries`. No ack email, no ticket number, no record they can return to. | auto-ack on every capture |
| 2.2 | **The cold-chain guarantee's own precondition has no mechanism.** `/promise` requires "photo within 24 hours of receipt and we settle it." **There is no photo upload on any buyer surface.** Claims arrive as email attachments Ben triages by hand. | file upload on `/support` |
| 2.3 | **A buyer pays a deposit; the rancher never taps Accept; the buyer is told nothing, ever.** The cron re-pings the rancher and Telegrams Ben. The $50 low-ticket rail already has `sendBuyerOrderDelayNotice`. The $2,000 rail is silent. | mirror onto deposit rail |
| 2.4 | **`/member` reads only the Referrals table.** A buyer who just paid on `/shop` and clicks "My Order" is told *"No active referrals yet. We're working on matching you with a rancher."* | read Rancher Orders too |
| 2.5 | **`/order/success` is a sealed cul-de-sac** — no order link, no `/member` link, no nav. The signed order page exists and the receipt email carries it; the success page doesn't. Its one primary CTA is an upsell. | add status link, demote upsell |
| 2.6 | **Day-5 collision.** `buyer-pulse` (17:05) and `referral-chasup` (18:00) both ask "did the rancher reach out?", neither reads the other's stamp, both are always-on, and **both stamp claim-before-send** — so the 3/week cap eats one and the stamp is burnt forever with nothing delivered. | cross-read stamps; stamp after `{success:true}` |
| 2.7 | **The frequency cap can no longer catch a collision.** `TRANSACTIONAL_WHITELIST` has grown to ~90 entries / ~43 buyer-facing, so the 3/week cap only bites education emails. The one cross-rail cooldown MAXes over 3 fields and omits `Ready Nudge Last Sent At` (written by the same cron), `Nurture Touched At`, `Sequence Sent At`, `Last Chased At`, `Buyer Pulse Sent At`. | one `Last Contacted At` written by every rail |
| 2.8 | **Promises the rails break.** Recovery stage 3 says "I'll stop the emails after this one" — no suppression flag is written, the buyer stays eligible for 5 rails. State waitlist promises "just one short monthly note" to a buyer eligible for nurture d2/6/12/21 + founder d7/30/60 + waiting-activation + demand-router. Nurture d21 says "the next email introduces you to them by name"; the READY chase then sends a slot nudge. Founder pitch promises "voting rights on platform direction" — a phrase that appears nowhere else in the repo. | delete or ship each |
| 2.9 | **No buyer self-serve cancel or refund exists anywhere**, while `/promise` promises "full refund, no questions" and `/faq` answers "How do I cancel?" with "email hello@". Every refund is a manual Ben action. | one-click cancel in the refundable window |
| 2.10 | **The live broker checkout has almost no trust content.** Money model #3 took the first shop order on 08-01 and its page carries no refund policy, no BHC Promise, no cold-chain guarantee, no security line — just a Terms checkbox — on raw Tailwind, none of the brand tokens. The Connect deposit page has all of it. | rebuild on brand primitives |
| 2.11 | **The "Ben personally" claim family.** Payment page: "personally certified by Ben." The canonical commerce trust line on `/shop` and every PDP: "a real person answers your receipt — ben." **The first email a buyer ever gets: "You applied and I just approved you"** — approval is a 09:00 cron. `/start`: "we verify USDA processor + farm ID." | rewrite to system truth |
| 2.12 | **Three cron-inline email templates interpolate without `esc()`**, and `referral-chasup` injects **raw LLM `${draft}` as HTML**. Every template in `lib/email.ts` escapes; these three don't. | `esc()` + sanitise |
| 2.13 | Buyer funnel loses everything on refresh (steps 1-3 are React state only) and the browser Back button exits the funnel. `/access?resume=1` says "pick up right here" and restores nothing but `?state=`. | sessionStorage + `pushState` |
| 2.14 | **No per-field validation anywhere** — every buyer form validates on submit into one banner above the button. Root cause: the shared `Input`/`Textarea`/`Select` primitives have **no `error` prop and no `autoComplete` prop at all**. Member login's one field has a label with no `htmlFor`, an input with no `id`, and no `autoComplete="email"` — no autofill on a magic-link form. | add the two props to the three primitives |
| 2.15 | **`--color-dust` #A7A29A on bone = 2.23:1**, used as body text **139× across 50 buyer files**. Do not darken the token — it is also 320 borders. Add `--color-muted` #6E6A63 (4.7:1) and sweep `text-dust`→`text-muted` on text only. Same for `text-amber` (1.49:1, the ★ rating) and `text-rust` (2.79:1, the "your order is late" warning) — both already have `-dark` variants defined. | `globals.css` + sweep |
| 2.16 | `focus:outline-none` on 60 sites with a replacement ring on 2 — it overrides the `*:focus-visible` floor `globals.css` declares. | sweep |
| 2.17 | **The only CTA at the bottom of `/ranchers` — the buyer's browse page — is "Apply to partner."** Rancher recruitment. A buyer who scrolls the list gets no "get matched" path. Cards also show a logo, not beef, and carry no "serves your area" signal despite `buyerZipServedBy` existing. | buyer CTA + coverage badge |
| 2.18 | `scroll-mt-12` (48px) against a 64px header on all four rancher-page anchors; `/founders` anchors have none at all. Consent banner is `fixed bottom-0` and **covers the Submit button** on `/apply`, `/map/add-a-rancher`, `/partner/represent`, and the wizard. | `scroll-mt-20` + banner padding |

### Rancher-side, same wave

- **Validation errors render in one banner at the top with no scroll and no
  focus** — on step 3 that's 4+ phone screens above Continue. From where the
  rancher stands, Continue did nothing.
- **Steps 1, 3 and 8 have zero autosave**, and autosave *failure* is silent.
  Close the tab on step 3 and every price, deposit, fee, weight, payment link
  and testimonial is gone. Step position is localStorage-only, so a different
  device restarts at step 0.
- **Ten hardcoded Ben touches in `activate/route.ts`** — "reply to the email and
  I'll send a fresh link", "I'll jump on a call", "I'll text you within a few
  hours" — while `/api/ranchers/resend-agreement` and
  `/api/rancher/setup/resend-link` both exist and are public.
- **Raw Stripe debug rendered on the go-live page.** A rancher who just signed
  reads `connect-probe: live Stripe status=restricted cardPaymentsActive=false
  currentlyDue=3` and a truncated raw SDK exception, on the last screen before
  their first sale.
- **Photo remove is `opacity-0 group-hover:opacity-100` in both the wizard and My
  Page** — there is no hover on a phone, so a rancher physically cannot delete a
  wrong photo. No confirm, no undo. Meanwhile the $2,500 add-on purchase
  finalizes a real Stripe invoice with **no confirm at all**.
- **The inbox returns 200-with-empty-list on any upstream failure** — a rancher
  whose buyer just replied sees a confident "no messages."
- **All 22 consequence warnings live in `title=` tooltips**, invisible on touch —
  including "buyer's deposit becomes non-refundable", "fires the commission
  invoice", and "we'll auto-reassign the buyer."
- **14 routes pass raw Stripe/Airtable exceptions straight to screen**, including
  both routes on the collect-the-balance path. Session expiry renders the bare
  word "Unauthorized" with no login link in ~20 handlers.
  **`quick-action/route.ts` returns HTTP 200 on every failure** — invisible to
  every dead-man check.

### Rancher self-service scorecard

**8 of 21 lifecycle actions require Ben. 3 more are self-serve but mislabeled as
needing him.** The ones that need Ben: recover a typo'd login email · complete
the wizard (legacy) · resolve Connect `restricted` · publish a Shopify-synced
product · refund a share deposit · see what BHC took · add a state · see their
reviews · control notifications (there is **no notification-preference UI at
all** — the only opt-out is deleting the account).

**A rancher can take a 2-star review, have it filtered off their public page,
and never be told** — so they can't fix what caused it, and Ben is the only one
who can see it.

---

## Wave 3 — polish

Shared email shell (**zero `<meta viewport>` and zero `@media` queries across all
four email modules; 46 primary CTAs are a `class="cta"` defined only in
`<head><style>`, which Gmail strips for non-Google accounts, degrading to a ~19px
underlined link; the CAN-SPAM footer is concatenated *after* `</body></html>`;
footer text is 2.25:1**) · **two email design systems** (share rail: system font,
600px, full doctype, Title-Case; shop rail: Georgia serif, 560px, bare `<div>`
with no doctype — buy a box and a share and you see two companies) · header and
footer IA (19 equal-weight footer pills, 3 of 6 primary nav slots non-buyer, **no
phone number and no street address anywhere on the site** while every email
carries a full one) · intro email's 5–7 competing CTAs and the three emails with
**zero** links · tab state in the URL (browser Back does nothing, refresh always
dumps you on Home, no tab is bookmarkable) · surface reviews including low-rated
· notification preferences · homepage H1 hydration swap (the LCP element swaps
text after hydration) · PromoBar CLS (page shifts ~42px after hydration on six
routes) · the ~35 remaining P2 touch/typography items · sticky pay block missing
`env(safe-area-inset-bottom)` — the pay button sits under the iPhone home
indicator.

---

## The cut list

### 🟢 SAFE-DELETE — ~1,015 LOC + 3 columns

`lib/aiSearch.ts` (zero importers) · `/api/admin/brands` + `[id]` (zero callers,
no page — the *brand* feature is live via `/brand-partners`, keep that) ·
`/marketplace` (pure redirect) · **News** (`app/news/**`, `/api/news/**` — table
read by 4 files, written by none, hand-entered, **live row count: 1**) ·
`Deal Events.Event` column (**verified blank on all 64 rows, zero readers**) ·
`Payments.Type` column (**verified absent from all 6 rows**) ·
`ON_PLATFORM_MESSAGING_ENABLED` (zero code readers — see correction ① below) ·
5 phantom env vars documented with zero readers (`EMAIL_FROM`,
`BACKFILL_LINK_EXPIRY_DAYS`, `NEXT_PUBLIC_CALENDLY_DISCOVERY_LINK`,
`NEXT_PUBLIC_RANCHER_ONBOARDING_VIDEO_ID`, `ADMIN_EMAILS`) · the `?email=`
unsubscribe shim (its own comment says "kept for 30d"; that ended 2026-07-26) ·
`sendRepeatPurchaseEmail` (zero callers, explicitly retired in a comment, never
deleted) · `sendSlotLockedConfirmation` + `sendBuyerSignupConfirmation` (zero
callers) · `Checkbox.tsx` (correctly built, used by nothing — all five consent
checkboxes hand-roll their own markup) · `_skipFooter` (declared, never set) ·
dead import at `webhooks/stripe:11` · **`/start`** (572 lines — a second,
unmaintained homepage with 4-audience self-select, its own geo hero, its own
USDA claims, and contradictory IA; unlinked from site chrome) · `/demo` gated to
404 in prod · **two dead admin surfaces** once their two rankers migrate into the
cockpit (Ben confirmed he uses neither) · **rancher Network Benefits tab**
(ships a permanent "check back soon") · **rancher Marketing tab** (read-only, no
action ever) · `/rancher/shipping-guide` (no inbound link; says "tell us from
your dashboard" with no href).

### 🟡 ARCHIVE-FIRST — ~1,782 LOC (money / consent / legal)

**Land Deals** (0 rows, no in-site links — but `/api/land/[id]/inquire` captures
buyer contact and writes Inquiries, a consent surface) · **`zip-gather`** (the
only cron dir not in `vercel.json` — but it mints 30-day JWTs and sends cold
email/SMS, and deleting breaks a CI test) · **`lib/whiteGlove.ts`** (zero
importers, nothing can mint the session — **but the Stripe webhook still branches
on that metadata**; archive lib + webhook branch together) ·
**`route-state-to-rancher` + `lib/bulkRoute.ts`** (Wave 0.14 — this is a risk,
not dead weight) · **`docs/superpowers/` (30 files), `docs/audits/` (6),
`docs/playbook/` (2)** — ~24k lines of executed plans whose headers read
*"REQUIRED SUB-SKILL: execute this plan"*; a future session can mistake them for
live orders. Move to `docs/archive/`.

**Legal — Ben's call, do not touch:** `app/rancher/sign-agreement/page.tsx`,
`/terms` §4.2, and the tracked `.docx` all still bind the rancher to *"BuyHalfCow
invoices monthly for commission"* and *"10% commission on all verified referred
sales."* The wizard's inline SignStep uses the correct `commissionCopyFor()`.
**Two surfaces POST to the same endpoint with two contradictory contracts.**

**Ring-fence, don't cut:** the legacy commission rail is deprecated as *the
model* but is still live code with a real receivable (`commissionUnpaid`
~$966.91).

### 🔵 KEEP-BUT-FIX — three audit premises were wrong

① **Threads / on-platform messaging is LIVE — only the flag is dead.**
`ON_PLATFORM_MESSAGING_ENABLED="false"` has zero code readers while threads are
wired into 7 live surfaces. 3 threads / 6 messages = low usage, not disabled.
`docs/BHC-PLATFORM-MAP.md:287` ("Threads off") is **false**. Delete the flag,
fix the doc, keep the 816 LOC.

② **`Products.Orders Left` blank means "unlimited", by design** — not a broken
guard. The real risk stands: a rancher with 4 half-cows who leaves it blank can
be oversold without limit. Force an explicit stock choice in the rancher UI.

③ **`Signup Attempts` at 0 rows is a FAILURE beacon working correctly** — zero
rows means no rancher signup has failed since 2026-07-24. It is read by
`daily-health-digest`. Keep it; fire one synthetic failure to prove it.

Also: `capacity-liberator` was already deleted in #506 but four docs still cite
it as live. **Wholesale has only 4 rows but is in the Header nav and
`/admin/inquiries` works it daily — do not cut.** `app/rancher/cal/` +
4 API routes have existed since June 22 and render nowhere (`/rancher/cal` is a
404) — wire it up or delete it, don't maintain a 404.

### Duplicate implementations to collapse

Money-tile math mirrored across 5 endpoints (comments literally say they
"mirror" the canonical one) · two work-queue ranker sets · two
funnel-conversion endpoints · ZIP normalization canon + ~9 inline copies ·
product checkout mid-migration (`/buy` hosted vs `/intent` Payment Element) ·
`scripts/_lib/safeSend.mjs` — **a complete second CAN-SPAM/suppression stack
with zero callers, untracked** · dark reservation-hold · `lib/closeQueue.ts`
`estimateBhcFee` duplicates `calcCommissionForRancher` with a hardcoded flat
rate that overstates the fee for Operator-tier (0%) ranchers.

### Cron triage — 41 of 61 did zero work in 24h

- **~15 are intentional zeros** (watchdogs, reapers, canaries, drift checks).
  Finding nothing *is* success — they should just stop announcing it.
- **~12 are genuinely dark and burning ~50 invocations/day**: `demand-router`
  (kill-switch off), `setup-link-undelivered` (env-disabled), `synthetic-e2e`
  (**paused — the signup-flow canary is off with no replacement probe**),
  `loss-recovery` (dry, pool 1,401), `waiting-activation` (dry, pool 2,017 —
  **arguably the largest un-pulled lever in the business**), `shopify-catalog-sync`
  (4×/day, no sync-mode ranchers), three product crons with pool=0,
  `backer-monthly-letter`, `zip-gather` (unscheduled). **Each should be turned
  on or turned off — not left half-running and reporting.**
- **20 are healthy.**

### Docs debt

**9 docs + 2 code surfaces still teach the deprecated money model** (worst:
the call script and the ManyChat LLM prompt — Wave 0.15).
`docs/EMAIL-QA-FINDINGS.md`'s entire P0 table is unactionable — every script it
cites doesn't exist; **20 of 23 `scripts/*.mjs` paths referenced across docs are
missing, and `scripts/` is gitignored, so no clone ever had them.**
**PII: `docs/MONEY-TRUTH-INVARIANTS.md` contains a buyer first name** — in
addition to the known pre-existing leak in the July handoff. This repo is public.

---

## Ben's manual list (nothing here can be done from code)

1. Add `Cancelled` to the `Rancher Orders → Status` select (API can't create it).
2. Flip `WAITING_ACTIVATION_ENABLED` (2,017 buyers), `LOSS_RECOVERY_ENABLED`
   (1,401), `DEAL_RELEASE_ENABLED` (frees 12 frozen buyers).
3. Add one row to the empty `Admin Config` table.
4. Set `Orders Left` per product, or accept the oversell risk knowingly.
5. SMS provider signup — **Telnyx or Plivo toll-free, not Twilio.**
6. Legal: rewrite `/terms` §4.2, the sign-agreement page, and the `.docx` to the
   current money model. **This is the only genuinely blocking legal item.**
7. Decide `BUYER_AUTORESPOND` (live by default).
8. Confirm the "first 4 closed deals are 100% yours, then a paid retainer"
   promise in `/api/rancher/activate` is a dead rail — it reads as a **fourth**
   money model.

---

## The target

**A 15-minute operating day.** Open one screen: what I earned, what broke, who
to call, the one move, how much supply I have. Everything else collapses.

The data for every band already exists and is already computed. Ben is about two
days of Wave 0 plus one week of Wave 1 away from it — the gap is not capability,
it's that the screen he'd use has the wrong money on it, points at buyers he
can't serve, and hides the recruiting queue.

**Then, and only then: content, sales, ads.**
