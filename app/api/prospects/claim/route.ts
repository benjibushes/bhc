import { NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import {
  getAllRecords,
  updateRecord,
  escapeAirtableValue,
  TABLES,
} from '@/lib/airtable';
import { sendProspectClaimMagicLink } from '@/lib/email';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { funnelRecord } from '@/lib/funnelMetrics';
import { fireCapi, buildUserData, getMetaCookiesFromRequest } from '@/lib/metaCapi';
import { rateLimit, getRequestIp } from '@/lib/rateLimit';

// Project 1 — Discover Map · prospect claim flow.
//
// Two modes on this single endpoint:
//   POST /api/prospects/claim          { slug, operatorName, email, phone }
//     -> Stage 1 of claim: form submission. Generate one-time Claim Token,
//        write it to Airtable, send magic link to provided email.
//        If the prospect already has a `claimed` email on file (rare but
//        possible — Ben added it manually), prefer THAT email and CC the
//        submitter so impersonation isn't trivial.
//   GET  /api/prospects/claim?slug=...&token=...
//     -> Stage 2 of claim: link click. Verify token matches Airtable, flip
//        Claim Status to `claim-pending`, fire Telegram alert so Ben can
//        follow up with onboarding (call → docs → agreement → Live).
//        Redirects user to /ranchers/<slug>/claim?confirmed=1.
//
// Per spec: this DOES NOT auto-flip Verification Status to Verified. That
// only happens after Ben does the onboarding call + docs + agreement, which
// the existing rancher onboarding flow already handles.

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function isValidEmail(s: string): boolean {
  return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(s);
}

function siteUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
}

async function findProspect(slug: string) {
  const safe = escapeAirtableValue(slug);
  const rows = await getAllRecords(
    TABLES.RANCHERS,
    `AND({Slug} = "${safe}", {Verification Status} = "Prospect", NOT({Public Map Hidden} = 1))`
  );
  return rows[0] as any | undefined;
}

// ── POST: form submission → magic-link email ────────────────────────────────

