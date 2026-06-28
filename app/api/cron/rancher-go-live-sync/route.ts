import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';

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

// AUDIT 2026-06-28 (rancher-lifecycle pass): verified this advances ranchers
// correctly. Candidate filter (signed + not Active/Paused/At-Capacity + pre-live
// Onboarding Status) matches the only statuses sign-agreement actually writes
// (Agreement Signed / Verification Complete / Live), so no signed+ready rancher
// is silently stranded. The tier_v2 fork gates on Connect='active' + slug + price
// (content gate prevents flipping a blank page Live) with a live-Stripe reconcile
// that removes the webhook dependency; legacy gates on slug + price + payment link.
// No silent-skip or wrong-field issues found — left as-is.
async function realHandler(
  _request: Request,
): Promise<{ status: 'success' | 'partial'; recordsTouched: number; notes: string }> {
  const ranchers = (await getAllRecords(TABLES.RANCHERS)) as any[];

  // ── CONNECT STATUS SELF-HEAL (2026-06-20) ─────────────────────────────────
  // The candidates filter below intentionally EXCLUDES Active / Paused /
  // At-Capacity ranchers, and the live-Connect reconcile only runs inside that
  // candidates loop. So a tier_v2 rancher who reached Active Status='Active'
  // with a Live page while their Stripe Connect Status is STILL the stale
  // 'onboarding' the webhook never advanced (STRIPE_CONNECT_WEBHOOK_SECRET
  // unset → account.updated 400s) is INVISIBLE to the heal — permanently. Those
  // ranchers are Live but the deposit endpoint 409s them and matching excludes
  // them (isRancherOperationalForBuyers gates tier_v2 on Connect='active'), so
  // they silently can't take money. (The Katie Hunter / Linda Anspach report,
  // 2026-06-20 — both Active, both Stripe charges_enabled, both stuck at
  // 'onboarding'.) This pass reconciles Connect status from a LIVE Stripe read
  // for EVERY tier_v2 rancher with an account whose cached status isn't already
  // active/detached — independent of go-live state. Status-only write (mirrors
  // the webhook + resync-connect); no go-live, money, or capacity side effects.
  // 'detached' is skipped so a deliberately-removed account isn't resurrected.
  let connectHealed = 0;
  try {
    const { getConnectAccountStatus } = await import('@/lib/stripeConnect');
    for (const r of ranchers) {
      if (String(r['Pricing Model'] || 'legacy').toLowerCase() !== 'tier_v2') continue;
      const acct = String(r['Stripe Connect Account Id'] || r['Stripe Account Id'] || '').trim();
      if (!acct) continue;
      const cached = String(r['Stripe Connect Status'] || '').toLowerCase();
      if (cached === 'active' || cached === 'detached') continue;
      try {
        const live = await getConnectAccountStatus(acct);
        const liveStatus = String(live.status || '').toLowerCase();
        if (liveStatus && liveStatus !== cached) {
          const wf: any = { 'Stripe Connect Status': live.status };
          if (liveStatus === 'active' && !r['Stripe Connect Connected At']) {
            wf['Stripe Connect Connected At'] = new Date().toISOString();
          }
          await updateRecord(TABLES.RANCHERS, r.id, wf);
          // Reflect locally so the candidates loop below sees the fresh status.
          r['Stripe Connect Status'] = live.status;
          connectHealed++;
        }
      } catch (e: any) {
        console.warn(`[rancher-go-live-sync] connect self-heal read failed for ${r['Operator Name'] || r.id}:`, e?.message);
      }
    }
  } catch (e: any) {
    console.warn('[rancher-go-live-sync] connect self-heal pass skipped:', e?.message);
  }

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
      // tier_v2 needs an ACTIVE Connect account AND real page content (slug +
      // at least one price) before going live. Previously this gated on Connect
      // ALONE, so a connected-but-content-less rancher would flip Live with a
      // BLANK page — a buyer landing there sees nothing. (No payment-link check:
      // tier_v2 collects deposits via Stripe Connect, not a Payment Link.)
      let connectStatus = String(rancher['Stripe Connect Status'] || '').toLowerCase();
      const hasSlug = !!rancher['Slug'];
      const hasPrice = !!(
        rancher['Quarter Price'] ||
        rancher['Half Price'] ||
        rancher['Whole Price']
      );
      const connectAcctId = rancher['Stripe Connect Account Id'] || rancher['Stripe Account Id'] || '';

      // LIVE-READ RECONCILE: the Connect webhook is the only writer of Status
      // 'active', and it returns 400 when CONNECT_WEBHOOK_SECRET is unset (the
      // usual prod state), so the cached field can lag FOREVER — a rancher who
      // finished Stripe KYC would never auto-go-live. When the rancher is
      // otherwise ready (acct + slug + price) but the cached status isn't active,
      // read live from Stripe and persist it, removing the webhook dependency.
      if (connectStatus !== 'active' && connectAcctId && hasSlug && hasPrice) {
        try {
          const { getConnectAccountStatus } = await import('@/lib/stripeConnect');
          const live = await getConnectAccountStatus(connectAcctId);
          if (live.status && live.status.toLowerCase() !== connectStatus) {
            await updateRecord(TABLES.RANCHERS, rancher.id, { 'Stripe Connect Status': live.status });
            connectStatus = live.status.toLowerCase();
          }
        } catch (e: any) {
          console.warn(`[rancher-go-live-sync] live Connect read failed for ${name}:`, e?.message);
        }
      }

      if (connectStatus === 'active' && hasSlug && hasPrice) {
        eligible = true;
      } else {
        const missing: string[] = [];
        if (connectStatus !== 'active') missing.push(`Connect="${rancher['Stripe Connect Status'] || 'unset'}"`);
        if (!hasSlug) missing.push('Slug');
        if (!hasPrice) missing.push('Price');
        skipReason = `tier_v2 missing: ${missing.join(', ')}`;
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
    `flipped=${flipped.length} connectHealed=${connectHealed} skipped=${skipped.length} errors=${errors}` +
    (flipped.length > 0 ? ` | went-live: ${flipped.join(', ')}` : '') +
    (skipped.length > 0
      ? ` | not-ready: ${skipped
          .slice(0, 5)
          .map((s) => `${s.name} (${s.reason})`)
          .join('; ')}${skipped.length > 5 ? ` ...+${skipped.length - 5} more` : ''}`
      : '');

  return {
    status: errors > 0 ? 'partial' : 'success',
    recordsTouched: flipped.length + connectHealed,
    notes,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('rancher-go-live-sync', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
