import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendEmail } from '@/lib/email';
import { sendTelegramUpdate } from '@/lib/telegram';

export async function GET(request: Request) {
  try {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      const url = new URL(request.url);
      const secret = url.searchParams.get('secret');
      if (secret !== process.env.CRON_SECRET && process.env.CRON_SECRET) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    const ranchers = await getAllRecords(TABLES.RANCHERS);
    const activeRanchers = ranchers.filter((r: any) =>
      r['Active Status'] === 'Active' && r['Agreement Signed'] === true
    );

    const month = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });
    let sentCount = 0;

    for (const rancher of activeRanchers as any[]) {
      const email = rancher['Email'];
      const name = rancher['Operator Name'] || rancher['Ranch Name'] || 'Rancher';

      if (!email) continue;

      await sendEmail({
        to: email,
        subject: `BuyHalfCow Monthly Sales Report - ${month}`,
        html: `
          <!DOCTYPE html>
          <html>
          <head>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #0E0E0E; background: #F4F1EC; margin: 0; padding: 20px; }
              .container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border: 1px solid #A7A29A; }
              h1 { font-family: Georgia, serif; font-size: 24px; }
              p { color: #6B4F3F; }
              .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #A7A29A; font-size: 12px; color: #A7A29A; }
            </style>
          </head>
          <body>
            <div class="container">
              <h1>Monthly Sales Report</h1>
              <p>Hi ${name},</p>
              <p>Please report any sales from BuyHalfCow referrals last month.</p>
              <p>Simply reply to this email with:</p>
              <ul style="color: #6B4F3F;">
                <li>Number of sales completed</li>
                <li>Total sale amount</li>
                <li>Any buyer feedback</li>
              </ul>
              <p>If no sales were made through BuyHalfCow referrals, reply <strong>"No sales"</strong>.</p>
              <p>This helps us track commissions and improve the matching process.</p>
              <div class="footer">
                <p>— Benji, BuyHalfCow</p>
              </div>
            </div>
          </body>
          </html>
        `,
      });

      sentCount++;

      // Check for missed reports
      const missedReports = rancher['Consecutive Missed Reports'] || 0;
      if (missedReports >= 2) {
        await updateRecord(TABLES.RANCHERS, rancher.id, {
          'Active Status': 'Non-Compliant',
        });
      }
    }

    try {
      await sendTelegramUpdate(
        `📋 <b>Compliance reminders sent</b>\n\nSent to ${sentCount} active rancher(s) for ${month}`
      );
    } catch (e) {
      console.error('Telegram error:', e);
    }

    return NextResponse.json({
      success: true,
      month,
      sentCount,
    });
  } catch (error: any) {
    console.error('Compliance reminder error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
