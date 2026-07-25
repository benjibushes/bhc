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
import {
  createConnectAccount,
  createOnboardingLink,
  applyConnectPrefill,
  getConnectAccountStatus,
  connectHandoff,
  type ConnectHandoff,
} from '@/lib/stripeConnect';
import { buildConnectPrefill, hasMeaningfulPrefill } from '@/lib/connectPrefill';
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
): Promise<
  | { ok: true; url: string; accountId: string; handoff: ConnectHandoff }
  | { ok: false; response: NextResponse }
> {
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
  const isFirstStart = !accountId;

  // ── PREFILL: stop making ranchers retype what we already hold ────────────
  // Five of the twelve ranchers who started Stripe Connect died at the
  // IDENTICAL point (verified live 2026-07-24): tos_acceptance.date = null —
  // Stripe SCREEN ONE. None reached bank details or SSN. All five carried the
  // same past_due set, three of which BHC already knows: their landing-page
  // URL, their product description, and their phone. Sending those ahead of
  // them removes three fields from the screen where they quit.
  // Best-effort by construction (see lib/connectPrefill.ts): a missing or junk
  // value is omitted, never guessed, and NEVER blocks account creation.
  const prefill = buildConnectPrefill(rancher, SITE_URL);

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
        prefill,
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
    // 'Connect Started At' rides this write on a genuine first start. It is ALSO
    // stamped unconditionally below (see stampConnectStarted) so that a rancher
    // whose account was created by some OTHER writer still gets an anchor.
    // Retry the persist once — a real, billable Stripe account already exists,
    // so a dropped write here orphans it (the next start mints ANOTHER account,
    // and the webhook can't resync a row it can't find by Account Id).
    let persisted = false;
    for (let attempt = 1; attempt <= 2 && !persisted; attempt++) {
      try {
        await updateRecord(TABLES.RANCHERS, rancherId, {
          'Stripe Connect Account Id': accountId,
          'Stripe Connect Status': 'onboarding',
          'Connect Started At': new Date().toISOString(),
        });
        persisted = true;
      } catch (e: any) {
        console.error(`[connect/start] Airtable persist failed (attempt ${attempt}):`, e?.message);
      }
    }
    if (!persisted) {
      // Both writes failed: the Account Id never landed on the rancher. Fire a
      // loud signal carrying accountId + rancherId so Ben can attach the orphan
      // by hand — otherwise a billable Connect account is silently unclaimed.
      // Keep minting the link below so the rancher still proceeds.
      try {
        const { sendOperatorSignal } = await import('@/lib/operatorSignal');
        await sendOperatorSignal({
          urgency: 'loud',
          kind: 'connect',
          summary: 'Orphan Connect account — attach manually',
          detail: `rancher=${rancherId} (${String(rancher['Operator Name'] || rancher['Ranch Name'] || '')}) acct=${accountId} — Stripe account created but the Account Id persist failed twice. Attach it to the rancher record by hand before they start again (avoids a duplicate account).`,
          dedupeKey: `connect-orphan-${rancherId}`,
          dedupeWindowMs: 30 * 60 * 1000,
        });
      } catch {}
    }
  }

  // ── STOP BEING BLIND: stamp 'Connect Started At' on EVERY start ─────────
  //
  // This field was 0/87 populated while TWELVE ranchers held a Connect
  // account (verified live 2026-07-24). The field exists and is writable
  // (Ranchers.fldB1nPQ2AsD6iiQT, dateTime) — the write was simply
  // UNREACHABLE for these rows. Both writers (here and tier/select) stamped
  // it only inside their `if (!accountId)` create branch, but the account is
  // frequently created by a THIRD path — /api/admin/ranchers/[id]/
  // mark-legacy-connect — which writes 'Stripe Connect Account Id' and never
  // stamps. After that, `accountId` is always truthy here, the create branch
  // never runs again, and the anchor can never be written for that rancher.
  // (Rep Provisions, onboarded 2026-07-23, is exactly this: Tier='Legacy
  // Connect', account present, anchor null.)
  //
  // Without this anchor the onboarding-stuck cron falls back to
  // Agreement Signed At / Docs Sent At / record-creation date — see its own
  // comment at app/api/cron/onboarding-stuck/route.ts — so the platform
  // cannot see the abandonment that costs 50% of everyone who starts.
  //
  // Idempotent (never overwrites an existing stamp) and best-effort: an
  // analytics anchor must never block a rancher from reaching Stripe. Failure
  // pings the operator rather than dying in a log line.
  if (!rancher['Connect Started At']) {
    try {
      await updateRecord(TABLES.RANCHERS, rancherId, {
        'Connect Started At': new Date().toISOString(),
      });
    } catch (e: any) {
      console.error('[connect/start] Connect Started At stamp failed:', e?.message);
      try {
        const { sendOperatorSignal } = await import('@/lib/operatorSignal');
        await sendOperatorSignal({
          urgency: 'normal',
          kind: 'system-error',
          summary: 'Connect Started At stamp failed — abandonment tracking blind',
          detail: `rancher=${rancherId} (${String(rancher['Ranch Name'] || rancher['Operator Name'] || '')}) — ${e?.message?.slice(0, 200) || 'unknown'}. The onboarding-stuck cron will fall back to a weaker anchor for this rancher.`,
          dedupeKey: `connect-started-stamp-fail-${rancherId}`,
          dedupeWindowMs: 6 * 60 * 60 * 1000,
        });
      } catch {}
    }
  }

  // ── RESUME PATH: read the truth, and push the prefill onto the account ──
  //
  // A brand-new account was just created WITH the prefill, so there is nothing
  // to read or push. For an existing account (every one of the five stalled
  // ranchers) we do two things: read live status so the caller can render one
  // honest next action, and push the prefill so the fields they abandoned on
  // are already filled when they walk back in.
  //
  // Both are wrapped so that NEITHER can stop the rancher reaching Stripe —
  // the onboarding link below is the thing that actually matters.
  let handoff = connectHandoff({ hasAccount: true, status: 'onboarding' });
  if (!isFirstStart) {
    try {
      const live = await getConnectAccountStatus(accountId);
      handoff = connectHandoff({
        hasAccount: true,
        status: live.status,
        currentlyDue: live.currentlyDue,
        canResumeOnboarding: live.canResumeOnboarding,
      });
      // Only push onto an unfinished account. Never overwrite the support
      // details a rancher has already curated on a live, working account.
      if (live.status !== 'active' && hasMeaningfulPrefill(prefill)) {
        try {
          await applyConnectPrefill({ accountId, prefill });
        } catch (e: any) {
          console.warn('[connect/start] prefill push failed (continuing):', e?.message);
        }
      }
    } catch (e: any) {
      // Status read failed — we still send them to Stripe. Report the honest
      // "we don't know yet" shape rather than inventing progress.
      console.warn('[connect/start] live status read failed (continuing):', e?.message);
      handoff = connectHandoff({ hasAccount: true, status: null });
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
    return { ok: true, url, accountId, handoff };
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
  // `url` is a FRESH Stripe account link, minted on this request (Stripe's
  // links expire ~24h), so it is safe to render as a one-click resume button.
  // `resumeUrl` is the same link under the name the UI reads; `state` +
  // `currentlyDue` carry the structured truth so a follow-up PR can render ONE
  // honest next action instead of guessing from a scatter of booleans.
  return NextResponse.json({
    url: result.url,
    resumeUrl: result.url,
    accountId: result.accountId,
    state: result.handoff.state,
    canResume: result.handoff.canResume,
    currentlyDueCount: result.handoff.currentlyDueCount,
    currentlyDue: result.handoff.currentlyDue,
    nextAction: result.handoff.nextAction,
  });
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
