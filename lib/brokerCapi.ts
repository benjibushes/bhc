// BROKER RAIL — Meta Conversions API event construction.
//
// Pure + hermetic on purpose: lib/brokerSettlement pulls lib/email → lib/secrets
// and cannot load in a bare test env, so the decision ("which events, which
// value, which event_id, which match keys") lives HERE where it can be pinned,
// and settleBrokerDeposit just hands the result to fireCapi.
//
// WHY THIS EXISTS AT ALL
// ----------------------
// The broker rail fired ZERO conversion events. The Connect rail's settlement
// (lib/stripeSettlement) has fired a server InitiateCheckout since launch and a
// gated Purchase since 2026-07-04, but its broker sibling never did — so every
// deposit on a represented ranch was invisible to Meta. Ads pointed at those
// ranch pages could not be optimized, and their revenue never showed up against
// spend.
//
// ── VALUE SEMANTICS (the one real judgement call — do not "fix" this) ────────
// The Purchase value is the DEPOSIT, not the share price.
//
// On this rail the buyer's card is charged the deposit and NOTHING ELSE. The
// balance is paid directly to the ranch, off-platform, in cash or by the
// ranch's own arrangement — BHC never sees it, Stripe never sees it, and no
// later event ever confirms it happened. Three independent reasons the deposit
// is the honest number:
//
//   1. IT IS WHAT THE BUYER PAID. Meta's Purchase value is meant to be the
//      transaction amount. readBrokerMoney clamps depositCents to the real
//      charge (pi.amount), so this figure is the card statement, exactly.
//   2. IT DEDUPS. The success-page client Purchase (app/checkout/[refId]/
//      success/page.tsx) fires with value = the settled Payments row's
//      'Total Charged Cents' ÷ 100 — which markDepositSucceeded writes as
//      depositCents on this rail. Server and browser must agree or the deduped
//      pair reports a conflicting value.
//   3. IT IS THE ACTUAL REVENUE. Money model 3: the deposit IS BHC's entire
//      commission (docs/BUSINESS-MODEL.md). Reporting the full share price
//      would inflate the conversion value by roughly 4-5x against real spend
//      and push the bidder toward a fictitious ROAS. The Connect rail reports
//      the buyer-paid total for the same reason — same principle, different
//      arithmetic, because there the buyer really is charged deposit + fee.
//
// This is a MEASUREMENT decision only. Nothing here is buyer-facing: no copy
// produced by this module reaches a buyer, and none of it names the commission.

import {
  buildUserData,
  depositEventId,
  reconstructFbc,
  type CapiEvent,
} from '@/lib/metaCapi';
import { metaEventId } from '@/lib/analytics';

export interface BrokerCapiInput {
  referralId: string;
  /**
   * What the buyer was actually charged on this transaction, in cents — the
   * output of readBrokerMoney (already clamped to pi.amount). This is the
   * Purchase value; see the VALUE SEMANTICS note above.
   */
  depositCents: number;
  /** The linked Consumer row, or null when unreadable (event still fires). */
  consumer?: Record<string, any> | null;
  /** The Referral row — the fallback source for buyer identity. */
  referral?: Record<string, any> | null;
  /** Human cut label for content_name ('Half Cow'). '' is fine. */
  cutLabel?: string;
  /**
   * depositPurchaseEnabled() from lib/metaCapi, passed in rather than read here
   * so this module stays pure and the gate keeps ONE authoritative definition.
   * false → no Purchase event is produced at all (dark by default).
   */
  purchaseEnabled: boolean;
  /** Injectable clock for tests. */
  nowMs?: number;
}

