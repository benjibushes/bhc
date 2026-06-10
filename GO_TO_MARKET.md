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

## Funnel observability (F3)

`/admin/today/v2` now shows a 30-day funnel:
- **Stage tiles**: signup, qualified, booked, invoiced, locked, closed
- **Conversion strip**: % between each pair + overall signup→closed
- **Per-source table**: top 10 UTM sources sorted by signup volume

**Endpoint:** `GET /api/admin/funnel-conversion?since=7d|30d|90d|all`

**Use it:**
- After a paid-ad push, watch the bySource table — which UTM Source closed?
- If `qualified→booked` drops, Cal flow has friction
- If `booked→invoiced` drops, calls aren't closing → check call recordings (F11 incoming)

## Known limitations / next features

F4 next: composite lead score on each Consumer card — sort desk by hottest lead first.
