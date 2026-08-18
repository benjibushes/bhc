// Find-or-create the deposit-intent referral for a BROKER 1-tap link.
//
// The Airtable I/O half of the /r/b redemption path (kept out of
// lib/brokerRail so that module stays hermetic + unit-testable). Mirrors
// lib/campaignReferral, with the differences the rail demands:
//
//   • addressed by rancher RECORD ID, not slug — a represented ranch has no
//     public page and no slug.
//   • gated by assertBrokerEligible, NOT assertReserveEligible. The Connect
//     gate requires isRancherOnConnect + Page Live + a Tier, all of which a
//     broker rancher deliberately lacks; running it here would reject every
//     legitimate broker link.
//   • NO capacity hold HERE. The canonical rule is that a slot is claimed
//     exactly when a referral ENTERS the held set (lib/capacityCount
//     HELD_REFERRAL_STATUSES) and released when it leaves. A row created here
//     is Status='Pending' — NOT held — so there is correctly nothing to claim
//     yet. The claim happens at the transition that actually holds a slot:
//     lib/brokerSettlement's flip to 'Awaiting Payment' (see
//     shouldIncrementOnEnterHeld). Before that pairing existed, paid broker
//     sales sat in a held status with no matching INCR, so the Redis seed read
//     them as phantom load and starved the ranch's routing.
//
// FIND-OR-CREATE, like the campaign rail: a texted link gets re-tapped (second
// device, forwarded, re-opened), and spawning a new referral per tap would
// litter duplicates.

import {
  TABLES,
  createRecord,
  updateRecord,
  getAllRecords,
  getRecordById,
  escapeAirtableValue,
} from '@/lib/airtable';
import {
  assertBrokerEligible,
  isBrokerRancher,
  formatUsdCents,
  BROKER_MATCH_TYPE,
  CUT_LABELS,
  type Cut,
  type BrokerQuote,
} from '@/lib/brokerRail';

// Statuses meaning "this deposit intent is dead or already settled" — never
// reuse one. Mirrors lib/campaignReferral's REUSABLE_BLOCKED.
const REUSABLE_BLOCKED = new Set(['Closed Won', 'Closed Lost', 'Awaiting Payment', 'Slot Locked']);

/**
 * The referral's Notes seed. Pure + exported so the weight-priced record is
 * unit-testable. For a WEIGHT-PRICED cut the note records the range and the
 * floor-stamp semantics right on the row — `Total Sale Amount` alone would
 * otherwise read like an exact price to any human scanning Airtable.
 */
export function brokerReferralNotes(quote: BrokerQuote): string {
  const base =
    '[Source] Broker rail — BHC represents this ranch; the deposit is BHC commission and the rancher collects the balance direct.';
  if (!quote.weightPriced || !quote.priceMaxCents) return base;
  return (
    base +
    `\n[weight-priced] Final share price is set by hanging weight: estimated ` +
    `${formatUsdCents(quote.priceCents)}–${formatUsdCents(quote.priceMaxCents)}. ` +
    `Total Sale Amount is stamped at the range FLOOR (conservative; the deposit/commission is exact and unaffected).`
  );
}

/**
 * The MONEY FIELDS a broker referral carries for a chosen cut. Exported and
 * shared by BOTH the create and the reuse branch — that sharing IS the fix:
 * the reuse branch used to stamp nothing, so a routed referral (created by
 * matching with no cut chosen yet) could reach checkout with a blank price and
 * a blank deposit and nothing for a human to reconcile against.
 *
 * WEIGHT-PRICED cuts stamp the range FLOOR as `Total Sale Amount` —
 * conservative, never overstates — with the full range recorded in Notes. The
 * deposit is exact in both modes.
 */
export function brokerReferralMoneyFields(quote: BrokerQuote): Record<string, any> {
  return {
    'Order Type': quote.cutLabel,
    'Total Sale Amount': quote.priceCents / 100,
    'Deposit Amount': quote.depositCents / 100,
    Notes: brokerReferralNotes(quote),
  };
}

/**
 * May this existing referral row be REUSED as the broker deposit intent for
 * `rancherId`? Pure, so the dedupe rule is unit-tested rather than inferred
 * from an inline `.find()`.
 *
 * The `Match Type` clause is byte-exact ON PURPOSE and is load-bearing in two
 * directions:
 *   • reuse — the matching engine stamps this same BROKER_MATCH_TYPE constant
 *     on a routed broker referral precisely so a buyer who then self-serves on
 *     the ranch's page lands back on THEIR row instead of spawning a duplicate;
 *   • refusal — never hijack a Connect deposit referral this buyer happens to
 *     have, or the two rails cross and the wrong money model charges.
 */
export function isReusableBrokerReferral(row: any, rancherId: string): boolean {
  if (!row || !rancherId) return false;
  const links: string[] = row['Rancher'] || row['Suggested Rancher'] || [];
  if (!Array.isArray(links) || !links.includes(rancherId)) return false;
  if (REUSABLE_BLOCKED.has(String(row['Status'] || ''))) return false;
  return String(row['Match Type'] || '') === BROKER_MATCH_TYPE;
}

export type BrokerReferralResult =
  | { ok: true; referralId: string; created: boolean; rancher: any }
  | {
      ok: false;
      reason: 'rancher-not-found' | 'not-broker-rail' | 'consumer-not-found' | 'ineligible' | 'io-error';
    };

