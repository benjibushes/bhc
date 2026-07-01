// lib/signalDelivery.ts
//
// Pure routing decision for operator alerts — which wires does a signal
// ride? Mirrors lib/routingPriority.ts: side-effect-free + independently
// unit-tested, so lib/operatorSignal.ts can delegate the decision without
// the test chain dragging in telegram/twilio/email (a `type`-only
// operatorSignal import erases at runtime).
//
// The model: EVERY signal rides Telegram (the primary wire). A `loud`
// signal that Telegram FAILED to deliver (null return / thrown — rotten
// bot token, Telegram outage) falls back to SMS + email, but only the
// wires that actually have a configured target. Non-loud signals never
// fall back — a missed digest is noise, a missed deposit-failure is money.
// Dedupe suppression happens ONCE, upstream of every wire: an outage must
// not turn a repeating alert into an SMS storm.

import type { SignalUrgency } from './operatorSignal';

export interface SignalDeliveryPlan {
  /** Fire the primary Telegram wire (always, unless dedupe-suppressed). */
  telegram: boolean;
  /** Fire the SMS fallback wire (loud + Telegram failed + phone configured). */
  sms: boolean;
  /** Fire the email fallback wire (loud + Telegram failed + address configured). */
  email: boolean;
}

export function planSignalDelivery(input: {
  urgency: SignalUrgency;
  /** Did the Telegram wire deliver? (false = returned null or threw) */
  telegramOk: boolean;
  hasSmsTarget: boolean;
  hasEmailTarget: boolean;
  /** Dedupe window suppressed this signal — nothing fires, on any wire. */
  deduped?: boolean;
}): SignalDeliveryPlan {
  if (input.deduped) {
    return { telegram: false, sms: false, email: false };
  }
  const fallback = input.urgency === 'loud' && !input.telegramOk;
  return {
    telegram: true,
    sms: fallback && input.hasSmsTarget,
    email: fallback && input.hasEmailTarget,
  };
}
