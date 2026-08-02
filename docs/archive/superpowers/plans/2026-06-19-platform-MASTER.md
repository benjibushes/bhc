# BHC Centralized Platform — MASTER Build Plan

> **For agentic workers:** This is the master index. Each phase below is its own detailed plan in `docs/superpowers/plans/`. Build phases IN ORDER. Each phase ships working software on its own and is feature-flagged so it can go live the moment Ben finishes that phase's setup gate.

**Goal:** Turn BHC from an email-marketing layer into the system-of-record for the DEAL — every customer goes match → conversation → call → deposit → fulfillment → beef-in-freezer on buyhalfcow.com's own rails, with ranchers pushed the exact next action on their phone.

**Build philosophy (Ben's words: "make the fixes, I'll set up everything, then we fire"):**
> **Build dark → Ben provisions → flip and fire.** Every integration ships behind an env flag that no-ops until the credential exists (the codebase already does this — `ENABLE_SMS`, `RESEND_*_WEBHOOK_SECRET` fail-closed, Twilio skips on missing creds). So engineering can build and merge every phase to `main` WITHOUT touching production behavior. Each phase goes live only when Ben adds that phase's env/DNS. No big-bang, no risk to the live v2 migration.

**Tech stack:** Next.js 16 (App Router) · Airtable (business SoR) · **Supabase Postgres + Realtime (NEW — comms SoR)** · Resend (email + inbound) · Twilio (SMS) · Web Push/VAPID (PWA) · Expo (Phase 3 native) · Stripe Connect V2 · Cal.com · Telegram (operator) · Upstash Redis.

---

## The one law

**Do NOT build push or the native app before the Deal state machine + conversation loop exist.** Build them out of order and you just relocate the fragmentation to a louder channel. Order is load-bearing.

---

## Phase sequence + dependency graph

```
Phase 0 ──┐  (config only, ~0 new code)  → recovers lost replies + kills spam
          │
Phase 1 ──┼──→ Deal state machine (lib/deal/state.ts) is the KEYSTONE.
          │    Everything downstream reads deal state from here.
          │    + Rancher SMS wake-up (Twilio, already coded).
          │
Phase 2 ──┼──→ Comms spine on Supabase (swap behind lib/contracts/threads.ts)
          │    + operator inbox + buyer fulfillment tracker + on-platform booking.
          │    Depends on: Phase 1 state machine (the context rail reads deal state).
          │
Phase 3 ──┼──→ PWA + Web Push fan-out. notifyParticipants() dispatcher.
          │    Depends on: Phase 1 (events) + Phase 2 (threads to notify about).
          │
Phase 4 ──┘  Native Expo app + full booking ownership. DEMAND-GATED —
             only if web-push opt-in/reliability proves insufficient.
```

| Phase | File | Builds | Ships when Ben does |
|---|---|---|---|
| **0** | `2026-06-19-phase-0-inbound-revival.md` | Turn on inbound replies + bounce suppression + deliverability. ~0 new code. | DNS on `replies.buyhalfcow.com` + 2 Resend dashboard endpoints + 2 env secrets |
| **1** | `2026-06-19-phase-1-deal-state-and-sms.md` | `lib/deal/state.ts` state machine; refactor all Status writers to `transition()`; rancher SMS wake-up + `/r/*` action pages. | Twilio account + 10DLC + `TWILIO_*` env |
| **2** | *(written when Phase 1 lands)* | Supabase schema; `lib/threads` Postgres module (one-import swap); Realtime; `/admin/inbox`; buyer fulfillment tracker; `/book/[refId]`. | Supabase project + `SUPABASE_*` env |
| **3** | *(written when Phase 2 lands)* | PWA manifest + service worker + self-hosted Web Push; `notifyParticipants()` unified dispatcher; Twilio inbound webhook. | VAPID keys (`npx web-push generate-vapid-keys`) |
| **4** | *(written when Phase 3 lands)* | Native Expo app (thin shell over Phase 1 API); native scheduling; optional Telnyx. | Apple Dev $99/yr · Google Play $25 · Firebase · Expo/EAS |

Phases 2–4 get their full task-by-task plans authored when the prior phase lands — their exact tasks depend on Phase 1's `transition()` signature and Phase 2's schema, so writing them now would be speculative (YAGNI). The **setup gate below covers all 4 phases now** so Ben can provision everything in parallel.

---

# THE SETUP GATE — everything Ben provisions (do this now, in parallel)

Work top-down. Each row says exactly what to create, the **exact env var names** engineering expects, and which phase it unblocks. **Add every env var to BOTH Vercel Production AND Preview** (several coded features are dark today purely because vars are missing from the deployed env). Ben supplies the secret values — engineering never pastes secrets into prod.

## Gate 0 — Inbound replies + deliverability (unblocks Phase 0) — **highest ROI, do first**

| # | Action | Where | Engineering needs |
|---|---|---|---|
| 0.1 | Add **MX** record on `replies.buyhalfcow.com` → the MX target Resend's Inbound page shows. Add the **SPF/DKIM** records Resend lists for that subdomain. | DNS (registrar / Vercel DNS) | — |
| 0.2 | In **Resend → Inbound**, add a catch-all route for `*@replies.buyhalfcow.com` → endpoint `https://www.buyhalfcow.com/api/webhooks/resend-inbound`. Copy the signing secret. | Resend dashboard | `RESEND_INBOUND_WEBHOOK_SECRET` = that secret |
| 0.3 | In **Resend → Webhooks**, add an endpoint `https://www.buyhalfcow.com/api/webhooks/resend` subscribed to **`email.bounced` + `email.complained`** (add `email.delivered`/`opened`/`clicked` too — handler already supports them). Copy the signing secret. | Resend dashboard | `RESEND_WEBHOOK_SECRET` = that secret |
| 0.4 | Confirm the **send subdomain** is green in Resend with SPF + DKIM, and add a **DMARC** TXT record (`v=DMARC1; p=quarantine; rua=mailto:dmarc@buyhalfcow.com`) on the root if not present. | Resend + DNS | — |
| 0.5 | Add both secrets to Vercel **Production + Preview**, redeploy. | Vercel env | (the two vars above) |

> **Why this is #1:** both webhook handlers are fully built and **fail closed** in production today (`resend-inbound/route.ts:251-256`, `resend/route.ts:49-62` — they 401 every request when the secret is unset). So **every inbound reply is being dropped right now**, and bounces aren't suppressing dead addresses (which is poisoning your sender reputation → spam). This is the single highest-leverage hour on the whole board, and it's pure dashboard + DNS.

## Gate 1 — Rancher SMS wake-up (unblocks Phase 1 go-live)

| # | Action | Where | Engineering needs |
|---|---|---|---|
| 1.1 | Create a **Twilio** account. Buy one **US 10DLC** long-code number. | Twilio console | — |
| 1.2 | Register **A2P 10DLC**: Brand (business name + EIN) + Campaign. Pick "Sole Proprietor" or "Low-Volume Standard." Have ready: 2–3 sample messages, opt-in description, and STOP/HELP copy. **Start now — campaign approval takes a few business days.** | Twilio console | — |
| 1.3 | Add to Vercel **Production + Preview**: | Vercel env | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` (E.164, e.g. `+1512...`), `BHC_OPERATOR_PHONE` (your cell, E.164), and `ENABLE_SMS=1` |
| 1.4 | Decide the **quiet-hours + frequency policy** with engineering (recommended: max 1 nudge per deal-state, ~3/day cap, none 9pm–7am rancher-local). | Decision | — |

> **Recon correction:** the rancher `Phone` field already exists and is populated for 160+ ranchers — you do NOT need a phone-capture project. What Phase 1 adds is rancher **SMS opt-in capture** (a TCPA consent checkbox in the wizard) + rancher-directed templates. Engineering handles both.

## Gate 2 — Supabase comms backbone (unblocks Phase 2)

| # | Action | Where | Engineering needs |
|---|---|---|---|
| 2.1 | Create a **Supabase** org + project (Free tier covers BHC now; Pro $25/mo only when limits approach). Pick a region near your Vercel region. | supabase.com | — |
| 2.2 | Copy the project URL + the **anon** key + the **service-role** key into Vercel **Production + Preview**. | Vercel env | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` |

> Supabase SDK (`@supabase/supabase-js@2.91.1`) is **already installed and unused** — this activates a paid-for dependency, not a new vendor. Engineering owns schema, migration, Realtime, and RLS.

## Gate 3 — Web Push (unblocks Phase 3) — no external account

| # | Action | Where | Engineering needs |
|---|---|---|---|
| 3.1 | Generate a VAPID keypair: `npx web-push generate-vapid-keys`. | Your terminal (or eng) | `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (=`mailto:ben@buyhalfcow.com`) |

## Gate 4 — Native app (unblocks Phase 4) — **only when we get there, don't spend yet**

| # | Action | Cost | When |
|---|---|---|---|
| 4.1 | **Apple Developer Program** enrollment (needs a D-U-N-S number for the business entity). Create an APNs `.p8` auth key; note Key ID + Team ID. | $99/yr | ~2 wks before app launch — Apple verification takes days |
| 4.2 | **Google Play Console** registration + identity verification. | $25 once | First review up to ~7 days |
| 4.3 | **Firebase** project for FCM; download the FCM V1 service-account JSON. | Free | With 4.1/4.2 |
| 4.4 | **Expo / EAS** account (Free to launch; $19/mo Starter only if OTA MAU > 1k). | Free | At build time |

---

## Definition of "done" — the credible claim to "modern sales infrastructure for DTC beef"

All six, measurable:
1. A buyer goes match → conversation → booked call → deposit → fulfillment → delivered **entirely on buyhalfcow.com**.
2. Every buyer/rancher/operator reply lands in ONE durable thread, **never lost** (inbound loop live, threads on Postgres, real read state).
3. ONE Deal state machine is the single source the operator Kanban, the buyer tracker, and every notification derive from — no sprawled Status strings.
4. Ranchers get real push (SMS floor + web-push) with the exact next action + a one-tap way to do it, governed by quiet-hours + idempotency.
5. The operator runs every live deal from `/admin/inbox` with deal context + AI classification; Telegram demoted to mobile alert.
6. Email/SMS/push/Telegram are delivery channels, not the system of record.

**Measurable bar:** ranchers act on intros within ~1h (vs ~15% email CTR); inbound replies = 0 lost; close rate moves off ~2/month.

---

## Guardrails that bind every phase (non-negotiable)

- **Migration-safe:** the live v2 migration (14 invited ranchers, deadline ~2026-06-29) is untouchable. Do NOT touch: Migration Status/Deadline/Invite-Sent-At fields, the migration-deadline cron, send-v2-upgrade, /admin/migration, resync-connect, the stripe/stripe-connect/cal webhooks' existing branches, sign-agreement, checkout/deposit, lib/rancherEligibility, lib/tiers, JWT_SECRET/SITE_URL/webhook secrets, the wizard 0..9 step numbering, the `/rancher/setup?token` route contract.
- **`bhc-mutation-guardrails`:** any bulk send (push/SMS/email) requires per-record gate-mirroring + dry-run + side-effect inventory + idempotency. `last_notified_state` idempotency is mandatory before ANY notification channel ships (guardrail against the 2026-05-06 incident: 109 stale pushes).
- **AI never fires mass sends:** Ben taps Send. Engineering builds the queue; the human pulls the trigger.
- **Deploy via PR merge-to-main only.** Never `vercel promote`.
- **TDD per task** (subagent-driven-development): failing test → minimal code → green → commit.
