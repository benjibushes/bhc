// Funnel telemetry — single call for every funnel-stage transition. Powers the
// admin conversion dashboard (app/(admin)/funnel). Writes are non-fatal: a
// logging failure must NEVER break the calling flow.
//
// Stage naming conventions (used by funnel dashboard rates):
//   - 'signup'                       (createBuyer)
//   - 'engaged'                      (recordBuyerEngagement / YES click)
//   - 'transition:NEW|WAITING|READY|MATCHED|CLOSED'  (transitionBuyerStage)
//   - 'close:won|lost|awaiting_payment'              (recordClose)
//   - 'deposit_paid'                                  (Stripe webhook → markDepositSucceeded)
//   - 'admin:<action>'                                (executeAdminAction)
//
// Schema: Airtable table "Funnel Events" with fields:
//   Id (auto), Stage (text), Buyer (link → Consumers, optional),
//   Rancher (link → Ranchers, optional), Referral (link → Referrals, optional),
//   Amount Cents (number, optional), Reason (text, optional),
//   Metadata (long text JSON), Created At (datetime).

import { createRecord } from '@/lib/airtable';

const FUNNEL_TABLE = 'Funnel Events';

export interface FunnelEvent {
  stage: string;
  buyerId?: string;
  rancherId?: string;
  referralId?: string;
  amount?: number;
  reason?: string;
  intentScore?: number;
  metadata?: Record<string, any>;
}

export async function funnelRecord(event: FunnelEvent): Promise<void> {
  try {
    await createRecord(FUNNEL_TABLE, {
      'Stage': event.stage,
      ...(event.buyerId ? { 'Buyer': [event.buyerId] } : {}),
      ...(event.rancherId ? { 'Rancher': [event.rancherId] } : {}),
      ...(event.referralId ? { 'Referral': [event.referralId] } : {}),
      ...(typeof event.amount === 'number' ? { 'Amount Cents': Math.round(event.amount * 100) } : {}),
      ...(event.reason ? { 'Reason': event.reason } : {}),
      'Metadata': JSON.stringify({
        intentScore: event.intentScore,
        ...event.metadata,
        ts: new Date().toISOString(),
      }).slice(0, 5000),
      'Created At': new Date().toISOString(),
    });
  } catch (e: any) {
    console.warn('[funnelMetrics] event write failed (non-fatal):', event.stage, e?.message);
  }
}
