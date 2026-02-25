import { NextResponse } from 'next/server';
import { updateRecord, getRecordById } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendEmail } from '@/lib/email';
import { sendTelegramUpdate } from '@/lib/telegram';
import { readFile } from 'fs/promises';
import { join } from 'path';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { callSummary, confirmedCapacity, specialNotes, includeVerification } = body;

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

    // Try to read PDF attachments
    const attachments: { filename: string; content: Buffer }[] = [];
    const docsDir = join(process.cwd(), 'public', 'docs');
    const docFiles = [
      { name: 'BHC_Partnership_Agreement.pdf', label: 'Partnership Agreement' },
      { name: 'BHC_Marketing_Guidelines.pdf', label: 'Marketing Guidelines' },
      { name: 'Rancher_Onboarding_Checklist.pdf', label: 'Onboarding Checklist' },
    ];

    for (const doc of docFiles) {
      try {
        const content = await readFile(join(docsDir, doc.name));
        attachments.push({ filename: doc.name, content });
      } catch {
        // PDF not found, skip attachment
      }
    }

    const verificationHtml = includeVerification
      ? `
        <h3 style="margin: 20px 0 10px;">3. Verification Process</h3>
        <ul style="color: #6B4F3F; line-height: 1.8;">
          <li>Ship 1 sample cut to our verification address (details in checklist)</li>
          <li>We'll verify quality and document the results</li>
          <li>Estimated timeline: 2-3 weeks</li>
        </ul>
      `
      : `
        <h3 style="margin: 20px 0 10px;">3. Verification Process</h3>
        <ul style="color: #6B4F3F; line-height: 1.8;">
          <li>We'll schedule a ranch tour during our visit to your state</li>
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
        </style>
      </head>
      <body>
        <div class="container">
          <h1>BuyHalfCow Partnership - Next Steps</h1>
          <p>Hi ${rancherName},</p>
          <p>Great talking with you today! Here's what we discussed:</p>

          ${callSummary ? `
            <div class="highlight">
              <strong>Your Operation:</strong><br>
              ${callSummary.replace(/\n/g, '<br>')}
            </div>
          ` : ''}

          ${confirmedCapacity ? `
            <div class="highlight">
              <strong>Capacity Confirmed:</strong> ${confirmedCapacity} orders/month
            </div>
          ` : ''}

          ${specialNotes ? `
            <div class="highlight">
              <strong>What Makes You A Great Fit:</strong><br>
              ${specialNotes.replace(/\n/g, '<br>')}
            </div>
          ` : ''}

          <div class="divider"></div>

          <h2 style="font-family: Georgia, serif; font-size: 22px;">Next Steps</h2>

          <h3 style="margin: 20px 0 10px;">1. Review & Sign Agreement (attached)</h3>
          <ul style="color: #6B4F3F; line-height: 1.8;">
            <li>Commission terms: 10% on BHC referrals</li>
            <li>Direct payment from buyer to you</li>
            <li>We invoice monthly for closed deals</li>
          </ul>

          <h3 style="margin: 20px 0 10px;">2. Complete Your Profile</h3>
          <ul style="color: #6B4F3F; line-height: 1.8;">
            <li>High-quality ranch photos</li>
            <li>Beef type details and pricing</li>
            <li>Any certifications</li>
          </ul>

          ${verificationHtml}

          <h3 style="margin: 20px 0 10px;">4. Go Live</h3>
          <ul style="color: #6B4F3F; line-height: 1.8;">
            <li>Profile activated on platform</li>
            <li>Start receiving qualified buyer leads</li>
            <li>We'll stay in close contact</li>
          </ul>

          ${attachments.length > 0 ? `
            <div class="divider"></div>
            <p><strong>Documents Attached:</strong></p>
            <ul style="color: #6B4F3F;">
              ${attachments.map(a => `<li>${a.filename.replace('BHC_', '').replace('.pdf', '').replace(/_/g, ' ')}</li>`).join('')}
            </ul>
          ` : ''}

          <div class="divider"></div>

          <p><strong>Questions?</strong> Reply to this email or text me directly.</p>

          <p>Looking forward to working with you!</p>

          <div class="footer">
            <p>— Benji, Founder<br>BuyHalfCow — Private Network for American Ranch Beef</p>
          </div>
        </div>
      </body>
      </html>
    `;

    await sendEmail({
      to: rancherEmail,
      subject: 'BuyHalfCow Partnership - Next Steps & Agreement',
      html: emailHtml,
    });

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
