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
    if (body.featured !== undefined) fields['Featured'] = body.featured;
    if (body.brandName) fields['Brand Name'] = body.brandName;
    if (body.contactName) fields['Contact Name'] = body.contactName;
    if (body.email) fields['Email'] = body.email;
    if (body.phone !== undefined) fields['Phone'] = body.phone;
    if (body.website !== undefined) fields['Website'] = body.website;
    if (body.productType || body.productCategory) fields['Product Type'] = body.productType || body.productCategory;
    if (body.discountOffered !== undefined || body.proposedDiscount !== undefined) fields['Discount Offered (%)'] = body.discountOffered ?? body.proposedDiscount;
    if (body.promotionDetails || body.partnershipGoals) fields['Partnership Goals'] = body.promotionDetails || body.partnershipGoals;

    const updatedRecord = await updateRecord(TABLES.BRANDS, id, fields);
    return NextResponse.json(updatedRecord);
  } catch (error: any) {
    console.error('API error updating brand:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    await deleteRecord(TABLES.BRANDS, id);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('API error deleting brand:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
