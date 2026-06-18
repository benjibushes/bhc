import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { withCronRun } from '@/lib/cronRun';

export const maxDuration = 120;

// ─────────────────────────────────────────────────────────────────────────
// RANCHER GO-LIVE SYNC
//
// Safety-net cron — runs daily at 06:30 UTC (00:30 MT) to catch ranchers
// whose onboarding is complete but who never got flipped Active due to
// a race condition, edge-case in sign-agreement, or manual state drift.
//
// Eligible = Agreement Signed = true  AND  Active Status != 'Active'
//
// Within that set, the eligibility fork is:
//
//   tier_v2 ranchers  → must have Stripe Connect Status = 'active'
//                        (deposit gate; no legacy Payment Link required)
//
//   legacy ranchers   → must have a Slug + at least one Price
//                        + at least one Payment Link
//                        (same criteria used by sign-agreement go-live gate)
//
// For each eligible rancher we flip:
//   Active Status   → 'Active'
//   Onboarding Status → 'Live'
//   Page Live       → true
//
// Then fire launch warmup (fire-and-forget, idempotent) + Telegram note.
// ─────────────────────────────────────────────────────────────────────────

async function realHandler(
  _request: Request,
): Promise<{ status: 'success' | 'partial'; recordsTouched: number; notes: string }> {
  const ranchers = (await getAllRecords(TABLES.RANCHERS)) as any[];

  // Pre-live onboarding statuses. A rancher who already went Live and was then
  // deliberately Paused / At Capacity carries Onboarding Status='Live', so this
  // guard EXCLUDES them — without it the cron would re-activate paused or
  // at-capacity ranchers (vacation/sick states + the capacity-liberator system).
  // Mirrors the Connect-webhook go-live gate.
  const PRE_LIVE_ONBOARDING = new Set([
    '', 'Agreement Signed', 'Verification Complete', 'Verification Pending', 'Docs Sent',
  ]);

  // Filter: signed, not yet Active, never went live before, and not a deliberate
  // Paused / At Capacity state.
  const candidates = ranchers.filter((r: any) => {
    if (!r['Agreement Signed']) return false;
    const activeStatus = String(r['Active Status'] || '');
    if (activeStatus === 'Active' || activeStatus === 'Paused' || activeStatus === 'At Capacity') return false;
    return PRE_LIVE_ONBOARDING.has(String(r['Onboarding Status'] || ''));
  });

  const flipped: string[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  let errors = 0;

  for (const rancher of candidates) {
    const name =
      (rancher['Operator Name'] as string | undefined) ||
      (rancher['Ranch Name'] as string | undefined) ||
      rancher.id;

    const pricingModel = String(rancher['Pricing Model'] || 'legacy').toLowerCase();
    const isTierV2 = pricingModel === 'tier_v2';

    let eligible = false;
    let skipReason = '';

    if (isTierV2) {
      const connectStatus = String(rancher['Stripe Connect Status'] || '').toLowerCase();
      if (connectStatus === 'active') {
        eligible = true;
      } else {
        skipReason = `tier_v2 but Stripe Connect Status="${rancher['Stripe Connect Status'] || 'unset'}"`;
      }
    } else {
      // Legacy rancher: needs slug + at least one price + at least one payment link
      const hasSlug = !!rancher['Slug'];
      const hasPrice = !!(
        rancher['Quarter Price'] ||
        rancher['Half Price'] ||
        rancher['Whole Price']
      );
      const hasPaymentLink = !!(
        rancher['Quarter Payment Link'] ||
        rancher['Half Payment Link'] ||
        rancher['Whole Payment Link']
      );

      if (hasSlug && hasPrice && hasPaymentLink) {
        eligible = true;
      } else {
        const missing: string[] = [];
        if (!hasSlug) missing.push('Slug');
        if (!hasPrice) missing.push('Price');
        if (!hasPaymentLink) missing.push('Payment Link');
        skipReason = `legacy missing: ${missing.join(', ')}`;
      }
    }

    if (!eligible) {
      skipped.push({ name, reason: skipReason });
      continue;
    }

    try {
      await updateRecord(TABLES.RANCHERS, rancher.id, {
        'Active Status': 'Active',
        'Onboarding Status': 'Live',
        'Page Live': true,
      });
      flipped.push(name);

      // Fire-and-forget launch warmup so this state's waitlisted buyers
      // get warmed promptly. The cron is idempotent.
      try {
        const { triggerLaunchWarmup } = await import('@/lib/triggerLaunchWarmup');
        triggerLaunchWarmup(`rancher-go-live-sync:${rancher.id}`);
      } catch (e: any) {
        console.warn(`[rancher-go-live-sync] could not trigger launch warmup for ${name}:`, e?.message);
      }

      // Telegram note per rancher flipped
      try {
        if (TELEGRAM_ADMIN_CHAT_ID) {
          await sendTelegramMessage(
            TELEGRAM_ADMIN_CHAT_ID,
            `🟢 <b>Go-Live Sync: ${name} flipped Active</b>\n\n` +
              `Pricing model: ${isTierV2 ? 'tier_v2' : 'legacy'}\n` +
              `State: ${rancher['State'] || '—'}\n` +
              `Agreement Signed At: ${rancher['Agreement Signed At'] || 'unknown'}\n` +
              `<i>Caught by safety-net cron — was missed on sign/sync.</i>`,
          );
        }
      } catch (tgErr: any) {
        console.error(`[rancher-go-live-sync] Telegram note failed for ${name}:`, tgErr?.message);
      }
    } catch (updateErr: any) {
      console.error(`[rancher-go-live-sync] updateRecord failed for ${rancher.id} (${name}):`, updateErr?.message);
      errors++;
    }
  }

  const notes =
    `flipped=${flipped.length} skipped=${skipped.length} errors=${errors}` +
    (flipped.length > 0 ? ` | went-live: ${flipped.join(', ')}` : '') +
    (skipped.length > 0
      ? ` | not-ready: ${skipped
          .slice(0, 5)
          .map((s) => `${s.name} (${s.reason})`)
          .join('; ')}${skipped.length > 5 ? ` ...+${skipped.length - 5} more` : ''}`
      : '');

  return {
    status: errors > 0 ? 'partial' : 'success',
    recordsTouched: flipped.length,
    notes,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${cronSecret}`) {
      const { searchParams } = new URL(request.url);
      if (searchParams.get('secret') !== cronSecret) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }
  }
  return withCronRun('rancher-go-live-sync', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
