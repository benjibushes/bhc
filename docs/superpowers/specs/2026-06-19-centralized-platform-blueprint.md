# BHC Centralized Platform Blueprint — "Modern Sales Infrastructure for DTC Beef"

**Date:** 2026-06-19
**Status:** Strategy / north-star blueprint (produced by a 6-agent audit of the live codebase). Not yet a build plan — this is the map. Each phase becomes its own spec → plan → build.

---

## North Star

> **Become the system-of-record for the DEAL — not the email tool.**

Every customer goes: **match → conversation → call → deposit (NRD lock) → fulfillment → beef in freezer**, and every step lives on buyhalfcow.com's own rails. One **Deal object** with one explicit **state machine** is the spine; every notification, every console column, and every "what do I do next" card derives from that single state. Ranchers get a push on their phone telling them the exact next action with a one-tap way to do it. Email/SMS/push/Telegram are **delivery channels** that fan a message OUT and route replies BACK IN — none is the source of truth.

**Decisive scope call:** BHC is ~70% built. The gap is **config + 3 new surfaces** (a Deal state machine, an operator inbox, a PWA) — **NOT a rewrite.**

**Sequencing law:** do NOT build push or the native app before the Deal state machine and the conversation loop exist, or you just move the fragmentation to a new layer.

---

## The core architecture decision: TWO systems of record

| System | Stays / Moves | What lives there |
|---|---|---|
| **Business SoR** | **Stays Airtable** | Referrals, Consumers, Ranchers, Payments, deposits, Stripe Connect, the 37 crons. Coupled to Stripe + cron logic — migrating is a risky big-bang for zero close-rate gain. |
| **Communication SoR** | **Moves to Supabase Postgres** | threads / messages / participants / push_subscriptions. Chat needs sub-50ms reads, per-participant read state, and realtime — none of which Airtable gives. |

Cross-link by storing Airtable record IDs as columns. **Supabase is already in `package.json` (installed, zero usage today)** — this activates paid-for capability, not a new vendor.

> **Why this matters:** today's rancher inbox (`app/api/rancher/inbox/route.ts`) does an N+1 scan (one `getAllRecords` per thread inside `.map()`), capped at 50, with zero polling/sockets. That can't become a real-time platform. Airtable's hard ceiling is also near: **5 requests/sec per base on every tier**, record caps, and 37 crons already hammering one base.

