# SAVE STATE — 2026-06-10

HEAD: `2b40635` GO_TO_MARKET: final consolidation across F1-F13

## What just shipped (F1-F13 war-ready funnel block)

Per-feature receipts: `BUILD_LOG.md`. Daily ops: `GO_TO_MARKET.md`.

13 commits + 1 doc commit. All typecheck clean. All pushed to main.

| Feature | Status | Flag |
|---|---|---|
| F1 brand voice + mission lock | ✅ live | n/a |
| F2 Meta CAPI placement (5 events) | ✅ live | n/a |
| F3 funnel observability | ✅ live | n/a |
| F4 composite lead score | ✅ live | n/a |
| F5 Resend open/click webhook | ✅ live | needs Resend subscription |
| F6 Next-Best-Action widget | ✅ live | n/a |
| F7 $49 reservation hold | ✅ shipped, OFF | `ENABLE_RESERVATION_HOLD` |
| F8 $497 white glove | ✅ shipped, OFF | `ENABLE_WHITE_GLOVE` |
| F9 SMS event stubs | ✅ shipped, OFF | `ENABLE_SMS` |
| F10 friction polish | ✅ live | `NEXT_PUBLIC_REQUIRE_PHONE` (A/B) |
| F11 click-to-call + Whisper | ✅ shipped, OFF | `ENABLE_CLICK_TO_CALL` |
| F12 deal-rot + stage advance | ✅ live | n/a |
| F13 email engage badges | ✅ live | needs F5 data flowing |

## Schema added live (via Airtable MCP)

**Consumers (9):**
- `Email Opens`, `Email Clicks`, `Last Email Event/Delivered/Opened/Clicked At`
- `Reservation Hold Paid At` / `Session Id` / `Refunded At`

**Ranchers (2):**
- `White Glove Paid At` / `Session Id`

**Email Sends (6):**
- `Last Event At`, `Delivered/Opened/Clicked At`, `Open Count`, `Click Count`

**Conversations (4):**
- `Recording URL`, `Transcript`, `Call Duration Seconds`, `Call Sid`

## NEXT — pick up here

### Verify ship (do before anything)
1. `curl https://www.buyhalfcow.com/api/health | jq .` — SHA should be `2b40635`
2. Synthetic E2E on prod — `/access` → `/qualify` → desk shows buyer with lead score badge
3. Meta Events Manager Test Events — 5 events fire deduped, Match Quality ≥6/10

### User-side ops (must do, can't automate)
- Resend dashboard → Webhooks → existing endpoint → add events: `email.delivered`, `email.opened`, `email.clicked`. Until this, F5/F13 surfaces empty
- Decide on flag flips (none required, but $49 hold is strongest revenue lever)
- When Twilio ready: set `TWILIO_*` + `BHC_OPERATOR_PHONE` + flip `ENABLE_SMS=1` + `ENABLE_CLICK_TO_CALL=1`

### Then biggest product gaps after F13
- **Rancher dashboard parity** — F12 stage advance works on admin, rancher UI still old
- **Wholesale + B2B closed-loop** — `/wholesale` lands in Airtable but no auto-routing
- **Buyer member portal** — `/member` bare-bones, no engagement loop after qualified

## Outstanding pre-F1 tasks (not new, still pending)

- Task #6 Phase E: Merge to main + prod verify + post-merge 3-pass
- Task #67 Wave 3 — G1-G5 backend hardening
- Task #74 Wave 4 — H1-H6 backend polish

## Files touched in this block

```
NEW
  lib/leadScore.ts            (F4)
  lib/nextBestAction.ts       (F6)
  lib/reservationHold.ts      (F7)
  lib/whiteGlove.ts           (F8)
  lib/smsEvents.ts            (F9)
  lib/clickToCall.ts          (F11)
  app/api/admin/funnel-conversion/route.ts          (F3)
  app/api/qualify/[id]/reservation-hold/route.ts    (F7)
  app/api/rancher/white-glove/route.ts              (F8)
  app/api/qualify/resend-link/route.ts              (F10)
  app/api/cron/abandoned-quiz-nudge/route.ts        (F10)
  app/api/admin/click-to-call/route.ts              (F11)
  app/api/webhooks/twilio-recording/route.ts        (F11)
  app/api/admin/referrals/[id]/stage/route.ts       (F12)
  docs/BHC-BRAND.md           (F1)
  BUILD_LOG.md
  GO_TO_MARKET.md
  SAVE_STATE.md (this file)

MOD
  app/components/FullHomepage.tsx                   (F1)
  app/founders/page.tsx                             (F1)
  app/access/page.tsx                               (F1 + F10)
  lib/emailMinimal.ts                               (F1)
  app/qualify/[consumerId]/page.tsx                 (F2 + F10)
  app/api/qualify/route.ts                          (F2)
  app/api/admin/send-deposit-invoice/route.ts       (F2 + F9)
  app/api/webhooks/cal/route.ts                     (F2)
  lib/metaCapi.ts                                   (F2)
  app/api/webhooks/resend/route.ts                  (F5)
  app/api/admin/desk/route.ts                       (F3 + F4 + F6 + F12 + F13)
  app/admin/today/v2/DeskClient.tsx                 (F3 + F4 + F6 + F12 + F13)
  app/api/webhooks/stripe/route.ts                  (F7 + F8)
  app/api/rancher/referrals/[id]/accept/route.ts    (F9)
  app/api/consumers/route.ts                        (F9)
  vercel.json                                       (F10 cron registration)
```

## Commit list (newest first)

```
2b40635 GO_TO_MARKET: final consolidation across F1-F13
ddc7506 F13: Email open/click badges on desk buyer cards
65c06aa F12: Deal-rot badges + stage-advance on desk
48bb53f F11: Click-to-call + Whisper transcribe (feature-flag OFF default)
9efaa15 F10: Funnel friction polish — phone toggle + JWT recovery + abandoned cron
b9e770e F9: SMS event stubs (feature-flag OFF default)
5b38553 F8: $497 White Glove Onboarding stub (feature-flag OFF default)
2bf5053 F7: $49 Reservation Hold stub (feature-flag OFF default)
aa587fe F6: Next-Best-Action widget on desk
75cf135 F5: Resend open/click/delivered → engagement log
87e524f F4: Composite lead score + desk sort
194963a F3: Funnel observability — desk card with stages + UTM source breakdown
d5c6b0c feat(F2): pixel placement — CompleteRegistration + Schedule + InitiateCheckout
26cca7d feat(F1): brand voice + mission lock across all surfaces
0704399 spec: war-ready funnel + sales floor v1 design — 6 decisions locked, 13 features, 4 phases
```

## Resume command

```bash
cd "/Users/benji.bushes/BHC/untitled folder/bhc"
git log --oneline -5
cat SAVE_STATE.md
```

Then pick from "NEXT" section above.
