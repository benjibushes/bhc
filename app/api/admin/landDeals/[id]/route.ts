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
    if (body.sellerName) fields['Seller Name'] = body.sellerName;
    if (body.email) fields['Email'] = body.email;
    if (body.phone !== undefined) fields['Phone'] = body.phone;
    if (body.propertyType) fields['Property Type'] = body.propertyType;
    if (body.acreage !== undefined) fields['Acreage'] = parseInt(body.acreage);
    if (body.state) fields['State'] = body.state;
    if (body.county !== undefined) fields['County'] = body.county;
    if (body.price !== undefined) fields['Price'] = parseInt(body.price);
    if (body.description !== undefined) fields['Description'] = body.description;

    const updatedRecord = await updateRecord(TABLES.LAND_DEALS, id, fields);
    return NextResponse.json(updatedRecord);
  } catch (error: any) {
    console.error('API error updating land deal:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    await deleteRecord(TABLES.LAND_DEALS, id);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('API error deleting land deal:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
