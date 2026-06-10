# BUILD LOG — War-ready funnel + sales floor v1

Spec: `docs/superpowers/specs/2026-06-09-war-ready-funnel-design.md`

Per-feature build record. Append-only. Latest at top.

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
