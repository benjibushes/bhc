# Recruiting Operations — the setter manual

*The single handable doc for the person recruiting ranchers onto BuyHalfCow.
You get this doc, the prospects dashboard, and the inbox. That's the whole
kit — you can execute day one without Ben in the room.*

*Written 2026-07-15. Counts marked with a date go stale — the dashboard and
the live endpoints are always the truth. Companion sources if you ever want
the deep end: RANCHER-PITCH.md · RANCHER-CALL-SCRIPTS.md ·
KNOW-YOUR-BUSINESS.md · INBOX-MANAGER-SOP.md.*

---

## 1. The mission + the math

**What BuyHalfCow is (one breath):**

> every beef tool out there sells ranchers software and leaves them to find
> their own buyers. Ben built the opposite — a demand engine. families come
> to buyhalfcow looking for a ranch, we qualify them, take their deposit,
> and route them to the rancher until their capacity is sold out. the
> rancher raises the beef and hands it over. that's the whole deal.

If a rancher only remembers one sentence: **"they sell you a cash register.
we show up with the line of customers."**

**Why your job exists:** the platform has ~1,981 qualified buyers on the
waitlist (2026-07-08 pull) and only a handful of ranchers who can actually
take their money. Demand is banked. Supply is the only constraint. One
activated rancher in Texas doesn't add a customer — it unlocks ~253 of them.
That multiplication only happens when a human gets a rancher across the
finish line. Ranchers say yes to a person, not an email. That person is you.

**Demand states, in order (re-pull before quoting — numbers move):**

| state | waiting buyers (2026-07-08) |
|---|---|
| TX | ~253 |
| CA | ~202 |
| CO | ~86 |
| GA | ~52 |
| TN | ~51 |
| also real demand | FL · AZ · UT (~33) · OK (~30) |

Live count per state: `buyhalfcow.com/api/stats/buyers-by-state?state=XX`.
Never invent a number. If you can't pull it, say "let me check."

**Definition of DONE — memorize this:** a rancher counts as activated when
their **Stripe Connect account shows ACTIVE** — charges and payouts enabled,
money can flow. Not "interested." Not "signed." Not "page live." A signed
rancher with no Connect is a store with no cash drawer. Everything in this
manual points at that one flip.

**Your targets:**
- **10 meaningful touches a day.** A touch = a real conversation, or a
  voicemail + same-minute text. A dial that rings out is not a touch.
- **3–4 activations a week.** At ~80 ranchers in the pipeline and 29 of
  them already warm, this is aggressive but real.
- Hours and comp: [BEN: fill — working hours, comp structure, bonus per
  activation if any].

---

## 2. The ICP filter (2 minutes per prospect)

Before you spend a call on anyone, run this filter. When unsure:
**demand-starved wins.** The ranch that can't find buyers is the ranch this
whole machine was built for.

**FIT — call them:**
- Small family ranch that can't fill a steer alone — needs 4 buyers per
  animal and finds them by hand
- Standing stock — animals raised or being raised, beef to move
- Already books by deposit, word-of-mouth, Facebook posts, a waitlist
  notebook — proof they sell direct, just slowly
- Sells some product direct already (a Shopify page nobody visits, a
  farmers-market table)
- Multi-generational, name-on-the-gate operations — the brand-and-customer
  pitch lands hardest here

**ANTI-FIT — log "bad fit" and move on:**
- Sold out constantly — they have the opposite problem; we don't solve it
- Scaled operation with its own plant/processing arm — wrong shape, wrong
  economics
- Pure feedlot — not the product our buyers passed a quiz for
- Wholesale-only (restaurants, distributors) with no interest in families

**Priority geography:** a merely-decent ranch in TX, CA, CO, GA, FL, or AZ
beats a great ranch in a zero-demand state. The waitlist is the scoreboard.

---

## 3. The four lanes (work them in this order)

> **Update 2026-07-15:** Ashcraft Beef (TX) was removed from the platform — excluded from every lane below. Connect-stuck lane is now 4 (was 5). Their 36 open leads were released back to the routing pool; TX's active catcher is Lazy Bar 3.

Your queue lives in the **prospects dashboard** (bhc-prospects.vercel.app —
Ben hands you the login directly; the password is never written down).
Every prospect falls into one of four lanes.

Pipeline snapshot from the 2026-07-14 audit (~80 ranchers total — the
dashboard is current truth):

