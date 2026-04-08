import { NextResponse } from 'next/server';
import { getRancherBySlug, getAllRecords, updateRecord, escapeAirtableValue, TABLES } from '@/lib/airtable';
import { sendTrackedContactEmail } from '@/lib/email';
import { sendTelegramUpdate } from '@/lib/telegram';

function isValidEmail(email: string): boolean {
  const re = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  return re.test(email);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await params;

    let body: any;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { name, email, phone, message } = body;

    // Validate required fields
    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      return NextResponse.json({ error: 'Please enter your name' }, { status: 400 });
    }

    if (!email || typeof email !== 'string' || !isValidEmail(email.trim())) {
      return NextResponse.json({ error: 'Please enter a valid email address' }, { status: 400 });
    }

    if (!message || typeof message !== 'string' || message.trim().length < 5) {
      return NextResponse.json({ error: 'Please enter a message' }, { status: 400 });
    }

    if (message.length > 5000) {
      return NextResponse.json({ error: 'Message must be under 5000 characters' }, { status: 400 });
    }

    // Look up the rancher
    const rancher: any = await getRancherBySlug(slug);
    if (!rancher) {
      return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });
    }

    const rancherName = rancher['Ranch Name'] || rancher['Operator Name'] || 'Ranch';
    const rancherEmail = rancher['Email'] || '';
    const operatorName = rancher['Operator Name'] || rancherName;

    if (!rancherEmail) {
      return NextResponse.json({ error: 'This rancher cannot receive messages at this time' }, { status: 400 });
    }

    // Check for matching referral and update status
    try {
      const referrals = await getAllRecords(
        TABLES.REFERRALS,
        `AND({Buyer Email} = "${escapeAirtableValue(email.trim().toLowerCase())}", {Suggested Rancher Name} = "${escapeAirtableValue(rancherName)}")`
      );

      for (const referral of referrals) {
        if ((referral as any)['Status'] === 'Intro Sent') {
          await updateRecord(TABLES.REFERRALS, referral.id, {
            'Status': 'Rancher Contacted',
          });
        }
      }
    } catch (e) {
      console.error('Error updating referral status:', e);
      // Non-blocking — continue sending the message
    }

    // Send email to rancher
    await sendTrackedContactEmail({
      rancherName: operatorName,
      rancherEmail,
      buyerName: name.trim(),
      buyerEmail: email.trim().toLowerCase(),
      buyerPhone: phone?.trim() || '',
      message: message.trim(),
    });

    // Send Telegram notification
    try {
      await sendTelegramUpdate(
        `\u{1F4AC} ${name.trim()} messaged ${rancherName} via contact page\n\nEmail: ${email.trim()}\n${phone ? `Phone: ${phone.trim()}\n` : ''}Message: ${message.trim().slice(0, 200)}${message.length > 200 ? '...' : ''}`
      );
    } catch (e) {
      console.error('Telegram notification error:', e);
      // Non-blocking
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Error in rancher contact API:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