/**
 * Resolve (find or create) the referral a broker deposit link should land on.
 * NEVER throws — every failure returns { ok:false } so the /r/b route can 302
 * to a safe page instead of 500ing.
 */
export async function findOrCreateBrokerReferral(args: {
  consumerId: string;
  rancherId: string;
  cut: Cut;
}): Promise<BrokerReferralResult> {
  const consumerId = String(args.consumerId || '').trim();
  const rancherId = String(args.rancherId || '').trim();
  const cut = String(args.cut || '').trim().toLowerCase() as Cut;
  if (!consumerId || !rancherId || !CUT_LABELS[cut]) {
    return { ok: false, reason: 'rancher-not-found' };
  }

  // 1) Rancher by record id.
  let rancher: any;
  try {
    rancher = await getRecordById(TABLES.RANCHERS, rancherId);
  } catch {
    return { ok: false, reason: 'io-error' };
  }
  if (!rancher) return { ok: false, reason: 'rancher-not-found' };

  // 2) FAIL CLOSED on the rail. A token minted while the ranch was on the
  //    broker rail must not still work after they were migrated onto Connect —
  //    that would charge a Connect rancher's buyer under broker economics.
  if (!isBrokerRancher(rancher)) return { ok: false, reason: 'not-broker-rail' };

  // 3) Money gates, before we create anything: priced, has a deposit,
  //    deposit < price, and no Connect footprint.
  const gate = assertBrokerEligible(rancher, cut);
  if (!gate.ok) return { ok: false, reason: 'ineligible' };

  // 4) Consumer must still exist (the token names it; guard a deleted row).
  let buyer: any = null;
  try {
    const rows: any[] = await getAllRecords(
      TABLES.CONSUMERS,
      `RECORD_ID() = "${escapeAirtableValue(consumerId)}"`,
    );
    buyer = rows[0] || null;
  } catch {
    return { ok: false, reason: 'io-error' };
  }
  if (!buyer) return { ok: false, reason: 'consumer-not-found' };

  const buyerEmail = String(buyer['Email'] || '').trim().toLowerCase();
  const buyerName = String(buyer['Full Name'] || '').trim();

  // 5) Reuse an existing OPEN broker referral for this buyer↔rancher.
  try {
    if (buyerEmail) {
      const candidates: any[] = await getAllRecords(
        TABLES.REFERRALS,
        `LOWER(TRIM({Buyer Email})) = "${escapeAirtableValue(buyerEmail)}"`,
      );
      const match = candidates.find((r) => isReusableBrokerReferral(r, rancherId));
      if (match) {
        // MONEY TRUTH ON REUSE (repo rule #2). The create branch below stamps
        // Total Sale Amount / Deposit Amount / Order Type; until now the reuse
        // branch stamped NOTHING, on the assumption that any row it found had
        // been created here and already carried them.
        //
        // That assumption broke when the matching engine started minting
        // broker referrals (app/api/matching/suggest — it stamps Match Type
        // BROKER_MATCH_TYPE precisely so this find-or-create reuses its row
        // instead of duplicating). A matched buyer has no cut yet, so the
        // routed row is created with blank money — and reusing it silently
        // carried those blanks all the way to checkout, leaving a payable
        // referral with no recorded price or deposit for anyone to reconcile
        // against.
        //
        // Stamp the CHOSEN cut's money now, from the same gate the checkout
        // will charge on. Best-effort: an Airtable blip must never block a
        // buyer who is trying to pay, and settlement re-stamps all three
        // authoritatively from the Stripe metadata (lib/brokerSettlement).
        try {
          await updateRecord(TABLES.REFERRALS, match.id, brokerReferralMoneyFields(gate.quote));
        } catch (e: any) {
          console.error('[brokerReferral] reuse money stamp failed:', e?.message);
        }
        return { ok: true, referralId: match.id, created: false, rancher };
      }
    }
  } catch {
    // A read blip must not block a real buyer — fall through to create.
  }

  // 6) Create the broker deposit-intent referral.
  const ranchName = String(rancher['Ranch Name'] || rancher['Operator Name'] || 'Rancher');
  const fields: Record<string, any> = {
    Name: `${buyerName || buyerEmail} → ${ranchName} · ${gate.quote.cutLabel}`,
    Status: 'Pending',
    // Typecast-created choice — the rail's human-readable label. Contains
    // "Deposit" so deposit-intent filters elsewhere still recognize it.
    'Match Type': BROKER_MATCH_TYPE,
    'Buyer Name': buyerName || '',
    'Buyer Email': buyerEmail,
    'Intent Score': 90,
    'Intent Classification': 'High',
    Rancher: [rancherId],
    Buyer: [consumerId],
    // Money truth up front, before a cent moves — from the SAME builder the
    // reuse branch above uses, so the two can never drift.
    ...brokerReferralMoneyFields(gate.quote),
  };
  const phone = String(buyer['Phone'] || '').trim();
  if (phone) fields['Buyer Phone'] = phone;
  const state = String(buyer['State'] || '').trim();
  if (state) fields['Buyer State'] = state;

  let referral: any;
  try {
    referral = await createRecord(TABLES.REFERRALS, fields);
  } catch {
    return { ok: false, reason: 'io-error' };
  }

  // NO capacity increment — Status='Pending' is not a held slot. The claim
  // fires when the row enters the held set at settlement (file header).
  return { ok: true, referralId: referral.id, created: true, rancher };
}
