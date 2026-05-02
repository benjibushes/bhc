# Project 1 — Discover Map (handoff)

**Branch:** `stage-1.5-map`
**Worktree:** `/Users/benji.bushes/BHC/untitled folder/bhc/.claude/worktrees/map`
**Status:** code complete · typecheck clean · `npm run build` clean · awaiting commit + review

The acquisition wedge for ranchers — a public map of every direct-to-consumer
rancher in America. Verified BuyHalfCow partners + AI-discovered prospect pins,
plus a claim flow that funnels new ranchers into the existing Stage 1 onboarding
pipeline. Per spec, Sprint 1.6 (cron outreach) is **deferred and not shipped**.

---

## 1. Airtable schema

All Project 1 fields already exist on the **Ranchers** table
(`tbl08y9Be45zNG0OG`, base `appgLT4z009iwAfhs`). Verified via
`mcp__d5aec254-622f-48e6-9468-0b36405e9a80__list_tables_for_base`:

| Field | Field ID | Type | Notes |
|---|---|---|---|
| `Verification Status` | `fldtdEmjN0BuGHDA6` | singleSelect | Existing options: `Not Started`, `Verified`. Project 1 adds `Prospect` and `Removed` via `typecast: true` on first insert (Airtable auto-creates select options). If your base disallows API-side option creation, add `Prospect` + `Removed` manually before running the WY seed. |
| `Latitude` | `fldPsGcxDpdEetGph` | number | Geocoded via Nominatim during discovery. |
| `Longitude` | `fldij7yLe9uqKQ45C` | number | |
| `Source URL` | `fld1yQ1AnINuaQ9ZD` | url | Where the AI scraper found this prospect. |
| `Source Type` | `fldIMOStmD7xP0e0w` | singleSelect | `web-search` / `manual-add` / `claimed` / `usda-directory` / `state-extension` |
| `Discovery Confidence` | `fldTpT8ZdDv5UgdDj` | number | 0–100; only `>= 60` are inserted. |
| `Discovered At` | `flddywu2DuhgJ5ZRB` | dateTime | |
| `Claim Token` | `fldbBOaNQZ8Wx5O7W` | singleLineText | One-time-use, burned on click. |
| `Claim Sent At` | `fldXVUFCXG8QWp5Tg` | dateTime | |
| `Claim Status` | `fldXRqLSzxmHlRRiw` | singleSelect | `unclaimed` / `email-sent` / `claim-pending` / `claimed` / `declined` / `removed-on-request` |
| `Public Map Hidden` | `fldBGrSclgqVsAkNQ` | checkbox | Honored by `/map` AND `/ranchers/<slug>` (returns 404). |
| `Primary Product` | `fldfMiIm0PhlFZrqC` | singleSelect | `Beef` / `Pork` / `Lamb` / `Multi-species` / `Dairy` / `Other` |

**Heads-up on `Verification Status`:** existing options are `Not Started` and
`Verified`. The first insert that writes `"Prospect"` (or `"Removed"`) will
auto-create the option via `typecast: true` in `lib/airtable.ts`. Some Airtable
plans throw `Insufficient permissions to create new select option` — if the
WY seed shows that error, add the two options manually in the field dropdown
and re-run.

---

## 2. Files created / modified

### Created (in `stage-1.5-map`)
```
app/map/page.tsx
app/map/components/DiscoverMap.tsx
app/map/components/DiscoverMapClient.tsx          (Next 16 ssr:false workaround)
app/map/components/MapLegend.tsx
app/map/components/StateFilter.tsx
app/map/components/ProductFilter.tsx
app/components/ProspectClaimBanner.tsx
app/ranchers/[slug]/claim/page.tsx
app/ranchers/[slug]/claim/ClaimForm.tsx
app/ranchers/[slug]/remove/page.tsx
app/ranchers/[slug]/remove/RemoveForm.tsx
app/api/prospects/claim/route.ts                  (POST=form submit · GET=magic link)
app/api/prospects/remove/route.ts                 (POST=opt-out · no auth)
lib/aiSearch.ts                                   (Tavily / Anthropic fallback)
scripts/discover-ranchers.mjs                     (gitignored — operational)
PROJECT-1-MAP-COMPLETE.md                         (this file)
```

