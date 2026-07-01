// app/api/qualify/resend-link/route.ts
//
// F10 — Stale JWT recovery. Buyer hits /qualify/[expired-id] → error UI
// surfaces "resend my link" form → posts here with email → look up Consumer
// by email → send fresh qualify URL.
//
// Privacy: always returns 200 + ok=true even when email not found, so an
// attacker can't enumerate which emails are in the Consumers list. Telegram
// alert fires only when an actual send happens.

import { NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';
import { getAllRecords, TABLES } from '@/lib/airtable';
import { sendEmail } from '@/lib/email';
import { JWT_SECRET } from '@/lib/secrets';

export const dynamic = 'force-dynamic';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

function esc(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function POST(req: Request) {
  let email = '';
  try {
    const body = await req.json().catch(() => ({}));
    email = String(body?.email || '').toLowerCase().trim();
  } catch {
    // ignore
  }
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ ok: false, error: 'valid email required' }, { status: 400 });
  }

  try {
    const matches = await getAllRecords(
      TABLES.CONSUMERS,
      `LOWER({Email})="${email}"`
    ).catch(() => []) as any[];

    if (!matches.length) {
      // Return ok=true to avoid email-enumeration. Buyer won't get email but
      // they think they did → they go check their inbox + spam + that
      // surfaces the issue with their support@ reply or original receipt.
      return NextResponse.json({ ok: true, sent: false });
    }
    const consumer = matches[0];
    if (consumer['Unsubscribed'] === true || consumer['Bounced'] === true) {
      return NextResponse.json({ ok: true, sent: false });
    }

    const firstName = String(consumer['Full Name'] || '').split(' ')[0] || 'there';
    const state = String(consumer['State'] || 'your state');
    // F10 fix (2026-06-15): mint a FRESH qualify-access JWT and append it as
    // ?token=. The /qualify page hard-requires a token (page.tsx surfaces
    // "Missing qualification token" without one), and /api/qualify rejects a
    // tokenless submit with 401. Without this the "resend my link" recovery
    // just looped the buyer straight back into the expired-link error.
    // Same shape every other qualify link uses (/api/consumers, warmup/engage):
    // { type: 'qualify-access', consumerId, email }.
    // Expiry 30d (was 24h): this is an EMAILED clickable recovery link — the
    // buyer may open it days later, and a 24h window put them right back in the
    // expired-link loop this resend flow exists to fix (Email QA, Audit B P1).
    // /api/qualify only checks type==='qualify-access' + consumerId, so a wider
    // window is safe.
    const qualifyToken = jwt.sign(
      { type: 'qualify-access', consumerId: consumer.id, email },
      JWT_SECRET,
      { expiresIn: '30d' }
    );
    const quizUrl = `${SITE_URL}/qualify/${encodeURIComponent(consumer.id)}?token=${encodeURIComponent(qualifyToken)}`;
    const subject = `${firstName}, your fresh quiz link`;
    const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px;">
<div style="max-width:600px;margin:0 auto;background:white;padding:40px;border:1px solid #A7A29A;">
  <h1 style="font-family:Georgia,serif;font-size:22px;margin:0 0 16px;">Hey ${esc(firstName)} —</h1>
  <p>Here's a fresh link to finish your 60-second qualification quiz for ${esc(state)}:</p>
  <div style="text-align:center;margin:24px 0;">
    <a href="${quizUrl}" style="display:inline-block;padding:14px 32px;background:#0E0E0E;color:#F4F1EC;text-decoration:none;font-weight:bold;font-size:13px;letter-spacing:1px;text-transform:uppercase;">Open quiz →</a>
  </div>
  <p style="font-size:13px;color:#6B4F3F;">Questions? Hit reply.<br>— Ben<br>BuyHalfCow<br><em>Connecting every household to a ranch they trust.</em></p>
</div>
</body></html>`;
    await sendEmail({
      to: email,
      subject,
      html,
      templateName: 'sendQuizResendLink',
    });

    return NextResponse.json({ ok: true, sent: true });
  } catch (e: any) {
    console.error('[qualify/resend-link] error:', e?.message);
    // Keep response shape ok=true for non-enumeration; surface error in logs only
    return NextResponse.json({ ok: true, sent: false });
  }
}
