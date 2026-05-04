import { NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { JWT_SECRET } from '@/lib/secrets';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';

// Self-serve removal endpoint. Rancher hits this from the wizard's "Remove me
// from the database" link or from the re-engagement email's opt-out link.
//
// Auth: rancher-setup JWT (same token type used by /api/rancher/setup —
// reuse so users on existing magic links can remove without a new token mint).
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
  const decoded = verifyToken(token);
  if (!decoded) {
    return NextResponse.json({ error: 'Invalid or expired removal link' }, { status: 401 });
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
    rancher = await getRecordById(TABLES.RANCHERS, decoded.rancherId);
  } catch {
    return NextResponse.json({ error: 'Rancher record not found' }, { status: 404 });
  }
  if (!rancher) {
    return NextResponse.json({ error: 'Rancher record not found' }, { status: 404 });
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
    await updateRecord(TABLES.RANCHERS, decoded.rancherId, updates);
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