### The layers (end to end)
1. **Deal state machine** (NEW `lib/deal/state.ts`) — one ordered enum: `NEW → MATCHED → INTRO_SENT → IN_CONVERSATION → CALL_BOOKED → CALL_DONE → DEPOSIT_PENDING → DEPOSIT_PAID → SLOT_LOCKED(NRD) → IN_FULFILLMENT → READY → SCHEDULED → IN_TRANSIT → DELIVERED → CLOSED_WON` (+ side-exits `CLOSED_LOST` / `REFUNDED`). One `transition(deal, event, actor)` validates the move, writes Status + timestamp, emits a typed event, writes an audit row. **Replaces the ~12 sprawled Status string literals** (verified: 97× `'Closed Won'`, 73× `'Intro Sent'`, and a close-detector querying statuses that aren't consistently written — that inconsistency is the bug).
2. **Event/notify backbone** (NEW `lib/notify/`) — every deal event + every new message flows through ONE `notifyParticipants()` dispatcher. Presence-aware de-dupe (skip push/SMS if the recipient is live in-thread).
3. **Realtime transport** — Supabase Realtime via Broadcast-from-Database (Postgres trigger → `realtime.broadcast_changes()`), channel per thread. Vercel serverless **cannot** hold WebSockets, so a managed socket layer is mandatory; Supabase Realtime is already paid for and BHC's volume is ~100× under the free ceiling.
4. **Inbound convergence** — email replies (Resend Inbound), SMS replies (Twilio), and Telegram operator replies ALL write through the same `postMessage()`. One thread, one log.
5. **Surfaces** — buyer ask page + rancher inbox (subscribe to Realtime, delete the manual-refresh hack), NEW `/admin/inbox` operator cockpit, NEW buyer fulfillment tracker, PWA shell for rancher push.
6. **Money rail unchanged** — Stripe Connect V2 deposit path is fully built. Just surface deposit CTAs IN the thread + as push instead of email links.

---

## The comms spine (~70% built — "dead replies" is 3 unfinished setup steps)

`app/api/webhooks/resend-inbound/route.ts` is **complete** (Svix verify, Claude-Haiku objection/sentiment/action classification, from-email fallback, routes into `postMessage()`, mirrors to Telegram with one-tap Close-Won). It **fails closed in production**: if `RESEND_INBOUND_WEBHOOK_SECRET` is unset it returns 401 — so **replies are dropped today.**

**The fix (mostly DNS + dashboard):**
1. MX + SPF/DKIM on `replies.buyhalfcow.com`
2. Resend Inbound catch-all → `https://www.buyhalfcow.com/api/webhooks/resend-inbound`
3. Set `RESEND_INBOUND_WEBHOOK_SECRET` in Vercel

**This is the single highest-ROI move on the board.**

### Operator cockpit (NEW `/admin/inbox` — the missing surface)
21 admin pages exist; none is an inbox. 3-pane: thread list (real unread badges) | conversation | deal-context rail (Airtable stage / deposit / NRD-lock). Ben works EVERY live deal here, sends as "operator" (fans to buyer + rancher via their preferred channel), sees AI classification inline, one-tap advance / Close-Won. **Telegram stays as the mobile alert layer that deep-links into the console — not the primary surface.**

---

## The mobile app: a notification engine, not "an app"

The deliverable is a **state-transition notification engine** wired to the Deal state machine: on every meaningful transition, ping the right rancher with ONE tappable card = exact next action + one-tap way to do it + inline "how" (steps + 20s Loom). Build that ONCE behind a transport-agnostic `send()` seam, then climb the channel ladder. **Today there is ZERO rancher push** (verified: no web-push / PWA / service-worker / manifest / Expo / FCM / APNs anywhere).

| Phase | Channel | Why | Status |
|---|---|---|---|
| **1** | **SMS (Twilio)** | Highest "act-now" deliverability, zero app-store friction, ships in ~1–2 wks. `lib/twilio.ts` + `lib/smsEvents.ts` (7 templates, TCPA gate) **already written** — just gated behind absent `TWILIO_*` env vars. | Code done, env absent |
| **2** | **PWA + Web Push (VAPID, self-hosted)** | Delivers the "push on their phone" vision at **~$0/message on BHC's own rails**. iOS 16.4+ (after Add-to-Home-Screen) + all Android/desktop. SMS stays the floor. | Not built |
| **3** | **Native app (Expo/React Native)** | ONLY when web-push opt-in/reliability proves insufficient (native ~10× opt-in, ~95% vs ~33% delivery). Thin shell over the same API — mostly UI, not a rebuild. | Gated |

**Decisive vendor calls:** self-hosted Web Push (VAPID) over OneSignal for Phase 2 ($0/msg, no SDK for a ~40-rancher base). Keep Twilio short-term (code exists); Telnyx saves ~half/msg but that's dollars/month at this volume. Do NOT lead with native.

---

## Own the sale (the close half leaks: 131 warm matched, ~2 close/mo)

The close primitives are **already built** — they just don't share one state source: deposit checkout, NRD lock, final invoice, off-platform close-confirm, on-platform threads, `/admin/today` desk, close-detector cron, Cal webhook.

**Fix the connective tissue:**
1. **Deal state machine** (keystone) — makes the operator console trustworthy, unlocks reliable Kanban + every notification.
2. **Native booking** — wrap the existing `lib/calBooking.ts` resolver in a `/book/[refId]` page on BHC chrome so the buyer never visibly leaves. (Cal.com `@calcom/atoms` is already a dependency.)
3. **Buyer fulfillment tracker** (`/checkout/[refId]/track`) — live "where's my beef" timeline. Today fulfillment is a single binary flag, so post-deposit buyers go dark and bounce.
4. **Turn the conversation ON** (the 3 inbound steps).
5. **`/admin/today` → Deal-state Kanban** with one-click advance/close.
6. **Rancher fulfillment pipeline** — Mark Ready → Schedule → In-Transit → Delivered (LATER).

---

## Integrations — what we need access to, who sets it up, what it costs

### Already live (finish config — no new vendor)
| Service | Action | Owner |
|---|---|---|
| **Resend** | Enable Inbound webhook + subscribe to bounced/complained. DNS (MX on replies subdomain, SPF/DKIM/DMARC). Handlers already written. | **Ben** (DNS + dashboard) |
| **Stripe Connect V2** | No change to rail. Surface deposit CTAs in-thread + as push. | Eng |
| **Cal.com** | Re-brand the embed in-product via `@calcom/atoms` (already installed). | Eng |
| **Telegram** | Stays as-is (operator channel). | None |
| **Vercel Crons** (37) | Continue orchestrating notify() fan-out. | Eng |

### New / to light up (in build order)
| Service | Purpose | Cost | Owner |
|---|---|---|---|
| **Twilio** | Phase-1 SMS wake-up + magic-link transport. A2P 10DLC brand+campaign. Add `TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM_NUMBER` + `BHC_OPERATOR_PHONE` to Vercel. | ~$0.011–0.013/SMS all-in | **Ben** opens acct + 10DLC; eng flips on |
| **Supabase** | The new backbone — Postgres comms SoR + Realtime + (later) Auth + Storage. | Free now → Pro $25/mo at scale | **Ben** creates org/project; eng owns schema/migration/RLS |
| **Web Push / VAPID** | Phase-2 free push from the PWA. `npx web-push generate-vapid-keys` → Vercel env. | $0 | Eng (no external acct) |
| **Apple Developer** | Phase-3 ONLY — iOS app + APNs key. | $99/yr | **Ben** enrolls |
| **Google Play Console** | Phase-3 ONLY — Android app. First review up to ~7 days. | $25 one-time | **Ben** registers |
| **Firebase (FCM)** | Phase-3 ONLY — Android push rail. | Free | Ben/eng |
| **Expo / EAS** | Phase-3 ONLY — build iOS+Android from one codebase, OTA updates. | Free → $19/mo if OTA MAU > 1k | **Ben** acct; eng configures |
| **OneSignal** *(optional)* | Phase-3 push fanout w/ segmentation+analytics. Alternative to free Expo Push. | Free (unlimited mobile push) | Ben acct; eng SDK |
| **Telnyx** *(later)* | Cost-optimized SMS (~half Twilio). Migrate only if volume justifies. | ~$0.004/segment | Ben acct; eng ports lib |
| **Clerk** *(alt)* | Drop-in auth for web+mobile IF not using Supabase Auth. | Free tier | Ben acct; eng integrates |

---

## Ben's setup checklist (ordered — engineering can't start the gated items without these)

**WEEK 1 (highest ROI, mostly DNS/dashboard):**
1. **Capture rancher phone numbers** (the long pole — blocks ALL SMS). Add a PHONE field + collect in the v2 wizard + Cal booking. *Nothing texts a rancher until this exists.*
2. **Turn the inbound email loop ON** — (a) MX + SPF/DKIM on `replies.buyhalfcow.com`; (b) Resend Inbound catch-all → the webhook URL; (c) set `RESEND_INBOUND_WEBHOOK_SECRET` in Vercel.
3. **Fix email deliverability** — dedicated send subdomain w/ SPF+DKIM+DMARC; add a Resend webhook on `email.bounced` + `email.complained` to auto-suppress dead addresses.
4. **Create the Airtable "Conversations" table** (fields listed atop the inbound route) so the handler has somewhere to write until data moves to Postgres.

**WEEK 1–2:**
5. **SMS via Twilio** — create account, buy a US 10DLC number, register A2P 10DLC Brand + Campaign (have business name/EIN + sample messages + opt-in description ready — campaign approval takes a few business days, **start now**). Add the `TWILIO_*` + `BHC_OPERATOR_PHONE` env vars.

**WEEK 2:**
6. **Stand up Supabase** — create org/project (Free tier covers BHC now), put `SUPABASE_URL` + anon key + service-role key in Vercel. Eng owns schema/migration/Realtime/RLS.

**WEEK 3–4:**
7. **Generate Web Push VAPID keys** (`npx web-push generate-vapid-keys`) → `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` in Vercel.

**ONGOING:**
8. **Vercel env hygiene** — add every key to BOTH Production and Preview. (Several coded features are dark in prod today precisely because `TWILIO_*` / `BHC_OPERATOR_PHONE` / Supabase keys are absent.)
9. **Decide quiet-hours + frequency policy** with eng before any push/SMS ships — suggest max 1 nudge/state, ~3/day cap, none 9pm–7am rancher-local, `last_notified_state` idempotency. (Guardrail against the 2026-05-06 incident: 109 stale pushes.)

**PHASE 3 ONLY (gate until web-push proves insufficient):**
10. Apple Developer ($99/yr, needs D-U-N-S), Google Play ($25), Firebase project (FCM JSON), Expo/EAS account. Kick off Apple + Google ~2 weeks before you want the app live.

---

## Roadmap

| Phase | Window | Goal | Builds |
|---|---|---|---|
| **0 — Stop the bleeding** | Days, ~zero new code | Recover LOST conversations + kill spam — fastest close-rate lever, code already exists | The 3 Resend inbound steps + send-subdomain SPF/DKIM/DMARC + bounce/complaint suppression. Verify by replying to a thread email and watching it land in the inbox + Telegram. |
| **1 — Deal state machine + SMS wake-up** | Wks 1–3 | One trustworthy deal-state source; ranchers actually told what to do | `lib/deal/state.ts` + refactor all close routes/webhooks to `transition()`. Next-Action engine + `send()` seam. Light up Twilio SMS deep-linking to mobile-first `/r/*` action pages behind magic-link auth. |
| **2 — Comms spine on Postgres** | Wks 3–7 | Every deal a durable real-time thread; replies never lost; operator works every deal in one place | Supabase schema + `lib/threads` Postgres module (one-import swap) + backfill. Broadcast-from-DB trigger. Buyer ask page + rancher inbox subscribe to Realtime. NEW `/admin/inbox` cockpit. Buyer fulfillment tracker. `/book/[refId]`. `/admin/today` → Kanban. |
| **3 — Push fan-out + PWA** | Wks 7–11 | The headline vision — "New buyer message — tap to reply" on their phone, ~$0/msg | PWA manifest + service worker + self-hosted Web Push. Unified `notifyParticipants()` w/ presence-aware de-dupe. Twilio inbound-SMS webhook. Telegram replies route through `postMessage()`. Multi-stage rancher fulfillment pipeline. |
| **4 — Own it end-to-end** | Wks 11+, demand-gated | Self-contained platform; native app + full booking ownership ONLY when data justifies cost | AI-suggested replies + SLA nudges. Native scheduling to retire Cal. Native Expo app (thin shell). Optional Telnyx migration. Demote ~20 low-impact crons now event-driven. |

---

## "Done" — the credible claim to "modern sales infrastructure for DTC beef"

A rancher wakes up to a push — *"New paid deposit from [buyer] — accept the slot"* — taps it, lands in-app, accepts, and the buyer instantly sees "Slot locked" on their live fulfillment tracker — **no external link, no lost email.** Concretely, ALL of:

1. A buyer can go match → conversation → booked call → deposit → fulfillment → delivered **entirely on buyhalfcow.com**.
2. Every buyer/rancher/operator reply lands in ONE durable thread, never lost (inbound loop live, threads on Postgres, real read state).
3. ONE Deal state machine is the single source the operator Kanban, the buyer tracker, and every notification derive from — no sprawled Status strings.
4. Ranchers receive real push (SMS floor + web-push) telling them the exact next action with a one-tap way to do it, governed by quiet-hours + idempotency.
5. The operator runs every live deal from `/admin/inbox` with deal context + AI classification; Telegram demoted to mobile alert.
6. Email/SMS/push/Telegram are delivery channels, not the system of record.

**Measurable bar:** ranchers open intros/messages within ~1h (vs ~15% email click-through), inbound replies = 0 lost, close rate moves off ~2/month.

---

## Risks (the 9 the audit flagged)

1. **Big-bang DB migration temptation** — migrate ONLY the chat domain; keep business SoR on Airtable; cross-link by ID. Hold this line against scope creep.
2. **Sequencing inversion** — building push/native before the state machine + conversation loop just relocates the fragmentation. State machine and inbound loop FIRST.
3. **Notification mass-misfire** (the 2026-05-06 pattern: 109 stale pushes) — `last_notified_state` idempotency + max-1-nudge-per-state + daily cap + quiet hours baked in BEFORE any channel ships. Route bulk sends through `bhc-mutation-guardrails`.
4. **Email deliverability stays broken** — undermines the async fallback. Dedicated send subdomain + DMARC + bounce/complaint suppression in Phase 0, not later.
5. **TCPA/A2P compliance on SMS** — explicit opt-in stored (gate exists), STOP/HELP copy, A2P brand+campaign before first send.
6. **Rancher phone-capture lag** — SMS impossible without numbers; capture is the long pole. Start week 1 regardless of build order.
7. **Inbound spam stripping Reply-To** — the from-email fallback is already coded; keep it belt-and-suspenders; monitor unmatched inbound.
8. **Realtime/RLS exposure** — a wrong RLS policy could leak one deal's thread to another party. Per-thread channel + strict RLS scoped to participants; review before backfill; never broadcast bodies on a shared channel.
9. **Two parallel message logs during cutover** — Postgres `messages` subsumes the Airtable Conversations table; retire the Airtable write once backfilled + verified.
