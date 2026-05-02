# Project 2 — Onboarding Throttle (handoff)

**Branch:** `stage-1.5-throttle`
**Author:** Agent A
**Goal:** prevent the "108-email same-day blast" first-impression destroyer when a TX (or any state with backlog) rancher activates. Replaces the one-shot `rancher-launch-warmup` drain with a per-rancher batched throttle, plus a first-week founder-approval gate in front of YES-click matching. Closes the Stage 1 gap where warmup cron filtered on `Referral Status = "Waitlisted"` instead of `Buyer Stage`.

---

## 1. Schema fields added

### Ranchers table (`tbl08y9Be45zNG0OG`)

| Field name | Field ID | Type | Purpose |
|---|---|---|---|
| `Onboarding Intro Pace` | `fldmNxN6YYv62070a` | number (precision 0) | Max warmup emails per WEEK during onboarding phase. Default 5 in code if blank. |
| `Onboarding Phase Until` | `fldwQOkxdud7loVl2` | dateTime (UTC ISO) | Set to wentLiveAt + 30d on Status flip to Live (set manually for now; future iteration can wire into `app/api/rancher/activate/route.ts`). After this passes, trust-promotion cron flips Trust Mode=true. |
| `Trust Mode` | `fldHDIBGCU5O5eoVD` | checkbox (icon: check, color: greenBright) | When TRUE, throttle is OFF for this rancher (legacy one-shot drain) AND the first-week founder-approval gate releases. |
| `Warmup Last Batch At` | `fldYjqbqwPQ9igfM7` | dateTime (UTC ISO) | Per-rancher 24h cooldown enforced by the throttle branch of `rancher-launch-warmup`. |

### Referrals table (`tblBfimb4Gt8C0fu4`)

| Field name | Field ID | Type | Purpose |
|---|---|---|---|
| `Approval Status` | `fldspsGdGoW6z9NrK` | singleSelect (`pending-approval`, `approved`, `held`, `skipped`) | First-week founder approval gate state. `pending-approval` = staged via Telegram by `/api/warmup/engage`; `approved`/`held`/`skipped` are flipped by `firstweek_*` Telegram callbacks. |

Base ID for all of the above: `appgLT4z009iwAfhs`.

---

## 2. Throttle behavior

### Cron `/api/cron/rancher-launch-warmup` (refactored)

For every operationally-Live rancher (`isRancherOperationalForBuyers`), one of two paths runs:

**A. Trust Mode = TRUE** → legacy one-shot drain (`Launch Warmup Triggered`-gated). Same behavior as pre-rebuild: pull every `Referral Status = "Waitlisted"` buyer in the rancher's served states, send `sendRancherLaunchWarmup`, mark them. Subject to global `WARMUP_CAP_PER_RUN = 100` cap.

**B. Trust Mode = FALSE** → batched throttle:
1. **24h cooldown**: skip rancher if `Warmup Last Batch At` < 24h ago.
2. **Daily batch size**: `Math.max(1, Math.ceil(Onboarding Intro Pace / 7))`. Default `Onboarding Intro Pace = 5` → 1/day (≈ 7/week which is conservatively above 5).
3. **Candidate filter** (Airtable formula, runs against Consumers table):
   - `Buyer Stage IN ('WAITING','READY')` ← the Stage 1 gap closer
   - `UPPER(State)` matches one of the rancher's States Served
   - No `Warmup Sent At` yet
   - `Status = 'Approved'`
   - Not Unsubscribed/Bounced/Complained
   - `Buyer Health != 'Non-Responsive'`
4. **Priority sort** (`priorityScore`):
   - `Ready to Buy` → +100
   - `Warmup Engaged At` → +80
   - `Buyer Stage = 'READY'` → +60
   - `Last Login At < 14d` → +50 (field reserved; null-safe today)
   - Signup age < 30d → +30; > 90d → −20
5. **Send + flip**: top N buyers receive `sendRancherLaunchWarmup`, get `Warmup Sent At` + `Warmup Stage='sent'` + `Buyer Stage='READY'` + `Buyer Stage Updated At`. Rancher gets `Warmup Last Batch At` stamped (cooldown).

Phase 2 (Day-7 nudge for buyers with `Warmup Sent At` ≥ 7d and no engagement) is unchanged. Telegram digest now distinguishes throttled-batch ranchers vs. trust-drain ranchers.

### Cron `/api/cron/rancher-trust-promotion` (new — daily 14:00 UTC)

