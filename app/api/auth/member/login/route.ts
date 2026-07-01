import { NextResponse } from 'next/server';
import { getAllRecords, escapeAirtableValue } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import jwt from 'jsonwebtoken';
import { sendEmail, sendMagicLink } from '@/lib/email';
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

    const normalizedEmail = email.trim().toLowerCase();
    const ip = getRequestIp(request);
    const emailLimit = await rateLimit(`login-member-email:${normalizedEmail}`, { requests: 3, window: '15m' });
    if (!emailLimit.ok) {
      return NextResponse.json(
        { error: 'Login link already sent — check your inbox. Try again in 15 minutes if it didn\'t arrive.' },
        { status: 429 },
      );
    }
    const ipLimit = await rateLimit(`login-member-ip:${ip}`, { requests: 10, window: '1h' });
    if (!ipLimit.ok) {
      return NextResponse.json(
        { error: 'Too many login attempts from this network. Try again in an hour.' },
        { status: 429 },
      );
    }

    const consumers = await getAllRecords(
      TABLES.CONSUMERS,
      `LOWER({Email}) = "${escapeAirtableValue(normalizedEmail)}"`
    );

    if (consumers.length === 0) {
      // Don't reveal whether the email exists
      return NextResponse.json({
        success: true,
        message: 'If this email is registered, you will receive a login link.',
      });
    }

    const consumer = consumers[0] as any;

    const status = (consumer['Status'] || '').toLowerCase();
    const LOGIN_ALLOWED = ['approved', 'active', 'waitlisted'];

    // If account exists but isn't in an allowed login state (blank/pending/rejected),
    // send a status-aware email so the user isn't left in silent-fail purgatory.
    // Pending/blank → "still reviewing". Rejected → generic "contact us" (no reveal).
    if (!LOGIN_ALLOWED.includes(status)) {
      try {
        if (status === 'pending' || status === '') {
          await sendEmail({
            to: normalizedEmail,
            subject: 'Your BuyHalfCow application is still under review',
            html: `
              <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;background:white;padding:40px;border:1px solid #A7A29A;">
                <h1 style="font-family:Georgia,serif;font-size:24px;margin:0 0 20px;">Still reviewing your application</h1>
                <p style="color:#6B4F3F;">Hi ${consumer['Full Name']?.split(' ')[0] || 'there'},</p>
                <p style="color:#6B4F3F;">We got your request to log in, but your BuyHalfCow application is still under review. I personally review every application — you'll hear back within 24 hours with next steps.</p>
                <p style="color:#6B4F3F;">If it's urgent, just reply to this email.</p>
                <p style="color:#6B4F3F;margin-top:24px;">— Benjamin, Founder</p>
              </div>`,
          });
        }
        // For rejected/other: do nothing (don't reveal status to a potentially lost email).
      } catch {}
      return NextResponse.json({
        success: true,
        message: 'If this email is registered, you will receive a login link.',
      });
    }

    const token = jwt.sign(
      {
        type: 'member-login',
        consumerId: consumer.id,
        email: normalizedEmail,
      },
      JWT_SECRET,
      // 14d expiry (was 7d): this is an EMAILED magic link a buyer may not click
      // until days later (Email QA, Audit B P1). The post-verify session cookie
      // is 30d, so 14d on the one-shot link balances late clicks against keeping
      // the emailed token short. /api/auth/member/verify only checks
      // type==='member-login', so widening expiry is safe.
      { expiresIn: '14d' }
    );

    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';
    const loginUrl = `${siteUrl}/member/verify?token=${token}`;

    await sendMagicLink({
      to: normalizedEmail,
      subject: 'Your BuyHalfCow Login Link',
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
            <h1>Your Login Link</h1>
            <p>Hi ${consumer['Full Name']?.split(' ')[0] || 'there'},</p>
            <p>Click the button below to access your BuyHalfCow member dashboard:</p>
            <a href="${loginUrl}" class="button">Log In to Your Dashboard</a>
            <p style="color: #6B4F3F; font-size: 14px;">This link works for 14 days. If you didn't request this, you can ignore this email.</p>
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
    console.error('Member login error:', error);
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}
