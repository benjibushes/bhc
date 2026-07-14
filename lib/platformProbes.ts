// lib/platformProbes.ts
//
// THE MORNING-PULSE PROBE SET — cheap, read-only checks that assert the
// platform's load-bearing dependencies are actually alive, not just present.
//
// Born from the 2026-07-14 Resend outage: the key went invalid and every
// email died silently for days while the audit log showed 'sent'. The class
// of failure — a set-once secret rotting silently — applies to every
// integration. These probes make each one a named, asserted line in the
// daily-health-digest (and the email-canary cron reuses the resend probe).
//
// Design rules:
//   - Read-only. No writes, no sends, no state.
//   - Network blip → 'skip' (never a false red); a PERSISTENT outage still
//     surfaces because the digest runs daily.
//   - Every red carries the FIX string — the digest tells Ben what to do,
//     not just that something is wrong.

export interface ProbeResult {
  name: string;
  ok: boolean;
  /** true = probe could not run (network blip) — reported, never red. */
  skipped?: boolean;
  detail: string;
  fix?: string;
}

/** Resend key validity — shared by email-canary + the digest. */
export async function probeResendKey(): Promise<ProbeResult> {
  const key = process.env.RESEND_API_KEY || '';
  if (!key) {
    return {
      name: 'resend_key', ok: false,
      detail: 'RESEND_API_KEY not set — ALL email dead',
      fix: 'resend.com → API Keys → create → Vercel env RESEND_API_KEY → redeploy',
    };
  }
  try {
    const res = await fetch('https://api.resend.com/domains', {
      headers: { Authorization: `Bearer ${key}` }, cache: 'no-store',
    });
    if (res.ok) return { name: 'resend_key', ok: true, detail: 'valid' };
    if ([400, 401, 403].includes(res.status)) {
      return {
        name: 'resend_key', ok: false,
        detail: `Resend rejected the key (HTTP ${res.status}) — ALL email dead`,
        fix: 'rotate RESEND_API_KEY (resend.com → Vercel env → redeploy)',
      };
    }
    return { name: 'resend_key', ok: true, skipped: true, detail: `resend HTTP ${res.status} (their side)` };
  } catch (e: any) {
    return { name: 'resend_key', ok: true, skipped: true, detail: `unreachable: ${e?.message || 'network'}` };
  }
}

/** Stripe secret key validity — the money-rail twin of the Resend probe. */
export async function probeStripeKey(): Promise<ProbeResult> {
  const key = process.env.STRIPE_SECRET_KEY || '';
  if (!key) {
    return {
      name: 'stripe_key', ok: false,
      detail: 'STRIPE_SECRET_KEY not set — every checkout dead',
      fix: 'set STRIPE_SECRET_KEY in Vercel env + redeploy',
    };
  }
  try {
    const res = await fetch('https://api.stripe.com/v1/balance', {
      headers: { Authorization: `Bearer ${key}` }, cache: 'no-store',
    });
    if (res.ok) return { name: 'stripe_key', ok: true, detail: 'valid' };
    if (res.status === 401 || res.status === 403) {
      return {
        name: 'stripe_key', ok: false,
        detail: `Stripe rejected the key (HTTP ${res.status}) — deposits + products + subscriptions ALL dead`,
        fix: 'rotate STRIPE_SECRET_KEY (dashboard.stripe.com → API keys → Vercel env → redeploy)',
      };
    }
    return { name: 'stripe_key', ok: true, skipped: true, detail: `stripe HTTP ${res.status}` };
  } catch (e: any) {
    return { name: 'stripe_key', ok: true, skipped: true, detail: `unreachable: ${e?.message || 'network'}` };
  }
}

/** Upstash Redis — fail-open infra (rate limits, capacity cache, dedupe). */
export async function probeRedis(): Promise<ProbeResult> {
  const url = process.env.UPSTASH_REDIS_REST_URL || '';
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || '';
  if (!url || !token) {
    return {
      name: 'redis', ok: false,
      detail: 'Upstash env missing — rate limits, capacity cache & signal dedupe are silently OFF (fail-open)',
      fix: 'set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN in Vercel env',
    };
  }
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/ping`, {
      headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
    });
    const body = await res.text().catch(() => '');
    if (res.ok && /pong/i.test(body)) return { name: 'redis', ok: true, detail: 'PONG' };
    return {
      name: 'redis', ok: false,
      detail: `Upstash ping failed (HTTP ${res.status}) — fail-open guards are OFF`,
      fix: 'check the Upstash database + credentials',
    };
  } catch (e: any) {
    return { name: 'redis', ok: true, skipped: true, detail: `unreachable: ${e?.message || 'network'}` };
  }
}

/**
 * Load-bearing env presence (no network) — the silent killers, each with its
 * documented blast radius. Sourced from docs/ENV-REGISTRY.md (26 load-bearing);
 * this asserts the subset whose absence has NO other alarm.
 */
export function probeEnvPresence(): ProbeResult[] {
  const checks: Array<{ name: string; present: boolean; blast: string; fix: string }> = [
    {
      name: 'env:STRIPE_CONNECT_WEBHOOK_SECRET',
      present: !!process.env.STRIPE_CONNECT_WEBHOOK_SECRET,
      blast: 'Connect events 400 → deposits paid but never stamped; ranchers stuck "onboarding" forever',
      fix: 'Stripe dashboard → Webhooks (Connect endpoint) → signing secret → Vercel env',
    },
    {
      name: 'env:STRIPE_WEBHOOK_SECRET',
      present: !!process.env.STRIPE_WEBHOOK_SECRET,
      blast: 'platform webhook events 400 → founders/tier/brand purchases never recorded',
      fix: 'Stripe dashboard → Webhooks (platform endpoint) → signing secret → Vercel env',
    },
    {
      name: 'env:TELEGRAM_BOT_TOKEN+CHAT',
      present: !!process.env.TELEGRAM_BOT_TOKEN && !!process.env.TELEGRAM_ADMIN_CHAT_ID,
      blast: 'ALL ops alerting dark (including this digest)',
      fix: 'set TELEGRAM_BOT_TOKEN + TELEGRAM_ADMIN_CHAT_ID',
    },
    {
      name: 'env:INTERNAL_API_SECRET',
      present: !!process.env.INTERNAL_API_SECRET,
      blast: 'qualify→matcher internal calls 401 — routing chain silently dead',
      fix: 'set INTERNAL_API_SECRET in Vercel env',
    },
    {
      name: 'env:STRIPE_CONNECT_ENABLED',
      present: process.env.STRIPE_CONNECT_ENABLED === 'true',
      blast: 'entire deposit/Connect rail 403s (bit us 2026-07-08 as a blank value)',
      fix: "set STRIPE_CONNECT_ENABLED='true' (exact string)",
    },
  ];
  return checks.map((c) => ({
    name: c.name,
    ok: c.present,
    detail: c.present ? 'present' : c.blast,
    fix: c.present ? undefined : c.fix,
  }));
}

/** Run the full morning-pulse probe set. */
export async function runPlatformProbes(): Promise<ProbeResult[]> {
  const [resend, stripe, redis] = await Promise.all([
    probeResendKey(),
    probeStripeKey(),
    probeRedis(),
  ]);
  return [resend, stripe, redis, ...probeEnvPresence()];
}
