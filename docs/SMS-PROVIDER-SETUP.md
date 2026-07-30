# SMS provider setup — operator runbook

**Written 2026-07-30.** BuyHalfCow's SMS transport is provider-agnostic as of
PR "feat(sms): provider-agnostic transport". Four vendors are wired: **Twilio**
(default), **Telnyx**, **Plivo**, **Bandwidth**. Switching is one env var. No
code change, no redeploy of logic — just `SMS_PROVIDER` plus that vendor's
credentials.

Nothing in this doc turns SMS on. `ENABLE_SMS` is still the master gate and is
still unset in production, so the channel stays dark until Ben flips it.

---

## Read this part first: the honest constraint

**Switching vendors does not skip A2P 10DLC.** Every US carrier requires that
application-to-person SMS (anything a computer sends, which is all of ours) be
tied to a registered **brand** and a registered **campaign** before messages to
US mobile numbers will reliably deliver. This is a *carrier / TCR* requirement,
not a Twilio policy. Telnyx, Plivo and Bandwidth all enforce the same thing
because the carriers make them.

So the thing Ben is stuck on — the registration paperwork — follows him to any
vendor. What changes between vendors is the **experience**: the signup flow, how
much the vendor front-loads identity verification, how fast their support
answers, and whether the console lets you get a number and a sandbox before the
campaign clears.

**The genuinely different, usually faster path for our volume is a toll-free
number with toll-free verification.** Toll-free verification is a separate
process from 10DLC: it is a single form (business details, use case, opt-in
description, sample messages), it is offered by all four vendors, and for low
volume it typically clears faster and with less back-and-forth than a 10DLC
brand + campaign. If the goal is "get the deposit-nudge texts moving this
week," toll-free is the shorter road. Long-code 10DLC is the better end state
for local-presence and per-message cost, and can be registered in parallel.

Either way, **have this on hand before starting any vendor's form**:

| What | Notes |
| --- | --- |
| **Legal business name + EIN** | Must match IRS records exactly. Sole-prop with no EIN slows every vendor down. |
| **Business address** | Registered address, not a PO box. |
| **Business website** | Must be live and describe the service. buyhalfcow.com. |
| **Contact name, email, phone** | A real person who can answer a verification call. |
| **Use case** | "Customer care / account notification" — transactional deal updates to buyers and ranchers who opted in. Not marketing. |
| **Sample messages (2–3)** | Copy them verbatim out of `lib/smsEvents.ts` (`buildBody` / `buildRancherBody`). They already end in "Reply STOP to opt out." |
| **Opt-in description + proof** | See below — this already exists in the funnel. |
| **Estimated volume** | Low. Dozens/day, not thousands. Say so; it keeps you out of the high-throughput review queue. |

### Opt-in evidence (already built — do not re-invent it)

Vendors will ask *how* a recipient consented. Our answer, which is true today:

- Buyers tick an explicit SMS consent checkbox in the funnel. The tick writes
  `SMS Opt-In = true` and stamps `SMS Opt-In At` on the Consumer record — that
  timestamp IS the consent record.
- No SMS is sent unless `SMS Opt-In === true` **and** `Unsubscribed !== true`
  (enforced in `sendSMSToConsumer`, `lib/twilio.ts`).
- Every message body ends with "Reply STOP to opt out."
- STOP / HELP / START are honored automatically on every provider (below).

Screenshot the funnel's consent checkbox and its wording for the form. That is
what "opt-in proof" means to a reviewer.

### The existing number

The current BuyHalfCow line is a Twilio number, configured as
`TWILIO_FROM_NUMBER` — read it from the env, never from a doc (this repo is
public, so no live number is written down here).

Numbers are portable between all four vendors, but porting takes days and
requires the losing carrier's account details. For a first send it is usually
faster to take a **new** number from the new vendor and leave the existing line
where it is until the new rail is proven.

---

## How the switch works

