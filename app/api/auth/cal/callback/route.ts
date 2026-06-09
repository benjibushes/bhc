import { NextResponse } from 'next/server';
import {
  verifyState,
  exchangeAuthorizationCode,
  persistRancherTokens,
  getCalMe,
} from '@/lib/cal';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { getRecordById, TABLES } from '@/lib/airtable';

// GET /api/auth/cal/callback
//
// Cal redirects here after a rancher approves (or denies) our OAuth
// authorization request. Two paths:
//
//   1. Success: ?code=<authorization_code>&state=<jwt>
//      → verify state JWT (we signed it in /start with the rancherId)
//      → exchange code for tokens
//      → fetch Cal user profile (for Cal User ID stamp)
//      → persist all three tokens + user id on the Rancher row
//      → redirect to /rancher/setup?token=... (resume wizard mid-flow)
//
//   2. Denial / error: ?error=...&error_description=...
//      → log, Telegram alert, redirect to wizard with ?cal_error=1
//
// Notes:
// - State is a 10-min JWT containing only rancherId. If it's been
//   tampered with or expired, we refuse — caller has to restart.
// - Token refresh + auto-rotation lives in lib/cal.ts callCalApi(). This
//   route only handles the INITIAL exchange.
// - Cal-side OAuth client may still be in "pending" state while admin
//   reviews. The exchange will work for our own (the owner's) authorization
//   even before approval; other users get blocked. Telegram alert flags it.

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code') || '';
  const state = url.searchParams.get('state') || '';
  const errorParam = url.searchParams.get('error') || '';
  const errorDescription = url.searchParams.get('error_description') || '';

  // ─── Denial / Cal-side error ────────────────────────────────────────
  if (errorParam) {
    console.warn('[auth/cal/callback] OAuth denied/error:', errorParam, errorDescription);
    try {
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `⚠️ <b>Cal OAuth denied/error</b>\n\n` +
          `error: ${errorParam}\n` +
          `description: ${errorDescription || '(none)'}\n\n` +
          `<i>Rancher cancelled, or Cal returned an OAuth-level error before token exchange.</i>`,
      );
    } catch {}
    return NextResponse.redirect(`${SITE_URL}/rancher?cal_error=${encodeURIComponent(errorParam)}`);
  }

  // ─── Missing required params ────────────────────────────────────────
  if (!code || !state) {
    return NextResponse.json({ error: 'Missing code or state' }, { status: 400 });
  }

  // ─── Verify state (prevents CSRF + tells us which rancher) ──────────
  const parsedState = verifyState(state);
  if (!parsedState) {
    console.warn('[auth/cal/callback] State verify failed — tamper or expiry');
    return NextResponse.json({ error: 'Invalid or expired state' }, { status: 401 });
  }
  const { rancherId } = parsedState;

  // ─── Exchange code → tokens ─────────────────────────────────────────
  let tokens;
  try {
    tokens = await exchangeAuthorizationCode(code);
  } catch (e: any) {
    console.error('[auth/cal/callback] Token exchange failed:', e?.message);
    try {
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `❌ <b>Cal token exchange failed</b>\n\n` +
          `Rancher: ${rancherId}\n` +
          `Error: ${e?.message || 'unknown'}\n\n` +
          `<i>Check CAL_OAUTH_CLIENT_ID + CAL_OAUTH_CLIENT_SECRET in Vercel env. Cal client may still be pending admin approval.</i>`,
      );
    } catch {}
    return NextResponse.redirect(`${SITE_URL}/rancher?cal_error=exchange_failed`);
  }

  // ─── Pull Cal user info so we can stamp Cal User ID ────────────────
  let calUserId: number | undefined;
  let calUsername = '';
  try {
    const me = await getCalMe(tokens.access_token);
    // Cal v2 /me shape: { status, data: { user: { id, username, email, ... } } }
    const userData = me?.data?.user || me?.user || me;
    calUserId = typeof userData?.id === 'number' ? userData.id : undefined;
    calUsername = userData?.username || '';
  } catch (e: any) {
    console.warn('[auth/cal/callback] getCalMe failed (non-fatal):', e?.message);
  }

  // ─── Persist tokens on the Rancher row ──────────────────────────────
  try {
    await persistRancherTokens(rancherId, tokens, { calUserId });
  } catch (e: any) {
    console.error('[auth/cal/callback] persist tokens failed:', e?.message);
    return NextResponse.redirect(`${SITE_URL}/rancher?cal_error=persist_failed`);
  }

  // ─── Telegram success alert ─────────────────────────────────────────
  try {
    const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);
    const name = rancher?.['Operator Name'] || rancher?.['Ranch Name'] || rancherId;
    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      `✅ <b>Cal connected</b>\n\n` +
        `🤠 ${name}\n` +
        (calUsername ? `🗓 cal.com/${calUsername}\n` : '') +
        (calUserId ? `Cal user id: ${calUserId}\n` : '') +
        `Scopes: ${tokens.scope}\n\n` +
        `<i>Tokens persisted. Next step: programmatically create their event type + webhook.</i>`,
    );
  } catch {}

  // ─── Send rancher back to dashboard with success flag ──────────────
  return NextResponse.redirect(`${SITE_URL}/rancher?cal_connected=1`);
}
