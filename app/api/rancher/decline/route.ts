import { NextResponse } from 'next/server';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import jwt from 'jsonwebtoken';

import { JWT_SECRET } from '@/lib/secrets';

// ── Multi-secret JWT verify ─────────────────────────────────────────────────
// See /api/rancher/activate/route.ts for full context. Yesterday's broadcast
// minted decline tokens with a different secret than prod; we accept both via
// JWT_SECRET_LEGACY (comma-separated) until the 60-day natural expiry.
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

// /api/rancher/decline?token=<JWT>
//
// One-tap rancher opt-out. Token is sent in the "push-coming-to-shove"
// pilot email alongside the activate link. Confirming removes them from the
// pipeline cleanly:
//   Status                 → "rejected"
//   Unsubscribed           → true (kills all future operational + marketing email)
//   Active Status          → "Paused" (defensive — they were never Active anyway)
//   Custom Notes           → audit-trail line appended
//
// Telegram alerts Ben so he knows to remove from any active follow-up
// queues. Returns an HTML confirmation page.
//
// PRE-FLIP GUARD (finding 4, 2026-07-01): GET no longer mutates. Corporate
// mail scanners (SafeLinks / Mimecast) prefetch every GET link in the email —
// the old GET-mutating handler let a scanner silently unsubscribe + reject a
// rancher who never clicked. Now: GET validates the token and renders a
// ONE-TAP confirm page; the POST from that form performs the exact same
// mutation (same idempotency: already-declined ranchers skip the write).
// URLs stay stable — the email links are unchanged.

function htmlPage(opts: { title: string; heading: string; body: string }): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title}</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.7;color:#0E0E0E;background:#F4F1EC;margin:0;padding:32px 16px;}
.container{max-width:560px;margin:40px auto;background:#fff;padding:48px 36px;border:1px solid #A7A29A;text-align:center;}
h1{font-family:Georgia,serif;font-size:26px;margin:0 0 16px;}
p{color:#2A2A2A;font-size:15px;margin:14px 0;}
.big{font-size:56px;line-height:1;margin:0 0 16px;}
.muted{color:#A7A29A;font-size:12px;margin-top:30px;}
</style></head><body><div class="container">
<div class="big">${opts.heading}</div>
${opts.body}
<p class="muted">— Benjamin · BuyHalfCow</p>
</div></body></html>`;
}

// Shared validation for GET (confirm page) + POST (mutation). Returns either
// the error response to send, or the verified payload + rancher record.
async function validateDecline(request: Request): Promise<
  | { error: NextResponse }
  | { error?: undefined; payload: any; rancher: any | null; token: string }
> {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get('token');

  if (!token) {
    return {
      error: new NextResponse(
        htmlPage({ title: 'Missing token', heading: '⚠️', body: '<h1>Link incomplete</h1><p>Reply to the email and I\'ll handle it manually.</p>' }),
        { status: 400, headers: { 'Content-Type': 'text/html' } }
      ),
    };
  }

  const payload: any = verifyJwt(token);
  if (!payload) {
    return {
      error: new NextResponse(
        htmlPage({ title: 'Expired link', heading: '⏰', body: '<h1>Link expired</h1><p>Reply to the email and I\'ll remove you manually.</p>' }),
        { status: 401, headers: { 'Content-Type': 'text/html' } }
      ),
    };
  }

  if (payload.type !== 'rancher-decline' || !payload.rancherId) {
    return {
      error: new NextResponse(
        htmlPage({ title: 'Invalid link', heading: '⚠️', body: '<h1>Link not recognized</h1><p>This token isn\'t valid.</p>' }),
        { status: 400, headers: { 'Content-Type': 'text/html' } }
      ),
    };
  }

  const rancher: any = await getRecordById(TABLES.RANCHERS, payload.rancherId);
  return { payload, rancher, token };
}

// GET — validate + render the ONE-TAP confirm page. NO writes on GET.
export async function GET(request: Request) {
  try {
    const v = await validateDecline(request);
    if (v.error) return v.error;
    const { rancher, token } = v;

    if (!rancher) {
      return new NextResponse(
        htmlPage({ title: 'Already removed', heading: '✓', body: '<h1>You\'re off the list</h1><p>I couldn\'t find your record — it may have already been removed. Either way, you won\'t hear from us again.</p>' }),
        { status: 200, headers: { 'Content-Type': 'text/html' } }
      );
    }

    const ranchName = rancher['Ranch Name'] || rancher['Operator Name'] || 'your ranch';
    const operatorFirst = String(rancher['Operator Name'] || '').trim().split(/\s+/)[0] || 'there';
    const wasAlreadyDeclined = rancher['Status'] === 'rejected' || rancher['Unsubscribed'] === true;

    if (wasAlreadyDeclined) {
      // Already off the list — read-only page, nothing to confirm.
      return new NextResponse(
        htmlPage({
          title: 'Removed',
          heading: '✓',
          body:
            `<h1>You're already off the list, ${operatorFirst}.</h1>` +
            `<p>${ranchName} was removed from the pipeline. No more emails, no follow-ups.</p>` +
            `<p>If you ever want back in, just shoot me a text or email.</p>`,
        }),
        { status: 200, headers: { 'Content-Type': 'text/html' } }
      );
    }

    const { pathname } = new URL(request.url);
    return new NextResponse(
      htmlPage({
        title: 'Confirm removal',
        heading: '👋',
        body:
          `<h1>Take ${ranchName} off the list?</h1>` +
          `<p>One tap and you're out — no more emails, no follow-ups, ever.</p>` +
          `<form method="post" action="${pathname}?token=${encodeURIComponent(token)}" style="margin-top:24px;">` +
          `<button type="submit" style="padding:14px 32px;background:#0E0E0E;color:#F4F1EC;border:none;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;font-size:13px;cursor:pointer;width:100%;">Yes — take me off the list</button>` +
          `</form>` +
          `<p>Changed your mind? Just close this page.</p>`,
      }),
      { status: 200, headers: { 'Content-Type': 'text/html' } }
    );
  } catch (error: any) {
    console.error('rancher-decline error:', error);
    return new NextResponse(
      htmlPage({
        title: 'Something broke',
        heading: '⚠️',
        body: '<h1>Removal hit a snag</h1><p>I got an error on the server side. Reply to the email with "remove me" and I\'ll handle it manually within the hour.</p>',
      }),
      { status: 500, headers: { 'Content-Type': 'text/html' } }
    );
  }
}

