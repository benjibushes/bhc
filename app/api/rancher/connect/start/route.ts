// app/api/rancher/connect/start/route.ts
//
// Stage-3 Task 7 — initiate Stripe Connect Express onboarding.
//
// Flow:
//   1. Auth check (rancher-session JWT)
//   2. If no Stripe Connect Account Id on rancher: create V2 account, persist
//      IMMEDIATELY (so refresh-mid-flow doesn't duplicate)
//   3. Create V2 account link → Stripe-hosted onboarding URL
//   4. Return { url } (POST) OR 302 redirect to it (GET) → continue flow
//
// Refresh URL points back to this same endpoint so abandoned mid-flow can
// resume. Stripe redirects with a GET when their account-link expires, so
// the GET handler always re-mints a FRESH account link and 302s the rancher
// straight into Stripe — no operator intervention, no 4xx, no "session
// expired" wall. This is the auto-recovery path for ranchers who received
// the magic onboarding link by email and clicked >24h later.
//
// CRITICAL: STRIPE_CONNECT_ENABLED env gate — refuses unless 'true'. Allows
// prod to ship this code with the flag off until canary (Task 16).

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { createConnectAccount, createOnboardingLink } from '@/lib/stripeConnect';
import { requireRancher } from '@/lib/rancherAuth';
import { JWT_SECRET } from '@/lib/secrets';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';
// Same cookie the magic-link verify flow + setup GET mint (lib/rancherAuth.ts).
const BHC_RANCHER_COOKIE = 'bhc-rancher-auth';

interface MintOptions {
  fromWizard: boolean;
  wizardToken: string;
}

/**
 * Verify a rancher-setup JWT (the wizard's 60-day link token) and return the
 * rancherId it vouches for, or null. This is the SAME trust the wizard itself
 * grants — /api/rancher/setup GET accepts this exact token and even mints the
 * session cookie from it — so honoring it here just extends that trust to the
 * Connect re-entry path. Without it, Stripe's refresh_url GET (fired when the
 * hosted account-link expires) 401'd any rancher whose cookie wasn't present:
 * mid-KYC return on ANOTHER DEVICE (admin migration tools text raw 24h Stripe
 * URLs) or a cleared cookie dead-ended at the login wall while a perfectly
 * valid wizardToken sat ignored in the query string.
 */
function verifySetupToken(token: string): string | null {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    if (decoded?.type !== 'rancher-setup' || !decoded.rancherId) return null;
    return String(decoded.rancherId);
  } catch {
    return null;
  }
}

/**
 * Shared mint path. Resolves rancher → ensures Connect account exists →
 * mints a fresh onboarding link. Returns either the URL (for POST callers
 * who want JSON) OR an error response. `createOnboardingLink` uses
 * `Date.now()` in its idempotencyKey, so every call produces a NEW Stripe
 * account-link — that's the auto-recovery for stale-link clicks.
 */
