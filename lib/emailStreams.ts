// ─────────────────────────────────────────────────────────────────────
// EMAIL STREAMS (P2.5, marketing revamp 2026-08 — docs/MARKETING-REVAMP-2026-08.md §5 Track 2)
//
// Every outbound email belongs to exactly one STREAM, and the stream picks
// the From-domain:
//
//   transactional → the apex domain (money mail, receipts, auth, deal comms,
//                   operator/admin internals). First SEND_DOMAINS entry,
//                   default buyhalfcow.com.
//   marketing     → MARKETING_SEND_DOMAIN env (e.g. updates.buyhalfcow.com
//                   once Ben verifies it in Resend — DKIM first, DMARC is
//                   sp=quarantine so an unverified subdomain send quarantines
//                   day one). Falls back to the apex until the env is set, so
//                   shipping this map changed NOTHING about live sends — the
//                   DNS flip is config, not code.
//
// This replaces the old SEND_DOMAINS round-robin in lib/email.ts, which
// rotated EVERY send (deposit invoices included) across all configured
// domains — flagged by the 2026-08-08 deliverability panel as reputation
// cross-contamination the day a marketing subdomain exists.
//
// CLASSIFICATION RULES (panel-set):
//   money / receipts / auth / deal-progress / operator internals / welcome
//     → transactional
//   nurture / nudge / digest / campaign / reconfirm / reactivation / letters
//     → marketing
//   FAIL-SAFE: a template with NO entry resolves 'transactional'. The error
//   direction is one-way by design — money mail can never accidentally ride
//   the marketing domain; an unclassified marketing sender merely stays on
//   the apex (today's behavior) until someone adds it here.
//
// Template names are the exact strings passed to guardedSend (lib/email.ts)
// — the same strings logged to Email Sends — covering every sender in
// lib/email.ts and lib/emailMinimal.ts, plus the marketing lanes that ride
// the generic sendEmail() from cron/campaign routes.
// ─────────────────────────────────────────────────────────────────────

export type EmailStream = 'transactional' | 'marketing';

// Marketing lanes: pressure/engagement mail. These are the sends that (a)
// migrate to MARKETING_SEND_DOMAIN when Ben flips it and (b) ALWAYS carry
// List-Unsubscribe + one-click headers (injected centrally in lib/email.ts).
export const MARKETING_TEMPLATES: readonly string[] = [
  // Buyer nurture / education (email-sequences + nurture-drip crons)
  'sendNurtureCheckIn',
  'sendNurtureEducation',
  'sendNurtureLongHaul',
  'sendNurtureShopBridge',
  'sendCutsEducation',
  // Buyer nudges / chases / reconfirms
  'sendIncompleteProfileAsk',
  'sendWaitingActivationNudge',
  'sendReadyChaseNudge',
  'sendNudgeToEngage',
  'sendMatchNowRescue',
  'sendWarmLeadReadyCheck',
  'sendAbandonedQuizNudge',
  'still_looking_reconfirm',
  'buyer_ready_nudge',
  'sendBackfillEmail',
  'sendOrphanCheckoutRewarm',
  'sendAbandonedRecoveryEmail',
  // Loss-recovery / winback
  'sendLossRecoveryDownsell',
  'sendLossRecoveryReengage',
  // Post-purchase lifecycle marketing (replenishment/upsell/review asks)
  'sendReplenishmentNudge',
  'sendRepeatPurchaseAsk',
  'sendTestimonialAsk',
  'sendPilotUpsellEmail',
  'sendMerchEmail',
  // Letters / digests / waitlist
  'sendFounderLetterWaiting',
  'sendBackerMonthlyLetter',
  'sendClosedMonthlyLetter',
  'sendStateWaitlistLetter',
  'sendWaitlistEmail',
  'state_coverage_opened',
  'sendRancherLaunchWarmup',
  'sendRancherLaunchWarmupNudge',
  'sendNoBudgetFounderPitch',
  // Campaign machine
  'sendBroadcastEmail',
  'demandRouterMsg1',
  'demandRouterMsg2',
  'demandRouterMsg3',
  'shop_drop_announce',
  // Rancher-side campaign/reconfirm mail (dormant-rancher reactivation,
  // pipeline check-ins, onboarding drip cadence)
  'sendRancherReactivationWarm',
  'sendRancherReactivationCold',
  'sendRancherCheckIn',
  'sendRancherOnboardingDripDay2',
  'sendRancherOnboardingDripDay5',
  'sendRancherOnboardingDripDay14',
];

