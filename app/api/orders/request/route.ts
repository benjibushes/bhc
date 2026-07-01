import { NextResponse } from 'next/server';
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
import { incrementCapacity, syncCapacityToAirtable } from '@/lib/rancherCapacity';
import { resolveBuyerSession } from '@/lib/buyerAuth';
import { isRancherOperationalForBuyers } from '@/lib/rancherEligibility';
import { rateLimit, getRequestIp } from '@/lib/rateLimit';

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

// Optional auth — endpoint accepts anonymous requests too (form fills
// name/email manually for non-logged-in buyers).
async function getMemberSession(req: Request): Promise<MemberSession | null> {
  const session = await resolveBuyerSession(req);
  if (!session) return null;
  return {
    consumerId: session.consumerId,
    name: session.name,
    email: session.email,
    state: session.state,
  };
}

function isValidEmail(s: string): boolean {
  return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(s);
}

export async function POST(req: Request) {
  // Rate limit order requests. No-op when Upstash env unset (safe fallthrough)
  // — same limiter + semantics as /api/consumers. This route is fully
  // anonymous and creates Consumer + Referral rows and fires rancher/buyer
  // emails + Telegram, so it's a bot magnet under paid traffic. 5/min/IP.
  const ip = getRequestIp(req);
  const rl = await rateLimit(`order-req:${ip}`, { requests: 5, window: '1m' });
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Too many order requests from this network — wait a minute and try again.' },
      { status: 429 },
    );
  }

  let body: Record<string, any> = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  // Honeypot — the rancher-page order form renders a hidden `website` field
  // (same field name /api/consumers uses). Real users never fill it; bots
  // that POST it get a fake success so they don't adapt. Absent field = pass,
  // so older clients / non-form callers are unaffected. No rows created, no
  // sends fired.
  if (typeof body.website === 'string' && body.website.trim().length > 0) {
    return NextResponse.json({
      success: true,
      referralId: null,
      rancherName: '',
      ranchName: '',
      expectedResponseHours: 48,
    });
  }

  const slug = String(body.slug || '').trim();
  const tier = String(body.tier || '').trim().toLowerCase();
  const fullNameInput = String(body.fullName || '').trim();
  const emailInput = String(body.email || '').trim().toLowerCase();
  const phone = String(body.phone || '').trim();
  const state = String(body.state || '').trim().toUpperCase().slice(0, 2);
  const zip = String(body.zip || '').trim().slice(0, 5);
  const message = String(body.message || '').trim().slice(0, 1000);
  // TCPA SMS consent checkbox (guest form only; unchecked by default). Only
  // meaningful with a non-empty phone — same guard as /api/consumers.
  const wantsSms = body.smsOptIn === true && phone.length > 0;

  if (!slug) return NextResponse.json({ error: 'Rancher slug required' }, { status: 400 });
  if (!TIER_LABELS[tier]) return NextResponse.json({ error: 'Invalid tier' }, { status: 400 });

  // Member session = skip name/email collection. Otherwise enforce.
  const session = await getMemberSession(req);
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
  // Operational gate — same canonical rule as matching engine, reorder, and
  // warmup. Without it, a paused/past_due rancher's page still accepted
  // orders: referral created, capacity bumped, emails fired, rancher never
  // responds — a ghost lead the buyer interprets as BHC being broken.
  if (!isRancherOperationalForBuyers(rancher)) {
    return NextResponse.json(
      {
        error: 'This rancher is not taking orders right now. Take the 90-second quiz and we will match you with an active rancher in your state.',
        fallbackToMatch: true,
      },
      { status: 409 }
    );
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
        // Consent lives on CONSUMERS (`SMS Opt-In` — the exact field the
        // funnel writes and sendSMSToConsumer gates on). Only ever flips
        // false→true; an unchecked box is not a revocation. Failure hits the
        // surrounding non-fatal catch.
        if (wantsSms && (existing[0] as any)['SMS Opt-In'] !== true) {
          await updateRecord(TABLES.CONSUMERS, consumerId, {
            'SMS Opt-In': true,
            'SMS Opt-In At': new Date().toISOString(),
          });
        }
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
          // FIX: same phantom 'Interest Beef' boolean bug as the reserve route.
          // Here the catch is non-fatal so the referral survived, but the
          // Consumer create 422'd → store buyers got a referral with NO Consumer
          // row (broke later member-login, review linkage, attribution). Write
          // the real 'Interests' multipleSelects field instead.
          'Interests': ['Beef'],
          'Intent Score': 90,
          'Intent Classification': 'High',
          // TCPA consent captured at creation when the box was checked.
          ...(wantsSms
            ? { 'SMS Opt-In': true, 'SMS Opt-In At': new Date().toISOString() }
            : {}),
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

  // Atomic capacity bump — read-then-write was racey under burst (two concurrent
  // direct-page orders for the same rancher could both observe N and both write
  // N+1, silently overflowing). Redis INCR + Airtable mirror solves it.
  // Also stamp Last Assigned At separately so timestamp updates even if Redis
  // is unavailable (fail-open path inside incrementCapacity).
  try {
    const newCount = await incrementCapacity(rancher.id);
    await syncCapacityToAirtable(rancher.id, newCount);
    await updateRecord(TABLES.RANCHERS, rancher.id, {
      'Last Assigned At': new Date().toISOString(),
    });
  } catch (e: any) {
    console.warn('[orders/request] active-ref count bump skipped:', e?.message);
  }

  // ── Email rancher (reply-to=buyer for direct conversation) ──
  // Track outcome so Telegram alert reflects what actually shipped (or didn't).
  let rancherEmailSent = false;
  let rancherEmailErr = '';
  let buyerEmailSent = false;
  let buyerEmailErr = '';
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
      const rancherResult = await sendEmail({
        to: rancherEmail,
        subject,
        html,
        _replyContext: { type: 'ref', recordId: referral.id },
        // Guard-truth fix (2026-07-01): the default 'sendEmail' templateName is
        // subject to the 3/week frequency cap — a rancher mid-deal trivially
        // exceeds it, after which NEW paying store leads were silently eaten.
        // Whitelisted in TRANSACTIONAL_WHITELIST (money-path).
        templateName: 'sendOrderRequestToRancher',
      });
      // TRUTH: guardedSend suppression (pause/unsub/bounce) returns
      // success:false WITHOUT throwing — the old `rancherEmailSent = true`
      // here lied to the Telegram footer whenever the send was suppressed.
      rancherEmailSent = !!rancherResult?.success;
      if (!rancherResult?.success) {
        rancherEmailErr = `suppressed: ${rancherResult?.reason || 'unknown'}`;
        console.error('[orders/request] rancher email suppressed:', rancherResult?.reason);
      }
    } catch (e: any) {
      rancherEmailErr = e?.message || 'unknown';
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
    const buyerResult = await sendEmail({
      to: buyerEmail,
      subject,
      html,
      // Customer-expected post-submit confirmation — whitelisted so the
      // frequency cap can never leave the buyer wondering if it went through.
      templateName: 'sendOrderRequestConfirmation',
    });
    // TRUTH: same as the rancher send — suppression returns success:false
    // without throwing, so derive the reported outcome from the actual result.
    buyerEmailSent = !!buyerResult?.success;
    if (!buyerResult?.success) {
      buyerEmailErr = `suppressed: ${buyerResult?.reason || 'unknown'}`;
      console.error('[orders/request] buyer email suppressed:', buyerResult?.reason);
    }
  } catch (e: any) {
    buyerEmailErr = e?.message || 'unknown';
    console.error('[orders/request] buyer email failed:', e?.message);
  }

  // ── Telegram alert to Ben ──
  // Truthful footer: surface whichever side's email failed so operator can
  // manually outreach. Prior alert claimed "Rancher emailed. Buyer confirmation
  // sent." regardless of actual outcome — silent failures bit Ashcraft-pattern
  // 2026-05-20 (rancher never got the lead, buyer thought we'd handed it off).
  try {
    if (TELEGRAM_ADMIN_CHAT_ID) {
      const rancherStatus = rancherEmail
        ? (rancherEmailSent ? '✅ rancher emailed' : `⚠️ RANCHER EMAIL FAILED (${rancherEmailErr})`)
        : '⚠️ rancher has no email on file';
      const buyerStatus = buyerEmailSent
        ? '✅ buyer confirmation sent'
        : `⚠️ BUYER EMAIL FAILED (${buyerEmailErr})`;
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
          `\n<i>${rancherStatus} · ${buyerStatus} · Referral ${referral.id}.</i>`
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
