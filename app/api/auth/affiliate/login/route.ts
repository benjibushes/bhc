import { NextResponse } from 'next/server';
import { getAllRecords, escapeAirtableValue } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import jwt from 'jsonwebtoken';
import { sendAffiliateLoginLink } from '@/lib/email';
import { rateLimit, getRequestIp } from '@/lib/rateLimit';

export const maxDuration = 60;

import { JWT_SECRET } from '@/lib/secrets';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

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
    const emailLimit = await rateLimit(`login-affiliate-email:${normalizedEmail}`, { requests: 3, window: '15m' });
    if (!emailLimit.ok) {
      return NextResponse.json(
        { error: 'Login link already sent — check your inbox. Try again in 15 minutes if it didn\'t arrive.' },
        { status: 429 },
      );
    }
    const ipLimit = await rateLimit(`login-affiliate-ip:${ip}`, { requests: 10, window: '1h' });
    if (!ipLimit.ok) {
      return NextResponse.json(
        { error: 'Too many login attempts from this network. Try again in an hour.' },
        { status: 429 },
      );
    }

    const affiliates = await getAllRecords(
      TABLES.AFFILIATES,
      `LOWER({Email}) = "${escapeAirtableValue(normalizedEmail)}"`
    );

    if (affiliates.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'If this email is registered as an affiliate, you will receive a login link.',
      });
    }

    const affiliate = affiliates[0] as any;
    const status = (affiliate['Status'] || '').toLowerCase();

    if (status !== 'active') {
      return NextResponse.json({
        success: true,
        message: 'If this email is registered as an affiliate, you will receive a login link.',
      });
    }

    const token = jwt.sign(
      {
        type: 'affiliate-login',
        affiliateId: affiliate.id,
        email: normalizedEmail,
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    const loginUrl = `${SITE_URL}/affiliate/verify?token=${token}`;

    await sendAffiliateLoginLink({
      email: normalizedEmail,
      loginUrl,
      name: affiliate['Name'] || '',
    });

    return NextResponse.json({
      success: true,
      message: 'If this email is registered as an affiliate, you will receive a login link.',
    });
  } catch (error: any) {
    console.error('Affiliate login error:', error);
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}
