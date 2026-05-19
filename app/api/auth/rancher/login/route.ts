import { NextResponse } from 'next/server';
import { getAllRecords, escapeAirtableValue } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import jwt from 'jsonwebtoken';
import { sendEmail } from '@/lib/email';

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

    // Both Email and Team Emails matching done server-side. Earlier version
    // used an Airtable formula equality on {Email} — that broke for any
    // record where the stored email had trailing whitespace (e.g. ZK Ranches
    // "zach@zkranches.com\n") because the formula compared raw stored value
    // to trimmed input. Operator saw silent "200 success" responses; rancher
    // got nothing. Now everything trimmed/compared in memory.
    const all = await getAllRecords(TABLES.RANCHERS) as any[];
    const splitRe = /[\s,;\n]+/;
    let rancher: any = all.find((r) => {
      const stored = String(r['Email'] || '').trim().toLowerCase().replace(/\s+/g, '');
      return stored && stored === normalizedEmail;
    });

    if (!rancher) {
      // Collect ALL matching ranchers — a consultant / spouse / hired help
      // may legitimately be on multiple Team Emails lists. Earlier behavior
      // was first-match-wins which silently logged them into the wrong
      // dashboard. Pick the most-recently-active one (latest of:
      // Last Assigned At, Agreement Signed At, Docs Sent At, _createdTime).
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
        const recencyMs = (r: any): number => {
          const candidates = [
            r['Last Assigned At'],
            r['Agreement Signed At'],
            r['Docs Sent At'],
            r._createdTime,
          ].map((d) => (d ? new Date(d).getTime() : 0));
          return Math.max(...candidates, 0);
        };
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
      // 7d expiry. 24h was still too tight — ranchers click a link 2-3
      // days after it arrives (especially weekends, busy ranch days),
      // hit "Invalid or expired link", give up. Buyer magic-link is 7d
      // too. Session cookie post-verify is 30d so we still don't keep
      // a stale token around indefinitely.
      { expiresIn: '7d' }
    );

    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
    const loginUrl = `${siteUrl}/rancher/verify?token=${token}`;
    const rancherName = rancher['Operator Name'] || rancher['Ranch Name'] || 'Rancher';

    await sendEmail({
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
            <p style="color: #6B4F3F; font-size: 14px;">This link is good for 7 days. If you didn't request it, you can ignore this email.</p>
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
