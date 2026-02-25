import { NextResponse } from 'next/server';
import { getAllRecords } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import jwt from 'jsonwebtoken';
import { sendEmail } from '@/lib/email';

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-member-secret-change-me';

export async function POST(request: Request) {
  try {
    const { email } = await request.json();

    if (!email) {
      return NextResponse.json({ error: 'Email is required' }, { status: 400 });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const ranchers = await getAllRecords(
      TABLES.RANCHERS,
      `LOWER({Email}) = "${normalizedEmail}"`
    );

    if (ranchers.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'If this email is registered, you will receive a login link.',
      });
    }

    const rancher = ranchers[0] as any;

    const token = jwt.sign(
      {
        type: 'rancher-login',
        rancherId: rancher.id,
        email: normalizedEmail,
      },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';
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
            <p style="color: #6B4F3F; font-size: 14px;">This link expires in 1 hour. If you didn't request this, you can ignore this email.</p>
            <div class="footer">
              <p>BuyHalfCow — Private Network for American Ranch Beef</p>
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
