# BUILD LOG — War-ready funnel + sales floor v1

Spec: `docs/superpowers/specs/2026-06-09-war-ready-funnel-design.md`

Per-feature build record. Append-only. Latest at top.

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
