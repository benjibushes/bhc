import { NextResponse } from 'next/server';
import { getAllRecords, getRecordById, TABLES, escapeAirtableValue } from '@/lib/airtable';
import { sendEmail } from '@/lib/email';
import { sendTelegramUpdate } from '@/lib/telegram';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-member-secret-change-me';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

function esc(str: string): string {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// POST /api/ranchers/resend-agreement
// Rancher self-serve recovery when their signing link expired, got lost,
// or never arrived. Accepts either { email } (lookup by email — no login
// required) or { rancherId } (admin-initiated).
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { email, rancherId } = body;

    let rancher: any = null;

    if (rancherId) {
      try {
        rancher = await getRecordById(TABLES.RANCHERS, rancherId);
      } catch {
        return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });
      }
    } else if (email) {
      const cleanEmail = String(email).trim().toLowerCase();
      if (!cleanEmail.includes('@')) {
        return NextResponse.json({ error: 'Valid email required' }, { status: 400 });
      }
      const results = await getAllRecords(
        TABLES.RANCHERS,
        `LOWER({Email}) = "${escapeAirtableValue(cleanEmail)}"`
      );
      rancher = results[0];
      if (!rancher) {
        // Don't leak account existence — return 200 either way.
        return NextResponse.json({
          success: true,
          message: 'If a rancher account exists with that email, a fresh signing link is on its way.',
        });
      }
    } else {
      return NextResponse.json({ error: 'email or rancherId required' }, { status: 400 });
    }

    const rancherEmail = rancher['Email'];
    const rancherName = rancher['Operator Name'] || rancher['Ranch Name'] || 'Rancher';
    if (!rancherEmail) {
      return NextResponse.json({ error: 'Rancher has no email on file — contact support.' }, { status: 400 });
    }

    // Already signed? Tell them, don't re-send.
    if (rancher['Agreement Signed']) {
      return NextResponse.json({
        success: true,
        alreadySigned: true,
        message: 'Agreement already signed. Log into your dashboard at /rancher.',
      });
    }

    const signingToken = jwt.sign(
      { type: 'agreement-signing', rancherId: rancher.id },
      JWT_SECRET,
      { expiresIn: '30d' }
    );
    const signingLink = `${SITE_URL}/rancher/sign-agreement?token=${signingToken}`;

    const emailResult = await sendEmail({
      to: rancherEmail,
      subject: 'Your BuyHalfCow signing link (resent)',
      html: `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:40px;background:#F4F1EC;">
<div style="background:white;padding:40px;border:1px solid #A7A29A;">
  <h1 style="font-family:Georgia,serif;font-size:24px;margin:0 0 16px;">Here's a fresh signing link</h1>
  <p style="color:#6B4F3F;">Hi ${esc(rancherName)},</p>
  <p style="color:#6B4F3F;">As requested, a fresh 30-day link to review and sign your Commission Agreement. Your previous link may have expired, bounced, or been lost.</p>
  <div style="text-align:center;margin:30px 0;">
    <a href="${signingLink}" style="display:inline-block;padding:16px 40px;background:#0E0E0E;color:#F4F1EC;text-decoration:none;font-weight:bold;font-size:14px;letter-spacing:1px;text-transform:uppercase;">Review &amp; Sign Agreement</a>
  </div>
  <p style="font-size:12px;color:#A7A29A;text-align:center;">This link is valid for 30 days.</p>
  <p style="color:#6B4F3F;font-size:13px;">Questions? Reply to this email.</p>
  <p style="color:#A7A29A;font-size:12px;margin-top:30px;">— Benjamin, BuyHalfCow</p>
</div></body></html>`,
    });

    if (!emailResult.success) {
      return NextResponse.json({ error: 'Failed to send link. Contact support@buyhalfcow.com.' }, { status: 500 });
    }

    await sendTelegramUpdate(
      `📧 <b>Signing link resent</b> to ${rancherName} (${rancherEmail})`
    ).catch(() => {});

    return NextResponse.json({
      success: true,
      message: `Fresh signing link sent to ${rancherEmail}. Check your inbox.`,
    });
  } catch (error: any) {
    console.error('Resend agreement error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
