# Re-engagement Email — Never-Emailed WAITING Buyers in Routable States

**Status:** DRAFT — not wired, not sent.
**Audience:** WAITING buyers in states that now have operational supply, who have
never received a campaign email from us. Count was 352 at briefing (2026-07-28) —
**[PULL COUNT] at send time.**
**Goal:** wake them honestly and hand them the one link that matches their state.
**Cadence:** single send through the guarded rail (`guardedSend`, suppression +
frequency caps respected). One send. If they don't move, the normal nurture takes
over — do not bolt a sequence onto this.

---

## CTA routing (for engineering)

One CTA per email, target picked per buyer at send time:

- Quiz complete + their state has an ad-ready rancher page → that page
  (e.g. `/ranchers/foodstead` for MT) with
  `?utm_source=email&utm_medium=drip&utm_campaign=waiting-wake-{st}` (matches the
  existing email UTM convention in `lib/email.ts`).
- Quiz incomplete → their quiz resume link (`/access` with their magic token) so
  they finish qualification first — never route or match on a half-done quiz
  (quiz-required qualification rule).

Merge fields: `{firstName}`, `{state}`, `{ranchName}`, `{ctaUrl}`, `{unsubscribeUrl}`.

---

## Subject options (pick one — lowercase, plain)

1. `{firstName}, there's a ranch for you now`
2. `you waited. here's what changed in {state}`
3. `been a while. good news about {state} beef`

---

## Body (plain text)

```
{firstName} — you signed up for the waitlist a while back and then heard
nothing from me. That silence was real: we didn't have a ranch serving {state},
and I wasn't going to send you hype about beef you couldn't buy.

That changed. {ranchName} is live in your area now. Real family ranch, real
prices on the page, processing included. You reserve with a small deposit and
it stays fully refundable until the rancher accepts your slot.

See the ranch:
    {ctaUrl}

If the timing is wrong, ignore me. You lose nothing. But the shares on that
page are a real count of what's left this round, so if a freezer full of honest
beef is still the plan, it's worth a look this week.

— Ben

Don't want emails from me? Unsubscribe: {unsubscribeUrl}
```

### Quiz-incomplete variant (only the middle block changes)

```
That changed. We now have a ranch serving {state}. One thing stands between
you and a match: the 90 second quiz you started. Finish it and we route you
to your rancher.

Finish the quiz:
    {ctaUrl}
```

---

## Copy notes

- Reads like an apology from a person, because it is one. The honesty about why
  we were silent IS the re-engagement hook — nobody else in their inbox says
  "I didn't email you because I had nothing for you."
- "Real count of what's left this round" is true: the share counters on the
  rancher pages are live inventory. That line dies if the counters ever go fake.
- One CTA. No secondary links, no social footer.
- No hyphens in body copy (Ben outreach rule); em dash signoff is the locked
  signature. "90 second quiz" written without a hyphen on purpose.
- No fee talk, no discounts, no urgency theater. The only urgency is inventory
  that is actually real.