### Modified
```
app/ranchers/[slug]/page.tsx     prospect banner + JSON-LD + hide pricing/payments for prospects
app/sitemap.ts                   add /map at priority 0.8
lib/airtable.ts                  added getRancherOrProspectBySlug helper
lib/email.ts                     added sendProspectClaimMagicLink (NO modification of the 7 Stage 1 founder-voice functions)
lib/secrets.ts                   exports TAVILY_API_KEY + NOMINATIM_USER_AGENT
package.json                     leaflet ^1.9.4 · react-leaflet ^5.0.0 · @types/leaflet ^1.9.21
```

### NOT modified (sibling territory + Stage 1 untouchables)
- The 7 Stage 1 founder-voice email functions in `lib/email.ts`
- `app/api/cron/email-sequences/route.ts`
- `app/api/cron/rancher-launch-warmup/route.ts` (Agent A)
- `app/api/cron/batch-approve/route.ts`
- `app/api/consumers/route.ts`
- `app/api/matching/suggest/route.ts`
- `app/api/warmup/engage/route.ts` (Agent A)
- `app/api/webhooks/stripe/route.ts` (Agent C)
- `app/api/webhooks/telegram/route.ts` (Agent A)
- `app/founders/*` (Agent C)
- `app/matched/page.tsx` (Agent A)
- `scripts/buyer-stage-migration.mjs`, `scripts/relaunch-broadcast.mjs`

---

## 3. WY seed

**Status: not yet executed.** The scraper is built and dry-run-ready; per the
assignment, real execution is held until you run it manually so you can
eyeball each candidate.

### Run command (dry-run)
```bash
cd "/Users/benji.bushes/BHC/untitled folder/bhc/.claude/worktrees/map"
node --env-file=.env.local scripts/discover-ranchers.mjs --state WY
```

### Run command (write to Airtable)
```bash
node --env-file=.env.local scripts/discover-ranchers.mjs --state WY --execute
```

### Required env vars in `.env.local`
- `AIRTABLE_API_KEY`, `AIRTABLE_BASE_ID` — already present
- `ANTHROPIC_API_KEY` — required for the classifier (and the search fallback)
- `TAVILY_API_KEY` — optional. If set, Tavily is the primary search provider; if absent, falls back to Anthropic native `web_search`.
- `NOMINATIM_USER_AGENT` — optional. Defaults to `BuyHalfCow/1.0 (ben@buyhalfcow.com)`. **Don't ship without setting this in Vercel** — Nominatim ToS bans anonymous requests.

### Expected WY output (rough estimate)
WY is the lowest-density rancher state by design (fast verification):
- Discovery: 6 queries × ~10 results each = ~60 raw URLs
- Classify (Claude Sonnet, batched in 8s): ~30–40 unique candidates
- After dedupe vs existing (1 WY ranch already in Airtable: Truly Beef):
  ~10–20 fresh prospects @ confidence ≥ 60
