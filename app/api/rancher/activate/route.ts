import { NextResponse } from 'next/server';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import jwt from 'jsonwebtoken';

import { JWT_SECRET } from '@/lib/secrets';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

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

// GET /api/rancher/activate?token=<JWT>
//
// One-click rancher activation. Token is sent in the "push-coming-to-shove"
// pilot email. Clicking flips the rancher fully Live and queues the warmup
// cron to send their state's Waitlisted buyers a launch email.
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
</style></head><body><div class="container">
<div class="big">${opts.heading}</div>
${opts.body}
<p class="muted">— Benjamin · BuyHalfCow</p>
</div></body></html>`;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const token = searchParams.get('token');

    if (!token) {
      return new NextResponse(
        htmlPage({ title: 'Missing token', heading: '⚠️', body: '<h1>Link incomplete</h1><p>This activation link is missing its token. Reply to the email and I\'ll send a fresh link.</p>' }),
        { status: 400, headers: { 'Content-Type': 'text/html' } }
      );
    }

    const payload: any = verifyJwt(token);
    if (!payload) {
      return new NextResponse(
        htmlPage({ title: 'Expired link', heading: '⏰', body: '<h1>Link expired</h1><p>This activation link is older than 60 days or invalid. Reply to the email and I\'ll send a new one.</p>' }),
        { status: 401, headers: { 'Content-Type': 'text/html' } }
      );
    }

    if (payload.type !== 'rancher-activate' || !payload.rancherId) {
      return new NextResponse(
        htmlPage({ title: 'Invalid link', heading: '⚠️', body: '<h1>Link not recognized</h1><p>This token isn\'t a valid activation link.</p>' }),
        { status: 400, headers: { 'Content-Type': 'text/html' } }
      );
    }

    const rancher: any = await getRecordById(TABLES.RANCHERS, payload.rancherId);
    if (!rancher) {
      return new NextResponse(
        htmlPage({ title: 'Not found', heading: '❓', body: '<h1>Ranch not found</h1><p>I couldn\'t find your record. Reply to the email and I\'ll fix it manually.</p>' }),
        { status: 404, headers: { 'Content-Type': 'text/html' } }
      );
    }

    const ranchName = rancher['Ranch Name'] || rancher['Operator Name'] || 'Your ranch';
    const operatorFirst = String(rancher['Operator Name'] || '').trim().split(/\s+/)[0] || 'there';
    const wasAlreadyLive = rancher['Active Status'] === 'Active' && rancher['Agreement Signed'] === true;

    if (wasAlreadyLive) {
      return new NextResponse(
        htmlPage({
          title: 'Already live',
          heading: '✅',
          body: `<h1>${ranchName} is already live</h1><p>You're all set, ${operatorFirst}. Leads are routing to you. If you'd like to log into your dashboard, reply to my last email and I'll send a fresh login link.</p>`,
        }),
        { status: 200, headers: { 'Content-Type': 'text/html' } }
      );
    }

    // Compute fields to set, preserving existing values where present
    const today = new Date().toISOString().split('T')[0];
    const fields: Record<string, any> = {
      'Agreement Signed': true,
      'Agreement Signed At': today,
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

    // Slug — kebab-case from Ranch Name if blank
    if (!rancher['Slug']) {
      const fallback = kebab(rancher['Ranch Name'] || rancher['Operator Name'] || `ranch-${payload.rancherId.slice(-6)}`);
      fields['Slug'] = fallback || `ranch-${payload.rancherId.slice(-6)}`;
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
    // Fire-and-forget the cron now: rancher just activated, buyers in
    // their state should receive the qualification (warmup) email within
    // seconds. The cron is idempotent and rancher-scoped via the
    // Launch Warmup Triggered flag we just set to false.
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret) {
      try {
        // Don't await — let the cron run in the background. The rancher's
        // confirmation page should render fast.
        fetch(`${SITE_URL}/api/cron/rancher-launch-warmup?secret=${encodeURIComponent(cronSecret)}`, {
          method: 'GET',
          // 50s timeout to match Vercel function lifecycle without blocking
          signal: AbortSignal.timeout(50_000),
        }).catch((e) => console.error('Activate-fired warmup cron (background):', e?.message));
      } catch (e) {
        console.error('Could not fire-and-forget warmup cron:', e);
      }
    }

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
          `<p style="margin:0 0 8px;"><strong>1.</strong> I'll text you within the next few hours to walk through your rancher dashboard.</p>` +
          `<p style="margin:8px 0;"><strong>2.</strong> Tomorrow morning, our warmup emails go out to qualified buyers in your state — anyone who's been waiting for a rancher.</p>` +
          `<p style="margin:8px 0;"><strong>3.</strong> Within a few days you'll start getting buyer intro emails. Reply within 24 hours and you're off to the races.</p>` +
          `<p style="margin:8px 0 0;"><strong>4.</strong> First 4 closed deals are 100% yours. After deal #4, we transition to full white-glove marketing — flat retainer, we run your direct-to-consumer growth.</p>` +
          `</div>` +
          `<p>Welcome to the network. Stand by — your phone's about to start ringing.</p>`,
      }),
      { status: 200, headers: { 'Content-Type': 'text/html' } }
    );
  } catch (error: any) {
    console.error('rancher-activate error:', error);
    return new NextResponse(
      htmlPage({
        title: 'Something broke',
        heading: '⚠️',
        body: '<h1>Activation hit a snag</h1><p>I got an error on the server side. Reply to the email and I\'ll activate you manually within the hour.</p>',
      }),
      { status: 500, headers: { 'Content-Type': 'text/html' } }
    );
  }
}
