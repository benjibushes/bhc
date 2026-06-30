// lib/fulfillmentTracking.ts
//
// WAVE 3b (2026-06-30) — pure fulfillment / order-tracking logic for the
// rancher dashboard. The existing "Mark beef delivered" flag
// (/api/rancher/fulfillment/confirm) is a single binary moment. This module
// adds a richer per-order tracker on top of it: a delivery status that moves
// through scheduled → processing → ready → fulfilled, plus structured order
// detail (processing date, cut-sheet note, pickup-vs-ship, carrier + tracking
// number).
//
// Extracted as a PURE module so the status-machine + validation can be
// unit-tested WITHOUT a live Airtable/session. The route
// (/api/rancher/referrals/[id]/fulfillment) stays a thin shell: auth, load
// record, call validateFulfillmentUpdate, write the returned fields, side
// effects.
//
// GRACEFUL DEGRADATION: the Airtable fields this writes are NEW (see
// FULFILLMENT_AIRTABLE_FIELDS — the founder must create them). Until they
// exist the write is best-effort and the route swallows the unknown-field
// error; the UI gates on whether the dashboard payload returns these fields.

export type FulfillmentStatus =
  | 'scheduled'
  | 'processing'
  | 'ready'
  | 'fulfilled';

export const FULFILLMENT_STATUSES: readonly FulfillmentStatus[] = [
  'scheduled',
  'processing',
  'ready',
  'fulfilled',
] as const;

// Human labels for the UI (brand voice = lowercase honest).
export const FULFILLMENT_STATUS_LABELS: Record<FulfillmentStatus, string> = {
  scheduled: 'scheduled',
  processing: 'at processor',
  ready: 'ready for pickup/ship',
  fulfilled: 'delivered',
};

export type FulfillmentMethod = 'pickup' | 'ship';
export const FULFILLMENT_METHODS: readonly FulfillmentMethod[] = ['pickup', 'ship'] as const;

// Airtable field names this module reads/writes. NEW fields — the founder
// creates them in the Referrals table. Surfaced in the PR's
// airtable_fields_needed.
export const FULFILLMENT_FIELDS = {
  status: 'Fulfillment Status',          // singleSelect: scheduled|processing|ready|fulfilled
  processingDate: 'Processing Date',     // date — ALREADY EXISTS (set by send-final-invoice)
  cutSheetNote: 'Cut Sheet Note',        // long text
  method: 'Fulfillment Method',          // singleSelect: pickup|ship
  carrier: 'Shipping Carrier',           // single line text
  trackingNumber: 'Tracking Number',     // single line text
  updatedAt: 'Fulfillment Updated At',   // date/time
} as const;

// The subset that is genuinely NEW (Processing Date already exists). These are
// what the founder must add before writes persist.
export const FULFILLMENT_AIRTABLE_FIELDS_NEEDED: readonly string[] = [
  'Fulfillment Status (singleSelect: scheduled, processing, ready, fulfilled)',
  'Cut Sheet Note (long text)',
  'Fulfillment Method (singleSelect: pickup, ship)',
  'Shipping Carrier (single line text)',
  'Tracking Number (single line text)',
  'Fulfillment Updated At (date with time)',
] as const;

export function isFulfillmentStatus(v: unknown): v is FulfillmentStatus {
  return typeof v === 'string' && (FULFILLMENT_STATUSES as readonly string[]).includes(v);
}

export function isFulfillmentMethod(v: unknown): v is FulfillmentMethod {
  return typeof v === 'string' && (FULFILLMENT_METHODS as readonly string[]).includes(v);
}

/**
 * Rank of a status in the lifecycle (0 = scheduled … 3 = fulfilled).
 * Used to decide whether a requested transition moves forward, stays, or
 * regresses.
 */
export function statusRank(s: FulfillmentStatus): number {
  return FULFILLMENT_STATUSES.indexOf(s);
}

/**
 * Decide whether a status transition is allowed.
 *
 * Rules (intentionally permissive but guarded):
 *   - Same status → allowed (idempotent re-save of other fields).
 *   - Forward by any number of steps → allowed (rancher can jump straight to
 *     fulfilled if they pick up + hand off same day).
 *   - Backward → allowed ONLY by one step (a correction — e.g. marked ready
 *     too early). A jump back from fulfilled → scheduled is blocked as almost
 *     certainly a mistake.
 */
export function canTransition(from: FulfillmentStatus, to: FulfillmentStatus): boolean {
  const f = statusRank(from);
  const t = statusRank(to);
  if (t >= f) return true;           // forward or same
  return f - t === 1;                // one step back = correction
}

export interface FulfillmentUpdateInput {
  /** Linked rancher ids on the referral (Rancher OR Suggested Rancher). */
  referralLinkedRancherIds: string[];
  /** Rancher id from the SESSION — never the body. */
  sessionRancherId: string;
  /** Current Fulfillment Status stored on the referral (may be missing). */
  currentStatus?: string | null;
  /** Requested patch from the client body. All optional. */
  patch: {
    status?: unknown;
    cutSheetNote?: unknown;
    method?: unknown;
    carrier?: unknown;
    trackingNumber?: unknown;
    processingDate?: unknown;
  };
  /** Now, injected for testability. */
  nowIso?: string;
}

