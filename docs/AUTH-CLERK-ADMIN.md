# Admin Auth — Clerk (Phase 0)

**Status:** Live on `stage-3-verticals` branch (2026-05-26).
**Scope:** Admin surface ONLY. Buyer + rancher auth unchanged.
**Owner:** Ben (founder), rotates with whoever holds prod refund power.

---

## Why Clerk for admin

Stage-3 ships LIVE Stripe payments. Before this change, admin used a single
shared password — cookie OR `x-admin-password` header OR (in dev) `?password=`
query. Whoever held that string owned:

- Full Stripe refund button (any buyer deposit, any rancher account)
- Full rancher data export (PII, payouts, contact info)
- Full buyer PII (email, phone, address, order history)
- Cron + Telegram bot impersonation

**Threat model.** A phished admin password was a one-credential, one-step
compromise. Adding Clerk for the browser path gives us:

1. **TOTP 2FA** — authenticator app required on every admin sign-in.
2. **Session UI** — revoke active sessions, list devices, force re-auth.
3. **Magic-link option** — phishing-resistant per-session token.
4. **Forensic audit log** — every sign-in event with IP, UA, geo.
5. **Industry-vetted crypto** — no homegrown cookie token to attack.

Server-to-server callers (Telegram bot, cron, ops curl) keep the
`x-admin-password` header — their threat profile is different (secret lives
in `process.env`, not in a human's head).

---

## Operator setup

### 1. Create Clerk app

1. Go to <https://dashboard.clerk.com> → New application.
2. Name: `BuyHalfCow Admin`.
3. Auth providers: **Email** + **Magic link**. Toggle off everything else
   for Phase 0 (no Google/GitHub/etc. — admins use known emails only).
4. Copy the publishable key (`pk_test_...` / `pk_live_...`) and secret key
   (`sk_test_...` / `sk_live_...`) into `.env.local`:

   ```
   NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
   CLERK_SECRET_KEY=sk_test_...
   ```

5. Also set in Vercel project env (Production + Preview + Development).

### 2. Enforce TOTP 2FA

In Clerk Dashboard → **User & Authentication** → **Multi-factor**:

- Enable **Authenticator application** (TOTP).
- Set requirement: **Required** (not optional).
- Save.

Now every admin sign-in goes: email → password OR magic link → TOTP code.

### 3. Configure email allowlist

In `.env.local` and Vercel env:

```
ADMIN_EMAILS=ben@buyhalfcow.com,partner@buyhalfcow.com
```

Comma-separated, case-insensitive. Email must match the **primary email** of
the Clerk session. If empty, **any** signed-in Clerk user can hit `/admin`
(dev convenience — never deploy to prod with empty allowlist).

The allowlist is enforced at two layers:

- `proxy.ts` — network-layer gate on every `/admin/*` and
  `/api/admin/*` request.
- `lib/adminAuth.ts` `requireAdmin()` — defense in depth in route handlers.

### 4. Add admin users in Clerk

In Clerk Dashboard → **Users** → **Create user**:

- Add each email from `ADMIN_EMAILS`.
- They'll get a magic-link invite to set password + scan TOTP QR code.
- Done. They can now hit `/admin/login`.

---

## Server-to-server callers (unchanged)

Telegram bot, cron jobs, and ops scripts authenticate via the
`x-admin-password` HTTP header against admin endpoints:

```bash
curl -X POST https://buyhalfcow.com/api/admin/refresh-cache \
  -H "x-admin-password: $ADMIN_PASSWORD"
```

This path:

- Does **NOT** require Clerk session.
- Skips the `ADMIN_EMAILS` allowlist.
- Is enforced in both `proxy.ts` and `lib/adminAuth.ts`.

If you rotate `ADMIN_PASSWORD`, update Telegram bot config + cron secrets at
the same time. Rotation cadence: quarterly minimum, immediately after any
suspected exposure.

The DEV-only `?password=` query param is REMOVED entirely (was already
prod-disabled per audit finding #42 — password in URL leaks to Vercel access
logs, browser history, Referer headers).

---

## Sensitive-action step-up (refund button, legacy upgrade)

Clerk supports **step-up re-verification** for high-risk actions. To require
fresh re-auth on the Stripe refund button or rancher legacy-upgrade:

1. In Clerk Dashboard → **Sessions** → **Reverification**: turn on the
   feature for your app.
2. In the route handler, before performing the destructive action, call:

   ```ts
   import { auth } from '@clerk/nextjs/server';

   const { has } = await auth();
   const fresh = has({ reverification: 'strict' });
   if (!fresh) {
     return NextResponse.json(
       { error: 'reverification_required' },
       { status: 403 }
     );
   }
   ```

3. On the client, catch the 403 and pop Clerk's `<UserVerification />`
   prompt to make the user re-enter their TOTP code, then retry the action.

**Status:** Not yet wired up to refund / legacy-upgrade endpoints. Tracked
as a follow-up commit on `stage-3-verticals`.

---

## Rollback path

If Clerk breaks (e.g. their service goes down, a config change locks us
out), revert this commit:

```bash
git revert <SHA-of-this-commit>
git push origin stage-3-verticals
```

The previous flow was: cookie OR header OR `?password=` (dev). All three
fallbacks come back. No data migration needed — Clerk never wrote to our
DB; the user is identified by email only.

**While reverting:**

- Verify Telegram bot still works (`x-admin-password` header path).
- Verify the legacy POST `/api/admin/auth` returns 200 again (cookie set).
- Verify `/admin/login` renders the password form, not Clerk's `<SignIn />`.

---

## Migration target

- **2026-06-25 (30 days post-merge):** Delete `/api/admin/auth` route
  entirely (currently returns 410 Gone with migration message).
- **Phase 1:** Migrate rancher auth to Clerk (replace
  `app/api/auth/rancher/*` + `lib/auth-rancher*`).
- **Phase 2:** Migrate buyer auth to Clerk (replace
  `app/api/auth/member/*` + `lib/auth-member*`).

Buyer + rancher Clerk migration is out of scope for Phase 0 — they were
just hardened on 2026-05-25 (B1+B2 + audit fixes) and aren't the high-blast-
radius attack surface.

---

## Verification checklist (post-deploy)

- [ ] `/admin/login` renders Clerk's hosted sign-in widget (not the legacy
      password form).
