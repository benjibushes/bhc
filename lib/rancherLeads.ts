// lib/rancherLeads.ts
//
// "MY LEADS" — rancher-entered lead CRM (2026-07-29).
//
// A rancher-entered lead is NOT a new table. It is a normal Referrals row with
//   'Referral Source' = 'rancher-added'   (fldC5pUi90WDpBTsa, singleLineText)
// plus a Consumers row with
//   'Lead Source' = 'rancher-crm'.
// That makes Ben's admin, close tracking, and the deposit rail work for free.
// The real engineering is the GUARDS: these rows must be INVISIBLE to
//   - capacity math (lib/capacityCount countHeldReferrals + heldCountsByRancher),
//   - stale-hold expiry (lib/staleHolds),
//   - chase rails (referral-chasup / first-touch-sla / lead digest / close-detector),
//   - loss-recovery + replenishment buyer outreach,
//   - marketing pools (nurture-drip / email-sequences / waiting-activation /
//     send-scheduled) — these buyers opted into the RANCHER, never into BHC
//     marketing. Transactional deposit emails (rancher-initiated) are fine.
// …while STILL counting as an active deal for routing (isActiveDealReferral),
// so matching/suggest never double-deals the buyer.
//
// STAGE MODEL — four stages, deliberately mapped onto EXISTING statuses:
//   UI 'new'     ↔ 'Rancher Contacted'
//   UI 'talking' ↔ 'Negotiation'
//   UI 'won'     ↔ 'Closed Won'
//   UI 'lost'    ↔ 'Closed Lost'
// NEVER 'Awaiting Payment' from this feature: that status is OVERLOADED
// (written pre- and post-payment; pre-payment writers MUST stamp Deposit
// Requested At — repo hard rule). The deposit ask happens via the EXISTING
// request-deposit flow, which owns that transition and its stamps.
//
// Pure module — zero runtime deps (phoneFormat is pure) so every rule here is
// unit-tested without Airtable (lib/rancherLeads.test.ts).

import { normalizePhoneDigits, isValidUsPhone, formatPhoneInput } from './phoneFormat';

// ── provenance markers ────────────────────────────────────────────────────

export const REFERRAL_SOURCE_RANCHER_ADDED = 'rancher-added';
export const CONSUMER_LEAD_SOURCE_CRM = 'rancher-crm';
export const REFERRAL_SOURCE_FIELD = 'Referral Source';
export const CONSUMER_LEAD_SOURCE_FIELD = 'Lead Source';

// Loss Reason written on a My-Leads lost close. MUST stay an existing
// singleSelect choice (never invent options), and one whose lib/lossRecovery
// action is 'none' — so the loss-recovery rail never emails this buyer a
// re-route offer for a customer the rancher brought themselves.
export const CRM_LOSS_REASON = 'Other';

// Airtable singleSelects sometimes read back as {name} objects — normalize
// the same way the rest of the codebase does.
function readEnumOrString(v: unknown): string {
  if (v && typeof v === 'object' && 'name' in (v as any)) return String((v as any).name || '');
  return String(v ?? '');
}

/** THE provenance predicate — every guard keys on this. */
export function isRancherAddedReferral(ref: any): boolean {
  if (!ref) return false;
  return readEnumOrString(ref[REFERRAL_SOURCE_FIELD]).trim() === REFERRAL_SOURCE_RANCHER_ADDED;
}

// ── stage model ───────────────────────────────────────────────────────────

export type LeadStage = 'new' | 'talking' | 'won' | 'lost';

export const LEAD_STAGE_TO_STATUS: Record<LeadStage, string> = {
  new: 'Rancher Contacted',
  talking: 'Negotiation',
  won: 'Closed Won',
  lost: 'Closed Lost',
};

export const LEAD_STATUS_TO_STAGE: Record<string, LeadStage> = {
  'Rancher Contacted': 'new',
  'Negotiation': 'talking',
  'Closed Won': 'won',
  'Closed Lost': 'lost',
};

export function isLeadStage(v: unknown): v is LeadStage {
  return v === 'new' || v === 'talking' || v === 'won' || v === 'lost';
}

// ── input validation ──────────────────────────────────────────────────────

