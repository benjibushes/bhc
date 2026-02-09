import { NextResponse, NextRequest } from 'next/server';
import { updateRecord, deleteRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const body = await request.json();

    // Build update fields object
    const fields: any = {};
    if (body.status) fields['Status'] = body.status;
    if (body.fullName) fields['Full Name'] = body.fullName;
    if (body.email) fields['Email'] = body.email;
    if (body.phone !== undefined) fields['Phone'] = body.phone;
    if (body.state) fields['State'] = body.state;

    const updatedRecord = await updateRecord(TABLES.CONSUMERS, id, fields);
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
