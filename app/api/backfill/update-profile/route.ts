import { NextResponse } from 'next/server';
import { updateRecord, getRecordById } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import jwt from 'jsonwebtoken';
import { sendTelegramUpdate } from '@/lib/telegram';

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-backfill-secret-change-me';

function calculateIntentScore(data: { orderType: string; budgetRange: string; notes: string }) {
  let score = 10; // phone + email bonus (existing backfill users have both)

  if (data.orderType === 'Whole') score += 30;
  else if (data.orderType === 'Half') score += 20;
  else if (data.orderType === 'Quarter') score += 10;

  if (data.budgetRange === '$2000+') score += 25;
  else if (data.budgetRange === '$1000-$2000') score += 20;
  else if (data.budgetRange === '$500-$1000') score += 10;

  if (data.notes && data.notes.length > 20) score += 15;

  return score;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { token, orderType, budgetRange, notes } = body;

    if (!token) {
      return NextResponse.json({ error: 'No token provided' }, { status: 400 });
    }

    let decoded: any;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch {
      return NextResponse.json({ error: 'Invalid or expired link' }, { status: 400 });
    }

    if (decoded.type !== 'backfill') {
      return NextResponse.json({ error: 'Invalid token type' }, { status: 400 });
    }

    const consumerId = decoded.consumerId;
    const consumer: any = await getRecordById(TABLES.CONSUMERS, consumerId);

    const intentScore = calculateIntentScore({ orderType, budgetRange, notes });
    const intentClassification = intentScore >= 60 ? 'High' : intentScore >= 30 ? 'Medium' : 'Low';

    await updateRecord(TABLES.CONSUMERS, consumerId, {
      'Order Type': orderType || '',
      'Budget Range': budgetRange || '',
      'Notes': notes || '',
      'Intent Score': intentScore,
      'Intent Classification': intentClassification,
      'Referral Status': 'Unmatched',
    });

    // Trigger matching engine
    const buyerState = consumer['State'] || '';
    if (buyerState) {
      try {
        const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
        await fetch(`${siteUrl}/api/matching/suggest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            buyerState,
            buyerId: consumerId,
            buyerName: consumer['Full Name'] || '',
            buyerEmail: consumer['Email'] || '',
            buyerPhone: consumer['Phone'] || '',
            orderType,
            budgetRange,
            intentScore,
            intentClassification,
            notes,
          }),
        });
      } catch (e) {
        console.error('Error triggering matching:', e);
      }
    }

    try {
      await sendTelegramUpdate(
        `📝 <b>Backfill update</b>: <b>${consumer['Full Name']}</b> (${buyerState}) updated preferences\nOrder: ${orderType}, Budget: ${budgetRange}, Intent: ${intentScore} (${intentClassification})`
      );
    } catch (e) {
      console.error('Telegram error:', e);
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Error updating profile:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
