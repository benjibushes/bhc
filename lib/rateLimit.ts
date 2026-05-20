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
