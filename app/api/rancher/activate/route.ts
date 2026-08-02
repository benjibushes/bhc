import { NextResponse } from 'next/server';
import { getRecordById, updateRecord, getAllRecords, escapeAirtableValue, TABLES } from '@/lib/airtable';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { signatureAuditFields } from '@/lib/agreementAudit';
import jwt from 'jsonwebtoken';

import { JWT_SECRET } from '@/lib/secrets';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

// ── Multi-secret JWT verify ────────────────────────────────────────────────
// Background: the 2026-04-29 pilot-pitch broadcast minted activate/decline
// tokens locally with the developer's .env.local JWT_SECRET, which differs
// from the production Vercel env var. Yesterday's tokens won't verify against
// the prod secret → ranchers see "Link expired" the moment they click.
//
// Fix without re-sending the broadcast: read additional comma-separated
// secrets from JWT_SECRET_LEGACY env var, try each in turn after the primary
// fails. Yesterday's tokens verify via the legacy secret, and all other
// tokens (warmup engage, member login, rancher dashboard) keep working via
// the primary. Once the broadcast tokens hit their natural 60-day expiry,
// the legacy secret can be removed without code changes.
const FALLBACK_SECRETS: string[] = (process.env.JWT_SECRET_LEGACY || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function verifyJwt(token: string): any | null {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {}
  for (const s of FALLBACK_SECRETS) {
    try {
      return jwt.verify(token, s);
    } catch {}
  }
  return null;
}

// /api/rancher/activate?token=<JWT>
//
// One-tap rancher activation. Token is sent in the "push-coming-to-shove"
// pilot email. Confirming flips the rancher fully Live and queues the warmup
// cron to send their state's Waitlisted buyers a launch email.
//
// PRE-FLIP GUARD (finding 4, 2026-07-01): GET no longer mutates. Corporate
// mail scanners (SafeLinks / Mimecast) prefetch every GET link in the email —
// the old GET-mutating handler let a scanner push a rancher LIVE (agreement
// stamped, warmup blast queued, buyers emailed) without a human click. Now:
// GET validates the token and renders a ONE-TAP confirm page; the POST from
// that form performs the exact same activation (same idempotency: an
// already-live rancher gets the read-only "already live" page, no writes).
// URLs stay stable — the email links are unchanged.
//
// State changes (idempotent — re-clicking does nothing harmful):
//   Agreement Signed       → true
//   Agreement Signed At    → today
//   Active Status          → "Active"
//   Onboarding Status      → "Live"
//   Status                 → "Active"
//   Page Live              → true
//   States Served          → primary State (only if empty)
//   Slug                   → kebab-case Ranch Name (only if empty)
//   Launch Warmup Triggered → false (so the daily cron picks them up)
//   Custom Notes           → audit-trail line appended
//
// Returns an HTML success page (not a redirect) so the rancher gets immediate
// confirmation in-browser without depending on a frontend route. Telegram
// alerts Ben so he can call/text the rancher within minutes.

function kebab(name: string): string {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
}

function htmlPage(opts: { title: string; heading: string; body: string; ranchName?: string }): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title}</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.7;color:#0E0E0E;background:#F4F1EC;margin:0;padding:32px 16px;}
.container{max-width:560px;margin:40px auto;background:#fff;padding:48px 36px;border:1px solid #A7A29A;text-align:center;}
h1{font-family:Georgia,serif;font-size:28px;margin:0 0 16px;}
p{color:#2A2A2A;font-size:15px;margin:14px 0;}
.big{font-size:64px;line-height:1;margin:0 0 16px;}
.box{background:#F8F5F0;border-left:3px solid #0E0E0E;padding:14px 18px;margin:24px 0;text-align:left;}
.muted{color:#A7A29A;font-size:12px;margin-top:30px;}
.cta{display:inline-block;padding:14px 32px;background:#0E0E0E;color:#F4F1EC !important;text-decoration:none;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;font-size:13px;min-height:44px;box-sizing:border-box;}
</style></head><body><div class="container">
<div class="big">${opts.heading}</div>
${opts.body}
<p class="muted">— Benjamin · BuyHalfCow</p>
</div></body></html>`;
}

// ── Self-serve recovery form (Wave 2 rancher-UX) ───────────────────────────
// Every dead-end on this route used to say "reply to the email and I'll fix
// it" — a founder-in-the-loop rail with hours-to-days latency. The platform
// already has the self-serve mint (/api/ranchers/resend-agreement: fresh
// signing/go-live link by email, no login, no-enumeration 200s), so the
// error pages now embed this small form instead of a support round-trip.
function resendLinkFormHtml(): string {
  return `<form id="bhc-resend" style="margin-top:20px;text-align:left;">
  <label for="bhc-resend-email" style="display:block;font-size:13px;text-transform:uppercase;letter-spacing:1px;color:#6B4F3F;margin-bottom:6px;">Your email</label>
  <input id="bhc-resend-email" type="email" required placeholder="you@yourranch.com" style="width:100%;padding:12px;border:1px solid #A7A29A;font-size:16px;box-sizing:border-box;" />
  <button type="submit" style="margin-top:12px;padding:14px 32px;background:#0E0E0E;color:#F4F1EC;border:none;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;font-size:13px;cursor:pointer;width:100%;min-height:44px;">Email me a fresh link</button>
  <p id="bhc-resend-msg" role="status" style="font-size:13px;color:#6B4F3F;margin-top:10px;"></p>
</form>
<script>
(function(){
  var f=document.getElementById('bhc-resend');
  if(!f)return;
  f.addEventListener('submit',function(e){
    e.preventDefault();
    var email=(document.getElementById('bhc-resend-email')||{}).value||'';
    var msg=document.getElementById('bhc-resend-msg');
    msg.textContent='Sending…';
    fetch('/api/ranchers/resend-agreement',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:email.trim()})})
      .then(function(r){return r.json().catch(function(){return {};});})
      .then(function(d){msg.textContent=d.message||d.error||'If that email is on file, a fresh link is on its way.';})
      .catch(function(){msg.textContent='Could not send just now — try again in a minute.';});
  });
})();
</script>`;
}

// Mints the 60-day self-serve setup-wizard link (same shape as every other
// setup-link producer). The wizard road includes the Stripe Connect step, so
// this one link IS the fix for every "finish your payment setup" dead-end.
function mintSetupUrl(rancherId: string): string {
  const setupToken = jwt.sign(
    { type: 'rancher-setup', rancherId },
    JWT_SECRET,
    { expiresIn: '60d' },
  );
  return `${SITE_URL}/rancher/setup?token=${setupToken}`;
}

// ── Gate-code → rancher copy (Wave 2 rancher-UX) ───────────────────────────
// The payment-path smoke test speaks in probe strings ("connect-probe: live
// Stripe status=restricted cardPaymentsActive=false currentlyDue=3", raw SDK
// exception slices). Those are operator diagnostics — a rancher who just
// signed must read plain instructions. Raw detail still goes to the operator
// Telegram (see the smoke-fail branch below).
function humanizeSmokeFailure(f: string): string {
  if (f.startsWith('price:')) {
    return 'Add a price to at least one share size (quarter, half, or whole).';
  }
  if (f.startsWith('payment-link:')) {
    return 'Add a payment link to at least one share you sell — that link is how buyers pay you.';
  }
  if (f.startsWith('connect-account:')) {
    return 'Connect your bank account with Stripe so buyer deposits can reach you.';
  }
  if (f.startsWith('connect-probe-failed')) {
    return 'We couldn’t reach Stripe to double-check your account just now. Wait a few minutes and click your activation link again.';
  }
  if (f.startsWith('connect-probe:')) {
    return 'Stripe still needs a few details before your account can take payments. Finish your Stripe setup from the button below, then click your activation link again.';
  }
  return 'One part of your payment setup isn’t finished yet — open your setup page below to complete it.';
}

// Shared validation for GET (confirm page) + POST (activation). Returns
// either the error/read-only response to send, or the verified context.
async function validateActivate(request: Request): Promise<
  | { error: NextResponse }
  | {
      error?: undefined;
      payload: any;
      rancher: any;
      token: string;
      ranchName: string;
      operatorFirst: string;
    }
> {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get('token');

  if (!token) {
    return {
      error: new NextResponse(
        htmlPage({ title: 'Missing token', heading: '⚠️', body: `<h1>Link incomplete</h1><p>This activation link is missing its token — usually a copy-paste that lost the end of the URL. Enter your email and we'll send you a fresh link right away.</p>${resendLinkFormHtml()}` }),
        { status: 400, headers: { 'Content-Type': 'text/html' } }
      ),
    };
  }

  const payload: any = verifyJwt(token);
  if (!payload) {
    return {
      error: new NextResponse(
        htmlPage({ title: 'Expired link', heading: '⏰', body: `<h1>Link expired</h1><p>This activation link is older than 60 days or invalid. Enter your email and we'll send you a fresh one right away — no waiting on a reply.</p>${resendLinkFormHtml()}` }),
        { status: 401, headers: { 'Content-Type': 'text/html' } }
      ),
    };
  }

  if (payload.type !== 'rancher-activate' || !payload.rancherId) {
    return {
      error: new NextResponse(
        htmlPage({ title: 'Invalid link', heading: '⚠️', body: '<h1>Link not recognized</h1><p>This token isn\'t a valid activation link.</p>' }),
        { status: 400, headers: { 'Content-Type': 'text/html' } }
      ),
    };
  }

  const rancher: any = await getRecordById(TABLES.RANCHERS, payload.rancherId);
  if (!rancher) {
    return {
      error: new NextResponse(
        htmlPage({ title: 'Not found', heading: '❓', body: `<h1>Ranch not found</h1><p>We couldn't find your record from this link. Enter your email below and we'll send a fresh link for your account — or write <a href="mailto:hello@buyhalfcow.com">hello@buyhalfcow.com</a> if that doesn't land.</p>${resendLinkFormHtml()}` }),
        { status: 404, headers: { 'Content-Type': 'text/html' } }
      ),
    };
  }

  const ranchName = rancher['Ranch Name'] || rancher['Operator Name'] || 'Your ranch';
  const operatorFirst = String(rancher['Operator Name'] || '').trim().split(/\s+/)[0] || 'there';
  const wasAlreadyLive = rancher['Active Status'] === 'Active' && rancher['Agreement Signed'] === true;

  if (wasAlreadyLive) {
    // Read-only — idempotency preserved: an already-live rancher never
    // re-triggers activation from either verb.
    return {
      error: new NextResponse(
        htmlPage({
          title: 'Already live',
          heading: '✅',
          body: `<h1>${ranchName} is already live</h1><p>You're all set, ${operatorFirst}. Leads are routing to you.</p><p><a class="cta" href="${SITE_URL}/rancher/login">Log into your dashboard →</a></p><p style="font-size:13px;color:#6B4F3F;">Enter your email there and we'll send you a one-tap login link.</p>`,
        }),
        { status: 200, headers: { 'Content-Type': 'text/html' } }
      ),
    };
  }

  return { payload, rancher, token, ranchName, operatorFirst };
}

