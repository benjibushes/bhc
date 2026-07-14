import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

// Lazy-init Upstash Redis client. Missing env doesn't crash module at import —
// routes calling rateLimit() fall through to ok:true when unset (safe default
// during rollout; Vercel env wires in before security depends on this).

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

type Window = '10s' | '1m' | '15m' | '1h' | '24h';

/**
 * Sliding window rate limiter. `key` is the bucket. Returns ok=true when
 * allowed. Falls through to ok=true when Upstash isn't configured (safe
 * default). Network failures on Upstash also fail-open with console.error.
 */
export async function rateLimit(
  key: string,
  opts: { requests: number; window: Window },
): Promise<RateLimitResult> {
  const redis = getRedis();
  if (!redis) {
    return { ok: true, remaining: opts.requests, reset: 0 };
  }
  try {
    const limiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(opts.requests, opts.window),
      analytics: false,
      prefix: 'bhc',
    });
    const res = await limiter.limit(key);
    return { ok: res.success, remaining: res.remaining, reset: res.reset };
  } catch (e) {
    console.error('[rateLimit] limiter failed, allowing request:', (e as any)?.message);
    return { ok: true, remaining: opts.requests, reset: 0 };
  }
}

/** Extract first non-empty IP from common forwarded headers. */
export function getRequestIp(request: Request): string {
  const fwd = request.headers.get('x-forwarded-for') || '';
  const first = fwd.split(',')[0]?.trim();
  if (first) return first;
  const real = request.headers.get('x-real-ip')?.trim();
  if (real) return real;
  return 'unknown';
}

/**
 * Trusted client IP for ABUSE-control buckets (checkout audit 2026-07-14).
 * getRequestIp trusts the FIRST x-forwarded-for value — which is client-
 * supplied on Vercel (the platform APPENDS the real hop), so a card-testing
 * script rotates it per request and gets a fresh bucket every time. Prefer
 * the platform-set headers an attacker cannot forge; fall back to the LAST
 * XFF hop (the one Vercel appended), never the first.
 */
export function getTrustedClientIp(request: Request): string {
  const vercel = request.headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim();
  if (vercel) return vercel;
  const real = request.headers.get('x-real-ip')?.trim();
  if (real) return real;
  const hops = (request.headers.get('x-forwarded-for') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (hops.length > 0) return hops[hops.length - 1];
  return 'unknown';
}

// ── Strict limiter for public MONEY-MINT endpoints ────────────────────────
// The base rateLimit() deliberately fails OPEN (Redis is optional platform
// infra). On the public product-checkout mints that meant: Upstash env drift
// or an outage → UNBOUNDED anonymous PaymentIntent creation → card-testing
// runs chargebacks straight onto the rancher's Connect account. Strict mode
// never allows unbounded: when Redis is missing or erroring it falls back to
// a per-instance in-memory sliding window — weaker than Redis (per-lambda),
// but a burst-cap always exists and checkout stays alive for real buyers.
const memBuckets = new Map<string, number[]>();
const MEM_WINDOW_MS = 60_000;

function memoryLimit(key: string, requests: number): RateLimitResult {
  const now = Date.now();
  const hits = (memBuckets.get(key) || []).filter((t) => now - t < MEM_WINDOW_MS);
  if (memBuckets.size > 10_000) memBuckets.clear(); // unbounded-growth guard
  if (hits.length >= requests) {
    memBuckets.set(key, hits);
    return { ok: false, remaining: 0, reset: hits[0] + MEM_WINDOW_MS };
  }
  hits.push(now);
  memBuckets.set(key, hits);
  return { ok: true, remaining: requests - hits.length, reset: now + MEM_WINDOW_MS };
}

/** Sliding-window limiter that NEVER fails open to unbounded. 1-minute window. */
export async function rateLimitStrict(
  key: string,
  opts: { requests: number },
): Promise<RateLimitResult> {
  const redis = getRedis();
  if (!redis) return memoryLimit(key, opts.requests);
  try {
    const limiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(opts.requests, '1m'),
      analytics: false,
      prefix: 'bhc',
    });
    const res = await limiter.limit(key);
    return { ok: res.success, remaining: res.remaining, reset: res.reset };
  } catch (e) {
    console.error('[rateLimitStrict] redis failed — using in-memory fallback:', (e as any)?.message);
    return memoryLimit(key, opts.requests);
  }
}
