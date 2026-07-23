// POST /api/rancher/setup/resend-link
//
// Self-serve recovery for an expired/lost 60-day setup link. Mirrors the
// pattern /api/ranchers/resend-agreement established for signing links: the
// rancher enters their email on the wizard's expired-token card and gets a
// fresh /rancher/setup?token= link — no founder round-trip, no login needed
// (a pre-signed rancher has no password or magic-link session yet; the setup
// token IS their auth, so a dead token previously dead-ended at "email ben@").
//
// HARD SECURITY RULES:
//  - NO ENUMERATION: every non-rate-limit outcome (no match, already live,
//    account removed, blank email on record, suppressed send, even an
//    internal error) answers the IDENTICAL neutral 200. A prober learns
//    nothing about which emails have rancher accounts.
//  - Rate-limited per-IP (rateLimitStrict — never fails open, #375 pattern)
//    AND per-email 3/15m before any Airtable read.
//  - Pre-live only: a rancher whose page is already live has a real session
//    path (/rancher/login) and gets no fresh wizard token from here; a
//    Removed (closed) account gets nothing.
//  - Token minted exactly like every other setup-link producer: JWT
//    { type: 'rancher-setup', rancherId }, 60d, signed with JWT_SECRET via
//    lib/secrets. The token never appears in logs.

import { NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '@/lib/secrets';
import { sendEmail } from '@/lib/email';
import { sendTelegramUpdate } from '@/lib/telegram';
import { rateLimit, rateLimitStrict, getTrustedClientIp } from '@/lib/rateLimit';
import { findRancherByEmail } from '@/lib/rancherLookup';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

// The one-and-only success body. Byte-identical whether or not the email
// matched a rancher — do not add outcome-specific fields.
const NEUTRAL_RESPONSE = {
  success: true,
  message: 'If a rancher account exists with that email, a fresh setup link is on its way.',
};

function esc(str: string): string {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function POST(request: Request) {
  try {
    // Per-IP strict limiter FIRST — never fails open even with Redis down
    // (in-memory fallback), so this public mint endpoint always has a burst
    // cap. 5/min is generous for a human retyping an email.
    const ip = getTrustedClientIp(request);
    const ipLimit = await rateLimitStrict(`setup-resend-ip:${ip}`, { requests: 5 });
    if (!ipLimit.ok) {
      return NextResponse.json(
        { error: 'Too many requests — try again in a minute.' },
        { status: 429 },
      );
    }

    const body = await request.json().catch(() => ({} as any));
    const email = String(body?.email || '').trim().toLowerCase();
    if (!email || !email.includes('@') || email.length > 254) {
      return NextResponse.json({ error: 'Valid email required' }, { status: 400 });
    }

    // Per-email window: 3 links / 15 minutes, mirroring the magic-link login
    // limits. Keyed on the SUBMITTED email so a prober can't rotate targets
    // under one address, and a rancher mashing the button can't spam their
    // own inbox.
    const emailLimit = await rateLimit(`setup-resend-email:${email}`, {
      requests: 3,
      window: '15m',
    });
    if (!emailLimit.ok) {
      return NextResponse.json(
        { error: 'Too many requests for that email — try again in 15 minutes.' },
        { status: 429 },
      );
    }

    // Same canonical-row resolution as password login / magic link
    // (Email first, then Team Emails, most-recently-active tiebreak).
    const rancher: any = await findRancherByEmail(email);
    if (!rancher) return NextResponse.json(NEUTRAL_RESPONSE);

    // Pre-live only. Live ranchers have a real session path (/rancher/login);
    // closed (Removed) accounts must not be re-openable from a public form.
    // Verification Status can arrive as an enum object or a plain string.
    const verificationStatus = String(
      (rancher['Verification Status'] as any)?.name || rancher['Verification Status'] || '',
    );
    if (rancher['Page Live'] || verificationStatus === 'Removed') {
      return NextResponse.json(NEUTRAL_RESPONSE);
    }

    // Always deliver to the CANONICAL Email on the record (not the submitted
    // address) — a Team Emails match still routes the setup link through the
    // owner's inbox, same as resend-agreement.
    const to = String(rancher['Email'] || '').trim();
    if (!to) return NextResponse.json(NEUTRAL_RESPONSE);

    const name = String(rancher['Operator Name'] || rancher['Ranch Name'] || 'Rancher');
    const setupToken = jwt.sign(
      { type: 'rancher-setup', rancherId: rancher.id },
      JWT_SECRET,
      { expiresIn: '60d' },
    );
    const setupUrl = `${SITE_URL}/rancher/setup?token=${setupToken}`;

    const result: any = await sendEmail({
      to,
      subject: 'Your fresh BuyHalfCow setup link',
      html: `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:40px;background:#F4F1EC;">
<div style="background:white;padding:40px;border:1px solid #A7A29A;">
  <h1 style="font-family:Georgia,serif;font-size:24px;margin:0 0 16px;">Here's a fresh setup link</h1>
  <p style="color:#6B4F3F;">Hi ${esc(name)},</p>
  <p style="color:#6B4F3F;">As requested — a fresh 60-day link to finish setting up your BuyHalfCow page. Your previous link may have expired or been lost. Your progress is saved, so you'll pick up where you left off.</p>
  <div style="text-align:center;margin:30px 0;">
    <a href="${setupUrl}" style="display:inline-block;padding:16px 40px;background:#0E0E0E;color:#F4F1EC;text-decoration:none;font-weight:bold;font-size:14px;letter-spacing:1px;text-transform:uppercase;">Finish My Setup</a>
  </div>
  <p style="font-size:12px;color:#A7A29A;text-align:center;">This link is valid for 60 days.</p>
  <p style="color:#6B4F3F;font-size:13px;">Didn't request this? You can ignore it — the link only opens your own setup page.</p>
  <p style="color:#A7A29A;font-size:12px;margin-top:30px;">— Benjamin, BuyHalfCow</p>
</div></body></html>`,
      // Whitelisted in lib/emailFrequencyGuard.ts — auth-critical, same class
      // as sendMagicLink. Cadence is owned by this endpoint's 3/15m limiter.
      templateName: 'sendRancherSetupLink',
    });

    if (result?.success) {
      await sendTelegramUpdate(
        `🔗 <b>Setup link re-minted</b> (self-serve) for ${name} (${to})`,
      ).catch(() => {});
    } else {
      // Suppressed/failed sends still answer neutral (no enumeration), but a
      // stuck rancher re-requesting a link IS the bounced/suppressed case (the
      // Vale Creek class) — the one rancher who most needs a human. Fire a loud
      // signal so Ben can deliver the link by hand; the caller still gets the
      // identical neutral 200.
      console.error('[setup/resend-link] send did not go out:', result?.reason || 'unknown');
      try {
        const { sendOperatorSignal } = await import('@/lib/operatorSignal');
        await sendOperatorSignal({
          urgency: 'loud',
          kind: 'stuck-rancher',
          summary: 'Stuck rancher asked for a setup link — deliver manually',
          detail: `${name} (${to}) requested a fresh setup link and the send was ${result?.suppressed ? 'suppressed' : `failed:${result?.reason || 'unknown'}`}. Deliver their /rancher/setup link by hand.`,
          dedupeKey: `resend-link-stuck-${to}`,
          dedupeWindowMs: 30 * 60 * 1000,
        });
      } catch {}
    }

    return NextResponse.json(NEUTRAL_RESPONSE);
  } catch (error: any) {
    // Even hard failures answer neutral — this is a public probe surface and
    // a 500-vs-200 split is an oracle. Log for ops, say nothing to the caller.
    console.error('[setup/resend-link] error:', error?.message);
    return NextResponse.json(NEUTRAL_RESPONSE);
  }
}
