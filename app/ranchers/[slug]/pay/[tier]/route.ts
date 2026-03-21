import { NextResponse } from 'next/server';
import { getRancherBySlug, updateRecord, TABLES } from '@/lib/airtable';
import { sendEmail } from '@/lib/email';
import { sendTelegramMessage } from '@/lib/telegram';

// Tracking redirect: /ranchers/[slug]/pay/[tier]
// Logs the click, appends UTM params, then redirects to the rancher's payment link.
// tier must be: quarter | half | whole

const TIER_CONFIG: Record<string, {
  clickField: string;
  linkField: string;
  label: string;
}> = {
  quarter: {
    clickField: 'Quarter Clicks',
    linkField: 'Quarter Payment Link',
    label: 'Quarter Share',
  },
  half: {
    clickField: 'Half Clicks',
    linkField: 'Half Payment Link',
    label: 'Half Share',
  },
  whole: {
    clickField: 'Whole Clicks',
    linkField: 'Whole Payment Link',
    label: 'Whole Share',
  },
};

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string; tier: string }> }
) {
  const { slug, tier } = await params;
  const config = TIER_CONFIG[tier.toLowerCase()];
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

  // Invalid tier — redirect back to ranch page
  if (!config) {
    return NextResponse.redirect(`${siteUrl}/ranchers/${slug}`, { status: 302 });
  }

  try {
    const rancher: any = await getRancherBySlug(slug);

    // No rancher or page not live — redirect home
    if (!rancher) {
      return NextResponse.redirect(`${siteUrl}/ranchers`, { status: 302 });
    }

    const paymentLink: string = rancher[config.linkField] || '';

    // ── Log the click before returning (Vercel terminates after response) ──
    const currentClicks: number = rancher[config.clickField] || 0;
    try {
      await updateRecord(TABLES.RANCHERS, rancher.id, {
        [config.clickField]: currentClicks + 1,
      });
    } catch (err) {
      console.error('Click log failed:', err);
    }

    // ── Notify rancher + Ben via Telegram that someone clicked ────────────
    const rancherName = rancher['Operator Name'] || rancher['Ranch Name'] || slug;
    const rancherEmail = rancher['Email'];
    const totalClicks = (currentClicks + 1);
    try {
      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (chatId) {
        await sendTelegramMessage(chatId,
          `🛒 <b>PAYMENT CLICK</b>\n\n` +
          `Someone clicked <b>${config.label}</b> on <b>${rancherName}</b>'s page\n` +
          `Total ${tier} clicks: ${totalClicks}\n` +
          `${paymentLink ? '→ Redirecting to payment' : '⚠️ No payment link set'}`
        );
      }
    } catch (e) {
      console.error('Telegram click notification error:', e);
    }

    // Notify the rancher they have a potential buyer
    if (rancherEmail && paymentLink) {
      try {
        await sendEmail({
          to: rancherEmail,
          subject: `New buyer interest — ${config.label} on BuyHalfCow`,
          html: `<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;">
            <h1 style="font-family:Georgia,serif;font-size:22px;">New Buyer Interest</h1>
            <p>Hi ${rancherName},</p>
            <p>Someone just clicked to purchase a <strong>${config.label}</strong> through your BuyHalfCow page. They've been redirected to your payment link.</p>
            <p>Keep an eye on your payment processor for the incoming order. If they don't complete payment, we'll follow up with them automatically.</p>
            <p style="font-size:12px;color:#A7A29A;margin-top:30px;">— Benjamin, BuyHalfCow</p>
          </div>`,
        });
      } catch (e) {
        console.error('Rancher click email error:', e);
      }
    }

    // ── If no payment link configured, send to ranch page ─────────────────
    if (!paymentLink) {
      return NextResponse.redirect(`${siteUrl}/ranchers/${slug}`, { status: 302 });
    }

    // ── Append UTM params so rancher's analytics sees BHC as source ───────
    const { searchParams } = new URL(request.url);
    const utmSource = searchParams.get('utm_source') || 'bhc';
    const utmMedium = searchParams.get('utm_medium') || 'rancher-page';
    const utmCampaign = searchParams.get('utm_campaign') || slug;
    const utmContent = searchParams.get('utm_content') || tier;

    let destination: URL;
    try {
      destination = new URL(paymentLink);
    } catch {
      // Malformed URL in Airtable — just redirect as-is
      return NextResponse.redirect(paymentLink, { status: 302 });
    }

    destination.searchParams.set('utm_source', utmSource);
    destination.searchParams.set('utm_medium', utmMedium);
    destination.searchParams.set('utm_campaign', utmCampaign);
    destination.searchParams.set('utm_content', utmContent);
    destination.searchParams.set('ref', 'bhc');

    return NextResponse.redirect(destination.toString(), { status: 302 });
  } catch (error: any) {
    console.error(`Pay redirect error [${slug}/${tier}]:`, error);
    // On any error, send to the ranch page rather than a 500
    return NextResponse.redirect(`${siteUrl}/ranchers/${slug}`, { status: 302 });
  }
}
