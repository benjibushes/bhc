// POST /api/signup/failure-beacon
//
// Failed-submit beacon (Justin incident 2026-07-23). The signup clients
// (ApplyForm / AddRancherForm) fire navigator.sendBeacon() here on ANY non-2xx
// response, thrown error, network abort, or client-side timeout — BEFORE they
// render the error, and even as the page tears down. We turn that report into a
// Signup Attempts row so a door failure that wrote no Ranchers record still
// leaves a queryable trace (turning the pre-write "trace desert" into a trail).
//
// Fast + best-effort: ALWAYS 204, never blocks the client, never throws.
// Anti-abuse: strict per-IP burst cap (public, unauthenticated), a hard body
// cap, and email-required (a beacon with no email is noise — dropped). The IP
// is derived server-side; the client always sends ip:''.

import { NextResponse } from 'next/server';
import { rateLimitStrict, getTrustedClientIp } from '@/lib/rateLimit';
import {
  logSignupAttempt,
  outcomeFromReport,
  type SignupDoor,
} from '@/lib/signupAttempts';

export const dynamic = 'force-dynamic';
export const maxDuration = 10;

const MAX_BODY_BYTES = 4096;
const VALID_DOORS: SignupDoor[] = ['apply', 'self-submit'];

// The one response shape — a bodyless 204 whether we logged, dropped, or
// rate-limited. sendBeacon ignores the body anyway; a fixed status keeps this
// from being a probe oracle.
const NO_CONTENT = () => new NextResponse(null, { status: 204 });

export async function POST(request: Request) {
  try {
    // Strict per-IP cap FIRST (never fails open — in-memory fallback if Redis is
    // down). A beacon fires at most a couple times per real submission; 20/min
    // is generous for a human and still caps a spammer.
    const ip = getTrustedClientIp(request);
    const limit = await rateLimitStrict(`signup-beacon-ip:${ip}`, { requests: 20 });
    if (!limit.ok) return NO_CONTENT();

    // Cap body size before parsing — a beacon payload is tiny.
    const raw = await request.text();
    if (!raw || raw.length > MAX_BODY_BYTES) return NO_CONTENT();

    let body: any;
    try {
      body = JSON.parse(raw);
    } catch {
      return NO_CONTENT();
    }

    // Ignore email-less noise — without an email the row can't be tied to a
    // rancher for rescue, which is the whole point.
    const email = String(body?.email || '').trim();
    if (!email) return NO_CONTENT();

    const door: SignupDoor = VALID_DOORS.includes(body?.door) ? body.door : 'apply';

    // logSignupAttempt is fire-and-forget (never throws), but await it so the
    // write actually flushes before the lambda freezes.
    await logSignupAttempt({
      email: email.slice(0, 254),
      ranchName: String(body?.ranchName || '').slice(0, 200),
      state: String(body?.state || '').slice(0, 40),
      phone: String(body?.phone || '').slice(0, 40),
      ip, // server-derived; client sends ip:''
      door,
      outcome: outcomeFromReport(body?.status, body?.reason),
      reason: String(body?.reason || '').slice(0, 500),
    });

    return NO_CONTENT();
  } catch {
    // A beacon is fire-and-forget by design — never surface an error.
    return NO_CONTENT();
  }
}
