// lib/deal/states.ts
// The ONE ordered deal lifecycle. Each state maps onto the existing Airtable
// Referral "Status" string (so this is additive, not a rename) and, where the
// transition is a milestone, the "...At" timestamp field that gets stamped.

export const DEAL_STATES = [
  'NEW', 'MATCHED', 'INTRO_SENT', 'IN_CONVERSATION', 'CALL_BOOKED', 'CALL_DONE',
  'DEPOSIT_PENDING', 'DEPOSIT_PAID', 'SLOT_LOCKED', 'IN_FULFILLMENT', 'READY',
  'SCHEDULED', 'IN_TRANSIT', 'DELIVERED', 'CLOSED_WON', 'CLOSED_LOST', 'REFUNDED',
] as const;

export type DealState = (typeof DEAL_STATES)[number];

const STATE_TO_STATUS: Record<DealState, string> = {
  NEW: 'Pending Approval',
  MATCHED: 'Pending Approval',
  INTRO_SENT: 'Intro Sent',
  IN_CONVERSATION: 'Rancher Contacted',
  CALL_BOOKED: 'Rancher Contacted',
  CALL_DONE: 'Negotiation',
  DEPOSIT_PENDING: 'Awaiting Payment',
  DEPOSIT_PAID: 'Awaiting Payment',
  SLOT_LOCKED: 'Slot Locked',
  IN_FULFILLMENT: 'Slot Locked',
  READY: 'Slot Locked',
  SCHEDULED: 'Slot Locked',
  IN_TRANSIT: 'Slot Locked',
  DELIVERED: 'Slot Locked',
  CLOSED_WON: 'Closed Won',
  CLOSED_LOST: 'Closed Lost',
  // Data-layer audit P2 (2026-08-18): was 'Closed Lost'. 'Refunded' is a REAL
  // Referral Status — lib/refundLifecycle::refundReferralClearFields writes it
  // on every full refund (payments.ts typecast-creates the option) and ~15
  // surfaces read it as its own terminal: the final-invoice send block, the
  // dunning skip list, the stuck-referral reaper, untouchedIntros, the rancher
  // dashboard's closed bucket, earnings export. Mapping it onto 'Closed Lost'
  // would have collapsed "the buyer walked" into "we gave the money back" the
  // first time anything routed a refund through the machine.
  REFUNDED: 'Refunded',
};

const STATUS_TO_STATE: Record<string, DealState> = {
  'Pending Approval': 'MATCHED',
  'Intro Sent': 'INTRO_SENT',
  'Rancher Contacted': 'IN_CONVERSATION',
  'Negotiation': 'CALL_DONE',
  'Waitlisted': 'MATCHED',
  'Awaiting Payment': 'DEPOSIT_PENDING',
  'Slot Locked': 'SLOT_LOCKED',
  'Closed Won': 'CLOSED_WON',
  'Closed Lost': 'CLOSED_LOST',
  // Same audit, reverse direction. Without this entry statusToState('Refunded')
  // returned null, and applyTransition skips its illegal-move guard entirely
  // when `from` is null — so ANY move out of a refunded deal was silently
  // allowed. REFUNDED is already in transitions.ts's TERMINAL list, so mapping
  // it here is what actually makes a refunded row terminal. The rancher PATCH
  // and pass rails both fall back to a direct write plus an operator signal
  // when the machine rejects, so a deliberate correction still lands — loudly,
  // which is the right volume for reviving a refunded deal.
  'Refunded': 'REFUNDED',
};

const STATE_TIMESTAMP: Partial<Record<DealState, string>> = {
  INTRO_SENT: 'Intro Sent At',
  CALL_BOOKED: 'Sales Call Booked At',
  CALL_DONE: 'Sales Call Completed At',
  SLOT_LOCKED: 'Rancher Accepted At',
  DELIVERED: 'Delivered At',
  CLOSED_WON: 'Closed At',
};

export function stateToStatus(s: DealState): string { return STATE_TO_STATUS[s]; }
export function statusToState(status: string): DealState | null {
  return STATUS_TO_STATE[status.trim()] ?? null;
}
export function timestampFieldFor(s: DealState): string | null {
  return STATE_TIMESTAMP[s] ?? null;
}
