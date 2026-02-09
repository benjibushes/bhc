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
    // For Airtable checkboxes: true to check, false to uncheck
    if (body.certified === true) fields['Certified'] = true;
    else if (body.certified === false) fields['Certified'] = false;
    if (body.call_scheduled === true) fields['Call Scheduled'] = true;
    else if (body.call_scheduled === false) fields['Call Scheduled'] = false;
    if (body.ranchName) fields['Ranch Name'] = body.ranchName;
    if (body.operatorName) fields['Operator Name'] = body.operatorName;
    if (body.email) fields['Email'] = body.email;
    if (body.phone !== undefined) fields['Phone'] = body.phone;
    if (body.state) fields['State'] = body.state;
    if (body.beefTypes) fields['Beef Types'] = body.beefTypes;
    if (body.monthlyCapacity !== undefined) fields['Monthly Capacity'] = parseInt(body.monthlyCapacity);
    if (body.certifications !== undefined) fields['Certifications'] = body.certifications;

    const updatedRecord = await updateRecord(TABLES.RANCHERS, id, fields);
    return NextResponse.json(updatedRecord);
  } catch (error: any) {
    console.error('API error updating rancher:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    await deleteRecord(TABLES.RANCHERS, id);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('API error deleting rancher:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
