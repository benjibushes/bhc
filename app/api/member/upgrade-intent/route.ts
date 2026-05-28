import { NextResponse } from 'next/server';
import { getRecordById, updateRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { resolveBuyerSession } from '@/lib/buyerAuth';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

function calculateIntentScore(orderType: string, budgetRange: string): number {
  let score = 30; // Base: they're explicitly requesting beef
  if (orderType === 'Whole') score += 30;
  else if (orderType === 'Half') score += 20;
  else if (orderType === 'Quarter') score += 10;
  if (budgetRange === '$2000+') score += 25;
  else if (budgetRange === '$1000-$2000') score += 20;
  else if (budgetRange === '$500-$1000') score += 10;
  return score;
}

function classifyIntent(score: number): string {
  if (score >= 60) return 'High';
  if (score >= 30) return 'Medium';
  return 'Low';
}

export async function PATCH(request: Request) {
  try {
    const session = await resolveBuyerSession(request);
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    const memberId = session.consumerId;
    const memberEmail = session.email;

    const body = await request.json();
    const { orderType, budgetRange } = body;

    if (!orderType) {
      return NextResponse.json({ error: 'Order type is required' }, { status: 400 });
    }

    const intentScore = calculateIntentScore(orderType, budgetRange || '');
    const intentClassification = classifyIntent(intentScore);

    await updateRecord(TABLES.CONSUMERS, memberId, {
      'Segment': 'Beef Buyer',
      'Intent Score': intentScore,
      'Intent Classification': intentClassification,
      'Order Type': orderType,
      'Budget': budgetRange || '',
    });

    const consumer: any = await getRecordById(TABLES.CONSUMERS, memberId);
    const fullName = consumer['Full Name'] || '';
    const phone = consumer['Phone'] || '';
    const state = consumer['State'] || '';

    // Trigger matching
    if (state) {
      try {
        await fetch(`${SITE_URL}/api/matching/suggest`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(process.env.INTERNAL_API_SECRET ? { 'x-internal-secret': process.env.INTERNAL_API_SECRET } : {}),
          },
          body: JSON.stringify({
            buyerState: state,
            buyerId: memberId,
            buyerName: fullName,
            buyerEmail: memberEmail,
            buyerPhone: phone,
            orderType,
            budgetRange,
            intentScore,
            intentClassification,
          }),
        });
      } catch (matchError) {
        console.error('Error calling matching engine:', matchError);
      }
    }

    return NextResponse.json({ success: true, segment: 'Beef Buyer', intentScore, intentClassification });
  } catch (error: any) {
    console.error('Error upgrading intent:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
