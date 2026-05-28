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
      await transitionBuyerStage(buyerId, 'CLOSED', `referral:${nextStatus}`);
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
  }
  if (buyerId && input.outcome === 'lost') {
    await restoreBuyerAfterClosedLost(buyerId, input.referralId);
  }

  await funnelRecord({
    stage: `close:${input.outcome}`,
    rancherId: input.rancherId,
    referralId: input.referralId,
    amount: input.saleAmount,
  });

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
