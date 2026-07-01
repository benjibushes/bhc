// lib/smsEvents.ts
//
// F9 — Feature-flagged SMS event dispatcher.
//
// User constraint: "I dont have twlio setup yet" — stub everything
// behind ENABLE_SMS feature flag (default off). Twilio creds may
// be unset entirely. When user flips ENABLE_SMS=1 in env, sends
// start firing via existing sendSMSToConsumer (TCPA-gated + opt-in
// + Unsubscribed mirror).
//
// 7 buyer-journey events with copy:
//   1. signup            — "Welcome to BHC..."
//   2. quiz_invite       — "Quick 60s quiz..."
//   3. cal_reminder      — "Your call w/ Ben in 1h..."
//   4. deposit_invoice   — "Deposit invoice ready..."
//   5. slot_locked       — "Slot locked at <ranch>!"
//   6. refund            — "Deposit refunded..."
//   7. fulfillment       — "Beef ready for pickup..."
//
// Each template: 160 chars max, single SMS segment, no emojis
// that break GSM-7 encoding.

import { sendSMSToConsumer, sendSMS } from './twilio';

export type SMSEventType =
  | 'signup'
  | 'quiz_invite'
  | 'cal_reminder'
  | 'deposit_invoice'
  | 'slot_locked'
  | 'refund'
  | 'fulfillment';

// Rancher-facing (operational/B2B) events. Kept separate from the buyer
// SMSEventType union because they ride a DIFFERENT gate: a rancher is a
// business partner who signed up to sell + receive deal alerts, not a
// marketing consumer. These skip the buyer TCPA SMS-Opt-In consent gate
// (which applies to consumers) and use the raw transactional sender — still
// flag-gated by ENABLE_SMS so nothing fires until Twilio is live.
export type RancherSMSEventType = 'deposit_paid_rancher';

const SMS_FEATURE_FLAG = 'ENABLE_SMS';

function isSMSEnabled(): boolean {
  return process.env[SMS_FEATURE_FLAG] === '1';
}

interface SMSEventVars {
  firstName?: string;
  ranchName?: string;
  amount?: number;       // dollars
  pickupDate?: string;   // human-readable
}

function buildBody(type: SMSEventType, vars: SMSEventVars): string {
  const fn = vars.firstName || 'there';
  switch (type) {
    case 'signup':
      return `Welcome to BuyHalfCow, ${fn}. We connect you to a ranch you trust. Watch your inbox for your next step. Reply STOP to opt out.`;
    case 'quiz_invite':
      return `${fn}, quick 60s quiz unlocks your rancher match: ${process.env.NEXT_PUBLIC_SITE_URL || 'buyhalfcow.com'}/qualify. Reply STOP to opt out.`;
    case 'cal_reminder':
      return `${fn}, your call with Ben at BuyHalfCow starts in 1 hour. Check your email for the link. Reply STOP to opt out.`;
    case 'deposit_invoice':
      return `${fn}, your deposit invoice is ready. Check your email to lock your slot at ${vars.ranchName || 'your ranch'}. Reply STOP to opt out.`;
    case 'slot_locked':
      return `${fn}, slot locked at ${vars.ranchName || 'your ranch'}! Pickup ${vars.pickupDate || 'TBD'}. Reply STOP to opt out.`;
    case 'refund':
      return `${fn}, your $${vars.amount || 0} deposit was refunded. It will land in 5-10 business days. Reply STOP to opt out.`;
    case 'fulfillment':
      return `${fn}, your beef is ready for pickup at ${vars.ranchName || 'your ranch'} on ${vars.pickupDate || 'TBD'}. Reply STOP to opt out.`;
  }
}

/**
 * Fire a buyer-journey SMS gated by ENABLE_SMS feature flag.
 * No-op when flag off — safe to wire into any call path now.
 *
 * Stacked gates (any false = skip):
 *   1. ENABLE_SMS=1                 (feature flag)
 *   2. SMS Opt-In on Consumer       (TCPA)
 *   3. Unsubscribed flag mirror     (global suppression)
 *   4. Phone number present + valid
 */
export async function fireSMSEvent(input: {
  type: SMSEventType;
  consumer: Record<string, any> | null | undefined;
  vars?: SMSEventVars;
}): Promise<boolean> {
  if (!isSMSEnabled()) {
    // Feature off — silent skip. No console noise.
    return false;
  }
  if (!input.consumer) return false;
  const vars = input.vars || {};
  const body = buildBody(input.type, vars);
  return sendSMSToConsumer({
    consumer: input.consumer,
    body,
    reason: `event=${input.type}`,
  });
}

interface RancherSMSEventVars {
  buyerFirstName?: string;
  state?: string;
  cut?: string;        // "Quarter" | "Half" | "Whole" | freeform
  amount?: number;     // dollars paid as deposit
}

// Body builder for rancher operational SMS. Pulled out (mirrors buildBody) so
// the copy lives in one place and the deposit-paid notify + the SLA re-ping
// cron emit identical text. GSM-7 safe (no emoji), single segment target.
function buildRancherBody(type: RancherSMSEventType, vars: RancherSMSEventVars): string {
  const who = vars.buyerFirstName || 'A buyer';
  const where = vars.state ? ` in ${vars.state}` : '';
  const cut = vars.cut ? vars.cut.toLowerCase() : 'share';
  const amt = typeof vars.amount === 'number' && vars.amount > 0
    ? ` ($${Math.round(vars.amount).toLocaleString('en-US')} deposit)`
    : '';
  switch (type) {
    case 'deposit_paid_rancher':
      return `BuyHalfCow: ${who}${where} just PAID a deposit for a ${cut}${amt}. They're expecting your call today. Accept + details in your dashboard: ${process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com'}/rancher`;
  }
}

/**
 * Fire a rancher-facing operational SMS gated by ENABLE_SMS feature flag.
 * Uses the raw transactional sender (a rancher consented to deal alerts at
 * onboarding — this is not a marketing message), so it does NOT require the
 * consumer TCPA SMS-Opt-In gate. No-op when the flag is off.
 *
 * Stacked gates (any false = skip):
 *   1. ENABLE_SMS=1            (feature flag — nothing fires until Twilio live)
 *   2. phone present + valid   (normalized E.164 inside sendSMS)
 */
export async function fireRancherSMSEvent(input: {
  type: RancherSMSEventType;
  phone: string | null | undefined;
  vars?: RancherSMSEventVars;
}): Promise<boolean> {
  if (!isSMSEnabled()) return false;
  const to = (input.phone || '').toString().trim();
  if (!to) return false;
  const body = buildRancherBody(input.type, input.vars || {});
  return sendSMS({ to, body });
}
