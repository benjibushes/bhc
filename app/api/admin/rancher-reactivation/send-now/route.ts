// app/api/admin/rancher-reactivation/send-now/route.ts
//
// One-click operator trigger for the Rancher Reactivation Campaign
// first-touch blast. Drives the "📣 Reactivation Campaign" panel on
// /admin/migration (Preview + Send Now buttons).
//
// POST → runReactivationSend({ cap: 1000 }) — sends to ALL eligible
// first-touch ranchers (Tier A warm first, then Tier B cold) with the
// EXACT same suppression / dedupe / stamp / audit behavior the daily cron
// uses. ?dryRun=1 → segment + report only, sends nothing.
//
// Auth: same pattern as /api/admin/ranchers/[id]/send-v2-upgrade —
// x-internal-secret OR requireAdmin (cookie / x-admin-password).
//
// DELIBERATELY NOT gated on RANCHER_REACTIVATION_ENABLED or
// CAMPAIGN_START_DATE. Those gates exist to keep the *scheduled cron*
// inert until Ben arms it. The authenticated admin click here IS the
// authorization — the operator is explicitly choosing to send now.

import { NextResponse, NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';
import { runReactivationSend } from '@/lib/rancherReactivation';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';

export const maxDuration = 180;

const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || '';

// Large enough to cover the entire ~44-rancher dormant audience in one
// click. The cron stays at 8/run; the button sends everyone eligible.
const SEND_NOW_CAP = 1000;

export async function POST(request: NextRequest) {
  // Auth: internal secret OR admin session (mirrors send-v2-upgrade).
  const internalHeader = request.headers.get('x-internal-secret') || '';
  const isInternal = INTERNAL_API_SECRET && internalHeader === INTERNAL_API_SECRET;
  if (!isInternal) {
    const unauthorized = await requireAdmin(request);
    if (unauthorized) return unauthorized;
  }

  // ?dryRun=1 (or =true) → Preview: segment + report, send nothing.
  let dryRun = false;
  try {
    const dr = new URL(request.url).searchParams.get('dryRun');
    dryRun = dr === '1' || dr === 'true';
  } catch {
    // Invalid URL — default to a real send only if the admin explicitly
    // POSTed; but safest is to treat a malformed URL as dryRun=false (the
    // UI always sends a well-formed ?dryRun query).
  }

  try {
    const result = await runReactivationSend({
      now: new Date(),
      dryRun,
      cap: SEND_NOW_CAP,
      actor: 'manual',
      tool: 'rancher-reactivation-send-now',
    });

    // Operator digest. In dryRun this reports what WOULD send; on a real
    // send it reports what actually went out.
    try {
      const lines: string[] = dryRun
        ? [
            '📣 <b>REACTIVATION — PREVIEW</b>',
            '',
            `Would send to ${result.names.length} ranchers`,
            `Tier A: ${result.tierACounted} · Tier B: ${result.tierBCounted}`,
          ]
        : [
            '📣 <b>REACTIVATION — SENT NOW (manual)</b>',
            '',
            `Sent: ${result.sent}`,
            `Skipped (suppressed/failed): ${result.skipped}`,
            `Tier A: ${result.tierACounted} · Tier B: ${result.tierBCounted}`,
          ];
      if (result.names.length > 0) {
        lines.push('', '<b>Ranchers:</b>', ...result.names.slice(0, 50).map((n) => `• ${n}`));
      }
      if (result.failures.length > 0) {
        lines.push('', '<b>Failures:</b>', ...result.failures.slice(0, 12).map((f) => `• ${f}`));
      }
      await sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, lines.join('\n'));
    } catch {
      // Telegram is best-effort — never fail the send because the digest didn't post.
    }

    return NextResponse.json({
      ok: true,
      dryRun: result.dryRun,
      sent: result.sent,
      skipped: result.skipped,
      tierACounted: result.tierACounted,
      tierBCounted: result.tierBCounted,
      names: result.names,
    });
  } catch (error: any) {
    console.error('rancher-reactivation send-now error:', error);
    return NextResponse.json(
      { ok: false, error: error?.message || 'Could not run reactivation send' },
      { status: 500 },
    );
  }
}
