# Stage-3 Merge Playbook

Procedure for merging `stage-3-verticals` → `main` and activating tier_v2 in production.

**Current state:** branch `stage-3-verticals` is feature-complete (12/12 Phase 1 tasks + 5 audit fixes + 4 build blockers + BHC Promise floor). Final review passed with operator caveats below.

## Phase 0 — Pre-merge operator steps

These MUST happen before merging or activating tier_v2. None require code changes — all are Vercel + Stripe Dashboard configuration.

### 0.1 Stripe Connect webhook endpoint (BLOCKING)

The Stage-3 Connect webhook at `/api/webhooks/stripe-connect` exists but won't function until registered in the Stripe Dashboard.

1. Stripe Dashboard → Developers → Webhooks → **Add endpoint**
2. URL: `https://buyhalfcow.com/api/webhooks/stripe-connect`
3. **Listen to: events on Connected accounts** (NOT "events on your account")
4. Subscribe to these event types:
   - `v2.core.account[requirements].updated`
   - `v2.core.account[configuration.merchant].capability_status_updated`
   - `v2.core.account.updated` (belt-and-suspenders catch-all)
5. Save → copy the signing secret
6. Vercel → Project Settings → Environment Variables → add `STRIPE_CONNECT_WEBHOOK_SECRET=whsec_...` (Production scope only)
7. Redeploy main so the new env var is picked up

**Failure mode if skipped:** Ranchers finish Stripe Express onboarding but the dashboard banner cascade stays on "Connect bank →" forever — because nothing writes back to the `Stripe Connect Status` field on Airtable. The startup warning at `app/api/webhooks/stripe-connect/route.ts:38` will log on every cold-start to surface this.

### 0.2 Confirm `STRIPE_CONNECT_ENABLED=false` on Vercel prod

This flag gates tier_v2 exposure even AFTER the code lands. Keep it false through merge + soak. Flip to true only after the controlled-launch step below.

### 0.3 Confirm Stripe products are LIVE (not test mode)

Phase 1 Task 0 created 6 LIVE price IDs:
- `price_1Tb3IWGTWWNqassHaIvpNXeC` — Pasture $150/mo
- `price_1Tb3IyGTWWNqassHynt7qAJn` — Ranch $350/mo
- `price_1Tb3JLGTWWNqassH0UPyua3j` — Operator $500/mo
- `price_1Tb3JhGTWWNqassHXZ8nSuW5` — Video Shoot $2,500
- `price_1Tb3K4GTWWNqassHvTC4w9KE` — Photo Refresh $1,500
- `price_1Tb3KPGTWWNqassHdBaWY8Z8` — Founder Letter $750

Verify these still exist in the Stripe Dashboard before merge. Real charges fire when flag flips.

## Phase 1 — Merge `stage-3-verticals` → `main`

```bash
git checkout main
git pull origin main
git merge --no-ff stage-3-verticals
git push origin main
```

Vercel auto-deploys main. The new code lands but `STRIPE_CONNECT_ENABLED=false` keeps tier_v2 dark.

### What's immediately visible (flag still false)

- `/partner` page still resolves but tier_v2 select endpoint returns 503
- Setup wizard step 7 ("Pick Your Plan") UI is reachable; the tier cards link to /partner/checkout/[tier] which 503s
- `/admin/payments` console live (no data yet)
- `/rancher/billing` live (only legacy info for existing 17 ranchers)
- `/rancher` dashboard banner cascade dark for all ranchers (none are tier_v2 yet)
- Legacy commission-invoice flow unchanged

### What's NOT visible

- Buyer deposit page (`/checkout/[refId]/deposit`) returns 503 from POST
- `/api/rancher/connect/start` returns 503
- No legacy rancher is auto-flipped to tier_v2

## Phase 2 — Soak (48 hours)

Watch for:
- Vercel logs: any 5xx from existing endpoints (legacy flow regressions)
- Cron Runs Airtable table: existing crons (batch-approve, email-sequences, commission-invoices) still showing `success` Status
- Telegram morning digest still landing normally

If anything looks off, revert the merge:
```bash
git revert -m 1 <merge-sha>
git push origin main
```

