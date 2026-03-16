import { NextResponse } from 'next/server';
import { getStripe, BRAND_LISTING_PRICE_CENTS } from '@/lib/stripe';
import { getRecordById } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-member-secret-change-me';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

export async function POST(request: Request) {
  try {
    let parsedBody: any;
    try { parsedBody = await request.json(); } catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }); }
    const { token } = parsedBody;

    if (!token) {
      return NextResponse.json({ error: 'Missing payment token' }, { status: 400 });
    }

    // Verify the brand payment token
    let decoded: any;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
      if (decoded.type !== 'brand-payment') {
        return NextResponse.json({ error: 'Invalid token type' }, { status: 400 });
      }
    } catch {
      return NextResponse.json({ error: 'Invalid or expired payment link' }, { status: 401 });
    }

    const { brandId, email, brandName } = decoded;

    // Verify brand exists and is approved
    let brand: any;
    try {
      brand = await getRecordById(TABLES.BRANDS, brandId);
    } catch {
      return NextResponse.json({ error: 'Brand not found' }, { status: 404 });
    }

    if (brand['Status'] !== 'Approved') {
      return NextResponse.json({ error: 'Brand must be approved before payment' }, { status: 400 });
    }

    if (brand['Payment Status'] === 'Paid') {
      return NextResponse.json({ error: 'Payment already completed' }, { status: 400 });
    }

    // Create Stripe Checkout session
    const session = await getStripe().checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: email,
      metadata: {
        brandId,
        brandName,
        type: 'brand-listing',
      },
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'BuyHalfCow Brand Partnership Listing',
              description: `Annual brand listing for ${brandName} — featured placement to verified beef buyers and ranchers`,
            },
            unit_amount: BRAND_LISTING_PRICE_CENTS,
          },
          quantity: 1,
        },
      ],
      success_url: `${SITE_URL}/brand/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL}/brand/payment?token=${token}&cancelled=true`,
    });

    return NextResponse.json({ url: session.url });
  } catch (error: any) {
    console.error('Stripe checkout error:', error);
    return NextResponse.json({ error: error.message || 'Payment error' }, { status: 500 });
  }
}
