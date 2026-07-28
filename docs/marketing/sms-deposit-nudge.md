# SMS Copy — Deposit-Request Rescue Rail

**Status:** DRAFT copy for the existing rail — no new sends, no new mechanism.
**Rail:** `app/api/cron/deposit-request-nudge` (hourly). Buyer got a deposit
request, hasn't paid. Selection, dedupe stamps, 24h delay, 48h cooldown, and the
2-lifetime-nudge cap are already enforced in `lib/depositRequestNudge` /
`lib/reserveRecovery`. Copy below slots into that machinery.

**Hard gates already in code — copy assumes all of them:**
- `SMS Opt-In` on the Consumer must be true (`sendSMSToConsumer`), plus the
  global `smsEnabled()` flag and TCPA quiet-hours window (`isSmsWindow`).
- Stamp-before-send: no dedupe stamp persisted, no send.
- `{payLink}` is the durable magic-link → deposit-page hop, NEVER the stored
  Stripe Checkout URL (those expire in ~24h — the exact moment this rail fires).

**Tone rule:** "your reservation link," never "last chance." The rancher is
holding a real slot; the message states that fact and stops. No countdowns, no
pressure verbs.

---

## Message 1 — initial nudge (fires ≥24h after the deposit request)

```
BuyHalfCow: {first}, your {cut} share at {rancher} is held. Your reservation link: {payLink} Reply STOP to opt out
```

- 114 chars as written. Rendered with a long ranch name and a ~35 char link it
  sits around 150 — under the 160 single-segment limit.
- If a ranch name would push a render past 160, the send code should fall back
  to "your ranch" (same fallback `lib/smsEvents.ts` already uses).

## Message 2 — one follow-up (respects the 48h cooldown; last touch on this rail)

```
BuyHalfCow: {first}, {rancher} is still holding your spot. Reserve when ready: {payLink} Reply STOP to opt out
```

- 110 chars as written; ~145 rendered. "When ready" is deliberate — the deposit
  stays refundable until the rancher accepts, so there is genuinely no cliff to
  threaten anyone with.

---

## What NOT to write on this rail (fence)

- "Last chance" / "expires tonight" / "final notice" — banned. The hold is real;
  fake cliffs aren't.
- No price, no fee math in SMS. The deposit page shows the money truthfully;
  160 characters can't.
- No second follow-up. Two touches is the cap in code and in copy.
- Never swap `{payLink}` for a raw Stripe URL. Durable links only.
