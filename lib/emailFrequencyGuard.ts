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
  // P0 hotfix (2026-06-02): rancher intro email from /api/matching/suggest
  // was hitting the 3/week cap silently — 60%+ of intros suppressed during
  // volume spikes. Whitelisted because this is revenue-critical (without it
  // the rancher never knows a buyer was matched to them).
  'sendRancherIntroNotification',
  'sendInquiryToRancher',
  'sendMatchedDay4CheckIn',
  'sendConsumerApproval',
  'sendFoundingHerdWelcome',
  'sendRancherGoLiveEmail',
  'sendRancherSelfSubmitWelcome',
  'sendProspectClaimMagicLink',
  // Customer-expected order confirmation after wholesale checkout.
  'sendWholesaleConfirmation',
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
  // Customer-expected shipping notification — the tracking number for a
  // ~$1,000 frozen-meat shipment. Sent at most ONCE per referral (the
  // fulfillment route only fires it on the FIRST save of a tracking number),
  // so whitelisting cannot cause volume. Suppressing it = buyer misses the
  // delivery window = thawed beef on a porch. D3, 2026-07-01.
  'sendBuyerShippingNotification',
  // Customer-expected confirmation that partner application was received.
  'sendPartnerConfirmation',
  // Operator-expected internal alerts — capping these blinds the team.
  'sendAdminAlert',
  // Operator-expected inquiry alerts so admins can respond in-band.
  'sendInquiryAlertToAdmin',
  // Auth-critical: magic-link login. Capping this locks members out.
  'sendMagicLink',
  // Revenue-critical: tier_v2 final invoice. Capping this would silently
  // suppress the rancher's final-payment email to the buyer — money lost.
  // Added 2026-06-04 after audit found this was missing.
  'sendBuyerFinalInvoice',
  // Post-signup customer-expected mail. Buyer just hit submit on /access,
  // they're waiting on this. Caps in flow here would break the YES-click
  // qualify-link flow entirely.
  'sendWelcomeAndReadyToBuy',
  // Stale-lead recovery (one-shot admin trigger for deploy-gap buyers).
  // Sent once per buyer w/ Notes-based dedup; should never hit cap but
  // whitelisted as belt-and-suspenders.
  'sendCleanupRecovery',
  // Migration deadline countdown for rancher tier_v2 upgrade. 4 sends
  // total per rancher (Day 7/4/2/1 of 14-day window). Revenue-critical
  // operator notice; must not be capped.
  'sendMigrationNudge',
  // Abandon-cart nudge for qualified buyers who didn't deposit within 4h.
  // One-shot per buyer (Notes dedup), revenue-critical. The frequency cap
  // would silently drop this nudge if the buyer already received their
  // welcome + RTB + intro in the same week (which they always do — that's
  // 3 emails already). Whitelisted to ensure recovery actually fires.
  'sendQualifiedNoActionNudge',
  // NRD-2 (2026-06-05): buyer "slot locked" confirmation when rancher
  // accepts. Buyer-facing legal-significance email — deposit transitions
  // to non-refundable so they must receive this. Capping = silent loss of
  // the disclosure that protects BHC against future chargeback disputes.
  'sendBuyerSlotLocked',
  // Deposit-paid confirmation: the buyer's payment-success email. A fresh
  // deposit buyer also receives welcome + quiz-invite + intro in the same
  // window, so without whitelisting this the #1 money-moment confirmation
  // can be silently frequency-capped -> "did my payment go through?" anxiety,
  // refund requests, and chargebacks on the deposit.
  'sendPostPurchaseWelcome',
  // Sales-floor pivot 2026-06-09: 4 new minimal-pipeline templates. All
  // are 1:1 transactional triggered by buyer state changes (signup, quiz
  // complete, sales-call close, rancher accept). Capping any of these
  // breaks the buyer journey silently.
  'buyer_signup_confirmation',
  'quiz_complete_cal_invite',
  // tier_v2/Connect twin of quiz_complete_cal_invite (#160, shipped 2026-06-30):
  // when a qualified buyer matches a Connect rancher they get the deposit-primary
  // invite instead of the cal invite — same quiz-complete money-moment slot. A
  // fresh buyer also gets welcome in the same window, so without whitelisting,
  // the #1 funnel conversion email is silently frequency-capped.
  'quiz_complete_deposit_invite',
  'buyer_deposit_invoice',
  'slot_locked_confirmation',
  // 2026-06-30 audit: two funnel-critical 1:1 triggers the buyer is actively
  // waiting on. sendQuizInvite is the backup quiz link when the client redirect
  // to /qualify stalls on a hot signup — capping it strands the buyer at the
  // one moment it matters. sendRerouteNotification fires when a rancher
  // passes/declines ("found you another rancher") — capping it makes the buyer
  // think they were silently dropped. Both arrive in the same week as
  // welcome+intro, i.e. exactly the cohort at/over the 3/week cap.
  'sendQuizInvite',
  'sendRerouteNotification',
  // T1 (2026-06-10): templates that were silently dropping at cap.
  // cron/cal-reminder-1h sends 1h-before-call notice — buyer typically
  // already got 3 emails (welcome+intro+cal-invite) this week.
  'sendCalReminder1h',
  // F10 abandon-quiz nudge for buyers who signed up but never quizzed.
  // Same cap collision as above.
  'sendAbandonedQuizNudge',
  // F10 expired-link recovery (POST /api/qualify/resend-link).
  'sendQuizResendLink',
  // T2 (2026-06-10): v2-upgrade invite for 14 legacy ranchers; rancher
  // got their migration nudge + agreement emails this same week.
  'sendV2UpgradeInvite',
  // Customer-expected /access submit confirmation. Rare to hit cap
  // (first interaction) but whitelisted for safety.
  'sendConsumerConfirmation',
  // T3 (2026-06-10): rancher intro after manual referral approval.
  // Manual-approve path bypassed cap; whitelist makes it consistent.
  'sendReferralApprovedIntro',
  // Rancher reactivation campaign (2026-06-13): staggered "book a v2 call
  // or remove yourself" sends to ~44 dormant legacy ranchers. Cadence is
  // already sanity-capped by the cron (8/day, 5d spacing, max ~2 touches),
  // and the Remove CTA is the existing unsubscribe flow, so the 3/week cap
  // would only ever drop a legitimately-scheduled campaign touch. Whitelist
  // both so the campaign engine — not the frequency guard — owns cadence.
  'sendRancherReactivationWarm',
  'sendRancherReactivationCold',
  // Flawless-handoff (2026-06-27): rancher "deposit paid — your buyer is
  // waiting" alert. Fires on deposit settlement + the deposit-accept-sla cron
  // re-ping. Operator/revenue-critical: a paid customer is expecting a call,
  // and the SLA re-ping deliberately re-sends the SAME template, so the 3/week
  // cap would silently swallow the safety-net nudge. Cadence is owned by the
  // SLA cron's own dedupe (Rancher Re-pinged At), not the frequency guard.
  'sendRancherDepositPaid',
  // Flawless-handoff (2026-06-27): buyer-preferences handoff mirror to the
  // rancher (POST /api/checkout/[refId]/preferences). Customer-driven, 1:1,
  // and the rancher likely already got intro + deposit-paid emails this week,
  // so the 3/week cap would silently drop the buyer's stated wishes.
  'sendRancherBuyerPreferences',
  // Demand Router backfill campaign (2026-06-27): the capacity-gated 3-wave
  // re-activation drip (Msg1 day0 / Msg2 +3 / Msg3 +7). Cadence + volume are
  // owned by lib/demandRouter (per-buyer wave-gap dedupe + openSlots×buffer
  // capacity gate + 7d non-campaign recency suppression + 18mo-dead exclusion),
  // so the generic 3/week cap would only ever drop a legitimately-scheduled
  // wave. Whitelist all three so the campaign engine owns cadence. Unsub/bounce
  // suppression still applies (resend wrapper). DRY-RUN gate lives in the cron.
  'demandRouterMsg1',
  'demandRouterMsg2',
  'demandRouterMsg3',
  // Demand Router abandoned-reserve recovery (2026-06-27): the recovery email
  // for buyers who reserved a deposit but never paid. Cadence is owned by
  // lib/reserveRecovery's own per-referral stamp (Reserve Recovery Sent At),
  // so the generic 3/week cap would only ever silently drop a legitimately-
  // scheduled recovery — AND the cron stamps BEFORE the send, so a cap-suppress
  // would mark the buyer recovered with nothing sent. Whitelist it. Unsub/bounce
  // suppression still applies (resend wrapper). DRY-RUN gate lives in the cron.
  'reserveRecoveryEmail',
  // E3/B15 (2026-07-01): fulfillment-chase rancher nudge — deposit-paid,
  // rancher-accepted order past its Processing Date with no fulfillment
  // confirmation. Cadence is owned by the chase cron's own stamps
  // (Fulfillment Chase Last Sent At / Count: 48h cooldown, one send per tier,
  // 3 lifetime) — AND the cron stamps BEFORE the send, so a cap-suppress
  // would burn one of the 3 lifetime chase slots with nothing delivered.
  // Unsub/bounce suppression still applies (resend wrapper).
  'sendRancherFulfillmentNudge',
  // Guard-truth fix (2026-07-01): money-path sends that previously used the
  // generic capped 'sendEmail' templateName — a rancher/buyer mid-deal easily
  // hits 3 emails/week, after which each of these was silently eaten.
  // Money-path: a NEW paying store lead's order request to the rancher.
  // Capping this = the lead silently vanishes (rancher never contacted).
  'sendOrderRequestToRancher',
  // Customer-expected: buyer's "your order request was delivered" confirmation
  // right after they hit submit — capping it = "did my request go through?"
  'sendOrderRequestConfirmation',
  // Customer-expected 1:1 buyer<->rancher thread mirror. The message is already
  // persisted in-thread; capping the mirror silently kills the conversation
  // mid-deal (neither side knows the other replied).
  'sendThreadMessageNotification',
  // Money-path operator notice: rancher's bank rejected the payout. Fires once
  // per Stripe payout.failed event; must reach the rancher or they don't get paid.
  'sendPayoutFailed',
  // Money-path: one-shot-per-deal dunning escalation to the rancher (fires only
  // on the touch that crosses ESCALATE_AFTER_TOUCHES, never retried) — a
  // cap-suppress means the rancher never learns the balance is outstanding.
  'sendDunningEscalation',
]);