- Geocode: ~80–95% Nominatim hit rate (with state-fallback)
- Insert: ~10–18 prospect records
- Wall-clock: ~3–5 min (mostly Nominatim's 1.1s sleep)

### Full national seed (DO NOT run from this session)
Save for the relaunch broadcast. ~50 states × ~5 min/state = **~4–8 h wall-clock**.
```bash
node --env-file=.env.local scripts/discover-ranchers.mjs --all-states --execute
```

---

## 4. URLs to verify after merge

| URL | Behavior |
|---|---|
| `/map` | Server-rendered server page, embeds the Leaflet client component. Verified pins green, prospect pins grey-dashed. State + Product filters. Counter "X verified · Y working with us · Z states covered". `Public Map Hidden` records skipped. `Verification Status = "Removed"` records skipped. |
| `/ranchers/<verified-slug>` | Existing flow unchanged. Pricing, payment links, RancherLeadModal all live. |
| `/ranchers/<prospect-slug>` | Renders the same template + `<ProspectClaimBanner />` at top. Hero badge says "Direct-to-consumer rancher · unclaimed listing". Hides Pricing + Custom Products + Reserve sections. Adds bottom CTA "Are you {ranchName}?" linking to `/claim`. JSON-LD `LocalBusiness` includes `disambiguatingDescription` flagging it's unclaimed. |
| `/ranchers/<slug>/claim` | Form: operator name, email, phone. Submits to `POST /api/prospects/claim`. Magic-link goes to scraped Email if present (anti-impersonation), else to submitter (Telegram alert flagged for manual review). |
| `/ranchers/<slug>/claim?confirmed=1` | Confirmation page after magic link is clicked. |
| `/ranchers/<slug>/remove` | Form: optional contact email + optional reason. Submits to `POST /api/prospects/remove`. No auth (legal-compliance). Sets `Public Map Hidden = true`, `Verification Status = "Removed"`, `Claim Status = "removed-on-request"`, `Page Live = false`. Telegram alert fires immediately. After this, `/ranchers/<slug>` returns 404 and the pin disappears from `/map`. |
| `/sitemap.xml` | Includes `/map` at priority 0.8. Verified rancher landing pages still listed (`Page Live = 1` filter). |

---

## 5. Verification commands

```bash
cd "/Users/benji.bushes/BHC/untitled folder/bhc/.claude/worktrees/map"

# typecheck
npx tsc --noEmit                     # expect: clean

# build
npm run build                        # expect: clean

# scraper dry-run
node --env-file=.env.local scripts/discover-ranchers.mjs --state WY

# scraper execute (writes to Airtable)
node --env-file=.env.local scripts/discover-ranchers.mjs --state WY --execute

# manual sanity-check the map after a seed
open http://localhost:3000/map       # after `npm run dev`

# inspect a prospect landing page (replace slug with one from the seed output)
open http://localhost:3000/ranchers/<prospect-slug>

# claim flow (manual end-to-end)
# 1. visit /ranchers/<slug>/claim
# 2. submit form with your email
# 3. check inbox for "confirm your <ranch> listing on BuyHalfCow"
# 4. click magic link → should land on /ranchers/<slug>/claim?confirmed=1
# 5. confirm Airtable Claim Status flipped to "claim-pending"
# 6. confirm Telegram alert fired

# remove flow
# 1. visit /ranchers/<slug>/remove
# 2. submit (no fields required)
# 3. confirm /ranchers/<slug> returns 404
# 4. confirm pin gone from /map (revalidate window: 30 min — bust cache or wait)
# 5. confirm Telegram alert fired
```

---

## 6. Architecture notes

### `getRancherOrProspectBySlug` vs `getRancherBySlug`
`/ranchers/[slug]/page.tsx`, `/claim`, `/remove`, and the prospect API routes
all use the **new** helper `getRancherOrProspectBySlug` in `lib/airtable.ts`.
It returns:
- Verified ranchers with `Page Live = 1`, **OR**
- Prospect records (regardless of `Page Live`)

while excluding records that are `Public Map Hidden = 1` or
`Verification Status = "Removed"`. This single function gates all public
prospect surfaces — change it once and everything respects the new policy.

The legacy `getRancherBySlug` (verified-only) is still used by:
- `app/api/public/ranchers/[slug]/route.ts` (the rancher contact JSON API)
- `app/api/public/ranchers/[slug]/contact/route.ts`

These routes only serve verified ranchers — prospects can't take messages.

### Magic-link claim semantics
- **Token storage:** random 16 bytes (32 hex chars) generated in `randomBytes`. Written to `Claim Token` + `Claim Sent At` on form submit.
- **Token verification:** GET handler checks the token matches, then **burns** it (sets to empty string). Re-clicking the link returns "invalid".
- **Anti-impersonation:** if the prospect has an `Email` field already populated (the scraper sometimes finds an email in snippets), the magic link goes to THAT address, not the form-submitted one. Telegram alert distinguishes the two paths so Ben can intervene if a third party tries to grab a listing.
- **No automatic Verified flip:** clicking the magic link only flips `Claim Status` to `claim-pending`. Becoming `Verified` still requires the existing onboarding flow (Verification Complete + Agreement Signed + Active=Active + Onboarding Status=Live), which Ben drives manually.

### Onboarding handoff
After magic link click, the standard rancher-onboarding flow takes over:
1. Telegram alert fires → Ben books a call (Calendly / direct)
2. Ben sends docs via `/api/ranchers/[id]/send-onboarding`
3. Rancher signs agreement → `Active Status = Live` → `Onboarding Status = Live`
4. Throttled `rancher-launch-warmup` (Project 2's refactor) takes over for buyer warming
5. The `Onboarding Intro Pace` field (per Project 2) defaults to 5/wk in code if blank — Ben can set per-rancher pace post-claim

> TODO when Project 2's schema is live: the claim onboarding form should ask for `Onboarding Intro Pace`. For now, leave-blank → defaults to 5/wk per Agent A's throttle code. (Comment is inline in `app/api/prospects/claim/route.ts`.)

### Opt-out (no auth) trade-offs
The remove flow is intentionally unauthenticated — legal compliance for
scraped listings outweighs the false-removal risk. Mitigations:
- Telegram alert on every removal so Ben sees it within seconds
- Removal is reversible (just clear the 4 fields in Airtable)
- All `Removed` records are excluded from `getRancherOrProspectBySlug`, `/map` query, and `Page Live` sitemap

### Map render path (Next.js 16 / Turbopack)
Server Components in Next 16 cannot use `dynamic({ ssr: false })` directly.
The pattern used:
```
app/map/page.tsx                  (server component, fetches pins)
  → app/map/components/DiscoverMapClient.tsx  ('use client' wrapper, dynamic-imports the Leaflet bundle)
    → app/map/components/DiscoverMap.tsx     (the Leaflet/react-leaflet client)
```
This keeps the data fetch on the server (cached + revalidated every 30 min)
and isolates Leaflet's `window`-touching to the client.

---

## 7. Known small gaps (acceptable for ship)

- `Verification Status` may need `Prospect` + `Removed` options added in Airtable UI before the WY seed (auto-create via typecast usually works, but plans differ).
- Prospect pages aren't pre-rendered at build time (`generateStaticParams` only includes `Page Live = 1`). They're SSR-on-demand with 10-min revalidate — fine for SEO, just not in the static manifest.
- The classifier batches in groups of 8 with a single Sonnet call per batch. If a batch's JSON parse fails, the whole batch is auto-rejected (logged). Acceptable noise floor.
- Search fallback (Anthropic native `web_search`) is slower and less structured than Tavily. Set `TAVILY_API_KEY` for production seeds.
- Magic link doesn't expire by time (only by use). If a token leaks via email forwarding, anyone who clicks can flip `Claim Status` to `claim-pending`. Verified flip still requires manual onboarding, so the blast radius is minimal — Telegram alerts surface the risk.

---

## 8. Sprint 1.6 (deferred — not shipped)

`app/api/cron/prospect-outreach/route.ts` is **not** in this branch per spec.
When eventually built, it should:
- Filter prospects: `Verification Status = "Prospect" AND Claim Status = "unclaimed" AND Email IS NOT BLANK AND Discovered At < 48h ago`
- Fire `sendProspectColdOutreach` (a future founder-voice email — does NOT exist yet, do not write it now)
- Throttle: max 50 prospects/day, max 1 email per prospect ever, 24h cooldown between sends
- Suppression: same suppression list as buyer emails (`Unsubscribed`/`Bounced`/`Complained`)

---

## 9. Quick commit guide for review

The branch `stage-1.5-map` is ready. From a non-isolated shell:

```bash
cd "/Users/benji.bushes/BHC/untitled folder/bhc/.claude/worktrees/map"
git status                            # confirm the file list above
git add -A                            # /scripts is gitignored — won't be added
git commit -m "Project 1 — Discover Map (ready for review)"

# DO NOT push to main. The branch lives until Stage 1.5 ship gate.
```

After commit, this worktree's commit hash should be the new tip of
`stage-1.5-map`. Ship sequence is:
1. Run WY seed (above) → eyeball results in Airtable
2. If results look good, scope full national seed for the relaunch (~8h)
3. Merge `stage-1.5-map` into the integration branch alongside Agent A
   (`stage-1.5-throttle`) and Agent C (`stage-2-founders`) per the runbook
