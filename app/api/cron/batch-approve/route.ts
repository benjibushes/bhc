import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendConsumerApproval } from '@/lib/email';
import { sendTelegramUpdate } from '@/lib/telegram';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-member-secret-change-me';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

// Runs daily at 9am MT — processes pending consumers who qualify for auto-approval
// and kicks off rancher matching for approved Beef Buyers
export async function POST(request: Request) {
  try {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      const { searchParams } = new URL(request.url);
      const secret = searchParams.get('secret');
      if (secret !== process.env.CRON_SECRET || !process.env.CRON_SECRET) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    // Get all pending consumers
    const pending = await getAllRecords(
      TABLES.CONSUMERS,
      `{Status} = "Pending"`
    );

    if (pending.length === 0) {
      await sendTelegramUpdate('⏳ Batch approve ran — no pending consumers.');
      return NextResponse.json({ success: true, approved: 0, skipped: 0 });
    }

    let approved = 0;
    let skipped = 0;
    let matched = 0;
    const errors: string[] = [];

    for (const consumer of pending as any[]) {
      try {
        const intentClassification = consumer['Intent Classification'] || '';
        // Derive segment: use stored Segment field if present, otherwise infer from Order Type/Budget
        // (existing records pre-date the Segment field being added to Airtable)
        const rawSegment = consumer['Segment'] || '';
        const hasBeefBuyerSignals = !!(consumer['Order Type'] || consumer['Budget']);
        const segment = rawSegment || (hasBeefBuyerSignals ? 'Beef Buyer' : 'Community');
        const email = consumer['Email'];
        const firstName = (consumer['Full Name'] || '').split(' ')[0];
        const consumerId = consumer['id'];

        // Determine if this consumer qualifies for auto-approval
        const qualifies =
          segment === 'Community' ||
          (segment === 'Beef Buyer' &&
            (intentClassification === 'High' || intentClassification === 'Medium'));

        if (!qualifies) {
          skipped++;
          continue;
        }

        // Approve the consumer
        await updateRecord(TABLES.CONSUMERS, consumerId, { 'Status': 'Approved' });

        // Send magic link email
        if (email) {
          const token = jwt.sign(
            { type: 'member-login', consumerId, email: email.trim().toLowerCase() },
            JWT_SECRET,
            { expiresIn: '7d' }
          );
          const loginUrl = `${SITE_URL}/member/verify?token=${token}`;
          await sendConsumerApproval({ firstName, email, loginUrl, segment });
        }

        approved++;

        // Trigger matching for Beef Buyers
        if (segment === 'Beef Buyer' && consumer['State']) {
          try {
            const matchRes = await fetch(`${SITE_URL}/api/matching/suggest`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                buyerState: consumer['State'],
                buyerId: consumerId,
                buyerName: consumer['Full Name'],
                buyerEmail: email,
                buyerPhone: consumer['Phone'],
                orderType: consumer['Order Type'],
                budgetRange: consumer['Budget'],
                intentScore: consumer['Intent Score'],
                intentClassification,
                notes: consumer['Notes'],
              }),
            });
            if (matchRes.ok) matched++;
          } catch (matchErr) {
            console.error(`Matching error for consumer ${consumerId}:`, matchErr);
          }
        }
      } catch (err: any) {
        console.error(`Error processing consumer ${consumer['id']}:`, err);
        errors.push(consumer['Full Name'] || consumer['id']);
      }
    }

    const summary = `✅ <b>Batch Approval Complete</b>

📥 Pending reviewed: ${pending.length}
✅ Approved: ${approved}
⏭️ Skipped (low intent): ${skipped}
🤝 Matched to ranchers: ${matched}${errors.length > 0 ? `\n⚠️ Errors: ${errors.length} (${errors.slice(0, 3).join(', ')})` : ''}`;

    await sendTelegramUpdate(summary);

    return NextResponse.json({ success: true, approved, skipped, matched, errors: errors.length });
  } catch (error: any) {
    console.error('Batch approve error:', error);
    await sendTelegramUpdate(`⚠️ Batch approval cron failed: ${error.message}`).catch(() => {});
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
