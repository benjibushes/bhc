# BHC GO-TO-MARKET — war-ready funnel + sales floor v1

Built 2026-06-09 across F1-F13. Spec: `docs/archive/superpowers/specs/2026-06-09-war-ready-funnel-design.md`. Per-feature receipts: `BUILD_LOG.md`.

## Mission

**Connect every household to a ranch they trust.**

This is the line. Use it. Don't drift.

## Brand voice (dual)

- **Buyer-facing** (`/`, `/access`, `/qualify`, `/matched`, buyer emails): product-led, "ranch-direct beef"
- **Rancher-facing** (`/partner`, `/founders`, `/rancher`, rancher emails): infra-led, "modern sales infrastructure for DTC ranchers"
- **Operator-facing** (`/admin/*`): pipeline-dense

Full doc: `docs/BHC-BRAND.md`. Read before any copy edit.

## Surface inventory

| Surface | Status |
|---|---|
| `/` homepage | ✅ mission integrated |
| `/access` | ✅ mission in footer, phone toggle env (F10) |
| `/qualify/[id]` | ✅ buyer voice + stale-JWT recovery (F10) |
| `/matched` | ✅ buyer voice clean |
| `/partner` | ✅ infra voice clean |
| `/founders` | ✅ mission + infra paragraph |
| `/rancher` | ✅ infra voice |
| `/rancher/setup` | ✅ wizard infra voice |
| `/admin/today/v2` | ✅ desk w/ NBA + funnel + lead score + email engage + rot + stage advance |
| `/admin/migration` | ✅ admin tracker |

## Daily ops on /admin/today/v2

1. **Next Best Action** (top of page, F6) — top 8 ranked actions for the next hour
2. **Cal calls** — today's bookings
3. **Quiz complete · awaiting Cal book** — sorted by composite lead score (F4). Hot ≥70, warm 40-69, cold <40. Email engagement badge per card (F13)
4. **Awaiting rancher accept** — rot badge (F12) shows days-since-last-action. Click `→ Locked` to advance
5. **Closed today** — celebration tape
6. **Funnel · last 30d** (F3) — stage tiles + per-source conversion rates
7. **Waitlist · no rancher in state** — heatmap of supply gaps

## Critical paths to watch (Telegram)

- `🏦 STRIPE CONNECT ACTIVE — <Ranch>` — rancher just finished KYC
- `💸 Deposit invoice sent — <buyer>` — admin Send Invoice fired
- `🔒 DEPOSIT LOCKED` — rancher accepted slot, deposit non-refundable
- `📊 Stage advanced` — manual stage flip from desk
- `📨 Abandoned-quiz nudges: N sent` — hourly cron summary
- `🚫 Email COMPLAINED` / `📭 Email BOUNCED` — auto-suppression
- `↩️ Deposit refunded — PI <id>` — buyer changed mind
- `⚠️ CAL WEBHOOK ERROR` — Cal handler exception
- `📞 Call recorded` (F11, when enabled)
- `💵 Reservation hold paid` (F7, when enabled)
- `🧤 White Glove sold` (F8, when enabled)

## Conversion tracking (F2)

5 events fire per buyer journey via Meta CAPI + client Pixel (deduped via event_id):
1. **Lead** — `/access` signup
2. **CompleteRegistration** — quiz submit
3. **Schedule** — Cal booking created
4. **InitiateCheckout** — admin Send Deposit Invoice
5. **Purchase** — Stripe webhook on deposit paid

Verify in Meta Events Manager → Test Events. Match Quality target ≥6/10. Dedup score: 100%.

## Funnel observability (F3)

`/admin/today/v2` shows 30-day funnel: signup → qualified → booked → invoiced → locked → closed. Per-UTM-source breakdown (top 10). Endpoint: `GET /api/admin/funnel-conversion?since=7d|30d|90d|all`.

Use it: after a paid-ad push, watch the bySource table. If `qualified→booked` drops, Cal flow has friction. If `booked→invoiced` drops, calls aren't closing.

## Lead score (F4)

Composite 0-100 per buyer card:
- `quiz × 0.4 + intent × 0.3 + recency bonus (0-20) + 5 phone + 5 paid source`
- **Dark badge (≥70)**: call NOW
- **Outline badge (40-69)**: queue today
- **Grey badge (<40)**: drip email

Sorted hottest first. Tags show why: `fresh`, `phone`, `paid:meta`, `today`.

## Email engagement (F5 + F13)

Resend webhook fires on `email.opened` / `email.clicked` / `email.delivered`. Stamps Consumer + Email Sends row. Surfaced on desk cards as `📧 Xo/Yc` badge (opens / clicks). Sage tint if any clicks.

**OPS:** add `email.delivered` + `email.opened` + `email.clicked` to Resend webhook subscriptions to activate.

## Next-Best-Action (F6)

