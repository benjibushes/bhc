---
name: bhc-audit
description: Comprehensive end-to-end audit of BuyHalfCow platform health. Probes every endpoint, pulls Vercel runtime logs, audits Airtable data integrity, traces synthetic signup, verifies admin surfaces. Returns prioritized triage with file:line for every issue. Use whenever the user asks "audit X", "is the system working", "check production", "what's broken", "/bhc-audit", "systematic debug", or after shipping multiple PRs and needing verification. Read-only by default; flags fixes for separate action.
---

# BHC Audit

Run this when you need to PROVE the BHC platform is working end-to-end.
Output: a single triage table with severity + file:line for every issue.
Read-only by default — don't ship fixes from inside this skill.

## When to invoke

- "audit X" / "is production working"
- After shipping 2+ PRs in a session ("verify what we just shipped")
- User reports "feels broken" without a specific failure
- Before walking away for a few hours
- After a maintenance window flip
- "/bhc-audit"

## Procedure

### Phase 1 — Parallel evidence gathering (4 agents)

Dispatch ALL FOUR `general-purpose` agents in a SINGLE message so they
run concurrently. Each agent reads-only + returns concise evidence.

**Agent A — Endpoint + Vercel log probe**

Probe every public + admin + cron endpoint. Capture status code per
endpoint. Pull Vercel runtime logs for `level=["error","fatal"]` and
`statusCode=500` over last 6h. Filter out `[DEP0169]` punycode noise.
Report deviations only.

Vercel MCP call shape:
- tool: `mcp__b2a1a8ed-5009-469d-a793-c345a239ed4b__get_runtime_logs`
- projectId: `prj_UiTlxTHcMl277z0QyrAVz82nclVA`
- teamId: `team_LtooF0XS8M8oDBUwxphrC1RJ`
- environment: `production`

**Agent B — Airtable data integrity + Cron Runs + warmup activity**

Pull Ranchers + Referrals + Consumers + Cron Runs. Report:
- Total counts per table
- Orphan Pending Approval (Pending Approval + no Rancher + no Suggested) — should be 0
- Counter drift (Live ranchers: stored Current Active Referrals vs actual)
- Approved consumers with empty Buyer Stage
- Maintenance captures still parked
- Stale warmups (Warmup Sent At >7d, no Warmup Engaged At)
- Stuck signed-not-live ranchers (Agreement Signed=true, Page Live=false)
- Cron Runs latest per name + error count last 24h
- Today's warmup activity by state
- Specific ranchers worth watching (Frank Fitzpatrick, Hewitson, Ace, Matt Hirschi)

**Agent C — Synthetic E2E flow probe**

Fire a single `probe-audit-<timestamp>@test.local` consumer through
`/api/consumers`. Verify the record appears in Airtable with correct
Buyer Stage. Probe `/api/warmup/engage` (expect 400/401 on invalid).
Probe `/api/webhooks/telegram` + `/api/webhooks/resend-inbound` with
spoofed payload (Resend should reject 401 IF webhook secret is set —
report whether spoof succeeds = security gap). Auth into `/admin/health`
+ pull snapshot. Cleanup the probe consumer + any conversation row
created.

**Agent D — Rancher dashboard surface read**

Also read (2026-07-06 additions — the marketplace + operator rails):
- `app/api/rancher/products/route.ts` (self-serve products: auth order,
  ownership, Connect gate, deposit-style fence, stock-only PATCH path)
- `app/api/rancher/orders/route.ts` (orders loop: ownership, mark-shipped
  claimOnce guard, tracking email)
- `app/api/admin/sell-links` + `sell-options` (operator console: mint gate
  must equal redemption floor MIN_TIER_PRICE)
- `lib/marketplaceProducts.ts` (isSellableRow + hasStock invariants)
- `lib/productSettlement.ts` (deposit-style truth in emails, inventory
  decrement + refund restore symmetry)

Read all of `app/rancher/page.tsx` + `app/api/rancher/*/route.ts` for
known failure modes:
- Close-sale flow (saleAmount validation, commission helper used,
  Stripe failure handling)
