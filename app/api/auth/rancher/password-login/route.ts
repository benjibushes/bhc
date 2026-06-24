// POST /api/auth/rancher/password-login
//
// Public email + password login for ranchers. Runs ALONGSIDE the magic-link
// login (/api/auth/rancher/login) — same resulting session, just a second way
// to get it. Supabase Auth verifies the credential; the bhc-rancher-auth
// session cookie is then minted from the Airtable Rancher record EXACTLY like
// the magic-link verify route (/api/auth/rancher/verify), so a password login
// produces an identical session.
//
// HARD SECURITY RULES (all enforced below):
//  - Generic 401 {error:'Invalid email or password'} on EVERY failure path
//    (unknown email, no password set, wrong password, no rancher record). No
//    user enumeration — the response is byte-identical regardless of which
//    check failed.
//  - Rate-limited per-email AND per-IP (reuses lib/rateLimit).
//  - The plaintext password is never logged.
//  - 503 (build-dark) when Supabase env is unset; magic-link still works.

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';
import { getAllRecords, TABLES } from '@/lib/airtable';
import { getSupabaseAnon, isSupabaseAuthConfigured } from '@/lib/supabaseAuth';
import { rateLimit, getRequestIp } from '@/lib/rateLimit';
import { JWT_SECRET } from '@/lib/secrets';

export const maxDuration = 60;

const RANCHER_AUTH_COOKIE = 'bhc-rancher-auth';
// Single generic failure — identical for every auth-failure branch so the
// client (and an attacker) cannot distinguish "no such email" from "wrong
// password" from "no rancher record". No enumeration.
const GENERIC_AUTH_FAIL = { error: 'Invalid email or password' };

export async function POST(request: Request) {
  try {
    let parsedBody: any;
    try { parsedBody = await request.json(); } catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }); }
    const rawEmail = parsedBody?.email;
    const password = parsedBody?.password;

    if (typeof rawEmail !== 'string' || typeof password !== 'string' || !rawEmail || !password) {
      // Shape error (not a credential check) — still generic, no enumeration.
      return NextResponse.json(GENERIC_AUTH_FAIL, { status: 401 });
    }

    const normalizedEmail = rawEmail.trim().toLowerCase().replace(/\s+/g, '');

    // 1) Rate limit per-email + per-IP BEFORE touching Supabase/Airtable.
    //    Mirrors the magic-link login route's limits.
    const ip = getRequestIp(request);
    const emailLimit = await rateLimit(`pwlogin-rancher-email:${normalizedEmail}`, { requests: 5, window: '15m' });
    if (!emailLimit.ok) {
      return NextResponse.json(
        { error: 'Too many login attempts. Try again in 15 minutes.' },
        { status: 429 },
      );
    }
    const ipLimit = await rateLimit(`pwlogin-rancher-ip:${ip}`, { requests: 20, window: '1h' });
    if (!ipLimit.ok) {
      return NextResponse.json(
        { error: 'Too many login attempts from this network. Try again in an hour.' },
        { status: 429 },
      );
    }

    // 2) Build-dark guard — no Supabase, no password login (magic-link still works).
    if (!isSupabaseAuthConfigured()) {
      return NextResponse.json(
        { error: 'Password login is not available yet. Use the email login link.' },
        { status: 503 },
      );
    }
    const anon = getSupabaseAnon();
    if (!anon) {
      return NextResponse.json(
        { error: 'Password login is not available yet. Use the email login link.' },
        { status: 503 },
      );
    }

    // 3) Verify the credential against Supabase Auth. Any error (unknown user,
    //    wrong password, unconfirmed) → generic 401. Password never logged.
    const { data: signIn, error: signInErr } = await anon.auth.signInWithPassword({
      email: normalizedEmail,
      password,
    });
    if (signInErr || !signIn?.user) {
      return NextResponse.json(GENERIC_AUTH_FAIL, { status: 401 });
    }

    // 4) Credential is valid — but the session must be backed by a real
    //    Rancher record. Look it up the SAME way the magic-link login route
    //    does (Email + Team Emails, trimmed/lowercased, most-recently-active
    //    tiebreak). No record → generic 401 (no enumeration).
    const rancher = await findRancherByEmail(normalizedEmail);
    if (!rancher) {
      return NextResponse.json(GENERIC_AUTH_FAIL, { status: 401 });
    }

    // Block deactivated ranchers — same rule as the magic-link verify route.
    const activeStatus = String(rancher['Active Status'] || '').toLowerCase();
    if (activeStatus === 'non-compliant') {
      return NextResponse.json(
        { error: 'Your account has been deactivated for compliance reasons. Contact hello@buyhalfcow.com.' },
        { status: 403 },
      );
    }

    // 5) Mint the bhc-rancher-auth session cookie — IDENTICAL to the magic-link
    //    verify route (same payload off the rancher record, same name/options/
    //    expiry) so password login yields the same session as a magic link.
    const sessionToken = jwt.sign(
      {
        type: 'rancher-session',
        rancherId: rancher.id,
        email: normalizedEmail,
        name: rancher['Operator Name'] || rancher['Ranch Name'] || '',
        ranchName: rancher['Ranch Name'] || '',
        state: rancher['State'] || '',
      },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    const cookieStore = await cookies();
    cookieStore.set(RANCHER_AUTH_COOKIE, sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 30,
      path: '/',
    });

    console.log(`[rancher-password-login] success rancher=${rancher.id}`);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    // Never echo error.message (could leak detail). Never log the password.
    console.error('[rancher-password-login] error:', error?.name || 'unknown');
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}

/**
 * Resolve a Rancher record by email — direct {Email} match first, then
 * {Team Emails}. Both branches collect ALL matches and pick the
 * most-recently-active one (latest of Last Assigned At / Agreement Signed At /
 * Docs Sent At / _createdTime), exactly like /api/auth/rancher/login so the
 * password session lands on the same canonical row a magic link would.
 */
async function findRancherByEmail(normalizedEmail: string): Promise<any | null> {
  const all = await getAllRecords(TABLES.RANCHERS) as any[];
  const splitRe = /[\s,;\n]+/;
  const recencyMs = (r: any): number => {
    const candidates = [
      r['Last Assigned At'],
      r['Agreement Signed At'],
      r['Docs Sent At'],
      r._createdTime,
    ].map((d) => (d ? new Date(d).getTime() : 0));
    return Math.max(...candidates, 0);
  };

  const emailMatches = all.filter((r) => {
    const stored = String(r['Email'] || '').trim().toLowerCase().replace(/\s+/g, '');
    return stored && stored === normalizedEmail;
  });
  if (emailMatches.length === 1) return emailMatches[0];
  if (emailMatches.length > 1) {
    emailMatches.sort((a, b) => recencyMs(b) - recencyMs(a));
    return emailMatches[0];
  }

  const teamMatches: any[] = [];
  for (const r of all) {
    const teamRaw = String(r['Team Emails'] || '').toLowerCase();
    if (!teamRaw) continue;
    const list = teamRaw.split(splitRe).map((s) => s.trim()).filter(Boolean);
    if (list.includes(normalizedEmail)) teamMatches.push(r);
  }
  if (teamMatches.length === 1) return teamMatches[0];
  if (teamMatches.length > 1) {
    teamMatches.sort((a, b) => recencyMs(b) - recencyMs(a));
    return teamMatches[0];
  }

  return null;
}
