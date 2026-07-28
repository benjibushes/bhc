// POST /api/funnel/quiz-start
//
// QUIZ-START BEACON (2026-07-28 conversion audit): BuyerFunnel fires
// navigator.sendBeacon() here ONCE per session when the buyer answers the
// FIRST quiz question (see lib/quizStart.ts for the guard). The event lands in
// the same Funnel Events table as 'signup' via the exact same writer
// (lib/funnelMetrics.funnelRecord) so the conversion dashboard can finally see
// pre-contact abandonment: quiz_start → signup is the leak ads would otherwise
// pour money into blind.
//
// Fast + best-effort: ALWAYS 204, never blocks the client, never throws
// (mirrors app/api/signup/failure-beacon). Anti-abuse: strict per-IP burst cap
// (public, unauthenticated), a hard body cap, and an allowlist clamp on the
// metadata (lib/quizStart.sanitizeQuizStartMetadata). There is deliberately no
// Buyer link — at quiz start no Consumer exists yet.

import { NextResponse } from 'next/server';
import { rateLimitStrict, getTrustedClientIp } from '@/lib/rateLimit';
import { funnelRecord } from '@/lib/funnelMetrics';
import { QUIZ_START_STAGE, sanitizeQuizStartMetadata } from '@/lib/quizStart';

export const dynamic = 'force-dynamic';
export const maxDuration = 10;

const MAX_BODY_BYTES = 2048;

// The one response shape — a bodyless 204 whether we logged, dropped, or
// rate-limited. sendBeacon ignores the body anyway; a fixed status keeps this
// from being a probe oracle.
const NO_CONTENT = () => new NextResponse(null, { status: 204 });

export async function POST(request: Request) {
  try {
    // Strict per-IP cap FIRST (never fails open — in-memory fallback if Redis
    // is down). A real buyer fires this at most once per session; 10/min still
    // absorbs shared-NAT households while capping a spammer.
    const ip = getTrustedClientIp(request);
    const limit = await rateLimitStrict(`quiz-start-ip:${ip}`, { requests: 10 });
    if (!limit.ok) return NO_CONTENT();

    // Cap body size before parsing — the beacon payload is tiny.
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return NO_CONTENT();

    let body: unknown = {};
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        return NO_CONTENT();
      }
    }

    const metadata = sanitizeQuizStartMetadata(body);
    if (metadata === null) return NO_CONTENT();

    // funnelRecord is itself non-fatal (warn-and-continue), but await it so
    // the write actually flushes before the lambda freezes.
    await funnelRecord({
      stage: QUIZ_START_STAGE,
      metadata: { ...metadata, funnel: true },
    });

    return NO_CONTENT();
  } catch {
    // A beacon is fire-and-forget by design — never surface an error.
    return NO_CONTENT();
  }
}
