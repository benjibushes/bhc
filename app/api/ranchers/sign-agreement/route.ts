import { NextResponse } from 'next/server';
import { getRecordById, updateRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendTelegramUpdate, sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { sendEmail } from '@/lib/email';
import { getCommissionRate } from '@/lib/commission';
import jwt from 'jsonwebtoken';

import { JWT_SECRET } from '@/lib/secrets';

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
      return NextResponse.json({ error: 'Invalid or expired signing link. Please contact hello@buyhalfcow.com.' }, { status: 401 });
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
      return NextResponse.json({ error: 'Invalid or expired signing link. Please contact hello@buyhalfcow.com.' }, { status: 401 });
    }

    const rancher: any = await getRecordById(TABLES.RANCHERS, decoded.rancherId);
    if (!rancher) {
      return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });
    }

    if (rancher['Agreement Signed']) {
      return NextResponse.json({ error: 'Agreement has already been signed', already_signed: true }, { status: 400 });
    }

    const now = new Date().toISOString();
    // Lock the rancher's Commission Rate at signing time so it can never
    // drift mid-pipeline. Pre-existing rate (admin pre-set OR sticky from
    // an earlier signing) wins — otherwise default to env. This stops the
    // 2026-05-20 Ashcraft pattern where deals closed against ad-hoc rates
    // because the rancher's row had no Commission Rate set.
    const existingRate = Number(rancher['Commission Rate']);
    const rateToLock =
      Number.isFinite(existingRate) && existingRate > 0
        ? existingRate
        : getCommissionRate();

    // Auto-flip live if the rancher's page already has the minimum content
    // required to serve buyers (slug + at least one price + at least one
    // payment link). The wizard UI explicitly tells the rancher "your page
    // goes live the moment you do" — so signed-but-invisible ranchers
    // violate that promise. Routing requires Active='Active' AND
    // Onboarding ∈ ('', 'Live'); without this flip, signed ranchers sit
    // dark waiting on manual verification even when their page is ready.
    const hasSlug = !!rancher['Slug'];
    const hasPrice = !!(
      rancher['Quarter Price'] ||
      rancher['Half Price'] ||
      rancher['Whole Price']
    );
    const hasPaymentLink = !!(
      rancher['Quarter Payment Link'] ||
      rancher['Half Payment Link'] ||
      rancher['Whole Payment Link']
    );
    // Branch by pricing model so the two paths are explicit and independent:
    //
    //   tier_v2 → takes deposits via Stripe Connect (platform checkout).
    //             No legacy Payment Link exists for these ranchers — gating
    //             on hasPaymentLink would leave every tier_v2 rancher
    //             signed-but-dark forever. Require active Stripe Connect
    //             account instead. The Stripe Connect gate ONLY applies here.
    //
    //   legacy  → no Stripe Connect involved. Must have slug + price +
    //             payment link (Square/Stripe/PayPal direct link). The
    //             Stripe Connect Status field is irrelevant and MUST NOT
    //             block go-live for these ranchers.
    const pricingModel = String(rancher['Pricing Model'] || 'legacy').toLowerCase();
    const isTierV2 = pricingModel === 'tier_v2';
    const connectStatus = String(rancher['Stripe Connect Status'] || '').toLowerCase();

    const readyToGoLive = isTierV2
      ? hasSlug && hasPrice && connectStatus === 'active'
      : hasSlug && hasPrice && hasPaymentLink;

    const updateFields: Record<string, unknown> = {
      'Agreement Signed': true,
      'Agreement Signed At': now,
      'Signature Name': signatureName.trim(),
      'Onboarding Status': 'Agreement Signed',
      'Commission Rate': rateToLock,
      'Commission Rate Locked At': now,
    };

    if (readyToGoLive) {
      updateFields['Onboarding Status'] = 'Live';
      updateFields['Active Status'] = 'Active';
      updateFields['Page Live'] = true;
    }

    await updateRecord(TABLES.RANCHERS, decoded.rancherId, updateFields);

    // Fire launch warmup immediately so this state's waitlisted buyers
    // get warmed up within seconds instead of waiting up to 24h for the
    // scheduled cron. The cron is idempotent (per-buyer Warmup Sent At
    // filter + per-rancher 24h cooldown), so back-to-back triggers are
    // safe.
    if (readyToGoLive) {
      try {
        const { triggerLaunchWarmup } = await import('@/lib/triggerLaunchWarmup');
        triggerLaunchWarmup(`sign-agreement:${decoded.rancherId}`);
      } catch (e: any) {
        console.warn('[sign-agreement] could not trigger launch warmup:', e?.message);
      }
    }

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
    <div class="step"><strong>🔍 Start verification</strong> — Submit verification signals on your dashboard (3+ signals = instant approval).</div>
    <div class="step"><strong>🟢 Go live</strong> — Once verified, your page goes live and buyers start coming in.</div>

    <div style="text-align: center; margin: 32px 0;">
      <a href="${dashboardLink}" class="btn">SET UP YOUR RANCH PAGE</a>
    </div>
    <p style="font-size: 12px; color: #A7A29A; text-align: center;">This link logs you in automatically. Valid for 7 days.</p>

    <div class="divider"></div>

    <p><strong>🔍 Verification — Here's How:</strong></p>
    <p>On your dashboard, fill in any of the following. <strong>3 or more = instant auto-approve.</strong> Fewer than 3 = we review within 24-48h.</p>
    <ul style="color: #6B4F3F; line-height: 2;">
      <li>2-3 customer references (name + contact info)</li>
      <li>Google Reviews or Facebook Reviews link</li>
      <li>Social media presence (Instagram and/or Facebook)</li>
      <li>USDA processing facility name</li>
      <li>Certifications (USDA, organic, grass-fed, etc.)</li>
      <li>Gallery photos of your operation</li>
    </ul>
    <p>Once verified, your page goes live and buyers route to you on the next 2-hourly approval cycle.</p>

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
      <p>— Benjamin, Founder<br>BuyHalfCow<br>Questions? Email ${ADMIN_EMAIL}</p>
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
      if (readyToGoLive) {
        // Ranch page was already content-complete at signing time — they're
        // already live and routing. No 1-tap-verify button needed.
        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          `🚀 <b>Rancher SIGNED + WENT LIVE</b>\n\n` +
          `<b>${rancherName}</b> (${rancher['State'] || 'Unknown'})\n` +
          `Signed as: ${signatureName.trim()}\n` +
          `Time: ${new Date(now).toLocaleString('en-US', { timeZone: 'America/Denver' })}\n\n` +
          `📧 Dashboard setup email sent automatically.\n` +
          (isTierV2
            ? `tier_v2: slug + price + Stripe Connect active — flipped Active + Page Live. Launch warmup fired for ${rancher['State'] || 'their state'}.`
            : `legacy: slug + price + payment link — flipped Active + Page Live. Launch warmup fired for ${rancher['State'] || 'their state'}.`)
        );
      } else {
        // Inline 1-tap-verify button. Without this, freshly-signed self-serve
        // ranchers sit indefinitely — sign-agreement only sets Onboarding
        // Status='Agreement Signed', but batch-approve requires
        // 'Verification Complete' to flip them Active. Telegram callback
        // 'rverify_' handler flips both Onboarding Status AND Verification
        // Status in one tap (see app/api/webhooks/telegram/route.ts:1788).
        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          `✍️ <b>Rancher SIGNED — needs verification</b>\n\n` +
          `<b>${rancherName}</b> (${rancher['State'] || 'Unknown'})\n` +
          `Signed as: ${signatureName.trim()}\n` +
          `Time: ${new Date(now).toLocaleString('en-US', { timeZone: 'America/Denver' })}\n\n` +
          `📧 Dashboard setup email sent automatically.\n` +
          `Tap below to 1-click verify and unlock routing — otherwise they sit until they self-verify on dashboard.`,
          {
            inline_keyboard: [
              [{ text: '✅ Verify Now & Unlock Routing', callback_data: `rverify_${decoded.rancherId}` }],
            ],
          }
        );
      }
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