export type FulfillmentUpdateResult =
  | { ok: true; fields: Record<string, any>; status: FulfillmentStatus }
  | { ok: false; status: number; error: string };

const MAX_NOTE = 1000;
const MAX_CARRIER = 80;
const MAX_TRACKING = 120;

/**
 * Validate + normalize a fulfillment-tracker update.
 *
 * Returns the exact Airtable field map to write (only the keys the rancher
 * actually changed), or an error with an HTTP status. PURE — no IO.
 */
export function validateFulfillmentUpdate(input: FulfillmentUpdateInput): FulfillmentUpdateResult {
  const { referralLinkedRancherIds, sessionRancherId, patch } = input;

  // Ownership — defense in depth (the route also checks). A rancher may only
  // touch their OWN referral.
  if (!sessionRancherId || !referralLinkedRancherIds.includes(sessionRancherId)) {
    return { ok: false, status: 403, error: 'This referral does not belong to you.' };
  }

  const now = input.nowIso || new Date().toISOString();
  const fields: Record<string, any> = {};

  // ── Status (the one required-ish field) ──────────────────────────────────
  const current: FulfillmentStatus = isFulfillmentStatus(input.currentStatus)
    ? input.currentStatus
    : 'scheduled';

  let nextStatus: FulfillmentStatus = current;
  if (patch.status !== undefined) {
    if (!isFulfillmentStatus(patch.status)) {
      return {
        ok: false,
        status: 400,
        error: `Invalid status. Must be one of: ${FULFILLMENT_STATUSES.join(', ')}.`,
      };
    }
    if (!canTransition(current, patch.status)) {
      return {
        ok: false,
        status: 409,
        error: `Can't move fulfillment from "${current}" back to "${patch.status}". Only one-step corrections are allowed.`,
      };
    }
    nextStatus = patch.status;
    fields[FULFILLMENT_FIELDS.status] = nextStatus;
  }

  // ── Cut-sheet note ───────────────────────────────────────────────────────
  if (patch.cutSheetNote !== undefined) {
    const note = String(patch.cutSheetNote ?? '').trim().slice(0, MAX_NOTE);
    fields[FULFILLMENT_FIELDS.cutSheetNote] = note || null;
  }

  // ── Method (pickup vs ship) ──────────────────────────────────────────────
  if (patch.method !== undefined && patch.method !== '' && patch.method !== null) {
    if (!isFulfillmentMethod(patch.method)) {
      return { ok: false, status: 400, error: 'Fulfillment method must be "pickup" or "ship".' };
    }
    fields[FULFILLMENT_FIELDS.method] = patch.method;
  } else if (patch.method === '' || patch.method === null) {
    fields[FULFILLMENT_FIELDS.method] = null;
  }

  const resolvedMethod: FulfillmentMethod | null = isFulfillmentMethod(fields[FULFILLMENT_FIELDS.method])
    ? (fields[FULFILLMENT_FIELDS.method] as FulfillmentMethod)
    : null;

  // ── Carrier + tracking (only meaningful for ship) ────────────────────────
  if (patch.carrier !== undefined) {
    const carrier = String(patch.carrier ?? '').trim().slice(0, MAX_CARRIER);
    fields[FULFILLMENT_FIELDS.carrier] = carrier || null;
  }
  if (patch.trackingNumber !== undefined) {
    const tracking = String(patch.trackingNumber ?? '').trim().slice(0, MAX_TRACKING);
    fields[FULFILLMENT_FIELDS.trackingNumber] = tracking || null;
  }

  // A tracking number without a carrier is allowed (some ranchers just paste a
  // tracking link). But a tracking number on a PICKUP order is almost
  // certainly a mistake — block it so the buyer doesn't get a "track your
  // shipment" cue for a pickup.
  const tn = fields[FULFILLMENT_FIELDS.trackingNumber];
  if (resolvedMethod === 'pickup' && typeof tn === 'string' && tn.length > 0) {
    return {
      ok: false,
      status: 400,
      error: 'This order is set to local pickup — clear the tracking number or switch the method to ship.',
    };
  }

  // ── Processing date — loose parse, reject past + unparseable ──────────────
  if (patch.processingDate !== undefined && patch.processingDate !== '' && patch.processingDate !== null) {
    const parsed = new Date(String(patch.processingDate));
    if (isNaN(parsed.getTime())) {
      return { ok: false, status: 400, error: 'Processing date is not a recognizable date. Use YYYY-MM-DD.' };
    }
    fields[FULFILLMENT_FIELDS.processingDate] = String(patch.processingDate);
  } else if (patch.processingDate === '' || patch.processingDate === null) {
    fields[FULFILLMENT_FIELDS.processingDate] = null;
  }

  // Nothing to write at all (no recognized keys present)?
  if (Object.keys(fields).length === 0) {
    return { ok: false, status: 400, error: 'No fulfillment fields provided.' };
  }

  // Always stamp updated-at when we write anything.
  fields[FULFILLMENT_FIELDS.updatedAt] = now;

  return { ok: true, fields, status: nextStatus };
}
