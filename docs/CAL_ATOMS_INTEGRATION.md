# Cal.com Atoms Integration — Branch `feat/cal-atoms-integration`

Comprehensive Cal.com OAuth + Atoms SDK integration. Built on a feature
branch while the Cal-side OAuth client is in **PENDING admin approval**
state — owner-only authorization works for E2E testing now, full rollout
unblocks the moment Cal approves the client.

## What this branch does for the business

**Before:** ranchers paste a Cal.com slug into BHC, buyers click a CTA
that drops them on `cal.com/<slug>` to book. Two surfaces, two brands,
buyer leaves BHC.

**After:** ranchers connect Cal via inline OAuth (one click in the
wizard), BHC programmatically creates their event types + webhooks, and
buyers book on a Cal embed widget that lives INSIDE `/ranchers/<slug>`
on the BHC domain. No leaving BHC. Buyer fields pre-fill. Bookings flow
back automatically.

## Files shipped on this branch

### Backend (no UI changes yet)

- **`lib/cal.ts`** — OAuth + Cal API wrapper. Single source of truth for
  every Cal interaction. Handles token refresh + rotation automatically.
- **`/api/auth/cal/start`** — rancher hits this from the dashboard
  "Connect Cal" CTA → 302 to Cal authorize URL with signed-state JWT.
- **`/api/auth/cal/callback`** — Cal redirects here w/ code → exchange
  for tokens → persist on Rancher row → Telegram alert → 302 to dashboard.
- **`/api/rancher/cal/status`** — live connection check (calls /me on
  rancher's Cal account) so dashboard can render precise state
  (connected/expired/disconnected/error).
- **`/api/rancher/cal/setup-event-types`** — one-shot post-connect setup.
  Creates two standard event types (intro-15, sales-30) + registers our
  webhook on the rancher's Cal account. Idempotent.
- **`/api/rancher/cal/bookings`** — live bookings list for the dashboard
  panel. Pulls from Cal API, cached 30s.
- **`/api/rancher/cal/disconnect`** — revokes our connection: deletes
  the webhook (best effort) + nukes all 8 stored Cal fields.

### Airtable fields auto-created on first write (typecast: true)

On the `Ranchers` table:
- `Cal OAuth Access Token` (long text)
- `Cal OAuth Refresh Token` (long text)
- `Cal Token Expires At` (datetime)
- `Cal User ID` (number)
- `Cal Username` (single line text)
- `Cal Event Type Intro Id` (number)
- `Cal Event Type Sales Id` (number)
- `Cal Webhook Id` (single line text)

### Env vars required on Vercel production (already set)

- `CAL_OAUTH_CLIENT_ID` — created via app.cal.com OAuth client form
- `CAL_OAUTH_CLIENT_SECRET` — same
- `NEXT_PUBLIC_CAL_OAUTH_CLIENT_ID` — same value as above, for Atoms client
- `CAL_WEBHOOK_SECRET` — for HMAC verify on `/api/webhooks/cal` (already
  exists from prior CONN-5 work — gets reused for the new per-rancher
  webhook registrations)

## What still needs to ship on this branch (UI work)

These layer on top of the backend already shipped. Each is independent
— ship in any order.

### 1. Install `@calcom/atoms` package

```
npm i @calcom/atoms
```

Adds Cal's React component library. Roughly +200KB to the client bundle
(tree-shakes per atom). Wrap app with `<CalProvider clientId={...}>` so
atoms can talk to Cal API on the buyer's behalf.

### 2. Wizard "Connect Cal" step

Add a step (or sub-step) between current tier-pick and Stripe Connect
where the rancher hits `<OnboardingEmbed />` to create+authorize a Cal
account inline. If they already have a Cal account, sign in flow handles
it. Post-success: auto-fire POST `/api/rancher/cal/setup-event-types` so
event types + webhook get created server-side.

### 3. Rancher dashboard Cal panel

New panel on `/rancher` showing:
- Status badge (Connected as @username / Expired / Not connected)
- Recent bookings list (next 10 upcoming + last 10 past)
- "Disconnect" button → POST `/api/rancher/cal/disconnect`
- "Re-authorize" if expired → links to `/api/auth/cal/start`
- Embedded availability editor (Atoms `<AvailabilitySettings />`)

### 4. Buyer-facing Cal embed on `/ranchers/[slug]`

Replace the current external `cal.com/<slug>` link with `<Booker />`
atom rendering inline. Pre-fills buyer name + email + metadata.

### 5. Operator-tier override

When rancher is Operator tier, embed BEN's Cal sales event instead of
the rancher's intro. Per-tier branching is already wired in `lib/email.ts`
— just port the same logic to the embed surface.

### 6. Telegram alert on first buyer booking

Auto-stamp "First Buyer Booking At" on Rancher row when their first
booking comes through the Cal webhook handler. Surface on
`/admin/migration` so we can celebrate.

## Test plan (while client is PENDING)

You (Ben, the OAuth client owner) can authorize during pending state.
Use this to E2E test before approval lands.

1. Locally: `npm run dev`
2. Sign in to `/rancher` dashboard as a test rancher (use admin
   impersonate if needed)
3. Hit `/api/auth/cal/start` → Cal authorize → click Allow
4. Verify callback persists 4 token fields on the Airtable Rancher row
5. POST `/api/rancher/cal/setup-event-types` (curl or Postman) → check
   for Telegram success alert + 3 new fields persisted
6. GET `/api/rancher/cal/status` → expect `{ state: 'connected', ... }`
7. GET `/api/rancher/cal/bookings` → expect `{ bookings: [...] }`
8. POST `/api/rancher/cal/disconnect` → verify all 8 fields cleared +
   webhook deleted Cal-side

## Rollout sequence (after Cal admin approves)

1. **Merge branch to main** — typecheck clean, all backend live
2. **Install Atoms** + ship UI pieces (wizard step, dashboard panel,
   embed widget)
3. **Pilot: 1 rancher** — flip one of the 5 pilots to use the embed end-to-end
4. **Validate first buyer booking** — make sure the webhook fires +
   Airtable updates + Telegram alerts
5. **Roll out to remaining 4 pilots** — they re-connect via dashboard
6. **Roll out to all new `/apply` signups** — wizard defaults to Cal embed path
7. **Migrate the 9 non-pilot legacy ranchers** — same upgrade flow

## Failure modes + recovery

| Failure | Recovery |
|---|---|
| Cal admin rejects OAuth client | Owner re-applies via Cal UI w/ new purpose/redirect; everything else unchanged |
| Token refresh fails (refresh token revoked) | `getCalConnectionStatus` returns 'error' → dashboard shows "Reconnect" CTA → POST disconnect + start fresh OAuth |
| Cal webhook delivery fails | Already retried by Cal; manual re-register via setup-event-types (idempotent) |
| Event-type slug collision (re-connect same Cal acct) | `createEventTypeForRancher` throws → operator manually picks different slug suffix |
| Rancher disconnects mid-flow | All 8 fields cleared + webhook deleted; dashboard reverts to "Connect Cal" CTA |

## Security notes

- `state` param on OAuth start is signed JWT (10-min expiry) — prevents
  CSRF + tells callback which rancher to attach tokens to
- Tokens stored in Airtable plain-text (long text field) — encrypted at
  rest by Airtable but visible to anyone with base API access; rotate
  the access pattern if this becomes a security concern
- Webhook HMAC verify already gates `/api/webhooks/cal` from spoofing
- Client secret in Vercel env only — never in repo, never in client bundle
