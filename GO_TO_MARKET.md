# BHC GO-TO-MARKET — what's shipped + how to use it

Built 2026-06-09. Updated as each feature ships.

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
| `/access` | ✅ mission in footer, voice clean |
| `/qualify/[id]` | ✅ buyer voice clean |
| `/matched` | ✅ buyer voice clean |
| `/partner` | ✅ infra voice clean |
| `/founders` | ✅ mission + infra paragraph |
| `/rancher` | ✅ infra voice |
| `/rancher/setup` | ✅ wizard infra voice |
| `/admin/today/v2` | ✅ operator pipeline view |
| `/admin/migration` | ✅ admin tracker |

## What you do daily

1. Open `/admin/today/v2` — single login screen
2. See: Cal calls today, quiz-complete buyers awaiting outreach, deposits pending, $$ closed today
3. Take Cal calls from your inbox
4. Click "Send Invoice" per closed call → buyer gets Stripe Checkout link
5. Watch Telegram for `💸 Deposit invoice sent` → `🏦 Stripe Connect active` → closed loop

## Critical paths to watch (Telegram)

- `🏦 STRIPE CONNECT ACTIVE — <Ranch>` — rancher just finished KYC
- `💸 Deposit invoice sent — <buyer>` — admin Send Invoice fired
- `↩️ Deposit refunded — PI <id>` — buyer changed mind
- `⚠️ CAL WEBHOOK ERROR` — Cal handler exception (200 returned but logged)

## Build log

See `BUILD_LOG.md`.

## Conversion tracking (F2)

5 events fire per buyer journey via Meta CAPI + client Pixel (deduped via event_id):

1. **Lead** — `/access` signup (was already wired)
2. **CompleteRegistration** — quiz submit (NEW F2)
3. **Schedule** — Cal booking created (NEW F2)
4. **InitiateCheckout** — admin Send Deposit Invoice fires (NEW F2)
5. **Purchase** — Stripe webhook on deposit paid (was already wired)

**Meta Events Manager verification (do this before turning on ads):**
- Open Events Manager → Test Events
- Submit a synthetic quiz on prod
- Expect all 5 events to fire within minutes
- Match Quality score per event: aim ≥6/10
- Dedup score: 100% (same event_id from client + server)

## Known limitations / next features

F3 next: funnel observability — UTM viz in admin + funnel-stage analytics dashboard.