// GET — validate + render the ONE-TAP confirm page. NO writes on GET.
export async function GET(request: Request) {
  try {
    const v = await validateActivate(request);
    if (v.error) return v.error;
    const { token, ranchName, operatorFirst } = v;

    const { pathname } = new URL(request.url);
    return new NextResponse(
      htmlPage({
        title: 'Push me live',
        heading: '🚀',
        body:
          `<h1>Ready to push ${ranchName} live, ${operatorFirst}?</h1>` +
          `<p>One tap and you're active in the network: your page goes live, and qualified buyers in your state start getting matched to you.</p>` +
          `<div class="box"><p style="margin:0;">Pilot terms: your first 4 closed deals are 100% yours — then we transition to full white-glove marketing.</p></div>` +
          `<form method="post" action="${pathname}?token=${encodeURIComponent(token)}" style="margin-top:24px;">` +
          `<button type="submit" style="padding:14px 32px;background:#0E0E0E;color:#F4F1EC;border:none;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;font-size:13px;cursor:pointer;width:100%;">🎉 Yes — push me live</button>` +
          `</form>`,
      }),
      { status: 200, headers: { 'Content-Type': 'text/html' } }
    );
  } catch (error: any) {
    console.error('rancher-activate error:', error);
    // Self-serve retry: activation is idempotent, so the same link is the fix.
    // Link back through GET (never a form re-POST) so retry is always safe.
    let retryHref = '';
    try {
      const u = new URL(request.url);
      retryHref = `${u.pathname}${u.search}`;
    } catch {}
    return new NextResponse(
      htmlPage({
        title: 'Something broke',
        heading: '⚠️',
        body:
          '<h1>Activation hit a snag</h1><p>Something failed on our side — nothing was changed. Your link still works: wait a minute and tap it again. If it keeps failing, write <a href="mailto:hello@buyhalfcow.com">hello@buyhalfcow.com</a>.</p>' +
          (retryHref ? `<p><a class="cta" href="${retryHref}">Try again now</a></p>` : ''),
      }),
      { status: 500, headers: { 'Content-Type': 'text/html' } }
    );
  }
}

