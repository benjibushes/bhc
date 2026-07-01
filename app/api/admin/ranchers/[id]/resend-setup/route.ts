import { NextResponse, NextRequest } from 'next/server';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { sendEmail } from '@/lib/email';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '@/lib/secrets';
import { requireRole } from '@/lib/adminAuth';

// POST /api/admin/ranchers/[id]/resend-setup
//
// Mints a fresh 60-day rancher-setup JWT (using PROD's JWT_SECRET) and emails
// the rancher their setup-wizard link. Stamps `Docs Sent At` on the record.
//
// Why this exists as a server-side endpoint:
//   JWT_SECRET only lives on Vercel. Local scripts can't mint tokens that
//   prod will accept. Any operator-side "send setup link" action must run
//   on the server. This endpoint is the canonical path.
//
// Auth: requireAdmin() handles browser admins (bhc-admin-auth cookie)
//   AND ops scripts (x-admin-password header). x-internal-secret kept as
//   a separate cron-style backdoor.

export const maxDuration = 30;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || '';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    // ── Auth: requireAdmin OR internal-secret header ──────────────────────
    const internalHeader = request.headers.get('x-internal-secret') || '';
    const isInternal = INTERNAL_API_SECRET && internalHeader === INTERNAL_API_SECRET;
    if (!isInternal) {
      // Opened to 'onboarding' partner: resending setup links is a core
      // onboarding action and carries no money/PII risk.
      const unauthorized = await requireRole(request, ['admin', 'onboarding']);
      if (unauthorized) return unauthorized;
    }

    const { id } = await context.params;
    if (!id || !id.startsWith('rec')) {
      return NextResponse.json({ error: 'Invalid rancher id' }, { status: 400 });
    }

    let rancher: any;
    try {
      rancher = await getRecordById(TABLES.RANCHERS, id);
    } catch {
      return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });
    }
    if (!rancher) return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });

    const email: string = (rancher['Email'] || '').toString().trim();
    if (!email) {
      return NextResponse.json({ error: 'Rancher has no email on file' }, { status: 400 });
    }
    const name: string = (rancher['Operator Name'] || rancher['Ranch Name'] || '').toString();
    const firstName = name.split(' ')[0] || 'there';
    const ranchName: string = (rancher['Ranch Name'] || name).toString();

    // Mint with prod's JWT_SECRET. 60-day expiry matches self-submit flow.
    const token = jwt.sign({ type: 'rancher-setup', rancherId: id }, JWT_SECRET, { expiresIn: '60d' });
    const setupUrl = `${SITE_URL}/rancher/setup?token=${token}`;

    const subject = `${firstName}, your ${ranchName} setup link`;
    const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:40px;background:#F4F1EC;color:#0E0E0E;">
<h1 style="font-family:Georgia,serif;margin:0 0 20px 0;">Hi ${firstName} — let's get ${ranchName} live</h1>
<p>Here's your setup link. It's a short wizard — confirms your info, signs the partner agreement, and gets your page online.</p>
<p>Most folks finish in under 10 minutes.</p>
<div style="text-align:center;margin:32px 0;">
  <a href="${setupUrl}" style="display:inline-block;padding:16px 40px;background:#0E0E0E;color:#F4F1EC;text-decoration:none;font-weight:bold;font-size:14px;letter-spacing:1px;text-transform:uppercase;">Start Setup</a>
  <p style="font-size:12px;color:#A7A29A;margin-top:10px;">This link is yours — valid for 60 days.</p>
</div>
<p style="font-size:14px;color:#6B4F3F;"><strong>What's in the wizard:</strong></p>
<ul style="color:#6B4F3F;line-height:1.8;">
  <li>Confirm contact + service area</li>
  <li>Add your tagline, about text, photos</li>
  <li>Sign the partner agreement (10% commission, 24mo term, no upfront fees)</li>
  <li>Set pricing for quarter / half / whole</li>
  <li>Page goes live after verification (usually same-day)</li>
</ul>
<p style="font-size:14px;color:#6B4F3F;">Questions? Just reply — I read every email.</p>
<p style="font-size:14px;color:#6B4F3F;">— Benjamin, BuyHalfCow</p>
</body></html>`;

    let sendOk = true;
    let sendErr = '';
    try {
      const r: any = await sendEmail({
        to: email,
        subject,
        html,
        _replyContext: { type: 'rnc', recordId: id },
      } as any);
      if (r && r.suppressed) { sendOk = false; sendErr = r.reason ?? 'suppressed'; }
    } catch (e: any) {
      sendOk = false;
      sendErr = e?.message || 'unknown';
    }

    if (!sendOk) {
      console.error('Resend setup email failed:', sendErr);
      return NextResponse.json({ error: 'Email send failed', detail: sendErr }, { status: 502 });
    }

    // Stamp Docs Sent At (date-only)
    try {
      await updateRecord(TABLES.RANCHERS, id, {
        'Docs Sent At': new Date().toISOString().slice(0, 10),
      });
    } catch (e: any) {
      console.warn('Could not stamp Docs Sent At:', e?.message);
    }

    try {
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `📨 <b>Setup link resent</b>\n\n🤠 ${name}\n📧 ${email}\nState: ${rancher['State'] || '?'}\nLink valid 60d.`
      );
    } catch {}

    return NextResponse.json({ success: true, sentTo: email, setupUrl });
  } catch (error: any) {
    console.error('resend-setup error:', error);
    return NextResponse.json({ error: 'Could not resend setup link' }, { status: 500 });
  }
}