| bucket | count |
|---|---|
| applied, untouched | 12 |
| call scheduled | 2 |
| call complete | 17 |
| docs sent | 12 |
| signed, not live | 1 |
| live, no Connect | 9 |
| Connect stuck | 5 |
| ACTIVE | 6 |

### Lane 1 — warm stalled (call-complete + docs-sent: ~29 ranchers)

They've already talked to Ben or hold the agreement. They didn't say no —
they got busy. Highest volume of near-wins.

**Call-complete (17) — they heard the pitch, then drifted:**
> hey [name] — [your name], I work with Ben at BuyHalfCow. you two talked
> about routing [state] buyers to you — there are [N] families waiting in
> [state] right now [pull the live count first]. Ben asked me to get you
> the rest of the way. it's one e-sign and one payout form — about 15
> minutes total. got them now, or should I grab you tonight?

**Docs-sent (12) — agreement in their inbox, unsigned:**
> hey [name] — the agreement Ben sent is still sitting unsigned, and I've
> got [N] [state] families I can't route to you until it's in. it's a
> 2-minute e-sign on your phone. I'll stay on while you do it — then the
> payout form, and you're the ranch I send them to.

If their link is old or dead, don't apologize into the void — get a fresh
one sent while they're on the phone (see Section 5 on link expiry).

### Lane 2 — one step from money (live-no-Connect + Connect-stuck: ~14)

The highest-value calls in the building. These ranchers did everything
except connect the bank. Some already have buyers routed to them and can't
take a dollar.

**Live-no-Connect (9):**
> your page is live, you're on the map — but there's nowhere for the money
> to land yet. the payout setup is one Stripe form, about 10 minutes.
> I'll stay on the phone while you tap through it, and the moment it flips
> active I can start routing [state] families to you.

**Connect-stuck (4) — they started Stripe and stalled partway:**
> you're 90% through the payout setup — it stalled partway. takes about 5
> more minutes to finish. I'll walk it with you screen by screen right now.

Both lanes end the same way: the Stripe walk-through in Section 5, done
live on the call. Do not accept "I'll finish it tonight" without booking
the exact time you'll call back.

### Lane 3 — cold prospects

New names from the dashboard, the map's yellow pins, or your own sourcing.
Run the ICP filter first (Section 2), then the intro call:

> hey [name] — [your name] from BuyHalfCow. quick one: there are [N]
> families in [state] on our waitlist right now — already qualified,
> budget and freezer screened, asking for beef from a ranch like yours.
> every beef tool out there sells you software and leaves you to find
> buyers. we're the opposite — we show up with the buyers. it's free to
> start and you don't pay a thing until a deposit actually lands. worth
> 10 minutes this week to see it?

Goal of a cold call is NOT activation — it's the next step: a booked call
with Ben ([BEN: fill — Cal.com booking link]) or the 90-second application
at buyhalfcow.com/sell. If they're hot and willing, run the whole thing
yourself: application → agreement → Stripe, one call.

**Race lines work — use them honestly.** When two ranches sit in one state
("first ranch live gets first routing") or one just activated ("[ranch]
went live this morning — want me to hold your spot?"), say it. Real
scarcity only. Never invent a competitor.

### Lane 4 — referral asks (the 6 active ranchers)

Active ranchers are your warmest source of new supply. On any check-in or
win call:

> who's the one rancher you'd trust with this? someone who raises real
> beef and hates the marketing side. I'll mention your name when I call —
> or don't, if you'd rather.

Log every referred name as a new prospect with the referrer noted. A
referred cold call opens with "your name came from [rancher]" — it's a
different call entirely.

---

## 4. Stage-by-stage playbook

For every stage: the goal, the talk track, the disposition to log, and
when to hand off to Ben.

**Handoff to Ben — always, no exceptions:**
- Pricing negotiation, commission rates, custom terms of ANY kind. You
  never quote a discount, never confirm a special rate. "That's Ben's
  call — I'll have him ring you today."
- Anything legal-flavored (contract questions beyond "where do I sign,"
  liability, disputes).
- Anything money that's already moved (refunds, charges, payouts gone
  wrong) — same hour.
- Some ranchers have pre-existing custom terms recorded in Ops Notes
  (Internal). **Honor them, never say them out loud on a call,** and
  never renegotiate them.

### Stage: applied / untouched
- **Goal:** first contact within 24h of application. Speed is the pitch.
- **Track:** "you applied at buyhalfcow — I'm the person who makes it
  real. got 10 minutes today?"
- **Log:** reached / voicemail+text / bad number. Next action + date.

