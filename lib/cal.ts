// lib/cal.ts
//
// Cal.com OAuth + API wrapper. Single source of truth for talking to Cal
// on behalf of an authenticated rancher.
//
// Flow:
//   1. Rancher hits "Connect Cal" in wizard → server mints OAuth URL via
//      buildAuthorizationUrl() with `state` containing the rancherId
//      (signed) so the callback can re-identify them.
//   2. Rancher approves → Cal redirects to /api/auth/cal/callback?code=...
//   3. Callback exchanges code for access + refresh tokens via
//      exchangeAuthorizationCode(), then persists them on the Rancher row.
//   4. Any subsequent Cal API call goes through callCalApi() which
//      auto-refreshes on 401 + restamps the new tokens.
//
// Token storage: Airtable fields on Ranchers table —
//   - "Cal OAuth Access Token"     (string, encrypted at rest)
//   - "Cal OAuth Refresh Token"    (string, encrypted at rest)
//   - "Cal Token Expires At"       (ISO date)
//   - "Cal User ID"                (number — pulled from /v2/me)
//
// Why a wrapper instead of using fetch inline at every callsite: token
// refresh + secret reads + base URL handling shouldn't live next to
// business logic in 12 different routes. One bug in one place = silent
// breakage everywhere.

import jwt from 'jsonwebtoken';
import { JWT_SECRET } from './secrets';
import { updateRecord, TABLES } from './airtable';

const CAL_OAUTH_AUTHORIZE_URL = 'https://app.cal.com/auth/oauth2/authorize';
const CAL_OAUTH_TOKEN_URL = 'https://api.cal.com/v2/auth/oauth2/token';
const CAL_API_BASE = 'https://api.cal.com/v2';
const CAL_API_VERSION = '2024-08-13';

const CAL_OAUTH_CLIENT_ID = process.env.CAL_OAUTH_CLIENT_ID || '';
const CAL_OAUTH_CLIENT_SECRET = process.env.CAL_OAUTH_CLIENT_SECRET || '';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';
const REDIRECT_URI = `${SITE_URL}/api/auth/cal/callback`;

// Scopes — matches what we registered the OAuth client with on Cal.
// If you add a new scope here, you also need to enable it in the Cal
// OAuth client settings + re-prompt the user to re-authorize.
const SCOPES = [
  'EVENT_TYPE_READ',
  'EVENT_TYPE_WRITE',
  'BOOKING_READ',
  'BOOKING_WRITE',
  'SCHEDULE_READ',
  'SCHEDULE_WRITE',
  'APPS_READ',
  'APPS_WRITE',
  'PROFILE_READ',
  'PROFILE_WRITE',
  'WEBHOOK_READ',
  'WEBHOOK_WRITE',
  'VERIFIED_RESOURCES_READ',
  'VERIFIED_RESOURCES_WRITE',
] as const;

export interface CalTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;        // seconds
  token_type: 'bearer';
  scope: string;             // space-separated granted scopes
}

export interface CalStatePayload {
  rancherId: string;
  // Add anything else you want round-tripped through Cal — but keep it
  // small. The state param has length limits in some OAuth clients.
}

/**
 * Build the Cal.com OAuth authorization URL. Rancher gets redirected here
 * from "Connect Cal" CTA. `state` is a signed JWT so the callback can't be
 * spoofed — verify it with verifyState() before trusting the rancherId.
 */
