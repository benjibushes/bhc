import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendEmail } from '@/lib/email';
import jwt from 'jsonwebtoken';
import { sendTelegramUpdate } from '@/lib/telegram';

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-backfill-secret-change-me';
const EXPIRY_DAYS = parseInt(process.env.BACKFILL_LINK_EXPIRY_DAYS || '30');

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { batchSize = 50 } = body;

    const consumers = await getAllRecords(TABLES.CONSUMERS);

    const needsBackfill = consumers.filter((c: any) =>
      !c['Order Type'] &&
      !c['Budget Range'] &&
      c['Email'] &&
      !c['Backfill Email Sent']
    );

    const batch = needsBackfill.slice(0, batchSize);
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';
    let sentCount = 0;

    for (const consumer of batch as any[]) {
      const token = jwt.sign(
        { email: consumer['Email'], consumerId: consumer.id, type: 'backfill' },
        JWT_SECRET,
        { expiresIn: `${EXPIRY_DAYS}d` }
      );
      const link = `${siteUrl}/update-profile?token=${token}`;
      const name = consumer['Full Name'] || 'there';
      const state = consumer['State'] || 'your state';

      try {
        await sendEmail({
          to: consumer['Email'],
          subject: 'Quick Update: Help Us Match You With Ranchers',
          html: `
            <!DOCTYPE html>
            <html>
            <head>
              <style>
                body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #0E0E0E; background: #F4F1EC; margin: 0; padding: 20px; }
                .container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border: 1px solid #A7A29A; }
                h1 { font-family: Georgia, serif; font-size: 26px; margin: 0 0 20px; }
                p { color: #6B4F3F; margin: 12px 0; }
                .cta { display: inline-block; padding: 16px 32px; background: #0E0E0E; color: #F4F1EC !important; text-decoration: none; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; margin: 20px 0; }
                .divider { height: 1px; background: #A7A29A; margin: 24px 0; }
                .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #A7A29A; font-size: 12px; color: #A7A29A; }
              </style>
            </head>
            <body>
              <div class="container">
                <h1>Help Us Match You</h1>
                <p>Hi ${name.split(' ')[0]},</p>
                <p>You signed up for BuyHalfCow access in <strong>${state}</strong>!</p>
                <p>We're now matching buyers with verified ranchers in your area. To speed up your match, update your preferences:</p>
                <div class="divider"></div>
                <div style="text-align: center;">
                  <a href="${link}" class="cta">Update Your Preferences</a>
                </div>
                <div class="divider"></div>
                <p>Takes 30 seconds. You'll hear from us within 48 hours.</p>
                <div class="footer">
                  <p>— Benji, Founder<br>BuyHalfCow — Private Network for American Ranch Beef</p>
                </div>
              </div>
            </body>
            </html>
          `,
        });

        await updateRecord(TABLES.CONSUMERS, consumer.id, {
          'Backfill Email Sent': true,
          'Backfill Email Sent At': new Date().toISOString(),
        });

        sentCount++;

        // Rate limit: ~1 per second to avoid spam flags
        if (sentCount < batch.length) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } catch (e) {
        console.error(`Error sending backfill email to ${consumer['Email']}:`, e);
      }
    }

    try {
      await sendTelegramUpdate(
        `📧 <b>Backfill campaign sent</b>\n\n${sentCount} emails sent (${needsBackfill.length - sentCount} remaining)`
      );
    } catch (e) {
      console.error('Telegram error:', e);
    }

    return NextResponse.json({
      success: true,
      sentCount,
      remaining: needsBackfill.length - sentCount,
      totalNeedingBackfill: needsBackfill.length,
    });
  } catch (error: any) {
    console.error('Error sending backfill campaign:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
