import { NextResponse, NextRequest } from 'next/server';
import { updateRecord, deleteRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { requireAdmin } from '@/lib/adminAuth';

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const __authResp = await requireAdmin(request);
    if (__authResp) return __authResp;
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
    // Final-sweep fix (2026-06-10): schema names are `Product Category` +
    // `Proposed Discount`. Old names silently stripped on admin edits.
    if (body.productType || body.productCategory) fields['Product Category'] = body.productType || body.productCategory;
    if (body.discountOffered !== undefined || body.proposedDiscount !== undefined) fields['Proposed Discount'] = body.discountOffered ?? body.proposedDiscount;
    if (body.promotionDetails || body.partnershipGoals) fields['Partnership Goals'] = body.promotionDetails || body.partnershipGoals;

    const updatedRecord = await updateRecord(TABLES.BRANDS, id, fields);

    // NOTE (2026-06-12): brand approval no longer fires a one-time listing
    // payment email. The $299 one-time brand-listing product was decommissioned
    // in favor of the self-serve /brand-partners subscription tiers. Approving a
    // brand now only updates the record; partners pay via Stripe Checkout
    // subscription, and the brand-partner-tier webhook handles go-live/featuring.

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
    const __authResp = await requireAdmin(request);
    if (__authResp) return __authResp;
    const { id } = await context.params;
    await deleteRecord(TABLES.BRANDS, id);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('API error deleting brand:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