### Stage: call scheduled
- **Goal:** the call happens. Confirm morning-of by text.
- **Log:** confirmed / rescheduled / no-show (no-show → same-day text +
  new time; a no-show is a touch, not a death).

### Stage: call complete
- **Goal:** agreement signed. Use the Lane 1 script.
- **Log:** signed live / link re-sent + follow-up booked / objection
  (which one) / not interested (why).

### Stage: docs sent
- **Goal:** e-sign done on the phone with you.
- **Log:** signed / stalling (reason) / dead link → fresh link sent.

### Stage: signed, not live / live, no Connect / Connect stuck
- **Goal:** Stripe Connect ACTIVE before you hang up. Section 5 is the
  whole play.
- **Log:** ACTIVE (the win — flag it so Ben confirms routing turns on) /
  partial (which screen they stopped on — this matters for the next
  call) / refused (why).

### Stage: ACTIVE
- **Goal:** keep them warm, get the referral ask in (Lane 4), plant the
  Operator seed (below).
- **Log:** check-in date, referrals collected.

### The objection bank (their fears, the honest answers)

- **"What's the catch on free?"** → "the catch is we only make money when
  you do. no deposit, no cost, ever. that's the whole design."
- **"Who pays the fee?"** → "the buyer does — it's added on their side of
  the checkout. the number you set is the number you get."
- **"Do I lose my customers?"** → "the buyer pays into YOUR stripe account
  and lands on YOUR page with your name on it. we physically can't own
  your customer — it's not how it's built. non-exclusive, pause or leave
  whenever."
- **"What about Stripe fees?"** → "on our checkout, card processing is on
  us — the number you set is the number you get." **Never say "no Stripe
  fees"** (Stripe gets paid — by us), and never extend the claim to the
  $500/mo Operator plan's deposits.
- **"I've paid for leads that never close."** → "you don't pay for leads.
  the cost only ever comes out of a deposit that already happened."
- **"How do I know the buyers are real?"** → "every one passed a quiz —
  budget, freezer, timeline — and puts real money down before you spend a
  minute on them."
- **"I'm too busy."** → "that's exactly what the $500/mo plan is for —
  Ben takes every sales call, you just ship. but the free plan takes 10
  minutes once, and I'm on the phone with you right now."
- **"I can sell it myself."** → "then sell it yourself — and let us hand
  you the [N] families you don't have to find. worst case you walk away
  with a free store."
- **"Will my beef sit in a queue?"** → "the waitlist is buyers waiting for
  YOU, not the other way around. supply is our constraint, not demand."
- **"How do you make money?"** → "a commission that comes out of the
  buyer's deposit when a share actually sells — the rate depends on the
  plan they pick. nothing before that." Never quote a flat 10% — rates
  are tier-based (Legacy Connect 10% · Pasture 7% · Ranch 3% · Operator
  0% + $500/mo). If they want exact plan math, that's a Ben conversation.

### The Operator seed (drop on every call that goes well)

> one more thing — most ranches do the $0/mo plan and handle their own
> buyer calls. some hand that to Ben: $500/mo, he takes every sales call,
> closes the buyers, you just ship. zero commission on top. you're welcome
> to start free and switch whenever the calls get annoying.

Plant it even when they start free. Never pressure it.

---

## 5. The Stripe walk-through (the highest-value 10 minutes you'll run)

This is how a rancher goes from "signed" to "money can flow." Run it LIVE
on the phone — send the link mid-call and stay on until it flips. Ranchers
who say "I'll do it tonight" are the 14 people stuck in Lane 2.

**Ground rules first:**
- **The rancher types everything themselves, on their own phone.** You
  never ask them to read an SSN, bank number, or password out loud, and
  you never enter anything for them. You narrate screens; they tap.
- **Links go stale.** Stripe onboarding links can expire in ~24 hours.
  Always trigger a FRESH link at call time — never tell them to dig up
  last week's text. If their link is dead, get a new one sent while
  you're both on the line ([BEN: fill — exact mechanism you use to
  trigger a fresh setup/Connect link: dashboard button vs. text Ben]).
- No tax or legal advice. "Pick what matches how you file taxes — your
  accountant knows in one text" is as far as you go.

**The script, screen by screen** (Stripe Express onboarding — what they'll
see, roughly in this order):

1. **Phone + email → code.** "First screen wants your cell and email —
   it'll text you a 6-digit code. That's Stripe making sure it's you."
2. **Business type.** "Now it asks what kind of business — most ranches
   are sole proprietor or LLC. Pick whatever matches your taxes."
