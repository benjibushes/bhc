import { NextResponse, NextRequest } from 'next/server';
import { updateRecord, deleteRecord, getRecordById } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendBrandApprovalWithPayment } from '@/lib/email';
import { BRAND_LISTING_PRICE_LABEL } from '@/lib/stripe';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-member-secret-change-me';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

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

    // When brand is approved, send payment link email (don't feature until paid)
    if (body.status === 'Approved') {
      try {
        const brand: any = await getRecordById(TABLES.BRANDS, id);
        const brandEmail = brand['Email'];
        const brandName = brand['Brand Name'] || '';
        const contactName = brand['Contact Name'] || '';

        if (brandEmail && brand['Payment Status'] !== 'Paid') {
          // Generate a payment token (30 day expiry)
          const paymentToken = jwt.sign(
            { type: 'brand-payment', brandId: id, email: brandEmail, brandName },
            JWT_SECRET,
            { expiresIn: '30d' }
          );
          const paymentUrl = `${SITE_URL}/brand/payment?token=${paymentToken}`;

          // Ensure brand is NOT featured until payment completes
          await updateRecord(TABLES.BRANDS, id, {
            'Featured': false,
            'Payment Status': 'Pending',
          });

          await sendBrandApprovalWithPayment({
            brandName,
            contactName,
            email: brandEmail,
            paymentUrl,
            listingPrice: BRAND_LISTING_PRICE_LABEL,
          });
        }
      } catch (emailError) {
        console.error('Error sending brand payment email:', emailError);
        // Don't fail the approval if email fails
      }
    }

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
