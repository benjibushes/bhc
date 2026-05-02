// Close Detector — the visibility unlock.
//
// The single biggest bug in BHC's data layer: 0 Closed Won across the
// entire platform despite real sales happening. Ranchers close off-platform
// and don't update Airtable because clicking through a dashboard is friction
// they avoid. So Ben can't see his close rate, can't measure conversion,
// can't trust any KPI.
//
// HOW IT WORKS:
//   1. Daily, scan referrals stuck in {Intro Sent, Rancher Contacted, Negotiation}
//      for 7+ days.
//   2. For each, post a Telegram one-tap card to Ben:
//        "Did this close? [✅ Yes — $X] [❌ Lost] [⏳ Still working]"
//   3. Ben taps once → status flips, audit logged, commission accrued.
//
// WHY THIS, NOT FULL AUTO:
//   "Did the buyer close?" is the one decision we shouldn't auto-classify
//   yet — too high stakes, too easy to be wrong, easy human input. The
//   actual close $ amount also has to be right or commission math breaks.
//   Phase 2 will add inbound email reply parsing as a stronger signal,
//   then we can promote some categories to auto.
//
// IDEMPOTENT:
//   Each referral gets at most ONE check-in card per 7-day window. The
//   `Close Check Sent At` field tracks last send.
//
// SETUP REQUIRED:
//   - Add Airtable Referrals field: "Close Check Sent At" (datetime)
//   - Telegram callback handlers `clcheck_won_*`, `clcheck_lost_*`,
//     `clcheck_working_*` need wiring in webhooks/telegram/route.ts
//     (Phase 0 task — coming next ship)

import { NextResponse } from 'next/server';
import { getAllRecords, TABLES } from '@/lib/airtable';
import { isMaintenanceMode, maintenanceResponse } from '@/lib/maintenance';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';

export const maxDuration = 60;

const DAY_MS = 24 * 60 * 60 * 1000;
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

// Min days since intro before we ask. Real ranch beef has 3-6 week pickup
// windows so 7 days is the earliest "did it close yet?" makes sense.
const MIN_DAYS_SINCE_INTRO = 7;
// Days between check-in cards for the same referral. Don't spam Ben.
const CHECK_COOLDOWN_DAYS = 7;
// Per-run cap so we don't dump 50 cards into Telegram at once.
const MAX_CARDS_PER_RUN = 15;

const rf = (v: any) => v == null ? '' : (typeof v === 'object' && 'name' in v) ? String(v.name) : String(v);

