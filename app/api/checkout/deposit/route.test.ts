// POST /api/checkout/deposit — rate-limiter pins (ad-readiness 2026-08-17).
//
// This route mints the card-charge PaymentIntent and shipped with NO
// throughput ceiling while its sibling money-mint
// (app/api/checkout/product/intent) has been rate-limited since the checkout
// audit. Ben is about to point heavy paid Meta traffic at deposit pages, so
// the ceiling is now load-bearing. Pinned here:
//   1. the limiter ENGAGES — request N+1 from one IP gets a 429;
//   2. it is the OUTERMOST guard, ahead of every other gate on the route
//      (nothing reaches Stripe/Airtable to be counted);
//   3. buckets are PER-IP — one hot IP never starves a different buyer;
//   4. the 429 body is buyer-safe and never implies a charge;
//   5. (source pin) the helper is rateLimitStrict, NOT the base rateLimit —
//      the base one fails OPEN on a Redis outage, which would silently
//      reinstate the unbounded hole this fix closes. A behavioral test cannot
//      catch that swap, so it is pinned against the source.
//
// The env is neutered below so no request in this file can reach Stripe or
// Airtable: Upstash unset forces rateLimitStrict onto its in-memory window
// (the same never-fails-open path production falls back to), and
// STRIPE_CONNECT_ENABLED unset makes every ALLOWED request short-circuit at
// the 503 immediately after the limiter — which is exactly what proves the
// limiter runs first. Both are read LAZILY (inside getRedis / inside POST), so
// deleting them at module scope — after the hoisted imports, before any test
// body runs — is sufficient.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { POST } from './route';

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.STRIPE_CONNECT_ENABLED;

/** The number the route documents. Mirrored here so a change is deliberate. */
const LIMIT = 20;

/**
 * A POST from `ip`. x-vercel-forwarded-for is the platform-set header
 * getTrustedClientIp prefers — a caller cannot forge it, which is the whole
 * point of the trusted-IP bucket.
 */
function depositPost(ip: string): ReturnType<typeof POST> {
  return POST(
    new Request('https://www.buyhalfcow.com/api/checkout/deposit', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vercel-forwarded-for': ip,
        origin: 'https://www.buyhalfcow.com',
      },
      body: JSON.stringify({ referralId: 'recTESTREFERRAL1', cutSize: 'half', termsAccepted: true }),
    }),
  );
}

/** Unique per test so the module-level in-memory buckets can't cross-talk. */
let ipSeq = 0;
const nextIp = () => `203.0.113.${++ipSeq}`;

test('the limiter ENGAGES: request LIMIT+1 from one IP is a 429', async () => {
  const ip = nextIp();
  for (let i = 0; i < LIMIT; i++) {
    const res = await depositPost(ip);
    assert.notEqual(res.status, 429, `request ${i + 1} of ${LIMIT} must be under the ceiling`);
  }
  const over = await depositPost(ip);
  assert.equal(over.status, 429, `request ${LIMIT + 1} must be rate limited`);
});

test('the limiter is the OUTERMOST guard — it beats the Connect-enabled gate', async () => {
  const ip = nextIp();
  // STRIPE_CONNECT_ENABLED is unset, so every allowed request stops at the 503
  // one line later. Seeing 503 → 503 → … → 429 proves the limiter counted the
  // request BEFORE any other gate, i.e. no gate can be used to burn quota-free
  // work, and nothing downstream (Stripe, Airtable, Redis claims) is reached.
  const first = await depositPost(ip);
  assert.equal(first.status, 503, 'sanity: allowed requests fall through to the Connect gate');
  for (let i = 1; i < LIMIT; i++) await depositPost(ip);
  assert.equal((await depositPost(ip)).status, 429);
});

test('buckets are PER-IP — a saturated IP never blocks a different buyer', async () => {
  const hot = nextIp();
  for (let i = 0; i <= LIMIT; i++) await depositPost(hot);
  assert.equal((await depositPost(hot)).status, 429, 'the hot IP stays limited');

  const cold = nextIp();
  const res = await depositPost(cold);
  assert.notEqual(res.status, 429, 'a different IP must start with a full budget');
});