// POST — the confirm form lands here; performs the original activation.
export async function POST(request: Request) {
  try {
    const v = await validateActivate(request);
    if (v.error) return v.error;
    const { payload, rancher, ranchName, operatorFirst } = v;

    // ── tier_v2 Connect-active gate ─────────────────────────────────────────
    // A tier_v2 rancher collects buyer deposits via Stripe Connect. If their
    // Connect account isn't 'active' (restricted / onboarding incomplete) they
    // physically cannot take a deposit — the deposit endpoint 409s them and
    // matching excludes them. Flipping them "Live" here would display a rancher
    // who can't actually transact. Refuse to go Live and tell them to finish
    // Stripe Connect first. Mirrors the gate in
    // app/api/ranchers/sign-agreement/route.ts (~146-148). Legacy
    // (non-tier_v2) ranchers are unaffected — Stripe Connect Status is
    // irrelevant to them and must NOT block their go-live.
    const pricingModel = String(rancher['Pricing Model'] || 'legacy').toLowerCase();
    const isTierV2 = pricingModel === 'tier_v2';
    const connectStatus = String(rancher['Stripe Connect Status'] || '').toLowerCase();
    if (isTierV2 && connectStatus !== 'active') {
      const setupUrl = mintSetupUrl(payload.rancherId);
      return new NextResponse(
        htmlPage({
          title: 'Finish Stripe Connect first',
          heading: '🔒',
          body:
            `<h1>One more step, ${operatorFirst}</h1>` +
            `<p>Your agreement is in, but ${ranchName} can't go live until your Stripe Connect account is fully active — that's what lets buyers pay their deposit straight to you.</p>` +
            `<div class="box"><p style="margin:0;">Finish (or re-open) your Stripe onboarding with the button below, then click this link again. The moment Stripe shows you as active, you'll go live instantly.</p></div>` +
            `<p style="margin-top:24px;"><a class="cta" href="${setupUrl}">Finish my Stripe setup →</a></p>` +
            `<p>Takes about 5 minutes — Stripe walks you straight to whatever's left (usually bank details or their terms).</p>`,
        }),
        { status: 409, headers: { 'Content-Type': 'text/html' } }
      );
    }

    // ── Legacy content/payment go-live gate (Wave A 2026-07-14) ────────────
    // This was the ONLY go-live rail with no price/payment-link check: every
    // other rail requires them (sign-agreement's readyToGoLive, batch-approve's
    // canCollectPayment, rancher-go-live-sync). The deposit endpoint 409s
    // legacy ranchers, so a legacy page's only purchase path is Payment Links
    // — flipping Live without them creates an Active rancher who literally
    // cannot collect a dollar (live proof: JC's Ranch NC, 12 active referrals,
    // no price, no link). tier_v2 readiness = price + active Connect (gated
    // above); legacy readiness = price + at least one Payment Link.
    //
    // Not ready → still stamp the agreement (they consented) but hold
    // Onboarding Status at 'Agreement Signed' — NOT Live/Active/Page Live —
    // and hand them a fresh setup link. The signed-no-page bucket in the
    // onboarding-stuck cron then chases them automatically.
    const today = new Date().toISOString().split('T')[0];
    const hasPrice = !!(
      rancher['Quarter Price'] ||
      rancher['Half Price'] ||
      rancher['Whole Price']
    );
    const hasPaymentLink = !!(
      rancher['Quarter Payment Link'] ||
      rancher['Half Payment Link'] ||
      rancher['Whole Payment Link']
    );
    const missing: string[] = [];
    if (!hasPrice) missing.push('a price on at least one share size (quarter, half, or whole)');
    if (!isTierV2 && !hasPaymentLink) missing.push('a payment link on at least one share size (so buyers can actually pay you)');
    if (missing.length > 0) {
      // Stamp consent without going live — idempotent, and keeps the
      // onboarding-stuck chase loop aware of them.
      try {
        const notes = rancher['Custom Notes'] || '';
        const holdLine = `[${today}] Clicked push-live but held pre-Live — missing: ${missing.join('; ')}. Agreement stamped; Onboarding Status=Agreement Signed.`;
        await updateRecord(TABLES.RANCHERS, payload.rancherId, {
          'Agreement Signed': true,
          'Agreement Signed At': rancher['Agreement Signed At'] || today,
          'Onboarding Status': 'Agreement Signed',
          'Custom Notes': notes ? `${notes}\n${holdLine}` : holdLine,
          // E-sign audit parity with sign-agreement (2026-07-28). Only on the
          // FIRST signature — a re-click must not clobber the original
          // IP/UA/version trail. Missing headers are omitted, never thrown.
          ...(rancher['Agreement Signed'] ? {} : signatureAuditFields(request.headers)),
        });
      } catch (e: any) {
        console.error('[activate] agreement-only stamp failed:', e?.message);
      }
      const setupUrl = mintSetupUrl(payload.rancherId);
      return new NextResponse(
        htmlPage({
          title: 'Almost there',
          heading: '🔒',
          body:
            `<h1>Almost there, ${operatorFirst}</h1>` +
            `<p>Your agreement is locked in — but ${ranchName} can't go live yet, because your page is missing:</p>` +
            `<div class="box">${missing.map((m) => `<p style="margin:4px 0;">• ${m}</p>`).join('')}</div>` +
            `<p>Without ${missing.length > 1 ? 'these' : 'this'}, buyers land on your page with no way to buy — and every lead we send you dead-ends.</p>` +
            `<p style="margin-top:24px;"><a class="cta" href="${setupUrl}">Finish my setup →</a></p>` +
            `<p>Takes about 5 minutes, and your progress saves as you go. The moment it's done, click your push-live link again and you're live instantly.</p>`,
        }),
        { status: 409, headers: { 'Content-Type': 'text/html' } }
      );
    }

    // ── Payment-path smoke test (money-truth 1c, 2026-07-21) ───────────────
    // The field gates above verify what Airtable BELIEVES; the smoke test
    // additionally LIVE-probes Stripe for tier_v2 (Connect account actually
    // active + card-payments capable — the cached 'Stripe Connect Status'
    // field can drift from reality). Static-gate failures can't normally
    // reach here (the checks above mirror them), so what this catches is the
    // cached-active/actually-restricted rancher. Slug failures are ignored:
    // this route auto-mints a Slug during the flip below.
    {
      const { runPaymentPathSmoke } = await import('@/lib/paymentPathSmoke');
      const smoke = await runPaymentPathSmoke(rancher);
      const smokeFailures = smoke.failures.filter((f) => !f.startsWith('slug:'));
      if (smokeFailures.length > 0) {
        // Rancher sees plain instructions; the raw probe strings (Stripe
        // status codes, requirement counts, truncated SDK exceptions) go to
        // the operator Telegram only — they are diagnostics, not rancher copy.
        const humanFailures = Array.from(new Set(smokeFailures.map(humanizeSmokeFailure)));
        try {
          await sendTelegramMessage(
            TELEGRAM_ADMIN_CHAT_ID,
            `🔒 <b>Push-live blocked by payment-path smoke</b>\n\n` +
              `🏞️ ${ranchName}\n` +
              smokeFailures.map((f) => `• ${f}`).join('\n') +
              `\n\n<i>Rancher saw the plain-copy version + a fresh setup link.</i>`,
          );
        } catch (e) {
          console.error('[activate] smoke-fail Telegram alert error:', e);
        }
        const setupUrl = mintSetupUrl(payload.rancherId);
        return new NextResponse(
          htmlPage({
            title: 'Payment path not ready',
            heading: '🔒',
            body:
              `<h1>One more step, ${operatorFirst}</h1>` +
              `<p>Your agreement is in, but ${ranchName} can't go live yet — our payment check found:</p>` +
              `<div class="box">${humanFailures.map((f) => `<p style="margin:4px 0;">• ${f}</p>`).join('')}</div>` +
              `<p>Going live now would send you buyers who couldn't actually pay you — so we hold the flip until this is fixed.</p>` +
              `<p style="margin-top:24px;"><a class="cta" href="${setupUrl}">Finish my setup →</a></p>` +
              `<p>Then click your activation link again and you're live instantly.</p>`,
          }),
          { status: 409, headers: { 'Content-Type': 'text/html' } }
        );
      }
    }

    // Compute fields to set, preserving existing values where present
    const fields: Record<string, any> = {
      'Agreement Signed': true,
      'Agreement Signed At': today,
      // E-sign audit parity with sign-agreement (2026-07-28). Only on the
      // FIRST signature — an already-signed rancher re-clicking their
      // activation link must not clobber the original IP/UA/version trail.
      ...(rancher['Agreement Signed'] ? {} : signatureAuditFields(request.headers)),
      'Active Status': 'Active',
      'Onboarding Status': 'Live',
      'Status': 'Active',
      'Page Live': true,
      // Default capacity if none set — 5 is the conservative starter
      ...((!rancher['Max Active Referalls'] && !rancher['Max Active Referrals'])
        ? { 'Max Active Referalls': 5 }
        : {}),
      // Pilot terms — 4 closes free, then white-glove
      'Pilot Closes Goal': rancher['Pilot Closes Goal'] || 4,
      // Reset so daily warmup cron picks them up tomorrow morning
      'Launch Warmup Triggered': false,
    };

    // States Served — fall back to primary State if blank
    if (!rancher['States Served'] && rancher['State']) {
      fields['States Served'] = String(rancher['State']);
    }

    // Slug — kebab-case from Ranch Name if blank. Collision-safe: two ranchers
    // with the same name (e.g. two "Bar S Ranch") must NOT auto-generate the
    // same slug — getRancherBySlug returns whichever Airtable lists first, so
    // the second rancher's page and all their direct traffic would silently
    // route to the first. Append -2, -3, … until free; on lookup failure fall
    // back to a record-id-suffixed slug rather than risk writing a collision.
    if (!rancher['Slug']) {
      const base =
        kebab(rancher['Ranch Name'] || rancher['Operator Name'] || '') ||
        `ranch-${payload.rancherId.slice(-6)}`;
      let unique = base;
      try {
        for (let n = 2; n < 50; n++) {
          const safe = escapeAirtableValue(unique);
          const taken = (
            (await getAllRecords(TABLES.RANCHERS, `LOWER({Slug}) = "${safe}"`)) as any[]
          ).filter((r) => r.id !== payload.rancherId);
          if (taken.length === 0) break;
          unique = `${base}-${n}`;
        }
      } catch (e: any) {
        console.warn('[activate] slug collision check failed:', e?.message);
        unique = `${base}-${payload.rancherId.slice(-6)}`;
      }
      fields['Slug'] = unique;
    }

    // Append audit-trail line to Custom Notes
    const existingNotes = rancher['Custom Notes'] || '';
    const auditLine = `[${today}] Self-activated via push-live email. Pilot terms: first 4 Closed Won deals are commission-free; then transitions to full white-glove marketing service (paid retainer).`;
    fields['Custom Notes'] = existingNotes
      ? `${existingNotes}\n${auditLine}`
      : auditLine;

    await updateRecord(TABLES.RANCHERS, payload.rancherId, fields);

    // ── IMMEDIATE WARMUP TRIGGER ────────────────────────────────────────
    // Without this, buyers in the rancher's state wait until the 8am MT
    // daily cron to receive the qualification email — up to 21h gap.
    // Fire-and-forget the warmup cron now: rancher just activated, buyers
    // in their state should receive the qualification (warmup) email within
    // seconds. Cron is idempotent (per-buyer Warmup Sent At gate).
    const { triggerLaunchWarmup } = await import('@/lib/triggerLaunchWarmup');
    triggerLaunchWarmup(`rancher-activate:${rancher.id}`);

    // Telegram alert — Ben should reach out within minutes
    try {
      const stateLabel = String(fields['States Served'] || rancher['States Served'] || rancher['State'] || '?');
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `🎉 <b>NEW RANCHER LIVE</b>\n\n` +
        `🤠 ${rancher['Operator Name'] || ranchName}\n` +
        `🏞️ ${ranchName}\n` +
        `📍 ${stateLabel}\n` +
        `📧 ${rancher['Email'] || '—'}\n` +
        `📱 ${rancher['Phone'] || '—'}\n\n` +
        `<b>Just clicked PUSH ME LIVE.</b> Pilot terms locked: 4 closes commission-free → white-glove retainer.\n\n` +
        `<i>Reach out tonight to thank them + walk through dashboard. Warmup emails to ${stateLabel} buyers fire on the next daily cron.</i>`
      );
    } catch (e) {
      console.error('rancher-activate Telegram alert error:', e);
    }

    return new NextResponse(
      htmlPage({
        title: `${ranchName} is live`,
        heading: '🎉',
        body:
          `<h1>You're live, ${operatorFirst}.</h1>` +
          `<p>${ranchName} is now active in our network. Here's what happens next:</p>` +
          `<div class="box">` +
          `<p style="margin:0 0 8px;"><strong>1.</strong> Your rancher dashboard is live right now — every lead, message, and payout lands there. Log in any time with just your email.</p>` +
          `<p style="margin:8px 0;"><strong>2.</strong> Tomorrow morning, our warmup emails go out to qualified buyers in your state — anyone who's been waiting for a rancher.</p>` +
          `<p style="margin:8px 0;"><strong>3.</strong> Within a few days you'll start getting buyer intro emails. Reply within 24 hours and you're off to the races.</p>` +
          `<p style="margin:8px 0 0;"><strong>4.</strong> First 4 closed deals are 100% yours. After deal #4, we transition to full white-glove marketing — flat retainer, we run your direct-to-consumer growth.</p>` +
          `</div>` +
          `<p style="margin-top:24px;"><a class="cta" href="${SITE_URL}/rancher/login">Open my dashboard →</a></p>` +
          `<p>Welcome to the network. Stand by — your phone's about to start ringing.</p>`,
      }),
      { status: 200, headers: { 'Content-Type': 'text/html' } }
    );
  } catch (error: any) {
    console.error('rancher-activate error:', error);
    // Self-serve retry: activation is idempotent, so the same link is the fix.
    // Link back through GET (never a form re-POST) so retry is always safe.
    let retryHref = '';
    try {
      const u = new URL(request.url);
      retryHref = `${u.pathname}${u.search}`;
    } catch {}
    return new NextResponse(
      htmlPage({
        title: 'Something broke',
        heading: '⚠️',
        body:
          '<h1>Activation hit a snag</h1><p>Something failed on our side — nothing was changed. Your link still works: wait a minute and tap it again. If it keeps failing, write <a href="mailto:hello@buyhalfcow.com">hello@buyhalfcow.com</a>.</p>' +
          (retryHref ? `<p><a class="cta" href="${retryHref}">Try again now</a></p>` : ''),
      }),
      { status: 500, headers: { 'Content-Type': 'text/html' } }
    );
  }
}
