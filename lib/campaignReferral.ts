// Find-or-create the deposit-intent referral for a campaign 1-tap link.
//
// The /r/d/<token> route resolves the buyer's OWN referral pinned to the
// campaign's rancher, then hands it to the deposit page. This is the Airtable
// I/O layer (kept out of lib/campaignReserve.ts so that module stays hermetic +
// unit-testable). It REUSES the self-serve reserve path's record shape
// (buildReserveReferralFields) and capacity-hold pattern (reserve/route.ts:
// 135-155) verbatim so a campaign deposit and a rancher-page deposit produce the
// SAME kind of referral.
//
// FIND-OR-CREATE (vs reserve's always-create): a campaign link is tapped from an
// email/SMS and may be re-tapped (re-opened thread, second device, forwarded).
// Spawning a new Pending referral + capacity hold on every tap would drift the
// rancher's slot counter and litter duplicates. So we first look for an OPEN
// deposit-intent referral already pinning this buyer↔rancher and reuse it;
// only create (and bump capacity) when there's a genuinely new intent.

import {
  TABLES,
  createRecord,
  updateRecord,
  getAllRecords,
  getRancherBySlug,
  escapeAirtableValue,
} from '@/lib/airtable';
import { incrementCapacity, syncCapacityToAirtable } from '@/lib/rancherCapacity';
import { buildReserveReferralFields, CUT_LABELS, type Cut } from '@/lib/reserveDeposit';

// Statuses that mean "this deposit intent is dead / already settled" — never
// reuse one of these; the buyer needs a fresh referral. Mirrors the deposit
// route's terminal gates (checkout/deposit/route.ts:87-100).
const REUSABLE_BLOCKED = new Set(['Closed Won', 'Closed Lost', 'Awaiting Payment', 'Slot Locked']);

export type CampaignReferralResult =
  | { ok: true; referralId: string; created: boolean; rancher: any }
  | { ok: false; reason: 'rancher-not-found' | 'consumer-not-found' | 'io-error' };

/**
 * Resolve (find or create) the referral a campaign deposit link should land on.
 *
 *  - Looks up the rancher by slug (the link's rancherSlug). Missing → fallback.
 *  - Confirms the consumer row still exists (the token names consumerId; if the
 *    record was deleted we must not create an orphan referral) → fallback.
 *  - Reuses an existing OPEN referral pinning this buyer↔rancher with a deposit
 *    Match Type if one exists (created:false, no capacity bump).
 *  - Else creates a deposit-intent referral (buildReserveReferralFields) and
 *    holds a slot (created:true), exactly like the reserve route.
 *
 * NEVER throws — every failure returns { ok:false } so the /r route falls back
 * to the rancher's public page instead of 500ing.
 */
export async function findOrCreateCampaignReferral(args: {
  consumerId: string;
  rancherSlug: string;
  cut: Cut;
}): Promise<CampaignReferralResult> {
  const consumerId = String(args.consumerId || '').trim();
  const rancherSlug = String(args.rancherSlug || '').trim();
  const cut = String(args.cut || '').trim().toLowerCase() as Cut;
  if (!consumerId || !rancherSlug || !CUT_LABELS[cut]) {
    return { ok: false, reason: 'rancher-not-found' };
  }

  // 1) Rancher by slug.
  let rancher: any;
  try {
    rancher = await getRancherBySlug(rancherSlug);
  } catch {
    return { ok: false, reason: 'io-error' };
  }
  if (!rancher) return { ok: false, reason: 'rancher-not-found' };

  // 2) Consumer must still exist (token names it; guard against a deleted row).
  let buyer: any = null;
  try {
    const safeId = escapeAirtableValue(consumerId);
    const rows: any[] = await getAllRecords(TABLES.CONSUMERS, `RECORD_ID() = "${safeId}"`);
    buyer = rows[0] || null;
  } catch {
    return { ok: false, reason: 'io-error' };
  }
  if (!buyer) return { ok: false, reason: 'consumer-not-found' };

  const buyerEmail = String(buyer['Email'] || '').trim().toLowerCase();
  const buyerName = String(buyer['Full Name'] || '').trim();

  // 3) Reuse an existing OPEN deposit-intent referral for this buyer↔rancher.
  //    Filter by Buyer Email (a flat field — link fields aren't formula-
  //    filterable) then confirm the Rancher link + reusable status in JS.
  try {
    if (buyerEmail) {
      const safeEmail = escapeAirtableValue(buyerEmail);
      const candidates: any[] = await getAllRecords(
        TABLES.REFERRALS,
        `LOWER(TRIM({Buyer Email})) = "${safeEmail}"`,
      );
      const match = candidates.find((r) => {
        const rancherLinks: string[] = r['Rancher'] || r['Suggested Rancher'] || [];
        if (!rancherLinks.includes(rancher.id)) return false;
        const status = String(r['Status'] || '');
        if (REUSABLE_BLOCKED.has(status)) return false;
        // Only reuse a deposit-intent referral (not a generic lead/match) so we
        // don't hijack an unrelated open referral the buyer has with this ranch.
        const matchType = String(r['Match Type'] || '');
        return matchType.includes('Deposit');
      });
      if (match) {
        return { ok: true, referralId: match.id, created: false, rancher };
      }
    }
  } catch {
    // A read failure here shouldn't block a brand-new buyer — fall through to
    // create. Worst case we create a referral that a prior tap already made;
    // capacity-drift-check reconciles abandoned Pending holds.
  }

  // 4) Create the deposit-intent referral (same shape as the reserve route).
  let referral: any;
  try {
    referral = await createRecord(
      TABLES.REFERRALS,
      buildReserveReferralFields({ rancher, consumerId, buyerName, buyerEmail, cut }),
    );
  } catch {
    return { ok: false, reason: 'io-error' };
  }

  // 5) Hold the slot during checkout (mirror reserve/route.ts:148-155). Transient:
  //    an abandoned Pending referral is reconciled by capacity-drift-check.
  try {
    const newCount = await incrementCapacity(rancher.id);
    await syncCapacityToAirtable(rancher.id, newCount);
    await updateRecord(TABLES.RANCHERS, rancher.id, { 'Last Assigned At': new Date().toISOString() });
  } catch {
    // Non-fatal — the referral exists; capacity reconciles later.
  }

  return { ok: true, referralId: referral.id, created: true, rancher };
}
