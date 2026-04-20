import { NextResponse } from 'next/server';
import { getRecordById, createRecord, TABLES } from '@/lib/airtable';
import { sendEmail } from '@/lib/email';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';

export const maxDuration = 30;

// Public inquiry endpoint — anyone can inquire on a land listing without
// being a BHC member (we want max top-of-funnel volume on land deals; it's
// the easiest way to grow the email list with high-intent rural buyers).
//
// Creates an INQUIRIES record + emails the seller + Telegrams Ben.
// The 1% referral fee on close is tracked manually for now (admin marks
// the inquiry as "Closed Won" with a Sale Amount in the admin UI).
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: dealId } = await params;
    const body = await request.json().catch(() => ({}));
    const { name, email, phone, message } = body || {};

    if (!name || !email || !message) {
      return NextResponse.json({ error: 'Name, email, and message are required' }, { status: 400 });
    }

    const re = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!re.test(email)) {
      return NextResponse.json({ error: 'Please enter a valid email' }, { status: 400 });
    }

    const deal: any = await getRecordById(TABLES.LAND_DEALS, dealId);
    if (!deal) {
      return NextResponse.json({ error: 'Listing not found' }, { status: 404 });
    }
    if (deal['Status'] !== 'Approved') {
      return NextResponse.json({ error: 'This listing is no longer active' }, { status: 410 });
    }

    const sellerName = deal['Seller Name'] || 'Land Seller';
    const sellerEmail = deal['Email'] || '';
    const acreage = deal['Acreage'] || 0;
    const state = deal['State'] || '';
    const propertyType = deal['Property Type'] || 'Property';
    const askingPrice = deal['Asking Price'] || deal['Price'] || 'Inquire';
    const propertyLocation = deal['Property Location'] || state;

    // Log the inquiry in the INQUIRIES table for tracking + 1% commission
    try {
      await createRecord(TABLES.INQUIRIES, {
        'Consumer Name': name.toString().trim().slice(0, 100),
        'Consumer Email': email.toString().trim().toLowerCase(),
        'Consumer Phone': phone || '',
        'Message': message.toString().trim().slice(0, 2000),
        'Interest Type': `Land Deal — ${propertyType}, ${acreage} acres in ${state}`,
        'Status': 'New',
        'Source': `land-deal:${dealId}`,
      });
    } catch (e: any) {
      console.error('Land inquiry: INQUIRIES create error:', e?.message);
    }

    // Email the seller with the inquiry
    if (sellerEmail) {
      try {
        await sendEmail({
          to: sellerEmail,
          subject: `🏞 New inquiry on your ${acreage}-acre listing`,
          html: `
            <div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:40px;background:white;border:1px solid #A7A29A;">
              <h1 style="font-family:Georgia,serif;font-size:22px;margin:0 0 20px;">New Land Inquiry</h1>
              <p style="color:#6B4F3F;">Hi ${sellerName},</p>
              <p style="color:#6B4F3F;">Someone just inquired about your <strong>${acreage}-acre ${propertyType}</strong> listing in ${propertyLocation} via BuyHalfCow.</p>
              <div style="background:#F4F1EC;border-left:3px solid #0E0E0E;padding:16px 20px;margin:20px 0;color:#0E0E0E;">
                <p style="margin:6px 0;"><strong>${name}</strong></p>
                <p style="margin:6px 0;">📧 <a href="mailto:${email}" style="color:#0E0E0E;">${email}</a></p>
                ${phone ? `<p style="margin:6px 0;">📞 <a href="tel:${phone}" style="color:#0E0E0E;">${phone}</a></p>` : ''}
              </div>
              <p style="color:#6B4F3F;"><strong>Their message:</strong></p>
              <p style="color:#6B4F3F;background:#F4F1EC;padding:12px;border:1px solid #E5E2DC;">${String(message).replace(/</g, '&lt;')}</p>
              <p style="color:#6B4F3F;">Reply to them directly — we just made the introduction. If a sale closes, BuyHalfCow earns a 1% referral fee per the partnership terms.</p>
              <p style="color:#6B4F3F;margin-top:24px;">— Benjamin, BuyHalfCow</p>
            </div>`,
        });
      } catch (e: any) {
        console.error('Land inquiry: seller email error:', e?.message);
      }
    }

    // Send confirmation to the inquirer
    try {
      await sendEmail({
        to: email,
        subject: `Your inquiry on ${propertyLocation} — BuyHalfCow`,
        html: `
          <div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:40px;background:white;border:1px solid #A7A29A;">
            <h1 style="font-family:Georgia,serif;font-size:22px;margin:0 0 20px;">Inquiry sent</h1>
            <p style="color:#6B4F3F;">Hi ${name},</p>
            <p style="color:#6B4F3F;">We forwarded your inquiry on the <strong>${acreage}-acre ${propertyType}</strong> in ${propertyLocation} (asking ${askingPrice}) to ${sellerName}. They typically respond within 1-3 business days.</p>
            <p style="color:#6B4F3F;">Want to see more listings or get notified when new ones go up? <a href="${process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com'}/access" style="color:#0E0E0E;">Join the network →</a></p>
            <p style="color:#6B4F3F;margin-top:24px;">— Benjamin, BuyHalfCow</p>
          </div>`,
      });
    } catch (e: any) {
      console.error('Land inquiry: confirm email error:', e?.message);
    }

    // Telegram alert — land inquiries are high-value (5-7 figure transactions)
    try {
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `🏞 <b>LAND INQUIRY</b>\n\n` +
        `📍 ${acreage} acres ${propertyType} in ${propertyLocation}\n` +
        `💵 Asking: ${askingPrice}\n\n` +
        `From: <b>${name}</b>\n` +
        `📧 ${email}\n` +
        (phone ? `📞 ${phone}\n` : '') +
        `\nForwarded to seller: ${sellerName}\n` +
        `Track for 1% commission on close.`
      );
    } catch {}

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Land inquiry endpoint error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
