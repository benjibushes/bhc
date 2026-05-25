# Debug Playbook — BuyHalfCow systematic E2E audit

8-phase repeatable debug sweep. Runs in ~10 min. Each phase has:
- **Check** — what to verify
- **Command** — copy-paste verification (uses `/usr/bin/curl` to bypass shell aliases)
- **Pass** — what success looks like
- **Severity** — `block` (don't ship), `warn` (fix soon), `info` (note only)

Invoke when user says "debug", "audit", "bulletproof", "round N", or before
shipping a public-facing change.

Track progress via TaskCreate × 8 (one task per phase). Ship findings as
commits, one per root cause.

---

## Phase 1 — Surface health

**Check:** every public URL returns 200, TTFB < 1s, title not duplicate-tagged.

```bash
for url in / /start /access /founders /brand-partners /matched /map /wins /about /privacy /terms /unsubscribe; do
  /usr/bin/curl -s -o /dev/null -w "%{http_code} %{time_total}s  $url\n" "https://www.buyhalfcow.com$url"
done
for url in / /start /access /founders /brand-partners /map /wins /about; do
  TITLE=$(/usr/bin/curl -s "https://www.buyhalfcow.com$url" | grep -oE '<title>[^<]+</title>' | head -1)
  echo "$url:  $TITLE"
done
```

**Pass:**
- All URLs 200 in < 1s
- Titles end with single ` — BuyHalfCow` suffix (no doubles)
- No "Lorem", "TBD", "TODO", placeholder leaks in HTML

**Severity:** block

---

## Phase 2 — API contracts

**Check:** all critical endpoints return expected shape + auth gates work.

```bash
# Public APIs
/usr/bin/curl -s https://www.buyhalfcow.com/api/stats/public | python3 -m json.tool | head -20
/usr/bin/curl -s -o /dev/null -w "%{http_code}\n" https://www.buyhalfcow.com/api/public/ranchers
/usr/bin/curl -s -o /dev/null -w "%{http_code}\n" https://www.buyhalfcow.com/api/testimonials

# Stripe brand redirects — all 3 tiers + bogus
for tier in spotlight featured founding bogus; do
  /usr/bin/curl -sI "https://www.buyhalfcow.com/api/checkout/brand?tier=$tier" | grep -iE "^location|^http"
done

# Admin lockdown
/usr/bin/curl -s -o /dev/null -w "%{http_code}\n" https://www.buyhalfcow.com/api/admin/ranchers
/usr/bin/curl -s -o /dev/null -w "%{http_code}\n" https://www.buyhalfcow.com/api/admin/consumers

# Cron auth
/usr/bin/curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer fake" https://www.buyhalfcow.com/api/cron/email-sequences
/usr/bin/curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer fake" https://www.buyhalfcow.com/api/cron/batch-approve
```

**Pass:**
- `/api/stats/public` returns keys `{ranchersActive, familiesMatched, foundersBacked, foundersCap, totalClosedWon, thisMonthClosedWon, latestClose, activity24h}`
- 3 tiers → `buy.stripe.com/*`; bogus → `/brand-partners#contact`
- All admin/cron endpoints → 401 with fake/no auth

**Severity:** block

---

## Phase 3 — Webhooks

**Check:** all webhook endpoints reject unauthenticated requests + idempotency in code.

```bash
# Stripe — unsigned + bad-sig POST
/usr/bin/curl -sI -X POST https://www.buyhalfcow.com/api/webhooks/stripe -H "Content-Type: application/json" -d '{}' | head -1
/usr/bin/curl -sI -X POST https://www.buyhalfcow.com/api/webhooks/stripe -H "stripe-signature: t=1,v1=fake" -d '{}' | head -1

# Resend Inbound — unauth
/usr/bin/curl -sI -X POST https://www.buyhalfcow.com/api/webhooks/resend-inbound -d '{}' | head -1

# Telegram — no signature
/usr/bin/curl -sI -X POST https://www.buyhalfcow.com/api/webhooks/telegram -d '{}' | head -1

# Code-level: Stripe Session ID idempotency
grep -n "Stripe Session ID\|idempotent\|already processed" app/api/webhooks/stripe/route.ts | head -5
```

**Pass:**
- Stripe → 400 (missing/bad sig)
- Resend Inbound → 401
- Telegram → 403
- Stripe webhook code shows `getAllRecords(CONSUMERS, '{Stripe Session ID} = "..."')` short-circuit before write

**Severity:** block

---

## Phase 4 — Data + cron pipeline health

**Check:** Cron Runs success rate + Cron Pauses empty + Email Sends growing.

Use Airtable MCP:
- List `Cron Runs` (tblXAPajkt1AVHBlO) sort by Started At desc, last 25 — all should be `status=success`
- List `Cron Pauses` (tbljVUZzZTWQjETNb) — should be empty (or only intentional ops pauses)
- List `Email Sends` (tblVUoMaYvi6NXtiH) sort by Sent At desc — should grow daily post-cron runs

**Pass:**
- 25/25 recent crons success
- 0 unexpected pauses
- Email Sends row count > prior day's count after each cron run

**Severity:** block (critical fail = silent data loss)

---

## Phase 5 — Email pipeline

**Check:** every send helper uses guardedSend + no direct Resend bypass + XSS escaped.

```bash
# Wrap coverage — should match
grep -c "^export async function send" lib/email.ts
grep -c "guardedSend(" lib/email.ts

# Bypass paths — should be empty (outside lib/email.ts)
grep -rn "\.emails\.send(" app/ --include="*.ts" | grep -v worktrees | grep -v ".next"

# XSS in HTML email bodies — should all use esc()
grep -nE "<[a-z][^>]*>[^<]*\\\$\{(firstName|first|data\.firstName|data\.name)\}[^<]*<" lib/email.ts | grep -v "esc("

# DNS deliverability
/usr/bin/dig +short TXT buyhalfcow.com | grep -i spf
/usr/bin/dig +short TXT resend._domainkey.buyhalfcow.com | head -1
/usr/bin/dig +short TXT _dmarc.buyhalfcow.com | head -1
```

**Pass:**
- send-helpers count == guardedSend count
- 0 direct Resend usage outside lib/email.ts
- 0 unescaped `${firstName}` in HTML body context
- SPF + DKIM + DMARC all return values

**Severity:** block (deliverability fails = paid ads waste)

---

## Phase 6 — Security posture

**Check:** cookies secure, headers set, no PII leak, no source maps in prod.

```bash
# Security headers
/usr/bin/curl -sI https://www.buyhalfcow.com/ | grep -iE "strict-transport|x-frame|x-content-type|referrer-policy"

# Source maps NOT exposed
URL=$(/usr/bin/curl -s https://www.buyhalfcow.com/start | grep -oE '/_next/static/chunks/[^"]*\.js' | head -1)
/usr/bin/curl -s -o /dev/null -w "%{http_code} (expect 404)\n" "https://www.buyhalfcow.com${URL}.map"

# PII on public endpoints
/usr/bin/curl -s https://www.buyhalfcow.com/api/public/ranchers | python3 -c "
import json, sys
for r in json.load(sys.stdin).get('ranchers',[])[:3]:
    leaky = [k for k in r if k in ['email','phone','operator_email','team_emails','stripe_customer_id']]
    print(f'{r.get(\"ranch_name\",\"?\")}: leaky={leaky}')"

# Cookie security flags — every set should have httpOnly/secure/sameSite
grep -rnE "cookies(\(\))?\.set\(" app/api/ --include="*.ts" | grep -v worktrees
```

**Pass:**
- HSTS + X-Frame DENY + nosniff + referrer-policy all present
- .map URLs → 404
- 0 leaky fields on public/ranchers
- All cookie .set() calls include httpOnly + secure + sameSite

**Severity:** block

---

## Phase 7 — SEO surfaces

**Check:** sitemap completeness + canonical host + per-page OG/Twitter cards.

```bash
# Sitemap URL count + canonical host
/usr/bin/curl -s https://www.buyhalfcow.com/sitemap.xml | grep -c "<loc>"
/usr/bin/curl -s https://www.buyhalfcow.com/sitemap.xml | grep -oE "<loc>https?://[^/]+" | sort -u

# Required URLs present
/usr/bin/curl -s https://www.buyhalfcow.com/sitemap.xml | grep -oE "<loc>[^<]*</loc>" | grep -E "/start|/access|/founders|/brand-partners|/wins|/map"

# Robots disallows
/usr/bin/curl -s https://www.buyhalfcow.com/robots.txt | grep -E "Disallow"

# Per-page OG + Twitter on high-rev pages
for p in /start /founders /brand-partners /access; do
  echo "=== $p ==="
  /usr/bin/curl -s "https://www.buyhalfcow.com$p" | grep -oE '<meta (property|name)="(og:title|twitter:title)" content="[^"]+"' | head -2
done
```

**Pass:**
- Sitemap ≥ 30 URLs, all use `https://www.buyhalfcow.com` (canonical)
- `/start /access /founders /brand-partners /wins /map` all present
- Robots disallows: `/admin /api /update-profile /unsubscribe /member /rancher /matched`
- /start /founders /brand-partners each have page-specific og:title + twitter:title (not root default)

**Severity:** warn (won't break, will leak revenue)

---

## Phase 8 — Race conditions

**Check:** atomic counters, idempotency keys, concurrent dup guards.

```bash
# Founder #N — should use Redis INCR via lib/founderNumber.ts
grep -n "assignFounderNumber\|founderNumber" app/api/webhooks/stripe/route.ts | head -3

# Affiliate code lookup — case-insensitive
grep -n "LOWER({Code})" lib/affiliates.ts | head -3

# /api/consumers dup-email — 409 path
grep -n "already registered\|409" app/api/consumers/route.ts | head -3

# matching/suggest capacity bump — re-read before write
grep -n "Current Active Referrals" app/api/matching/suggest/route.ts | head -5
```

**Pass:**
- `assignFounderNumber` imported in stripe webhook (atomic Redis INCR)
- `LOWER({Code})` used in `findAffiliateByCode`
- `/api/consumers` returns 409 on duplicate email
- matching/suggest re-reads `Current Active Referrals` before bumping

**Severity:** warn (rare under low volume, real under viral burst)

---

## After each phase

If finding: dispatch fix → commit (`fix(<area>): ...`) → push → verify post-deploy.

If clean: TaskUpdate phase to completed → move to next.

After all 8 phases: summary table of findings + severity counts.

---

## Floor declaration

If 2 consecutive runs find 0 bugs across all 8 phases, declare floor.
Anything below is optimization (Tier 2+), not blocker.

Past audit floor: round 6 of session 2026-05-24. Round 7 onward expected
zero new critical findings — only Tier 2 hardening (race conditions under
extreme burst) or Tier 3 SEO/perf optimization.
