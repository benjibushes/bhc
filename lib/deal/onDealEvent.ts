import type { DealEvent } from './events';

// Phase 1 (later task) fills this in: rancher SMS on DEPOSIT_PAID / CALL_BOOKED
// with Redis last_notified_state idempotency. No-op stub until then.
export async function onDealEvent(_ev: DealEvent): Promise<void> {
  // intentionally empty
}
