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
//   • NO capacity hold. Capacity (`Max Active Referalls` / the Redis counter)
//     is a PLATFORM supply-routing construct for ranchers the matching engine
//     assigns buyers to. Ben allocates a represented rancher's shares himself
//     on the phone, and the rancher is excluded from routing entirely, so
//     incrementing a counter nobody reads would only pollute drift checks.
//
// FIND-OR-CREATE, like the campaign rail: a texted link gets re-tapped (second
// device, forwarded, re-opened), and spawning a new referral per tap would
// litter duplicates.

import {
  TABLES,
  createRecord,
  getAllRecords,
  getRecordById,
  escapeAirtableValue,
} from '@/lib/airtable';
import {
  assertBrokerEligible,
  isBrokerRancher,
  BROKER_MATCH_TYPE,
  CUT_LABELS,
  type Cut,
} from '@/lib/brokerRail';

// Statuses meaning "this deposit intent is dead or already settled" — never
// reuse one. Mirrors lib/campaignReferral's REUSABLE_BLOCKED.
const REUSABLE_BLOCKED = new Set(['Closed Won', 'Closed Lost', 'Awaiting Payment', 'Slot Locked']);

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
      const match = candidates.find((r) => {
        const links: string[] = r['Rancher'] || r['Suggested Rancher'] || [];
        if (!links.includes(rancherId)) return false;
        if (REUSABLE_BLOCKED.has(String(r['Status'] || ''))) return false;
        // Only reuse a BROKER referral — never hijack a Connect deposit
        // referral this buyer happens to have, or the rails would cross.
        return String(r['Match Type'] || '') === BROKER_MATCH_TYPE;
      });
      if (match) return { ok: true, referralId: match.id, created: false, rancher };
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
    'Order Type': gate.quote.cutLabel,
    'Intent Score': 90,
    'Intent Classification': 'High',
    Notes: '[Source] Broker rail — BHC represents this ranch; the deposit is BHC commission and the rancher collects the balance direct.',
    Rancher: [rancherId],
    Buyer: [consumerId],
    // Money truth up front, before a cent moves.
    'Total Sale Amount': gate.quote.priceCents / 100,
    'Deposit Amount': gate.quote.depositCents / 100,
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

  // NO capacity increment — see the file header.
  return { ok: true, referralId: referral.id, created: true, rancher };
}
