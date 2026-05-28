// Admin Vertical — operator-initiated actions from /admin/*, Telegram callbacks,
// manual fixes via Airtable MCP. Admin ops CAN call buyer + rancher contracts;
// the buyer + rancher verticals CANNOT call admin (boundary enforced by Task 5).
//
// Auditability: every admin action that mutates state via this module gets
// recorded in Funnel Events with the operator id so the funnel dashboard can
// distinguish customer-driven flow from operator overrides.

import { transitionBuyerStage, BuyerStage } from './buyer';
import { recordClose } from './rancher';
import { funnelRecord } from '@/lib/funnelMetrics';

export type AdminAction =
  | { kind: 'force_close'; referralId: string; rancherId: string; outcome: 'won' | 'lost'; saleAmount?: number }
  | { kind: 'force_buyer_stage'; buyerId: string; stage: BuyerStage; reason: string }
  | { kind: 'comp_founder'; consumerId: string; tier: string; founderNumber?: number }
  | { kind: 'broadcast'; campaignName: string; audience: string; recipientCount: number };

export async function executeAdminAction(action: AdminAction, operator: string): Promise<{ ok: boolean }> {
  if (action.kind === 'force_close') {
    await recordClose({
      referralId: action.referralId,
      rancherId: action.rancherId,
      outcome: action.outcome,
      saleAmount: action.saleAmount,
    });
    await funnelRecord({
      stage: `admin:force_close:${action.outcome}`,
      referralId: action.referralId,
      rancherId: action.rancherId,
      amount: action.saleAmount,
      reason: `operator=${operator}`,
    });
    return { ok: true };
  }
  if (action.kind === 'force_buyer_stage') {
    await transitionBuyerStage(action.buyerId, action.stage, `admin:${action.reason}`);
    await funnelRecord({
      stage: `admin:force_buyer_stage:${action.stage}`,
      buyerId: action.buyerId,
      reason: `operator=${operator}:${action.reason}`,
    });
    return { ok: true };
  }
  if (action.kind === 'comp_founder') {
    await funnelRecord({
      stage: 'admin:comp_founder',
      buyerId: action.consumerId,
      reason: `operator=${operator}:tier=${action.tier}:num=${action.founderNumber || '-'}`,
    });
    return { ok: true };
  }
  if (action.kind === 'broadcast') {
    await funnelRecord({
      stage: 'admin:broadcast',
      reason: `operator=${operator}:campaign=${action.campaignName}:audience=${action.audience}:n=${action.recipientCount}`,
    });
    return { ok: true };
  }
  return { ok: false };
}
