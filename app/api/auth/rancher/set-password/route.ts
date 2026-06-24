// POST /api/auth/rancher/set-password
//
// Lets a rancher who is ALREADY logged in (magic-link session) set or change
// a password for next time. The password is stored ONLY in Supabase Auth,
// which hashes + salts it — we never log or persist the plaintext.
//
// SECURITY:
//  - Requires an authed rancher session (requireRancher). The email is taken
//    from the SESSION, never from the request body, so a rancher can only set
//    a password for their own account.
//  - Minimum length 8.
//  - 503 (not 500) when Supabase env is unset — build-dark; magic-link login
//    keeps working regardless.
//  - The password value is never written to any log line.

import { NextResponse } from 'next/server';
import { requireRancher } from '@/lib/rancherAuth';
import { getSupabaseAdmin, isSupabaseAuthConfigured } from '@/lib/supabaseAuth';

export const maxDuration = 30;

export async function POST(request: Request) {
  try {
    // 1) Must be an authed rancher. Email comes from the verified session.
    const auth = await requireRancher(request);
    if (auth instanceof NextResponse) return auth;
    const { session } = auth;

    const email = String(session.email || '').trim().toLowerCase();
    if (!email) {
      // Session with no email claim can't own a Supabase Auth user.
      return NextResponse.json({ error: 'Session is missing an email.' }, { status: 400 });
    }

    // 2) Build-dark guard. Password storage requires Supabase configured.
    if (!isSupabaseAuthConfigured()) {
      return NextResponse.json(
        { error: 'Password login is not available yet. Use the email login link.' },
        { status: 503 },
      );
    }
    const admin = getSupabaseAdmin();
    if (!admin) {
      return NextResponse.json(
        { error: 'Password login is not available yet. Use the email login link.' },
        { status: 503 },
      );
    }

    // 3) Validate the password. Min length 8. (Never logged.)
    let parsedBody: any;
    try { parsedBody = await request.json(); } catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }); }
    const password = parsedBody?.password;
    if (typeof password !== 'string' || password.length < 8) {
      return NextResponse.json(
        { error: 'Password must be at least 8 characters.' },
        { status: 400 },
      );
    }

    // 4) Upsert the Supabase Auth user. Try create first (email_confirm so the
    //    rancher can sign in immediately — no Supabase confirmation email).
    const { error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (createErr) {
      // Most likely the user already exists. Find their id and update the
      // password instead. We page through listUsers and match on email —
      // the JS SDK has no getUserByEmail, so this is the supported path.
      const existingId = await findSupabaseUserIdByEmail(admin, email);
      if (!existingId) {
        // Genuine create failure that wasn't "already registered" — surface
        // a generic error (no Supabase internals leaked to the client).
        console.error('[rancher-set-password] createUser failed and no existing user found');
        return NextResponse.json({ error: 'Could not set password. Please try again.' }, { status: 500 });
      }
      const { error: updateErr } = await admin.auth.admin.updateUserById(existingId, { password });
      if (updateErr) {
        console.error('[rancher-set-password] updateUserById failed');
        return NextResponse.json({ error: 'Could not set password. Please try again.' }, { status: 500 });
      }
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    // Deliberately do NOT echo error.message — could contain request detail.
    console.error('[rancher-set-password] error:', error?.name || 'unknown');
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}

/**
 * Locate a Supabase Auth user id by email. The admin SDK exposes only
 * listUsers (paginated), so we page until we find a case-insensitive email
 * match or run out of pages. Bounded to 20 pages (20k users) as a safety cap.
 */
async function findSupabaseUserIdByEmail(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  email: string,
): Promise<string | null> {
  const target = email.trim().toLowerCase();
  const perPage = 1000;
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error || !data) return null;
    const match = data.users.find(
      (u) => String(u.email || '').trim().toLowerCase() === target,
    );
    if (match) return match.id;
    if (data.users.length < perPage) break; // last page
  }
  return null;
}