```
fireSMSEvent / fireRancherSMSEvent      lib/smsEvents.ts
  └─ smsEnabled()                       ENABLE_SMS master gate — lib/smsFlag.ts
     └─ sendSMSToConsumer()             TCPA: SMS Opt-In === true
        └─                              suppression: Unsubscribed !== true
           └─ sendSMS()                 phone normalized to E.164
              └─ sendViaProvider()      ◀ SMS_PROVIDER picks the vendor here
                 └─ adapter             twilio | telnyx | plivo | bandwidth
```

The provider sits **below every gate**. Changing `SMS_PROVIDER` cannot loosen
consent, suppression or the one-SMS-ever stamps. It only changes which wire an
already-authorized message leaves on.

`SMS_PROVIDER` unset ⇒ `twilio` ⇒ today's exact behavior.
`SMS_PROVIDER` set to garbage ⇒ warns and falls back to `twilio` rather than
silently dropping every send.

---

## Env vars per provider

Set `SMS_PROVIDER` to one of `twilio` | `telnyx` | `plivo` | `bandwidth`, plus
that block's credentials. Leave the other blocks unset.

### `SMS_PROVIDER=twilio` (default — omit the var entirely for this)

| Var | Where it comes from |
| --- | --- |
| `TWILIO_ACCOUNT_SID` | Twilio Console → Account Info |
| `TWILIO_AUTH_TOKEN` | Twilio Console → Account Info (API Key preferred in prod) |
| `TWILIO_FROM_NUMBER` | Your Twilio number, in E.164 format (`+1` + 10 digits) |

### `SMS_PROVIDER=telnyx`

| Var | Where it comes from |
| --- | --- |
| `TELNYX_API_KEY` | Telnyx portal → Auth → API Keys (`KEY…`) |
| `TELNYX_FROM` | Your Telnyx number, E.164 |

Wire: `POST https://api.telnyx.com/v2/messages`, `Authorization: Bearer <key>`,
body `{from, to, text}`. Verified against
<https://developers.telnyx.com/docs/messaging/messages/send-message>.

Telnyx also requires the number to be attached to a **Messaging Profile**; do
that in the portal, not in env.

### `SMS_PROVIDER=plivo`

| Var | Where it comes from |
| --- | --- |
| `PLIVO_AUTH_ID` | Plivo console → Account → Auth ID (`MA…`) |
| `PLIVO_AUTH_TOKEN` | Plivo console → Account → Auth Token |
| `PLIVO_FROM` | Your Plivo number, E.164 (sent as `src`) |

Wire: `POST https://api.plivo.com/v1/Account/{auth_id}/Message/`, Basic auth
`auth_id:auth_token`, body `{src, dst, text}`. Verified against
<https://www.plivo.com/docs/messaging/api/message/send-a-message/>.

### `SMS_PROVIDER=bandwidth`

| Var | Where it comes from |
| --- | --- |
| `BANDWIDTH_ACCOUNT_ID` | Bandwidth App → Account |
| `BANDWIDTH_API_TOKEN` | Basic-auth username |
| `BANDWIDTH_API_SECRET` | Basic-auth password |
| `BANDWIDTH_APPLICATION_ID` | The messaging application bound to your number |
| `BANDWIDTH_FROM` | Your Bandwidth number, E.164 |

Wire: `POST https://messaging.bandwidth.com/api/v2/users/{accountId}/messages`,
Basic auth, body `{applicationId, to:[…], from, text}` → `202 Accepted`.
Verified against <https://dev.bandwidth.com/docs/messaging/createMessage/>.

> ⚠️ **Bandwidth auth caveat.** The Basic-auth token/secret pair this adapter
> uses is Bandwidth's *legacy* scheme. Bandwidth is migrating to OAuth 2.0
> client credentials and stopped issuing new legacy Basic-auth API users after
> 2026-03-31. A brand-new Bandwidth account may only be able to issue OAuth
> client credentials, which this adapter does **not** implement. Of the four,
> Bandwidth is the least likely to work from a cold signup — treat Telnyx and
> Plivo as the realistic Twilio alternatives.

---

## Inbound: STOP / HELP / START on any provider

