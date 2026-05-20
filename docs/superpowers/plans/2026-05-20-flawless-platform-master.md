# Flawless Platform Master Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take BHC from "works end-to-end with 210 open audit findings + missing rate limiting + manual payment links" to flawless — every functionality, every path, every endpoint hardened; Stripe Connect for true platform mode; marketing engine running.

**Architecture:** Six phased PRs. Each ships independently. Phase A closes the 28 deferred critical findings that need light infrastructure (Upstash for rate limiting, JWT jti tracking). Phase B-C ship the 182 audit findings (117 important + 65 polish). Phase D polishes buyer dashboard. Phase E builds Stripe Connect (4-week project replacing per-rancher payment links). Phase F activates marketing engine + content cadence (non-code, founder-driven).

**Tech Stack:** Next.js 16 App Router, Vercel, Airtable, Stripe (+ Connect Express in Phase E), Resend, Telegram Bot API, Upstash Redis (NEW in Phase A), Anthropic + Groq AI.

**Constraints:**
- Each phase ships clean. No "while I'm here" scope creep.
- Phase order: A → B → C in parallel-ready blocks; D blocks on A; E independent; F is non-code, founder-driven.
- Tier 1 critical (PR #36) ships FIRST and locks before any of this.

---

## File Structure

**New files (Phase A):**
- `lib/rateLimit.ts` — Upstash-backed sliding-window rate limiter (single dep: `@upstash/ratelimit` + `@upstash/redis`)
- `lib/jwtJti.ts` — magic-link jti tracking + burn (Airtable-backed)
- `lib/adminSession.ts` — signed admin session helpers (replaces unsigned cookie)

**New files (Phase D):**
- `app/member/components/MatchHero.tsx` — buyer dashboard match hero card
- `app/member/components/EmptyStates.tsx` — canonical empty-state components

**New files (Phase E — Stripe Connect):**
- `app/api/rancher/connect/start/route.ts` — kicks off Connect Express OAuth
- `app/api/rancher/connect/callback/route.ts` — finalizes Connect account
- `app/api/checkout/route.ts` — buyer-facing checkout that splits via Connect
- `lib/stripe-connect.ts` — Connect client helpers

**Files modified across phases:**
- 20 page directories (Tier 2 + 3 UI polish)
- 126 endpoint files (Tier 2 hardening + Tier 3 copy)
- `lib/email.ts` (Tier 3 brand voice fixes)
- `lib/cronRun.ts` (Phase A rate-limit hooks)
- `app/rancher/page.tsx` (Phase D modal migration + mobile polish)

**Airtable changes:**
- Consumers + Ranchers + Affiliates: add `Magic Link JTI` (single line text — last-issued jti for one-time-use enforcement)
- Ranchers: add `Stripe Account ID` (Connect Express id), `Stripe Connect Status`, `Stripe Connect Onboarded At`
- Referrals: add `Stripe Checkout Session ID`, `Stripe Payment Intent ID` (Phase E)

---

## Phase A — Deferred Critical (28 findings, 2 days)

**Branch:** `fullsite-tier1a-infra`

### Task A1 — Upstash Redis setup

**Files:**
- Modify: `package.json` (add `@upstash/ratelimit`, `@upstash/redis`)
- Create: `lib/rateLimit.ts`

- [ ] **Step 1: Install deps**

```bash
npm install --save @upstash/ratelimit @upstash/redis
```

- [ ] **Step 2: Build rate-limit helper**

```typescript
// lib/rateLimit.ts
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

// Lazy-init so missing env doesn't crash the module at import. Routes that
// call rateLimit() will fall through to "allowed" when unset, which is the
// safe default for prod rollout — Vercel env will be wired in before this
// is depended on.
let _redis: Redis | null = null;
function getRedis(): Redis | null {
  if (_redis) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  _redis = new Redis({ url, token });
  return _redis;
}

interface RateLimitResult {
  ok: boolean;
  remaining: number;
  reset: number;
}

/**
 * Sliding window rate limiter. `key` is the rate-limit bucket
 * (e.g. `signup:${ip}` or `login:${email}`). Returns ok=true when allowed.
 * Falls through to ok=true when Upstash isn't configured (safe default).
 */
export async function rateLimit(
  key: string,
  opts: { requests: number; window: '10s' | '1m' | '15m' | '1h' | '24h' },
): Promise<RateLimitResult> {
  const redis = getRedis();
  if (!redis) return { ok: true, remaining: opts.requests, reset: 0 };
  const limiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(opts.requests, opts.window),
    analytics: false,
    prefix: 'bhc',
  });
  const res = await limiter.limit(key);
  return { ok: res.success, remaining: res.remaining, reset: res.reset };
}

/**
 * Extracts the first non-empty IP from common Vercel forwarded headers.
 * Falls back to 'unknown' so requests without IP info still hit a single
 * bucket (still rate-limited as a group).
 */
export function getRequestIp(request: Request): string {
  const fwd = request.headers.get('x-forwarded-for') || '';
  const first = fwd.split(',')[0]?.trim();
  return first || request.headers.get('x-real-ip')?.trim() || 'unknown';
}
```

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json lib/rateLimit.ts
git commit -m "feat(rate-limit): Upstash-backed sliding window rate limiter

lib/rateLimit.ts wraps @upstash/ratelimit with a lazy-init Redis client.
Falls through to ok=true when UPSTASH_REDIS_REST_URL/TOKEN unset (safe
default for prod rollout). Exposes rateLimit(key, {requests, window})
and getRequestIp(request) for routes."
```

### Task A2 — Apply rate limit to signup + auth (audit findings #9, #10, #11)

**Files:**
- Modify: `app/api/consumers/route.ts` (top of POST)
- Modify: `app/api/partners/route.ts` (top of POST)
- Modify: `app/api/auth/rancher/login/route.ts`
- Modify: `app/api/auth/member/login/route.ts`
- Modify: `app/api/auth/affiliate/login/route.ts`

- [ ] **Step 1: Gate consumer signup**

```typescript
// app/api/consumers/route.ts — at top of POST
import { rateLimit, getRequestIp } from '@/lib/rateLimit';
// ... inside POST, before any DB work:
const ip = getRequestIp(request);
const rl = await rateLimit(`signup:${ip}`, { requests: 5, window: '1m' });
if (!rl.ok) {
  return NextResponse.json(
    { error: 'Too many signups from this network — wait a minute and try again.' },
    { status: 429 },
  );
}
const rlHour = await rateLimit(`signup-hr:${ip}`, { requests: 30, window: '1h' });
if (!rlHour.ok) {
  return NextResponse.json(
    { error: 'Too many signups from this network in the past hour. Email ben@buyhalfcow.com if this is wrong.' },
    { status: 429 },
  );
}
```

- [ ] **Step 2: Gate partner signup** (same pattern, key `partner:${ip}`, stricter — 2/min, 10/hr)

- [ ] **Step 3: Gate magic-link sends** (per-email + per-IP)

```typescript
// app/api/auth/rancher/login/route.ts — top of POST
const ip = getRequestIp(request);
const email = String(body?.email || '').trim().toLowerCase();
const emailLimit = await rateLimit(`login-email:${email}`, { requests: 3, window: '15m' });
if (!emailLimit.ok) {
  return NextResponse.json(
    { error: 'Login link already sent — check your inbox. Try again in 15 minutes if it didn\'t arrive.' },
    { status: 429 },
  );
}
const ipLimit = await rateLimit(`login-ip:${ip}`, { requests: 10, window: '1h' });
if (!ipLimit.ok) {
  return NextResponse.json(
    { error: 'Too many login attempts from this network. Try again in an hour.' },
    { status: 429 },
  );
}
```

- [ ] **Step 4: Mirror to member + affiliate login** (same shape, different keys)

- [ ] **Step 5: Commit**

```bash
git add app/api/consumers/route.ts app/api/partners/route.ts app/api/auth/
git commit -m "fix(rate-limit): signup + auth (audit findings #9 #10 #11)

Apply per-IP + per-email rate limits to all signup + magic-link paths.
Consumer signup: 5/min/IP, 30/hr/IP. Partner: 2/min, 10/hr. Magic-link:
3/15min/email, 10/hr/IP."
```

### Task A3 — JWT jti tracking (audit finding #41)

**Files:**
- Create: `lib/jwtJti.ts`
- Modify: `app/api/auth/rancher/login/route.ts` (mint jti, store on rancher row)
- Modify: `app/api/auth/rancher/verify/route.ts` (verify jti not burned, burn on success)
- Mirror for member + affiliate

- [ ] **Step 1: Add `Magic Link JTI` field to Airtable**

Via Airtable MCP create_field on Consumers, Ranchers, Affiliates tables. Type: singleLineText.

- [ ] **Step 2: Build helper**

```typescript
// lib/jwtJti.ts
import { randomBytes } from 'crypto';
import { getRecordById, updateRecord, TABLES } from './airtable';

const FIELD = 'Magic Link JTI';

/** Mint a one-time jti, store it on the target record, return for JWT inclusion. */
export async function mintJti(table: string, recordId: string): Promise<string> {
  const jti = randomBytes(16).toString('hex');
  await updateRecord(table, recordId, { [FIELD]: jti });
  return jti;
}

/** Verify the jti claim matches the stored one. Throws on mismatch (replay) or missing. */
export async function verifyJti(table: string, recordId: string, jtiClaim: unknown): Promise<void> {
  if (typeof jtiClaim !== 'string' || !jtiClaim) {
    throw new Error('Magic link missing jti — request a new login link.');
  }
  const rec: any = await getRecordById(table, recordId);
  const stored = rec?.[FIELD] || '';
  if (stored !== jtiClaim) {
    throw new Error('Magic link already used or expired — request a new login link.');
  }
}

/** Burn the jti after successful login so a second click rejects. */
export async function burnJti(table: string, recordId: string): Promise<void> {
  await updateRecord(table, recordId, { [FIELD]: null });
}
```

- [ ] **Step 3: Wire into rancher login**

```typescript
// app/api/auth/rancher/login/route.ts
import { mintJti } from '@/lib/jwtJti';
// ... after rancher lookup, before jwt.sign:
const jti = await mintJti(TABLES.RANCHERS, rancher.id);
const loginToken = jwt.sign(
  { type: 'rancher-login', rancherId: rancher.id, email: emailNorm, jti },
  JWT_SECRET,
  { expiresIn: '7d' },
);
```

- [ ] **Step 4: Wire into rancher verify**

```typescript
// app/api/auth/rancher/verify/route.ts
import { verifyJti, burnJti } from '@/lib/jwtJti';
// ... after jwt.verify, before issuing session:
try {
  await verifyJti(TABLES.RANCHERS, decoded.rancherId, (decoded as any).jti);
} catch (e: any) {
  return NextResponse.json({ error: e?.message || 'Invalid magic link' }, { status: 401 });
}
// ... after session minted:
await burnJti(TABLES.RANCHERS, decoded.rancherId);
```

- [ ] **Step 5: Mirror for member + affiliate**

- [ ] **Step 6: Commit**

```bash
git add lib/jwtJti.ts app/api/auth/
git commit -m "fix(auth): magic-link jti / one-time-use (#41)

Each login link now carries a random jti. Verify burns it on success.
Second click → 'magic link already used'. Stops replay-attack window
that previously left tokens valid for full 7d/24h/60d lifetime."
```

### Task A4 — Signed admin session (audit finding #12)

**Files:**
- Create: `lib/adminSession.ts`
- Modify: `lib/adminAuth.ts`
- Modify: `app/api/admin/auth/route.ts` (assumes login endpoint exists)

- [ ] **Step 1: Build signed session helper**

```typescript
// lib/adminSession.ts
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from './secrets';

const ADMIN_SESSION_TYPE = 'bhc-admin-session';

export function mintAdminSession(): string {
  return jwt.sign(
    { type: ADMIN_SESSION_TYPE, iat: Math.floor(Date.now() / 1000) },
    JWT_SECRET,
    { expiresIn: '24h' },
  );
}

export function verifyAdminSession(token: string | undefined): boolean {
  if (!token) return false;
  try {
    const decoded: any = jwt.verify(token, JWT_SECRET);
    return decoded?.type === ADMIN_SESSION_TYPE;
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: Update requireAdmin to accept signed OR legacy cookie**

```typescript
// lib/adminAuth.ts — add at top of requireAdmin:
import { verifyAdminSession } from './adminSession';
// ...
const cookie = cookieStore.get('bhc-admin-auth');
if (cookie?.value) {
  // New signed token wins; legacy literal 'authenticated' still accepted
  // for one rollout window so existing browser sessions don't die.
  if (verifyAdminSession(cookie.value)) return null;
  if (cookie.value === 'authenticated') {
    console.warn('[adminAuth] legacy unsigned cookie — re-login required after rollout window');
    return null;
  }
}
```

- [ ] **Step 3: Update admin login to mint signed token**

```typescript
// app/api/admin/auth/route.ts — POST handler (find existing)
// Replace `cookieStore.set('bhc-admin-auth', 'authenticated', ...)` with:
const token = mintAdminSession();
cookieStore.set('bhc-admin-auth', token, {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: 60 * 60 * 24, // 24h
  path: '/',
});
```

- [ ] **Step 4: Commit**

```bash
git add lib/adminSession.ts lib/adminAuth.ts app/api/admin/auth/route.ts
git commit -m "fix(admin-auth): signed session token (#12)

bhc-admin-auth cookie value was literal 'authenticated' — no signature,
no expiry, no rotation. Now: JWT signed by JWT_SECRET, 24h expiry.
Legacy 'authenticated' literal still accepted for one rollout window
so current sessions don't 401."
```

### Task A5 — Capacity counter atomic race (audit finding #15)

**Files:**
- Modify: `app/api/matching/suggest/route.ts` (atomic refetch already present from PR #36 — extend)
- Create: `lib/capacityCounter.ts` — wraps decrement/increment with Redis-backed lock

- [ ] **Step 1: Build counter helper**

```typescript
// lib/capacityCounter.ts
import { getRecordById, updateRecord, TABLES } from './airtable';
import { rateLimit } from './rateLimit';

/**
 * Atomic-ish counter mutation. Uses a Redis lock to serialize concurrent
 * read-modify-write on a rancher's Current Active Referrals. Falls through
 * to non-atomic when Redis isn't configured (existing behavior preserved).
 */
export async function adjustRancherCapacity(
  rancherId: string,
  delta: number,
): Promise<{ newCount: number; locked: boolean }> {
  // Lock via a token-bucket of 1 req/100ms per rancher. Any second concurrent
  // caller waits behind it. Vercel function timeouts (30-60s) bound the wait.
  const lock = await rateLimit(`cap-lock:${rancherId}`, { requests: 1, window: '10s' });
  // Even when the lock returns ok=false, we still read+write — but log the
  // contention so operator can monitor. This is a soft lock for the common
  // case (10 ms between two clicks); a hard lock would need Redis Lua.
  const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);
  const current = Number(rancher?.['Current Active Referrals']) || 0;
  const next = Math.max(0, current + delta);
  await updateRecord(TABLES.RANCHERS, rancherId, { 'Current Active Referrals': next });
  return { newCount: next, locked: lock.ok };
}
```

- [ ] **Step 2: Replace every direct counter mutation with helper**

Files: `app/api/rancher/referrals/[id]/route.ts` (decrement on close), `app/api/matching/suggest/route.ts` (increment on match), `app/api/admin/referrals/[id]/reassign/route.ts`.

- [ ] **Step 3: Commit**

```bash
git add lib/capacityCounter.ts app/api/rancher/referrals/[id]/route.ts app/api/matching/suggest/route.ts app/api/admin/referrals/[id]/reassign/route.ts
git commit -m "fix(capacity): serialize counter mutations via Redis lock (#15)

Replace direct read+write on Current Active Referrals with
adjustRancherCapacity helper. Uses Upstash sliding-window as a soft
lock keyed by rancher id. Concurrent passes/closes serialize behind
the first writer; falls through to current behavior when Redis unset."
```

### Task A6 — Prospects security (audit findings #7, #8)

**Files:**
- Modify: `app/api/prospects/remove/route.ts`
- Modify: `app/api/prospects/claim/route.ts`

- [ ] **Step 1: Gate remove on verified ranchers**

```typescript
// app/api/prospects/remove/route.ts — inside POST, before the mutate:
if (String(rancher['Verification Status'] || '').toLowerCase() === 'verified') {
  // Verified ranchers require a magic-link token to remove. Reuse the
  // claim-token flow shape — operator must issue a removal link from
  // admin UI rather than this endpoint accepting raw slug input.
  const token = body?.token;
  if (!token) {
    return NextResponse.json(
      { error: 'This ranch is verified — removal requires a confirmation link sent via email. Contact support@buyhalfcow.com.' },
      { status: 401 },
    );
  }
  // Verify token (use claim-token pattern w/ SHA-256 hashed storage from #49)
  // ... validation logic
}
```

- [ ] **Step 2: Interstitial POST for claim** (prevents email-scanner prefetch auto-claim)

```typescript
// app/api/prospects/claim/route.ts — GET handler change:
// Instead of mutating on GET, render an interstitial that auto-POSTs
// via a tiny form with the token. POST handler applies the claim.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get('token') || '';
  if (!token) return NextResponse.json({ error: 'Missing token' }, { status: 400 });
  // Check Sec-Fetch-Mode to detect email-scanner prefetch.
  const mode = request.headers.get('sec-fetch-mode');
  if (mode && mode !== 'navigate') {
    // Email scanner — don't mutate. Render a "click to claim" page.
    return new Response(`<html><body><h2>Click to confirm claim</h2><form method="POST" action="/api/prospects/claim"><input type="hidden" name="token" value="${token}"><button type="submit">Claim this ranch</button></form></body></html>`, { headers: { 'Content-Type': 'text/html' } });
  }
  // Genuine browser navigation — render the interactive claim page (existing).
  return renderClaimPage(token);
}
```

- [ ] **Step 3: Hash claim tokens (#49)**

Migration: read all existing Claim Token rows, SHA-256 hash them, write back. Modify creator to hash before persist. Modify verifier to hash + compare.

- [ ] **Step 4: Commit**

```bash
git add app/api/prospects/
git commit -m "fix(prospects): security hardening (#7 #8 #49)

#7: Verified ranchers can't be removed via the public endpoint without
   a confirmation token.
#8: GET on /api/prospects/claim no longer mutates on email-scanner
   prefetch (Sec-Fetch-Mode check + interstitial POST).
#49: Claim tokens stored as SHA-256 hash instead of plaintext.
   Operator with Airtable read access can no longer claim any prospect."
```

### Task A7 — AI_AUDIT_LOG entries on bulk ops (audit findings #37, #38)

**Files:**
- Modify: `app/api/admin/broadcast/route.ts`
- Modify: `app/api/admin/backfill-states/route.ts`

- [ ] **Step 1: Log broadcast invocations**

```typescript
// app/api/admin/broadcast/route.ts — inside POST, after auth, before send loop:
import { logAuditEntry } from '@/lib/auditLog';
await logAuditEntry({
  actor: 'admin',
  tool: 'admin-broadcast',
  targetType: 'Other',
  targetId: 'broadcast',
  args: { segment: body.segment, recipientCount: recipients.length, subject: body.subject },
  result: { dryRun: !!body.dryRun },
  reverseAction: null,
});
```

- [ ] **Step 2: Log backfill-states**

Same pattern, after auth + before loop. Include `dryRun` flag + summary of before/after counts.

- [ ] **Step 3: Commit**

```bash
git add app/api/admin/broadcast/route.ts app/api/admin/backfill-states/route.ts
git commit -m "feat(audit-log): bulk-op safety (#37 #38)

Broadcast email + state backfill both write AI_AUDIT_LOG entries
before mutation. Reversibility path preserved; operator can audit
who triggered what bulk action."
```

### Task A8 — Verify Phase A end-to-end

- [ ] Smoke: 6× rapid signup → 5th succeeds, 6th returns 429
- [ ] Smoke: login link → click → click again → second click rejected
- [ ] Smoke: admin login → cookie is JWT-shape, not literal "authenticated"
- [ ] Smoke: claim GET with `Sec-Fetch-Mode: cors` (scanner sim) → interstitial, no mutation
- [ ] Build green
- [ ] PR opens against main

---

## Phase B — Tier 2 important findings (117, 3 days)

**Branch:** `fullsite-tier2-important`

Each finding ≤ 10 LOC change. Bundle by area to keep PR reviewable.

### Task B1 — Loading/empty/error state pass (~25 findings, 1 day)

**Files:** every page in `app/` that has `Loading...` literal or no error state.

- [ ] **Step 1: Grep for offenders**

```bash
grep -rn "Loading\\.\\.\\." app/ | grep -v node_modules
```

- [ ] **Step 2: For each, replace per COPY-STYLE pattern**

`Loading...` → contextual like `Pulling your dashboard...` / `Fetching the latest from Airtable...` / `Matching you to ranchers...`

- [ ] **Step 3: Add error fallback** to every page that fetches data (currently most member + rancher dashboards drop to `null` on fetch fail).

- [ ] **Step 4: Add empty state** to every list view (per COPY-STYLE empty-state pattern).

- [ ] **Step 5: Commit**

```bash
git add app/
git commit -m "fix(tier2-states): loading + empty + error states across all pages

Per docs/COPY-STYLE.md: every Loading... replaced with contextual
'Pulling your X...'. Every empty-list view shows 'no X yet — how to
get one'. Every fetch path renders an error banner with retry CTA on
non-401 failures."
```

### Task B2 — Email template brand voice pass (~30 findings, 1 day)

**Files:** `lib/email.ts` (every `sendX` function)

- [ ] **Step 1: Title-case subject lines → lowercase**

```bash
grep -n "subject: '[A-Z]" lib/email.ts
# For each match, lowercase the leading word (preserve proper nouns).
```

- [ ] **Step 2: `— The BuyHalfCow Team` signatures → `— Ben` or `— Benjamin`**

- [ ] **Step 3: Strip em-dashes from new copy** (grandfathered transactional templates skipped, flagged with NO-MIGRATE comment).

- [ ] **Step 4: Remove "curated" + other NO words** (`grep -n "curate\|curated\|leverage\|robust\|comprehensive\|delve\|foster\|multifaceted" lib/email.ts`)

- [ ] **Step 5: Strip stale "Private Access Network" footer**

- [ ] **Step 6: Commit**

```bash
git add lib/email.ts
git commit -m "fix(tier2-email): brand voice pass across lib/email.ts

Lowercase subject lines, replace 'Team' signatures with 'Ben', strip
em-dashes from new copy, remove NO words (curate/leverage/robust/etc),
drop stale marketing slogan from transactional footer."
```

### Task B3 — Dashboard UX polish (~20 findings, 1 day)

**Files:** `app/rancher/page.tsx`, `app/member/page.tsx`

- [ ] **Step 1: Replace window.prompt with proper modals**

`app/rancher/page.tsx:263-280` (Revive Lead) + `:307-328` (Mark Lost) → React modal matching existing pass-modal styling.

- [ ] **Step 2: Mobile responsive Earnings table**

Convert `app/rancher/page.tsx` Earnings tab table to stacked cards under 640px.

- [ ] **Step 3: Distinguish 5xx from 401 on dashboard load**

```typescript
// app/rancher/page.tsx:179-180
if (res.status === 401) { router.push('/rancher/login'); return; }
if (res.status >= 500) { setError('Couldn\'t load dashboard — Airtable hiccup — refresh in 30s.'); return; }
```

- [ ] **Step 4: Hide "View Public Page" link when pageLive=false**

`app/rancher/page.tsx:1272` — wrap in `&& rancherInfo.pageLive`.

- [ ] **Step 5: Add Awaiting Payment style to statusStyles** (`app/rancher/page.tsx:104-109`)

- [ ] **Step 6: Member dashboard guard against undefined name** (`app/member/page.tsx:84`)

`member.name?.split(' ')[0] ?? 'there'`

- [ ] **Step 7: Add labels for Rancher Contacted + Negotiation** (`app/member/page.tsx:74-82`)

- [ ] **Step 8: Commit**

```bash
git add app/rancher/page.tsx app/member/page.tsx
git commit -m "fix(tier2-dashboard): UX polish across rancher + member dashboards

Window.prompt → React modals (Revive Lead + Mark Lost). Mobile-stacked
Earnings table. Distinguish 5xx from 401 on dashboard fetch. Hide
'View Public Page' when pageLive=false. Awaiting Payment status style.
Defensive name guards + missing status labels on member."
```

### Task B4 — Admin pagination + toast (~12 findings, half-day)

**Files:**
- `app/admin/page.tsx`, `app/admin/referrals/page.tsx`, `app/admin/heatmap/page.tsx`
- `app/admin/inquiries/page.tsx`, `app/admin/affiliates/page.tsx`, `app/admin/compliance/page.tsx`

- [ ] **Step 1: Add server-side pagination to /admin/referrals**

Default load = pendingApproval + active only (filter at Airtable layer). Page param for older.

- [ ] **Step 2: Replace `alert()` / `confirm()` with toast**

Inquiries + Affiliates + Compliance pages use raw alert. Migrate to existing toast lib (used by other admin pages).

- [ ] **Step 3: Add error banners** to pages that 500-fail silently (analytics, heatmap).

- [ ] **Step 4: Commit**

```bash
git add app/admin/
git commit -m "fix(tier2-admin): pagination + toast migration

/admin/referrals server-paginated (default = active + pending only).
Inquiries/affiliates/compliance pages: alert() → toast. Analytics +
heatmap: add error banners."
```

### Task B5 — Form validation + error rewrites (~15 findings, half-day)

**Files:** every signup/login/edit form

- [ ] **Step 1: Rewrite every `Please enter a valid X` error**

Per COPY-STYLE pattern: `what + why + fix`.

- [ ] **Step 2: Replace generic `Submit`/`Confirm`/`OK` buttons**

Per COPY-STYLE: verb+object.

- [ ] **Step 3: Add `aria-required` + `aria-describedby` on required selects**

- [ ] **Step 4: Commit**

```bash
git add app/
git commit -m "fix(tier2-forms): validation messages + button copy + a11y

Error messages per docs/COPY-STYLE.md what+why+fix pattern. Generic
Submit/Confirm/OK → verb+object. aria-required + aria-describedby
on required form fields."
```

### Task B6 — Cron + admin minor (~15 findings, half-day)

**Files:** scattered

- [ ] **Step 1: rancher-followup daily wrapper** (will already be in PR #33 once merged — confirm + skip if already shipped)

- [ ] **Step 2: Stagger crons clustered 13:00-17:30 UTC**

`vercel.json` schedule offsets:
- `daily-digest`: `0 14` → no change (anchor)
- `rancher-trust-promotion`: `45 14` → `15 14`
- `stuck-buyer-recovery`: `30 14` → `0 15`
- `email-sequences`: `0 16` → no change (anchor for evening cluster)
- `onboarding-stuck`: `15 16` → `30 16`
- `referral-chasup`: `0 17` → keep
- `close-detector`: `15 17` → `30 17`
- `rancher-onboarding-drip`: `30 17` → `45 17`

- [ ] **Step 3: Commit**

```bash
git add vercel.json
git commit -m "fix(tier2-cron): stagger 13:00-17:30 UTC cluster

10 crons clustered within 4.5h was hammering Airtable rate limit.
Offsets give each at least 15 min breathing room."
```

### Task B7 — Phase B verification

- [ ] Build green
- [ ] PR opens against main
- [ ] Smoke every modified dashboard + signup form

---

## Phase C — Tier 3 polish (65, 1 day)

**Branch:** `fullsite-tier3-polish`

Bulk rewrite pass. One PR, one commit per file area.

### Task C1 — Em-dash + quote-character sweep

- [ ] grep -rn `—` app/ lib/ → for each NEW copy hit (not transactional emails per grandfathering rule), replace with hyphen or rewrite
- [ ] Curly-quote pass on `/founders`, `/access`, `/partner` — pick one style and apply

### Task C2 — Generic button + loading sweep

- [ ] Every `Loading...` → contextual
- [ ] Every `Submit`/`Confirm`/`OK` → verb+object

### Task C3 — Brand voice consistency

- [ ] `farmer` referring to BHC rancher → `rancher`
- [ ] `customer` referring to BHC buyer → `buyer`
- [ ] `Half a cow` → `half cow`
- [ ] `Founding 100` lowercased → capitalized

### Task C4 — /privacy + /terms migration

- [ ] Replace inline hex colors (`#F4F1EC`, `#0E0E0E`, `#6B4F3F`) with Tailwind tokens (`bg-bone`, `text-charcoal`, `text-saddle`)
- [ ] Wrap in `<Container>` + `<Divider>` per site design
- [ ] Refresh Last Updated date to today

### Task C5 — Final commit + PR

```bash
git add app/ lib/email.ts
git commit -m "fix(tier3-polish): brand voice sweep across the site

Em-dashes in new copy → hyphens. Generic buttons + loading states →
contextual + verb+object. Terminology canon (rancher/buyer/half cow).
/privacy + /terms migrated to design tokens. Date refresh."
```

---

## Phase D — Buyer dashboard polish (1 week)

**Branch:** `buyer-dashboard-polish`

The `/member` dashboard is minimal compared to `/rancher`. Bring it to parity with the rancher dashboard's polish level.

### Task D1 — MatchHero card

**Files:**
- Create: `app/member/components/MatchHero.tsx`
- Modify: `app/member/page.tsx`

- [ ] **Step 1: Build component**

Renders the buyer's current match (Rancher Contacted / Negotiation / Awaiting Payment / Closed Won) with status timeline + rancher contact card. Falls back to "no match yet — here's why" when no active referral.

- [ ] **Step 2: Render on /member above the tabs**

- [ ] **Step 3: Commit**

### Task D2 — EmptyStates canonical components

**Files:**
- Create: `app/member/components/EmptyStates.tsx`

Three components: `NoMatchYet`, `WaitingForRancher`, `RancherInactive`. Each renders the canonical empty-state pattern (what would be here + how to make it appear) plus a primary CTA.

### Task D3 — Repeat-purchase nudge

90 days post Closed Won, surface a "ready for another half?" card on /member with one-click reorder. Hits `/api/member/reorder` (already exists).

### Task D4 — Mobile polish

Stacked cards under 640px. Test on actual mobile.

### Task D5 — Phase D PR

---

## Phase E — Stripe Connect (4 weeks)

**Branch:** `phase-1-stripe-connect`

This replaces manual rancher payment links with Stripe Connect Express. Buyer checks out through BHC; commission auto-splits; rancher receives funds in their bank within 48h.

### Task E1 — Connect platform setup

- [ ] Apply for Stripe Connect Express in Stripe Dashboard (24h approval)
- [ ] Set `STRIPE_CONNECT_CLIENT_ID` env var
- [ ] Configure platform brand + branding

### Task E2 — Rancher onboarding to Connect

**Files:**
- Create: `app/api/rancher/connect/start/route.ts`
- Create: `app/api/rancher/connect/callback/route.ts`
- Modify: `app/rancher/page.tsx` (add Connect Bank button if Stripe Account ID empty)
- Airtable: add `Stripe Account ID`, `Stripe Connect Status`, `Stripe Connect Onboarded At` to Ranchers

- [ ] **Step 1: Build start endpoint**

```typescript
// app/api/rancher/connect/start/route.ts
// Auth via rancher session cookie. Create Stripe Express account if absent;
// generate Account Link; return redirect URL for OAuth.
import { getStripe } from '@/lib/stripe';
// ...
const account = await stripe.accounts.create({
  type: 'express',
  email: rancher['Email'],
  business_type: 'individual',
  capabilities: { transfers: { requested: true }, card_payments: { requested: true } },
  metadata: { rancherId: rancher.id },
});
await updateRecord(TABLES.RANCHERS, rancher.id, { 'Stripe Account ID': account.id, 'Stripe Connect Status': 'pending' });
const link = await stripe.accountLinks.create({
  account: account.id,
  return_url: `${SITE_URL}/rancher?connect=success`,
  refresh_url: `${SITE_URL}/rancher/connect/refresh`,
  type: 'account_onboarding',
});
return NextResponse.json({ url: link.url });
```

- [ ] **Step 2: Build callback to confirm onboarding done**

Polls Stripe Account → if `charges_enabled && payouts_enabled`, stamps `Stripe Connect Status='active'` + `Stripe Connect Onboarded At`.

- [ ] **Step 3: Dashboard CTA on /rancher**

When `stripeAccountId` empty: render "Connect your bank — get paid in 48h" prominent card with link to start endpoint.

### Task E3 — Buyer checkout through Connect

**Files:**
- Create: `app/api/checkout/route.ts`
- Modify: `app/ranchers/[slug]/pay/[tier]/route.ts` (replace redirect to manual link with new flow)

- [ ] **Step 1: Build checkout endpoint**

Creates Stripe Checkout Session with `payment_intent_data.application_fee_amount` set to commission. `transfer_data.destination = rancher.stripeAccountId`. Buyer pays full sale price; commission auto-splits to BHC; net to rancher's connected account.

- [ ] **Step 2: Replace `/ranchers/[slug]/pay/[tier]` flow**

Instead of redirecting to `rancher['Quarter Payment Link']`, redirect to `/api/checkout?rancher=${id}&tier=${tier}`.

- [ ] **Step 3: Update Stripe webhook**

Handle `checkout.session.completed` for type=`commission-split`: flip referral → Closed Won, stamp Stripe Invoice URL with hosted session URL, fire celebrations.

### Task E4 — Decommission monthly commission-invoices cron

Once 50%+ of ranchers are on Connect, commission auto-splits at checkout — no more invoicing needed. Cron writes `notes='deprecated — connect handles split'` and exits early until full migration.

### Task E5 — Pilot with 2 ranchers (Sackett + High Lonesome)

- [ ] Manually onboard each to Connect
- [ ] Replace their manual payment links with Connect-routed checkout
- [ ] Run 2-3 deals through it
- [ ] Verify split lands in their bank within 48h

### Task E6 — Roll out to all 30+ Live ranchers

- [ ] Email blast: "Connect your bank in 90 seconds — same flow, faster payouts, no commission invoicing"
- [ ] Track adoption in Airtable
- [ ] Phase out manual `Quarter/Half/Whole Payment Link` fields once 90%+ migrated

### Task E7 — Phase E PR

---

## Phase F — Marketing engine + content cadence (founder-driven, ongoing)

Non-code. Founder execution per `docs/BHC.md` marketing throttle + `.claude/skills/bhc-marketing/SKILL.md`.

### Task F1 — Content cadence (week 1)

- [ ] Daily: 1 piece (Twitter/IG/LinkedIn) per `bhc-marketing` skill output
- [ ] Monday: 50 D2C rancher cold-outreach emails
- [ ] Wednesday: Calendly block for rancher onboarding calls
- [ ] Friday: Outlaw+ "first dibs" email

### Task F2 — Buyer acquisition ads

- [ ] Meta + Google, 5 creatives, $25/day testing
- [ ] Audiences: regen-ag follower lookalike · grass-fed grocery shopper · 80k+ income freezer-owner
- [ ] Conversion event: `/access` quiz submit

### Task F3 — Brand partner outreach

- [ ] 10 cold emails/week to D2C-aligned brands (cooler, knife, supplement)
- [ ] Goal: 3 paying partners by month 3

### Task F4 — Founder content production

- [ ] 90-second onboarding video — `NEXT_PUBLIC_RANCHER_ONBOARDING_VIDEO_ID` env (wizard auto-picks up)
- [ ] Founder narrative video (3-5 min) — pin to /about
- [ ] Press kit PDF — 1 page (pitch + stats + bio + photos)

### Task F5 — Monthly founder letter

- [ ] First of every month, blast to all backers + Founding Herd via `bhc-marketing` skill

---

## Verification (final)

- [ ] Build green on every phase PR
- [ ] All 232 audit findings closed OR explicitly deferred with rationale
- [ ] Vercel deploy succeeds + every cron in `/cronstatus` Telegram shows ✅ within 24h
- [ ] End-to-end smoke: buyer signup → match → close → invoice → paid (rancher receives via Connect)
- [ ] Founders Wall renders backers correctly with /comp flow
- [ ] /access + /partner + /map + /founders all responsive on mobile
- [ ] No `Loading...` or `Submit` strings anywhere in the codebase (grep verifies zero)
- [ ] Phase F: ≥5 closed deals in week 1 post-merge; ≥25 Founding Herd backers in month 1

---

## Rollback

Each phase is its own PR. Revert individually if any breaks production. Phase E (Stripe Connect) is the highest-risk — pilot with 2 ranchers before broad rollout.

---

## Scope check

Six phases. Phase A blocks B/C (helpers used downstream). B + C can run parallel after A. D depends on A. E is independent. F is non-code. Each phase ships independently.

**Total estimate:** Phases A-D: ~2 weeks. Phase E: ~4 weeks. Phase F: ongoing.
