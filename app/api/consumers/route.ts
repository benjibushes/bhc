import { NextResponse } from 'next/server';
import { createRecord, getAllRecords } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendConsumerConfirmation, sendConsumerApproval, sendAdminAlert } from '@/lib/email';
import { sendTelegramConsumerSignup } from '@/lib/telegram';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-member-secret-change-me';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

function deriveStatus(segment: string, intentClassification: string): string {
  if (segment === 'Community') return 'approved';
  if (segment === 'Beef Buyer' && (intentClassification === 'High' || intentClassification === 'Medium')) return 'approved';
  return 'pending';
}

function isValidEmail(email: string): boolean {
  const re = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!re.test(email)) return false;
  const throwaway = ['mailinator.com', 'guerrillamail.com', 'tempmail.com', 'throwaway.email', 'yopmail.com', 'sharklasers.com', 'grr.la', 'guerrillamailblock.com', '10minutemail.com', 'trashmail.com'];
  const domain = email.split('@')[1]?.toLowerCase();
  return !throwaway.includes(domain);
}

function isValidPhone(phone: string): boolean {
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15;
}

function isValidName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 100) return false;
  if (/^\d+$/.test(trimmed)) return false;
  if (/[<>{}()\[\]\\\/]/.test(trimmed)) return false;
  return true;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const {
      fullName, email, phone, state,
      orderType, budgetRange, notes,
      interestBeef, interestLand, interestMerch, interestAll,
      intentScore, intentClassification, segment,
      source, campaign, utmParams,
    } = body;

    if (!fullName || !email || !state) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    if (!isValidName(fullName)) {
      return NextResponse.json({ error: 'Please enter a valid name' }, { status: 400 });
    }

    if (!isValidEmail(email)) {
      return NextResponse.json({ error: 'Please enter a valid email address' }, { status: 400 });
    }

    if (phone && !isValidPhone(phone)) {
      return NextResponse.json({ error: 'Please enter a valid phone number' }, { status: 400 });
    }

    if (notes && notes.length > 2000) {
      return NextResponse.json({ error: 'Notes must be under 2000 characters' }, { status: 400 });
    }

    // Check for duplicate email
    try {
      const existing = await getAllRecords(TABLES.CONSUMERS, `{Email} = "${email.trim().toLowerCase()}"`);
      if (existing.length > 0) {
        return NextResponse.json({ error: 'This email is already registered. Check your inbox for your confirmation.' }, { status: 409 });
      }
    } catch (e) {
      console.error('Error checking duplicate email:', e);
    }

    const interests = [];
    if (interestBeef) interests.push('Beef');
    if (interestLand) interests.push('Land');
    if (interestMerch) interests.push('Merch');
    if (interestAll) interests.push('All');

    const consumerSegment = segment || 'Community';
    const status = deriveStatus(consumerSegment, intentClassification || '');
    const firstName = fullName.split(' ')[0];

    const record = await createRecord(TABLES.CONSUMERS, {
      'Full Name': fullName,
      'Email': email,
      'Phone': phone || '',
      'State': state,
      'Interests': interests,
      'Status': status,
      'Segment': consumerSegment,
      'Order Type': orderType || '',
      'Budget Range': budgetRange || '',
      'Notes': notes || '',
      'Source': source || 'organic',
      'Intent Score': intentScore || 0,
      'Intent Classification': intentClassification || '',
      'Referral Status': consumerSegment === 'Community' ? 'Community' : 'Unmatched',
      'Campaign': campaign || '',
      'UTM Parameters': utmParams || '',
    });

    if (status === 'approved') {
      const token = jwt.sign(
        { type: 'member-login', consumerId: record.id, email: email.trim().toLowerCase() },
        JWT_SECRET,
        { expiresIn: '7d' }
      );
      const loginUrl = `${SITE_URL}/member/verify?token=${token}`;
      await sendConsumerApproval({ firstName, email, loginUrl, segment: consumerSegment });
    } else {
      await sendConsumerConfirmation({ firstName, email, state });
    }

    await sendAdminAlert({
      type: 'consumer',
      name: fullName,
      email,
      details: {
        State: state,
        Segment: consumerSegment,
        Status: status,
        'Order Type': orderType || 'Not specified',
        'Budget': budgetRange || 'Not specified',
        'Intent Score': `${intentScore || 0} (${intentClassification || 'N/A'})`,
        Interests: interests.join(', '),
        Phone: phone || 'Not provided',
        Notes: notes || 'None',
      },
    });

    try {
      await sendTelegramConsumerSignup({
        consumerId: record.id,
        name: fullName,
        email,
        state,
        segment: consumerSegment,
        intentScore: intentScore || 0,
        intentClassification: intentClassification || '',
        status,
        orderType,
        budgetRange,
      });
    } catch (e) {
      console.error('Telegram consumer signup error:', e);
    }

    // Only trigger matching for approved Beef Buyers
    const shouldMatch = status === 'approved' && consumerSegment === 'Beef Buyer' && state;
    if (shouldMatch) {
      try {
        const matchRes = await fetch(
          `${SITE_URL}/api/matching/suggest`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              buyerState: state,
              buyerId: record.id,
              buyerName: fullName,
              buyerEmail: email,
              buyerPhone: phone,
              orderType,
              budgetRange,
              intentScore,
              intentClassification,
              notes,
            }),
          }
        );
        if (!matchRes.ok) {
          console.error('Matching engine returned non-OK status');
        }
      } catch (matchError) {
        console.error('Error calling matching engine:', matchError);
      }
    }

    return NextResponse.json({ success: true, consumer: record }, { status: 201 });
  } catch (error: any) {
    console.error('API error creating consumer:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
