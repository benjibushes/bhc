// app/api/zip-confirm/route.ts
//
// One-tap "confirm your delivery ZIP" capture (2026-07-23).
//
// The ZIP-gathering campaign (app/api/cron/zip-gather) emails a WAITING, no-ZIP
// buyer a signed link here. GET renders a tiny ZIP form; POST validates the
// signed token + the ZIP and writes Consumers.Zip. That's the ONLY field it
// touches (fldGm54EreQD6pYju, name "Zip") — no guessed fields, no stamps that
// don't exist yet.
//
// Security: the JWT binds the consumerId, so a buyer can only ever set their
// OWN ZIP, and only to a valid US 5-digit ZIP. No other auth — this is a
// self-service link the buyer received at their own address.
//
// This endpoint is harmless while the campaign is dark: nothing links here
// until Ben flips ZIP_GATHER_SEND=true, and even then it only records a ZIP the
// buyer typed about themselves. The confirmed ZIP then flows through the SAME
// exclusive-ZIP gate (lib/exclusiveZip) as everyone else — this never routes.

import jwt from 'jsonwebtoken';
import { updateRecord, TABLES } from '@/lib/airtable';
import { JWT_SECRET } from '@/lib/secrets';
import { normalizeZip } from '@/lib/zipFormat';

export const dynamic = 'force-dynamic';

function html(body: string, status = 200): Response {
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Confirm your delivery ZIP · BuyHalfCow</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#F4F1EC;color:#0E0E0E;margin:0;padding:40px 20px;line-height:1.6}.card{max-width:440px;margin:0 auto;background:#fff;border:1px solid #A7A29A;padding:32px}h1{font-family:Georgia,serif;font-size:22px;margin:0 0 12px}p{color:#6B4F3F;margin:12px 0}input[type=text]{font-size:18px;padding:12px;width:100%;box-sizing:border-box;border:1px solid #A7A29A;margin:8px 0}button{font-size:15px;font-weight:600;padding:14px 28px;background:#0E0E0E;color:#FAF8F4;border:0;cursor:pointer;width:100%}.err{color:#8B2E2E}</style>
</head><body><div class="card">${body}</div></body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

interface ZipToken { type?: string; consumerId?: string }

function verify(token: string | null): ZipToken | null {
  if (!token) return null;
  try {
    const p = jwt.verify(token, JWT_SECRET) as ZipToken;
    if (p?.type !== 'zip-confirm' || !p.consumerId) return null;
    return p;
  } catch {
    return null;
  }
}

function form(token: string, error?: string): string {
  return `<h1>Confirm your delivery ZIP</h1>
    <p>Enter your delivery ZIP so we can match you with a local rancher.</p>
    ${error ? `<p class="err">${error}</p>` : ''}
    <form method="POST" action="/api/zip-confirm">
      <input type="hidden" name="t" value="${token.replace(/"/g, '&quot;')}">
      <input type="text" name="zip" inputmode="numeric" autocomplete="postal-code" placeholder="e.g. 77002" maxlength="10" required>
      <button type="submit">Confirm ZIP</button>
    </form>`;
}

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get('t');
  const payload = verify(token);
  if (!payload) {
    return html(`<h1>This link expired</h1><p>Reply to the email we sent and we'll get you a fresh one.</p>`, 400);
  }
  return html(form(token as string));
}

export async function POST(req: Request) {
  let token = '';
  let zipRaw = '';
  try {
    const ct = req.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const body: any = await req.json();
      token = String(body.t || '');
      zipRaw = String(body.zip || '');
    } else {
      const fd = await req.formData();
      token = String(fd.get('t') || '');
      zipRaw = String(fd.get('zip') || '');
    }
  } catch {
    return html(`<h1>Something went wrong</h1><p>Please try the link again.</p>`, 400);
  }

  const payload = verify(token);
  if (!payload) {
    return html(`<h1>This link expired</h1><p>Reply to the email we sent and we'll get you a fresh one.</p>`, 400);
  }

  const zip = normalizeZip(zipRaw);
  if (!zip) {
    return html(form(token, `"${zipRaw}" isn't a valid 5-digit US ZIP — try again.`), 400);
  }

  try {
    await updateRecord(TABLES.CONSUMERS, payload.consumerId as string, { Zip: zip });
  } catch (e: any) {
    console.error('[zip-confirm] write failed:', e?.message);
    return html(`<h1>Couldn't save that</h1><p>Please try again in a moment, or reply to our email.</p>`, 500);
  }

  return html(`<h1>You're confirmed ✓</h1><p>Thanks — your delivery ZIP (<strong>${zip}</strong>) is saved. We'll match you with a local rancher and be in touch.</p>`);
}