Auth: `CRON_SECRET` via `Authorization: Bearer` header or `?secret=` query param (mirrors `nightly-rancher-audit`).

For each operationally-Live rancher with `Trust Mode = false`, count their `Closed Won` referrals and check `Onboarding Phase Until`. If either:
- `closedWon >= 5`, OR
- `Onboarding Phase Until` is in the past

…flip `Trust Mode = true` and post a Telegram alert. Throttle drops away on the next `rancher-launch-warmup` tick; first-week gate also releases for that rancher.

Registered in `vercel.json` under `/api/cron/rancher-trust-promotion @ 0 14 * * *`.

---

## 3. First-week founder-approval gate (Sprint 2.3)

### Trigger flow (in `/api/warmup/engage`)

1. Buyer clicks YES on warmup email → token verified → `Warmup Engaged At` + `Ready to Buy` + `Warmup Stage = 'engaged'` flipped.
2. **NEW gate**, runs BEFORE `matching/suggest`:
   - `findInStateRancher(buyer.State)` → first operationally-Live rancher serving the buyer's state.
   - If found AND `Trust Mode = false`:
     - Count onboarding intros (Status ∈ {Intro Sent, Rancher Contacted, Negotiation, Closed Won, Closed Lost}) since rancher's `Approved At`.
     - If `< 5`: **stage** a `Pending Approval` referral (Approval Status = `pending-approval`) + post a Telegram approval card (`✅ Approve` / `⏸️ Hold 7d` / `⏭️ Skip` buttons), set `gateActive = true`, **skip** `matching/suggest`.
3. If gate active: redirect to `/matched?rancher=…&state=…&pending=true`. Buyer sees "I'm personally vetting your match before {rancher} reaches out — expect 24-48h."
4. If gate NOT active (Trust Mode on, or budget met, or no in-state rancher): existing immediate-route flow runs unchanged — flips `Buyer Stage = MATCHED`, fires `matching/suggest`, redirects to `/matched?rancher=…`.
5. On gate error: **fail open** — falls through to immediate route. Better to ship the buyer than strand them.

### Telegram callback handlers in `/api/webhooks/telegram` (`firstweek_*`)

