import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import crypto from 'crypto';
import { ADMIN_PASSWORD } from '@/lib/secrets';

const AUTH_TOKEN = 'bhc-admin-auth';

// In-memory rate limiter: max 5 failed POSTs per IP per 15min.
// Solo-operator scale is fine; lives in process memory and resets on deploy.
// Audit fix (C-2): admin/auth POST had ZERO rate limit — brute-force open
// with refund power behind a single password.
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX_FAILS = 5;
const failedAttempts = new Map<string, number[]>();

function getClientIp(request: Request): string {
  // Vercel sets x-forwarded-for; fall back to x-real-ip; last resort unknown.
  const fwd = request.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return request.headers.get('x-real-ip') || 'unknown';
}

function pruneAndCount(ip: string): number {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const arr = (failedAttempts.get(ip) || []).filter((t) => t > cutoff);
  failedAttempts.set(ip, arr);
  return arr.length;
}

function recordFailure(ip: string): number {
  const arr = failedAttempts.get(ip) || [];
  arr.push(Date.now());
  failedAttempts.set(ip, arr);
  return pruneAndCount(ip);
}

function clearFailures(ip: string): void {
  failedAttempts.delete(ip);
}

// Constant-time string compare. Wraps crypto.timingSafeEqual w/ length-mismatch
// fallback (timingSafeEqual throws on differing lengths). Pads to fixed length
// so the comparison itself is always constant time.
function safeEqual(a: string | undefined | null, b: string | undefined | null): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  // Pad shorter buffer to longer length so both buffers compare in constant time.
  const maxLen = Math.max(aBuf.length, bBuf.length, 1);
  const aPad = Buffer.alloc(maxLen);
  const bPad = Buffer.alloc(maxLen);
  aBuf.copy(aPad);
  bBuf.copy(bPad);
  // Still need a length match check — but do it AFTER constant-time compare
  // so attacker can't time the length-check itself.
  const eq = crypto.timingSafeEqual(aPad, bPad);
  return eq && aBuf.length === bBuf.length;
}

export async function POST(request: Request) {
  const ip = getClientIp(request);

  // Rate-limit check BEFORE password compare so failed attempts don't even
  // hit the constant-time compare path (cost optimization + DoS resistance).
  const recentFails = pruneAndCount(ip);
  if (recentFails >= RATE_LIMIT_MAX_FAILS) {
    return NextResponse.json(
      { error: 'Too many failed attempts. Try again later.' },
      { status: 429, headers: { 'Retry-After': String(RATE_LIMIT_WINDOW_MS / 1000) } },
    );
  }

  try {
    let parsedBody: any;
    try {
      parsedBody = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const { password } = parsedBody;

    if (safeEqual(password, ADMIN_PASSWORD)) {
      // Successful login → clear failure counter for this IP.
      clearFailures(ip);
      // Set secure HTTP-only cookie (expires in 7 days)
      const cookieStore = await cookies();
      cookieStore.set(AUTH_TOKEN, 'authenticated', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 7, // 7 days
        path: '/',
      });

      return NextResponse.json({ success: true });
    }

    // Record failure + return 401.
    const newCount = recordFailure(ip);
    if (newCount >= RATE_LIMIT_MAX_FAILS) {
      return NextResponse.json(
        { error: 'Too many failed attempts. Try again later.' },
        { status: 429, headers: { 'Retry-After': String(RATE_LIMIT_WINDOW_MS / 1000) } },
      );
    }
    return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
  } catch (error) {
    console.error('Admin auth error:', error);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}

export async function GET() {
  try {
    const cookieStore = await cookies();
    const authCookie = cookieStore.get(AUTH_TOKEN);

    if (authCookie?.value === 'authenticated') {
      return NextResponse.json({ authenticated: true });
    }

    return NextResponse.json({ authenticated: false }, { status: 401 });
  } catch (error) {
    console.error('Admin auth check error:', error);
    return NextResponse.json({ authenticated: false }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const cookieStore = await cookies();
    cookieStore.delete(AUTH_TOKEN);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Admin logout error:', error);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
