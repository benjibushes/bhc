import { NextResponse } from 'next/server';
import { updateRecord, getRecordById } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendEmail } from '@/lib/email';
import { sendTelegramUpdate } from '@/lib/telegram';
import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-member-secret-change-me';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

function esc(str: string): string {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { callSummary, confirmedCapacity, specialNotes, includeVerification, password } = body;

    const adminPassword = process.env.ADMIN_PASSWORD;
    const internalSecret = process.env.INTERNAL_API_SECRET;
    const authHeader = request.headers.get('x-internal-secret');

    // Check admin cookie (from admin dashboard)
    const cookieStore = await cookies();
    const adminCookie = cookieStore.get('bhc-admin-auth');
    const hasAdminCookie = adminCookie?.value === 'authenticated';

    const isAuthed =
      hasAdminCookie ||
      (adminPassword && password === adminPassword) ||
      (internalSecret && authHeader === internalSecret);

    if (!isAuthed) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const rancher: any = await getRecordById(TABLES.RANCHERS, id);
    const rancherName = rancher['Operator Name'] || rancher['Ranch Name'] || 'Rancher';
    const rancherEmail = rancher['Email'];

    if (!rancherEmail) {
      return NextResponse.json({ error: 'Rancher has no email address' }, { status: 400 });
    }

    const now = new Date().toISOString();
    await updateRecord(TABLES.RANCHERS, id, {
      'Call Notes': callSummary || '',
      'Monthly Capacity': confirmedCapacity || 10,
      'Onboarding Status': 'Docs Sent',
      'Docs Sent At': now,
      'Call Completed At': now,
    });

    // Document download links (served from public/docs/ as static files)
    const docs = [
      { name: 'BHC_Commission_Agreement.docx', label: 'Commission Agreement' },
      { name: 'BHC_Media_Agreement.docx', label: 'Media Agreement' },
      { name: 'BHC_Rancher_Info_Packet.pdf', label: 'Rancher Info Packet' },
    ];

    const signingToken = jwt.sign(
      { type: 'agreement-signing', rancherId: id },
      JWT_SECRET,
      { expiresIn: '30d' }
    );
    const signingLink = `${SITE_URL}/rancher/sign-agreement?token=${signingToken}`;

    const hasCallContext = !!(callSummary || confirmedCapacity || specialNotes);

    const verificationHtml = includeVerification
      ? `
        <h3 style="margin: 20px 0 10px;">3. Verification (Product Sample)</h3>
        <ul style="color: #6B4F3F; line-height: 1.8;">
          <li>Ship a representative product sample from your processor</li>
          <li>Properly packaged and clearly labeled</li>
          <li>Ship to: 420 N Walnut St, Colorado Springs, CO</li>
          <li>We review packaging, marbling, cut accuracy, and presentation</li>
          <li>Estimated timeline: 2-3 weeks after receipt</li>
        </ul>
      `
      : `
        <h3 style="margin: 20px 0 10px;">3. Verification (In-Person Visit)</h3>
        <ul style="color: #6B4F3F; line-height: 1.8;">
          <li>We'll schedule an on-site ranch visit</li>
          <li>Includes walkthrough, feeding program review, and processing partner verification</li>
          <li>Optional media documentation during the visit</li>
          <li>I'll reach out to coordinate timing</li>
        </ul>
      `;

    const emailHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #0E0E0E; background: #F4F1EC; margin: 0; padding: 20px; }
          .container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border: 1px solid #A7A29A; }
          h1 { font-family: Georgia, serif; font-size: 26px; margin: 0 0 20px 0; }
          h3 { color: #0E0E0E; font-size: 16px; }
          p { margin: 12px 0; color: #6B4F3F; }
          .highlight { background: #F4F1EC; padding: 16px; margin: 16px 0; border-left: 3px solid #0E0E0E; }
          .divider { height: 1px; background: #A7A29A; margin: 24px 0; }
          .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #A7A29A; font-size: 12px; color: #A7A29A; }
          .doc-link { display: inline-block; padding: 8px 16px; margin: 4px 0; background: #F4F1EC; color: #0E0E0E; text-decoration: none; font-size: 13px; border: 1px solid #A7A29A; }
          .doc-link:hover { background: #E8E4DD; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>BuyHalfCow Partnership - Next Steps</h1>
          <p>Hi ${esc(rancherName)},</p>
          ${hasCallContext
            ? `<p>Thanks for connecting with us! Here's everything you need to get started:</p>`
            : `<p>We're excited to have you in the BuyHalfCow network! Here's everything you need to get started:</p>`
          }

          ${callSummary ? `
            <div class="highlight">
              <strong>Your Operation:</strong><br>
              ${esc(callSummary).replace(/\n/g, '<br>')}
            </div>
          ` : ''}

          ${confirmedCapacity ? `
            <div class="highlight">
              <strong>Capacity Confirmed:</strong> ${esc(String(confirmedCapacity))} orders/month
            </div>
          ` : ''}

          ${specialNotes ? `
            <div class="highlight">
              <strong>What Makes You A Great Fit:</strong><br>
              ${esc(specialNotes).replace(/\n/g, '<br>')}
            </div>
          ` : ''}

          <div class="divider"></div>

          <h2 style="font-family: Georgia, serif; font-size: 22px;">Next Steps</h2>

          <h3 style="margin: 20px 0 10px;">1. Review & Sign Commission Agreement</h3>
          <ul style="color: #6B4F3F; line-height: 1.8;">
            <li>10% commission on all verified referred sales</li>
            <li>Buyers pay you directly — you control pricing</li>
            <li>24-month commission term from first referral</li>
            <li>No upfront fees</li>
          </ul>
          <div style="text-align: center; margin: 24px 0;">
            <a href="${signingLink}" style="display: inline-block; padding: 16px 40px; background: #0E0E0E; color: #F4F1EC; text-decoration: none; font-weight: bold; font-size: 14px; letter-spacing: 1px; text-transform: uppercase;">
              REVIEW & SIGN AGREEMENT
            </a>
          </div>
          <p style="font-size: 12px; color: #A7A29A; text-align: center;">This link is valid for 30 days.</p>

          <h3 style="margin: 20px 0 10px;">2. Review the Info Packet & Media Agreement</h3>
          <ul style="color: #6B4F3F; line-height: 1.8;">
            <li>Rancher Info Packet covers the full process from verification to listing</li>
            <li>Media Agreement covers content usage and marketing guidelines</li>
            <li>We'll need: ranch photos, beef type details, pricing, certifications</li>
          </ul>
          <div style="margin: 12px 0;">
            ${docs.map(d => `<a href="${SITE_URL}/docs/${d.name}" class="doc-link">${d.label}</a><br>`).join('')}
          </div>

          ${verificationHtml}

          <h3 style="margin: 20px 0 10px;">4. Go Live</h3>
          <ul style="color: #6B4F3F; line-height: 1.8;">
            <li>After signing, you'll be taken straight to your dashboard to set up your ranch page</li>
            <li>Once verified, your profile goes live and you start receiving qualified buyer leads</li>
            <li>We'll stay in close contact throughout the process</li>
          </ul>

          <div class="divider"></div>

          <p><strong>Questions?</strong> Reply to this email or text me directly.</p>

          <p>Looking forward to working with you!</p>

          <div class="footer">
            <p>— Benjamin, Founder<br>BuyHalfCow — Private Network for American Ranch Beef</p>
          </div>
        </div>
      </body>
      </html>
    `;

    const emailResult = await sendEmail({
      to: rancherEmail,
      subject: 'BuyHalfCow Partnership - Next Steps & Agreement',
      html: emailHtml,
    });

    if (!emailResult.success) {
      console.error('Email send failed for', rancherEmail, emailResult.error);
      return NextResponse.json({ error: `Email failed to send to ${rancherEmail}` }, { status: 500 });
    }

    try {
      await sendTelegramUpdate(
        `📦 <b>Onboarding docs sent</b> to <b>${rancherName}</b> (${rancher['State'] || 'Unknown state'})\nCapacity: ${confirmedCapacity} orders/month`
      );
    } catch (e) {
      console.error('Telegram notification error:', e);
    }

    return NextResponse.json({ success: true, message: `Onboarding package sent to ${rancherName}` });
  } catch (error: any) {
    console.error('Error sending onboarding package:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
