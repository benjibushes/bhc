// lib/strandedBuyers.ts
//
// STRANDED-MATCHED RESTORE (routing forensics 2026-07-08). The gap this
// closes: a buyer whose Buyer Stage is 'MATCHED' but whose only referral(s)
// went terminal (Closed Lost by a rancher, Dormant, etc.) is invisible to
// EVERY routing rail — batch-approve and stuck-buyer-recovery both read only
// Buyer Stage='READY', and the stale-hold expiry cron's restore leg only
// touches buyers whose referrals IT flipped. So a buyer a rancher passed on
// sat at MATCHED forever, never reconsidered (found live: Amie/TX, referral
// Closed Lost at Ashcraft, never re-routed).
//
// This is the general backstop: ANY buyer at MATCHED with no live deal
// referral (isActiveDealReferral over the full set) should drop back to
// READY so the next recovery pass reconsiders them against current supply.
//
// Pure — the cron passes plain records in; no Airtable/network here so it's
// unit-tested in isolation.

import { isActiveDealReferral } from './capacityCount';

function readStage(c: any): string {
  const v = c?.['Buyer Stage'];
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && 'name' in v) return String(v.name || '');
  return String(v);
}

/**
 * IDs of consumers stranded at MATCHED with no live deal — safe to reset to
 * READY. A buyer is stranded iff:
 *   - Buyer Stage === 'MATCHED', AND
 *   - none of their referrals is an active deal (isActiveDealReferral).
 *
 * CLOSED buyers (Closed Won / already customers) never appear — they aren't
 * at MATCHED. Suppressed/rejected filtering is the caller's job (the recovery
 * pass re-applies the full qualification gate before actually routing); this
 * only un-sticks the stage so they can be SEEN.
 */
export function strandedMatchedBuyerIds(consumers: any[], referrals: any[]): string[] {
  // Map buyer -> has at least one live deal.
  const hasLiveDeal = new Set<string>();
  for (const ref of referrals) {
    if (!isActiveDealReferral(ref)) continue;
    for (const id of (ref?.['Buyer'] || []) as string[]) hasLiveDeal.add(id);
  }

  const out: string[] = [];
  for (const c of consumers) {
    if (!c?.id) continue;
    if (readStage(c) !== 'MATCHED') continue;
    if (hasLiveDeal.has(c.id)) continue; // a real deal is in flight — leave it
    out.push(c.id);
  }
  return out;
}
