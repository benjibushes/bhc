import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

// Lazy-init Upstash Redis client. Missing env doesn't crash the module at
// import — routes that call rateLimit() fall through to "allowed" when
// unset, which is the safe default for prod rollout (Vercel env wires in
// before this is depended on for security).

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
 * Sliding window rate limiter. `key` is the rate-limit bucket
 * (e.g. `signup:${ip}` or `login:${email}`). Returns ok=true when allowed.
 * Falls through to ok=true when Upstash isn't configured (safe default).
 *
 * Usage:
 *   const rl = await rateLimit(`signup:${ip}`, { requests: 5, window: '1m' });
 *   if (!rl.ok) return NextResponse.json({ error: '...' }, { status: 429 });
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
    // Network blip on Upstash — fail open rather than block legitimate
    // traffic. Logged so operator can monitor.
    console.error('[rateLimit] limiter failed, allowing request:', (e as any)?.message);
    return { ok: true, remaining: opts.requests, reset: 0 };
  }
}

/**
 * Extracts the first non-empty IP from common forwarded headers. Falls
 * back to 'unknown' so requests without IP info still bucket together
 * (still rate-limited as a group, just less granular).
 */
export function getRequestIp(request: Request): string {
  const fwd = request.headers.get('x-forwarded-for') || '';
  const first = fwd.split(',')[0]?.trim();
  if (first) return first;
  const real = request.headers.get('x-real-ip')?.trim();
  if (real) return real;
  return 'unknown';
}
