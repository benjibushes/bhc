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

// ─── High-level helpers for the BHC flow ──────────────────────────────
// These wrap callCalApi() with the specific shapes the rest of the app
// uses. If Cal adds/changes payload shape, ONE function changes here,
// not 12 call sites.

export interface CalEventTypePayload {
  lengthInMinutes: number;
  title: string;
  slug: string;
  description?: string;
  metadata?: Record<string, any>;
}

/**
 * Create an event type on the rancher's Cal account. The BHC standard is
 * to create two per rancher post-connect:
 *
 *   1. "intro-15" — 15-min buyer intro call. Default for non-Operator
 *      tiers. Lands on the rancher's calendar.
 *   2. "sales-30" — 30-min sales call. Reserved for Operator-tier
 *      ranchers where Ben handles the call but the slot lives on the
 *      rancher's calendar so the rancher sees it.
 *
 * Returns the created event type id — caller persists it on the Rancher
 * row so the embed widget can render the right slot type later.
 */
export async function createEventTypeForRancher(opts: {
  rancher: any;
  payload: CalEventTypePayload;
}): Promise<{ id: number; slug: string }> {
  const result = await callCalApi({
    rancher: opts.rancher,
    method: 'POST',
    path: '/event-types',
    body: opts.payload,
  });
  // Cal v2 shape: { status: "success", data: { id, slug, ... } }
  const data = result?.data || result;
  if (!data?.id) {
    throw new Error(`Cal createEventType returned no id: ${JSON.stringify(result)}`);
  }
  return { id: Number(data.id), slug: String(data.slug || opts.payload.slug) };
}

/**
 * Update an existing event type on the rancher's Cal account.
 * Use for syncing title/description/metadata changes from BHC UI.
 */
export async function updateEventType(opts: {
  rancher: any;
  eventTypeId: number;
  patch: Partial<CalEventTypePayload>;
}): Promise<any> {
  return callCalApi({
    rancher: opts.rancher,
    method: 'PATCH',
    path: `/event-types/${opts.eventTypeId}`,
    body: opts.patch,
  });
}

/**
 * Delete an event type — used during disconnect cleanup OR if rancher
 * manually nukes a slot type from BHC dashboard.
 */
export async function deleteEventType(opts: {
  rancher: any;
  eventTypeId: number;
}): Promise<void> {
  await callCalApi({
    rancher: opts.rancher,
    method: 'DELETE',
    path: `/event-types/${opts.eventTypeId}`,
  });
}

/**
 * Register a Cal webhook on this rancher's account so BHC gets booking
 * events (created/rescheduled/cancelled/meeting-ended) for any of their
 * slots. The handler already lives at /api/webhooks/cal — this just
 * subscribes the rancher's account to it.
 *
 * Returns the webhook id — persisted on Rancher row so we can delete it
 * on disconnect (avoid orphan webhooks that fire-and-403 forever).
 */
export async function registerCalWebhook(opts: {
  rancher: any;
  subscriberUrl: string;
  triggers?: Array<'BOOKING_CREATED' | 'BOOKING_RESCHEDULED' | 'BOOKING_CANCELLED' | 'MEETING_ENDED'>;
  secret?: string;
}): Promise<{ id: string }> {
  const triggers = opts.triggers ?? [
    'BOOKING_CREATED',
    'BOOKING_RESCHEDULED',
    'BOOKING_CANCELLED',
    'MEETING_ENDED',
  ];
  const result = await callCalApi({
    rancher: opts.rancher,
    method: 'POST',
    path: '/webhooks',
    body: {
      active: true,
      subscriberUrl: opts.subscriberUrl,
      triggers,
      secret: opts.secret,
      payloadTemplate: undefined,
    },
  });
  const data = result?.data || result;
  if (!data?.id) {
    throw new Error(`Cal createWebhook returned no id: ${JSON.stringify(result)}`);
  }
  return { id: String(data.id) };
}

/**
 * Delete a registered Cal webhook. Used during disconnect cleanup so we
 * don't leave orphan webhooks firing into a rancher account that no
 * longer authorizes us.
 */
export async function deleteCalWebhook(opts: {
  rancher: any;
  webhookId: string;
}): Promise<void> {
  await callCalApi({
    rancher: opts.rancher,
    method: 'DELETE',
    path: `/webhooks/${opts.webhookId}`,
  });
}

/**
 * List a rancher's recent bookings. Used by the dashboard "Bookings"
 * panel — pull live from Cal instead of relying on the webhook-mirror
 * for the source of truth.
 */
export async function listCalBookings(opts: {
  rancher: any;
  status?: 'upcoming' | 'past' | 'cancelled';
  take?: number;
}): Promise<any[]> {
  const params = new URLSearchParams();
  if (opts.status) params.set('status', opts.status);
  if (opts.take) params.set('take', String(opts.take));
  const qs = params.toString();
  const result = await callCalApi({
    rancher: opts.rancher,
    method: 'GET',
    path: `/bookings${qs ? `?${qs}` : ''}`,
  });
  const data = result?.data?.bookings || result?.bookings || result?.data || [];
  return Array.isArray(data) ? data : [];
}

/**
 * Check whether the rancher's Cal connection is currently usable. Returns
 * a structured result so the UI can render a precise state (connected /
 * expired / disconnected / error). The dashboard CTA cascades on this.
 */
export async function getCalConnectionStatus(rancher: any): Promise<
  | { state: 'connected'; expiresAt: string | null; calUserId: number | null; username: string | null }
  | { state: 'expired'; expiresAt: string | null }
  | { state: 'disconnected' }
  | { state: 'error'; reason: string }
> {
  const accessToken = String(rancher?.['Cal OAuth Access Token'] || '');
  const refreshToken = String(rancher?.['Cal OAuth Refresh Token'] || '');
  if (!accessToken && !refreshToken) return { state: 'disconnected' };

  const expiresAtRaw = String(rancher?.['Cal Token Expires At'] || '');
  const expiresAt = expiresAtRaw || null;
  const now = Date.now();
  const expiresAtMs = expiresAt ? new Date(expiresAt).getTime() : 0;

  if (expiresAt && expiresAtMs < now && !refreshToken) {
    return { state: 'expired', expiresAt };
  }

  try {
    // If we have a refresh token, callCalApi will silently refresh on
    // 401 — so probing /me is a true connectivity test.
    const me = await callCalApi({
      rancher,
      method: 'GET',
      path: '/me',
    });
    const userData = me?.data?.user || me?.user || me?.data || me;
    return {
      state: 'connected',
      expiresAt,
      calUserId: typeof userData?.id === 'number' ? userData.id : null,
      username: userData?.username || null,
    };
  } catch (e: any) {
    return { state: 'error', reason: e?.message || 'unknown' };
  }
}

/**
 * Clear all Cal tokens + ids from a Rancher row. Used by /disconnect and
 * by webhook handlers when Cal signals deauthorization. Doesn't delete
 * the rancher's Cal account — just our tokens for it.
 */
export async function clearRancherCalTokens(rancherId: string): Promise<void> {
  await updateRecord(TABLES.RANCHERS, rancherId, {
    'Cal OAuth Access Token': '',
    'Cal OAuth Refresh Token': '',
    'Cal Token Expires At': '',
    'Cal User ID': '',
    'Cal Username': '',
    'Cal Event Type Intro Id': '',
    'Cal Event Type Sales Id': '',
    'Cal Webhook Id': '',
  });
}
