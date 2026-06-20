// Rancher Vertical — all writes from /rancher, /ranchers/[slug], /api/rancher/*
// MUST route here. Close-completion logic was previously duplicated in 3 places
// (dashboard PATCH, quick-action email link, Telegram close-amount reply). Each
// copy drifted independently — capacity decrement, Buyer Stage flip, Missed
// Responses reset, activity stamps. recordClose() is the single source of truth.

import { updateRecord, getRecordById, getAllRecords, escapeAirtableValue, TABLES } from '@/lib/airtable';
import { decrementCapacity, syncCapacityToAirtable } from '@/lib/rancherCapacity';
import { transitionBuyerStage } from './buyer';
import { funnelRecord } from '@/lib/funnelMetrics';
import { ensureBuyerAffiliate } from '@/lib/affiliates';
import { sendAffiliateWelcome } from '@/lib/email';
import { fireCapi, buildUserData, reconstructFbc, closePurchaseEnabled } from '@/lib/metaCapi';
import { metaEventId } from '@/lib/analytics';

const AFFILIATE_SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

export type ReferralStatus =
  | 'Pending Approval'
  | 'Intro Sent'
  | 'Rancher Contacted'
  | 'Negotiation'
  | 'Awaiting Payment'
  | 'Closed Won'
  | 'Closed Lost';

export interface RecordCloseInput {
  referralId: string;
  rancherId: string;
  outcome: 'won' | 'lost' | 'awaiting_payment';
  saleAmount?: number;
  reason?: string;
  closeReason?: 'no_response' | 'price' | 'timing' | 'other';
}

const ACTIVE_REF_STATES = new Set<ReferralStatus>([
  'Intro Sent',
  'Rancher Contacted',
  'Negotiation',
  'Pending Approval',
]);

