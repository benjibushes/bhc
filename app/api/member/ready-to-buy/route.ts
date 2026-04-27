import { NextResponse } from 'next/server';
import { getRecordById, getAllRecords, updateRecord, escapeAirtableValue } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { sendEmail } from '@/lib/email';

export const maxDuration = 30;

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-member-secret-change-me';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

// Member clicks "Ready to buy this month" on the dashboard. This is the
// highest-intent signal we have — the buyer is self-identifying as a hot lead.
// We:
//   1. Stamp the consumer Notes with a timestamp so it's visible in Airtable.
//   2. Telegram Ben so he can follow up personally.
//   3. Email the matched rancher (if any) so they know to call the buyer.
//
// Deliberately NOT creating a new Airtable field — keeps this shippable
// without a schema migration. If the signal becomes critical, promote to
// a dedicated singleSelect/dateTime field later.
export async function POST(request: Request) {
  try {
    const cookieStore = await cookies();
    const sessionCookie = cookieStore.get('bhc-member-auth');
    if (!sessionCookie?.value) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    let memberId = '';
    let memberEmail = '';
    try {
      const decoded: any = jwt.verify(sessionCookie.value, JWT_SECRET);
      if (decoded.type === 'member-session') {
        memberId = decoded.consumerId || '';
        memberEmail = decoded.email || '';
      }
    } catch {
      return NextResponse.json({ error: 'Session expired' }, { status: 401 });
    }
    if (!memberId) {
      return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
    }

    const consumer: any = await getRecordById(TABLES.CONSUMERS, memberId);
    if (!consumer) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    const buyerName = consumer['Full Name'] || '';
    const buyerState = consumer['State'] || '';
    const buyerPhone = consumer['Phone'] || '';
    const buyerOrderType = consumer['Order Type'] || '';
    const buyerBudget = consumer['Budget'] || '';
    const firstName = buyerName.split(' ')[0] || 'there';

    // 1. Append ready-to-buy marker to Notes (idempotent — skip if flagged in last 24h)
    const now = new Date();
    const existingNotes: string = consumer['Notes'] || '';
    const recentlyFlagged = /\[READY TO BUY\s+(\d{4}-\d{2}-\d{2})/i.test(existingNotes) &&
      (() => {
        const match = existingNotes.match(/\[READY TO BUY\s+(\d{4}-\d{2}-\d{2}T[^\]]+)\]/i);
        if (!match) return false;
        const lastFlag = new Date(match[1]);
        return (now.getTime() - lastFlag.getTime()) < 24 * 60 * 60 * 1000;
      })();

    if (!recentlyFlagged) {
      const marker = `[READY TO BUY ${now.toISOString()}]`;
      const newNotes = existingNotes ? `${marker}\n${existingNotes}` : marker;
      try {
        await updateRecord(TABLES.CONSUMERS, memberId, {
          'Notes': newNotes,
          // Set the structured checkbox so isQualifiedForRouting + email
          // subject prefix + Telegram alerts all recognize this as a
          // ready-to-buy signal. Notes stays for human-readable history.
          'Ready to Buy': true,
        });
      } catch (e) {
        console.error('Error updating consumer notes:', e);
      }
    }

    // 2. Find the buyer's active matched rancher (if any)
    let matchedRancher: any = null;
    let activeReferral: any = null;
    try {
      const refs = await getAllRecords(
        TABLES.REFERRALS,
        `AND({Buyer Email} = "${escapeAirtableValue((memberEmail || '').toLowerCase())}", OR({Status} = "Intro Sent", {Status} = "Rancher Contacted", {Status} = "Negotiation"))`
      ) as any[];
      activeReferral = refs[0] || null;
      if (activeReferral) {
        const rancherLinks = activeReferral['Rancher'] || activeReferral['Suggested Rancher'] || [];
        const rancherId = Array.isArray(rancherLinks) ? rancherLinks[0] : null;
        if (rancherId) {
          matchedRancher = await getRecordById(TABLES.RANCHERS, rancherId);
        }
      }
    } catch (e) {
      console.error('Error loading matched rancher:', e);
    }

    // 3. Telegram Ben
    try {
      const rancherLine = matchedRancher
        ? `🤠 Matched with: ${matchedRancher['Operator Name'] || matchedRancher['Ranch Name']}`
        : `⚠️ No active match — needs manual outreach`;
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `🔥 <b>READY TO BUY</b>\n\n` +
        `👤 ${buyerName} in ${buyerState}\n` +
        `📦 ${buyerOrderType || 'Not specified'} · ${buyerBudget || 'Budget unknown'}\n` +
        `📧 ${memberEmail}\n` +
        (buyerPhone ? `📞 ${buyerPhone}\n` : '') +
        `${rancherLine}\n\n` +
        `They just tapped "Ready to buy this month." Call them this week.`
      );
    } catch (e) {
      console.error('Error sending Telegram ready-to-buy alert:', e);
    }

    // 4. Email the matched rancher (if any)
    if (matchedRancher && matchedRancher['Email']) {
      try {
        const rancherName = matchedRancher['Operator Name'] || matchedRancher['Ranch Name'] || 'Partner';
        await sendEmail({
          to: matchedRancher['Email'],
          subject: `🔥 ${firstName} is ready to buy — call this week`,
          html: `
            <div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;">
              <h1 style="font-family:Georgia,serif;font-size:24px;margin:0 0 20px;">Your buyer just flagged as ready to purchase</h1>
              <p style="color:#6B4F3F;">Hi ${rancherName},</p>
              <p style="color:#6B4F3F;"><strong>${buyerName}</strong> in ${buyerState} — who I introduced you to earlier — just tapped "Ready to buy this month" on their BuyHalfCow dashboard.</p>
              <p style="color:#6B4F3F;">This is the clearest signal I can give you: they want to pull the trigger. If you can, call or email them this week before they cool off.</p>
              <div style="background:#F4F1EC;border-left:3px solid #0E0E0E;padding:16px 20px;margin:20px 0;">
                <p style="margin:6px 0;"><strong>${buyerName}</strong></p>
                <p style="margin:6px 0;">📧 <a href="mailto:${memberEmail}" style="color:#0E0E0E;">${memberEmail}</a></p>
                ${buyerPhone ? `<p style="margin:6px 0;">📞 <a href="tel:${buyerPhone}" style="color:#0E0E0E;">${buyerPhone}</a></p>` : ''}
                <p style="margin:6px 0;"><strong>Wants:</strong> ${buyerOrderType || 'Not specified'}${buyerBudget ? ' · ' + buyerBudget : ''}</p>
              </div>
              <p style="color:#6B4F3F;">Reply-all if you need me to help close, or mark this one as "Closed Won" in your <a href="${SITE_URL}/rancher" style="color:#0E0E0E;">rancher dashboard</a> after the sale.</p>
              <p style="color:#6B4F3F;margin-top:30px;">— Benjamin, BuyHalfCow</p>
            </div>`,
        });
      } catch (e) {
        console.error('Error emailing rancher ready-to-buy alert:', e);
      }
    }

    return NextResponse.json({
      success: true,
      hasMatch: !!matchedRancher,
      rancherName: matchedRancher ? (matchedRancher['Operator Name'] || matchedRancher['Ranch Name']) : null,
      alreadyFlagged: recentlyFlagged,
    });
  } catch (error: any) {
    console.error('Error in ready-to-buy:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
