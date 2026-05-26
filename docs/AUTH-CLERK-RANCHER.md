# Auth Phase 2 — Clerk for Rancher Surface (Feature-Flag Gated)

**Status:** Code-complete on `stage-3-verticals`. Default flag = `false` → no rancher behavior changes until flipped.

**Predecessors:**
- [AUTH-CLERK-ADMIN.md](AUTH-CLERK-ADMIN.md) — Phase 0 shipped Clerk for the `/admin` surface.
- [AUTH-CLERK-BUYER.md](AUTH-CLERK-BUYER.md) — Phase 1 shipped Clerk for the buyer surface alongside the legacy `bhc-member-auth` cookie.

Phase 2 follows the exact same pattern for the rancher surface, with one wrinkle worth understanding: **ranchers can have multiple authorized emails** (operator + spouse + hired help) via the multiline `Team Emails` field. The auto-link path knows how to handle that.

---

## What Phase 2 changes

A single env var — `CLERK_RANCHER_ENABLED` — gates whether rancher requests resolve via Clerk or the legacy `bhc-rancher-auth` JWT cookie. Every rancher-gated route now reads through `lib/rancherAuth.ts → resolveRancherSession()` instead of decoding the cookie directly.

```
CLERK_RANCHER_ENABLED=false   ← default: 100% legacy JWT (no change)
CLERK_RANCHER_ENABLED=true    ← Clerk first, legacy cookie as bridge
```

### New surface area

| File | Purpose |
| --- | --- |
| `lib/rancherAuth.ts` | `resolveRancherSession()` + `requireRancher()` helpers — the single read-side helper every rancher endpoint now uses. |
| `app/api/auth/rancher/clerk-link/route.ts` | Manual fallback POST that forces the auto-link between an active Clerk session and the Ranchers row. Cheap rescue tool for ops/QA. |
| Airtable `Ranchers.Clerk User Id` | New `singleLineText` field (`fld3kbOtssxOplwac`). Empty for all 17 existing ranchers; populated on first Clerk login. |

### Files migrated to `resolveRancherSession`

All previously decoded the `bhc-rancher-auth` cookie directly:

- `app/api/auth/rancher/session/route.ts` (GET; DELETE clears legacy cookie + revokes Clerk session)
- `app/api/rancher/dashboard/route.ts`
- `app/api/rancher/inbox/route.ts`
- `app/api/rancher/billing/data/route.ts`
- `app/api/rancher/landing-page/route.ts`
- `app/api/rancher/upload/route.ts`
- `app/api/rancher/legacy-upgrade/route.ts`
- `app/api/rancher/connect/start/route.ts`
- `app/api/rancher/connect/status/route.ts`
- `app/api/rancher/tier/select/route.ts`
- `app/api/rancher/tier/change/route.ts`
- `app/api/rancher/tier/portal/route.ts`
- `app/api/rancher/fulfillment/confirm/route.ts`
- `app/api/rancher/addons/purchase/route.ts`
- `app/api/rancher/referrals/[id]/route.ts` (PATCH)
- `app/api/rancher/referrals/[id]/confirm-payment/route.ts`
- `app/api/threads/[id]/message/route.ts` (rancher side; buyer side already migrated in Phase 1)

### Files deliberately NOT migrated

- `app/api/auth/rancher/verify/route.ts` — still **issues** the legacy `bhc-rancher-auth` JWT cookie via the magic-link flow. Removing it would break existing bookmarks/intro emails currently in inboxes. Phase 3 cleanup target.
- `app/api/auth/rancher/login/route.ts` — magic-link request endpoint. Same reasoning.
- `app/api/admin/ranchers/[id]/impersonate/route.ts` — admin "view dashboard as rancher" tool mints the legacy JWT cookie with a 4h expiry. Tied to the legacy session shape; will be revisited once Clerk impersonation hooks land.
- `app/api/rancher/quick-action/route.ts` — uses its own `QUICK_ACTION_JWT_SECRET` (per-referral one-tap link token). Different auth surface; not session-based.
- `app/api/rancher/checkin-response/route.ts` — same story: per-check-in token, not session.
- Buyer + admin auth endpoints — out of scope for Phase 2.

---

## Team Emails handling

Ranchers can have multiple authorized emails. The `Email` field is the primary contact; the `Team Emails` multiline field is for everyone else who's allowed to log in (operator's spouse, hired help, consultant).

The auto-link path in `resolveClerkRancher()`:

1. Fast path — look up `Ranchers` row by `Clerk User Id` (already linked from a prior login).
2. First-login path — pull Clerk's primary email, run an Airtable formula that matches `LOWER({Email}) = "x"` OR `SEARCH("x", LOWER({Team Emails}))`. Substring matches are then re-validated in memory against a tokenized delimiter split (`/[\s,;\n]+/`) so `ben@x.com` doesn't false-match `unben@x.com`.
3. Multi-team match (one Clerk user listed on multiple ranches' Team Emails) — picks the most-recently-active rancher row, mirroring the heuristic used by `/api/auth/rancher/login`.
4. Idempotent link write — only writes `Clerk User Id` if it's empty.

**Practical implication:** when you flip the flag on, every existing teammate who logs in via Clerk gets their ranch's row linked the first time they hit any rancher-gated endpoint. No data migration required.

---

## What happens when the flag flips to `true`

### Existing rancher with active `bhc-rancher-auth` cookie

`resolveRancherSession` checks Clerk **first**. If no Clerk session exists (they haven't signed up on Clerk yet), it falls through to the legacy cookie. **Result: zero disruption** — all 17 ranchers keep working until their 30-day cookie expires.

### Existing rancher — cookie expired OR new browser

When they go through the magic-link flow (`/api/auth/rancher/login` → email link → `/api/auth/rancher/verify`), they get the legacy cookie back. Still works.

To migrate them to Clerk, they'd need to either (a) sign up on the Clerk-hosted UI when we wire it into `/rancher/login`, or (b) be enrolled by operator via Clerk dashboard. The auto-link in `resolveClerkRancher()` matches their Clerk primary email to the existing Ranchers row (via Email OR Team Emails) and stamps `Clerk User Id` back idempotently.

### First-time signup (new rancher)

Once `/rancher/login` is wired to Clerk's `SignIn` component (separate UI commit), a new rancher's Clerk account creates → first hit to any rancher-gated endpoint resolves via Clerk → `resolveClerkRancher()` looks up `Clerk User Id` (miss), then primary email (miss → no Ranchers row exists yet). **Action item for the UI commit:** create the Ranchers row during Clerk signup (the rancher wizard already does this on the magic-link path; mirror it for Clerk).

### Edge case: Clerk session present, no matching Ranchers row

`resolveRancherSession` returns **null** rather than falling through to legacy. Otherwise a Clerk user could effectively impersonate any stale `bhc-rancher-auth` cookie that happens to live in the same browser. The rancher sees a 401 and is sent to login.

### Edge case: Clerk API outage

`requireRancher()` catches `ClerkApiError` and returns **503** (operational, retry expected) instead of 401 (security, you're not authenticated). Without this, a Clerk-side hiccup would mass-401 every rancher-gated request and the dashboard would look broken. Match the buyer-side behavior.

### Logout under Clerk

`DELETE /api/auth/rancher/session` clears the legacy cookie AND server-side revokes the active Clerk session via `clerkClient.sessions.revokeSession`. Without the revoke, hitting Log Out under Clerk would silently leave the rancher signed in (the legacy cookie doesn't exist; the Clerk session cookie persists). Best-effort — if Clerk's revoke fails we log + continue.

---

## Rollback

```
CLERK_RANCHER_ENABLED=false
```

Redeploy. Every rancher endpoint now ignores Clerk and reads the legacy cookie. **No data migration required** — the `Clerk User Id` writes already done remain in Airtable (harmless; legacy path doesn't read it).

A rancher who logged in via Clerk during the flag-on window won't have a `bhc-rancher-auth` cookie. They'll see a 401 until they re-do the magic-link flow. Communicate this in #ops if you flip back after >24h of flag-on traffic. With only 17 ranchers + a 30-day legacy cookie window, the blast radius is tiny.

---

## Post-flip metrics to watch

In the first 30 minutes after flipping `CLERK_RANCHER_ENABLED=true`:

| Metric | Where to watch | Alarm if |
| --- | --- | --- |
| 401 rate on `/api/rancher/dashboard` | Vercel logs filtered by route | Sustained spike vs. baseline → ranchers can't see their leads |
| 401 rate on `/api/auth/rancher/session` | Vercel logs | Sustained 100% → dashboard fully broken |
| 503 rate on any `/api/rancher/*` route | Vercel logs | Any sustained 503 → Clerk API connectivity issue; investigate before flipping back |
| `[rancherAuth] Clerk User Id lookup failed` warnings | Vercel logs | Any in first hour → Airtable formula bug; investigate field name + filter quoting |
| `[rancherAuth] clerkClient.getUser failed` warnings | Vercel logs | More than a handful → Clerk API issue |
| `[rancherAuth] multi-match email=…` info logs | Vercel logs | Expected for shared-email consultants; surface to ops if unexpected ranch is picked |
| New `Clerk User Id` writes on Ranchers rows | Airtable Ranchers view filtered by `{Clerk User Id} != ''` | Should grow steadily as ranchers + teammates log in via Clerk |

If any of the alarm conditions trip, flip the flag back and triage. The legacy cookie path is unchanged so rollback is instant.

---

## Phase 3 (separate commit, ~30 days after Phase 2 flip)

1. Remove the `resolveLegacyJwt` branch from `lib/rancherAuth.ts`.
2. Delete `app/api/auth/rancher/verify` + `login` (and any callers that still mint the cookie, e.g. `app/api/admin/ranchers/[id]/impersonate`).
3. Delete the `bhc-rancher-auth` cookie via `cookieStore.delete()` from a one-shot route or just let the existing 30-day expiry roll off.
4. Move `/rancher/login` UI to the Clerk-hosted `<SignIn />` component.
5. Reimplement admin impersonation via Clerk's "Sign in as" feature.

Phase 3 is in scope only after the Phase 2 soak shows clean metrics across all 17 ranchers + any new teammates that signed up during the window.