export async function recordClose(input: RecordCloseInput): Promise<{ ok: boolean; capacityFreed: boolean }> {
  const ref: any = await getRecordById(TABLES.REFERRALS, input.referralId);
  if (!ref) return { ok: false, capacityFreed: false };
  const prevStatus = String(ref['Status'] || '') as ReferralStatus;

  const now = new Date().toISOString();
  const nextStatus: ReferralStatus =
    input.outcome === 'won' ? 'Closed Won' :
    input.outcome === 'lost' ? 'Closed Lost' :
    'Awaiting Payment';

  const updates: Record<string, any> = {
    'Status': nextStatus,
    'Closed At': now,
    'Last Rancher Activity At': now,
    'Rancher Engaged Flag': true,
  };
  if (input.outcome === 'won' && typeof input.saleAmount === 'number') {
    updates['Sale Amount'] = input.saleAmount;
  }
  await updateRecord(TABLES.REFERRALS, input.referralId, updates);

  let capacityFreed = false;
  if (ACTIVE_REF_STATES.has(prevStatus)) {
    try {
      const newCount = await decrementCapacity(input.rancherId);
      await syncCapacityToAirtable(input.rancherId, newCount);
      capacityFreed = true;
    } catch (capErr: any) {
      console.warn('[contracts.recordClose] capacity decrement failed:', capErr?.message);
    }
  }

  // Buyer Stage propagation. Closed Won + Closed Lost normally flip to CLOSED.
  // Awaiting Payment keeps the buyer in MATCHED until final close lands —
  // a partial pay-on-delivery deal should not flip the buyer to CLOSED yet.
  //
  // F-2 audit fix: Closed Lost is NOT terminal for the buyer when they have
  // no other active referrals. Pre-fix, rancher passes/loses a deal →
  // Buyer Stage=CLOSED forever → stuck-buyer-recovery cron skips them
  // (only retries READY). Dead-end. Now: on Closed Lost, check for other
  // active referrals; if none, restore Buyer Stage=READY + Ready to Buy=true
  // so the buyer re-enters the routing pool.
  const buyerIds: string[] = (ref['Buyer'] || []) as string[];
  const buyerId = Array.isArray(buyerIds) ? buyerIds[0] : null;
  if (buyerId && input.outcome === 'won') {
    try {
      // Only on the FIRST transition into Closed Won — a re-run (dual webhook
      // delivery, or a read-blip retry) must not re-flip an already-CLOSED buyer.
      if (prevStatus !== 'Closed Won') {
        await transitionBuyerStage(buyerId, 'CLOSED', `referral:${nextStatus}`);
      }
    } catch (e: any) {
      console.warn('[contracts.recordClose] Buyer Stage flip failed:', e?.message);
    }

    // P2-A audit fix: auto-enroll Closed Won buyer as affiliate AND send the
    // welcome email. Single helper (enrollClosedWonAffiliate) so every close
    // path — Stripe webhook tier_v2, admin contract, Telegram quick-action,
    // legacy dashboard PATCH — gets identical enrollment + welcome behavior.
    // Pre-fix the dashboard PATCH path called ensureBuyerAffiliate WITHOUT
    // firing the welcome email; the tier_v2 Stripe webhook path skipped
    // enrollment entirely. Fire-and-forget: never block the close path.
    await enrollClosedWonAffiliate(buyerId);

    // Meta CAPI: the attributed Purchase for this close. recordClose covers the
    // Stripe final-invoice, Telegram/quick-action, and tier_v2 webhook close
    // paths. The rancher-dashboard PATCH and admin PATCH close INLINE (not via
    // recordClose), so those routes call fireClosePurchaseIfEnabled() directly
    // too — all routed through the one gated helper (env flag + first-transition
    // guard + positive amount). Off-session, so attribution rides on the buyer's
    // stored fbclid rebuilt into _fbc. When the flag is off, settleFinalInvoice
    // keeps firing its legacy Purchase (no double-count). Never blocks the close.
    fireClosePurchaseIfEnabled({
      referralId: input.referralId,
      buyerId,
      saleAmount: input.saleAmount,
      prevStatus,
      closedAtIso: now,
    });
  }
  if (buyerId && input.outcome === 'lost') {
    await restoreBuyerAfterClosedLost(buyerId, input.referralId);
  }

  // Only on a FRESH transition — a re-run (dual webhook delivery / retry) must
  // not double-count close revenue in the funnel metrics.
  if (prevStatus !== nextStatus) {
    await funnelRecord({
      stage: `close:${input.outcome}`,
      rancherId: input.rancherId,
      referralId: input.referralId,
      amount: input.saleAmount,
    });
  }

  // Close any open Threads for this referral on terminal close. Awaiting
  // Payment keeps threads Active (deal still in progress; rancher may still
  // need to message buyer about delivery). Non-fatal: a Threads write failure
  // shouldn't block the close.
  if (input.outcome === 'won' || input.outcome === 'lost') {
    try {
      const { getAllRecords, updateRecord } = await import('@/lib/airtable');
      const { THREADS_TABLE } = await import('./threads');
      const safeRefId = input.referralId.replace(/"/g, '\\"');
      const threads: any[] = await getAllRecords(
        THREADS_TABLE,
        `AND(SEARCH("${safeRefId}", ARRAYJOIN({Referral})), {Status} = "Active")`,
      );
      for (const t of threads) {
        try {
          await updateRecord(THREADS_TABLE, t.id, { 'Status': 'Closed' });
        } catch (e: any) {
          console.warn('[contracts.recordClose] thread close failed:', t.id, e?.message);
        }
      }
    } catch (e: any) {
      console.warn('[contracts.recordClose] thread close lookup failed:', e?.message);
    }
  }

  return { ok: true, capacityFreed };
}

/**
 * Fire the attributed Closed-Won Purchase to Meta CAPI. Server-side and
 * off-session (rancher/admin close — no buyer browser), so we rebuild the
 * buyer's _fbc from their stored fbclid + click-time ms. event_time is the real
 * close time (within Meta's 7-day website-event window); event_id is the
 * referral id so it shares the dedup key with any prior event for this deal.
 * Best-effort: callers wrap in .catch and never let this block a close.
 */
async function fireClosedWonPurchase(args: {
  buyerId: string;
  referralId: string;
  saleAmount: number;
  closedAtIso: string;
}): Promise<void> {
  const buyer: any = await getRecordById(TABLES.CONSUMERS, args.buyerId).catch(() => null);
  if (!buyer?.['Email']) return; // no match key → nothing useful to send

  const fullName = String(buyer['Full Name'] || '').trim();
  const nameParts = fullName ? fullName.split(/\s+/) : [];
  const fbclid = String(buyer['fbclid'] || '').trim();
  const fbclidTs = Number(buyer['fbclid_ts'] || 0);
  const fbc = reconstructFbc(fbclid, fbclidTs);

  const parsed = Date.parse(args.closedAtIso);
  const eventTime = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : Math.floor(Date.now() / 1000);

  await fireCapi([{
    event_name: 'Purchase',
    event_time: eventTime,
    event_id: metaEventId(args.referralId),
    // system_generated, not 'website': this is a server-initiated close with no
    // buyer browser, so we have no event_source_url / client_user_agent — and
    // Meta DISCARDS action_source='website' events that omit those. fbc is still
    // honored for attribution under system_generated. Matches the legacy fire.
    action_source: 'system_generated',
    event_source_url: AFFILIATE_SITE_URL,
    user_data: buildUserData({
      email: String(buyer['Email']).toLowerCase(),
      firstName: nameParts[0] || undefined,
      lastName: nameParts.slice(1).join(' ') || undefined,
      state: String(buyer['State'] || '') || undefined,
      fbc,
    }),
    custom_data: {
      value: args.saleAmount,
      currency: 'usd',
      content_name: 'Beef — full sale',
      content_category: 'closed-won',
    },
  }]);
}

/**
 * Gated entry point for the attributed Closed-Won Purchase, callable from EVERY
 * close path: recordClose() (Stripe final-invoice, Telegram/quick-action,
 * tier_v2 webhook) AND the rancher-dashboard + admin PATCH routes that close
 * inline without recordClose. Fires at most once per close:
 *   - only when META_CLOSE_PURCHASE_ENABLED is on,
 *   - only on the FIRST transition into Closed Won (prevStatus guard — a re-close
 *     / re-edit, or a later final-invoice on an already-won deal, is a no-op so
 *     we never lean on Meta's ~48h event_id dedup window),
 *   - only with a positive sale amount and a known buyer.
 * Fire-and-forget: synchronous gating, detached CAPI call, never blocks a close.
 */
export function fireClosePurchaseIfEnabled(args: {
  referralId: string;
  buyerId: string | null;
  saleAmount?: number;
  prevStatus?: string;
  closedAtIso: string;
}): void {
  if (!closePurchaseEnabled()) return;
  if (!args.buyerId) return;
  if (args.prevStatus === 'Closed Won') return;
  if (typeof args.saleAmount !== 'number' || !Number.isFinite(args.saleAmount) || args.saleAmount <= 0) return;
  fireClosedWonPurchase({
    buyerId: args.buyerId,
    referralId: args.referralId,
    saleAmount: args.saleAmount,
    closedAtIso: args.closedAtIso,
  }).catch((e: any) =>
    console.error('[contracts.fireClosePurchaseIfEnabled] Purchase CAPI fire failed:', e?.message),
  );
}

/**
 * P2-A audit helper. Exported so the legacy dashboard PATCH path
 * (app/api/rancher/referrals/[id]/route.ts) can share the same affiliate
 * enrollment + welcome email flow as recordClose() without re-implementing
 * it. Idempotent via ensureBuyerAffiliate's email-based lookup — calling
 * this twice for the same buyer is a no-op on the second call.
 *
 * Fire-and-forget: every internal step swallows its own error so a Resend
 * outage or Airtable hiccup never blocks the close path.
 */
export async function enrollClosedWonAffiliate(buyerId: string): Promise<void> {
  if (!buyerId) return;
  try {
    const buyerRecord: any = await getRecordById(TABLES.CONSUMERS, buyerId);
    const buyerEmail = String(buyerRecord?.['Email'] || '').trim();
    const buyerFullName = String(buyerRecord?.['Full Name'] || '');
    if (!buyerEmail) return;

    const result = await ensureBuyerAffiliate({
      consumerId: buyerId,
      email: buyerEmail,
      fullName: buyerFullName,
    });
    if (!result || result.existing || !result.code) return;

    // Stamp Consumer row so a re-edit of Closed Won doesn't re-process.
    // Audit trail + dedup signal for downstream crons.
    try {
      await updateRecord(TABLES.CONSUMERS, buyerId, {
        'Affiliate Created At': new Date().toISOString(),
        'Affiliate Code': result.code,
      });
    } catch (e: any) {
      console.warn('[enrollClosedWonAffiliate] affiliate stamp failed:', e?.message);
    }

    // Welcome email — fail silently if Resend errors. Mirrors the link
    // shape used by /api/admin/affiliates POST for consistency.
    try {
      const buyerLink = `${AFFILIATE_SITE_URL}/access?ref=${encodeURIComponent(result.code)}`;
      const rancherLink = `${AFFILIATE_SITE_URL}/partner?ref=${encodeURIComponent(result.code)}`;
      const dashboardUrl = `${AFFILIATE_SITE_URL}/affiliate`;
      await sendAffiliateWelcome({
        name: buyerFullName || buyerEmail,
        email: buyerEmail,
        code: result.code,
        dashboardUrl,
        buyerLink,
        rancherLink,
      });
    } catch (e: any) {
      console.warn('[enrollClosedWonAffiliate] sendAffiliateWelcome failed:', e?.message);
    }
  } catch (e: any) {
    console.warn('[enrollClosedWonAffiliate] failed:', e?.message);
  }
}

// F-2 audit helper. Exported so non-contract close paths (Telegram reject /
// closelost callbacks, dashboard PATCH legacy branch) can apply the same
// "restore READY if no other active referrals" logic without re-implementing
// the Airtable lookup + branch. Caller is responsible for stamping the
// Referral row itself — this helper only handles the Buyer side.
export async function restoreBuyerAfterClosedLost(buyerId: string, referralId: string): Promise<{ restored: boolean }> {
  if (!buyerId) return { restored: false };
  try {
    const safeBuyerId = escapeAirtableValue(buyerId);
    const safeRefId = escapeAirtableValue(referralId);
    const otherActive: any[] = await getAllRecords(
      TABLES.REFERRALS,
      `AND(SEARCH("${safeBuyerId}", ARRAYJOIN({Buyer})), {Status} != "Closed Won", {Status} != "Closed Lost", RECORD_ID() != "${safeRefId}")`,
    );
    const now = new Date().toISOString();
    if (otherActive.length === 0) {
      const buyer: any = await getRecordById(TABLES.CONSUMERS, buyerId);
      const existingNotes = String(buyer?.['Notes'] || '');
      const auditStamp = `[auto-restore READY after Closed Lost ref=${referralId} @ ${now}]`;
      await updateRecord(TABLES.CONSUMERS, buyerId, {
        'Buyer Stage': 'READY',
        'Buyer Stage Updated At': now,
        'Ready to Buy': true,
        'Referral Status': 'Unmatched',
        'Notes': existingNotes ? `${existingNotes}\n${auditStamp}` : auditStamp,
      });
      await funnelRecord({ stage: 'transition:READY', buyerId, reason: `auto-restore:after-Closed Lost` });
      return { restored: true };
    } else {
      await transitionBuyerStage(buyerId, 'MATCHED', `referral:Closed Lost:other-active`);
      return { restored: false };
    }
  } catch (e: any) {
    console.warn('[contracts.restoreBuyerAfterClosedLost] failed:', e?.message);
    try {
      await transitionBuyerStage(buyerId, 'CLOSED', `referral:Closed Lost:restore-failed`);
    } catch {}
    return { restored: false };
  }
}