- [ ] Unauthenticated GET `/admin/payments` redirects to `/admin/login`.
- [ ] Authenticated GET `/admin/payments` with an email NOT in
      `ADMIN_EMAILS` redirects to `/?reason=not-admin`.
- [ ] Authenticated GET `/admin/payments` with an email in `ADMIN_EMAILS`
      renders the page.
- [ ] `curl -H "x-admin-password: $ADMIN_PASSWORD" /api/admin/refresh-cache`
      returns 200 (Telegram bot path).
- [ ] `curl /api/admin/refresh-cache` (no auth) returns 401.
- [ ] POST `/api/admin/auth` returns 410 Gone.
- [ ] Telegram bot's `/inbox` and other admin commands still work end-to-end.

---

## Operator gotchas

- **Clerk dev keys vs prod keys.** Dev keys (`pk_test_...`) and prod keys
  (`pk_live_...`) have different user pools. Adding an admin in dev does
  NOT add them in prod. Set them up twice.
- **Magic link vs password.** Both work. Magic link is preferred for
  phishing resistance. Disable password sign-in in Clerk Dashboard if you
  want magic-link-only.
- **Session length.** Clerk default is 7 days. Tighten to 24h in Clerk
  Dashboard → Sessions for stricter security if needed.
- **Empty `ADMIN_EMAILS` in prod = open door.** With no allowlist, any
  signed-up Clerk user can become admin. Always set this env var in prod.