Carrier keyword handling is a legal obligation. It is implemented **once**
(`lib/smsKeywords.ts` for the rules, `lib/smsInboundHandler.ts` for the Airtable
write) and both inbound routes call it, so behavior is identical on every
vendor:

| Keyword | What we do | What we reply |
| --- | --- | --- |
| STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT | `Unsubscribed = true`, `SMS Opt-In = false` on the Consumer | nothing (see note) |
| START, UNSTOP, YES, RESUME | `Unsubscribed = false`, `SMS Opt-In = true`, re-stamp `SMS Opt-In At` | "you're re-subscribed…" |
| HELP, INFO | no state change | brand + contact + rates + "Reply STOP to cancel" |
| anything else | no state change | nothing |

### Routes

- **Twilio** keeps its own endpoint with `X-Twilio-Signature` verification:
  `https://www.buyhalfcow.com/api/webhooks/twilio-sms` — unchanged.
- **Everything else** uses the neutral endpoint:

  ```
  https://www.buyhalfcow.com/api/webhooks/sms?token=<SMS_INBOUND_SECRET>
  ```

  Paste that full URL (token included) into the vendor's inbound-message webhook
  field. POST is preferred; GET also works (Plivo can be configured either way).

| Var | Notes |
| --- | --- |
| `SMS_INBOUND_SECRET` | Long random string. Constant-time compared. **Unset in production ⇒ the endpoint returns 503 and refuses all inbound** (fail-closed by design — this endpoint can flip consent flags). |

Generate one with: `openssl rand -hex 32`.

### Note on the STOP confirmation

Twilio injects its own carrier-mandated STOP confirmation, so we deliberately
send nothing extra. **On Telnyx, Plivo and Bandwidth, turn on the vendor's own
automatic opt-out handling in their console** — that is the correct place for
the confirmation message and for the carrier-level block. Our handler mirrors
the state into Airtable either way, so our own gate agrees with the carrier's,
but do not rely on our handler alone for the carrier block.

---

## Switch checklist

1. Register brand + campaign (10DLC) **or** submit toll-free verification with
   the new vendor. Wait for approval. Nothing below works before this.
2. Buy a number on the new vendor; attach it to the messaging profile /
   application the vendor requires.
3. Set the vendor's credential vars in Vercel (Production + Preview).
4. Set `SMS_INBOUND_SECRET` (if not already set) and paste
   `/api/webhooks/sms?token=…` into the vendor's inbound webhook field.
5. Enable the vendor's automatic opt-out (STOP) handling in their console.
6. Set `SMS_PROVIDER=<vendor>`. Redeploy.
7. Smoke test **before** flipping `ENABLE_SMS`: text HELP to the new number from
   Ben's phone and confirm the reply arrives; then text STOP and confirm the
   Consumer record flips `Unsubscribed`; then text START to restore it.
8. Only then flip `ENABLE_SMS=1`.

Rollback is `SMS_PROVIDER=twilio` (or unset) + redeploy.

---

## Related files

| File | Role |
| --- | --- |
| `lib/smsTransport.ts` | provider resolution + dispatch; never throws |
| `lib/smsProviders/{twilio,telnyx,plivo,bandwidth}.ts` | one adapter each, REST over fetch, no SDKs except Twilio's existing one |
| `lib/smsProviders/http.ts` | timeout-bounded POST that never throws |
| `lib/smsInbound.ts` | normalizes any vendor's inbound payload to `{from,to,body,providerMessageId}` |
| `lib/smsKeywords.ts` | STOP/HELP/START rules + reply copy (pure) |
| `lib/smsInboundHandler.ts` | the Airtable consent flip |
| `lib/smsInboundAuth.ts` | shared-secret gate for the neutral route |
| `lib/smsFlag.ts` | `ENABLE_SMS` master gate — unchanged |
| `lib/twilio.ts` | `sendSMS` / `sendSMSToConsumer` — the TCPA gate, unchanged |
| `app/api/webhooks/sms/route.ts` | provider-neutral inbound |
| `app/api/webhooks/twilio-sms/route.ts` | Twilio inbound (signature-verified) |
