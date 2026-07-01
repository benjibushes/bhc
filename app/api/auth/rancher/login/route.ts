import { NextResponse } from 'next/server';
import { getAllRecords, escapeAirtableValue } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import jwt from 'jsonwebtoken';
import { sendMagicLink } from '@/lib/email';
import { rateLimit, getRequestIp } from '@/lib/rateLimit';

export const maxDuration = 60;

import { JWT_SECRET } from '@/lib/secrets';

export async function POST(request: Request) {
  try {
    let parsedBody: any;
    try { parsedBody = await request.json(); } catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }); }
    const { email } = parsedBody;

    if (!email) {
      return NextResponse.json({ error: 'Email is required' }, { status: 400 });
    }

    const normalizedEmail = email.trim().toLowerCase().replace(/\s+/g, '');

    // Per-email + per-IP rate limit on magic-link send. #11.
    const ip = getRequestIp(request);
    const emailLimit = await rateLimit(`login-rancher-email:${normalizedEmail}`, { requests: 3, window: '15m' });
    if (!emailLimit.ok) {
      return NextResponse.json(
        { error: 'Login link already sent — check your inbox. Try again in 15 minutes if it didn\'t arrive.' },
        { status: 429 },
      );
    }
    const ipLimit = await rateLimit(`login-rancher-ip:${ip}`, { requests: 10, window: '1h' });
    if (!ipLimit.ok) {
      return NextResponse.json(
        { error: 'Too many login attempts from this network. Try again in an hour.' },
        { status: 429 },
      );
    }

    // Both Email and Team Emails matching done server-side. Earlier version
    // used an Airtable formula equality on {Email} — that broke for any
    // record where the stored email had trailing whitespace (e.g. ZK Ranches
    // "zach@zkranches.com\n") because the formula compared raw stored value
    // to trimmed input. Operator saw silent "200 success" responses; rancher
    // got nothing. Now everything trimmed/compared in memory.
    const all = await getAllRecords(TABLES.RANCHERS) as any[];
    const splitRe = /[\s,;\n]+/;
    // Shared most-recently-active tiebreak (latest of: Last Assigned At,
    // Agreement Signed At, Docs Sent At, _createdTime). Used for BOTH the
    // direct-Email and Team-Emails branches so a lingering duplicate row
    // resolves deterministically to the canonical (most-recently-active) one
    // — and to the SAME row the dedupe guard in lib/airtable.ts converges on.
    const recencyMs = (r: any): number => {
      const candidates = [
        r['Last Assigned At'],
        r['Agreement Signed At'],
        r['Docs Sent At'],
        r._createdTime,
      ].map((d) => (d ? new Date(d).getTime() : 0));
      return Math.max(...candidates, 0);
    };

    // Direct {Email} match. Previously first-match-wins via .find() — if a
    // duplicate email still existed, login could land on the WRONG row (and
    // Connect onboarding then attached to the wrong rancher). Collect ALL
    // direct matches and pick the most-recently-active, same as Team Emails.
    let rancher: any;
    const emailMatches: any[] = all.filter((r) => {
      const stored = String(r['Email'] || '').trim().toLowerCase().replace(/\s+/g, '');
      return stored && stored === normalizedEmail;
    });
    if (emailMatches.length === 1) {
      rancher = emailMatches[0];
    } else if (emailMatches.length > 1) {
      emailMatches.sort((a, b) => recencyMs(b) - recencyMs(a));
      rancher = emailMatches[0];
      console.log(`[rancher-login] multi-email-match email=${normalizedEmail} → picked ${rancher.id} of ${emailMatches.length} candidates`);
    }

    if (!rancher) {
      // Collect ALL matching ranchers — a consultant / spouse / hired help
      // may legitimately be on multiple Team Emails lists. Earlier behavior
      // was first-match-wins which silently logged them into the wrong
      // dashboard. Pick the most-recently-active one.
      const teamMatches: any[] = [];
      for (const r of all) {
        const teamRaw = String(r['Team Emails'] || '').toLowerCase();
        if (!teamRaw) continue;
        const list = teamRaw.split(splitRe).map((s) => s.trim()).filter(Boolean);
        if (list.includes(normalizedEmail)) teamMatches.push(r);
      }
      if (teamMatches.length === 1) {
        rancher = teamMatches[0];
      } else if (teamMatches.length > 1) {
        teamMatches.sort((a, b) => recencyMs(b) - recencyMs(a));
        rancher = teamMatches[0];
        console.log(`[rancher-login] multi-team-match email=${normalizedEmail} → picked ${rancher.id} of ${teamMatches.length} candidates`);
      }
    }

    if (!rancher) {
      // Telegram audit on every miss — surfaces typos + whitespace bugs
      // immediately instead of operator guessing why a rancher didn't get
      // an email.
      try {
        const { sendOperatorSignal } = await import('@/lib/operatorSignal');
        await sendOperatorSignal({
          urgency: 'normal',
          kind: 'login-miss',
          summary: `Email typed: ${normalizedEmail}`,
          detail: 'No match in Email or Team Emails. Likely a typo or whitespace in the stored field.',
          dedupeKey: `login-miss:${normalizedEmail}`,
          dedupeWindowMs: 30 * 60 * 1000,
        });
      } catch {}
      console.log(`[rancher-login] MISS email=${normalizedEmail}`);
      return NextResponse.json({
        success: true,
        message: 'If this email is registered, you will receive a login link.',
      });
    }
    console.log(`[rancher-login] match email=${normalizedEmail} rancher=${rancher.id}`);

    const token = jwt.sign(
      {
        type: 'rancher-login',
        rancherId: rancher.id,
        email: normalizedEmail,
      },
      JWT_SECRET,
      // 14d expiry (was 7d). Ranchers click a link days after it arrives
      // (weekends, busy ranch days), hit "Invalid or expired link", give up —
      // 7d was still too tight for an EMAILED magic link (Email QA, Audit B P1).
      // Buyer magic-link is 14d too. Session cookie post-verify is 30d so we
      // still don't keep a stale one-shot token around indefinitely.
      { expiresIn: '14d' }
    );

    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';
    const loginUrl = `${siteUrl}/rancher/verify?token=${token}`;
    const rancherName = rancher['Operator Name'] || rancher['Ranch Name'] || 'Rancher';

    await sendMagicLink({
      to: normalizedEmail,
      subject: 'Your BuyHalfCow Rancher Dashboard Login',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #0E0E0E; background: #F4F1EC; margin: 0; padding: 20px; }
            .container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border: 1px solid #A7A29A; }
            h1 { font-family: Georgia, serif; font-size: 24px; margin: 0 0 20px 0; }
            .button { display: inline-block; padding: 16px 32px; background: #0E0E0E; color: white !important; text-decoration: none; text-transform: uppercase; font-weight: 600; letter-spacing: 1px; margin: 20px 0; }
            .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #A7A29A; font-size: 12px; color: #A7A29A; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Rancher Dashboard Login</h1>
            <p>Hi ${rancherName.split(' ')[0]},</p>
            <p>Click the button below to access your BuyHalfCow rancher dashboard:</p>
            <a href="${loginUrl}" class="button">Log In to Dashboard</a>
            <p style="color: #6B4F3F; font-size: 14px;">This link is good for 14 days. If you didn't request it, you can ignore this email.</p>
            <div class="footer">
              <p>BuyHalfCow</p>
            </div>
          </div>
        </body>
        </html>
      `,
    });

    return NextResponse.json({
      success: true,
      message: 'If this email is registered, you will receive a login link.',
    });
  } catch (error: any) {
    console.error('Rancher login error:', error);
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}
