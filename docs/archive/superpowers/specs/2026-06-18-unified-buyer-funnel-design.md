# Unified Game-Like Buyer Funnel — Design Spec

**Date:** 2026-06-18
**Status:** Approved-in-concept (v2 mockup signed off). Pending written-spec review.

## Goal

One continuous, game-like flow that is **the single front door** for every beef buyer. It replaces both the `/access` signup form and the `/qualify` quiz with one wizard. It captures contact **mid-flow** (after the buyer has shown intent), so we stop creating email-only dead leads. Completing the flow = a qualified, routable buyer. Every entry point on the site funnels into it; the two junk-lead generators are deleted.

**Success criteria:** in-state quiz/flow completion climbs well above today's 4.8%; zero email-only `Pending` dead leads created; every buyer entry point lands in this one flow.

## The flow (5 steps)

A mobile-first, sealed (no nav/promo/footer — already enforced by `ChromeGate`), tap-driven wizard. One question per screen, auto-advance on single-select, a progress bar, on-brand (serif headers, saddle accent, founder voice, "private network" framing).

| Step | Screen | Captures | Behavior |
|---|---|---|---|
| 1 | **Size** — Quarter / Half / Whole / Not sure (feeds-N + price anchor) | `tier` | tap → auto-advance |
| 2 | **Timing** — Within a month / 1–3 months / Just browsing | `timing` | tap → auto-advance |
| 3 | **Claim your match** — first name, email, phone, **state** | contact + `state` | **Lead created here.** Trust line + testimonial. CTA "Show me my match" |
| 4 | **Storage** — Have freezer / Need space / Rancher holds | `storage` | tap → auto-advance |
| 5 | **Match reveal** — named rancher + next steps, or honest waitlist | finalize | completion fires matching |

Commitment ("ack") is folded into completing the flow — reaching step 5 *is* the commitment signal (replaces the old explicit checkbox).

### Conversion psychology (built into copy/layout, not bolted on)
- **Social proof:** "1,900+ families matched · 40+ verified ranches" (header); "you're family #1,901" (finish). *(Numbers must be pulled live from Airtable counts, not hardcoded — see Data.)*
- **Scarcity:** "each ranch takes only a handful of families" at the contact step.
- **Trust at the ask:** "private, approval-only · no spam · never resold" + a real testimonial placed exactly at the contact step (peak hesitation).
- **Goal-gradient:** "almost there — last one" + live step hint near the finish.
- **Value anchoring:** feeds 1–2 / 3–5 / 6+ on the size cards.
- **Human reveal:** matched with a named rancher (operator names), not "a rancher."

## Data lifecycle (the core change)

```
Steps 1–2 (size, timing)      → CLIENT STATE ONLY. No record. Tire-kickers leave no trace.
Step 3 (contact submit)       → CREATE Consumer:
                                   tier, timing, state, first name, email, phone, Source, UTMs
                                   Status = Approved, Buyer Stage = QUIZ_STARTED
                                   Qualified At = UNSET  → NOT routable yet (GUARD-2 holds)
                                 This is the lead — real intent, drip-eligible if they bail at step 4.
Step 5 (completion)           → WRITE storage answer + Qualification Score + Qualified At
                                 Buyer Stage → READY, fire /api/matching/suggest
                                 → MATCHED (or Waitlisted if no in-state rancher)
```

- **Scoring** reuses the existing quiz scorer (tier 25 / timing 25 / storage 25 / completion-ack 25; ≥75 passes). A serious buyer who completes hits ≥75. "Just browsing" timing (0 pts) + "Not sure" tier (5 pts) can keep a low-intent buyer under 75 → captured as a lead, nurtured, not force-routed. Policy preserved: **the quiz is the qualifier.**
- **State** captured at step 3 (geo-detect with a confirm/edit dropdown; fallback to a plain dropdown). Required for matching.
- **Live counts** ("1,900+ families", "family #N", "3 ranches near you") come from a small `GET /api/funnel/stats?state=XX` (cached) — never hardcoded, or the social proof goes stale/false.

## Routes & components

- **`/access`** = the unified flow (fresh entry, starts at step 1). The homepage, `/start`, rancher pages, and ad links already point here.
- **`/qualify/[consumerId]?token=`** = **resume** entry for an existing lead (the quiz-drip emails shipped today link here). The wizard detects a valid consumer+token and resumes at **step 4 (storage)** — they already gave size/timing/contact. Keeps every drip link working.
- **`BuyerFunnel`** — one client wizard component with two modes: `fresh` (no consumer → step 1) and `resume` (consumer+token → step 4). Internal step state, progress, transitions, validation.
- **`FunnelStep*`** — small per-step components (Size, Timing, Contact, Storage, Reveal), each one clear responsibility.

## APIs

