# Full-Site Audit + Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Debug + fix + improve every public-facing page and every API endpoint on BHC. Update copy across marketing surfaces, email templates, error messages, empty states. Produce a triaged issue inventory + execute fixes in priority tiers.

**Architecture:** Three-phase. Audit → Triage → Remediate. Audit dispatches parallel read-only subagents (one per category) that produce file:line issue tables with severity tags. Triage rolls findings into three tiers (critical, important, polish). Remediate ships each tier as its own PR so failures stay scoped.

**Tech Stack:** Next.js 16 App Router. 20 top-level page routes. 126 API endpoint routes. 19 cron jobs. Airtable + Stripe + Resend + Telegram + Vercel Blob.

**Scope baseline (2026-05-20):**
- 20 page directories in `app/`
- 126 `route.ts` files in `app/api/`
- ~30 admin pages in `app/admin/`
- 19 crons in `app/api/cron/`
- 9 webhooks in `app/api/webhooks/`
- Brand-voice copy lives across: marketing pages, email templates in `lib/email.ts`, Telegram message strings, form labels, error responses

---

## File Structure

**Files created (this plan):**
- `docs/AUDIT-INVENTORY.md` — living triage doc with every finding from Tier 0
- `docs/COPY-STYLE.md` — brand voice guide (extracted from existing docs/BHC.md)
- 3 separate PR branches as remediation tiers ship

**Files modified (across remediation tiers):**
- All 20 page files in `app/`
- All 126 endpoint files in `app/api/`
- `lib/email.ts` (every email template)
- `app/api/webhooks/telegram/route.ts` (every bot string)
- Anywhere a user-facing string lives

---

## Phase 0 — Setup

### Task 0.1: Create audit inventory doc

**Files:**
- Create: `docs/AUDIT-INVENTORY.md`

- [ ] **Step 1: Bootstrap the inventory doc**

```markdown
# BHC Audit Inventory

Generated 2026-05-20. Living triage doc. Each finding is `[severity] file:line — description → proposed fix`.

## Severity codes
- 🚨 CRITICAL — broken end-to-end, revenue-blocking, security hole, 500/404 on real user path
- 🟡 IMPORTANT — UX paper-cut, missing state, confusing label, accessibility gap, mobile issue
- ⚪ POLISH — copy improvement, brand voice drift, minor consistency

## Tier breakdown
- Tier 1 (critical): _populated by Audit Phase_
- Tier 2 (important): _populated by Audit Phase_
- Tier 3 (polish): _populated by Audit Phase_

## Findings
<populated by audit subagents>
```

- [ ] **Step 2: Commit**

```bash
git checkout -b fullsite-audit && git add docs/AUDIT-INVENTORY.md docs/superpowers/plans/2026-05-20-fullsite-audit-and-remediation.md && git commit -m "docs(plan): full-site audit + remediation v1"
```

### Task 0.2: Extract brand-voice guide

**Files:**
- Create: `docs/COPY-STYLE.md`

- [ ] **Step 1: Pull voice rules from existing docs**

Sources to scan: `docs/BHC.md`, `docs/VISION.md`, `docs/BUSINESS-MODEL.md`, `.claude/skills/bhc-marketing/SKILL.md`. Extract canonical phrases, tone rules, words to avoid, brand-voice litmus tests.

- [ ] **Step 2: Write the guide**

```markdown
# BHC Copy Style Guide

## Voice
- Direct, founder-talking-to-rancher. No corporate-speak.
- Concrete numbers over vague claims.
- Beef-buyer language, not marketing-speak.

## Always
- "Half cow" over "half a cow"
- "Rancher" over "farmer" (BHC ranchers raise beef cattle)
- "Buyer" over "customer" (we're matching, not selling)
- "Founding Herd" capitalized (program name)
- "Closed Won" (Airtable status, never paraphrase)

## Never
- "Revolutionary", "disruptive", "ecosystem", "leverage" (as verb)
- Em dashes (use hyphens or rewrite)
- Marketing-AI words: delve, robust, comprehensive, foster, multifaceted

## Error messages
- Pattern: <what happened> + <why> + <what to do>
- Bad: "An error occurred."
- Good: "Couldn't save your changes — Airtable rate-limited us. Try again in 30 seconds."

## Empty states
- Always show: <what would be here> + <how to make it appear>
- Bad: "No data."
- Good: "No closed deals yet. When a rancher reports a sale, it'll show up here within 5 minutes."
```

