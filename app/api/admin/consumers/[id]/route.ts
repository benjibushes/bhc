import { NextResponse, NextRequest } from 'next/server';
import { getRecordById, updateRecord, deleteRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendConsumerApproval } from '@/lib/email';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-member-secret-change-me';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const record: any = await getRecordById(TABLES.CONSUMERS, id);
    if (!record) {
      return NextResponse.json({ error: 'Consumer not found' }, { status: 404 });
    }
    return NextResponse.json({
      id: record.id,
      first_name: record['Full Name'] || '',
      email: record['Email'] || '',
      phone: record['Phone'] || '',
      state: record['State'] || '',
      interests: record['Interests'] || [],
      status: record['Status'] || 'Pending',
      membership: record['Membership'] || 'none',
      segment: record['Segment'] || '',
      order_type: record['Order Type'] || '',
      budget_range: record['Budget Range'] || '',
      notes: record['Notes'] || '',
      lead_source: record['Lead Source'] || record['Source'] || '',
      intent_score: record['Intent Score'] || 0,
      intent_classification: record['Intent Classification'] || '',
      referral_status: record['Referral Status'] || 'Unmatched',
      admin_notes: record['Admin Notes'] || '',
      last_contacted: record['Last Contacted'] || '',
      campaign: record['Campaign'] || '',
      created_at: record['Created'] || record.createdTime || new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('API error fetching consumer:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const body = await request.json();

    const fields: any = {};
    if (body.status) fields['Status'] = body.status;
    if (body.fullName) fields['Full Name'] = body.fullName;
    if (body.email) fields['Email'] = body.email;
    if (body.phone !== undefined) fields['Phone'] = body.phone;
    if (body.state) fields['State'] = body.state;
    if (body.membership) fields['Membership'] = body.membership;
    if (body.admin_notes !== undefined) fields['Admin Notes'] = body.admin_notes;
    if (body.last_contacted !== undefined) fields['Last Contacted'] = body.last_contacted;

    // Check if this is an approval — need current record to detect status change
    let shouldSendApproval = false;
    if (body.status === 'approved') {
      try {
        const current: any = await getRecordById(TABLES.CONSUMERS, id);
        const currentStatus = (current['Status'] || '').toLowerCase();
        if (currentStatus !== 'approved' && currentStatus !== 'active') {
          shouldSendApproval = true;
        }
      } catch { /* proceed with update */ }
    }

    const updatedRecord = await updateRecord(TABLES.CONSUMERS, id, fields);

    if (shouldSendApproval) {
      try {
        const consumer: any = await getRecordById(TABLES.CONSUMERS, id);
        const email = consumer['Email'];
        const name = consumer['Full Name'] || '';
        const firstName = name.split(' ')[0] || 'there';
        const segment = consumer['Segment'] || '';

        if (email) {
          const token = jwt.sign(
            { type: 'member-login', consumerId: id, email: email.trim().toLowerCase() },
            JWT_SECRET,
            { expiresIn: '7d' }
          );
          const loginUrl = `${SITE_URL}/member/verify?token=${token}`;
          await sendConsumerApproval({ firstName, email, loginUrl, segment });
        }
      } catch (emailErr) {
        console.error('Failed to send approval email (non-fatal):', emailErr);
      }
    }

    return NextResponse.json(updatedRecord);
  } catch (error: any) {
    console.error('API error updating consumer:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    await deleteRecord(TABLES.CONSUMERS, id);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('API error deleting consumer:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
