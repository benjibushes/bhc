import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';

export const maxDuration = 120;

// ─────────────────────────────────────────────────────────────────────────
// AUTO-VERIFY STALE
//
// Removes the last per-rancher MANUAL gate from onboarding so a 100-rancher
// wave never waits on a human tapping rverify_ in Telegram.
//
// Low-signal ranchers (no website/reviews/social) land in
// Onboarding Status='Verification Pending'. This daily cron clears any that
// have been pending >24h to 'Verification Complete' + Verification Status
// 'Verified', flagged PROVISIONAL so the operator can spot-check after the
// fact instead of gating signup on it. Go-live still requires the rancher to
// have actually signed + finished Connect + set a price, so this only removes
// the human bottleneck, it does not flip anyone live who isn't otherwise ready.
// ─────────────────────────────────────────────────────────────────────────

const STALE_MS = 24 * 60 * 60 * 1000;

async function realHandler(): Promise<{ status: 'success' | 'partial'; recordsTouched: number; notes: string }> {
  const ranchers = (await getAllRecords(TABLES.RANCHERS)) as any[];
  const now = Date.now();

  const stale = ranchers.filter((r) => {
    if (String(r['Onboarding Status'] || '') !== 'Verification Pending') return false;
    const reqAt = r['Verification Requested At'] || r['Docs Sent At'] || r['Agreement Signed At'];
    // No timestamp at all → treat as stale (it's been sitting). Otherwise require >24h.
    if (!reqAt) return true;
    const t = new Date(reqAt).getTime();
    return !Number.isFinite(t) || (now - t) >= STALE_MS;
  });

  const cleared: string[] = [];
  let errors = 0;
  for (const r of stale) {
    const name = r['Operator Name'] || r['Ranch Name'] || r.id;
    try {
      await updateRecord(TABLES.RANCHERS, r.id, {
        'Onboarding Status': 'Verification Complete',
        'Verification Status': 'Verified',
        'Verification Notes':
          `Provisional auto-verify ${new Date().toISOString().slice(0, 10)} — pending >24h, no manual review. SPOT-CHECK.` +
          (r['Verification Notes'] ? ` | prior: ${String(r['Verification Notes']).slice(0, 120)}` : ''),
      });
      cleared.push(name);
    } catch (e: any) {
      console.error(`[auto-verify-stale] update failed for ${r.id} (${name}):`, e?.message);
      errors++;
    }
  }

  if (cleared.length && TELEGRAM_ADMIN_CHAT_ID) {
    try {
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `🟢 <b>Auto-verified ${cleared.length} stale rancher${cleared.length === 1 ? '' : 's'}</b> (pending >24h)\n` +
          `${cleared.slice(0, 10).join(', ')}${cleared.length > 10 ? ` +${cleared.length - 10} more` : ''}\n\n` +
          `<i>Provisional — spot-check their materials when you can. They still must finish Connect + price to go live.</i>`,
      );
    } catch { /* non-fatal */ }
  }

  return {
    status: errors > 0 ? 'partial' : 'success',
    recordsTouched: cleared.length,
    notes: `cleared=${cleared.length} errors=${errors}${cleared.length ? ` | ${cleared.slice(0, 8).join(', ')}` : ''}`,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('auto-verify-stale', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