// POST — the confirm form lands here; performs the original opt-out mutation.
export async function POST(request: Request) {
  try {
    const v = await validateDecline(request);
    if (v.error) return v.error;
    const { payload, rancher } = v;

    if (!rancher) {
      return new NextResponse(
        htmlPage({ title: 'Already removed', heading: '✓', body: '<h1>You\'re off the list</h1><p>I couldn\'t find your record — it may have already been removed. Either way, you won\'t hear from us again.</p>' }),
        { status: 200, headers: { 'Content-Type': 'text/html' } }
      );
    }

    const ranchName = rancher['Ranch Name'] || rancher['Operator Name'] || 'your ranch';
    const operatorFirst = String(rancher['Operator Name'] || '').trim().split(/\s+/)[0] || 'there';
    const wasAlreadyDeclined = rancher['Status'] === 'rejected' || rancher['Unsubscribed'] === true;

    if (!wasAlreadyDeclined) {
      const today = new Date().toISOString().split('T')[0];
      const existingNotes = rancher['Custom Notes'] || '';
      const auditLine = `[${today}] Self-declined via push-live email — opted out of BuyHalfCow pipeline.`;

      await updateRecord(TABLES.RANCHERS, payload.rancherId, {
        'Status': 'rejected',
        'Unsubscribed': true,
        'Active Status': 'Paused',
        'Custom Notes': existingNotes ? `${existingNotes}\n${auditLine}` : auditLine,
      });

      // Telegram alert — Ben should pull them from any in-flight follow-up sequences manually
      try {
        const stateLabel = rancher['State'] || rancher['States Served'] || '?';
        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          `❌ <b>RANCHER OPT-OUT</b>\n\n` +
          `🤠 ${rancher['Operator Name'] || ranchName}\n` +
          `🏞️ ${ranchName}\n` +
          `📍 ${stateLabel}\n` +
          `📧 ${rancher['Email'] || '—'}\n\n` +
          `<b>Clicked TAKE ME OFF THE LIST.</b> Status=rejected + Unsubscribed=true. They're suppressed from all future operational + marketing email.\n\n` +
          `<i>If you want to do a personal follow-up to understand why, do it via text/phone — not email.</i>`
        );
      } catch (e) {
        console.error('rancher-decline Telegram alert error:', e);
      }
    }

    return new NextResponse(
      htmlPage({
        title: 'Removed',
        heading: '✓',
        body:
          `<h1>You're off the list, ${operatorFirst}.</h1>` +
          `<p>${ranchName} has been removed from the pipeline. You won't hear from us again — no more emails, no follow-ups.</p>` +
          `<p>If you ever want back in, just shoot me a text or email.</p>` +
          `<p>Appreciate you giving it a look.</p>`,
      }),
      { status: 200, headers: { 'Content-Type': 'text/html' } }
    );
  } catch (error: any) {
    console.error('rancher-decline error:', error);
    return new NextResponse(
      htmlPage({
        title: 'Something broke',
        heading: '⚠️',
        body: '<h1>Removal hit a snag</h1><p>I got an error on the server side. Reply to the email with "remove me" and I\'ll handle it manually within the hour.</p>',
      }),
      { status: 500, headers: { 'Content-Type': 'text/html' } }
    );
  }
}
