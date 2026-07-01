import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getRecordById } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import jwt from 'jsonwebtoken';
import { verifyJwtWithFallback } from '@/lib/jwt';
// Open-redirect defense for the ?next= param (validator + full rationale
// live in lib/safeNextPath.ts — extracted so the login route and the
// /member/verify page validate with the SAME rules; tested in
// lib/__auth_tests__/safeNextPath.test.ts).
import { safeNextPath } from '@/lib/safeNextPath';

import { JWT_SECRET } from '@/lib/secrets';
const MEMBER_AUTH_COOKIE = 'bhc-member-auth';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

export async function POST(request: Request) {
  try {
    let parsedBody: any;
    try { parsedBody = await request.json(); } catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }); }
    const { token } = parsedBody;

    if (!token) {
      return NextResponse.json({ error: 'Token is required' }, { status: 400 });
    }

    let decoded: any;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch {
      return NextResponse.json({ error: 'Invalid or expired link. Please request a new one.' }, { status: 401 });
    }

    if (decoded.type !== 'member-login') {
      return NextResponse.json({ error: 'Invalid token type' }, { status: 401 });
    }

    const consumer = await getRecordById(TABLES.CONSUMERS, decoded.consumerId) as any;
    if (!consumer) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    const status = (consumer['Status'] || '').toLowerCase();
    const LOGIN_ALLOWED = ['approved', 'active', 'waitlisted'];
    if (!LOGIN_ALLOWED.includes(status)) {
      return NextResponse.json({ error: 'Your account is not yet approved. Please wait for admin review.' }, { status: 403 });
    }

    const sessionToken = jwt.sign(
      {
        type: 'member-session',
        consumerId: consumer.id,
        email: decoded.email,
        name: consumer['Full Name'] || '',
        state: consumer['State'] || '',
      },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    const cookieStore = await cookies();
    cookieStore.set(MEMBER_AUTH_COOKIE, sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 30, // 30 days
      path: '/',
    });

    return NextResponse.json({
      success: true,
      member: {
        id: consumer.id,
        name: consumer['Full Name'] || '',
        email: decoded.email,
        state: consumer['State'] || '',
      },
    });
  } catch (error: any) {
    console.error('Member verify error:', error);
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}

// GET — magic-link flow. The buyer intro email embeds a URL like
// `/api/auth/member/verify?token=<jwt>&next=/checkout/<refId>/deposit`. This
// handler verifies the token, sets the bhc-member-auth cookie, then 302s the
// browser to `next` (validated to be a same-origin relative path). Buyer
// arrives at the deposit page already authed — no separate login step.
//
// Status codes follow the redirect convention: every terminal state is a 302
// to a human-facing page, never a JSON error (the browser is the only caller).
//
// Token failures land on /member/login?reason=expired-link (the login page
// reads `reason` and shows "Your link expired — request a new one").
// Status failures land on /access?reason=not-approved (the gated waitlist
// page). All redirects use absolute URLs so the cookie set on the response
// applies cleanly to the redirected GET.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  const next = url.searchParams.get('next');
  const safeNext = safeNextPath(next);

  // Resolve redirect base — prefer the request origin (Vercel preview deploys
  // each have a unique alias; SITE_URL is the prod one). Falls back to
  // SITE_URL when the request origin can't be parsed.
  let redirectBase: string;
  try {
    redirectBase = new URL(request.url).origin;
  } catch {
    redirectBase = SITE_URL;
  }

  if (!token) {
    return NextResponse.redirect(`${redirectBase}/member/login?reason=expired-link`, 302);
  }
  // Bound the token length. jwt.verify on a multi-kilobyte payload still
  // costs CPU; capping pre-verify prevents trivial DoS via a malicious URL.
  // Standard JWTs are <1KB; 4KB is generous.
  if (token.length > 4096) {
    return NextResponse.redirect(`${redirectBase}/member/login?reason=expired-link`, 302);
  }

  let decoded: any;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch {
    return NextResponse.redirect(`${redirectBase}/member/login?reason=expired-link`, 302);
  }

  if (decoded.type !== 'member-login') {
    return NextResponse.redirect(`${redirectBase}/member/login?reason=expired-link`, 302);
  }

  let consumer: any;
  try {
    consumer = await getRecordById(TABLES.CONSUMERS, decoded.consumerId);
  } catch {
    return NextResponse.redirect(`${redirectBase}/member/login?reason=expired-link`, 302);
  }
  if (!consumer) {
    return NextResponse.redirect(`${redirectBase}/member/login?reason=expired-link`, 302);
  }

  const status = (consumer['Status'] || '').toLowerCase();
  const LOGIN_ALLOWED = ['approved', 'active', 'waitlisted'];
  if (!LOGIN_ALLOWED.includes(status)) {
    return NextResponse.redirect(`${redirectBase}/access?reason=not-approved`, 302);
  }

  // Mirror POST handler's session token shape EXACTLY — same payload fields,
  // same expiry, same secret. Any drift here means the cookie set by GET
  // won't decode correctly downstream where /member/* routes check it.
  const sessionToken = jwt.sign(
    {
      type: 'member-session',
      consumerId: consumer.id,
      email: decoded.email,
      name: consumer['Full Name'] || '',
      state: consumer['State'] || '',
    },
    JWT_SECRET,
    { expiresIn: '30d' }
  );

  const cookieStore = await cookies();
  cookieStore.set(MEMBER_AUTH_COOKIE, sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 30, // 30 days
    path: '/',
  });

  return NextResponse.redirect(`${redirectBase}${safeNext}`, 302);
}
