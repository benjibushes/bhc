# BUILD LOG — War-ready funnel + sales floor v1

Spec: `docs/superpowers/specs/2026-06-09-war-ready-funnel-design.md`

Per-feature build record. Append-only. Latest at top.

---

## R1-R9 — Schema gap audit + 9 fixes — 2026-06-10

**Status:** ✅ shipped (R1-R6 + R9). R7+R8 closed as PREMISE FALSIFIED. R10 surfaced for operator.

**Trigger:** User report "lots of errors, lots of table mismatches and reads writes and failing crons. We need to update everything."

**Root cause:** Multiple ships (F11/F18/FINAL-7 etc.) wrote field names to Airtable that didn't exist in live schema. `lib/airtable.ts` silent-strip retry hid the gap. 4 parallel audit agents converged on the same finding.

### R1 — Schema: 12 missing fields added live via Airtable MCP
**Inquiries:** `Last Activity At` (dateTime)
**Referrals:** `Deposit Amount`, `Deposit Paid At`, `Final Invoice URL`, `Final Invoice Sent At`, `Final Invoice Amount`, `Final Paid At`, `Final Paid Amount`, `Total Sale Amount`, `Processing Date`, `Sales Call Booked At`, `Sales Call Completed At`
**Cron Runs:** `Errors` (number) — prevents future audits misreading Records Touched

### R2 — F15 wholesale formatWholesale
`app/api/admin/desk/route.ts`: Inquiries field is `Created`, not `Created At`/`Created Time`. Fallback `_rawJson.createdTime`.

### R3 — F12 Referral rot createdTime metadata
`app/api/admin/desk/route.ts` + `app/api/rancher/dashboard/route.ts`: Referrals has no `Created At` field. Use Airtable metadata.

### R4 — Cal webhook Conversations write field names
`app/api/webhooks/cal/route.ts:445-460`: rewrite to use existing Timestamp/Direction/From/To/Subject/Body/Sender Type.

### R5 — F18 cal-reminder-1h cron + admin desk calls
Pivot from Conversations `Type='cal_booking'` (never existed) to Referrals `Sales Call Booked At` (now exists). Fixes 16/24h errors.

### R6 — Cal webhook Quiz Score → Qualification Score
`app/api/webhooks/cal/route.ts`: pre-call brief reads correct schema field with legacy fallback.

### R7 — PREMISE FALSIFIED
"139 stranded buyers" is documented design: `Status='Approved'` = membership/access, `Qualified At` = routing gate. Pre-quiz nurture by `qualified-no-action` + `abandoned-quiz-nudge` crons. Not a regression.

### R8 — PREMISE FALSIFIED
"68 errors" was a misread: `Records Touched=68`, `Duration ms=94363`, Notes says `errors=0`. Last 11 runs all `errors=0`. Added Cron Runs `Errors` column to prevent re-occurrence.

### R9 — /api/qualify exposes matchDiag
Synthetic-e2e fails opaquely. Captured matching/suggest status + matchFound/paused/error/reason in response. Tomorrow's failure tells us exact gate. Phase 2 fix locks in based on data.

### R10 — Surfaced to operator
Renick Valley has 2 rows: Jesse Gajewski (May, Live, has Slug) + Jesse Zimmerman (June 9, Active, no Slug, Migration=invited). Per bhc-mutation-guardrails Rule 2, dup decision needs operator instruction.

**Files touched:** `app/api/admin/desk/route.ts`, `app/api/rancher/dashboard/route.ts`, `app/api/webhooks/cal/route.ts`, `app/api/cron/cal-reminder-1h/route.ts`, `app/api/qualify/route.ts`.

**Schema deltas:** 12 fields + 1 Cron Runs Errors column.

**Side effects:** writes that were silent-stripped now land. FINAL-7 tier_v2 deposit + final invoice flow starts persisting properly.

---

## F13 — Email open/click badge on desk cards — 2026-06-09

**Status:** ✅ shipped, typecheck clean. Final feature of the 13-block.

**What:** Each quiz-complete buyer card on `/admin/today/v2` now shows a `📧 Xo/Yc` badge (opens / clicks). Hover for last-event ages. Sage tint if any clicks; bone-warm if opens-only. Hidden when both 0.

