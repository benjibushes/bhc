import { NextResponse, NextRequest } from 'next/server';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { sendEmail } from '@/lib/email';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '@/lib/secrets';
import { requireAdmin } from '@/lib/adminAuth';

// POST /api/admin/consumers/[id]/resend-warmup
//
// Server-side mint of the warmup-engage JWT + YES-button email. Use this
// (NEVER mint warmup-engage tokens in local scripts) so the token is
// signed with prod's JWT_SECRET and the link works when clicked.
//
// Body (optional JSON): { rancherStateName?: string } — used to personalize
//   subject/body ("we've got a rancher in {state} now"). Falls back to the
//   consumer's State field.
//
// Auth: requireAdmin() — bhc-admin-auth cookie for browser admins OR
// x-admin-password header for server-to-server. x-internal-secret still
// works for cron-style internal callers.

export const maxDuration = 30;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || '';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const internalHeader = request.headers.get('x-internal-secret') || '';
    const isInternal = INTERNAL_API_SECRET && internalHeader === INTERNAL_API_SECRET;
    if (!isInternal) {
      const unauthorized = await requireAdmin(request);
      if (unauthorized) return unauthorized;
    }

    const { id } = await context.params;
    if (!id || !id.startsWith('rec')) {
      return NextResponse.json({ error: 'Invalid consumer id' }, { status: 400 });
    }

    let consumer: any;
    try {
      consumer = await getRecordById(TABLES.CONSUMERS, id);
    } catch {
      return NextResponse.json({ error: 'Consumer not found' }, { status: 404 });
    }
    if (!consumer) return NextResponse.json({ error: 'Consumer not found' }, { status: 404 });
    if (consumer['Unsubscribed']) {
      return NextResponse.json({ error: 'Consumer is unsubscribed', skipped: true }, { status: 400 });
    }
    if (consumer['Warmup Engaged At']) {
      return NextResponse.json({ error: 'Already engaged', skipped: true, alreadyEngaged: true }, { status: 400 });
    }

    const email = String(consumer['Email'] || '').trim();
    if (!email) return NextResponse.json({ error: 'Consumer has no email' }, { status: 400 });

    const body = await request.json().catch(() => ({}));
    const state = String(consumer['State'] || body.rancherStateName || '').trim();
    const firstName = String(consumer['Full Name'] || consumer['Name'] || '').split(' ')[0] || 'there';

    // Mint with prod JWT_SECRET. 60-day expiry matches the signup-path mint.
    const token = jwt.sign({ type: 'warmup-engage', consumerId: id }, JWT_SECRET, { expiresIn: '60d' });
    const engageUrl = `${SITE_URL}/api/warmup/engage?token=${token}`;

    const subject = state
      ? `${firstName}, we've got a rancher in ${state} now`
      : `${firstName}, ready to buy?`;
    const stateLabel = state || 'your state';
    const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:40px;background:#F4F1EC;color:#0E0E0E;">
<h1 style="font-family:Georgia,serif;">hey ${firstName} —</h1>
<p>quick update: we now have a verified rancher serving ${stateLabel}, and you're one of the first I'm letting know.</p>
<p>back when you signed up, we didn't have anyone in your area yet. that's changed.</p>
<p><strong>One question:</strong> are you ready to buy in the next 1–2 months?</p>
<p>if yes, click below. I'll personally match you with the rancher serving ${stateLabel} and they'll reach out within 24–48 hours with pricing, processing dates, and how to lock in your order.</p>
<div style="text-align:center;margin:30px 0;">
  <a href="${engageUrl}" style="display:inline-block;padding:16px 40px;background:#0E0E0E;color:#F4F1EC;text-decoration:none;font-weight:bold;font-size:14px;letter-spacing:1px;text-transform:uppercase;">Yes — Ready to Buy</a>
  <p style="font-size:13px;color:#A7A29A;margin-top:10px;">one click confirms. we only introduce ranchers to confirmed buyers.</p>
</div>
<p style="font-size:14px;color:#6B4F3F;">not ready yet? just don't click. you stay on the list, no pressure.</p>
<p style="font-size:14px;color:#6B4F3F;">— Benjamin, BuyHalfCow</p>
</body></html>`;

    let sendOk = true;
    let sendErr = '';
    try {
      const r: any = await sendEmail({
        to: email,
        subject,
        html,
        _replyContext: { type: 'usr', recordId: id },
      } as any);
      if (r && r.suppressed) { sendOk = false; sendErr = r.reason ?? 'suppressed'; }
    } catch (e: any) {
      sendOk = false;
      sendErr = e?.message || 'unknown';
    }
    if (!sendOk) {
      console.error('resend-warmup email failed:', sendErr);
      return NextResponse.json({ error: 'Email send failed', detail: sendErr }, { status: 502 });
    }

    try {
      await updateRecord(TABLES.CONSUMERS, id, {
        'Warmup Sent At': new Date().toISOString(),
        'Buyer Stage': 'READY',
        'Buyer Stage Updated At': new Date().toISOString(),
        'Referral Status': 'Unmatched',
      });
    } catch (e: any) {
      console.warn('Could not stamp warmup fields:', e?.message);
    }

    return NextResponse.json({ success: true, sentTo: email, engageUrl });
  } catch (error: any) {
    console.error('resend-warmup error:', error);
    return NextResponse.json({ error: 'Could not resend warmup email' }, { status: 500 });
  }
}

// GET handler for visibility / health
export async function GET() {
  return NextResponse.json({
    info: 'Use POST. Auth: admin cookie or x-internal-secret header. Mints warmup-engage JWT server-side and sends the YES-button email.',
  });
}
