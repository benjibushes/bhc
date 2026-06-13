import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getRecordById } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import jwt from 'jsonwebtoken';

import { JWT_SECRET } from '@/lib/secrets';
const RANCHER_AUTH_COOKIE = 'bhc-rancher-auth';

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

    if (decoded.type !== 'rancher-login') {
      return NextResponse.json({ error: 'Invalid token type' }, { status: 401 });
    }

    const rancher = await getRecordById(TABLES.RANCHERS, decoded.rancherId) as any;
    if (!rancher) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    // Block login for ranchers who've been explicitly deactivated. Allowed
    // statuses (per schema): Active, At Capacity, Paused, Pending Onboarding,
    // Non-Compliant. Only Non-Compliant should block login outright (they're
    // being removed for cause). Paused is self-service vacation mode — still
    // let them log in so they can resume themselves.
    const activeStatus = (rancher['Active Status'] || '').toLowerCase();
    if (activeStatus === 'non-compliant') {
      return NextResponse.json({ error: 'Your account has been deactivated for compliance reasons. Contact hello@buyhalfcow.com.' }, { status: 403 });
    }

    // Re-validate token's email claim against current record. If the
    // rancher's email was changed since the token was minted, the old
    // token shouldn't grant access. Audit finding 2026-05-20 #46.
    const tokenEmail = String(decoded.email || '').trim().toLowerCase();
    const currentEmail = String(rancher['Email'] || '').trim().toLowerCase();
    if (tokenEmail && currentEmail && tokenEmail !== currentEmail) {
      // Check Team Emails too — token may have been minted for a teammate
      // who's still authorized.
      const teamEmails = String(rancher['Team Emails'] || '')
        .split(/[\n,]/)
        .map(e => e.trim().toLowerCase())
        .filter(Boolean);
      if (!teamEmails.includes(tokenEmail)) {
        return NextResponse.json({ error: 'Token no longer valid — email changed. Request a new login link.' }, { status: 401 });
      }
    }

    const sessionToken = jwt.sign(
      {
        type: 'rancher-session',
        rancherId: rancher.id,
        email: decoded.email,
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

    return NextResponse.json({
      success: true,
      rancher: {
        id: rancher.id,
        name: rancher['Operator Name'] || '',
        ranchName: rancher['Ranch Name'] || '',
        email: decoded.email,
        state: rancher['State'] || '',
      },
    });
  } catch (error: any) {
    console.error('Rancher verify error:', error);
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}
