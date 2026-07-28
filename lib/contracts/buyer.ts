// Buyer Vertical — all writes from /access, /map, /member, /api/consumers,
// /api/warmup, /api/orders/request MUST go through one of these contract
// functions. Any direct updateRecord(TABLES.CONSUMERS, ...) outside this
// file is a vertical boundary violation (Task 5 enforces).
//
// Why a contract: the buyer side is the most-touched surface (signup,
// engagement, stage transitions). Without a single funnel, every code path
// duplicated the Buyer Stage write logic + the Funnel Events emit. This
// module centralizes both so future stage additions ripple in one place.

import { updateRecord, TABLES } from '@/lib/airtable';
import { funnelRecord } from '@/lib/funnelMetrics';

export type BuyerStage = 'NEW' | 'WAITING' | 'READY' | 'MATCHED' | 'CLOSED';

export async function transitionBuyerStage(buyerId: string, to: BuyerStage, reason: string): Promise<void> {
  const now = new Date().toISOString();
  await updateRecord(TABLES.CONSUMERS, buyerId, {
    'Buyer Stage': to,
    'Buyer Stage Updated At': now,
  });
  await funnelRecord({ stage: `transition:${to}`, buyerId, reason });
}

export async function recordBuyerEngagement(buyerId: string): Promise<void> {
  const now = new Date().toISOString();
  await updateRecord(TABLES.CONSUMERS, buyerId, {
    'Warmup Engaged At': now,
    'Ready to Buy': true,
  });
  await funnelRecord({ stage: 'engaged', buyerId });
}
