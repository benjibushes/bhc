import { getAllRecords, createRecord, TABLES, escapeAirtableValue } from './airtable';

/**
 * Per-recipient rolling 7-day email cap. Configurable via env var w/
 * a safe default. Audit 2 P1: reduced from 10 to 3 to protect sender
 * reputation at paid-ad scale. Tighten further if needed via env var.
 */
const DEFAULT_FREQUENCY_CAP = Number(process.env.EMAIL_FREQUENCY_CAP_PER_WEEK || 3);

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Templates that bypass the frequency cap entirely. These are
 * transactional sends that customers EXPECT and depend on (invoice,
 * approval, intro). Suppressing one of these would break revenue or
 * trust.
 *
 * NOTE: sendPilotUpsellEmail was removed (Audit 2 P1) — it is marketing,
 * not transactional. Should be subject to frequency caps.
 */
export const TRANSACTIONAL_WHITELIST: ReadonlySet<string> = new Set([
  'sendInstantCommissionInvoice',
  'sendMonthlyCommissionInvoice',
  'sendRancherApproval',
  'sendBuyerIntroNotification',
  'sendInquiryToRancher',
  'sendMatchedDay4CheckIn',
  'sendConsumerApproval',
  'sendFoundingHerdWelcome',
  'sendRancherGoLiveEmail',
  'sendRancherSelfSubmitWelcome',
  'sendProspectClaimMagicLink',
  // Customer-expected order confirmation after wholesale checkout.
  'sendWholesaleConfirmation',
  // Customer-expected approval + payment link — blocks revenue if suppressed.
  'sendBrandApprovalWithPayment',
  // Customer-expected confirmation that their brand listing is live.
  'sendBrandListingConfirmation',
  // Customer-expected payment failure notice — must reach the brand to retry.
  'sendBrandPaymentFailed',
  // Customer-expected pre-renewal heads-up (3-7d before subscription renews) —
  // gives customer time to update card / cancel intentionally / etc. Suppressing
  // = surprise charge = chargeback. P3-A audit fix.
  'sendRenewalReminder',
  // Customer-expected fulfillment confirmation post-order.
  'sendBuyerFulfillmentConfirmation',
  // Customer-expected confirmation that partner application was received.
  'sendPartnerConfirmation',
  // Operator-expected internal alerts — capping these blinds the team.
  'sendAdminAlert',
  // Operator-expected inquiry alerts so admins can respond in-band.
  'sendInquiryAlertToAdmin',
  // Auth-critical: magic-link login. Capping this locks members out.
  'sendMagicLink',
]);

/**
 * Per-process memoization to avoid hammering Airtable with the same
 * recipient lookup 50x during a single cron run. 60-second TTL — soft
 * stale acceptable for cap accuracy.
 */
const _countCache: Map<string, { count: number; ts: number }> = new Map();
const CACHE_TTL_MS = 60_000;

export interface FrequencyGateResult {
  ok: boolean;
  reason?: 'cap-exceeded' | 'paused' | 'unsubscribed' | 'bounced' | 'complained';
  weekCount: number;
  cap: number;
}

/**
 * Check whether sending another email to `recipientEmail` for template
 * `templateName` would violate the frequency cap, pause flag, or known
 * suppression list. Transactional templates always pass.
 *
 * Returns `ok: true` to send. `ok: false` + reason to suppress.
 *
 * The pause check uses the existing Cron Pauses table (template names
 * stored alongside cron names). The unsubscribed/bounced/complained
 * checks are delegated to the caller for now — those flags live on
 * Consumers/Ranchers, not on Email Sends, and the guard doesn't know
 * the recipient type. Caller's existing suppression list should still
 * fire BEFORE this guard. The guard returns those reason values for
 * uniformity if a caller wants to use this as the single check.
 */