| Action | Effect |
|---|---|
| `firstweek_approve_<refId>` | Buyer → `Buyer Stage = MATCHED`. Referral → `Approval Status = approved`. Fires `POST /api/matching/suggest` with `preferredRancherId` hint (matching/suggest is idempotent — it'll either upgrade the staged row to `Intro Sent` or create the canonical referral). Edits the Telegram card to confirm. |
| `firstweek_hold_<refId>` | Referral → `Approval Status = held`, `Approved At` stamped 7d future as a lightweight "re-surface pointer". Buyer stays at READY/WAITING. Edits card. |
| `firstweek_skip_<refId>` | Referral → `Approval Status = skipped`, `Status = Closed Lost`, `Closed At` stamped. Buyer reverts to `WAITING`. Edits card. (Future: try next-best rancher inline.) |

### `/matched` page (Sprint 2.3 minimal change)

Now reads `?pending=true` and renders an alternate variant — same handshake emoji, same address-line, but heading is "You're in." with the vetting copy + "why the pause?" explainer. Standard variant unchanged when `pending` is absent.

---

## 4. Verification commands (post-merge)

After this branch merges to main and Vercel redeploys:

```bash
# Confirm new fields are visible via API
curl -s -H "Authorization: Bearer $AIRTABLE_API_KEY" \
  "https://api.airtable.com/v0/meta/bases/appgLT4z009iwAfhs/tables" \
  | jq '.tables[] | select(.id=="tbl08y9Be45zNG0OG") | .fields[] | select(.name=="Trust Mode" or .name=="Onboarding Intro Pace" or .name=="Onboarding Phase Until" or .name=="Warmup Last Batch At")'

# Dry-run trust promotion cron (look for which ranchers would graduate)
curl -s "$SITE_URL/api/cron/rancher-trust-promotion?secret=$CRON_SECRET" | jq

# Trigger a single warmup cron run and inspect throttled vs trust-drain output
curl -s "$SITE_URL/api/cron/rancher-launch-warmup?secret=$CRON_SECRET" | jq

# After a real YES click on a new-rancher state: check Telegram for the
# approval card, then verify the staged referral exists with Approval Status=pending-approval
curl -s -H "Authorization: Bearer $AIRTABLE_API_KEY" \
  "https://api.airtable.com/v0/appgLT4z009iwAfhs/tblBfimb4Gt8C0fu4?filterByFormula={Approval%20Status}%3D%27pending-approval%27" | jq
```

### Smoke checklist before turning the throttle loose

- [ ] In Airtable, manually flip `Trust Mode = true` on at least one already-proven rancher (e.g. The High Lonesome) so they keep full pipe through the migration.
- [ ] For each operational rancher that's still in their first 30 days, set `Onboarding Phase Until` = `(activation date) + 30 days` (UTC ISO). For ranchers older than 30 days but with <5 closes, decide whether to set `Trust Mode = true` directly or let the trust-promotion cron's "phase expired" branch flip them on next tick.
- [ ] Confirm `vercel.json` redeploys the new cron (Vercel UI → Crons tab should show `rancher-trust-promotion @ 0 14 * * *`).
- [ ] Hit `/matched?rancher=Test&state=MT&pending=true` in a browser to confirm the pending variant renders.
- [ ] Hit `/matched?rancher=Test&state=MT` (no pending) to confirm the standard variant still renders.
- [ ] Telegram smoke: from a test buyer in a state with a non-Trust-Mode rancher, click YES on a warmup email — confirm the `🛂 FIRST-WEEK APPROVAL` card lands, then tap Approve and watch matching/suggest fire.

---

## 5. Voice rules followed

The only new user-facing copy is the `?pending=true` variant of `/matched/page.tsx`. Audit of voice rules from `STAGE-1-REBUILD-CHANGELOG.md` § 10:

- Lowercase opener: not applicable (page heading), but the body copy uses the founder voice ("I'm personally vetting…", "I'll personally respond.").
- Single primary CTA: only the dashboard link.
- Sign-off: `— Benjamin`.
- Footer: address line is inherited from page chrome (no email footer here).
- Forbidden phrases: none used. No emoji prefixes on body, no "10,000 families," no "The HERD" / "BHC Network" / "Private Network for American Ranch Beef."

Telegram-side copy is admin-facing so the voice rules don't strictly apply, but the cards stay terse and avoid jargon.

---

## 6. Files touched

### Created
- `app/api/cron/rancher-trust-promotion/route.ts` — new daily cron.
- `PROJECT-2-THROTTLE-COMPLETE.md` — this file.

### Modified
- `app/api/cron/rancher-launch-warmup/route.ts` — heavy refactor: Trust-Mode branch + throttled batched branch + Buyer Stage filter + cooldown stamp + priorityScore.
- `app/api/warmup/engage/route.ts` — first-week founder-approval gate inserted in front of `matching/suggest`.
- `app/api/webhooks/telegram/route.ts` — added `firstweek_approve | hold | skip` callback handlers.
- `app/matched/page.tsx` — added `?pending=true` variant.
- `vercel.json` — registered `/api/cron/rancher-trust-promotion @ 0 14 * * *`.

### Not touched (Stage 1 untouchables / sibling agent territory)
- `lib/email.ts` (no new email functions added)
- `app/api/cron/email-sequences/route.ts`
- `app/api/consumers/route.ts`
- `app/api/matching/suggest/route.ts`
- `app/api/rancher/referrals/[id]/route.ts`
- `app/api/referrals/[id]/route.ts`
- Anything under `app/r/*`, `app/map/*`, `app/founders/*`, `app/api/founders/*`, `app/api/prospects/*`

---

## 7. Verification

- ✅ `npx tsc --noEmit` clean
- ✅ `npm run build` clean (Turbopack, Next 16.1.4)
- ✅ All 4 Ranchers fields + 1 Referrals field created via Airtable MCP (IDs in §1)
- ✅ Cron registered in `vercel.json`
- ✅ Buyer Stage transition wired in throttle path (WAITING → READY post-warmup; MATCHED only on Approve callback)

---

## 8. Known follow-ups (not in scope for this sprint)

- `Onboarding Phase Until` is not yet auto-set on `app/api/rancher/activate/route.ts`. Next iteration: when activate flips `Onboarding Status = 'Live'`, also write `Onboarding Phase Until = nowISO() + 30d`.
- `Last Login At` field referenced by `priorityScore` is reserved — null-safe today, will start contributing once that field exists on Consumers.
- `firstweek_skip` currently reverts buyer to WAITING. A future iteration could try a next-best rancher inline before falling back to WAITING.
- Trust Mode promotion is one-way (false → true). If a trusted rancher goes dark, today the only recovery is manual unflag in Airtable. Future iteration could add a "demote to onboarding" path triggered by 30d of zero closes after going trusted.
