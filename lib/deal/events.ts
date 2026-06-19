import type { DealState } from './states.ts';

export interface DealEvent {
  referralId: string;
  from: DealState | null;
  to: DealState;
  actor: string;
  reason?: string;
  atIso: string;
}

// The seam. A later task wires rancher SMS here. Resilient: a missing
// onDealEvent module or a throw inside it must never break a transition.
export async function dispatchDealEvent(ev: DealEvent): Promise<void> {
  try {
    const { onDealEvent } = await import('./onDealEvent');
    await onDealEvent(ev);
  } catch (e) {
    console.warn('[deal] dispatch failed', e);
  }
}
