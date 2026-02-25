import { NextResponse } from 'next/server';
import { getAllRecords, createRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendBroadcastEmail } from '@/lib/email';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { subject, message, campaignName, audienceType, selectedStates, includeCTA, ctaText, ctaLink } = body;

    if (!subject || !message || !campaignName) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Fetch recipients based on audience type
    let recipients: Array<{ email: string; name: string }> = [];

    if (audienceType === 'consumers') {
      const consumers = await getAllRecords(TABLES.CONSUMERS);
      recipients = consumers.map((c: any) => ({
        email: c['Email'] || '',
        name: c['Full Name'] || 'Member',
      })).filter((r: any) => r.email);
    } else if (audienceType === 'consumers-by-state') {
      const consumers = await getAllRecords(TABLES.CONSUMERS);
      recipients = consumers
        .filter((c: any) => selectedStates.includes(c['State']))
        .map((c: any) => ({
          email: c['Email'] || '',
          name: c['Full Name'] || 'Member',
        }))
        .filter((r: any) => r.email);
    } else if (audienceType === 'ranchers') {
      const ranchers = await getAllRecords(TABLES.RANCHERS);
      recipients = ranchers.map((r: any) => ({
        email: r['Email'] || '',
        name: r['Operator Name'] || 'Rancher',
      })).filter((r: any) => r.email);
    }

    if (recipients.length === 0) {
      return NextResponse.json({ error: 'No recipients found' }, { status: 400 });
    }

    // Build CTA link with campaign tracking
    let fullCtaLink = ctaLink;
    if (includeCTA && ctaLink) {
      const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';
      if (!ctaLink.startsWith('http')) {
        fullCtaLink = `${baseUrl}${ctaLink.startsWith('/') ? '' : '/'}${ctaLink}?campaign=${campaignName}`;
      } else {
        fullCtaLink = `${ctaLink}${ctaLink.includes('?') ? '&' : '?'}campaign=${campaignName}`;
      }
    }

    // Send emails to all recipients
    const sendPromises = recipients.map(recipient =>
      sendBroadcastEmail({
        to: recipient.email,
        name: recipient.name,
        subject,
        message,
        campaignName,
        includeCTA,
        ctaText: ctaText || 'Learn More',
        ctaLink: fullCtaLink,
      })
    );

    await Promise.all(sendPromises);

    // Log campaign to Airtable
    try {
      await createRecord(TABLES.CAMPAIGNS, {
        'Campaign Name': campaignName,
        'Subject Line': subject,
        'Message Body': message,
        'Audience Filter': audienceType === 'consumers-by-state' 
          ? `state:${selectedStates.join(',')}` 
          : audienceType,
        'Sent Date': new Date().toISOString(),
        'Recipients Count': recipients.length,
        'Link Clicks': 0,
      });
    } catch (campaignError) {
      console.error('Failed to log campaign (non-fatal):', campaignError);
      // Don't fail the whole request if campaign logging fails
    }

    return NextResponse.json({ 
      success: true, 
      recipientCount: recipients.length,
      campaignName 
    });
  } catch (error: any) {
    console.error('Error sending broadcast email:', error);
    return NextResponse.json({ error: error.message || 'Failed to send emails' }, { status: 500 });
  }
}