// T1 (2026-06-10): dynamic-name templates whose names contain a stage
// or timestamp variable (e.g. `rancher_docs_reminder_${stage}`). Each
// fires exactly once per stage transition + Notes dedup, so cap is
// noise. Match by prefix.
export const TRANSACTIONAL_WHITELIST_PREFIXES: readonly string[] = [
  'rancher_docs_reminder_',
];

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
  // Prefix match (e.g. `rancher_docs_reminder_${stage}`).
  if (TRANSACTIONAL_WHITELIST_PREFIXES.some((p) => templateName.startsWith(p))) {
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
  /**
   * Optional campaign name. When present, written to the Email Sends
   * `Campaign` field so the campaign console can tie engagement
   * (delivered/opened/clicked) back to the originating Campaigns row.
   * Left unset for transactional/one-off sends — backward-compatible.
   */
  campaign?: string;
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
    if (input.campaign) {
      fields['Campaign'] = input.campaign;
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
    // Update cap cache for this recipient. CRITICAL: increment in-memory
    // BEFORE Airtable read-after-write becomes visible, so a cron tick
    // that sends N emails to the same recipient sees count=1, 2, 3,
    // cap-exceeded — instead of N parallel sends all reading count=0
    // from a stale Airtable snapshot. PA5 audit (2026-05-28) found
    // rancher-followup cron bursting 9-11 sendRancherLeadReminder
    // emails to one rancher per tick because all checks fired before
    // any Airtable write became visible.
    //
    // Only bump on status='sent' or 'suppressed' (those count toward
    // delivery decisions). 'bounced'/'complained' come via webhook and
    // already had a 'sent' counted at original send time.
    const email = input.recipientEmail.toLowerCase();
    if (input.status === 'sent') {
      const cached = _countCache.get(email);
      const newCount = cached ? cached.count + 1 : 1;
      _countCache.set(email, { count: newCount, ts: Date.now() });
    } else if (input.status === 'suppressed') {
      // Suppressed sends don't count toward the cap (that would
      // self-reinforce suppression). But also don't invalidate the
      // cache — the count we read is still valid.
    } else {
      // bounced / complained — refresh from Airtable next call.
      _countCache.delete(email);
    }
  }
}

/**
 * Helper for callers that already have the recipient Consumer record id.
 * Returns the same shape as `checkFrequencyCap` but skips the Cron Pauses
 * lookup for transactional templates (perf).
 */
export function isTransactionalTemplate(templateName: string): boolean {
  if (TRANSACTIONAL_WHITELIST.has(templateName)) return true;
  return TRANSACTIONAL_WHITELIST_PREFIXES.some((p) => templateName.startsWith(p));
}
