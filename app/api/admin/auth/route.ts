import { NextResponse } from 'next/server';

// Auth Phase 0 — legacy admin auth endpoint is retired.
//
// Browser admins now sign in via Clerk at /admin/login (TOTP 2FA + email
// allowlist). Server-to-server callers continue to use the x-admin-password
// HTTP header against the actual admin endpoints — they never hit this route.
//
// Kept here as 410 Gone for ~30 days so any cached frontend code gets a
// clear migration signal in logs / Sentry. Removal target: 2026-06-25
// (30 days post-merge). After removal the route can be deleted entirely.

const RESPONSE_BODY = {
  error: 'Endpoint removed',
  message:
    'Admin auth migrated to Clerk. Browser admins: sign in at /admin/login. ' +
    'Server-to-server callers: continue to use the x-admin-password header ' +
    'against the actual admin endpoint (e.g. POST /api/admin/refresh-cache).',
  redirect: '/admin/login',
} as const;

function gone() {
  return NextResponse.json(RESPONSE_BODY, { status: 410 });
}

export async function GET() {
  return gone();
}

export async function POST() {
  return gone();
}

export async function DELETE() {
  return gone();
}
