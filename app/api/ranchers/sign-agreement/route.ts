import { NextResponse } from 'next/server';
import { getRecordById, updateRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendTelegramUpdate } from '@/lib/telegram';
import { sendEmail } from '@/lib/email';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-member-secret-change-me';

function verifySigningToken(token: string) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    if (decoded.type !== 'agreement-signing') return null;
    return decoded;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const token = url.searchParams.get('token');

    if (!token) {
      return NextResponse.json({ error: 'Missing token' }, { status: 400 });
    }

    const decoded = verifySigningToken(token);
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired signing link. Please contact support@buyhalfcow.com.' }, { status: 401 });
    }

    const rancher: any = await getRecordById(TABLES.RANCHERS, decoded.rancherId);
    if (!rancher) {
      return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });
    }

    if (rancher['Agreement Signed']) {
      // Give them a fresh dashboard link so they're not stuck
      const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
      const rancherEmail = rancher['Email'] || '';
      const loginToken = jwt.sign(
        { type: 'rancher-login', rancherId: decoded.rancherId, email: rancherEmail },
        JWT_SECRET,
        { expiresIn: '24h' }
      );
      const dashboardLink = `${SITE_URL}/rancher/verify?token=${loginToken}`;

      return NextResponse.json({
        already_signed: true,
        signed_at: rancher['Agreement Signed At'] || '',
        rancher_name: rancher['Operator Name'] || rancher['Ranch Name'] || '',
        dashboardLink,
      });
    }

    return NextResponse.json({
      already_signed: false,
      rancher_name: rancher['Operator Name'] || rancher['Ranch Name'] || '',
      ranch_name: rancher['Ranch Name'] || '',
      state: rancher['State'] || '',
      email: rancher['Email'] || '',
    });
  } catch (error: any) {
    console.error('Sign agreement GET error:', error);
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    let body: any;
    try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }); }
    const { token, signatureName, agreedToTerms } = body;

    if (!token || !signatureName || !agreedToTerms) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    if (signatureName.trim().length < 2) {
      return NextResponse.json({ error: 'Please enter your full legal name' }, { status: 400 });
    }

    const decoded = verifySigningToken(token);
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired signing link. Please contact support@buyhalfcow.com.' }, { status: 401 });
    }

    const rancher: any = await getRecordById(TABLES.RANCHERS, decoded.rancherId);
    if (!rancher) {
      return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });
    }

    if (rancher['Agreement Signed']) {
      return NextResponse.json({ error: 'Agreement has already been signed', already_signed: true }, { status: 400 });
    }

    const now = new Date().toISOString();
    await updateRecord(TABLES.RANCHERS, decoded.rancherId, {
      'Agreement Signed': true,
      'Agreement Signed At': now,
      'Signature Name': signatureName.trim(),
      'Onboarding Status': 'Verification Pending',
    });

    const rancherName = rancher['Operator Name'] || rancher['Ranch Name'] || 'Rancher';
    const ranchName = rancher['Ranch Name'] || rancherName;
    const rancherEmail = rancher['Email'] || '';
    const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
    const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@buyhalfcow.com';

    // Create a login token so they can go straight to their dashboard
    const loginToken = jwt.sign(
      { type: 'rancher-login', rancherId: decoded.rancherId, email: rancherEmail },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    const dashboardLink = `${SITE_URL}/rancher/verify?token=${loginToken}`;

    // Send "you're signed — now set up your page" email
    if (rancherEmail) {
      try {
        const esc = (s: string) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        await sendEmail({
          to: rancherEmail,
          subject: `Agreement signed — set up your ranch page, ${rancherName.split(' ')[0]}`,
          html: `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #0E0E0E; background: #F4F1EC; margin: 0; padding: 20px; }
    .container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border: 1px solid #A7A29A; }
    h1 { font-family: Georgia, serif; font-size: 26px; margin: 0 0 20px 0; }
    p { margin: 14px 0; color: #6B4F3F; }
    .divider { height: 1px; background: #A7A29A; margin: 28px 0; }
    .btn { display: inline-block; padding: 16px 40px; background: #0E0E0E; color: #F4F1EC; text-decoration: none; font-weight: bold; font-size: 14px; letter-spacing: 1px; text-transform: uppercase; }
    .step { padding: 12px 16px; border-left: 3px solid #0E0E0E; margin: 12px 0; background: #F4F1EC; }
    .step-done { border-left-color: #22c55e; }
    .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #A7A29A; font-size: 12px; color: #A7A29A; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Agreement Signed — You're Almost Live</h1>
    <p>Hi ${esc(rancherName.split(' ')[0])},</p>
    <p>Great news — your Commission Agreement for <strong>${esc(ranchName)}</strong> is now signed and on file.</p>

    <div class="divider"></div>

    <p><strong>Two things to do right now:</strong></p>

    <div class="step step-done">✅ <strong>Agreement signed</strong> — Done</div>
    <div class="step"><strong>🖥️ Set up your ranch page</strong> — Add your logo, tagline, about text, pricing, and payment links. This is what buyers will see.</div>
    <div class="step"><strong>🔍 Start verification</strong> — Ship a product sample so we can get you approved fast</div>
    <div class="step"><strong>🟢 Go live</strong> — Once verified, your page goes live and buyers start coming in.</div>

    <div style="text-align: center; margin: 32px 0;">
      <a href="${dashboardLink}" class="btn">SET UP YOUR RANCH PAGE</a>
    </div>
    <p style="font-size: 12px; color: #A7A29A; text-align: center;">This link logs you in automatically. Valid for 7 days.</p>

    <div class="divider"></div>

    <p><strong>🔍 Verification — Here's How:</strong></p>
    <p>Ship a representative product sample from your processor to:</p>
    <div style="background: #F4F1EC; padding: 16px; margin: 12px 0; border-left: 3px solid #0E0E0E;">
      <strong>BuyHalfCow Verification</strong><br>
      420 N Walnut St<br>
      Colorado Springs, CO 80905
    </div>
    <ul style="color: #6B4F3F; line-height: 2;">
      <li>Include a few representative cuts (steaks, roast, ground — your choice)</li>
      <li>Properly packaged and clearly labeled</li>
      <li>We review packaging, marbling, cut accuracy, and presentation</li>
      <li>Turnaround: 5-7 days after receipt</li>
    </ul>
    <p>Once your sample passes, we'll go live with your page immediately — no additional steps needed from you.</p>

    <div class="divider"></div>

    <p><strong>What to have ready for your page:</strong></p>
    <ul style="color: #6B4F3F; line-height: 2;">
      <li>Ranch logo or photo</li>
      <li>A short tagline (one sentence)</li>
      <li>Your "about" story — why buyers should trust you</li>
      <li>Pricing for quarter, half, and/or whole</li>
      <li>Payment link (Square, Stripe, PayPal, etc.)</li>
    </ul>

    <p><strong>The faster you set up your page and send a sample, the faster you're live and receiving buyer leads.</strong></p>

    <div class="footer">
      <p>— Benjamin, Founder<br>BuyHalfCow — Private Network for American Ranch Beef<br>Questions? Email ${ADMIN_EMAIL}</p>
    </div>
  </div>
</body>
</html>
          `,
        });
      } catch (emailErr) {
        console.error('Post-signing email error:', emailErr);
      }
    }

    try {
      await sendTelegramUpdate(
        `✍️ <b>Agreement signed!</b>\n\n` +
        `<b>${rancherName}</b> (${rancher['State'] || 'Unknown'})\n` +
        `Signed as: ${signatureName.trim()}\n` +
        `Time: ${new Date(now).toLocaleString('en-US', { timeZone: 'America/Denver' })}\n\n` +
        `📧 Dashboard setup email sent automatically\nNext step: Verification`
      );
    } catch {
      // Non-fatal
    }

    return NextResponse.json({
      success: true,
      message: 'Agreement signed successfully',
      signed_at: now,
      dashboardLink,
    });
  } catch (error: any) {
    console.error('Sign agreement POST error:', error);
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}
