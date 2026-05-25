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

  return { ok: true, capacityFreed };
}
