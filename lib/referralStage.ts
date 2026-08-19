// lib/referralStage.ts
//
// Data-layer audit P1-1 (2026-08-18) — where a Referral actually IS, read from
// the stamps rather than from an overloaded Status string. PURE: no imports,
// no IO, safe in a client component.
//
// THE PROBLEM. Referral `Status` = 'Awaiting Payment' means TWO different
// things at two different points in the deal:
//   • before the accept — the DEPOSIT has not landed;
//   • after it — the accepted deal has been invoiced for the BALANCE, written
//     by app/api/rancher/referrals/[id]/send-final-invoice.
// That second write lands on a row already at 'Slot Locked', so the accepted
// state is erased seconds after it is reached. Live proof at the time of this
// fix: of 1,806 referrals ZERO sit at 'Slot Locked' and exactly two sit at
// 'Awaiting Payment' — both carrying `Rancher Accepted At` (one invoiced 78
// seconds after accepting). Every surface asking `{Status}='Slot Locked'`
// therefore showed an empty queue, and the desk's advance button offered those
// two deals 'Slot Locked' — a backward re-accept — instead of the close.
//
// WHY THE WRITE STAYS. It is load-bearing for two money-recovery rails that
// select on that exact string: app/api/cron/final-invoice-dunning (Airtable
// formula AND isDunningEligible) and app/api/cron/awaiting-payment-nudge.
// Removing it would make an unpaid final invoice silently un-chaseable. The
// Status is not the bug; asking it a question only the timestamps can answer
// is. `Rancher Accepted At` is stamped by lib/deal on SLOT_LOCKED and is never
// cleared except by a full refund, so it is the durable truth.

/** Deal is over — nothing to advance, nothing to chase. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['Closed Won', 'Closed Lost', 'Refunded']);

/** Tolerates Airtable's `{name}` singleSelect object form. */
function statusOf(ref: any): string {
  const raw = ref?.['Status'] ?? '';
  if (raw && typeof raw === 'object' && 'name' in raw) return String((raw as any).name || '').trim();
  return String(raw || '').trim();
}

function acceptedAt(ref: any): string {
  return String(ref?.['Rancher Accepted At'] ?? '').trim();
}

/**
 * Has the rancher accepted this slot, with the deal still live?
 *
 * THE replacement for `{Status}='Slot Locked'` on every operator surface. Reads
 * the accept STAMP, so it keeps seeing the deal after the final invoice
 * rewrites Status. Fails CLOSED: no stamp, or an unreadable row, is not in the
 * cohort.
 */
export function isAcceptedInFlight(ref: any): boolean {
  if (!ref) return false;
  if (!acceptedAt(ref)) return false;
  return !TERMINAL_STATUSES.has(statusOf(ref));
}

/**
 * Airtable formula for the same cohort, so the query and the JS predicate
 * cannot drift. `Rancher Accepted At` is a live Referrals field (the
 * deposit-accept-sla cron already filters on it), so this is safe to send.
 */
export const ACCEPTED_IN_FLIGHT_FORMULA =
  `AND(NOT({Rancher Accepted At}=''),{Status}!='Closed Won',{Status}!='Closed Lost',{Status}!='Refunded')`;

/**
 * Formula for the genuinely deposit-pending cohort — 'Awaiting Payment' rows
 * the rancher has NOT accepted. Keeps the desk's two money queues mutually
 * exclusive now that the accepted queue reads the stamp: without the
 * accept-is-empty clause an invoiced deal would appear in both.
 */
export const DEPOSIT_PENDING_FORMULA =
  `AND({Status}='Awaiting Payment',{Rancher Accepted At}='')`;

/**
 * Which stages may an operator move this referral to?
 *
 * The canonical advance path, with ONE stamp-aware branch: an 'Awaiting
 * Payment' row that has already been accepted is past the slot lock, so its
 * forward move is the CLOSE. Offering 'Slot Locked' there re-accepts a deal
 * that was accepted days ago and costs a second click on the only two deals
 * that have ever got this far.
 *
 * Server-validated in app/api/admin/referrals/[id]/stage; the desk button
 * renders nextStageFor() from the same table.
 */
export function allowedStagesFrom(ref: any): string[] {
  const status = statusOf(ref);
  switch (status) {
    case 'Intro Sent':
      return ['Awaiting Payment', 'Closed Lost'];
    case 'Awaiting Payment':
      return isAcceptedInFlight(ref) ? ['Closed Won', 'Closed Lost'] : ['Slot Locked', 'Closed Lost'];
    case 'Slot Locked':
      return ['Closed Won', 'Closed Lost'];
    case 'Closed Lost':
      return ['Intro Sent']; // revive
    default:
      return [];
  }
}

/** The single forward step the desk's advance button offers, or null. */
export function nextStageFor(ref: any): string | null {
  return allowedStagesFrom(ref)[0] ?? null;
}