3. **Your details.** "Legal name, date of birth, home address. Standard
   bank stuff."
4. **The SSN moment — expect hesitation, meet it head on:** "Next it asks
   for the last 4 of your social. Totally normal — it's the same identity
   check as opening a bank account or setting up Venmo. That goes to
   Stripe, the payments company — Ben and BuyHalfCow never see it, it
   never touches our system. Stripe runs payments for Amazon and Shopify;
   this is as standard as it gets." (If Stripe can't verify on the last 4
   it may ask for the full SSN — same answer: Stripe only, never us.)
5. **Business details.** "Industry — pick agriculture or food. Website —
   your buyhalfcow page counts: buyhalfcow.com/ranchers/[their-slug]."
6. **Bank account.** "Last real step — where the money lands. Fastest is
   logging into your bank right there; or type routing and account number
   off a check. This is the account your buyers' deposits pay into —
   yours, not ours."
7. **Review → submit.** "Hit submit — you should see charges and payouts
   enabled. That's it. You're live to take money."
8. **The descriptor (do it while you have them):** "One more minute — in
   Stripe, Settings → Public details, set the statement descriptor to
   your RANCH NAME. That's what shows on your buyers' card statements —
   you want them to recognize you, not a code."

**Confirm the flip before you hang up:**
- Have the rancher read you the "charges enabled / payouts enabled" line
  off their screen, and
- Flag it as ACTIVE in the dashboard + text Ben so routing gets confirmed
  on his side.

**If it sticks:** sometimes a rancher finishes the form but the status
doesn't flip (verification pending, or the platform hasn't resynced).
Don't guess, don't have them redo it — text Ben; he has a one-click
resync on his side. Log "Connect stuck — [which screen / what it says]"
so the next touch starts smart.

**Close the call:**
> that's the whole setup — you never touch it again. buyers in [state]
> route to you from here, deposits land straight in that account, and
> you'll get a text the moment the first one moves.

---

## 6. Inbox SOP (the condensed rules)

You'll also cover the shared inbox. Full playbook is
INBOX-MANAGER-SOP.md; these are the rules you cannot break.

**Reply window:** 4 business hours, every thread. The inbox ends each day
at zero — answered or escalated.

**Tone:** write like Ben texts. Lowercase-friendly, plain, direct, warm,
zero corporate. Two-sentence paragraphs. No "we apologize for any
inconvenience," no hype words (never: seamless, journey, ecosystem,
best-in-class). Sign **"— [your first name] at buyhalfcow"** — never
"— Ben" (his signature is his), never "— The BuyHalfCow Team."

**Never promise:**
- **Lead volume.** No "you'll get X buyers a month," no "guaranteed"
  anything. Honest shape: "buyers in [state] who pass our screen route to
  you until your capacity fills — [pull the live count]."
- **"No Stripe fees."** The phrase is "card processing is on us — the
  number you set is the number you get." (Not true on Operator deposits —
  don't extend it there.)
- **A refund or remedy before Ben approves it.** You can say "that's not
  the deal — we make it right," then escalate. Refund vs. reship is his
  call.
- **Numbers you didn't pull.** Live stats or "let me check."

