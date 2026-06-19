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
  REFUNDED: 'Closed Lost',
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
