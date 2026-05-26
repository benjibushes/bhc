# Auth Phase 1 — Clerk for Buyer Surface (Feature-Flag Gated)

**Status:** Code-complete on `stage-3-verticals`. Default flag = `false` → no buyer behavior changes until flipped.

**Predecessor:** [AUTH-CLERK-ADMIN.md](AUTH-CLERK-ADMIN.md) — Phase 0 shipped Clerk for the `/admin` surface only. This phase adds Clerk for the buyer surface (`/member`, `/checkout`, etc.) **alongside** the existing magic-link + JWT cookie flow.

---

## What Phase 1 changes

A single env var — `CLERK_BUYER_ENABLED` — gates whether buyer requests resolve via Clerk or the legacy `bhc-member-auth` JWT cookie. Every buyer-gated route now reads through `lib/buyerAuth.ts → resolveBuyerSession()` instead of decoding the cookie directly.

```
CLERK_BUYER_ENABLED=false   ← default: 100% legacy JWT (no change)
CLERK_BUYER_ENABLED=true    ← Clerk first, legacy cookie as bridge
```

### New surface area

| File | Purpose |
| --- | --- |
| `lib/buyerAuth.ts` | `resolveBuyerSession()` + `requireBuyer()` helpers — the single read-side helper every buyer endpoint now uses. |
| `app/api/auth/member/clerk-link/route.ts` | Manual fallback POST that forces the auto-link between an active Clerk session and the Consumers row. Cheap rescue tool for ops/QA. |
| Airtable `Consumers.Clerk User Id` | New `singleLineText` field. Empty for existing buyers; populated on first Clerk login. |

### Files migrated to `resolveBuyerSession`

All previously decoded the `bhc-member-auth` cookie directly:

- `app/api/checkout/deposit/route.ts` (POST + GET)
- `app/api/auth/member/session/route.ts` (GET; DELETE still clears legacy cookie)
- `app/api/member/reorder/route.ts`
- `app/api/member/content/route.ts`
- `app/api/member/upgrade-intent/route.ts`
- `app/api/member/ready-to-buy/route.ts`
- `app/api/threads/by-referral/[refId]/route.ts`
- `app/api/threads/[id]/message/route.ts` (buyer side; rancher side unchanged)
- `app/api/orders/request/route.ts` (optional auth path)

### Files deliberately NOT migrated

- `app/api/auth/member/verify/route.ts` — still **issues** the legacy `bhc-member-auth` JWT cookie via the magic-link flow. Removing it would break existing bookmarks/intro emails currently in inboxes. Phase 2 cleanup target.
- `app/api/auth/member/login/route.ts` — magic-link request endpoint. Same reasoning.
- `app/api/warmup/engage/route.ts` — sets the legacy cookie on warmup engagement. Same reasoning.
- Rancher auth endpoints + admin auth endpoints — out of scope for Phase 1.

---

## What happens when the flag flips to `true`

### Existing buyer with active `bhc-member-auth` cookie

`resolveBuyerSession` checks Clerk **first**. If no Clerk session exists (they haven't signed up on Clerk yet), it falls through to the legacy cookie. **Result: zero disruption** — the 1500 existing buyers keep working until their 30-day cookie expires.

### Existing buyer — cookie expired OR new browser

When they go through the magic-link flow (`/api/auth/member/login` → email link → `/api/auth/member/verify`), they get the legacy cookie back. Still works.

To migrate them to Clerk, they'd need to either (a) sign up on the Clerk-hosted UI when we wire it into `/member/login`, or (b) be enrolled by operator via Clerk dashboard. The auto-link in `resolveClerkBuyer()` matches their Clerk primary email to the existing Consumers row and stamps `Clerk User Id` back idempotently.

### First-time signup (new buyer)

Once `/member/login` is wired to Clerk's `SignIn` component (separate UI commit), a new buyer's Clerk account creates → first hit to any buyer endpoint resolves via Clerk → `resolveClerkBuyer()` looks up `Clerk User Id` (miss), then primary email (miss → no Consumers row exists yet). **Action item for the UI commit:** call `/api/consumers` POST during Clerk signup to create the Consumers row, then the auto-link stamps `Clerk User Id` on the next request.

### Edge case: Clerk session present, no matching Consumers row

`resolveBuyerSession` returns **null** rather than falling through to legacy. Otherwise a Clerk user could effectively impersonate any stale `bhc-member-auth` cookie that happens to live in the same browser. The buyer sees a 401 and is sent to login.

---

## Rollback

```
CLERK_BUYER_ENABLED=false
```

Redeploy. Every buyer endpoint now ignores Clerk and reads the legacy cookie. **No data migration required** — the `Clerk User Id` writes already done remain in Airtable (harmless; legacy path doesn't read it).

A buyer who logged in via Clerk during the flag-on window won't have a `bhc-member-auth` cookie. They'll see a 401 until they re-do the magic-link flow. Communicate this in #ops if you flip back after >24h of flag-on traffic.

---

## Post-flip metrics to watch

In the first 30 minutes after flipping `CLERK_BUYER_ENABLED=true`:

| Metric | Where to watch | Alarm if |
| --- | --- | --- |
| 401 rate on `/api/checkout/deposit` (POST + GET) | Vercel logs filtered by route | >5% spike vs. baseline → buyers can't pay |
| 401 rate on `/api/auth/member/session` | Vercel logs | Sustained 100% → dashboard fully broken |
| `[buyerAuth] Clerk User Id lookup failed` warnings | Vercel logs | Any in first hour → Airtable formula bug; investigate field name + filter quoting |
| `[buyerAuth] clerkClient.getUser failed` warnings | Vercel logs | More than a handful → Clerk API connectivity issue |
| New `Clerk User Id` writes on Consumers rows | Airtable Consumers view filtered by `{Clerk User Id} != ''` | Should grow steadily as existing buyers log in via Clerk |

If any of the alarm conditions trip, flip the flag back and triage. The legacy cookie path is unchanged so rollback is instant.

---

## Phase 2 (separate commit, ~30 days after Phase 1 flip)

1. Remove the `resolveLegacyJwt` branch from `lib/buyerAuth.ts`.
2. Delete `app/api/auth/member/verify` + `login` (and any callers that still mint the cookie, e.g. `app/api/warmup/engage`).
3. Delete the `bhc-member-auth` cookie via `cookieStore.delete()` from a one-shot route or just let the existing 30-day expiry roll off.
4. Move `/member/login` UI to the Clerk-hosted `<SignIn />` component.

Phase 2 is in scope only after the Phase 1 soak shows clean metrics.