Top-of-desk widget. 5 rules ordered by revenue impact:
1. P1 Cal call within 60 min
2. P1 Hot quiz buyer (lead score ≥70)
3. P2 Deposit pending → chase rancher
4. P3 Warm quiz buyer (40-69) → drip Cal invite
5. P3 Slots locked → verify processing date

## Feature-flagged upsells (F7 + F8)

OFF by default. Flip env when ready.

### $49 Reservation Hold (F7)
- Env: `ENABLE_RESERVATION_HOLD=1`
- Buyer flow: `/qualify` → POST `/api/qualify/[id]/reservation-hold` → Stripe Checkout → webhook stamps Consumer
- Use case: filter tire-kickers + create float at scale

### $497 White Glove Onboarding (F8)
- Env: `ENABLE_WHITE_GLOVE=1`
- Rancher flow: POST `/api/rancher/white-glove` → Stripe Checkout → webhook stamps Rancher
- Use case: premium onboarding for ranchers who want Ben to handle first 3 buyer matches

## SMS event stubs (F9)

OFF by default. Flip `ENABLE_SMS=1` + set Twilio env vars.

Wired sites:
- `/api/consumers` signup → `fireSMSEvent('signup')`
- `/api/admin/send-deposit-invoice` → `fireSMSEvent('deposit_invoice')`
- `/api/rancher/referrals/[id]/accept` → `fireSMSEvent('slot_locked')`

TCPA-gated via `SMS Opt-In` on Consumer + `Unsubscribed` mirror.

Remaining 4 events (quiz_invite, cal_reminder, refund, fulfillment) wired when business logic finalizes.

## Friction polish (F10)

- **Phone-optional toggle**: `NEXT_PUBLIC_REQUIRE_PHONE=0` lets `/access` accept blank phone (A/B test top of funnel)
- **Stale JWT recovery**: inline "send me fresh link" form on expired `/qualify` URLs
- **Abandoned-quiz nudge cron**: hourly. Window 1-72h post-signup, no `Qualified At`. Telegram volume alert.

## Click-to-call + Whisper transcribe (F11)

OFF by default. Flip `ENABLE_CLICK_TO_CALL=1` + `BHC_OPERATOR_PHONE` + `TWILIO_*` + `GROQ_API_KEY`.

Flow: Admin clicks Call → Twilio dials Ben first, then buyer (conference) → both legs recorded → webhook → Groq Whisper → Conversations row + Telegram alert.

UI button on desk TODO (helper + endpoints ready).

## Deal-rot + stage advance (F12)

- **Rot badge** on pipeline cards: days-since-last-action. Grey 0-2d, saddle 3-6d, red 7d+.
- **`→ Locked` button** per pipeline card: server-validated transition (intro→awaiting→locked→won; any→lost; lost→intro revive).

## Schema added (live via MCP)

**Consumers:**
- `Email Opens` / `Email Clicks` (number)
- `Last Email Event/Delivered/Opened/Clicked At` (dateTime)
- `Reservation Hold Paid At` / `Session Id` / `Refunded At`

**Ranchers:**
- `White Glove Paid At` / `Session Id`

**Email Sends:**
- `Last Event At` / `Delivered/Opened/Clicked At`
- `Open Count` / `Click Count`

**Conversations:**
- `Recording URL` / `Transcript` / `Call Duration Seconds` / `Call Sid`

## Env vars (new)

All OFF by default:
- `ENABLE_RESERVATION_HOLD` (F7)
- `RESERVATION_HOLD_PRICE_CENTS` (F7; default 4900)
- `ENABLE_WHITE_GLOVE` (F8)
- `WHITE_GLOVE_PRICE_CENTS` (F8; default 49700)
- `ENABLE_SMS` (F9)
- `NEXT_PUBLIC_REQUIRE_PHONE` (F10; default '1' = required)
- `ENABLE_CLICK_TO_CALL` (F11)
- `BHC_OPERATOR_PHONE` (F11)

## What to do tomorrow

1. **Test Meta Events Manager:** synthetic buyer journey → verify all 5 events fire deduped
2. **Add Resend webhook subscriptions:** delivered + opened + clicked → engagement data flows
3. **Watch funnel.bySource:** which UTM converted overnight?
4. **Watch NBA widget:** are P1 calls being made within 60min?
5. **Check `/admin/migration`:** any legacy ranchers ready for tier_v2 outreach?
6. **Decide flag flips:** ready for $49 hold or $497 white glove?

## Rollback strategy

Each feature has its own commit + revert path. See `BUILD_LOG.md` per-feature `Rollback:` line. Most schema additions are harmless if unused.

## What's not built (deferred)

- F11 desk UI button (helper ready, button not wired)
- F8 wizard sign-step opt-in (endpoint ready, wizard checkbox not added)
- F9 remaining 4 SMS event sites (helper ready)
- Drag-to-stage UX (F12 used buttons instead — simpler)
- Resend `email.delivered/opened/clicked` subscriptions (Resend dashboard config, user action)
- Twilio Voice config (user has not set up Twilio yet)
