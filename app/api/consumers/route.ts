import { NextResponse } from 'next/server';
import { createRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendConsumerConfirmation, sendAdminAlert } from '@/lib/email';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { fullName, email, phone, state, interestBeef, interestLand, interestMerch, interestAll, source, campaign, utmParams } = body;

    if (!fullName || !email || !state) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Build interests array
    const interests = [];
    if (interestBeef) interests.push('Beef');
    if (interestLand) interests.push('Land');
    if (interestMerch) interests.push('Merch');
    if (interestAll) interests.push('All');

    // Create record in Airtable with campaign tracking
    const record = await createRecord(TABLES.CONSUMERS, {
      'Full Name': fullName,
      'Email': email,
      'Phone': phone || '',
      'State': state,
      'Interests': interests,
      'Status': 'Pending',
      'Source': source || 'organic',
      'Campaign': campaign || '',
      'UTM Parameters': utmParams || '',
    });

    // Send confirmation email to consumer
    await sendConsumerConfirmation({
      firstName: fullName.split(' ')[0],
      email,
      state,
    });

    // Send alert to admin
    await sendAdminAlert({
      type: 'consumer',
      name: fullName,
      email,
      details: {
        State: state,
        Interests: interests.join(', '),
        Phone: phone || 'Not provided',
      },
    });

    return NextResponse.json({ success: true, consumer: record }, { status: 201 });
  } catch (error: any) {
    console.error('API error creating consumer:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
