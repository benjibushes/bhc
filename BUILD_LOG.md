# BUILD LOG — War-ready funnel + sales floor v1

Spec: `docs/superpowers/specs/2026-06-09-war-ready-funnel-design.md`

Per-feature build record. Append-only. Latest at top.

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
