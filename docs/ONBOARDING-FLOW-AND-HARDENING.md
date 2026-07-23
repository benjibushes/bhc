# Rancher Onboarding — Canonical Flow Map + Hardening Plan

*Written 2026-07-23 after the "Justin" incident (a rancher whose signup failed
silently — no record, no email, no alert). Source: a 19-agent read-only
deep-dive (adversarially verified) over every door, record write, email, and
state transition, plus external research on signup reliability. This is the
single source of truth for how a rancher goes from signup → live → payable,
and where it can silently break.*

---

## 1. What happened to Justin (root cause)

Justin submitted at `/apply`, saw an error, and **nothing was written
anywhere** — no Ranchers record, no Email Sends row, no Telegram, at most a
Vercel `console.error` nobody watches.

The mechanism is the **pre-record-write window** of `POST /api/apply`:
- `mintUniqueSlug` (route.ts:236) does up to **48 sequential** filtered
  `getAllRecords` scans on slug collision.
- `findOrCreateRancherByEmail` (lib/airtable.ts:848) then does an **unfiltered
  full-table `getAllRecords(RANCHERS)` scan** before the create.
- All under `maxDuration = 30s`, and **none** of it is wrapped in
  `withRateLimitRetry`.

Under Airtable's 5 req/s cap (any onboarding wave, cron overlap, or a common
ranch name), this path **throws or times out**. On a throw → the catch
(route.ts:351) returns a 500 and logs `console.error` only. On a hard timeout
kill → **the catch never even runs**. Either way: no record, no email, and
**no alert to Ben**. That is why Justin was invisible.

**The systemic hole:** PR #446 hardened everything *after* the record exists.
The moment *before* it exists — every 400 (validation), 429 (rate limit), 500
(Airtable throw), and timeout — is a **trace desert**. A qualified rancher can
fail at the door and no human is ever told. For every Justin we hear about,
others fail silently.

---

## 2. Canonical flow map

### Doors (3, all → 2 endpoints)
| Door | Path | Endpoint | Creates |
|---|---|---|---|
| Apply (primary) | `/sell` → `/apply` | `POST /api/apply` | Ranchers row |
| Map self-submit | `/map/add-a-rancher` | `POST /api/prospects/self-submit` | Ranchers row |
| Book a call | `/book?purpose=rancher` | Cal.com | (no record until call) |