export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const slug = String(body.slug || '').trim();
  const operatorName = String(body.operatorName || '').trim();
  const submittedEmail = String(body.email || '').trim().toLowerCase();
  const phone = String(body.phone || '').trim();
  // Honeypot — bots fill hidden fields; humans never see them. Silent success
  // so the bot believes it worked but no Airtable write / email / Telegram fires.
  // Convention matches self-submit (`website2`). Form (ClaimForm.tsx, out of
  // this lane) should add the hidden field; until then this is a free no-op.
  const honeypot = String(body.website2 || body.company || '');

  if (honeypot) {
    return NextResponse.json({ success: true, manualReview: false, sentTo: maskEmail(submittedEmail) });
  }

  if (!slug) {
    return NextResponse.json({ error: 'Missing slug' }, { status: 400 });
  }
  if (operatorName.length < 2) {
    return NextResponse.json({ error: 'Please enter your name' }, { status: 400 });
  }
  if (!isValidEmail(submittedEmail)) {
    return NextResponse.json({ error: 'Please enter a valid email address' }, { status: 400 });
  }

  // Rate limit BEFORE any Airtable write / email / Telegram. This endpoint
  // had no auth and emails the prospect's (often scraped) address — an open
  // email-bomb / Telegram-spam vector. Two buckets: per-IP (stops a single
  // attacker hammering many slugs) and per-slug (stops a distributed flood
  // from bombing one prospect's inbox). Fails open if Upstash is unset.
  const ip = getRequestIp(req);
  const ipLimit = await rateLimit(`prospect-claim:ip:${ip}`, { requests: 5, window: '1h' });
  if (!ipLimit.ok) {
    return NextResponse.json(
      { error: 'Too many attempts. Please try again later.' },
      { status: 429 },
    );
  }
  const slugLimit = await rateLimit(`prospect-claim:slug:${slug}`, { requests: 3, window: '1h' });
  if (!slugLimit.ok) {
    return NextResponse.json(
      { error: 'This listing was just sent a claim link. Please check the email on file or try again later.' },
      { status: 429 },
    );
  }

  const prospect = await findProspect(slug);
  if (!prospect) {
    return NextResponse.json({ error: 'Listing not found or no longer claimable' }, { status: 404 });
  }

  const ranchName = (prospect['Ranch Name'] || prospect['Operator Name'] || 'this ranch') as string;
  const knownEmail = (prospect['Email'] || '').toString().trim().toLowerCase();

  // Generate magic-link token. 32 hex chars = 128 bits of entropy. Stored
  // back to Airtable with the timestamp; the GET handler validates against
  // both fields so old/cached tokens stop working after re-issue.
  const token = randomBytes(16).toString('hex');
  const link = `${siteUrl()}/api/prospects/claim?slug=${encodeURIComponent(slug)}&token=${token}`;

  try {
    await updateRecord(TABLES.RANCHERS, prospect.id, {
      'Claim Token': token,
      'Claim Sent At': new Date().toISOString(),
      'Claim Status': 'email-sent',
    });
  } catch (e) {
    console.error('[claim] Airtable update failed:', e);
    return NextResponse.json({ error: 'Could not save claim — try again' }, { status: 500 });
  }

  // ── P1-5: funnel telemetry + Meta CAPI Lead ────────────────────────────
  // /partner POST fires both (T1 commit 608535b) but the prospect claim flow
  // was attribution-blind: paid traffic to /ranchers/[slug]/claim fired ZERO
  // funnel events + ZERO CAPI Lead. Same shape as /api/partners + self-submit.
  const prospectState = (prospect['State'] || '').toString();
  try {
    await funnelRecord({
      stage: 'partner_signup',
      rancherId: prospect.id,
      metadata: {
        source: 'claim',
        partnerType: 'rancher',
        state: prospectState,
        recordId: prospect.id,
        claimToken: 'redacted',
      },
    });
  } catch (e) {
    console.error('[funnel] claim fire failed:', e);
  }

  const capiIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const capiUserAgent = req.headers.get('user-agent') || undefined;
  const { fbp: capiFbp, fbc: capiFbc } = getMetaCookiesFromRequest(req);
  const capiNameParts = (operatorName || '').trim().split(/\s+/).filter(Boolean);
  fireCapi([
    {
      event_name: 'Lead',
      event_time: Math.floor(Date.now() / 1000),
      event_source_url: `${siteUrl()}/ranchers/${slug}/claim`,
      event_id: prospect.id,
      action_source: 'website',
      user_data: buildUserData({
        email: submittedEmail || undefined,
        phone: phone || undefined,
        firstName: capiNameParts[0],
        lastName: capiNameParts.slice(1).join(' ') || undefined,
        state: prospectState || undefined,
        ip: capiIp,
        userAgent: capiUserAgent,
        fbp: capiFbp,
        fbc: capiFbc,
      }),
      custom_data: {
        content_name: 'BHC Rancher Claim',
        content_category: 'rancher-claim',
      },
    },
  ]).catch((e) => console.error('[capi] claim fire failed:', e));

  // Decide where the magic link goes.
  //   - If the prospect record already has an Email on file (often scraped
  //     from the public site), send to THAT address. The submitter doesn't
  //     get to redirect the link to themselves — anti-impersonation.
  //   - If no email on file, send to the submitted email. This is the
  //     fallback path; flag it for manual review.
  const emailedTo = knownEmail || submittedEmail;
  const isManualReviewPath = !knownEmail;

  try {
    await sendProspectClaimMagicLink({
      to: emailedTo,
      ranchName,
      operatorName,
      link,
    });
  } catch (e) {
    console.error('[claim] email send failed:', e);
    // Non-blocking — Telegram alert below still fires so Ben can intervene.
  }

  // Telegram alert. Manual review path gets a louder header so Ben verifies
  // identity before flipping anything.
  try {
    const header = isManualReviewPath
      ? '🟡 PROSPECT CLAIM (manual review — no email on file)'
      : '🟢 PROSPECT CLAIM (magic link sent to scraped email)';
    const msg =
      `${header}\n` +
      `Ranch: ${ranchName}\n` +
      `Slug: ${slug}\n` +
      `Submitted by: ${operatorName} <${submittedEmail}>\n` +
      (phone ? `Phone: ${phone}\n` : '') +
      `Magic link sent to: ${emailedTo}\n` +
      (isManualReviewPath
        ? `\nNo scraped email on file — verify identity manually before clicking the link below for them:\n${link}`
        : `\nIf the operator confirms identity, the link they click will flip Claim Status to claim-pending and queue them for onboarding.`);
    if (TELEGRAM_ADMIN_CHAT_ID) {
      await sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, msg);
    }
  } catch (e) {
    console.error('[claim] telegram alert failed:', e);
  }

  return NextResponse.json({
    success: true,
    manualReview: isManualReviewPath,
    sentTo: isManualReviewPath
      ? submittedEmail
      : maskEmail(emailedTo),
  });
}

