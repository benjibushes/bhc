// lib/rancherNotify.ts
//
// Flawless-handoff (2026-06-27): the rancher-side of the post-deposit handoff.
//
// Before this, a settled buyer deposit fired ONLY an admin Telegram to Ben —
// the RANCHER was never told real money landed and a customer was waiting. This
// helper is the single place that notifies the rancher (email + SMS) so BOTH
// callers stay in lockstep:
//   1. lib/stripeSettlement.ts::settleBuyerDeposit — instant, on deposit settle.
//   2. app/api/cron/deposit-accept-sla — re-ping when the rancher hasn't
//      accepted within the SLA window.
//
// Mirrors the accept-route notify pattern (sendEmail + an SMS event, each in
// its own try/catch, non-fatal). Email suppression is enforced inside
// sendEmail's wrapper; SMS is flag-gated (ENABLE_SMS) and skips silently.
//
// Side effects only — never throws. Returns a small result for the caller's
// log/summary. Callers pass already-fetched rows so we don't re-hit Airtable.

import { sendRancherDepositPaid } from '@/lib/email';
import { fireRancherSMSEvent } from '@/lib/smsEvents';
import { resolveBuyerContact } from '@/lib/reserveDeposit';

export interface RancherNotifyResult {
  emailSent: boolean;
  smsSent: boolean;
  hadEmail: boolean;
  hadPhone: boolean;
  skipped?: string; // reason when neither channel had a target
}

/**
 * Resolve the rancher's best operational email. Prefers the canonical `Email`
 * field; falls back to the FIRST address in `Team Emails` (mirrors the rancher
 * auth lookup which treats Team Emails as valid contacts).
 */
export function resolveRancherEmail(rancher: Record<string, any> | null | undefined): string {
  if (!rancher) return '';
  const primary = String(rancher['Email'] || '').trim();
  if (primary) return primary;
  const team = String(rancher['Team Emails'] || '').trim();
  if (team) {
    const first = team.split(/[\s,;\n]+/).map((s) => s.trim()).filter(Boolean)[0];
    if (first) return first;
  }
  return '';
}

/** First name from the rancher's Operator Name (for a warm salutation). */
export function rancherFirstName(rancher: Record<string, any> | null | undefined): string {
  if (!rancher) return '';
  const op = String(rancher['Operator Name'] || '').trim();
  if (op) return op.split(/\s+/)[0] || '';
  return '';
}

/**
 * Notify the rancher that a buyer's deposit landed (email + SMS).
 *
 * @param referral  already-fetched Referral row (for buyer name/email/phone/cut)
 * @param rancher   already-fetched Ranchers row (for email/phone/name)
 * @param opts.isReminder  true when called from the SLA re-ping cron
 * @param opts.depositAmount  dollars (falls back to referral's Deposit Amount)
 * @param opts.consumer  already-fetched linked Consumer row; when supplied, the
 *   buyer's phone/state fall back to it if the referral lacks them (so the
 *   click-to-call number always rides the alert, even for older referrals).
 */
export async function notifyRancherDepositPaid(
  referral: Record<string, any>,
  rancher: Record<string, any>,
  opts: { isReminder?: boolean; depositAmount?: number; consumer?: Record<string, any> | null } = {},
): Promise<RancherNotifyResult> {
  const result: RancherNotifyResult = {
    emailSent: false,
    smsSent: false,
    hadEmail: false,
    hadPhone: false,
  };

  // Buyer-facing details for the alert body. Buyer Name/Email/Phone are
  // denormalized onto the referral (same fields the accept route reads).
  const buyerName = String(referral['Buyer Name'] || '').trim();
  const buyerFirstName = buyerName.split(/\s+/)[0] || 'A buyer';
  const buyerEmail = String(referral['Buyer Email'] || '').trim();
  // Phone/State: prefer the referral's denormalized values, fall back to the
  // linked Consumer (when supplied) so the alert always carries a click-to-call
  // number even for referrals created before phone/state capture shipped.
  const { phone: buyerPhone, state } = resolveBuyerContact(referral, opts.consumer);
  const cut = String(referral['Order Type'] || '').trim();
  const depositAmount =
    typeof opts.depositAmount === 'number' && opts.depositAmount > 0
      ? opts.depositAmount
      : Number(referral['Deposit Amount'] || 0) || undefined;

  const rancherEmail = resolveRancherEmail(rancher);
  const rancherPhone = String(rancher['Phone'] || '').trim();
  result.hadEmail = !!rancherEmail;
  result.hadPhone = !!rancherPhone;

  if (!rancherEmail && !rancherPhone) {
    result.skipped = 'rancher has no email or phone';
    return result;
  }

  const rancherId: string | undefined = String(rancher['id'] || rancher['Id'] || '') || undefined;

  // Email — gated on having an address. Suppression handled inside sendEmail.
  if (rancherEmail) {
    try {
      const r = await sendRancherDepositPaid({
        rancherEmail,
        rancherFirstName: rancherFirstName(rancher),
        buyerFirstName,
        buyerEmail,
        buyerPhone,
        state,
        cut,
        depositAmount,
        rancherId,
        isReminder: opts.isReminder,
      });
      result.emailSent = !!r.success;
    } catch (e: any) {
      console.warn('[rancherNotify] deposit-paid email failed (non-fatal):', e?.message);
    }
  }

  // SMS — gated on having a phone + ENABLE_SMS (inside fireRancherSMSEvent).
  if (rancherPhone) {
    try {
      result.smsSent = await fireRancherSMSEvent({
        type: 'deposit_paid_rancher',
        phone: rancherPhone,
        vars: { buyerFirstName, state, cut, amount: depositAmount },
      });
    } catch (e: any) {
      console.warn('[rancherNotify] deposit-paid SMS failed (non-fatal):', e?.message);
    }
  }

  return result;
}
