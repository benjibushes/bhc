import { NextResponse } from 'next/server';
import { createRecord, getAllRecords, getRecordById } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendInquiryToRancher, sendInquiryAlertToAdmin } from '@/lib/email';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { consumerId, rancherId, consumerName, consumerEmail, consumerPhone, rancherEmail, ranchName, message, interestType } = body;

    if (!consumerId || !rancherId || !consumerName || !consumerEmail || !rancherEmail || !ranchName || !message) {
      return NextResponse.json({ error: 'Missing required fields for inquiry' }, { status: 400 });
    }

    // Fetch consumer to inherit campaign/source
    let source = 'direct';
    try {
      const consumer: any = await getRecordById(TABLES.CONSUMERS, consumerId);
      if (consumer?.['Campaign']) {
        source = consumer['Campaign'] as string;
      } else if (consumer?.['Source']) {
        source = consumer['Source'] as string;
      }
    } catch (err) {
      console.log('Could not fetch consumer for campaign tracking:', err);
    }

    const inquiryFields: any = {
      'Consumer ID': consumerId,
      'Rancher ID': rancherId,
      'Consumer Name': consumerName,
      'Consumer Email': consumerEmail,
      'Consumer Phone': consumerPhone || '',
      'Rancher Email': rancherEmail,
      'Ranch Name': ranchName,
      'Message': message,
      'Status': 'Pending', // Changed from 'Sent' - requires admin approval
      'Sale Amount': 0,
      'Commission Amount': 0,
      // Omit 'Commission Paid' - Airtable checkbox defaults to unchecked
      'Source': source, // Track campaign attribution
    };

    // Only add Interest Type if provided
    if (interestType) {
      inquiryFields['Interest Type'] = interestType;
    }

    const record = await createRecord(TABLES.INQUIRIES, inquiryFields);

    // ONLY send alert to admin - rancher email goes out AFTER approval
    await sendInquiryAlertToAdmin({
      ranchName,
      rancherEmail,
      consumerName,
      consumerEmail,
      interestType: interestType || '',
      message,
      inquiryId: record.id,
    });

    return NextResponse.json({ success: true, inquiry: record }, { status: 201 });
  } catch (error: any) {
    console.error('API error creating inquiry:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

export async function GET() {
  try {
    const inquiries = await getAllRecords(TABLES.INQUIRIES);
    
    // Fetch rancher details and normalize field names
    const inquiriesWithRanchers = await Promise.all(
      inquiries.map(async (inquiry: any) => {
        const rancherId = inquiry['Rancher ID'];
        let rancherData = {
          ranch_name: 'Unknown',
          operator_name: 'Unknown',
          email: '',
          state: '',
        };
        
        if (rancherId) {
          try {
            const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);
            rancherData = {
              ranch_name: rancher['Ranch Name'] || 'Unknown',
              operator_name: rancher['Operator Name'] || 'Unknown',
              email: rancher['Email'] || '',
              state: rancher['State'] || '',
            };
          } catch (err) {
            console.log(`Could not fetch rancher ${rancherId}:`, err);
          }
        }
        
        // Transform Airtable field names to snake_case for frontend
        return {
          id: inquiry.id,
          consumer_name: inquiry['Consumer Name'] || '',
          consumer_email: inquiry['Consumer Email'] || '',
          consumer_phone: inquiry['Consumer Phone'] || '',
          message: inquiry['Message'] || '',
          interest_type: inquiry['Interest Type'] || '',
          status: inquiry['Status'] || 'Pending',
          sale_amount: inquiry['Sale Amount'] || 0,
          commission_amount: inquiry['Commission Amount'] || 0,
          commission_paid: inquiry['Commission Paid'] || false,
          notes: inquiry['Notes'] || null,
          created_at: inquiry['Created'] || new Date().toISOString(),
          ranchers: rancherData,
        };
      })
    );
    
    return NextResponse.json(inquiriesWithRanchers);
  } catch (error: any) {
    console.error('API error fetching inquiries:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
