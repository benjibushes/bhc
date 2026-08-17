// lib/depositSuccessCopy.ts
//
// RAIL-AWARE post-deposit success copy. Pure — no Airtable, no React — so the
// words a buyer reads after paying are unit-testable.
//
// WHY THIS EXISTS (2026-08-17). app/checkout/[refId]/success is the landing
// page for BOTH deposit rails: the Connect deposit checkout and the broker
// checkout both set it as their success_url. Its "What happens next" list was
// written for Connect only and told a broker buyer three things that are false
// on their rail:
//   1. "We let <ranch> know your deposit landed" — stated unconditionally, even
//      when the fulfillment-sheet email was suppressed, bounced, or failed.
//   2. "you and <ranch> settle … in your message thread" — a REPRESENTED ranch
//      has no login and no thread.
//   3. "<ranch> confirms fulfillment and gets paid out by Stripe" — no Connect
//      account, no payout; the buyer pays the ranch the balance directly.
//
// BUYER FRAMING IS UNCHANGED (docs/BUSINESS-MODEL.md model 3, lib/brokerRail
// header): the buyer reads "deposit toward your share, balance paid to the
// ranch". That the deposit IS BuyHalfCow's whole commission is a matter between
// BHC and the rancher who agreed to it at signup — it is never buyer-facing.
// The unit tests pin that silence.

import { isBrokerRancher } from './brokerRail';
import { isBrokerReferralRow } from './commission';

export type DepositRail = 'connect' | 'broker';

/**
 * Did the represented ranch actually receive the fulfillment sheet?
 *
 *   'delivered'     — a delivery verdict says yes.
 *   'not-delivered' — a delivery verdict says no (suppressed / bounced / failed).
 *   'unknown'       — no verdict recorded. NEVER optimistically 'delivered'.
 *
 * `unknown` and `not-delivered` render the SAME honest, non-alarming copy; they
 * stay distinct so the operator surfaces can tell "we know it failed" from "we
 * have no record".
 */
export type RancherSheetDelivery = 'delivered' | 'not-delivered' | 'unknown';

/** The rail a referral's deposit was taken on, from its linked rancher record. */
export function depositRailForRancher(rancher: unknown): DepositRail {
  return isBrokerRancher(rancher) ? 'broker' : 'connect';
}

/**
 * The rail, read the way the success-page projection has to read it.
 *
 * The rancher's `Broker Rail` checkbox is the authority, but the deposit GET
 * fetches that record best-effort (`.catch(() => null)`) — and a failed read
 * must not quietly downgrade a broker sale into the Connect story, which is
 * exactly the copy this whole module exists to keep away from broker buyers.
 * The referral's own `Match Type`, stamped at mint by lib/brokerReferral and
 * re-stamped at settle, is therefore the belt: it needs no extra read and is
 * present before, during and after payment.
 *
 * Either signal alone is enough. A Connect referral carries neither.
 */
export function depositRailForReferral(referral: unknown, rancher: unknown): DepositRail {
  if (isBrokerRancher(rancher)) return 'broker';
  return isBrokerReferralRow(referral) ? 'broker' : 'connect';
}

// Broker settlement stamps the delivery outcome onto the referral's `Notes` —
// money-truth persisted, not just logged (repo hard rule #2). TWO formats are
// in the wild and both are read here:
//
//   legacy   `[broker] rancher notified <iso> — sent=true|false`
//   hardened `[broker] rancher fulfillment sheet <iso> — DELIVERED`
//            `[broker] rancher fulfillment sheet <iso> — NOT DELIVERED (<outcome>)`
//
// `Intro Sent At` is deliberately NOT consulted: the legacy settlement path
// stamps it whether or not the send succeeded, so it proves nothing on its own.
//
// Notes is operator-internal free text and MUST NOT be shipped to the browser —
// callers send only the verdict this returns.
const SHEET_MARKER = /\[broker\][^\n]*rancher[^\n]*(?:fulfillment sheet|notified)[^\n]*/gi;

export function brokerSheetDelivery(referral: any): RancherSheetDelivery {
  const notes = referral?.['Notes'];
  if (typeof notes !== 'string' || !notes) return 'unknown';

  const matches = notes.match(SHEET_MARKER);
  if (!matches || !matches.length) return 'unknown';
  const last = matches[matches.length - 1];

  // Order matters: "NOT DELIVERED" contains "DELIVERED".
  if (/NOT\s+DELIVERED/i.test(last)) return 'not-delivered';
  if (/\bDELIVERED\b/i.test(last)) return 'delivered';
  if (/sent\s*=\s*true/i.test(last)) return 'delivered';
  if (/sent\s*=\s*false/i.test(last)) return 'not-delivered';
  return 'unknown';
}

export interface NextStep {
  /** Timeline label rendered in the left column ("Today:", "This week:"). */
  when: string;
  text: string;
}

/**
 * The "What happens next" list for the post-deposit success page.
 *
 * CONNECT copy is byte-for-byte what shipped — it is correct for that rail and
 * must not regress. BROKER copy describes the rail that actually exists: the
 * ranch calls the buyer, and the balance is paid to the ranch directly.
 */
export function depositNextSteps(args: {
  rail: DepositRail;
  /** Rancher/ranch name as the buyer knows it; 'your rancher' when unknown. */
  rancherLabel: string;
  /** Broker only. Omitted → treated as 'unknown' (never claims we told them). */
  sheetDelivery?: RancherSheetDelivery;
}): NextStep[] {
  const who = args.rancherLabel;

  if (args.rail !== 'broker') {
    return [
      {
        when: 'Today:',
        // NOT "by email and text" — SMS is behind ENABLE_SMS, which is off and
        // has no provider configured. Only claim the channel that actually fires.
        text: `We let ${who} know your deposit landed. They reach out directly to set things up, usually the same day.`,
      },
      {
        when: 'This week:',
        text: `You and ${who} settle pickup or delivery details in your message thread — date, exact location, balance due at pickup.`,
      },
      {
        when: 'When ready:',
        text: `You pick up or ${who} delivers. ${who} confirms fulfillment and gets paid out by Stripe.`,
      },
    ];
  }

  // BROKER. The "we told them" claim is earned, not assumed: only a recorded
  // delivery buys the confident sentence. Anything else gets copy that is true
  // in every case, stays calm (no "failed", no "bounced" — the buyer did
  // nothing wrong and their share is reserved either way), and hands them one
  // real action instead of a promise.
  const told =
    args.sheetDelivery === 'delivered'
      ? `We sent ${who} your order — your share, your details, and how to reach you. They contact you directly to set things up, usually within a day.`
      : `${who} is getting your order details from us now, and contacts you directly to set things up. Haven't heard from them within a business day? Reply to your receipt email and we'll get them on the phone.`;

  return [
    { when: 'Today:', text: told },
    {
      when: 'This week:',
      text: `${who} works out the details with you directly — cut sheet, date, and pickup or delivery.`,
    },
    {
      when: 'When ready:',
      text: `You pick up or ${who} delivers, and you pay the remaining balance directly to the ranch.`,
    },
  ];
}
