# RECRUITING MACHINE — the supply pivot (2026-07-28)

*The perfection push (#492–#509) closed: money path live-proven, comms
truth-aligned, DB clean, campaign machine repeatable. Code stopped being the
constraint. This doc is the single source of truth for the next phase:
**recruiting payable ranchers.** North star: payable ranchers (Active + can
take money). Each ≈ +$162/mo and unlocks a state's buyer backlog.*

**Voice rules for every touchpoint in this doc:** docs/BHC.md is canon.
Never "guaranteed leads." Never negotiate the rate. Non-exclusive, always.
Ben writes as "I". Buyer references: first initial + state only. No hyphens
in outbound copy (Ben's rule).

---

## 1. The funnel, coldest to warmest

| Rail | Who | Count | State | Where |
|---|---|---|---|---|
| Cold email | Scraped prospects | ~1,076 | **DARK** — engine built, sends gated | Rancher Prospects Airtable (`tbljw0vdfMpyQ6Nk5`) + bhc-prospects.vercel.app dashboard |
| Warm chase | Signed up, stalled pre-wizard | 26 tracked | LIVE — daily chase email + Telegram | rancher-followup cron |
| Stuck queue | Escalated, never worked | 55 callable (52 have phones) | LIVE | `/admin/today` cockpit queue (#489), demand×proximity scored |
| Nearest-to-live | Connect started or priced, one step out | Rep Provisions (Connect=onboarding, no price) · Luke Yearout (no Connect/slug/price) | LIVE | go-live-sync flags |
| Self-serve doors | Inbound | — | LIVE + honest (#505) | /sell · /apply (90s) · /partner · /map/add-a-rancher (+ fan flag) |

The wizard behind every door: ~10 minutes, prices → Stripe bank connection →
one e-signature, free plan auto-selects, all comms verified live and truthful.

## 2. What Ben must flip before COLD sends (in order)

1. **Buy 3–5 cold domains** — trybuyhalfcow.com / gethalfcow.com pattern,
   .com only. Cold email NEVER rides buyhalfcow.com.
2. Verify them in Resend, warm up (ramp 5→10→20→30/day per inbox over ~3wk —
   `lib/inboxRotation.js` handles pacing once `OUTREACH_INBOXES` roster set).
3. Set `OUTREACH_FROM`, `OUTREACH_INBOXES`, `OUTREACH_RESEND_KEY` (isolated
   cold account), then `PROSPECT_OUTREACH_ENABLED`.
4. Engine drafts daily at dry-run; **every send stays approval-gated
   regardless.** `OUTREACH_DAILY_CAP` is the hard ceiling.

Warm rails need zero flips — they're live today. **Start with the phone list
and the 55 stuck queue while domains warm.**

## 3. Cold sequence — 4 touches, book a call

Goal: a reply or a booked 15-minute call. One CTA per email. Subjects
lowercase, 2–4 words, no punctuation tricks. Merge fields: `{first}`,
`{ranch}`, `{state}`, `{waiting_count}` (pull live:
`/api/stats/buyers-by-state?state=XX` — never invent the number).

### T1 · day 0 — subject: `buyers in {state}`

> {first} — found {ranch} while mapping ranches that sell direct in {state}.
>
> I run BuyHalfCow. We hold a waitlist of families who already said they want
> a quarter, half, or whole from a local ranch — {waiting_count} of them in
> {state} right now. The hard half of selling direct is finding those people.
> That's the half we do.
>
> When one matches you: we send the intro, run the checkout, and the money
> lands in your own account. You keep 100% of your price. Our fee is added
> to the buyer on top. Non exclusive, sell anywhere else you want, leave any
> time.
>
> Worth a look?
>
> — Ben

### T2 · day 3 — subject: `real deposits`

> {first} — quick follow up. This isn't a directory. Families put down real
> deposits through us this month; one buyer paid $2,249 for a half within
> minutes of getting her link. The ranch kept every dollar of its price.
>
> If {ranch} has capacity for even a few shares this season, the {state}
> waitlist is sitting there.
>
> 15 minutes this week? Grab a slot: {cal_link}
>
> — Ben

### T3 · day 7 — subject: `no call needed`

> {first} — last practical note. You don't actually need the call. Setup is
> self serve, about 10 minutes: your prices, a short Stripe bank connection
> so deposits land in your own account, one e signature. Your page goes live
> and buyers in {state} can route to you.
>
> Start here: {apply_link}
>
> Or reply with a question. I read every one.
>
> — Ben

### T4 · day 14 — subject: `closing the loop`

> {first} — I'll stop here. If direct buyers aren't a fit this season, no
> hard feelings.
>
> One zero commitment option: I can put {ranch} on the public map as a pin
> so families searching {state} find you either way. Reply "map me" and it's
> done.
>
> Good luck with the season either way.
>
> — Ben

**Stop-loss (same as buyer campaigns):** complaints <0.3%, hard bounces <5%,
sunset any address after 2 no-open touches. Suppression honored globally.

## 4. Warm re-engage — the 55 stuck (one touch, then phone)

Nine of the top ten need one sentence. Email (or text) before the call:

> {first} — {ranch} is one click from live on BuyHalfCow. The only thing
> left is the e signature. Here's your link: {setup_link}
>
> {waiting_count} families in {state} are on the waitlist. Want me to walk
> you through the last step on a 5 minute call instead? — Ben

Phone scripts: docs/RANCHER-CALL-SCRIPTS.md (lead with Operator tier on
qualified calls). Work order: `/admin/today` queue score, top first — 5 Bar
(CA, 220 waiting) · Bear Musgrave (TX) · Rocking B (TX) · Anvil Bar (CA) ·
Crescent C (TX).

## 5. After they sign — nothing manual left

Welcome + chase + stuck rails all fire automatically and say true things
(#505). Products live → rancher notified. First lead → intro email with
one-click actions + daily lead digest (#507). The machine holds; recruiting
is the only input it's missing.

## 6. Measurement

- **North star: payable ranchers** (was 6 at pivot). Weekly count in Monday
  scorecard.
- Cold: reply rate ≥3% is working; booked calls per 100 sends.
- Warm: signatures per week from the 55; days-to-live per new rancher.
- Every send logged in Email Sends w/ delivered/opened/clicked (webhook live).