- [ ] **Step 3: Commit**

```bash
git add docs/COPY-STYLE.md && git commit -m "docs(copy): brand-voice style guide v1"
```

---

## Phase 1 — Audit (parallel read-only subagents)

Each subagent scans a category, produces a triaged finding table. All read-only. Results merge into `docs/AUDIT-INVENTORY.md`.

Dispatch all 6 in parallel via single message (per subagent-driven-development skill: "When you launch multiple agents for independent work, send them in a single message with multiple tool uses").

### Task 1.1: Audit public marketing pages

**Subagent prompt template:**
> Audit BHC public marketing pages for bugs, UX gaps, broken states, brand-voice drift, and copy quality. Read-only. Pages in scope: app/page.tsx, app/access/page.tsx, app/partner/page.tsx, app/founders/page.tsx, app/map/page.tsx, app/map/add-a-rancher/AddRancherForm.tsx, app/map/add-a-buyer/page.tsx, app/faq/page.tsx, app/land/page.tsx, app/brand-partners/page.tsx, app/matched/page.tsx, app/wins/page.tsx, app/unsubscribe/page.tsx.
>
> For each page, report:
> - Functional bugs (broken links, missing loading/empty/error states, undefined fields, 500-risk paths)
> - UX gaps (no mobile responsive, accessibility issues, confusing CTAs, hidden critical info)
> - Copy quality vs docs/COPY-STYLE.md (vague language, marketing-AI words, brand-voice drift)
> - Performance issues (large unoptimized images, unnecessary client-side data fetches)
>
> Output format: markdown table with columns `Severity | File:Line | Issue | Proposed Fix`. Severity 🚨/🟡/⚪.

### Task 1.2: Audit auth + signup flows

**Subagent prompt template:**
> Audit BHC auth + signup paths. Read-only. Files in scope: app/api/consumers/route.ts, app/api/partners/route.ts, app/api/auth/rancher/login/route.ts, app/api/auth/rancher/verify/route.ts, app/api/auth/affiliate/login/route.ts, app/api/auth/affiliate/verify/route.ts, app/member/login/page.tsx, app/member/verify/page.tsx, app/rancher/login/page.tsx, app/rancher/verify/page.tsx, app/affiliate/login/page.tsx, app/ranchers/[slug]/claim/page.tsx.
>
> Look for: missing input validation, weak email regex, no rate limiting, JWT misuse, secret leakage in client, session-cookie security flags (HttpOnly, Secure, SameSite), CSRF protection, replay-attack vulnerability on magic links, error messages that leak system info, missing dedupe protection on signup.
>
> Output format: same table as Task 1.1.

### Task 1.3: Audit rancher dashboard + endpoints