- **`POST /api/consumers`** (adapt existing): create the lead at step 3 with tier+timing+state+contact, `Buyer Stage=QUIZ_STARTED`, no `Qualified At`. Returns `{ consumerId, resumeToken }` so the client can finalize. Upsert on duplicate email (no dup records).
- **`POST /api/qualify`** (adapt existing): finalize at step 5 — accept `storage`, compute score, write `Qualified At`, fire `matching/suggest`. Already does most of this; extend to accept the storage answer and to be called for a `QUIZ_STARTED` consumer.
- **`GET /api/funnel/stats`** (new, cached): families-matched count, verified-rancher count, ranches-in-state count. Powers the live social proof.

## What gets deleted

- **`ExitIntentModal`** + **`POST /api/consumers/quick`** — the email-only exit grab (36 leads, 0 conversions).
- **Email-blur abandoned capture** + **`POST /api/abandoned-app`** — moot now (email is step 3, there's no pre-submit blur), and it produced 170 leads, 0 conversions. Remove the blur trigger; retire or repurpose the route.
- **The old multi-field `/access` form** — replaced by the wizard.
- **The duplicate timing question** (was asked on `/access` *and* in the quiz).

## Universal entry ("everybody goes through this")

Audit + repoint every buyer entry to `/access` (the flow): homepage CTA(s), `/start` audience cards, `/ranchers/[slug]` ("?rancher=" still prefills the pinned rancher through the flow), ManyChat/IG webhook landing, any ad/UTM landing. No buyer path bypasses the flow.

## Extensibility: the operator sales-call flip (the next flip you'll want)

The reveal (step 5) is **config-driven** so it can switch from "your rancher reaches out" to **"book your call with Ben"** the day you start taking sales calls — with **no redeploy**.

- A runtime operator-config flag `funnelOfferOperatorCall` (`lib/adminConfig.ts`, toggled in `/admin/settings`, read live).
- **OFF (today):** reveal = matched rancher + "they'll text you today."
- **ON (when you take calls):** reveal = an inline **"Book your 15-min call with Ben"** using the **existing `CalInlineBooker`** (`app/qualify/[consumerId]/CalInlineBooker.tsx`) + the live Cal resolver (`getOperatorBookingUrl('sales')` — no hardcoded slug). The rancher match is still recorded; the call just becomes the buyer's next step before the hand-off.
- Flipping it is **one toggle in `/admin/settings`** — config is read at runtime, so it takes effect live. The same gate can later be scoped by state / tier / score (e.g. only offer your call to Whole-cow buyers).

Everything in the flow (copy, step order, which steps render, social-proof source, the reveal CTA) is driven from one `funnelConfig` object, so future changes are config edits — not rebuilds. **This is the "easy to update" you asked for: built in from day one.**

## Edge cases & error handling

- **No rancher in buyer's state:** still capture + qualify, but the reveal is honest — "we're bringing ranches to {state} — you're first in line" (waitlist), not a fake match. They're a qualified lead the moment a rancher onboards.
- **Validation:** reuse existing email validation (throwaway-domain block, fat-finger domain suggestions). **Phone is REQUIRED** (operator decision 2026-06-18 — the operator/rancher must be able to reach the buyer) with format validation. Not optional.
- **Resume token expiry:** drip mints a fresh token per send (already does, 14d). Expired/invalid token → restart at step 1 (re-collect, upsert by email).
- **Back navigation:** allow stepping back; preserve answers (client state).
- **Duplicate email:** upsert the existing Consumer, don't create a second.
- **Pre-contact abandonment:** no record (intended). **Post-contact abandonment:** `QUIZ_STARTED` lead → the quiz-drip (shipped today) nudges them back via `/qualify/[id]` resume link.

## Testing

- **Browser E2E (mobile viewport):** full flow start→finish creates a Consumer at step 3 (verify), qualifies + fires matching at step 5 (verify referral/Telegram), reveal renders. Resume path from a `/qualify/[id]?token` link enters at storage and finishes. (Per bhc-mutation-guardrails Rule 7 — curl can't verify this.)
- **Unit:** scorer (tier/timing/storage/completion → ≥75 boundary); lead-not-created before step 3; upsert-on-duplicate-email.
- **Regression:** GUARD-2 still 412s a `QUIZ_STARTED`-but-not-`Qualified At` consumer at matching; the routing-budget-gate fix + quiz-drip + ChromeGate all still hold.

## Rollout

Ship the new `/access` flow + keep `/qualify/[id]` resume working. Add `/access` to `ChromeGate`'s focused routes (seal it). Monitor flow-completion rate vs the 4.8% baseline. Keep the old form code one release for fast rollback, then delete.

## Out of scope (later)

- A/B testing step count (5 vs 3).
- Land/merch/wholesale audiences (this spec is the **beef-buyer** funnel; other audiences keep their paths for now).
- SMS step (Twilio "when necessary," per operator).
