// app/api/rancher/referrals/[id]/accept/route.ts
//
// NRD-2 (2026-06-05): Rancher confirms they will fulfill this buyer's
// processing slot. Stamps Rancher Accepted At, which becomes the
// non-refundable cutoff per BHC's deposit policy.
//
// Before this stamp: buyer can request a refund and we auto-process
// (rancher hasn't committed, no real loss to them).
// After this stamp: deposit is locked. Buyer needs cause (cold-chain
// failure, rancher cancels, BHC mediation outcome).
//
// Auth: requires rancher session cookie (same as the existing PATCH
// handler on the parent route).
//
// Idempotency: if already accepted, returns 200 with the original
// timestamp so a double-tap doesn't blow up the rancher's dashboard.
//
// Side effects:
//   - Stamps Rancher Accepted At + Notes append
//   - Sends buyer "deposit locked" email (transactional, branded)
//   - Telegram operator alert
//   - Audit log
import { NextResponse } from 'next/server';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { requireRancher } from '@/lib/rancherAuth';
import { sendEmail } from '@/lib/email';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';

export const maxDuration = 30;

function esc(s: string): string {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildBuyerLockEmail(args: {
  firstName: string;
  rancherName: string;
  ranchName: string;
  acceptedAt: string;
}): { subject: string; html: string } {
  const first = args.firstName || 'there';
  const subject = `${first} — ${args.rancherName} accepted your slot`;
  const dateStr = new Date(args.acceptedAt).toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' });
  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px;">
<div style="max-width:600px;margin:0 auto;background:white;padding:40px;border:1px solid #A7A29A;">
  <p style="font-family:Georgia,serif;font-size:24px;margin:0 0 14px;">Slot locked in.</p>
  <p>Hey ${esc(first)} — <strong>${esc(args.rancherName)}</strong>${args.ranchName ? ` at ${esc(args.ranchName)}` : ''} just accepted your deposit and committed your processing slot.</p>

  <div style="background:#F4F1EC;border-left:4px solid #6B4F3F;padding:14px 18px;margin:18px 0;">
    <p style="margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:2px;color:#6B4F3F;">What this means</p>
    <p style="margin:0;font-size:14px;line-height:1.6;">
      Your deposit is now non-refundable. ${esc(args.rancherName)} has set aside cuts of meat for you and put your processing slot on their calendar. The BHC cold-chain guarantee + dispute mediation still apply.
    </p>
  </div>

  <p><strong>Next steps:</strong></p>
  <ul style="padding-left:20px;line-height:1.7;">
    <li>${esc(args.rancherName)} will reach out within 24h to confirm pickup/delivery details</li>
    <li>You&rsquo;ll get a fulfillment confirmation email when your beef is ready</li>
    <li>Final invoice (balance due) gets sent when processing completes</li>
  </ul>

  <p style="font-size:13px;color:#6B4F3F;margin-top:24px;">Accepted ${esc(dateStr)} · Questions? Reply here. — Benjamin, BuyHalfCow</p>
</div>
</body></html>`;
  return { subject, html };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await requireRancher(request);
    if (auth instanceof NextResponse) return auth;
    const rancherId = auth.session.rancherId;
    const rancherName = auth.session.name || 'Your rancher';
    const ranchName = auth.session.ranchName || '';

    const { id } = await params;
    const referral = (await getRecordById(TABLES.REFERRALS, id)) as any;
    if (!referral) {
      return NextResponse.json({ error: 'Referral not found' }, { status: 404 });
    }

    // Owner check — only the assigned/suggested rancher can accept their own.
    const assignedIds = referral['Rancher'] || [];
    const suggestedIds = referral['Suggested Rancher'] || [];
    const isOwner =
      (Array.isArray(assignedIds) && assignedIds.includes(rancherId)) ||
      (Array.isArray(suggestedIds) && suggestedIds.includes(rancherId));
    if (!isOwner) {
      return NextResponse.json({ error: 'Not authorized for this referral' }, { status: 403 });
    }

    // Gate: only accept once a deposit actually exists. Without this a rancher
    // could lock a buyer in before any money changed hands — destroying the
    // refund-window protection from the buyer side.
    const depositPaidAt = referral['Deposit Paid At'];
    if (!depositPaidAt) {
      return NextResponse.json(
        {
          error: 'Cannot accept yet — buyer has not paid deposit',
          hint: 'Accept fires only after Stripe Connect deposit lands. Check back after buyer completes checkout.',
        },
        { status: 409 },
      );
    }

    // Idempotency — if already accepted, return the original timestamp.
    const existing = referral['Rancher Accepted At'];
    if (existing) {
      return NextResponse.json({
        ok: true,
        alreadyAccepted: true,
        acceptedAt: existing,
      });
    }

    const nowIso = new Date().toISOString();

    // Stamp the record. Append to Notes so the audit trail is on the row.
    try {
      const existingNotes = String(referral['Notes'] || '');
      await updateRecord(TABLES.REFERRALS, id, {
        'Rancher Accepted At': nowIso,
        'Notes':
          `[NRD-accept ${nowIso.slice(0, 16)}] ${rancherName} confirmed processing slot. ${existingNotes}`.slice(
            0,
            2000,
          ),
      });
    } catch (e: any) {
      console.error('[NRD-accept] referral update failed:', e?.message);
      return NextResponse.json(
        { error: 'Could not save acceptance. Try again.', details: e?.message },
        { status: 500 },
      );
    }

    // Buyer notification — transactional, customer-expected.
    const buyerEmail = (referral['Buyer Email'] || '').toString().trim();
    const buyerName = (referral['Buyer Name'] || '').toString().trim();
    const firstName = buyerName.split(' ')[0] || 'there';
    if (buyerEmail) {
      try {
        const { subject, html } = buildBuyerLockEmail({ firstName, rancherName, ranchName, acceptedAt: nowIso });
        await sendEmail({
          to: buyerEmail,
          subject,
          html,
          templateName: 'sendBuyerSlotLocked',
          _replyContext: { type: 'ref', recordId: id },
        });
      } catch (e: any) {
        // Don't fail the accept on email error — the audit field is stamped.
        console.warn('[NRD-accept] buyer email failed:', e?.message);
      }
    }

    // F9 — SMS (gated by ENABLE_SMS feature flag, default OFF)
    try {
      const { getAllRecords } = await import('@/lib/airtable');
      const buyerLink = Array.isArray(referral['Buyer']) ? referral['Buyer'][0] : null;
      let buyerRecord: any = null;
      if (buyerLink) {
        const { getRecord: getRec } = await import('@/lib/airtable');
        buyerRecord = await getRec(TABLES.CONSUMERS, buyerLink).catch(() => null);
      } else if (buyerEmail) {
        const list = await getAllRecords(TABLES.CONSUMERS, `{Email}="${buyerEmail.toLowerCase()}"`) as any[];
        buyerRecord = list[0] || null;
      }
      const { fireSMSEvent } = await import('@/lib/smsEvents');
      await fireSMSEvent({
        type: 'slot_locked',
        consumer: buyerRecord,
        vars: { firstName, ranchName },
      });
    } catch (e: any) {
      console.warn('[NRD-accept] SMS fire failed:', e?.message);
    }

    // Operator visibility.
    try {
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `🔒 <b>DEPOSIT LOCKED</b>\n\n` +
          `Rancher: ${rancherName}\n` +
          `Buyer: ${buyerName || buyerEmail || '?'}\n` +
          `Referral: ${id}\n` +
          `<i>Rancher accepted processing slot. Deposit now non-refundable per NRD policy.</i>`,
      );
    } catch {}

    return NextResponse.json({
      ok: true,
      acceptedAt: nowIso,
      message: 'Slot accepted. Deposit is now non-refundable per NRD policy.',
    });
  } catch (error: any) {
    console.error('[NRD-accept] handler error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
