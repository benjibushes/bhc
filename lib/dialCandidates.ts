// lib/dialCandidates.ts
//
// Fold every buyer source the operator surfaces already hold into ONE list of
// callable buyers for lib/callbackQueue.rankDialQueue.
//
// Extracted VERBATIM from app/api/admin/desk/route.ts (Wave 1B, 2026-08-01)
// so the /admin/today cockpit and the desk API share one candidate builder —
// the ranking itself stays in lib/callbackQueue. Airtable field names live
// here (the boundary); callbackQueue speaks camelCase only.
//
// Merged by consumer id, not concatenated — a buyer who asked for a call AND
// has an unpaid checkout open is one person and must appear once, in the
// higher tier. Costs no extra Airtable read: all three inputs are rows the
// caller already fetched for other purposes.

import { orderTypeToCut } from './requalifyCampaign';
import { isAcceptedInFlight } from './referralStage';
import type { DialCandidate } from './callbackQueue';

// Consumers field names, verified against the live schema (tblAbjQDnLrOtjpoE)
// 2026-07-30 — see docs/WRITE-MAP.md.
export const F_CALLBACK_REQUESTED_AT = 'Callback Requested At';
export const F_CALLBACK_NOTE = 'Callback Note';
export const F_CALLBACK_HANDLED_AT = 'Callback Handled At';

export function buildDialCandidates(
  callbackRows: any[],
  depositPending: any[],
  quizComplete: any[],
): DialCandidate[] {
  const byId = new Map<string, DialCandidate>();
  const merge = (id: string, patch: Partial<DialCandidate>) => {
    if (!id) return;
    // First writer wins per field, and sources are merged highest-signal
    // first, so a callback row's identity is never clobbered by a colder one.
    const prev = byId.get(id) || { id };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === '' || v === null) continue;
      if ((prev as any)[k] === undefined || (prev as any)[k] === '') (prev as any)[k] = v;
    }
    byId.set(id, prev);
  };

  // 1. asked for a call — the top tier.
  for (const c of callbackRows) {
    merge(c.id, {
      id: c.id,
      name: String(c['Full Name'] || '').trim(),
      state: String(c['State'] || '').trim(),
      phone: String(c['Phone'] || '').trim(),
      email: String(c['Email'] || '').trim(),
      callbackRequestedAt: String(c[F_CALLBACK_REQUESTED_AT] || ''),
      callbackHandledAt: String(c[F_CALLBACK_HANDLED_AT] || ''),
      callbackNote: String(c[F_CALLBACK_NOTE] || '').trim(),
      qualifiedAt: String(c['Qualified At'] || ''),
      hasCutOnFile: !!orderTypeToCut(c['Order Type']),
      nextFollowUpAt: String(c['Next Follow Up At'] || ''),
    });
  }

  // 2. opened a deposit page and never paid. Keyed on the referral's Buyer
  //    link so it merges with the same person's callback row; falls back to
  //    the referral id so a link-less row is still listed rather than dropped.
  //
  //    ACCEPTED DEALS ARE NOT IN THIS TIER (2026-08-19). Referral Status
  //    'Awaiting Payment' is overloaded (lib/referralStage): before the accept
  //    it means the DEPOSIT has not landed, after it the BALANCE has not,
  //    because send-final-invoice rewrites an accepted 'Slot Locked' row. The
  //    desk API already queries the two cohorts apart (DEPOSIT_PENDING_FORMULA
  //    / ACCEPTED_IN_FLIGHT_FORMULA, PR #655); the cockpit derives its list in
  //    JS off a snapshot, so the guard lives HERE too and the two surfaces
  //    cannot drift again.
  //
  //    Why EXCLUDE rather than relabel: an accepted deal is not a checkout
  //    that was walked away from, and it already has a lane with the right
  //    script — lib/closeQueue ranks it on revenue-per-call and says "Balance
  //    is due — collect it." Left here it never even reached this tier
  //    ('Deposit Paid At' is set, so dialTierFor drops it to `other`, i.e.
  //    "No fresh signal" at the cockpit's lowest priority) AND it registered
  //    the referral id in lib/cockpitDialList's dedupe map, suppressing that
  //    close-queue row outright.
  for (const r of depositPending.filter((r) => !isAcceptedInFlight(r))) {
    const buyerLink = Array.isArray(r['Buyer']) ? String(r['Buyer'][0] || '') : '';
    merge(buyerLink || r.id, {
      id: buyerLink || r.id,
      name: String(r['Buyer Name'] || '').trim(),
      state: String(r['Buyer State'] || '').trim(),
      phone: String(r['Buyer Phone'] || '').trim(),
      email: String(r['Buyer Email'] || '').trim(),
      depositLinkOpenedAt: String(r['Deposit Link Opened At'] || ''),
      depositPaidAt: String(r['Deposit Paid At'] || ''),
      lastChasedAt: String(r['Last Chased At'] || ''),
      referralId: r.id,
      rancherName: String(r['Rancher Name'] || r['Suggested Rancher Name'] || '').trim(),
      cutLabel: String(r['Order Type'] || '').trim(),
      dealAmount: Number(r['Total Sale Amount'] || r['Sale Amount'] || 0) || undefined,
      hasLiveDeal: true,
    });
  }

  // 3. qualified, a real cut on file, nothing live. Buyer Stage='READY' is
  //    already the "not in a deal" state (MATCHED is the in-deal one), so
  //    these rows carry no live-deal flag unless a referral above set it.
  for (const c of quizComplete) {
    merge(c.id, {
      id: c.id,
      name: String(c['Full Name'] || '').trim(),
      state: String(c['State'] || '').trim(),
      phone: String(c['Phone'] || '').trim(),
      email: String(c['Email'] || '').trim(),
      qualifiedAt: String(c['Qualified At'] || ''),
      hasCutOnFile: !!orderTypeToCut(c['Order Type']),
      nextFollowUpAt: String(c['Next Follow Up At'] || ''),
    });
  }

  return [...byId.values()];
}
