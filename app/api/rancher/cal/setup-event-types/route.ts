import { NextResponse } from 'next/server';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { createEventTypeForRancher, registerCalWebhook } from '@/lib/cal';
import { resolveRancherSession } from '@/lib/rancherAuth';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';

// POST /api/rancher/cal/setup-event-types
//
// One-shot post-Cal-connect setup. Creates the two standard BHC event
// types on the rancher's Cal account + registers our webhook so booking
// events flow back. Idempotent — re-running re-issues only the missing
// pieces (won't double-create).
//
// Flow:
//   1. Rancher hits "Connect Cal" → /api/auth/cal/start → Cal authorize
//      → /api/auth/cal/callback persists tokens
//   2. Wizard auto-fires POST here to set up slots + webhook
//   3. Persists event_type_ids + webhook_id on the Rancher row
//   4. Rancher is now ready for buyer bookings through Atoms embeds
//
// Telegram-alerts on errors so the operator can intervene before the
// rancher hits the dashboard expecting a working setup.

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';
const CAL_WEBHOOK_SECRET = process.env.CAL_WEBHOOK_SECRET || '';

interface SetupResult {
  introEventTypeId: number | null;
  salesEventTypeId: number | null;
  webhookId: string | null;
  errors: string[];
}

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
  if (!accessToken) {
    return NextResponse.json({ error: 'Cal not connected — finish OAuth first' }, { status: 412 });
  }

  const ranchName = String(rancher['Ranch Name'] || rancher['Operator Name'] || 'Ranch');
  const result: SetupResult = {
    introEventTypeId: rancher['Cal Event Type Intro Id'] ? Number(rancher['Cal Event Type Intro Id']) : null,
    salesEventTypeId: rancher['Cal Event Type Sales Id'] ? Number(rancher['Cal Event Type Sales Id']) : null,
    webhookId: rancher['Cal Webhook Id'] ? String(rancher['Cal Webhook Id']) : null,
    errors: [],
  };
  const fields: Record<string, any> = {};

  // ─── Intro event type ──────────────────────────────────────────────
  if (!result.introEventTypeId) {
    try {
      const intro = await createEventTypeForRancher({
        rancher,
        payload: {
          lengthInMinutes: 15,
          title: `Intro call — ${ranchName}`,
          slug: 'buyhalfcow-intro-15',
          description: `Meet the team at ${ranchName} before you place a deposit. Walk through pricing, processing date, cut options, and delivery — direct with the rancher, no middleman. Booked via BuyHalfCow.`,
          metadata: { source: 'bhc', tier: 'intro' },
        },
      });
      result.introEventTypeId = intro.id;
      fields['Cal Event Type Intro Id'] = intro.id;
    } catch (e: any) {
      result.errors.push(`intro: ${e?.message || 'unknown'}`);
    }
  }

  // ─── Sales event type (used for Operator tier — Ben hosts on rancher cal) ──
  if (!result.salesEventTypeId) {
    try {
      const sales = await createEventTypeForRancher({
        rancher,
        payload: {
          lengthInMinutes: 30,
          title: `Sales call — ${ranchName}`,
          slug: 'buyhalfcow-sales-30',
          description: `Walk through ${ranchName}'s pricing, processing date, cuts, fulfillment, and reserve your share with a deposit. Hosted by Ben (BuyHalfCow operator) for Operator-tier ranches.`,
          metadata: { source: 'bhc', tier: 'sales' },
        },
      });
      result.salesEventTypeId = sales.id;
      fields['Cal Event Type Sales Id'] = sales.id;
    } catch (e: any) {
      result.errors.push(`sales: ${e?.message || 'unknown'}`);
    }
  }

  // ─── Cal webhook subscription ──────────────────────────────────────
  // Subscribes the rancher's Cal account to our /api/webhooks/cal handler
  // so we get notified on any of their bookings (created/rescheduled/
  // cancelled/meeting-ended). Without this, the embed widget books slots
  // but BHC never finds out.
  if (!result.webhookId) {
    try {
      const hook = await registerCalWebhook({
        rancher,
        subscriberUrl: `${SITE_URL}/api/webhooks/cal`,
        triggers: ['BOOKING_CREATED', 'BOOKING_RESCHEDULED', 'BOOKING_CANCELLED', 'MEETING_ENDED'],
        secret: CAL_WEBHOOK_SECRET || undefined,
      });
      result.webhookId = hook.id;
      fields['Cal Webhook Id'] = hook.id;
    } catch (e: any) {
      result.errors.push(`webhook: ${e?.message || 'unknown'}`);
    }
  }

  // ─── Persist whatever we created ───────────────────────────────────
  if (Object.keys(fields).length) {
    try {
      await updateRecord(TABLES.RANCHERS, r.rancherId, fields);
    } catch (e: any) {
      result.errors.push(`persist: ${e?.message || 'unknown'}`);
    }
  }

  // ─── Telegram on errors ────────────────────────────────────────────
  if (result.errors.length) {
    try {
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `⚠️ <b>Cal setup-event-types partial failure</b>\n\n` +
          `🤠 ${ranchName}\n` +
          `Errors:\n${result.errors.map((e) => `• ${e}`).join('\n')}\n\n` +
          `<i>Idempotent — calling this endpoint again will retry only the failed parts.</i>`,
      );
    } catch {}
    return NextResponse.json(result, { status: 207 }); // Multi-Status
  }

  // ─── Telegram on success ───────────────────────────────────────────
  try {
    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      `✅ <b>Cal event types + webhook ready</b>\n\n` +
        `🤠 ${ranchName}\n` +
        `Intro id: ${result.introEventTypeId}\n` +
        `Sales id: ${result.salesEventTypeId}\n` +
        `Webhook id: ${result.webhookId}\n\n` +
        `<i>Buyers can now self-book via the Atoms embed.</i>`,
    );
  } catch {}

  return NextResponse.json(result);
}