async function mintOnboardingUrl(
  req: Request,
  options: MintOptions,
): Promise<{ ok: true; url: string; accountId: string } | { ok: false; response: NextResponse }> {
  if (process.env.STRIPE_CONNECT_ENABLED !== 'true') {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Stripe Connect not enabled in this env' }, { status: 503 }),
    };
  }

  // Cookie session first; fall back to the wizardToken when the caller came
  // from the setup wizard. A valid rancher-setup JWT authenticates the
  // re-entry with the same trust the wizard grants (see verifySetupToken).
  const r = await requireRancher(req);
  let rancherId: string;
  let authedViaWizardToken = false;
  if (r instanceof NextResponse) {
    const tokenRancherId = options.fromWizard ? verifySetupToken(options.wizardToken) : null;
    if (!tokenRancherId) return { ok: false, response: r };
    rancherId = tokenRancherId;
    authedViaWizardToken = true;
  } else {
    rancherId = r.session.rancherId;
  }

  const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);
  if (!rancher) {
    return { ok: false, response: NextResponse.json({ error: 'Rancher not found' }, { status: 404 }) };
  }

  // Wizard-token re-entry: re-mint the session cookie exactly like setup GET
  // does, so every downstream call this browser makes (connect/status POST on
  // return from Stripe, tier/select, the dashboard) works without another
  // login wall. Best-effort — the Connect link mint below must not fail on a
  // cookie edge case.
  if (authedViaWizardToken) {
    try {
      const sessionToken = jwt.sign(
        {
          type: 'rancher-session',
          rancherId: rancher.id,
          email: rancher['Email'] || '',
          name: rancher['Operator Name'] || rancher['Ranch Name'] || '',
          ranchName: rancher['Ranch Name'] || '',
          state: rancher['State'] || '',
        },
        JWT_SECRET,
        { expiresIn: '60d' },
      );
      const cookieStore = await cookies();
      cookieStore.set({
        name: BHC_RANCHER_COOKIE,
        value: sessionToken,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 60 * 24 * 60 * 60, // 60 days — same ceiling as the setup token
      });
    } catch (e: any) {
      console.warn('[connect/start] session cookie re-mint failed (continuing):', e?.message);
    }
  }

  let accountId: string = String(rancher['Stripe Connect Account Id'] || '');

  // First-time onboarding: create the V2 Connect account, persist immediately
  if (!accountId) {
    const email = String(rancher['Email'] || '').trim();
    if (!email) {
      return {
        ok: false,
        response: NextResponse.json({ error: 'Rancher email required for Stripe Connect' }, { status: 400 }),
      };
    }
    const displayName =
      String(rancher['Operator Name'] || rancher['Ranch Name'] || 'BHC Rancher').trim();

    try {
      const result = await createConnectAccount({
        email,
        displayName,
        rancherId: rancherId,
      });
      accountId = result.accountId;
    } catch (e: any) {
      console.error('[connect/start] V2 account create failed:', e?.message);
      // U26: a rancher stuck at payout setup is a supply blocker (they can never
      // take a deposit). Alert the operator with the raw detail, but return a
      // calm human message — never the raw Stripe internals — with a help path.
      try {
        const { sendOperatorSignal } = await import('@/lib/operatorSignal');
        await sendOperatorSignal({
          urgency: 'loud',
          kind: 'system-error',
          summary: 'Rancher stuck at Stripe Connect start (account create failed)',
          detail: `rancher=${rancherId} (${String(rancher['Operator Name'] || rancher['Ranch Name'] || '')}) — ${e?.message?.slice(0, 200) || 'unknown'}`,
          dedupeKey: `connect-start-fail-${rancherId}`,
          dedupeWindowMs: 30 * 60 * 1000,
        });
      } catch {}
      return {
        ok: false,
        response: NextResponse.json(
          { error: "We couldn't start your payout setup with Stripe just now. Give it another try in a moment — if it keeps happening, email hello@buyhalfcow.com and we'll finish it with you.", code: 'connect_start_failed' },
          { status: 502 },
        ),
      };
    }

    // Persist BEFORE link creation so a refresh mid-flow doesn't create duplicates.
    // 'Connect Started At' is written ONLY here (the first-start branch, gated by
    // `if (!accountId)`), so re-entry/refresh never overwrites it. This anchors the
    // onboarding-stuck recovery-nudge cron, which targets ranchers who began Stripe
    // Connect and abandoned KYC.
    try {
      await updateRecord(TABLES.RANCHERS, rancherId, {
        'Stripe Connect Account Id': accountId,
        'Stripe Connect Status': 'onboarding',
        'Connect Started At': new Date().toISOString(),
      });
    } catch (e: any) {
      console.error('[connect/start] Airtable persist failed:', e?.message);
      // Continue — Stripe account exists; webhook will resync status
    }
  }

  // Mint a FRESH onboarding link every call. This is the auto-recovery
  // path: a rancher clicking a stale email link gets a brand-new one and
  // 302s straight into Stripe instead of seeing "session expired."
  try {
    const returnUrl =
      options.fromWizard && options.wizardToken
        ? `${SITE_URL}/rancher/setup?token=${encodeURIComponent(options.wizardToken)}&connectComplete=1`
        : `${SITE_URL}/rancher/billing?onboarding=done`;
    // refreshUrl carries the SAME wizard context as returnUrl. Stripe GETs the
    // refresh_url when its account-link goes stale (>24h), and our GET handler
    // reads from/wizardToken off the query string — without them, a wizard
    // rancher resuming a stale link was re-minted with the /rancher/billing
    // return_url and skipped the wizard's remaining steps after KYC.
    const refreshUrl =
      options.fromWizard && options.wizardToken
        ? `${SITE_URL}/api/rancher/connect/start?from=wizard&wizardToken=${encodeURIComponent(options.wizardToken)}`
        : `${SITE_URL}/api/rancher/connect/start`;
    const { url } = await createOnboardingLink({
      accountId,
      returnUrl,
      refreshUrl,
    });
    return { ok: true, url, accountId };
  } catch (e: any) {
    console.error('[connect/start] onboarding link failed:', e?.message);
    // U26: same as the account-create failure — alert + calm human message.
    try {
      const { sendOperatorSignal } = await import('@/lib/operatorSignal');
      await sendOperatorSignal({
        urgency: 'loud',
        kind: 'system-error',
        summary: 'Rancher stuck at Stripe Connect start (onboarding link failed)',
        detail: `rancher=${rancherId} acct=${accountId} — ${e?.message?.slice(0, 200) || 'unknown'}`,
        dedupeKey: `connect-link-fail-${rancherId}`,
        dedupeWindowMs: 30 * 60 * 1000,
      });
    } catch {}
    return {
      ok: false,
      response: NextResponse.json(
        { error: "We couldn't open your Stripe payout setup just now. Please try again — if it persists, email hello@buyhalfcow.com and we'll get you connected.", code: 'connect_link_failed' },
        { status: 502 },
      ),
    };
  }
}