export async function GET(request: Request) {
  try {
    if (isMaintenanceMode()) return maintenanceResponse('close-detector');

    // Cron auth — same pattern as other crons. Validated CRON_SECRET via
    // lib/secrets.ts, which throws if env unset (no silent fallback).
    const { CRON_SECRET } = await import('@/lib/secrets');
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${CRON_SECRET}`) {
      const url = new URL(request.url);
      const secret = url.searchParams.get('secret');
      if (secret !== CRON_SECRET) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    const now = Date.now();

    // Pull active referrals + ranchers (for name resolution).
    const referrals = await getAllRecords(
      TABLES.REFERRALS,
      'OR({Status} = "Intro Sent", {Status} = "Rancher Contacted", {Status} = "Negotiation")'
    ) as any[];
    const ranchers = await getAllRecords(TABLES.RANCHERS) as any[];
    const ranchersById = new Map(ranchers.map((r: any) => [r.id, r]));

    // Filter to ones that are stale enough + haven't been checked recently.
    const candidates = referrals.filter((r: any) => {
      const introAt = r['Intro Sent At'] || r['Approved At'];
      if (!introAt) return false;
      const daysSinceIntro = (now - new Date(introAt).getTime()) / DAY_MS;
      if (daysSinceIntro < MIN_DAYS_SINCE_INTRO) return false;

      const lastCheck = r['Close Check Sent At'];
      if (lastCheck) {
        const daysSinceCheck = (now - new Date(lastCheck).getTime()) / DAY_MS;
        if (daysSinceCheck < CHECK_COOLDOWN_DAYS) return false;
      }
      return true;
    });

    // Sort: oldest unchecked first (more likely to have actually closed).
    candidates.sort((a: any, b: any) => {
      const aTime = new Date(a['Intro Sent At'] || a['Approved At']).getTime();
      const bTime = new Date(b['Intro Sent At'] || b['Approved At']).getTime();
      return aTime - bTime;
    });

    const targets = candidates.slice(0, MAX_CARDS_PER_RUN);

    let posted = 0;
    let failed = 0;
    const skippedReasons: string[] = [];

    for (const ref of targets) {
      try {
        // Resolve rancher name LIVE (don't trust the stale Suggested Rancher Name cache).
        const rancherLinks = ref['Rancher'] || ref['Suggested Rancher'] || [];
        const rancherId = Array.isArray(rancherLinks) ? rancherLinks[0] : null;
        const rancher = rancherId ? ranchersById.get(rancherId) : null;
        const rancherName = rancher
          ? ((rancher as any)['Operator Name'] || (rancher as any)['Ranch Name'] || 'unknown rancher')
          : (rf(ref['Suggested Rancher Name']) || 'unknown rancher');

        const buyerName = rf(ref['Buyer Name']) || 'unknown buyer';
        const buyerState = rf(ref['Buyer State']) || '?';
        const orderType = rf(ref['Order Type']) || '?';
        const introAt = ref['Intro Sent At'] || ref['Approved At'];
        const daysSince = Math.floor((now - new Date(introAt).getTime()) / DAY_MS);

        // Build the inline keyboard. Phase 0 stops at this prompt — Telegram
        // handler wiring lands in the next ship (extending webhooks/telegram).
        // For now, the card includes the referral ID so manual SQL fixes are
        // easy until callbacks are wired.
        const text =
          `🤔 <b>Did this close?</b>\n\n` +
          `👤 ${buyerName} (${buyerState})\n` +
          `🤠 → ${rancherName}\n` +
          `📦 ${orderType} · ${daysSince}d since intro\n` +
          `🆔 <code>${ref.id}</code>\n\n` +
          `<i>Tap below. Status flips immediately; sale $ requires confirm.</i>`;

        const inlineKeyboard = {
          inline_keyboard: [
            [
              { text: '✅ Closed Won', callback_data: `clcheck_won_${ref.id}` },
              { text: '❌ Closed Lost', callback_data: `clcheck_lost_${ref.id}` },
            ],
            [
              { text: '⏳ Still working', callback_data: `clcheck_working_${ref.id}` },
              { text: '🔇 Stop asking', callback_data: `clcheck_mute_${ref.id}` },
            ],
          ],
        };

        // sendTelegramMessage signature is (chatId, text, replyMarkup?). Parse
        // mode defaults to HTML inside the helper. Pass the inline keyboard
        // directly — the helper JSON.stringifies it for the Telegram API.
        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          text,
          inlineKeyboard
        );

        // Mark as checked so we don't re-ask within the cooldown.
        const { updateRecord } = await import('@/lib/airtable');
        try {
          await updateRecord(TABLES.REFERRALS, ref.id, {
            'Close Check Sent At': new Date().toISOString(),
          });
        } catch (fieldErr: any) {
          // Field doesn't exist yet — track in console but don't fail the cron.
          // Ben can add the field via Airtable UI; until then, every run will
          // re-ask which is louder than ideal but not broken.
          if (skippedReasons.length === 0) {
            skippedReasons.push(`Add "Close Check Sent At" datetime field to Referrals table — until then cards re-fire each run. (${fieldErr?.message})`);
          }
        }

        posted++;
        // Pace 600ms between Telegram sends to avoid hitting their per-bot rate limit.
        await new Promise((r) => setTimeout(r, 600));
      } catch (e: any) {
        failed++;
        console.error('[close-detector] card failed for ref', ref.id, e?.message || e);
      }
    }

    // Summary message at the end so Ben sees one line about what just happened.
    if (posted > 0) {
      try {
        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          `📊 <b>Close detector swept</b>\n\n` +
          `Posted ${posted} check-in card${posted === 1 ? '' : 's'}\n` +
          `Stale referrals scanned: ${candidates.length}\n` +
          `Failed: ${failed}` +
          (skippedReasons.length ? `\n\n⚠️ ${skippedReasons[0]}` : '')
        );
      } catch {}
    }

    return NextResponse.json({
      ok: true,
      posted,
      failed,
      candidates_total: candidates.length,
      cap: MAX_CARDS_PER_RUN,
      site_url: SITE_URL,
      warnings: skippedReasons,
    });
  } catch (error: any) {
    console.error('[close-detector] cron error:', error);
    return NextResponse.json({ error: error?.message || 'Internal server error' }, { status: 500 });
  }
}
