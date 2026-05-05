import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';
import {
  TABLES,
  createRecord,
  updateRecord,
  getAllRecords,
  getRancherBySlug,
  escapeAirtableValue,
} from '@/lib/airtable';
import { sendEmail } from '@/lib/email';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { JWT_SECRET } from '@/lib/secrets';

// Order request endpoint — buyer fills inline form on rancher landing page.
// No external redirect to rancher's website. We capture the request, link
// buyer ↔ rancher in Airtable, notify both sides, and let the rancher reach
// back out to confirm + arrange payment.
//
// Why this exists: rancher payment links (Stripe/Etsy/Shopify on their own
// site) leak buyers off BHC. Once they leave, conversion is unmeasurable
// and the rancher-buyer connection isn't tracked. This flow keeps the
// connection inside BHC, captures the lead either way, and lets ranchers
// close at their own pace.
//
// Auth: optional. If member session cookie present, we skip name/email
// collection (buyer is already in our Consumers table). Otherwise we
// require name + email.
//
// Body:
//   {
//     slug: string,           // rancher slug (URL path)
//     tier: 'quarter' | 'half' | 'whole',
//     fullName?: string,      // required if not logged in
//     email?: string,         // required if not logged in
//     phone?: string,         // optional
//     state?: string,         // 2-letter, optional but useful
//     zip?: string,           // 5-digit, optional
//     message?: string,       // optional buyer note ("I want grass-fed only", etc.)
//   }
//
// Response:
//   { success, referralId, rancherName, expectedResponseHours }

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const MEMBER_AUTH_COOKIE = 'bhc-member-auth';

const TIER_LABELS: Record<string, string> = {
  quarter: 'Quarter Cow',
  half: 'Half Cow',
  whole: 'Whole Cow',
};

interface MemberSession {
  consumerId: string;
  name?: string;
  email?: string;
  state?: string;
}

async function getMemberSession(): Promise<MemberSession | null> {
  try {
    const cookieStore = await cookies();
    const sessionCookie = cookieStore.get(MEMBER_AUTH_COOKIE);
    if (!sessionCookie?.value) return null;
    const decoded: any = jwt.verify(sessionCookie.value, JWT_SECRET);
    if (decoded.type !== 'member-session') return null;
    return {
      consumerId: decoded.consumerId,
      name: decoded.name,
      email: decoded.email,
      state: decoded.state,
    };
  } catch {
    return null;
  }
}

function isValidEmail(s: string): boolean {
  return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(s);
}