export async function POST(req: Request) {
  // Origin-aware return URL: wizard caller resumes at setup Step 8 (Fulfillment).
  // Default (billing dashboard caller) returns to /rancher/billing.
  // Without this, ranchers completing Stripe inside the wizard get stranded on
  // /rancher/billing and skip Step 8 (Fulfillment) + Step 9 (Sign agreement).
  let fromWizard = false;
  let wizardToken = '';
  try {
    const body = await req.json().catch(() => ({} as any));
    fromWizard = body?.from === 'wizard';
    wizardToken = typeof body?.wizardToken === 'string' ? body.wizardToken : '';
  } catch {
    /* body optional */
  }

  const result = await mintOnboardingUrl(req, { fromWizard, wizardToken });
  if (!result.ok) return result.response;
  return NextResponse.json({ url: result.url, accountId: result.accountId });
}

/**
 * GET handler — auto-recovery for expired Stripe onboarding links.
 *
 * Stripe redirects to `refresh_url` (this endpoint) when their hosted
 * account-link expires (24h default). The redirect is a GET with no body,
 * so we can't accept the wizard params via JSON — we read them from the
 * query string instead. Auth: the session cookie when present, else a valid
 * wizardToken from the query string (cross-device / cleared-cookie re-entry —
 * see verifySetupToken; the token also re-mints the cookie so downstream
 * calls work).
 *
 * Outcome: rancher who clicks a stale link gets a 302 to a freshly-minted
 * Stripe onboarding URL. They never see a 4xx or "session expired" page.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const fromWizard = url.searchParams.get('from') === 'wizard';
  const wizardToken = url.searchParams.get('wizardToken') || '';

  const result = await mintOnboardingUrl(req, { fromWizard, wizardToken });
  if (result.ok) {
    // 302 redirect — straight back into Stripe onboarding with a fresh link.
    return NextResponse.redirect(result.url, 302);
  }

  // GET reaches here via Stripe's refresh_url browser redirect (or a stale
  // email link). The shared mint path returns JSON errors aimed at the POST/API
  // caller — but a browser navigating here would just see raw JSON, a dead-end.
  // For a human-facing GET, turn the recoverable cases into friendly
  // redirects instead:
  //   • 401 with wizard context → back to /rancher/setup?token=<wizardToken>.
  //     Reaching 401 here means BOTH the cookie and the wizardToken failed
  //     (a valid wizardToken authenticates above), so the token is expired —
  //     the wizard's expired card offers the self-serve re-mint, and a rancher
  //     who re-auths there resumes the WIZARD, not billing.
  //   • 401 without wizard context → /rancher/login (password + "email me a
  //     link" fallback both live there) so the rancher can re-auth, then pick
  //     up the "finish payout setup" banner on the dashboard. No raw-JSON wall.
  //   • anything else (Connect disabled, account-create failure) → /rancher/billing
  //     where the Connect card explains what's left + offers the resume button.
  const status = result.response.status;
  if (status === 401) {
    if (fromWizard && wizardToken) {
      return NextResponse.redirect(
        `${SITE_URL}/rancher/setup?token=${encodeURIComponent(wizardToken)}`,
        302,
      );
    }
    return NextResponse.redirect(
      `${SITE_URL}/rancher/login?relogin=1&next=${encodeURIComponent('/rancher/billing')}`,
      302,
    );
  }
  return NextResponse.redirect(`${SITE_URL}/rancher/billing?onboarding=incomplete`, 302);
}
