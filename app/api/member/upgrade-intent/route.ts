import { NextResponse } from 'next/server';
import { getRecordById, updateRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-member-secret-change-me';
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
    const cookieStore = await cookies();
    const sessionCookie = cookieStore.get('bhc-member-auth');

    if (!sessionCookie?.value) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    let memberId = '';
    let memberEmail = '';
    try {
      const decoded: any = jwt.verify(sessionCookie.value, JWT_SECRET);
      if (decoded.type === 'member-session') {
        memberId = decoded.consumerId || '';
        memberEmail = decoded.email || '';
      }
    } catch {
      return NextResponse.json({ error: 'Session expired' }, { status: 401 });
    }

    if (!memberId) {
      return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
    }

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
      'Budget Range': budgetRange || '',
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
          headers: { 'Content-Type': 'application/json' },
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