export async function POST(req: Request) {
  let body: Record<string, any> = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const slug = String(body.slug || '').trim();
  const tier = String(body.tier || '').trim().toLowerCase();
  const fullNameInput = String(body.fullName || '').trim();
  const emailInput = String(body.email || '').trim().toLowerCase();
  const phone = String(body.phone || '').trim();
  const state = String(body.state || '').trim().toUpperCase().slice(0, 2);
  const zip = String(body.zip || '').trim().slice(0, 5);
  const message = String(body.message || '').trim().slice(0, 1000);

  if (!slug) return NextResponse.json({ error: 'Rancher slug required' }, { status: 400 });
  if (!TIER_LABELS[tier]) return NextResponse.json({ error: 'Invalid tier' }, { status: 400 });

  // Member session = skip name/email collection. Otherwise enforce.
  const session = await getMemberSession();
  let buyerName = '';
  let buyerEmail = '';
  let buyerState = '';
  let consumerId = '';

  if (session) {
    consumerId = session.consumerId;
    buyerName = session.name || fullNameInput || '';
    buyerEmail = session.email || emailInput || '';
    buyerState = session.state || state || '';
  } else {
    if (!fullNameInput) {
      return NextResponse.json({ error: 'Name required' }, { status: 400 });
    }
    if (!isValidEmail(emailInput)) {
      return NextResponse.json({ error: 'Valid email required' }, { status: 400 });
    }
    buyerName = fullNameInput;
    buyerEmail = emailInput;
    buyerState = state;
  }

  // Look up rancher
  let rancher: any;
  try {
    rancher = await getRancherBySlug(slug);
  } catch {
    return NextResponse.json({ error: 'Rancher lookup failed' }, { status: 500 });
  }
  if (!rancher) {
    return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });
  }
  const rancherName =
    (rancher['Operator Name'] || rancher['Ranch Name'] || 'Rancher').toString();
  const ranchName = (rancher['Ranch Name'] || rancherName).toString();
  const rancherEmail = (rancher['Email'] || '').toString();

  // Find or create Consumer record (so future visits + member upgrade work)
  if (!consumerId) {
    try {
      const safeEmail = escapeAirtableValue(buyerEmail);
      const existing: any[] = await getAllRecords(
        TABLES.CONSUMERS,
        `LOWER({Email}) = "${safeEmail.toLowerCase()}"`
      );
      if (existing.length > 0) {
        consumerId = existing[0].id;
      } else {
        const created: any = await createRecord(TABLES.CONSUMERS, {
          'Full Name': buyerName,
          'Email': buyerEmail,
          'Phone': phone || '',
          'State': buyerState || '',
          'Zip': zip || '',
          'Segment': 'Beef Buyer',
          'Source': `rancher-page:${slug}`,
          'Order Type': TIER_LABELS[tier],
          'Interest Beef': true,
          'Intent Score': 90,
          'Intent Classification': 'High',
        });
        consumerId = created.id;
      }
    } catch (e: any) {
      console.error('[orders/request] consumer upsert failed:', e?.message);
      // Non-fatal — we can still create the referral with denormalized buyer data.
    }
  }

  // Create Referral
  const referralName = `${buyerName} → ${ranchName} · ${TIER_LABELS[tier]}`;
  const referralFields: Record<string, any> = {
    Name: referralName,
    Status: 'Pending',
    'Approval Status': 'Pending Rancher Response',
    'Match Type': 'Direct (Rancher Page)',
    'Buyer Name': buyerName,
    'Buyer Email': buyerEmail,
    'Buyer Phone': phone || '',
    'Buyer State': buyerState || '',
    'Order Type': TIER_LABELS[tier],
    'Intent Score': 90,
    'Intent Classification': 'High',
    'Notes': message
      ? `[Buyer message]\n${message}\n\n[Source] Direct rancher-page order request`
      : '[Source] Direct rancher-page order request',
    Rancher: [rancher.id],
  };
  if (consumerId) referralFields.Buyer = [consumerId];

  let referral: any;
  try {
    referral = await createRecord(TABLES.REFERRALS, referralFields);
  } catch (e: any) {
    console.error('[orders/request] referral create failed:', e?.message);
    return NextResponse.json(
      { error: 'Order request failed — try again' },
      { status: 500 }
    );
  }

  // Bump rancher's active referral count
  try {
    const current = Number(rancher['Current Active Referrals'] || 0);
    await updateRecord(TABLES.RANCHERS, rancher.id, {
      'Current Active Referrals': current + 1,
      'Last Assigned At': new Date().toISOString(),
    });
  } catch (e: any) {
    console.warn('[orders/request] active-ref count bump skipped:', e?.message);
  }

  // ── Email rancher (reply-to=buyer for direct conversation) ──
  if (rancherEmail) {
    try {
      const subject = `New order request: ${TIER_LABELS[tier]} — ${buyerName}`;
      const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;padding:20px">
<div style="max-width:600px;margin:0 auto;background:#fff;padding:36px;border:1px solid #A7A29A">
<h1 style="font-family:Georgia,serif;font-size:24px;margin:0 0 18px">New order request — ${TIER_LABELS[tier]}</h1>
<p>Hey ${rancherName.split(' ')[0] || 'there'},</p>
<p>You just got an order request through your BuyHalfCow page.</p>
<table style="width:100%;border-collapse:collapse;margin:18px 0;font-size:14px">
  <tr><td style="padding:6px 12px 6px 0;color:#6B4F3F;width:120px"><strong>Buyer</strong></td><td style="padding:6px 0">${buyerName}</td></tr>
  <tr><td style="padding:6px 12px 6px 0;color:#6B4F3F"><strong>Email</strong></td><td style="padding:6px 0"><a href="mailto:${buyerEmail}" style="color:#0E0E0E">${buyerEmail}</a></td></tr>
  ${phone ? `<tr><td style="padding:6px 12px 6px 0;color:#6B4F3F"><strong>Phone</strong></td><td style="padding:6px 0">${phone}</td></tr>` : ''}
  ${buyerState ? `<tr><td style="padding:6px 12px 6px 0;color:#6B4F3F"><strong>State</strong></td><td style="padding:6px 0">${buyerState}${zip ? ` · ${zip}` : ''}</td></tr>` : ''}
  <tr><td style="padding:6px 12px 6px 0;color:#6B4F3F"><strong>Wants</strong></td><td style="padding:6px 0">${TIER_LABELS[tier]}</td></tr>
</table>
${message ? `<div style="background:#F4F1EC;padding:16px;margin:18px 0;border-left:3px solid #6B4F3F"><p style="margin:0;font-size:13px;color:#6B4F3F;text-transform:uppercase;letter-spacing:1px">Buyer note</p><p style="margin:8px 0 0">${message.replace(/</g, '&lt;')}</p></div>` : ''}
<p><strong>Reply directly to this email to reach ${buyerName}</strong> — your reply lands in their inbox. Confirm timing, processing date, and how you'd like to take payment.</p>
<p style="margin-top:24px;font-size:14px;color:#6B4F3F">Tracked in BuyHalfCow as Referral <code>${referral.id}</code>. Ben gets a Telegram alert too.</p>
<p style="margin-top:24px">— Ben<br>Founder, BuyHalfCow</p>
</div></body></html>`;
      await sendEmail({
        to: rancherEmail,
        subject,
        html,
        _replyContext: { type: 'ref', recordId: referral.id },
      });
    } catch (e: any) {
      console.error('[orders/request] rancher email failed:', e?.message);
    }
  }

  // ── Email buyer confirmation ──
  try {
    const subject = `Order request sent — ${ranchName}`;
    const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;padding:20px">
<div style="max-width:600px;margin:0 auto;background:#fff;padding:36px;border:1px solid #A7A29A">
<h1 style="font-family:Georgia,serif;font-size:24px;margin:0 0 18px">You're connected with ${ranchName}</h1>
<p>Hey ${buyerName.split(' ')[0] || 'there'},</p>
<p>We sent your <strong>${TIER_LABELS[tier]}</strong> request to ${rancherName} at ${ranchName}. They typically reply within 48 hours to confirm timing, processing date, and payment details.</p>
<p>If you don't hear back in 48 hours, reply to this email and Ben will personally chase it down.</p>
<p style="margin-top:24px">— Ben<br>Founder, BuyHalfCow</p>
<p style="margin-top:24px;font-size:12px;color:#A7A29A">BuyHalfCow · Kalispell, MT 59901</p>
</div></body></html>`;
    await sendEmail({
      to: buyerEmail,
      subject,
      html,
    });
  } catch (e: any) {
    console.error('[orders/request] buyer email failed:', e?.message);
  }

  // ── Telegram alert to Ben ──
  try {
    if (TELEGRAM_ADMIN_CHAT_ID) {
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `🛒 <b>NEW ORDER REQUEST</b>\n\n` +
          `<b>${TIER_LABELS[tier]}</b> · ${ranchName}\n` +
          `🤠 ${rancherName}${rancherEmail ? ` · ${rancherEmail}` : ''}\n\n` +
          `<b>Buyer:</b> ${buyerName}\n` +
          `📧 ${buyerEmail}\n` +
          (phone ? `📞 ${phone}\n` : '') +
          (buyerState ? `📍 ${buyerState}${zip ? ` · ${zip}` : ''}\n` : '') +
          (message
            ? `\n<b>Note:</b> ${message.length > 200 ? message.slice(0, 200) + '…' : message}\n`
            : '') +
          `\n<i>Rancher emailed (reply-to=buyer). Buyer confirmation sent. Referral ${referral.id}.</i>`
      );
    }
  } catch (e: any) {
    console.error('[orders/request] telegram alert failed:', e?.message);
  }

  return NextResponse.json({
    success: true,
    referralId: referral.id,
    rancherName,
    ranchName,
    expectedResponseHours: 48,
  });
}
