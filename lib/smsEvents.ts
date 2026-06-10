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

import { sendSMSToConsumer } from './twilio';

export type SMSEventType =
  | 'signup'
  | 'quiz_invite'
  | 'cal_reminder'
  | 'deposit_invoice'
  | 'slot_locked'
  | 'refund'
  | 'fulfillment';

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
