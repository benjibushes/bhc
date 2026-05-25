// Rancher Vertical — all writes from /rancher, /ranchers/[slug], /api/rancher/*
// MUST route here. Close-completion logic was previously duplicated in 3 places
// (dashboard PATCH, quick-action email link, Telegram close-amount reply). Each
// copy drifted independently — capacity decrement, Buyer Stage flip, Missed
// Responses reset, activity stamps. recordClose() is the single source of truth.

import { updateRecord, getRecordById, TABLES } from '@/lib/airtable';
import { decrementCapacity, syncCapacityToAirtable } from '@/lib/rancherCapacity';
import { transitionBuyerStage } from './buyer';
import { funnelRecord } from '@/lib/funnelMetrics';

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

  // Buyer Stage propagation. Closed Won + Closed Lost flip to CLOSED.
  // Awaiting Payment keeps the buyer in MATCHED until final close lands —
  // a partial pay-on-delivery deal should not flip the buyer to CLOSED yet.
  const buyerIds: string[] = (ref['Buyer'] || []) as string[];
  const buyerId = Array.isArray(buyerIds) ? buyerIds[0] : null;
  if (buyerId && (input.outcome === 'won' || input.outcome === 'lost')) {
    try {
      await transitionBuyerStage(buyerId, 'CLOSED', `referral:${nextStatus}`);
    } catch (e: any) {
      console.warn('[contracts.recordClose] Buyer Stage flip failed:', e?.message);
    }
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