**Escalate to Ben (text, don't sit on it):**
- Anything money — refunds, disputes, "charged twice," settlement → same
  hour.
- Angry or legal-flavored anything → same hour, don't reply first.
- Rancher deal negotiation (pricing, tiers, custom terms) → his call.
- Press, partnerships, influencers → his call.
- Anyone you can't make happy in two replies → hand it up.

Escalation = forward the thread + one line of context to Ben's text.
[BEN: fill — your escalation number for the setter.]

---

## 7. Daily rhythm

**Morning (first 30 minutes):**
1. Open the prospects dashboard. Work the queue in this order:
   - anyone who was mid-Stripe yesterday (finish the flip)
   - today's booked calls (confirm by text)
   - Lane 2 — one-step-from-money
   - Lane 1 — warm stalled
   - Lane 3 — cold, newest applications first
2. Pull the live buyer count for each state you'll call into today. Write
   the numbers down — you say them on every call.
3. Clear the inbox to zero (Section 6 windows apply all day).

**Through the day:**
- **10 meaningful touches.** Conversations and voicemail+text combos
  count; dead dials don't.
- **Disposition logged same-call, before the next dial.** Not at lunch,
  not at EOD. What happened, which objection, next action, next date. An
  unlogged call didn't happen.
- Every activation: text Ben immediately so routing gets flipped and
  confirmed same-day.

**End of day (10 minutes):**
- Sweep the queue: **nothing sits untouched more than 3 days.** If it's
  about to age out, touch it or log why it's parked.
- One-line EOD to Ben: touches / conversations / activations / anything
  escalated. [BEN: fill — where you want the EOD note: text, Telegram,
  email.]

---

## 8. Hard rules (break one and we have a problem)

1. **Never send bulk email.** One-to-one messages only. Anything sent to
   a list — waitlist, prospects, ranchers — is approval-gated by Ben, no
   exceptions. Don't blast the waitlist, ever.
2. **Never edit anything in the main admin** (buyhalfcow.com/admin).
   If you have view access, look — never touch. Pausing ranchers, marking
   deals, refunds, resyncs: all Ben.
3. **Buyer names stay private.** Never share a buyer's info with a
   rancher (or vice versa) outside their own deal thread. Publicly, a
   buyer is "first initial + last initial + state," and only with
   consent.
4. **No pricing promises.** You don't quote custom rates, discounts, or
   flat "10%." Tiers are what they are; anything bespoke is Ben's
   negotiation. Existing custom terms live in Ops Notes (Internal) —
   honor them silently.
5. **Notes go in Ops Notes (Internal). Never in Custom Notes.** Custom
   Notes can surface publicly — internal terms leaked that way once.
   Once is enough.
6. **Removed ranchers stay removed.** If an account was closed, you don't
   re-recruit it, re-link it, or help it back in the side door. Reopening
   a closed account is Ben's decision alone.
7. **Never invent numbers.** Live endpoints or "let me check." Real
   scarcity only — no fake countdowns, no imaginary competing ranch.
8. **The rancher types their own sensitive info.** You never handle,
   read back, or record an SSN, bank number, or password. Ever.
9. **Never send a raw Stripe link from an old text.** Fresh links only,
   triggered at call time (they expire).
10. **Work from BHC channels only.** No personal email for prospect
    contact, no conversations pasted outside the inbox/dashboard.

---

## 9. Glossary (one page, plain English)

- **Connect / Stripe Connect** — the rancher's own Stripe account, opened
  through our platform. Their money lands there directly; we never hold
  it. **"Connect ACTIVE" = charges + payouts enabled = the rancher is
  DONE.** The whole job scores on this.
- **tier_v2** — the current money model. The platform's commission is
  collected up front out of the buyer's deposit, at the rancher's tier
  rate (Legacy Connect 10% · Pasture 7% · Ranch 3% · Operator 0% +
  $500/mo). Free to start on any commission tier; nothing owed until a
  deposit happens.
- **Operator tier** — $500/mo, 0% commission. "We close, you ship" — Ben
  runs the sales calls and the follow-up; the rancher gets texts that
  beef is sold.
- **Deposit rail** — how a share is bought: a qualified buyer puts a real,
  refundable deposit down through the rancher's page. Refundable until
  the rancher accepts the slot; then the processing date locks. The
  deposit lands in the rancher's Connect account.
- **Referral** — one buyer routed to one rancher; the deal record. "Closed
  Won" = the sale happened. Dead intros auto-expire after ~21 quiet days
  so a rancher's pipeline never clogs.
- **Waitlist** — qualified buyers (passed the quiz: budget, freezer,
  timeline) sitting in a state with no active rancher to take them.
  ~1,981 of them (2026-07-08). Your fuel.
- **The quiz / funnel** — the 90-second qualification every buyer passes
  before they can be routed. Nobody unserious ever reaches a rancher.
- **Capacity / Max Active Referrals** — how many head the rancher has to
  sell. They keep receiving buyers until that many sales have CLOSED —
  the cap counts closed sales, not leads in the pipeline.
- **Ops Notes (Internal)** — the private notes field on a rancher record.
  Where dispositions and deal context live. The only safe place for
  anything internal.
- **Prospects dashboard** — bhc-prospects.vercel.app. Your queue, your
  disposition log, your scoreboard. Login handed over by Ben directly.

---

## Open items for Ben

Everything marked **[BEN: fill]** above, in one list:
1. Setter comp structure, hours, activation bonus (Section 1).
2. Cal.com booking link for "book a call with Ben" (Section 3, Lane 3).
3. The exact mechanism the setter uses to trigger a fresh setup/Connect
   link mid-call (Section 5).
4. Escalation phone number for the setter (Section 6).
5. Where the EOD note goes — text / Telegram / email (Section 7).
6. Hand over directly (never in this doc): prospects dashboard password,
   inbox login, the outbound caller-ID number the setter dials from.
