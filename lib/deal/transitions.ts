// lib/deal/transitions.ts
import type { DealState } from './states.ts';

// Forward-only lifecycle with universal side-exits. Off-platform closes can
// jump straight to CLOSED_WON from any active state (ranchers close verbally);
// any active state can go CLOSED_LOST. Terminal states don't transition out
// (revive is an explicit admin override that bypasses the machine).
const FORWARD: DealState[] = [
  'NEW', 'MATCHED', 'INTRO_SENT', 'IN_CONVERSATION', 'CALL_BOOKED', 'CALL_DONE',
  'DEPOSIT_PENDING', 'DEPOSIT_PAID', 'SLOT_LOCKED', 'IN_FULFILLMENT', 'READY',
  'SCHEDULED', 'IN_TRANSIT', 'DELIVERED', 'CLOSED_WON',
];
const TERMINAL: DealState[] = ['CLOSED_WON', 'CLOSED_LOST', 'REFUNDED'];

export function canTransition(from: DealState, to: DealState): boolean {
  if (from === to) return false;
  if (TERMINAL.includes(from)) return false;
  if (to === 'CLOSED_LOST' || to === 'REFUNDED') return true; // universal exit
  if (to === 'CLOSED_WON') return true; // off-platform fast-close from any active
  // IN_CONVERSATION ("Rancher Contacted"/in-talks) is a re-affirmable engagement
  // state — the operator can mark a deal "in talks" from any active state,
  // including stepping back from Negotiation. Allow it (matches the old PATCH).
  if (to === 'IN_CONVERSATION') return true;
  const fi = FORWARD.indexOf(from);
  const ti = FORWARD.indexOf(to);
  if (fi === -1 || ti === -1) return false;
  return ti > fi; // forward-only
}