**Subagent prompt template:**
> Audit BHC rancher dashboard + every /api/rancher/* endpoint. Read-only. Files in scope: app/rancher/page.tsx, app/rancher/setup/page.tsx, app/rancher/sign-agreement/page.tsx, all files under app/api/rancher/, all files under app/api/ranchers/.
>
> Look for: missing ownership checks, race conditions on capacity counters, fields written without validation, off-by-one on referral filtering, empty-state copy on dashboard panels, missing loading/error states, accessibility gaps, mobile responsive issues, error responses that don't help the rancher resolve the issue.
>
> Special focus: close-sale flow (Sale Amount gates, Commission Rate locked, Stripe invoice path), capacity flow (At Capacity ↔ Active transitions, Current Active Referrals integrity), payment confirmation flow (Awaiting Payment → Closed Won), image upload paths (Blob token, 503 fallback).
>
> Output format: same table as Task 1.1.

### Task 1.4: Audit buyer dashboard + matching

**Subagent prompt template:**
> Audit BHC buyer dashboard + matching flow. Read-only. Files in scope: app/member/page.tsx, app/api/member/**, app/api/matching/suggest/route.ts, app/api/warmup/engage/route.ts, app/api/consumers/route.ts.
>
> Look for: bugs in matching engine (state normalization, capacity hard ceiling, tier specialty filter, multi-state gate), buyer dashboard rendering (loading/empty/error), warmup engage JWT validation, hot-lead bypass logic.
>
> Output format: same table as Task 1.1.

### Task 1.5: Audit admin surfaces + crons

**Subagent prompt template:**
> Audit BHC admin pages + cron endpoints. Read-only. Files in scope: everything under app/admin/, everything under app/api/admin/, everything under app/api/cron/.
>
> Look for: admin auth gates (cookie/password/internal-secret consistency), cron idempotency (re-run safety), maintenance-mode honoring, withCronRun wrapper present on every cron, dangerous bulk operations without confirmation step, admin pages that 500 on missing data, missing pagination on large lists.
>
> Output format: same table as Task 1.1.

### Task 1.6: Audit webhooks + email templates

**Subagent prompt template:**
> Audit BHC webhooks + every email template. Read-only. Files in scope: everything under app/api/webhooks/, lib/email.ts in full.
>
> Webhooks: signature verification present, replay-attack window, idempotency keys, error envelopes, retry behavior, dead-letter handling, request-body size limits.
>
> Email templates: every sendX function in lib/email.ts. Check brand voice vs docs/COPY-STYLE.md, broken HTML, missing alt text, missing unsubscribe footer, vendor-specific Resend headers correctly set, sender domain consistency.
>
> Output format: same table as Task 1.1.

### Task 1.7: Merge findings

- [ ] **Step 1: Roll all 6 subagent outputs into `docs/AUDIT-INVENTORY.md`**

Each subagent's table appended under a section header. Then re-sort the WHOLE list by severity at top of file.

- [ ] **Step 2: Tag each finding with a tier label**

- 🚨 critical → Tier 1
- 🟡 important → Tier 2
- ⚪ polish → Tier 3

- [ ] **Step 3: Commit**

```bash
git add docs/AUDIT-INVENTORY.md && git commit -m "docs(audit): full-site issue inventory

6 parallel subagents scanned every page + every endpoint + every email
template + every cron + every webhook. N findings: X critical, Y
important, Z polish."
```

---

## Phase 2 — Triage gate (user decision)

After Phase 1 the user reads `docs/AUDIT-INVENTORY.md` and decides:

| Decision | Path |
|---|---|
| Approve all 3 tiers, ship sequentially | Phase 3, 4, 5 in order |
| Tier 1 only (critical fixes only) | Phase 3, defer rest to TODOS |
| Custom subset | User cherry-picks findings → Phase 3 with just those |

**No fixes ship before this gate.** Phase 1 is read-only; Phase 3+ is mutation. User decides scope before we touch code.

---

## Phase 3 — Tier 1 remediation (critical fixes)

Branch: `fullsite-tier1-critical`. Each critical finding gets its own commit. PR opens when all critical findings closed OR after 24h, whichever first.

### Task 3.1: For each critical finding in `docs/AUDIT-INVENTORY.md`

- [ ] **Step 1: Pull finding details**

Read the entry. Confirm severity. Confirm reproducible (or run smoke test).

- [ ] **Step 2: Write failing smoke test (if applicable)**

For bugs with clear inputs/outputs: smoke test via curl OR direct function call. For UX bugs: screenshot or manual repro steps.

- [ ] **Step 3: Apply fix**

Smallest possible change that fixes the root cause. No "while I'm here" refactors (per systematic-debugging skill).

- [ ] **Step 4: Verify**

Smoke test passes OR manual repro no longer shows the bug.

- [ ] **Step 5: Commit**

```bash
git add <files>
git commit -m "fix(<area>): <one-line>

Reference: docs/AUDIT-INVENTORY.md finding #N
Root cause: <one line>
Fix: <one line>
Verified: <how>"
```

- [ ] **Step 6: Move finding to "Closed" section in inventory**

### Task 3.2: Open Tier 1 PR

When all critical findings closed (or 24h max):

```bash
git push -u origin fullsite-tier1-critical
gh pr create --title "fullsite tier 1: critical fixes" --body "..."
```

PR body lists every finding fixed + verification evidence per finding.

---

## Phase 4 — Tier 2 remediation (important UX + copy gaps)

Branch: `fullsite-tier2-important`. Same per-finding loop as Phase 3.

Tier 2 includes:
- Missing loading/empty/error states across dashboards
- Confusing CTAs or button copy
- Mobile-responsive issues on `/founders`, `/map`, `/ranchers/[slug]`
- Accessibility gaps (keyboard nav, focus rings, contrast, touch targets)
- Form validation messages that don't help the user
- Email templates with broken alt text or missing unsubscribe links

PR opens when all important findings closed.

---

## Phase 5 — Tier 3 remediation (copy polish)

Branch: `fullsite-tier3-copy`. Per-finding loop again.

Tier 3 includes:
- Brand-voice drift (marketing-AI words, em dashes, weak verbs)
- Inconsistent terminology (rancher vs farmer, half cow vs half a cow)
- Email subject lines that don't open well
- Empty-state copy that doesn't explain how to fill it
- Error messages that say "An error occurred" instead of the canonical pattern from `docs/COPY-STYLE.md`

This tier touches the most files but each touch is small. Bundle into 1 PR.

---

## Phase 6 — Verification

- [ ] **Step 1: After all 3 PRs merge, run end-to-end smoke**

```bash
SEC=$(grep -E "^CRON_SECRET=" .env.local | cut -d= -f2- | tr -d '"')
# Hit every public page
for path in / /access /partner /founders /map /faq /wins; do
  printf "%s %s\n" "$(curl -s -o /dev/null -w "%{http_code}" "https://www.buyhalfcow.com$path")" "$path"
done

# Hit a sample of crons via manual trigger
curl -s -H "Authorization: Bearer $SEC" "https://www.buyhalfcow.com/api/cron/healthcheck" | jq .

# Invoke bhc-audit skill for system-wide read
```

- [ ] **Step 2: Update `docs/AUDIT-INVENTORY.md` with "Verified" stamps**

- [ ] **Step 3: Commit verification + close out**

```bash
git checkout main
git add docs/AUDIT-INVENTORY.md
git commit -m "docs(audit): full-site remediation complete

Tier 1: N critical fixes shipped via PR #X
Tier 2: M important fixes shipped via PR #Y
Tier 3: K copy fixes shipped via PR #Z

Verified end-to-end: every public page returns 200, crons fire, no
500s in Vercel logs last 24h, brand-voice consistent per
docs/COPY-STYLE.md."
```

---

## Verification (manual, end of all phases)

- [ ] `docs/AUDIT-INVENTORY.md` exists with every finding tagged with tier + status
- [ ] `docs/COPY-STYLE.md` exists and is referenced by 3+ commits
- [ ] All 3 tier PRs merged
- [ ] `npm run build` green
- [ ] No new TypeScript errors
- [ ] Vercel deploy succeeds + every cron in `/cronstatus` Telegram shows ✅ within 24h post-merge
- [ ] Manual click-through of buyer signup → match → close flow works end-to-end
- [ ] Manual click-through of rancher self-submit → sign-agreement → setup-page → go-live works end-to-end

---

## Rollback

Each tier is its own PR. Revert PR if it breaks production. Phase 1 (audit) is read-only — no revert needed.

If a specific finding fix breaks something unforeseen, that commit is its own revert target — granular rollback supported.

---

## Constraints + non-goals

**In scope:**
- Every page in `app/` (20 directories)
- Every endpoint in `app/api/` (126 files)
- Every email template in `lib/email.ts`
- Every Telegram string in `app/api/webhooks/telegram/route.ts`
- Brand voice across all customer-facing copy

**Out of scope (defer to separate plans):**
- Database schema changes (use Airtable MCP via separate plans)
- New features
- Visual redesign / new component library
- Stripe Connect / payouts (Phase 1 of VISION.md)
- New crons / new state machines
- Marketing campaign content (use `.claude/skills/bhc-marketing/` instead)

**Time bound:** Phase 1 (audit) target = 1 hour wall time (6 parallel subagents). Phase 3-5 (remediation) target = 1 working day per tier.