- Earnings tab math
- Image upload Vercel Blob path (503 if BLOB_READ_WRITE_TOKEN unset)
- Team Emails picker
- Pass action + Mark Lost reason codes
- Capacity edit edge cases (lower max below current)
- Public landing page robustness on missing fields

### Phase 2 — Synthesize

Build single triage table:

| Finding | Severity | File:line | Root cause | Action |
|---|---|---|---|---|

Severity codes:
- 🚨 critical — money-losing or security
- 🟡 important — UX or correctness bug
- ⚪ noise — expected behavior or wait-for-time (e.g. cron hasn't fired yet)

### Phase 3 — Hand off to fix workflow

DO NOT ship fixes from inside this skill. Per Phase 1 of
`superpowers:systematic-debugging`: NO FIXES WITHOUT ROOT CAUSE
INVESTIGATION FIRST. The audit IS Phase 1. Fixes go through their own
PR flow.

After reporting, ask the user which findings to prioritize. They pick
the top N → run `superpowers:writing-plans` OR execute inline.

## Quick probes (without full audit)

When user asks a small-scope question, skip the full audit:

- "Is X cron firing?" → Query Cron Runs table filtered by Name
- "Did Y rancher get their warmup?" → Pull rancher + check Warmup Last Batch At + Launch Warmup Triggered
- "Why didn't Z buyer route?" → Pull buyer + check Warmup Engaged At + Ready to Buy + Buyer Health
- "Is endpoint /foo broken?" → `curl -s -o /dev/null -w "%{http_code}" https://www.buyhalfcow.com/foo`
- "Is the marketplace healthy?" → curl /shop (200 + category anchors), a PDP
  (200 + Product JSON-LD; ground box recLQdfYMnP1NxRgL should show
  AggregateOffer 95–355), /api/rancher/products unauth (expect 401)

## Known recurring failure patterns

Document these — they appear over and over and waste audit time:

1. **`getAllRecords()` flatten drops Airtable metadata** — `record.createdTime` is metadata, NOT a field. Use `record._rawJson?.createdTime` OR the exposed `_createdTime` on flattened rows.

2. **JWT_SECRET local/prod mismatch** — local scripts that mint tokens for prod produce 401s. ALWAYS use server-side `/api/admin/.../resend-*` endpoints. Never mint JWTs in scripts.

3. **Airtable field name typo (`Max Active Referalls`)** — single L. `lib/rancherCapacity.ts::getMaxActiveReferrals` reads both spellings defensively. NEVER write code that reads `Max Active Referrals` (two L's) without falling back.

4. **Trust Mode flag one-shot** — `Launch Warmup Triggered` blocks future iterations. Fixed PR #27 — flag-gate removed. Don't reintroduce.

5. **Multi-state gate** — Routing States populated doesn't mean routing happens. Requires `Admin Approved Multi-State=true` boolean (default false = home state only).

6. **Counter drift batch-approve self-heals** — if stored ≠ actual on a Live rancher, batch-approve fixes within 2h. Wait before manually patching.

7. **Same skip count daily on waitlist retry** — by design. `isQualifiedForRouting` requires explicit YES click. Unengaged buyers correctly skip forever (until they click or re-warm cohort fires).

8. **Env vars failing silent** — `BLOB_READ_WRITE_TOKEN`, `RESEND_INBOUND_WEBHOOK_SECRET`, `ADMIN_EMAIL_FOR_FORWARD`, `CRON_SECRET`, `INTERNAL_API_SECRET`, `STRIPE_SECRET_KEY` all gate features but fail open. Always check Vercel env before assuming code bug.

## Output template

```
## Phase 1 — Evidence

### Endpoint health
<table from Agent A>

### Data integrity
<table from Agent B>

### E2E flow
<from Agent C>

### Rancher dashboard read
<from Agent D>

## Phase 2 — Triage

| # | Finding | Severity | File:line | Action |
|---|---------|----------|-----------|--------|

## Phase 3 — Next steps

Top N findings to fix this session: [...]

User picks 1+. Hand off to writing-plans OR execute inline.
```
