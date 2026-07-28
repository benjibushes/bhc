# One-Question Email — Nationwide Shipping Ask (168 Stranded READY Buyers)

**Status:** DRAFT — not wired, not sent. Engineering wires the one-click YES;
Ben approves the send.
**Audience:** the READY buyers whose state has no operational supply. Count was
168 at briefing (2026-07-28) — **[PULL COUNT] at send time**; this pool moves as
ranchers activate.
**Goal:** one answer to one question — would they take shipped beef from a
verified ranch outside their state?

---

## Mechanism (for engineering — do not improvise a new rail)

The YES button is the **existing** magic-link preference mechanism, not a new
endpoint. The click lands the buyer authenticated (member login token →
`bhc-member-auth` session) and fires:

```
POST /api/member/preferences
{ "nationwide": true, "refireMatching": true }
```

That writes the whitelisted `Nationwide Preference` field (`nationwide-ok`) on
the buyer's own Consumer record and re-fires `matching/suggest` in-process — the
same pattern the funnel waitlist reveal already uses
(`app/api/member/preferences/route.ts`, caller #1). A YES can therefore match
the buyer immediately, which is exactly the promise the copy makes. No reply
parsing, no manual step.

Send through the standard guarded rail (`guardedSend` suppression +
frequency caps). One send, no sequence — this is a question, not a campaign.

---

## Subject options (pick one — lowercase, boring internal style)

1. `quick question about your beef`
2. `would shipped work for you, {firstName}?`
3. `no ranch in {state} yet. one question`

---

## Body (plain text; merge fields `{firstName}`, `{state}`, `{yesLink}`, `{unsubscribeUrl}`)

```
{firstName} — straight answer first: we don't have a ranch in {state} yet.

You qualified and you're ready to buy. I hate that you're waiting on geography.

So, one question. Several of our verified ranches ship frozen, direct to your
door. Same real beef, same cut sheet, same rancher you can actually talk to.
It just rides a truck to you instead of a tailgate.

Would that work for you?

    YES, match me with a shipping ranch
    {yesLink}

One click is the whole answer. If yes, our matching runs immediately and you
could hear from a rancher today. If shipped beef isn't for you, do nothing —
you keep your place in line for {state} and I'll email you when a local ranch
goes live.

— Ben

p.s. your deposit stays fully refundable until a rancher accepts your slot.
Same promise either way.

Don't want emails from me? Unsubscribe: {unsubscribeUrl}
```

---

## Copy notes

- One CTA, one link, per `docs/BHC.md`. The button label states the action, not
  "click here."
- "You could hear from a rancher today" is true only because `refireMatching`
  runs the engine on click — if engineering ships the YES without the refire,
  soften to "we start matching you right away."
- No hyphens in body copy (Ben outreach rule). The em dash in the signoff is the
  locked signature format.
- Honest framing: leads with the bad news ("no ranch in {state} yet"). No fake
  supply, no "coming soon to your state" promises.
- Money model fence: no fee talk needed here; the refundable deposit line is the
  only money reference and it matches the BHC Promise verbatim intent.