export async function checkFrequencyCap(
  recipientEmail: string,
  templateName: string,
): Promise<FrequencyGateResult> {
  const cap = DEFAULT_FREQUENCY_CAP;

  // Pause check runs BEFORE the whitelist so an operator running
  // `/pausemail <template>` can halt even a transactional template
  // when it's misbehaving. Emergency stop must always win.
  try {
    const pauses = await getAllRecords(
      TABLES.CRON_PAUSES,
      `AND({Name}="${escapeAirtableValue(templateName)}", {Paused}=TRUE())`,
    ) as any[];
    if (pauses.length > 0) {
      return { ok: false, reason: 'paused', weekCount: 0, cap };
    }
  } catch (e: any) {
    // Don't let pause-table read error block a send. Log + proceed.
    console.warn(`[freqGuard] pause check failed for ${templateName}:`, e?.message);
  }

  // Transactional whitelist — bypass the rolling 7-day cap.
  if (TRANSACTIONAL_WHITELIST.has(templateName)) {
    return { ok: true, weekCount: 0, cap };
  }

  // Count rolling 7-day sends to this recipient.
  let count = 0;
  const cached = _countCache.get(recipientEmail.toLowerCase());
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    count = cached.count;
  } else {
    try {
      const sinceISO = new Date(Date.now() - SEVEN_DAYS_MS).toISOString();
      const safeEmail = escapeAirtableValue(recipientEmail.toLowerCase());
      const records = await getAllRecords(
        TABLES.EMAIL_SENDS,
        `AND(LOWER({Recipient Email})="${safeEmail}", {Sent At} > "${sinceISO}", {Status}="sent")`,
      ) as any[];
      count = records.length;
      _countCache.set(recipientEmail.toLowerCase(), { count, ts: Date.now() });
    } catch (e: any) {
      console.warn(`[freqGuard] count read failed for ${recipientEmail}, failing open:`, e?.message);
      // Fail open — if we can't read, let the send through. Better to
      // over-send by a few than to drop critical email during an Airtable
      // outage.
      return { ok: true, weekCount: 0, cap };
    }
  }

  if (count >= cap) {
    return { ok: false, reason: 'cap-exceeded', weekCount: count, cap };
  }
  return { ok: true, weekCount: count, cap };
}

/**
 * Append a row to the Email Sends Airtable table. Used by every
 * named send helper after either dispatching to Resend or suppressing.
 * Non-fatal: logs failure to console + continues.
 */
export async function logEmailSend(input: {
  recipientEmail: string;
  recipientConsumerId?: string;
  templateName: string;
  subject: string;
  status: 'sent' | 'suppressed' | 'bounced' | 'complained';
  suppressionReason?: string;
}): Promise<void> {
  try {
    const fields: any = {
      'Sent At': new Date().toISOString(),
      'Recipient Email': input.recipientEmail.toLowerCase(),
      'Template Name': input.templateName,
      'Subject': input.subject.slice(0, 500),
      'Status': input.status,
    };
    if (input.suppressionReason) {
      fields['Suppression Reason'] = input.suppressionReason;
    }
    if (input.recipientConsumerId) {
      fields['Recipient Consumer'] = [input.recipientConsumerId];
    }
    await createRecord(TABLES.EMAIL_SENDS, fields);
  } catch (e: any) {
    // Use console.error so this surfaces in Vercel log API (console.warn is invisible there).
    // Log the full error object — statusCode + errors array — so the root cause is findable
    // without a deploy. Previously this only logged e?.message which hid 403/422 details.
    console.error(
      `[freqGuard] logEmailSend FAILED for ${input.recipientEmail} / ${input.templateName}:`,
      e?.message,
      'statusCode:', e?.statusCode,
      'FULL ERROR:', JSON.stringify(e?.errors || e?.error || e),
    );
  } finally {
    // Invalidate the cap cache for this recipient regardless of whether
    // the Airtable log write succeeded. If logging failed (422/403), the
    // cache would otherwise stay stale and over/under-cap subsequent sends.
    _countCache.delete(input.recipientEmail.toLowerCase());
  }
}

/**
 * Helper for callers that already have the recipient Consumer record id.
 * Returns the same shape as `checkFrequencyCap` but skips the Cron Pauses
 * lookup for transactional templates (perf).
 */
export function isTransactionalTemplate(templateName: string): boolean {
  return TRANSACTIONAL_WHITELIST.has(templateName);
}