## Phase 3 — Controlled launch (flag flip)

After 48h clean soak:

1. Pick 2 trusted pilot ranchers (Sackett + High Lonesome recommended per VISION.md)
2. Vercel → Environment Variables → set `STRIPE_CONNECT_ENABLED=true` (Production)
3. Redeploy
4. Walk each pilot rancher manually through:
   - `/partner` → pick tier → /partner/checkout/[tier] → real charge → success page
   - `/rancher/billing` → see subscription active + Connect status `not_connected`
   - Click "Connect bank →" banner → Stripe Express onboarding
   - After Express complete: Connect status flips to `active` (verifies webhook B3 works)
   - Manually flip their Pricing Model legacy → tier_v2 via /api/rancher/legacy-upgrade (or admin Airtable)
5. Synthetic buyer flow:
   - Magic-link buyer email → /checkout/[refId]/deposit → real charge → success page
   - Verify Payments row written, Referral flipped Closed Won, Telegram celebration fired
   - Rancher hits "Mark beef delivered →" → buyer gets confirmation email

## Phase 4 — Open to existing legacy ranchers

After 2 pilot ranchers prove the flow:

- /rancher dashboard already surfaces the LegacyUpgradeBanner (Task 11.5) for legacy ranchers
- Send a "tier_v2 is live, here's the upgrade pitch" email to the 17 existing ranchers
- Track upgrades via Telegram alerts (`🆙 LEGACY → tier_v2` fires on every flip)

## Phase 5 — Open to new rancher signups

The `/partner` page is the public entry. Once Phase 4 has 3-5 active tier_v2 ranchers + clean dispute history, point cold-acquisition Meta ads at the buyer flow:

- Ad → `/access` (existing buyer signup)
- Auto-match if state has tier_v2 rancher → intro email with magic-link deposit CTA (B1+B2)
- Buyer pays → tier_v2 flow runs end-to-end

## Rollback paths

| Stage | Rollback action | Data impact |
|---|---|---|
| Phase 1 (merge, flag off) | `git revert -m 1 <merge-sha>` | None — flag was off, no data wrote |
| Phase 2 (soak) | Same revert | None |
| Phase 3 (flag flip, no real charges yet) | Vercel env: `STRIPE_CONNECT_ENABLED=false` | Pilot rancher subscriptions stay active in Stripe; can cancel via Stripe portal |
| Phase 3 (after first real deposit) | Flag off blocks NEW deposits; existing settled charges stay settled | Payouts + commissions already flowed; no unwind possible |
| Phase 4 (legacy opt-ins live) | Flag off blocks NEW opt-ins; flipped ranchers stay tier_v2 | Need manual Airtable revert per rancher to restore legacy commission flow |
| Phase 5 (ads driving traffic) | Pause ads + flag off | Same as Phase 4 |

## Open follow-ups (after merge, not blocking)

From the final code review:
- Refund console claim-type enum: surface `bhc-promise-cold-chain` / `bhc-promise-claim` as a dropdown in `/admin/payments` refund flow so reserve burn metric is queryable (currently free-form reason field).
- B3 webhook short-circuit on no-op writes: small optimization — check status equality BEFORE the live Stripe API call.
- jwt.verify failure category logging: distinguish expired vs tampered vs malformed for forensics.
- Rate limit on `/api/auth/member/verify` GET to prevent consumer-id brute force probing.

## Critical IDs reference

- Vercel project: `prj_UiTlxTHcMl277z0QyrAVz82nclVA`
- Vercel team: `team_LtooF0XS8M8oDBUwxphrC1RJ`
- Branch alias (preview): `bhc-git-stage-3-verticals-benibeauchman-3168s-projects.vercel.app`
- Airtable base: `appgLT4z009iwAfhs`
- Stripe platform account: `acct_1TSn5PGTWWNqassH`

## Locked constraints

- NEVER push to main without explicit user consent
- NEVER commit to main directly — only merge from `stage-3-verticals`
- LIVE Stripe mode — real charges from the moment flag flips
- 17 verified ranchers continue legacy commission flow until they opt-in to tier_v2