export interface LeadInput {
  name: string;
  /** lowercased; '' when not provided */
  email: string;
  /** display-formatted ((406) 555-1234); '' when not provided */
  phone: string;
  note: string;
}

// Strict email shape — same regex as lib/requalifyCampaign.ts.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateLeadInput(raw: {
  name?: unknown;
  email?: unknown;
  phone?: unknown;
  note?: unknown;
}): { ok: true; lead: LeadInput } | { ok: false; error: string } {
  const name = String(raw?.name ?? '').trim();
  if (name.length < 2 || name.length > 80) {
    return { ok: false, error: 'Name is required (2-80 characters).' };
  }

  const emailRaw = String(raw?.email ?? '').trim().toLowerCase();
  const phoneRaw = String(raw?.phone ?? '').trim();

  if (!emailRaw && !phoneRaw) {
    return { ok: false, error: 'Add at least one way to reach them — email or phone.' };
  }

  let email = '';
  if (emailRaw) {
    if (!EMAIL_RE.test(emailRaw)) {
      return { ok: false, error: 'That email does not look right — check it and try again.' };
    }
    email = emailRaw;
  }

  let phone = '';
  if (phoneRaw) {
    // #413 rule: normalize (strip a leading US 1), never truncate. A phone
    // that fails the ≥10-digit check is rejected rather than stored corrupt.
    if (!isValidUsPhone(phoneRaw)) {
      if (!email) {
        return { ok: false, error: 'That phone number looks too short — 10 digits needed.' };
      }
      // Email present: drop the bad phone instead of failing the whole add.
      phone = '';
    } else {
      phone = formatPhoneInput(normalizePhoneDigits(phoneRaw));
    }
  }

  const note = String(raw?.note ?? '').trim();
  if (note.length > 500) {
    return { ok: false, error: 'Note is too long — 500 characters max.' };
  }

  return { ok: true, lead: { name, email, phone, note } };
}

// ── stage-transition decision (pure) ──────────────────────────────────────

export type LeadStageDecision =
  | { kind: 'error'; httpStatus: number; message: string }
  | { kind: 'noop'; message: string }
  | { kind: 'update'; status: string }
  | { kind: 'close'; outcome: 'won' | 'lost'; saleAmount?: number };

const TERMINAL_STATUSES = new Set(['Closed Won', 'Closed Lost', 'Refunded', 'Dormant']);
// Deposit-rail statuses a lead can reach via the existing request-deposit
// flow. won/lost are still allowed from here while the deposit is UNPAID
// (off-platform close; the unused link just dies) — regressing to open
// stages is not (the rail's stamps would lie).
const DEPOSIT_RAIL_STATUSES = new Set(['Awaiting Payment', 'Slot Locked']);

export function decideLeadStagePatch(input: {
  referral: any;
  rancherId: string;
  stage: LeadStage | string;
  saleAmount?: number;
}): LeadStageDecision {
  const { referral, rancherId } = input;

  if (!isRancherAddedReferral(referral)) {
    return {
      kind: 'error',
      httpStatus: 403,
      message: 'Stage updates only apply to leads you added yourself. Routed buyer intros are managed from the Deals tab.',
    };
  }

  // Ownership: the Rancher link must include the session rancher. Suggested
  // Rancher is NOT enough — rancher-added rows are always created with the
  // hard link, so a Suggested-only match means this is not their lead.
  const link = Array.isArray(referral?.['Rancher']) ? referral['Rancher'] : [];
  if (!rancherId || !link.includes(rancherId)) {
    return { kind: 'error', httpStatus: 403, message: 'Not authorized.' };
  }

  if (!isLeadStage(input.stage)) {
    return { kind: 'error', httpStatus: 400, message: 'stage must be one of: new | talking | won | lost.' };
  }
  const stage = input.stage;

  // MONEY LOCK — once the deposit has SETTLED, the deposit rail owns every
  // transition (settlement/final-invoice/refund paths). Mirrors the
  // quick-action + dashboard money locks.
  if (referral?.['Deposit Paid At']) {
    return {
      kind: 'error',
      httpStatus: 409,
      message: 'This lead has a paid deposit — the deal is managed from the Deals tab now (final invoice / fulfillment).',
    };
  }

  const currentStatus = readEnumOrString(referral?.['Status']).trim();
  const targetStatus = LEAD_STAGE_TO_STATUS[stage];

  // Idempotency: same stage (open OR terminal) is a no-op, never a re-fire.
  if (currentStatus === targetStatus) {
    return { kind: 'noop', message: `Already ${stage}.` };
  }

  // Terminal leads never reopen or flip from this endpoint — that class of
  // correction is an operator move (Airtable / admin), not a one-tap.
  if (TERMINAL_STATUSES.has(currentStatus)) {
    return {
      kind: 'error',
      httpStatus: 409,
      message: `This lead is already closed ("${currentStatus}"). Contact hello@buyhalfcow.com if that is wrong.`,
    };
  }

  // Deposit link out (unpaid): closes allowed, regressions are not.
  if (DEPOSIT_RAIL_STATUSES.has(currentStatus) && (stage === 'new' || stage === 'talking')) {
    return {
      kind: 'error',
      httpStatus: 409,
      message: 'A deposit link is out to this buyer — mark the lead won or lost, or manage it from the Deals tab.',
    };
  }

  if (stage === 'won') {
    const amount = Number(input.saleAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return { kind: 'error', httpStatus: 400, message: 'Enter the sale amount to mark this lead won.' };
    }
    if (amount > 250_000) {
      return { kind: 'error', httpStatus: 400, message: 'Sale amount looks too large — check the number.' };
    }
    return { kind: 'close', outcome: 'won', saleAmount: amount };
  }
  if (stage === 'lost') {
    return { kind: 'close', outcome: 'lost' };
  }
  return { kind: 'update', status: targetStatus };
}

