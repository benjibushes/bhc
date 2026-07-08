# Inbox Manager SOP — running the buyhalfcow inbox

*2026-07-08. The playbook that lets one person run the inbox without Ben.
Give this doc + one login to a new manager and they're productive day one.*

---

## 1. What this job is

Every email the platform hears — buyer replies, rancher replies, contact
forms, (soon) cold-outreach replies — lands in ONE inbox, pre-triaged.
Each forwarded message opens with a machine-written briefing block:

> **From:** the actual human · **Context:** which deal/thread ·
> **Classification:** buyer/rancher · objection category · sentiment ·
> **AI Summary:** one line on what they want

Your job: answer what you can from this doc within **4 business hours**,
escalate what you can't, never promise what section 5 forbids. Hitting
reply goes straight to the human (the platform set that up) — you never
need to copy addresses.

## 2. Tone (non-negotiable)

Write like Ben texts: lowercase-friendly, plain, direct, warm, zero
corporate. Two-sentence paragraphs. No exclamation stacking, no "we
apologize for any inconvenience," no hype words (never: seamless,
journey, ecosystem, best-in-class). Sign **"— [your first name] at
buyhalfcow"** — never "— Ben" (his signature is his), never "— The
BuyHalfCow Team."

## 3. Play the hits — canned answers (adapt, don't paste)

**Buyer: "when do I get matched / where's my rancher?"**
> still lining up the right ranch in your state — your spot holds and
> you'll get an intro by name the moment they're ready. meanwhile the
> shop ships this week from the same ranches if you're hungry:
> buyhalfcow.com/shop

**Buyer: "how do refunds work?" (deposit)**
> your deposit is fully refundable until the rancher accepts your slot —
> after they commit your processing date it locks in, and you'll have
> gotten a "slot locked" email at that moment. want me to check where
> yours stands? *(then check with Ben/admin before confirming status)*

**Buyer: product order issue (wrong/damaged/freezer-burned)**
> that's not the deal — we make it right, no forms. *(escalate to Ben
> same day with the order details; do NOT promise the specific remedy —
> refund vs reship is his call.)*

**Buyer: "is this legit / how do I know the rancher is real?"**
> every ranch on the platform is verified before a single buyer is
> routed — real family, real land, their name on everything. you pay
> through stripe and your deposit is refundable until they accept you.

**Rancher: "what does this cost me?"**
> free to start — the commission comes out of a deposit that already
> happened, so no booking, no cost. on our checkout card processing is
> on us: the number you set is the number you get. *(NEVER say "no
> stripe fees." NEVER extend the processing claim to the $500/mo
> operator plan's deposits.)*

**Rancher: "do you own my customers?"**
> no — buyers pay into YOUR stripe account and land on YOUR page with
> your name on it. your brand, your prices, your customer list.

**Rancher: "how many buyers will I get?"**
> ⚠️ never promise volume — it depends on demand in their state. honest
> shape: "buyers in [state] who pass our screen route to you until your
> capacity fills — [check the live count at
> buyhalfcow.com/api/stats/buyers-by-state?state=XX before quoting]."

**Cold-outreach reply (rancher curious):**
> answer the question simply, then: "fastest way to see it is a quick
> call with ben — [cal link] — or the 90-second application at
> buyhalfcow.com/sell." *(goal = call booked or application started;
> hand warm ones to Ben via escalation.)*

**Unsubscribe / "stop emailing me":**
> unsubscribe them immediately (link is in every email footer; if they
> just replied "stop," confirm kindly + tell Ben so it's suppressed) —
> never argue, never win-back.

## 4. Escalate to Ben (text him, don't sit on it)

- Anything money: refund requests, disputed charges, "I was charged
  twice," settlement questions → **same hour**.
- Angry or legal-flavored anything → same hour, don't reply first.
- Rancher deal negotiation (pricing, tiers, custom terms) → his call.
- Press, partnerships, influencers → his call.
- A buyer or rancher you can't make happy in two replies → hand it up.

Escalation = forward the thread + one line of context to Ben's personal
email/text. You keep the inbox at zero; he keeps the judgment calls.

## 5. Never (the hard lines)

- Never promise lead volume or "guaranteed" anything to ranchers.
- Never say "no Stripe fees" (Stripe gets paid — by us).
- Never confirm a refund/remedy before Ben approves it.
- Never share a buyer's info with a rancher (or vice versa) outside
  their own deal thread.
- Never send from your personal email, never BCC yourself, never
  paste conversations anywhere outside the inbox.
- Never invent numbers — pull live stats or say "let me check."

## 6. The setup itself (Ben does once, ~20 min)

1. **Google Workspace** on buyhalfcow.co: create `ben@buyhalfcow.co`
   (the public identity) + `[manager]@buyhalfcow.co` ($7/user/mo).
2. **Gmail delegation**: ben@ → Settings → Accounts → "Grant access to
   your account" → add the manager. They read + reply from their OWN
   login; replies send as ben@'s address with no password sharing.
   (House rule from §2 still applies: they sign their own first name.)
3. Point the platform at it: tell Claude "set the forward to
   ben@buyhalfcow.co" (one env flip + redeploy).
4. Outreach replies already reply-to the same address once OUTREACH_FROM
   is set — one inbox by construction.
5. Offboarding = delete the manager's Workspace user. Nothing else to
   revoke — they never had Vercel, Airtable, Stripe, or Telegram.

**Access boundary:** the manager gets the inbox and this doc. Platform
actions (marking deals, pausing ranchers, refunds) stay with Ben — if a
thread needs a platform action, that's an escalation by definition.