### Record writes (create sites + update chain)
1. **Create — /api/apply** (`findOrCreateRancherByEmail`): Operator Name, Ranch
   Name, Email, Phone, City, State, **Status='Pending'**, **Pricing
   Model='legacy'**, Operation Details, Slug. **Onboarding Status left BLANK**
   (load-bearing — blank is the ONLY thing routing the row into
   `rancher-followup`'s New-Applicant chase). Idempotent dedupe by
   email → team-email → phone → ranch+state.
2. **Create — /self-submit**: Verification Status='Prospect', Source
   Type='manual-add', Self-Submitted At, Self-Submit Drip Stage='welcome-sent',
   Pricing Model='legacy', Slug, Lat/Lng. **Does NOT write Status or Onboarding
   Status** (divergence from /apply).
3. **Wizard saves** (`PATCH /api/rancher/setup`): a **content whitelist only**
   (route.ts:40-92) — explicitly barred from Onboarding/Active/Verification/Page
   Live/Agreement. **The wizard never advances state.**
4. **Request agreement**: Onboarding Status='Docs Sent' + Docs Sent At.
5. **Stripe Connect** (`connect/start` + `connect/status` + `account.updated`
   webhook): Stripe Connect Account Id, Stripe Connect Status, Connect
   Connected At, Migration Status.
6. **Sign agreement** (`/api/ranchers/sign-agreement`): ONE atomic write —
   Agreement Signed, Signature Name, Commission Rate + lock, and *if*
   `readyToGoLive`, the full go-live union (Onboarding='Live', Active
   Status='Active', Page Live=true, Status='Active').

### Emails (each: trigger → template → failure visibility)
All route through `guardedSend` → single Resend client reading
`process.env.RESEND_API_KEY` (**prod key is healthy**; the dead key is only in
`.env.local` / the Resend MCP plugin — local-only).

| Email | Trigger | Template | On failure |
|---|---|---|---|
| Welcome + wizard link | /api/apply success | `sendRancherApplyAutoApproved` | **#446: stamps Operation Details + Telegrams Ben the link** ✅ |
| Self-submit welcome | /self-submit success | `sendRancherSelfSubmitWelcome` | **result DISCARDED — silent** ❌ |
| Setup-link resend | `/api/rancher/setup/resend-link` | `sendRancherSetupLink` | Email Sends row + `console.error` only — **no push** ❌ |
| Agreement reminder | `cron/email-sequences` | drip | **stamps stage regardless of send result** ❌ |
| Approval / go-live / Connect nudges / first-lead | various | various | mixed |

`guardedSend` truth: returns `{success:false, suppressed:true}` on
cap/paused/suppression-list (logs `status='suppressed'`); `{success:false,
suppressed:false}` on a resolved `{error}` — the dead-key shape (logs
`status='failed'`); `{success:true}` otherwise (logs `sent`). It **only throws
when send() itself throws — and that path writes NO Email Sends row** (the one
invisible send-failure shape).

### State machine — path to LIVE and PAYABLE
```
signup ─► Status=Pending, Onboarding=BLANK, Pricing=legacy
          (blank Onboarding = New-Applicant chase rail)
   │  (wizard fills content — does NOT advance state)
   ▼
request-agreement ─► Onboarding=Docs Sent
   │
   ▼
sign-agreement ─► Agreement Signed + Commission locked
   ├─ readyToGoLive?  legacy = slug + price + payment link
   │                  tier_v2 = slug + price + Connect active
   │        YES ─► LIVE (Onboarding=Live, Active=Active, Page Live=true, Status=Active)
   │        NO  ─► stays "Agreement Signed"  ← signed-but-dark cohort
   └─ preVetted tier_v2 ─► Verification=Verified, Onboarding=Verification Complete
```
**LIVE** = Page Live=true. **PAYABLE** = Active + a working rail (Connect active
OR legacy payment link). Go-live is written by **4 different code paths** with
slightly different field sets — the split-brain risk (some omit `Status=Active`).

---

## 3. The 12 confirmed blockers (verified)

**Pre-write invisibility (the Justin class) — highest priority:**
1. `/api/apply` timeout mid-flow (slug + dedupe scans under `maxDuration=30`) →
   rancher error, nothing written, **catch never runs → zero trace**.
2. `/api/apply` Airtable create throw → 500 + `console.error` only, **no Telegram**.
3. `findOrCreateRancherByEmail` unfiltered full-table scan throws → silent 500
   (Justin's exact incident).
4. `/self-submit` create failure → same silent 500, no rate limiting either.

**Email strandings:**
5. Setup-link resend suppressed/failed (bounced/unsub — the Vale Creek class) →
   stuck rancher gets nothing, Ben gets no push.
6. `/self-submit` welcome result discarded → suppressed/failed setup email is
   fully silent.

**Connect / state:**
7. `connect/start` creates a real Stripe account but fails to persist the
   Account Id → **orphan/duplicate billable Connect accounts**, `console.error` only.
8. Connect-webhook auto-go-live failure → Connect-active-but-dark rancher, unsignaled.
9. Go-live written by 4 paths, some omit `Status=Active` → silent split-brain.
10. Force-Live / `force=true` bypasses the payment smoke with **no persisted
    "smoke skipped" marker**.

**Read integrity:**
11. **Fresh rancher invisible for ~10s+** — `findRancherByEmail` reads the
    stale cached rancher list; a just-created row misses `resend-link` and
    dedupe (this is why the first resend looked un-sent tonight).
12. Manual/MCP record creation never busts the cache → L1+L2 serve stale until TTL.

## 4. The theme across 40 observability gaps
Every one is the same disease: **a failure that writes no record also writes no
alert.** The platform is blind to its own front door. There is no failed-submit
beacon, no synthetic canary on `/apply`, no "started-but-didn't-finish" rollup,
and no real-time watch on Email Sends failures.

---

## 5. Systematization plan (ranked — build in this order)

### Phase 1 — KILL THE SILENT FAILURE (this week, before more ranchers)
*Goal: it becomes impossible for a rancher to fail at the door without Ben knowing.*
- **Loud rescue alert** in BOTH create-failure catches (`/api/apply:351`,
  `/self-submit:363`): `sendOperatorSignal` (loud, deduped) carrying the full
  submitted name/email/phone/state + error, so Ben can hand-create + resend in 60s.
- **Failed-submit beacon**: client `navigator.sendBeacon('/api/signup/failure-beacon')`
  on any non-2xx/throw/timeout (fires even as the page tears down) → writes a
  `Signup Attempts` row {ts, ip, email, ranch, state, outcome, reason}. Turns
  the trace desert into a queryable trail; also catches 429/400 give-ups.
- **Synthetic `/apply` canary** (extend `synthetic-e2e`): POST a tagged test
  rancher hourly, assert 200 + wizardUrl + record, hard-delete, alert on
  failure. A fully broken signup door becomes detectable in ≤1h, not "when a
  human complains."

### Phase 2 — MAKE THE WRITE RELIABLE (removes the Justin *cause*)
- Raise `/api/apply` `maxDuration` 30→60; wrap lookup+create in
  `withRateLimitRetry`.
- **Mint the slug AFTER a successful create** (or lazily); cap the collision
  loop; replace the full-table dedupe scan with a **filtered** query.
- Add a ~20s internal timeout race that Telegrams the payload before the
  function is killed.
- `connect/start`: retry the Account-Id persist; on final fail, loud signal
  with accountId+rancherId (rescue the orphan).

### Phase 3 — EMAIL DELIVERY BECOMES STATE
- Capture + flag the `/self-submit` welcome result (mirror #446).
- `resend-link` + agreement-drip: alert on `{success:false}`, only advance the
  drip stage on `success:true`.
- `guardedSend`: log `status='failed'` before re-throwing (close the no-row shape).
- **Resend delivery webhooks as state**: stamp email.sent/delivered/bounced onto
  the record; **hard bounce → immediate Telegram a human** (dead address = manual
  rescue, the Justin/Vale Creek pattern); soft bounce → retry w/ backoff.
- **"Link never delivered" sweep**: cron finds setup-link sent but no
  delivered/bounced webhook in N min → Telegram.

### Phase 4 — COHORT OBSERVABILITY (never fly blind again)
- **Read-after-write**: `findRancherByEmail` falls back to ONE filtered live
  read on a full-scan miss (bypasses cache) before returning null.
- **Started-vs-completed** funnel counters; a daily **"ranchers who started but
  didn't finish"** line in `daily-health-digest` (blank Onboarding >2d,
  signed-but-dark, Connect-stuck).
- Chase crons return `status:'partial'` on a zero-touch/degraded read so a
  silently-broken chase actually alarms.
- Make welcome-email failure a **queryable field** (`Welcome Email Failed At`),
  not free-text buried in Operation Details.

---

## 6. Pre-onboarding runbook (use for every rancher this week)
Until Phase 1 ships, onboard defensively:
1. Have them submit at `/apply` with **all `*` fields incl. phone**; watch the
   screen — the **"Build my page" link appears on success**; tell them to click
   it immediately (don't wait on email).
2. If they report ANY error: get the **exact red error text** (names the cause:
   phone / email / server). If it's a server error, they hit the pre-write
   window — hand-create + `POST /api/rancher/setup/resend-link {email}` (works
   once the record exists; allow ~15s for the cache).
3. Confirm the setup email via the **direct Airtable Email Sends filter**, not
   the MCP search (it lags on fresh rows).
4. Verify the link opens their ONBOARDING wizard before moving on.