test('the 429 body is buyer-safe and never implies a charge', async () => {
  const ip = nextIp();
  for (let i = 0; i <= LIMIT; i++) await depositPost(ip);
  const res = await depositPost(ip);
  assert.equal(res.status, 429);

  const j = await res.json();
  assert.equal(j.error, 'rate_limited');
  assert.ok(typeof j.message === 'string' && j.message.length > 0, 'a 429 must carry buyer copy');
  // No raw internals leak, and the copy reassures rather than alarms.
  assert.ok(!/redis|upstash|ratelimit|stripe/i.test(JSON.stringify(j)), 'no infra detail may leak');
  assert.match(j.message, /not charged/i, 'the buyer must be told their card was not charged');
});

test('a rate-limited buyer is NOT dead-ended by the deposit page (non-terminal error code)', () => {
  // app/checkout/[refId]/deposit/page.tsx reserves the full-screen takeover for
  // TERMINAL states, matching on substrings of the error code. 'rate_limited'
  // must miss every one of them so the 429 renders inline, above a pay button
  // the buyer can simply press again a minute later.
  const code = 'rate_limited';
  for (const terminal of ['referral_closed', 'already', 'auth', 'forbidden', 'sign in', '401', '403', 'not_found', 'not found']) {
    assert.ok(!code.includes(terminal), `'${code}' must not read as terminal ('${terminal}')`);
  }
});

// ── source pin: posture cannot silently regress ───────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(HERE, 'route.ts'), 'utf8');

test('PIN: the mint uses rateLimitStrict (never fails open), not the base rateLimit', () => {
  assert.match(
    src,
    /import \{ rateLimitStrict, getTrustedClientIp \} from '@\/lib\/rateLimit';/,
    'must import the strict helper, mirroring the product/intent sibling',
  );
  assert.match(src, /await rateLimitStrict\(`deposit-session:\$\{getTrustedClientIp\(req\)\}`/);
  // The base rateLimit() returns ok:true whenever Upstash is missing or
  // erroring — on a money mint that is an unbounded hole, not a ceiling.
  assert.ok(
    !/[^a-zA-Z]rateLimit\(/.test(src),
    'the fail-open base rateLimit() must never be used on this route',
  );
});

test('PIN: the bucket is the TRUSTED client IP, not the spoofable x-forwarded-for', () => {
  // getRequestIp trusts the FIRST x-forwarded-for hop, which is caller-supplied
  // on Vercel — a retry storm could rotate it and get a fresh bucket per
  // request. getTrustedClientIp prefers the platform-set headers.
  assert.ok(!src.includes('getRequestIp'), 'must not bucket on the spoofable IP helper');
});

test('PIN: the documented limit and the enforced limit are the same number', () => {
  const m = src.match(/const DEPOSIT_MINTS_PER_MINUTE_PER_IP = (\d+);/);
  assert.ok(m, 'the limit must be a named, documented constant');
  assert.equal(Number(m![1]), LIMIT);
  assert.match(src, /requests: DEPOSIT_MINTS_PER_MINUTE_PER_IP/);
  // The comment must justify the number, not just state it.
  assert.match(src, new RegExp(`WHY ${LIMIT}/min`), 'the chosen limit must be reasoned in a comment');
});

test('PIN: only POST is limited — the GET the success page POLLS stays open', () => {
  // The success page polls GET /api/checkout/deposit while it waits for the
  // webhook to settle. Limiting that would break confirmation for the buyer
  // who just paid — the exact opposite of the goal.
  const postIdx = src.indexOf('export async function POST');
  const getIdx = src.indexOf('export async function GET');
  const limiterIdx = src.indexOf('rateLimitStrict(`deposit-session');
  assert.ok(postIdx > -1 && getIdx > -1 && limiterIdx > -1);
  assert.ok(limiterIdx > postIdx && limiterIdx < getIdx, 'the limiter must live inside POST only');
  assert.equal(src.split('rateLimitStrict(').length - 1, 1, 'exactly one limiter call site on the route');
});
