import { NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { updateRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendBrandListingConfirmation } from '@/lib/email';

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

export async function POST(request: Request) {
  const body = await request.text();
  const sig = request.headers.get('stripe-signature');

  if (!sig || !WEBHOOK_SECRET) {
    console.error('Missing Stripe signature or webhook secret');
    return NextResponse.json({ error: 'Missing signature' }, { status: 400 });
  }

  let event;
  try {
    event = getStripe().webhooks.constructEvent(body, sig, WEBHOOK_SECRET);
  } catch (err: any) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { brandId, brandName } = session.metadata || {};

    if (!brandId || session.metadata?.type !== 'brand-listing') {
      // Not a brand payment, ignore
      return NextResponse.json({ received: true });
    }

    try {
      // Update brand record — mark as paid and featured
      await updateRecord(TABLES.BRANDS, brandId, {
        'Payment Status': 'Paid',
        'Featured': true,
        'Stripe Session ID': session.id,
        'Paid At': new Date().toISOString(),
        'Amount Paid': (session.amount_total || 0) / 100,
      });

      // Send confirmation email
      if (session.customer_email) {
        await sendBrandListingConfirmation({
          brandName: brandName || 'Your Brand',
          email: session.customer_email,
          amountPaid: `$${((session.amount_total || 0) / 100).toFixed(0)}`,
        });
      }

      // Send Telegram notification
      try {
        const { sendTelegramUpdate } = await import('@/lib/telegram');
        await sendTelegramUpdate(
          `💰 <b>Brand Payment Received</b>\n\n` +
          `🏷️ <b>${brandName}</b>\n` +
          `📧 ${session.customer_email}\n` +
          `💵 $${((session.amount_total || 0) / 100).toFixed(0)}\n\n` +
          `✅ Brand is now LIVE and featured to all members.`
        );
      } catch (e) {
        console.error('Telegram brand payment notification error:', e);
      }

      console.log(`Brand ${brandId} payment completed — now featured`);
    } catch (error) {
      console.error('Error processing brand payment webhook:', error);
      return NextResponse.json({ error: 'Processing error' }, { status: 500 });
    }
  }

  return NextResponse.json({ received: true });
}
