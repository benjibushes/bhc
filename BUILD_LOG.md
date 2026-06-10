# BUILD LOG — War-ready funnel + sales floor v1

Spec: `docs/superpowers/specs/2026-06-09-war-ready-funnel-design.md`

Per-feature build record. Append-only. Latest at top.

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