// ── Airtable field builders (pure) ────────────────────────────────────────

export function buildLeadConsumerFields(
  lead: LeadInput,
  ctx: { rancherState: string },
  nowIso: string,
): Record<string, any> {
  const fields: Record<string, any> = {
    'Full Name': lead.name,
    // The provenance marker every marketing-pool exclusion keys on.
    [CONSUMER_LEAD_SOURCE_FIELD]: CONSUMER_LEAD_SOURCE_CRM,
    'Source': CONSUMER_LEAD_SOURCE_CRM,
    // MATCHED = in a deal → routing pools, nurture drip, and waiting rails
    // all treat this buyer as spoken-for. Deliberately NO 'Status' (blank =
    // cron-invisible by design — WRITE-MAP Consumers), no Qualified At, no
    // Segment, no Intent Score: this buyer raised their hand to the RANCHER,
    // not to BHC.
    'Buyer Stage': 'MATCHED',
    // MUST pair with every Buyer Stage write (email-sequences skips rows
    // without it, and other readers treat the pair as one fact).
    'Buyer Stage Updated At': nowIso,
  };
  if (lead.email) fields['Email'] = lead.email;
  if (lead.phone) fields['Phone'] = lead.phone;
  if (ctx.rancherState) fields['State'] = ctx.rancherState;
  return fields;
}

export function buildLeadReferralFields(
  lead: LeadInput,
  ctx: { rancherId: string; rancherState: string; ranchName: string; consumerId: string },
  nowIso: string,
): Record<string, any> {
  const noteBlock = lead.note ? `[Rancher note]\n${lead.note}\n\n` : '';
  const fields: Record<string, any> = {
    Name: `${lead.name} → ${ctx.ranchName || 'Ranch'} · My Leads`,
    Status: LEAD_STAGE_TO_STATUS.new, // 'Rancher Contacted' — already talking by definition
    [REFERRAL_SOURCE_FIELD]: REFERRAL_SOURCE_RANCHER_ADDED,
    'Buyer Name': lead.name,
    'Buyer State': ctx.rancherState || '',
    Notes: `${noteBlock}[Source] Rancher-entered lead (My Leads CRM)`,
    Rancher: [ctx.rancherId],
    // The rancher literally just engaged — stamp freshness so activity-aware
    // rails (and the dashboard rot badges) read this row as alive.
    'Last Rancher Activity At': nowIso,
    'Rancher Engaged Flag': true,
  };
  if (lead.email) fields['Buyer Email'] = lead.email;
  if (lead.phone) fields['Buyer Phone'] = lead.phone;
  if (ctx.consumerId) fields['Buyer'] = [ctx.consumerId];
  return fields;
}