// Transactional: money, receipts, auth, deal progress, confirmations the
// recipient is actively waiting on, and operator/admin internals. This list
// is documentation-of-intent — an entry here behaves identically to no entry
// (the resolver default) but records that the template was READ and
// deliberately classified, not forgotten.
export const TRANSACTIONAL_TEMPLATES: readonly string[] = [
  // Generic default name (callers of sendEmail() that pass no templateName)
  'sendEmail',
  // Auth / magic links
  'sendMagicLink',
  'sendAffiliateLoginLink',
  'sendProspectClaimMagicLink',
  'sendQuizResendLink',
  // Money: invoices, deposits, receipts, dunning, settlement
  'sendBuyerFinalInvoice',
  'sendInstantCommissionInvoice',
  'sendMonthlyCommissionInvoice',
  'sendPostPurchaseWelcome',
  'buyer_deposit_invoice',
  'deposit_request_nudge_1',
  'deposit_request_nudge_2',
  'quiz_complete_cal_invite',
  'quiz_complete_deposit_invite',
  'buyer_refund_notice',
  'buyer_order_delay',
  'buyer_deposit_delay',
  'sendRancherStopShip',
  'sendRancherDepositPaid',
  'sendRancherFinalPaid',
  'sendRancherPaymentFailed',
  'sendBrandPaymentFailed',
  'sendRenewalReminder',
  'broker_rancher_order',
  'broker_buyer_receipt',
  'broker_represent_confirmation',
  // Deal progress / fulfillment / tracking
  'sendBuyerIntroNotification',
  'sendBuyerFulfillmentConfirmation',
  'sendBuyerShippingNotification',
  'sendBuyerHandoffScheduled',
  'sendMatchedDay4CheckIn',
  'sendRerouteNotification',
  'sendInquiryToRancher',
  'sendTrackedContactEmail',
  'sendRancherFulfillmentNudge',
  'sendRancherLeadNudge',
  'sendRancherLeadDigest',
  // Signup / onboarding confirmations the recipient is waiting on
  'sendConsumerConfirmation',
  'sendConsumerApproval',
  'sendWelcomeAndReadyToBuy',
  'sendQuizInvite',
  'sendFoundingHerdWelcome',
  'sendPartnerConfirmation',
  'sendWholesaleConfirmation',
  'sendBrandListingConfirmation',
  'sendAffiliateInvite',
  'sendAffiliateWelcome',
  // Rancher front-door / lifecycle ops (the Vale Creek rescue class)
  'sendRancherApplyAutoApproved',
  'sendRancherSelfSubmitWelcome',
  'sendRancherSetupLink',
  'sendRancherApproval',
  'sendRancherGoLiveEmail',
  'sendRancherBankConnected',
  'sendRancherConnectAttention',
  'sendRancherProductLive',
  'sendRancherCommunityIntro',
  'sendPipelineUpdateEmail',
  // Buyer capture-point acks
  'support_report_ack',
  'callback_request_ack',
  // Operator / admin internals (the deliberately header-less senders)
  'sendAdminAlert',
  'sendInquiryAlertToAdmin',
  'sendOperatorPreCallBrief',
];

// Dynamic-name marketing templates matched by prefix (e.g. the requalify
// campaign sender logs `campaign_<name>` per campaign).
export const MARKETING_TEMPLATE_PREFIXES: readonly string[] = ['campaign_'];

function buildStreamMap(): Readonly<Record<string, EmailStream>> {
  const map: Record<string, EmailStream> = {};
  for (const t of TRANSACTIONAL_TEMPLATES) map[t] = 'transactional';
  for (const t of MARKETING_TEMPLATES) map[t] = 'marketing';
  return Object.freeze(map);
}

export const EMAIL_STREAM_BY_TEMPLATE: Readonly<Record<string, EmailStream>> = buildStreamMap();

/**
 * Resolve the stream for a template name. FAIL-SAFE: unknown, blank, or
 * missing names resolve 'transactional' — a sender must be explicitly
 * classified marketing before its mail can leave the apex domain.
 */
export function resolveEmailStream(templateName?: string | null): EmailStream {
  const name = String(templateName ?? '').trim();
  if (!name) return 'transactional';
  const mapped = EMAIL_STREAM_BY_TEMPLATE[name];
  if (mapped) return mapped;
  if (MARKETING_TEMPLATE_PREFIXES.some((p) => name.startsWith(p))) return 'marketing';
  return 'transactional';
}

/**
 * Per-stream From-domain. The old round-robin is dead: same stream, same
 * domain, every call.
 *
 *   transactional → first SEND_DOMAINS entry (default buyhalfcow.com)
 *   marketing     → MARKETING_SEND_DOMAIN, else the transactional apex
 *
 * `env` is injectable for tests; production callers use process.env.
 */
export function sendDomainForStream(
  stream: EmailStream,
  env: Record<string, string | undefined> = process.env,
): string {
  const apex =
    String(env.SEND_DOMAINS || 'buyhalfcow.com').split(',')[0]?.trim() || 'buyhalfcow.com';
  if (stream === 'marketing') {
    const marketing = String(env.MARKETING_SEND_DOMAIN || '').trim();
    if (marketing) return marketing;
  }
  return apex;
}

/**
 * Centralized List-Unsubscribe policy (panel finding: headers were
 * per-caller opt-in while the CAN-SPAM footer was centrally injected — a
 * future sender could silently ship marketing mail without them; 84 of 88
 * call sites carried them by hand).
 *
 *   marketing     → guaranteed to carry List-Unsubscribe AND
 *                   List-Unsubscribe-Post (RFC 8058 one-click). Missing
 *                   headers are minted via `buildUnsubscribeHeaders` — the
 *                   caller passes lib/email.ts's existing JWT builder, so the
 *                   one-click URL generation is reused, never duplicated.
 *                   Caller-passed values win on conflict.
 *   transactional → untouched. Callers keep their explicit headers (or their
 *                   deliberate absence — admin alerts, operator briefs).
 *
 * Pure so the policy is unit-testable without touching the Resend wrapper.
 */
export function ensureListUnsubscribeHeaders(
  stream: EmailStream,
  existing: Record<string, string> | undefined,
  buildUnsubscribeHeaders: () => Record<string, string>,
): Record<string, string> | undefined {
  if (stream !== 'marketing') return existing;
  const keys = Object.keys(existing || {}).map((k) => k.toLowerCase());
  const hasUnsub = keys.includes('list-unsubscribe');
  const hasOneClick = keys.includes('list-unsubscribe-post');
  if (hasUnsub && hasOneClick) return existing;
  // Merge case-safely: only add built headers whose (case-insensitive) name
  // the caller didn't already set — never emit the same header twice.
  const merged: Record<string, string> = { ...(existing || {}) };
  for (const [name, value] of Object.entries(buildUnsubscribeHeaders())) {
    if (!keys.includes(name.toLowerCase())) merged[name] = value;
  }
  return merged;
}
