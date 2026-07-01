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
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { createConnectAccount, createOnboardingLink } from '@/lib/stripeConnect';
import { requireRancher } from '@/lib/rancherAuth';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

interface MintOptions {
  fromWizard: boolean;
  wizardToken: string;
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

  const r = await requireRancher(req);
  if (r instanceof NextResponse) return { ok: false, response: r };
  const { session } = r;

  const rancher: any = await getRecordById(TABLES.RANCHERS, session.rancherId);
  if (!rancher) {
    return { ok: false, response: NextResponse.json({ error: 'Rancher not found' }, { status: 404 }) };
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
        rancherId: session.rancherId,
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
          detail: `rancher=${session.rancherId} (${String(rancher['Operator Name'] || rancher['Ranch Name'] || '')}) — ${e?.message?.slice(0, 200) || 'unknown'}`,
          dedupeKey: `connect-start-fail-${session.rancherId}`,
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
      await updateRecord(TABLES.RANCHERS, session.rancherId, {
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
    const { url } = await createOnboardingLink({
      accountId,
      returnUrl,
      refreshUrl: `${SITE_URL}/api/rancher/connect/start`,
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
        detail: `rancher=${session.rancherId} acct=${accountId} — ${e?.message?.slice(0, 200) || 'unknown'}`,
        dedupeKey: `connect-link-fail-${session.rancherId}`,
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
 * query string instead. The rancher's session cookie is still valid (the
 * Stripe-side link expiry is independent of our auth), so requireRancher
 * still works.
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
  // For a human-facing GET, turn the two recoverable cases into friendly
  // redirects instead:
  //   • 401 (session expired) → /rancher/login (password + "email me a link"
  //     fallback both live there) so the rancher can re-auth, then pick up the
  //     "finish payout setup" banner on the dashboard. No raw-JSON wall.
  //   • anything else (Connect disabled, account-create failure) → /rancher/billing
  //     where the Connect card explains what's left + offers the resume button.
  const status = result.response.status;
  if (status === 401) {
    return NextResponse.redirect(
      `${SITE_URL}/rancher/login?relogin=1&next=${encodeURIComponent('/rancher/billing')}`,
      302,
    );
  }
  return NextResponse.redirect(`${SITE_URL}/rancher/billing?onboarding=incomplete`, 302);
}