// Mask `ben@truly-beef.com` -> `b***@truly-beef.com` so we can confirm the
// magic link was sent without exposing the full address to randos who might
// try to claim a listing they don't own.
function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***';
  return `${local[0]}${'*'.repeat(Math.max(2, local.length - 1))}@${domain}`;
}

// ── GET: magic-link click → flip Claim Status ───────────────────────────────

export async function GET(req: Request) {
  const url = new URL(req.url);
  const slug = (url.searchParams.get('slug') || '').trim();
  const token = (url.searchParams.get('token') || '').trim();

  if (!slug || !token) {
    return NextResponse.redirect(new URL(`/ranchers/${slug || ''}?claim=invalid`, url));
  }

  const prospect = await findProspect(slug);
  if (!prospect) {
    return NextResponse.redirect(new URL(`/?claim=notfound`, url));
  }

  const storedToken = (prospect['Claim Token'] || '').toString();
  if (!storedToken || storedToken !== token) {
    return NextResponse.redirect(new URL(`/ranchers/${slug}?claim=invalid`, url));
  }

  // Token is good. Flip status, BUT keep the prospect's Verification Status
  // as "Prospect" — onboarding (call + docs + agreement) is the gate for
  // becoming "Verified". The /api/ranchers/* onboarding endpoints handle that.
  try {
    await updateRecord(TABLES.RANCHERS, prospect.id, {
      'Claim Status': 'claim-pending',
      'Claim Token': '', // burn the token after use
    });
  } catch (e) {
    console.error('[claim GET] Airtable update failed:', e);
    return NextResponse.redirect(new URL(`/ranchers/${slug}?claim=error`, url));
  }

  // Telegram alert + nudge Ben to start onboarding. The standard rancher
  // onboarding flow takes over from here:
  //   1. Ben books a call (Calendly / direct)
  //   2. Ben sends docs via /api/ranchers/[id]/send-onboarding
  //   3. Rancher signs agreement → Active Status flips to Live → Onboarding
  //      Status flips to Live → throttled rancher-launch-warmup (Project 2's
  //      refactor) takes over for buyer warming.
  // TODO(project-2): when Project 2's `Onboarding Intro Pace` field exists
  // on the rancher record, the onboarding form should ask for it. For now
  // it defaults to 5 / week per Agent A's throttle code.
  try {
    if (TELEGRAM_ADMIN_CHAT_ID) {
      const ranchName = (prospect['Ranch Name'] || prospect['Operator Name'] || 'Ranch') as string;
      const state = (prospect['State'] || '').toString();
      const email = (prospect['Email'] || '').toString();
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `🤝 PROSPECT CLAIMED · CLICKED MAGIC LINK\n` +
          `Ranch: ${ranchName} (${state})\n` +
          `Slug: ${slug}\n` +
          (email ? `Email on file: ${email}\n` : '') +
          `Status flipped to claim-pending.\n\n` +
          `Next: book onboarding call + send docs. Standard onboarding flow applies.`
      );
    }
  } catch (e) {
    console.error('[claim GET] telegram alert failed:', e);
  }

  return NextResponse.redirect(new URL(`/ranchers/${slug}/claim?confirmed=1`, url));
}
