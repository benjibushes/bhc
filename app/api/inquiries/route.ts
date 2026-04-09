import { NextResponse } from 'next/server';
import { createRecord, getAllRecords, getRecordById } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendInquiryToRancher, sendInquiryAlertToAdmin } from '@/lib/email';

export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    let body: any;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const { consumerId, rancherId, consumerName, consumerEmail, consumerPhone, message, interestType } = body;

    if (!rancherId || !consumerName || !consumerEmail || !message) {
      return NextResponse.json({ error: 'Missing required fields for inquiry' }, { status: 400 });
    }

    // Look up rancher to get verified email and ranch name
    let rancherEmail = '';
    let ranchName = '';
    try {
      const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);
      rancherEmail = rancher['Email'] || '';
      ranchName = rancher['Ranch Name'] || '';
    } catch (err) {
      console.error('Could not fetch rancher for inquiry:', err);
      return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });
    }

    if (!rancherEmail || !ranchName) {
      return NextResponse.json({ error: 'Rancher data incomplete' }, { status: 400 });
    }

    // Map interest type to title case for Airtable select field
    const interestLabels: Record<string, string> = {
      half_cow: 'Half Cow',
      quarter_cow: 'Quarter Cow',
      whole_cow: 'Whole Cow',
      custom: 'Custom Order',
    };
    const normalizedInterestType = interestType ? (interestLabels[interestType] || interestType) : '';

    // Optionally fetch consumer for campaign tracking
    let source = 'direct';
    if (consumerId) {
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
    }

    const inquiryFields: any = {
      'Rancher ID': rancherId,
      'Consumer Name': consumerName,
      'Consumer Email': consumerEmail,
      'Consumer Phone': consumerPhone || '',
      'Rancher Email': rancherEmail,
      'Ranch Name': ranchName,
      'Message': message,
      'Status': 'Pending',
      'Sale Amount': 0,
      'Commission Amount': 0,
      'Source': source,
    };

    if (consumerId) {
      inquiryFields['Consumer ID'] = consumerId;
    }

    if (normalizedInterestType) {
      inquiryFields['Interest Type'] = normalizedInterestType;
    }

    const record = await createRecord(TABLES.INQUIRIES, inquiryFields);

    // ONLY send alert to admin - rancher email goes out AFTER approval
    await sendInquiryAlertToAdmin({
      ranchName,
      rancherEmail,
      consumerName,
      consumerEmail,
      interestType: normalizedInterestType,
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
