# Unified Sales Desk — Spec + Plan

**Goal:** Replace `/admin/today` + `/admin/referrals` with ONE mobile-first cockpit where every deal is an action card, tapping a deal shows the COMPLETE customer journey, and every operator function (route, reroute, unlock, contact, close, approve, adjust, revive, go-live, etc.) is one tap away.

**Owner intent (verbatim):** "full capability to reroute and see what the customer journey has been and if they responded to something… any and all functions."

**Architecture:** one new page `/admin/desk` (the queue) + a deal cockpit (`/admin/desk/[referralId]`) that loads a journey timeline from a new read-only aggregator endpoint, with an action rail that calls the existing (and a few new) operator endpoints. Mobile-first cards, urgency-sorted. Old pages kept reachable but de-linked from nav.

**Tech:** Next 16 App Router, Airtable (`lib/airtable`), existing operator endpoints, `requireRole(['admin','onboarding'])`.

---

## Components

### 1. Journey aggregator — `GET /api/admin/deal/[referralId]/journey`
Read-only. Anchor = referral; hydrate buyer + rancher; parallel-load + merge into a sorted `JourneyEvent[]`:
- **Referrals** → milestone stamps (Created, Intro Sent, Rancher Accepted, Deposit Paid, Closed) + reroute notes.
- **Consumers** → signup, source/intent, Buyer Stage changes, Warmup Sent/Engaged.
- **Conversations** (`SEARCH(refId, ARRAYJOIN({Linked Referral}))`) → inbound replies + sentiment/objection/AI summary = the "did they respond" signal.
- **Email Sends** (by Recipient Consumer) → what we sent + status (sent/suppressed/bounced).
- **Funnel Events** (by Referral) → signup/engaged/stage/close/deposit_paid.
- **Payments** (by Referral) → deposit lifecycle.
- **Threads + Thread Messages** (by Referral) → on-platform buyer↔rancher messages.
Each source wrapped in its own try/catch (a missing table/field degrades to "no events", never 500s). Output: `{ referral, buyer, rancher, events: JourneyEvent[], responded: boolean, lastInbound?: {...}, nextAction: string }`.
`JourneyEvent = { at: ISO, type, actor, summary, source, sentiment? }`. `nextAction` = derived suggestion (e.g. "Awaiting rancher reply 6d → nudge or reroute").

### 2. Desk queue — `app/admin/desk/page.tsx`
Mobile-first card stack, urgency-sorted. Reuses the existing `/api/admin/referrals` list data (or a focused list endpoint). Top: attention chips (counts: to-approve, stalled, unmatched, awaiting-payment). Each card: buyer (name/state/tier/intent), matched rancher + status pill, a one-line "next action" + last-activity age, and an inline action row (the 2-3 most relevant actions for that state). Tapping the card → cockpit. Filters/search retained. Buckets: Unmatched, Pending approval, Active (intro/contacted/negotiation), Awaiting payment, Recently closed.

### 3. Deal cockpit — `app/admin/desk/[referralId]/page.tsx` (or slide-over)
Full deal view: header (buyer + rancher + status + key money), the **journey timeline** (chronological, reply sentiment colored, what-we-sent vs what-they-said), and the **full action rail** — every applicable action for the deal's state.

### 4. Actions — wire ALL
Existing (already have endpoints): approve (`/api/referrals/[id]/approve`), reroute (`/api/admin/referrals/[id]/reassign`), resend-intro, change status / close-won (`/api/referrals/[id]` PATCH), adjust-commission, revive, mark-paid; rancher: go-live/pause/resume/resync. 
**New endpoints to build:**
- `POST /api/admin/deal/route-buyer` — manual route an unmatched/approved buyer to a chosen rancher (wraps existing `manual-create` logic / matching create). 
- `POST /api/admin/deal/[referralId]/rematch` — re-run `/api/matching/suggest` for a stuck buyer.
- Unlock override on reassign — surface the existing `unlockOverride` flag as a UI affordance.
- `POST /api/admin/consumers/[id]/resend-warmup` — already exists, just wire a button.
(Bulk reroute = v2.)

### 5. Nav + roles
`requireRole(['admin','onboarding'])` on the new endpoints. `app/admin/nav.ts`: add "Sales desk" (→ `/admin/desk`), repoint/retire the "Today" + "Referrals" entries (keep routes alive, drop from primary nav). Main `/admin` landing: add a prominent "Open Sales Desk" CTA; trim the redundant tabbed lists later.

---

## Out of scope (v1)
Bulk reroute; Cal.com booking webhook (no call-booked event persisted today — a data gap, separate); email open/click tracking; pageview/login timeline. Note these as known gaps.

---

## Task plan (each leaves the system working)

- [ ] **T1 — Journey aggregator endpoint** (`/api/admin/deal/[referralId]/journey`). Read-only, per-source try/catch, returns sorted events + responded/nextAction. Verify against a real referral id.
- [ ] **T2 — Deal cockpit page** consuming T1: header + timeline render (sentiment-colored replies). Read-only first (no actions yet) so it's shippable.
- [ ] **T3 — Action rail** on the cockpit: wire all EXISTING actions (approve/reroute/status/close/adjust/revive/mark-paid + rancher go-live/pause/resync). Each calls its endpoint, optimistic refresh.
- [ ] **T4 — New action endpoints**: route-buyer, rematch, unlock-reroute affordance, resend-warmup button. Gated `['admin','onboarding']`.
- [ ] **T5 — Desk queue page** (`/admin/desk`): urgency-sorted card stack + attention chips + inline quick-actions + link to cockpit. Reuse the referrals list data.
- [ ] **T6 — Nav + landing**: add Sales Desk to nav, repoint Today/Referrals, add landing CTA. Role-gate.
- [ ] **T7 — Verify end-to-end** on a Vercel preview / locally: load a real deal, see its journey, take a reroute action, confirm it persists.