/**
 * Match keys for the broker deposit events.
 *
 * Identity is read from the Consumer first and the Referral second — the same
 * precedence buildBrokerOrderFacts (lib/brokerNotify) uses, so the pixel and
 * the emails describe the same person. That includes `state`: the referral's
 * denormalized 'Buyer State' is a copy of the consumer's State taken at
 * referral creation (lib/brokerReferral), so the fallback is a no-op whenever
 * the Consumer row reads — it only earns its keep on the degraded path where
 * the Consumer is unreadable, which is exactly when we'd otherwise drop a
 * match key. Email/phone/name already fall back this way; state must too.
 *
 * PHONE is included here and NOT on the Connect side (lib/stripeSettlement
 * builds email/name/state/fbc only). That is an addition, not a divergence:
 * buildUserData SHA-256s it (digits only, min 10) exactly like every other
 * key, so it is one more hashed match signal, never plaintext.
 *
 * fbc is rebuilt from the buyer's stored first-touch click id + click
 * timestamp. reconstructFbc returns undefined unless BOTH are present and sane,
 * which is why the reserve rails now persist `fbclid` / `fbclid_ts` at consumer
 * creation (lib/adAttribution). No fbp: a Stripe webhook has no browser and no
 * cookies, so there is nothing to read — same as the Connect rail.
 */
export function buildBrokerCapiUserData(
  consumer?: Record<string, any> | null,
  referral?: Record<string, any> | null,
): ReturnType<typeof buildUserData> {
  const email = String(consumer?.['Email'] || referral?.['Buyer Email'] || '').trim().toLowerCase();
  const phone = String(consumer?.['Phone'] || referral?.['Buyer Phone'] || '').trim();
  const fullName = String(consumer?.['Full Name'] || referral?.['Buyer Name'] || '').trim();
  const nameParts = fullName ? fullName.split(/\s+/) : [];
  const fbclid = String(consumer?.['fbclid'] || '').trim();
  const fbclidTs = Number(consumer?.['fbclid_ts'] || 0);
  return buildUserData({
    email: email || undefined,
    phone: phone || undefined,
    firstName: nameParts[0] || undefined,
    lastName: nameParts.slice(1).join(' ') || undefined,
    state: String(consumer?.['State'] || referral?.['Buyer State'] || '').trim() || undefined,
    fbc: reconstructFbc(fbclid, fbclidTs),
  });
}

/**
 * The events to fire when a broker deposit settles.
 *
 * Always: InitiateCheckout — the intent signal, event_id = metaEventId(
 * referralId) (the raw record id, the repo-wide dedup convention), matching the
 * Connect rail so both rails' deposits land in one Meta event stream.
 *
 * Gated: Purchase — only when purchaseEnabled (META_DEPOSIT_PURCHASE_ENABLED
 * === 'true', dark by default). event_id = depositEventId(referralId) =
 * `deposit_<referralId>` — the SAME id the success page's client Pixel fires,
 * so browser + server dedup into one Purchase, and deliberately distinct from
 * the Closed-Won Purchase's id (see lib/metaCapi depositEventId).
 *
 * action_source 'system_generated': there is no browser in a Stripe webhook.
 */
export function buildBrokerDepositCapiEvents(input: BrokerCapiInput): CapiEvent[] {
  const eventTime = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const userData = buildBrokerCapiUserData(input.consumer, input.referral);
  // Never emit a negative or NaN value — a bad read reports 0, which Meta
  // accepts, rather than poisoning the conversion-value column.
  const cents = Number(input.depositCents);
  const value = Number.isFinite(cents) && cents > 0 ? cents / 100 : 0;
  const label = String(input.cutLabel || '').trim();
  const customData = {
    value,
    currency: 'usd',
    content_name: label ? `Beef deposit — ${label}` : 'Beef deposit',
    content_category: 'buyer-deposit',
  };

  const events: CapiEvent[] = [
    {
      event_name: 'InitiateCheckout',
      event_time: eventTime,
      event_id: metaEventId(input.referralId),
      action_source: 'system_generated',
      user_data: userData,
      custom_data: customData,
    },
  ];

  if (input.purchaseEnabled) {
    events.push({
      event_name: 'Purchase',
      event_time: eventTime,
      event_id: depositEventId(input.referralId),
      action_source: 'system_generated',
      user_data: userData,
      custom_data: customData,
    });
  }

  return events;
}
