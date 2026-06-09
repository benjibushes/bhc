import { NextResponse } from 'next/server';
import { getRecordById, TABLES } from '@/lib/airtable';
import { clearRancherCalTokens, deleteCalWebhook } from '@/lib/cal';
import { resolveRancherSession } from '@/lib/rancherAuth';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { logAuditEntry } from '@/lib/auditLog';

// POST /api/rancher/cal/disconnect
//
// Rancher-initiated revocation of our Cal connection. Best-effort: tries
// to delete the registered Cal webhook first so we don't leave it
// firing-and-403ing forever, then nukes all four token fields + the
// stored ids from the Rancher row.
//
// Does NOT touch the rancher's Cal account or their event types — those
// live on their side. Just our connection.
//
// Re-connecting later means re-running the full OAuth + setup-event-types
// flow (event types get recreated, new webhook subscribed). The old
// event types on Cal-side persist with their existing slug, so if you
// re-connect the SAME rancher's Cal account, you'll get a Cal-side
// "duplicate slug" error and either need to delete the old ones or pick
// a different slug suffix.

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(req: Request) {
  const r = await resolveRancherSession(req);
  if (!r) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  let rancher: any;
  try {
    rancher = await getRecordById(TABLES.RANCHERS, r.rancherId);
  } catch {
    return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });
  }
  if (!rancher) return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });

  const accessToken = String(rancher['Cal OAuth Access Token'] || '');
  const webhookId = String(rancher['Cal Webhook Id'] || '');
  const ranchName = String(rancher['Ranch Name'] || rancher['Operator Name'] || 'Ranch');

  // ─── Try to delete the webhook subscription first ───────────────────
  // If this fails (Cal-side issue, network blip, deauth already happened),
  // we still proceed with clearing local tokens — we don't want a stuck
  // disconnect blocking the rancher from re-trying.
  if (webhookId && accessToken) {
    try {
      await deleteCalWebhook({ rancher, webhookId });
    } catch (e: any) {
      console.warn('[cal/disconnect] webhook delete failed (continuing):', e?.message);
    }
  }

  // ─── Clear all stored Cal tokens + ids ─────────────────────────────
  try {
    await clearRancherCalTokens(r.rancherId);
  } catch (e: any) {
    console.error('[cal/disconnect] token clear failed:', e?.message);
    return NextResponse.json({ error: 'Could not clear tokens — try again' }, { status: 500 });
  }

  // ─── Audit log + Telegram ──────────────────────────────────────────
  try {
    await logAuditEntry({
      actor: 'manual',
      tool: 'cal-disconnect',
      targetType: 'Rancher',
      targetId: r.rancherId,
      args: { initiatedBy: r.rancherId },
      result: { ok: true, webhookDeleted: !!webhookId },
      // No reverseAction — tokens are nuked, only recovery path is full
      // re-OAuth from the rancher's side.
      reverseAction: { type: 'manual', description: 'Rancher must re-OAuth via /api/auth/cal/start to restore connection.' } as any,
    });
  } catch {}

  try {
    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      `🔌 <b>Cal disconnected</b>\n\n` +
        `🤠 ${ranchName}\n\n` +
        `<i>Tokens nuked. Webhook deletion: ${webhookId ? 'attempted' : 'n/a'}.\nRancher can reconnect via wizard or dashboard CTA.</i>`,
    );
  } catch {}

  return NextResponse.json({ ok: true });
}
