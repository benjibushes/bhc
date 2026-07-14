import { NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { JWT_SECRET } from '@/lib/secrets';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { requireRancher } from '@/lib/rancherAuth';
import { getLiveCapacity } from '@/lib/rancherCapacity';

// Self-serve removal endpoint. Rancher hits this from the wizard's "Remove me
// from the database" link or from the re-engagement email's opt-out link.
//
// Auth (two doors, same soft-delete):
//   1. rancher-setup JWT via ?token= (same token type as /api/rancher/setup —
//      reuse so users on existing magic links can remove without a new mint).
//   2. logged-in dashboard session (bhc-rancher-auth cookie) — before this,
//      an onboarded rancher had NO self-serve way to close their account.
//
// Behavior: soft-delete. We don't drop the row — we flip:
//   Verification Status: Removed
//   Public Map Hidden:   true
//   Active Status:       Paused
//   Self-Submit Drip Stage: stopped (if currently set, halts cron drip)
//
// The record stays in Airtable for audit/history but disappears from the
// public map, the buyer routing layer, and the onboarding drip cron. Ben
// gets a Telegram alert with reason (if provided).

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function verifyToken(token: string): { rancherId: string } | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    if (decoded.type !== 'rancher-setup' || !decoded.rancherId) return null;
    return { rancherId: decoded.rancherId };
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get('token') || '';
  let rancherId = token ? verifyToken(token)?.rancherId || '' : '';
  if (!rancherId) {
    if (token) {
      // A token was presented and failed — keep the link-specific message.
      return NextResponse.json({ error: 'Invalid or expired removal link' }, { status: 401 });
    }
    const r = await requireRancher(req);
    if (r instanceof NextResponse) return r;
    rancherId = r.session.rancherId;
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    // Reason is optional — empty body OK.
  }
  const reason = String(body.reason || '').trim().slice(0, 500);

  let rancher: any;
  try {
    rancher = await getRecordById(TABLES.RANCHERS, rancherId);
  } catch {
    return NextResponse.json({ error: 'Rancher record not found' }, { status: 404 });
  }
  if (!rancher) {
    return NextResponse.json({ error: 'Rancher record not found' }, { status: 404 });
  }

  // Mid-deal guard (both auth doors — a wizard-stage rancher simply has no
  // held referrals): a rancher holding live buyers can't self-close, or those
  // buyers silently lose their deal mid-payment.
  try {
    const held = await getLiveCapacity(rancherId);
    if (held > 0) {
      return NextResponse.json(
        { error: "You have active buyers mid-deal. Finish those deals or email hello@buyhalfcow.com and we'll close things out together." },
        { status: 409 },
      );
    }
  } catch (e: any) {
    // Fail closed: if we can't verify there are no live buyers, don't remove.
    console.error('[rancher/remove] held-referral check failed:', e?.message);
    return NextResponse.json({ error: 'Could not verify your account has no active deals — try again in a moment' }, { status: 500 });
  }

  const ranchName = (rancher['Ranch Name'] || rancher['Operator Name'] || 'Rancher').toString();
  const operatorName = (rancher['Operator Name'] || '').toString();
  const email = (rancher['Email'] || '').toString();
  const state = (rancher['State'] || '').toString();

  // Soft-delete: flip the gating fields. Keep the record + history.
  const updates: Record<string, any> = {
    'Verification Status': 'Removed',
    'Public Map Hidden': true,
    'Active Status': 'Paused',
  };
  // Stop drip cron if it was running
  if (rancher['Self-Submit Drip Stage'] && rancher['Self-Submit Drip Stage'] !== 'stopped') {
    updates['Self-Submit Drip Stage'] = 'stopped';
  }
  // Append reason to Notes for audit trail
  if (reason) {
    const existingNotes = (rancher['Notes'] || '').toString();
    const stamp = `[REMOVED ${new Date().toISOString().slice(0, 10)}] ${reason}`;
    updates['Notes'] = existingNotes ? `${existingNotes}\n\n${stamp}` : stamp;
  }

  try {
    await updateRecord(TABLES.RANCHERS, rancherId, updates);
  } catch (e: any) {
    console.error('[rancher/remove] update failed:', e?.message);
    return NextResponse.json({ error: 'Removal failed — try again' }, { status: 500 });
  }

  // Telegram alert
  try {
    if (TELEGRAM_ADMIN_CHAT_ID) {
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `🚪 <b>RANCHER REMOVED (self-serve)</b>\n\n` +
        `🤠 ${ranchName}${operatorName && operatorName !== ranchName ? ` (${operatorName})` : ''}\n` +
        `📧 ${email || '(no email)'}\n` +
        `📍 ${state || '?'}\n` +
        (reason ? `\n<b>Reason:</b> ${reason}` : '\n<i>No reason given.</i>') +
        `\n\nRecord soft-deleted: hidden from map, paused, drip stopped. Airtable row preserved for audit.`
      );
    }
  } catch (e: any) {
    console.error('[rancher/remove] telegram alert failed:', e?.message);
  }

  return NextResponse.json({
    success: true,
    message: `${ranchName} removed from BuyHalfCow.`,
  });
}