**Files touched:**
- MOD: `app/api/admin/desk/route.ts` — `formatBuyer` returns `emailOpens`, `emailClicks`, `lastOpenedAt`, `lastClickedAt` (sourced from F5's Resend-stamped Consumer fields)
- MOD: `app/admin/today/v2/DeskClient.tsx` — `DeskBuyer` type adds 4 optional fields; NEW `EmailEngageBadge` helper rendered inline on quiz-complete cards

**Schema:** none new (uses F5 fields `Email Opens`, `Email Clicks`, `Last Email Opened At`, `Last Email Clicked At`)
**Side effects:** 0
**Test cmd:**
1. F5 webhook delivers an open event for a buyer with quiz complete
2. Visit `/admin/today/v2` → that buyer's row now shows `📧 1o/0c` badge
3. Hover → tooltip "1 open, last 3m ago"

**Why this matters:** Ben can instantly see which buyers ENGAGED with the recent intro email vs. which never opened. Combined with the lead score (F4) — opens + clicks = ready to call.

**Rollback:** revert files.

---

## F12 — Deal-rot indicator + stage advance — 2026-06-09

**Status:** ✅ shipped, typecheck clean.

**What:**
- **Rot badge** on deposit-pending pipeline cards — `0` (today, grey), `1-2d` (grey), `3-6d` (saddle), `7d+` (red). Computed server-side as `max(last activity timestamps) → days since`.
- **Stage advance button** per pipeline card — server-validated transitions only. Replaces what would have been a drag-drop UX (simpler, less visual noise).

**Files touched:**
- MOD: `app/api/admin/desk/route.ts` — `formatReferral` adds `daysSinceActivity` + `status`
- NEW: `app/api/admin/referrals/[id]/stage/route.ts` — POST {status} validates `ALLOWED` map, transitions, Telegram alert
- MOD: `app/admin/today/v2/DeskClient.tsx` — DeskReferral type adds fields, new `RotBadge` + `AdvanceStageButton` helpers wired on deposit-pending list

**Allowed transitions (`/api/admin/referrals/[id]/stage`):**
- `Intro Sent` → `Awaiting Payment` | `Closed Lost`
- `Awaiting Payment` → `Slot Locked` | `Closed Lost`
- `Slot Locked` → `Closed Won` | `Closed Lost`
- `Closed Lost` → `Intro Sent` (revive)

**Side effects:** Stage advance fires Telegram alert + updates Referral Status field. Existing Status-flip triggers in matching/contracts not duplicated here.

**Test cmd:**
1. Visit `/admin/today/v2` — pending deposits show rot badge + `→ Locked` button
2. Click button → status flips → Telegram alert "Stage advanced"
3. Bad transition returns 422

**Rollback:** revert files. Endpoint is stateless.

---

## F11 — Click-to-call + Whisper transcription — 2026-06-09

**Status:** ✅ shipped (feature-flag OFF default), typecheck clean. Schema fields added live.

**What:** Ben can initiate a Twilio call from `/admin/today/v2` Consumer cards. Twilio dials Ben first, then buyer (conference). Both legs auto-recorded. On call complete, recording URL POSTed to webhook → Groq Whisper transcribes → new Conversations row stamped.

**Files touched:**
- NEW: `lib/clickToCall.ts` — feature flag + `initiateCall` (creates Twilio call w/ TwiML) + `transcribeRecording` (Groq Whisper)
- NEW: `app/api/admin/click-to-call/route.ts` — POST {consumerId} → triggers call
- NEW: `app/api/webhooks/twilio-recording/route.ts` — Twilio recording-complete webhook handler

**Schema (Conversations, added live):**
- `Recording URL` (url) `fldihuoU2V4yshDNr`
- `Transcript` (multilineText) `fldlV8wzV4zoMurru`
- `Call Duration Seconds` (number) `fldOf6nTuRmfg4q1E`
- `Call Sid` (singleLineText) `fldoeI73orCBBGtdq`

**Env vars (new):**
- `ENABLE_CLICK_TO_CALL` (default unset = off)
- `BHC_OPERATOR_PHONE` (Ben's E.164 phone)
- `GROQ_API_KEY` (for Whisper) — already used elsewhere
- `TWILIO_*` — existing

**Side effects when flag on:** Twilio call charges + Groq Whisper API charges (cheap) + 1 Conversations row per call.
**Telegram alerts:** `📞 Call recorded — duration + transcript preview`
**Twilio dashboard setup required:**
- Phone number with Voice enabled
- Recording callback URL: `https://buyhalfcow.com/api/webhooks/twilio-recording`
- StatusCallback URL: `https://buyhalfcow.com/api/webhooks/twilio-call-status` (TODO build)

**UI wiring:** Desk button still TODO (helper + endpoints ready). Wire on next desk pass.

**Rollback:** unset `ENABLE_CLICK_TO_CALL`.

---

## F10 — Funnel friction polish — 2026-06-09

**Status:** ✅ shipped, typecheck clean.

**3 polishes:**

### 10A — Phone-optional env toggle
- MOD: `app/access/page.tsx:419-449` — phone required only when `NEXT_PUBLIC_REQUIRE_PHONE !== '0'`. When `'0'`, blank phone is OK; if provided, format still validated.
- Use case: A/B test top-of-funnel conversion lift without redeploy.

### 10B — Stale JWT recovery inline form
- NEW: `app/api/qualify/resend-link/route.ts` — POST {email} → looks up Consumer by email (case-insensitive) → emails fresh qualify URL (no JWT, just record-id path). Always returns ok=true to prevent email enumeration.
- MOD: `app/qualify/[consumerId]/page.tsx` — extracted error UI into new `ExpiredLinkRecovery` component. Inline "send me a fresh link" form replaces the "go back to /access" CTA. Privacy-preserving success message.

### 10C — Abandoned-quiz nudge cron
- NEW: `app/api/cron/abandoned-quiz-nudge/route.ts` — hourly cron. Window: Consumers `Status=Approved` AND `Qualified At` empty AND created 1-72h ago AND has Email AND not Unsubscribed/Bounced. Dedup via Notes `[abandoned-quiz-nudge YYYY-MM-DD]`. Telegram volume alert on each run with touched count.
- MOD: `vercel.json` — registered cron at `0 * * * *`.

**Env vars (new):**
- `NEXT_PUBLIC_REQUIRE_PHONE` (default '1' = required; set to `'0'` to make optional)

**Side effects:**
- Hourly cron sends abandonment emails (0-N per run)
- Resend-link POST fires fresh quiz email per request

**Test cmd:**
- 10A: set `NEXT_PUBLIC_REQUIRE_PHONE=0` → /access form accepts blank phone
- 10B: visit /qualify/invalid-id → see "send fresh link" form → submit email → expect quiz email
- 10C: trigger `/api/cron/abandoned-quiz-nudge` manually → check Cron Runs row

**Rollback:** revert files. `vercel.json` cron registration safe to leave.

---

## F9 — SMS event stubs (feature-flagged) — 2026-06-09

**Status:** ✅ shipped (feature-flag OFF by default), typecheck clean.

**User constraint:** "I dont have twlio setup yet" — every SMS event is a feature-flagged stub. No sends until both:
- `ENABLE_SMS=1` env var set, AND
- Twilio creds (`TWILIO_ACCOUNT_SID`/`AUTH_TOKEN`/`FROM_NUMBER`) set

**What:** `lib/smsEvents.ts` exposes `fireSMSEvent({type, consumer, vars})`. 7 type templates (signup, quiz_invite, cal_reminder, deposit_invoice, slot_locked, refund, fulfillment) each compiled into a 160-char TCPA-compliant body. Wraps existing `sendSMSToConsumer` which enforces SMS Opt-In + Unsubscribed gates.

**Wired call sites (3 of 7 — others left as helper-ready):**
- `app/api/consumers/route.ts` — signup → `fireSMSEvent('signup')`
- `app/api/admin/send-deposit-invoice/route.ts` — invoice fire → `fireSMSEvent('deposit_invoice')`
- `app/api/rancher/referrals/[id]/accept/route.ts` — slot lock → `fireSMSEvent('slot_locked')`

**Files touched:**
- NEW: `lib/smsEvents.ts` — templates + dispatcher
- MOD: 3 routes wire `fireSMSEvent` (always non-blocking try/catch)

**Env vars (new):**
- `ENABLE_SMS` (default unset = off; flip to `1` when ready)

**Schema:** none new (existing `SMS Opt-In` + `Unsubscribed` on Consumers reused)
**Side effects when flag on:** 1 SMS per gated event (when both opt-ins true + valid phone)
**Telegram alerts:** none
**Test cmd:**
1. Flip `ENABLE_SMS=1` in Vercel env
2. Set Twilio env vars
3. Stamp a synthetic Consumer with `SMS Opt-In=true` + valid phone
4. Trigger a signup → SMS arrives in 5-10s
5. Verify body matches template, no opt-out (Twilio STOP keyword handled by Twilio)

**Remaining 4 events (not yet wired):**
- quiz_invite — would go in `/api/qualify` or a new abandoned-cart cron
- cal_reminder — new cron `cal-reminder-1h` (1h before each booked call)
- refund — `/api/admin/refund-deposit` after successful Stripe refund
- fulfillment — `/api/rancher/referrals/[id]/send-final-invoice` after payment

Wire these when business logic finalizes (call helper from each site).

**Rollback:** leave `ENABLE_SMS` unset (default).

---

## F8 — $497 White Glove Onboarding upsell — 2026-06-09

**Status:** ✅ shipped (feature-flag OFF by default), typecheck clean. Schema fields added live.

**Decision D (locked):** "$497 optional" — bundle Stripe Checkout for ranchers who want Ben to personally handle first 3 buyer matches.

**What:** Rancher POSTs to `/api/rancher/white-glove` → Stripe Checkout for $497 → webhook stamps Ranchers record. Auth via existing `requireRancher`. When `ENABLE_WHITE_GLOVE!=1`, endpoint 404s.

**Files touched:**
- NEW: `lib/whiteGlove.ts` — feature flag + `createWhiteGloveCheckoutSession` + `hasWhiteGlove`
- NEW: `app/api/rancher/white-glove/route.ts` — POST returns Stripe URL
- MOD: `app/api/webhooks/stripe/route.ts` — `metaType === 'white_glove'` branch stamps Rancher + Telegram alert

**Schema (Ranchers, added live):**
- `White Glove Paid At` (dateTime) `fld1aov1bRy65re4I`
- `White Glove Session Id` (singleLineText) `fldFhFhW4vdp4FbR2`

**Env vars (new):**
- `ENABLE_WHITE_GLOVE` (default unset = off)
- `WHITE_GLOVE_PRICE_CENTS` (default 49700)

**Side effects:** Stripe Checkout creation + webhook stamps Rancher + Telegram alert when paid.
**Telegram alerts:** `🧤 White Glove sold — <ranch> — $X`

**Wizard integration (deferred):**
Wizard sign-step UI surface left out — flag still off. When user flips ON in env, follow-up commit adds opt-in checkbox + Stripe redirect on wizard Step 4.

**Rollback:** unset env (already off).

---

## F7 — $49 Reservation Hold stub + Cal book gate — 2026-06-09

**Status:** ✅ shipped (feature-flag OFF by default), typecheck clean. Schema fields added live.

**Decision B (locked):** "No deposit but we should be able to flip to deposit lock spot feature when needed" — built as feature-flag stub.

**What:** Buyer hits "Book a Call" on `/qualify` → /api/qualify/[id]/reservation-hold → Stripe Checkout for $49 → Stripe webhook stamps Consumer record. When the flag is OFF (default), the endpoint returns 404 and Cal booking proceeds normally. When ON, helpers in `lib/reservationHold.ts` gate the booking.

**Files touched:**
- NEW: `lib/reservationHold.ts` — `isReservationHoldEnabled()`, `getHoldPriceCents()`, `createHoldCheckoutSession()`, `hasReservationHold()`
- NEW: `app/api/qualify/[consumerId]/reservation-hold/route.ts` — POST creates Stripe Checkout, returns URL
- MOD: `app/api/webhooks/stripe/route.ts` — new `metaType === 'reservation_hold'` branch stamps Consumer + Telegram alert

**Schema (Airtable, added live):**

`Consumers`:
- `Reservation Hold Paid At` (dateTime) `fld42HABNS9J1VmEG`
- `Reservation Hold Session Id` (singleLineText) `fldYlSOFK9l9X0Boc`
- `Reservation Hold Refunded At` (dateTime) `fldWNLgVaALvXjcbR`

**Env vars (new):**
- `ENABLE_RESERVATION_HOLD` (default unset = off; set to `1` to flip on)
- `RESERVATION_HOLD_PRICE_CENTS` (default 4900)

**Side effects:** Stripe Checkout session creation + webhook stamps Consumer when paid + Telegram alert.
**Telegram alerts:** `💵 Reservation hold paid — <name> — $X`

**Test cmd (when flag flipped on):**
1. Set `ENABLE_RESERVATION_HOLD=1` in Vercel env
2. Visit `/qualify/<consumerId>` → call POST `/api/qualify/<id>/reservation-hold`
3. Expect Stripe Checkout URL → complete with test card
4. Verify Consumer `Reservation Hold Paid At` stamped + Telegram alert received

**Rollback:** unset `ENABLE_RESERVATION_HOLD` (already off by default). Schema fields harmless.

---

## F6 — Next-Best-Action widget — 2026-06-09

**Status:** ✅ shipped, typecheck clean.

**What:** Top of `/admin/today/v2` now shows ranked top-8 actions Ben should take RIGHT NOW. Priority 1 (charcoal), 2 (saddle), 3 (divider). Each item: who, why now, suggested verb.

**5 rules (ordered by revenue impact):**
1. **P1 Cal call within 60 min** — prep + jump on call
2. **P1 Hot quiz buyer (score ≥70)** — phone outreach, top 5
3. **P2 Deposit pending** — chase rancher to accept slot
4. **P3 Warm quiz buyer (40-69)** — drip Cal invite, top 3
5. **P3 Slots locked** — verify processing date, top 3

**Files touched:**
- NEW: `lib/nextBestAction.ts` — pure helper `computeNBA(input) → NBAItem[]`
- MOD: `app/api/admin/desk/route.ts` — compute NBA + include in response
- MOD: `app/admin/today/v2/DeskClient.tsx` — NBAItem interface, ranked list section above hero

**Env vars:** none
**Schema:** none
**Side effects:** 0 (read-only compute)
**Telegram alerts:** none
**Test cmd:**
1. Visit `/admin/today/v2` — NBA section appears above Closed Today hero
2. If quiz lead score ≥70, first item is "Call X" with score reason
3. If Cal call in 30 min, P1 "prep + jump on call"

**Why this matters:** Cognitive offload. Ben no longer scans 30 buyers + 5 calls + 10 pending. NBA = top 8 actions ranked by $.

**Rollback:** `git revert <F6 commit sha>`

---

## F5 — Resend open/click/delivered webhook → engagement log — 2026-06-09

**Status:** ✅ shipped, typecheck clean. Schema fields added live.

**What:** Existing `/api/webhooks/resend` handler now stamps engagement on Consumer + Email Sends row when Resend fires `email.opened`, `email.clicked`, `email.delivered`. Counters increment per event. Existing bounce/complaint logic preserved.

**Files touched:**
- MOD: `app/api/webhooks/resend/route.ts` — added 3 event-type branches. Looks up Consumer by recipient email + stamps Last Email Event/Delivered/Opened/Clicked + Email Opens / Email Clicks counters. Looks up latest Email Sends row (last 7d) for recipient + stamps Last Event/Delivered/Opened/Clicked + Open Count / Click Count.

**Schema (Airtable, added live via MCP):**

`Consumers`:
- `Last Email Event At` (dateTime UTC) `fldS8El7uFK1rzM7D`
- `Last Email Delivered At` (dateTime UTC) `fld1hcic4RNtCmpGK`
- `Last Email Opened At` (dateTime UTC) `fld8fYoqaUcpGRhXz`
- `Last Email Clicked At` (dateTime UTC) `fldRkaCMchDfMcLqw`
- `Email Opens` (number, precision 0) `fldzeIINXeTf4jEnR`
- `Email Clicks` (number, precision 0) `fldmGJI7w4EnnsK3O`

`Email Sends`:
- `Last Event At` (dateTime UTC) `fld9XoNJEJnRfX8qB`
- `Delivered At` (dateTime UTC) `fldCwTcvZPOVUsAXP`
- `Opened At` (dateTime UTC) `fldP1pJccbytb4Myk`
- `Clicked At` (dateTime UTC) `fldpKpiLOacniDR5E`
- `Open Count` (number, precision 0) `fld7shHNOwbTMR8GA`
- `Click Count` (number, precision 0) `fldzK3Qq6jypF5zyJ`

**Env vars:** `RESEND_WEBHOOK_SECRET` (already required for bounce/complaint signature verify)
**Side effects:** Stamps Consumer + Email Sends row per delivery/open/click event
**Telegram alerts:** unchanged (only fire on bounced/complained)
**Failure mode:** schema writes wrapped in try/catch; missing fields = silent skip + console.warn

**OPS — User must do this in Resend dashboard:**
1. Settings → Webhooks → Edit existing endpoint
2. Add subscribed events: `email.delivered`, `email.opened`, `email.clicked`
3. Save. Resend starts firing within minutes.

**Test cmd:**
1. Send a synthetic Welcome email to your own address via prod
2. Open the email → wait 30s → check Consumer record in Airtable → `Email Opens=1`, `Last Email Opened At` stamped
3. Click any link → wait 30s → `Email Clicks=1`, `Last Email Clicked At` stamped
4. Check Email Sends row for same recipient → `Open Count` + `Click Count` match

**Rollback:** `git revert <F5 commit sha>` — schema fields can remain (unused, harmless).

---

## F4 — Composite lead score + desk sort — 2026-06-09

**Status:** ✅ shipped, typecheck clean.

**What:** Each quiz-complete buyer on `/admin/today/v2` now shows a composite 0-100 lead score (color-tiered badge). List is sorted hottest first. Hover badge → reasons (`fresh`, `phone`, `paid:meta`, etc).

**Score formula (`lib/leadScore.ts`):**
```
score = quiz × 0.4
      + intent × 0.3
      + recency (0-20, decays over 24h)
      + 5 if phone
      + 5 if paid source
```

**Files touched:**
- NEW: `lib/leadScore.ts` — pure helper, returns `{score, reasons[]}`
- MOD: `app/api/admin/desk/route.ts` — import + apply in `formatBuyer` + sort `quizFormatted` desc
- MOD: `app/admin/today/v2/DeskClient.tsx` — DeskBuyer interface adds leadScore/leadReasons; card renders color badge + reasons inline

**Env vars:** none
**Schema:** none (reads existing Qualification Score + Intent Score + Source/UTM Source fields)
**Side effects:** 0 (read-only computation)
**Telegram alerts:** none
**Test cmd:**
1. Visit `/admin/today/v2` after seeding 3 buyers w/ varied quiz scores
2. Hottest buyer (high quiz + recent) at top with dark badge ≥70
3. Cold buyer (no quiz, old) at bottom with grey badge <40
4. Hover badge → reasons array displayed

**Why this matters:** Ben sees 10-30 ready buyers daily. Sorting by composite score = highest-value call first → higher conversion per hour of his sales time.

**Rollback:** `git revert <F4 commit sha>`

---

## F3 — Funnel observability — 2026-06-09

**Status:** ✅ shipped, typecheck clean.

**What:** state-snapshot funnel viz on `/admin/today/v2`. 6 stages (signup → qualified → booked → invoiced → locked → closed). Conversion rates between stages. Per-UTM-source breakdown (top 10).

**Files touched:**
- NEW: `app/api/admin/funnel-conversion/route.ts` — GET endpoint. Reads Consumers + Referrals, computes totals + conv + bySource. Window param: `?since=7d|30d|90d|all` (default 30d).
- MOD: `app/admin/today/v2/DeskClient.tsx` — added FunnelData interface, useState, tick() fetch, Funnel section between Waitlist and footer.

**Env vars:** none
**Schema:** none (reads existing Consumers + Referrals fields)
**Side effects:** 0 (read-only endpoint)
**Telegram alerts:** none
**Test cmd:**
1. Visit `/admin/today/v2` — Funnel section renders below Waitlist
2. Stage tiles show 30d totals
3. Per-source table sorted by signup desc (top 10)
4. Hit `/api/admin/funnel-conversion?since=7d` directly → JSON shape `{totals, conv, bySource}`

**Why this matters:** Ben can now see exact funnel drop-offs by acquisition channel without opening Airtable. Cuts paid-ad attribution loop time from "I don't know which UTM converts" → real-time card on his desk.

**Rollback:** `git revert <F3 commit sha>`

---

## F2 — Pixel placement: CompleteRegistration + InitiateCheckout + Schedule — 2026-06-09

**Status:** ✅ shipped, typecheck clean.

**Existing infra (preserved):** Meta Pixel base (`PixelTracker`, `RouteChangeTracker`), server CAPI (`lib/metaCapi.ts` w/ fbp/fbc cookie capture), Lead+Purchase fires already wired (E1-E4 prior). Audit agent claim "MISSING" was wrong.

**Gaps filled:**
1. **CompleteRegistration** on quiz submit — client (`/qualify` page) + server CAPI (`/api/qualify`) deduped via event_id
2. **InitiateCheckout** on admin Send Deposit Invoice — server CAPI (`/api/admin/send-deposit-invoice`)
3. **Schedule** custom event on Cal BOOKING_CREATED — server CAPI (`/api/webhooks/cal`)

**Files touched:**
- `app/qualify/[consumerId]/page.tsx` — client `track('CompleteRegistration', ...)` after quiz success
- `app/api/qualify/route.ts` — server `fireCapi([{ event_name: 'CompleteRegistration', ... }])`
- `app/api/admin/send-deposit-invoice/route.ts` — server `fireCapi([{ event_name: 'InitiateCheckout', ... }])` after deposit invoice sent
- `app/api/webhooks/cal/route.ts` — server `fireCapi([{ event_name: 'Schedule', ... }])` on BOOKING_CREATED
- `lib/metaCapi.ts` — added `'Schedule'` to `event_name` union

**Env vars:** none new (existing `META_PIXEL_ID` + `META_CAPI_ACCESS_TOKEN` + `NEXT_PUBLIC_META_PIXEL_ID` already set)
**Schema:** none
**Side effects:** 3 new CAPI events per buyer journey (Lead → CompleteRegistration → Schedule → InitiateCheckout → Purchase)
**Telegram alerts:** unchanged
**Test cmd:**
1. Meta Events Manager → Test Events → expect 5 events during synthetic journey
2. Each event has event_id matching shape `qualify-*`, `cal-booking-*`, `deposit-invoice-*`
3. Match Quality score ≥6/10 (email+phone+state+fbp+fbc)

**Rollback:** `git revert <F2 commit sha>`

---

## F1 — Brand voice + mission lock — 2026-06-09

**Status:** ✅ shipped, verified, documented.

**Files touched:**
- NEW: `docs/BHC-BRAND.md` — source of truth (voice table + banned words + mission integration checklist)
- MOD: `app/components/FullHomepage.tsx:58-63` — homepage subtitle now leads w/ mission
- MOD: `app/founders/page.tsx:347-349` — italic mission line above founder vision
- MOD: `app/access/page.tsx:1216-1221` — footer adds italic mission + back-to-home
- MOD: `lib/emailMinimal.ts` — all 4 minimal-pipeline email signatures append mission italic

**Env vars:** none
**Schema deltas:** none
**Side effects:** 0 (copy only)
**Telegram alerts:** none
**Test cmd:**
```bash
curl -sS https://www.buyhalfcow.com | grep "ranch they trust"
curl -sS https://www.buyhalfcow.com/access | grep "ranch they trust"
curl -sS https://www.buyhalfcow.com/founders | grep "ranch they trust"
```
Expected: 3 hits (one per page).

**Rollback:** `git revert <F1 commit sha>`