export function buildAuthorizationUrl(payload: CalStatePayload): string {
  if (!CAL_OAUTH_CLIENT_ID) {
    throw new Error('CAL_OAUTH_CLIENT_ID env not set');
  }
  const state = jwt.sign(payload, JWT_SECRET, { expiresIn: '10m' });
  const params = new URLSearchParams({
    client_id: CAL_OAUTH_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    state,
    scope: SCOPES.join(' '),
  });
  return `${CAL_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Verify + decode the state JWT round-tripped from Cal. Returns null on
 * tamper / expiry / signature mismatch. Callback MUST treat null as
 * authorization failure — don't fall through.
 */
export function verifyState(state: string): CalStatePayload | null {
  if (!state) return null;
  try {
    const decoded: any = jwt.verify(state, JWT_SECRET);
    if (!decoded || typeof decoded.rancherId !== 'string') return null;
    return { rancherId: decoded.rancherId };
  } catch {
    return null;
  }
}

/**
 * Exchange an authorization code for access + refresh tokens. Throws on
 * Cal API error — caller should surface a friendly "couldn't connect Cal,
 * try again" message + Telegram alert.
 */
export async function exchangeAuthorizationCode(code: string): Promise<CalTokens> {
  if (!CAL_OAUTH_CLIENT_ID || !CAL_OAUTH_CLIENT_SECRET) {
    throw new Error('Cal OAuth env vars not set');
  }
  const res = await fetch(CAL_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CAL_OAUTH_CLIENT_ID,
      client_secret: CAL_OAUTH_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = JSON.stringify(await res.json()); } catch {}
    throw new Error(`Cal token exchange failed (${res.status}): ${detail}`);
  }
  return (await res.json()) as CalTokens;
}

/**
 * Refresh an expired access token. Returns fresh tokens (Cal rotates the
 * refresh token on every call — store both).
 */
export async function refreshAccessToken(refreshToken: string): Promise<CalTokens> {
  if (!CAL_OAUTH_CLIENT_ID || !CAL_OAUTH_CLIENT_SECRET) {
    throw new Error('Cal OAuth env vars not set');
  }
  const res = await fetch(CAL_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CAL_OAUTH_CLIENT_ID,
      client_secret: CAL_OAUTH_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = JSON.stringify(await res.json()); } catch {}
    throw new Error(`Cal refresh failed (${res.status}): ${detail}`);
  }
  return (await res.json()) as CalTokens;
}

/**
 * Persist Cal tokens on a Rancher row. Computes Expires At from
 * `expires_in` (Cal returns seconds) so the next caller can decide
 * whether to refresh proactively before hitting a 401.
 */
export async function persistRancherTokens(
  rancherId: string,
  tokens: CalTokens,
  opts: { calUserId?: number } = {},
): Promise<void> {
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
  const fields: Record<string, any> = {
    'Cal OAuth Access Token': tokens.access_token,
    'Cal OAuth Refresh Token': tokens.refresh_token,
    'Cal Token Expires At': expiresAt,
  };
  if (opts.calUserId !== undefined) fields['Cal User ID'] = opts.calUserId;
  await updateRecord(TABLES.RANCHERS, rancherId, fields);
}

/**
 * Get the current Cal user (the rancher) using the access token. Useful
 * after a fresh OAuth completes — pull their Cal user ID + username to
 * persist alongside the tokens.
 */
export async function getCalMe(accessToken: string): Promise<any> {
  const res = await fetch(`${CAL_API_BASE}/me`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'cal-api-version': CAL_API_VERSION,
    },
  });
  if (!res.ok) {
    let detail = '';
    try { detail = JSON.stringify(await res.json()); } catch {}
    throw new Error(`Cal /me failed (${res.status}): ${detail}`);
  }
  return await res.json();
}

/**
 * Generic Cal API call with auto-refresh on 401. Caller passes the
 * Rancher row (with current tokens) so on refresh we can restamp the
 * new pair. If the refresh also fails (refresh_token revoked / expired
 * / Cal-side issue) — throws so the caller can surface a re-authorize CTA.
 */
export async function callCalApi(opts: {
  rancher: any;                 // Airtable Rancher record (must have Cal token fields)
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;                 // e.g. '/event-types'
  body?: unknown;
}): Promise<any> {
  let accessToken = String(opts.rancher['Cal OAuth Access Token'] || '');
  const refreshToken = String(opts.rancher['Cal OAuth Refresh Token'] || '');
  const rancherId: string = opts.rancher.id;
  if (!accessToken || !refreshToken) {
    throw new Error(`Rancher ${rancherId} has no Cal tokens — re-authorize required`);
  }

  const doFetch = async (token: string) =>
    fetch(`${CAL_API_BASE}${opts.path}`, {
      method: opts.method,
      headers: {
        Authorization: `Bearer ${token}`,
        'cal-api-version': CAL_API_VERSION,
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });

  let res = await doFetch(accessToken);
  if (res.status === 401) {
    // Token expired — refresh + retry once. If refresh fails, surface so
    // the caller can re-authorize the rancher.
    const fresh = await refreshAccessToken(refreshToken);
    await persistRancherTokens(rancherId, fresh);
    accessToken = fresh.access_token;
    res = await doFetch(accessToken);
  }
  if (!res.ok) {
    let detail = '';
    try { detail = JSON.stringify(await res.json()); } catch {}
    throw new Error(`Cal API ${opts.method} ${opts.path} failed (${res.status}): ${detail}`);
  }
  // Some endpoints return empty body (e.g. DELETE) — guard parse.
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}
