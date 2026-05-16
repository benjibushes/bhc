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

    const normalizedEmail = email.trim().toLowerCase();

    // Match primary Email OR an EXACT entry in Team Emails. Earlier version
    // used Airtable FIND() inside the formula — that's a substring match
    // ("alice" matches "alice@ranch.com"). Auth bypass: attacker types a
    // substring they control as a real inbox and gets the magic link to
    // their address. Now we exact-match by parsing the Team Emails field
    // server-side.
    let primary = await getAllRecords(
      TABLES.RANCHERS,
      `LOWER({Email}) = "${escapeAirtableValue(normalizedEmail)}"`
    );
    let rancher: any = primary[0] || null;

    if (!rancher) {
      // No primary email match — scan Team Emails field. Pulling all ranchers
      // is fine: getAllRecords(RANCHERS) is in-process cached (10s TTL) and
      // matching/suggest already does this on hot path.
      const all = await getAllRecords(TABLES.RANCHERS);
      const splitRe = /[\s,;\n]+/;
      for (const r of all as any[]) {
        const teamRaw = String(r['Team Emails'] || '').toLowerCase();
        if (!teamRaw) continue;
        const list = teamRaw.split(splitRe).map((s) => s.trim()).filter(Boolean);
        if (list.includes(normalizedEmail)) {
          rancher = r;
          break;
        }
      }
    }

    if (!rancher) {
      return NextResponse.json({
        success: true,
        message: 'If this email is registered, you will receive a login link.',
      });
    }

    const token = jwt.sign(
      {
        type: 'rancher-login',
        rancherId: rancher.id,
        email: normalizedEmail,
      },
      JWT_SECRET,
      // 24h expiry (was 1h). Ranchers check email hours-to-a-day after
      // requesting, so 1h was producing "Invalid or expired login link"
      // for the normal case. 24h is still tight enough that a stolen-phone
      // token is low-value. Session cookie still 30d after exchange.
      { expiresIn: '24h' }
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
            <p style="color: #6B4F3F; font-size: 14px;">This link is good for 24 hours. If you didn't request it, you can ignore this email.</p>
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
