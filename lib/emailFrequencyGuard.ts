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
  // ── CAP-EATEN MONEY EMAILS (2026-07-17, revenue-path audit) ──────────────
  // Live Email Sends data: 99 of the last 100 suppressions were 'cap-exceeded'
  // — NOT unsubscribes. The 3/week cap was silently eating the deposit ASK.
  //
  // deposit_request_nudge_1/2/mid: the buyer's rancher SENT them a deposit
  // request (or the quiz minted an invite) and they're expected to pay — this
  // is the money ask. 5 were cap-suppressed, which partly explains the
  // 16-requested → 6-opened → 1-paid funnel. SAFE to whitelist because the
  // throttle is DB-STATE, not a best-effort stamp: rail A stays capped at
  // DEPOSIT_NUDGE_LIFETIME_CAP=2 + 48h cooldown; rail B (P5′ 2026-08-08) is
  // bounded by lib/intentWindows' deposit-invite policy — hard lifetime cap
  // of 6 touches per referral, every gap >= 2 days, window+decay hard-ends at
  // day 21 — all read from 'Deposit Nudge Count'/'Deposit Nudge Last Sent At'
  // with claim-before-send, so whitelisting cannot create volume even if a
  // send fails.
  'deposit_request_nudge_1',
  'deposit_request_nudge_2',
  'deposit_request_nudge_mid',
  // NOT whitelisted (pressure audit 2026-07-17): still_looking_reconfirm and
  // sendRancherLeadReminder were ALSO cap-eaten (31 + 33 suppressed), but their
  // throttles are too weak to safely uncap:
  //   - still_looking_reconfirm: the 14-day 'Reconfirm Sent At' stamp is
  //     best-effort — its own code comment says a failed write "degrades to the
  //     old always-send." batch-approve re-pulls the same stale buyers DAILY,
  //     so whitelisting turns a stamp-write failure into an unbounded daily
  //     storm to the exact cohort whose email promises "no more nags."
  // These stay capped. The eaten-email leak for them needs a robust throttle
  // fix, not a blanket cap exemption (tracked in memory).
  // (sendRancherLeadReminder lived here too until 2026-07-28 — replaced by
  // sendRancherLeadDigest below, whose throttle IS per-recipient DB state.)
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
  // Rancher-expected one-shot Stripe Connect milestone ("bank connected —
  // deposits on"). Fires at most once per rancher (gated on the Connected At
  // stamp in the Connect webhook), so whitelisting cannot cause volume.
  'sendRancherBankConnected',
  // Downgrade twin of sendRancherBankConnected (Wave A 2026-07-14): Connect
  // flipped active→restricted/onboarding and the rancher must fix their
  // payout setup before deposits work again. Money-critical + one-shot per
  // downgrade edge (webhook fires it only on the wasActive transition,
  // deduped), so whitelisting cannot cause volume.
  'sendRancherConnectAttention',
  // Rancher-expected milestone: their held-for-review products were approved
  // and are live on /shop. Fired only from the operator /approvestore command,
  // which only targets rows with Marketplace Approved !== true — a re-run has
  // an empty target list, so whitelisting cannot cause volume.
  'sendRancherProductLive',
  // Daily per-rancher lead digest (audit 2026-07-28): ONE email listing all
  // Intro-Sent leads waiting 2+ days. Throttled by DB state — Ranchers.'Lead
  // Digest Sent At' is stamped BEFORE the send and checked per recipient, so
  // whitelisting cannot create volume (a failed stamp write suppresses the
  // next digest rather than multiplying it). Rancher silence drives 44% of
  // real losses; the cap was eating 90% of the old per-referral reminders.
  'sendRancherLeadDigest',
  'sendRancherSelfSubmitWelcome',
  'sendProspectClaimMagicLink',
  // The ONLY email persisting the 60-day wizard link for /apply + /partners
  // rancher signups — its copy says "Bookmark this email". A rancher who
  // already had 3 sends in 7 days (self-submit welcome + drips before
  // applying) was silently cap-suppressed: tab closed → link exists nowhere →
  // stall (audit 2026-07-21). One-shot per application, cannot create volume.
  'sendRancherApplyAutoApproved',
  // Customer-expected order confirmation after wholesale checkout.
  'sendWholesaleConfirmation',
  // Customer-expected confirmation that their brand listing is live.
  'sendBrandListingConfirmation',
  // Customer-expected payment failure notice — must reach the brand to retry.
  'sendBrandPaymentFailed',
  // Rancher twin of sendBrandPaymentFailed (dashboard-audit rank 7): a
  // paid-tier rancher's subscription card declined. One-shot per
  // invoice.payment_failed event; suppressing it makes churn invisible to
  // the rancher until Stripe cancels the plan.
  'sendRancherPaymentFailed',
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
  // Wave 2 (2026-07-29): buyer "your pickup/delivery is scheduled for {date}"
  // notice. Fires ONLY on a rancher schedule action — the fulfillment route
  // compares the persisted Handoff Date before vs after the write and skips
  // the send when the new date equals the stored date, so re-saves cannot
  // create volume. Suppressing it = buyer never learns their handoff date.
  'sendBuyerHandoffScheduled',
  // Customer-expected confirmation that partner application was received.
  'sendPartnerConfirmation',
  // Operator-expected internal alerts — capping these blinds the team.
  'sendAdminAlert',
  // Operator-expected inquiry alerts so admins can respond in-band.
  'sendInquiryAlertToAdmin',
  // Operator pre-call brief — lands in Ben's inbox the moment a buyer books
  // an Operator-tier sales call. Same argument as sendAdminAlert: a 1:1
  // once-per-booking internal notice that cannot create volume. Capping it
  // silently strands Ben on a blind sales call once he's already received a
  // few sends in the week (which he always has — every booking + alert routes
  // to the same inbox).
  'sendOperatorPreCallBrief',
  // Auth-critical: magic-link login. Capping this locks members out.
  'sendMagicLink',
  // Auth-critical: self-serve setup-link re-mint (wave B). For a pre-signed
  // rancher the setup token IS their only auth — capping this re-strands the
  // exact cohort the expired-link recovery exists for. Cadence is owned by
  // the endpoint's own 3/15m per-email + strict per-IP limiter.
  'sendRancherSetupLink',
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
  // Low-ticket PRODUCT rail parity (2026-07-06): the product buyer receipt +
  // the rancher ship-it email. Same argument as sendPostPurchaseWelcome /
  // sendRancherDepositPaid — one-shot per PI (settleProductPurchase is idempotent
  // via claimOnce + existing-order lookup), so whitelisting cannot create volume.
  // Without it, a buyer/rancher already at the 3/week cap silently loses the
  // "did my payment go through?" confirmation (buyer) or the ship-to + reply-with-
  // tracking email (rancher — the hands-off fulfillment leg the product rail needs).
  'product_receipt',
  'rancher_order_notify',
  // Phase 10 (2026-07-06): the tracking email the receipt promises. One-shot —
  // POST /api/rancher/orders rejects a second mark-shipped (409 Already), so
  // whitelisting cannot create volume. Without it a buyer at cap never learns
  // their beef shipped.
  'product_shipped',
  // Phase 11 (2026-07-06): monthly inventory digest to ranchers with listed
  // products — 1/rancher/month by cron schedule; operational, must not be
  // suppressed by the cap or inventory truth rots.
  'product_stock_checkin',
  // Reach lever #2 (2026-07-06): the lead-magnet guide the visitor explicitly
  // requested seconds ago — transactional delivery, one-shot per request,
  // rate-limited at the route. Suppressing it = a broken promise on first touch.
  'halfcow_guide',
  // Trust flywheel (2026-07-06): the post-delivery product review ask —
  // once-ever per order (claim-stamped 'Review Asked At' + submit-side 409),
  // so whitelisting cannot create volume.
  'product_review_ask',
  // Fulfillment-SLA chase (2026-07-14): one nudge EVER per order (stamped
  // 'SLA Nudged At' before a second could fire) — whitelisting cannot create
  // volume, and capping it would silently strand a paid unshipped order.
  'product_sla_nudge',
  // Buyer-side twin of product_sla_nudge (shop-chain audit 2026-08-01): the
  // SLA cron chased the rancher and rang the operator on a stale paid order
  // but never told the BUYER, whose money was the one sitting still. Silence
  // at day 6 is how a paid order becomes a chargeback.
  //
  // WHY THIS CANNOT CREATE VOLUME — the bar this whitelist sets (cf. the
  // still_looking_reconfirm note above, which is deliberately NOT whitelisted
  // because its throttle is a best-effort stamp):
  //   • throttle is DB STATE, not a counter: Rancher Orders 'Buyer Delay
  //     Notified At', one per order forever (slaDecisions sets notifyBuyer
  //     false the instant the stamp is non-blank);
  //   • it is CLAIM-BEFORE-SEND WITH READ-BACK: the cron writes the stamp,
  //     re-reads the row, and only sends if the stamp actually persisted. A
  //     failed write — or the field not existing yet — means ZERO mails, not
  //     one per run. That is the exact failure mode that disqualified
  //     still_looking_reconfirm, inverted;
  //   • the order leaves the eligible set as soon as it ships/refunds
  //     (Status='New' is a hard filter upstream).
  'buyer_order_delay',
  // SHARE-rail twin of buyer_order_delay (Wave 2 buyer-comms, 2026-08-01):
  // the deposit-accept-sla cron re-pinged the RANCHER and rang the operator
  // on an unaccepted paid deposit while the buyer — told "usually the same
  // day" — heard nothing, ever. One-shot per referral by construction: the
  // cron holds a Redis claimOnce (SET NX, ~1yr TTL) keyed on the referral
  // BEFORE the send, so re-runs cannot repeat it (Referrals has no free
  // stamp field; the Redis claim IS the throttle, same pattern as the
  // settlement rails). A buyer mid-deal trivially has 3+ sends this week
  // (welcome + invite + receipt), so without whitelisting the one honest
  // "your deposit is safe, we're on it" note is exactly the email the cap
  // eats.
  'buyer_deposit_delay',
  // Capture-point acks (Wave 2 buyer-comms, 2026-08-01). Three buyer capture
  // points Telegram'd the operator and told the BUYER nothing. Each ack is
  // 1:1, customer-expected seconds after their own submit, and throttled by
  // the route itself, so whitelisting cannot create volume:
  // /api/support/report — rate-limited 5/min/IP + honeypot; the /support page
  // promises a human reply, so the receipt must never be cap-eaten (a buyer
  // in distress already got order emails this week — that's the exact cohort
  // at cap).
  'support_report_ack',
  // /api/callback-request — the open-request guard returns early on a second
  // POST (one open request at a time), so at most one ack per request cycle.
  'callback_request_ack',
  // /api/inquiries — the pre-purchase question ack (existed since 2026-07-17
  // but rode the capped generic name; a buyer asking a ~$2k question right
  // after signup was silently unacknowledged). Route is rate-limited
  // 3/min + 10/hr per IP.
  'inquiry_buyer_ack',
  // Day-5 rail pair (Wave 2 buyer-comms, 2026-08-01 — the collision fix).
  // buyer-pulse and referral-chasup both fire ~day-5 after Intro Sent;
  // both used the capped generic 'sendEmail' name and stamped claim-before-
  // send, so the 3/week cap ate one and its stamp was burnt with nothing
  // delivered. Now each has its own name, cross-reads the other's stamp
  // before selecting, holds a Redis claimOnce, and stamps only AFTER
  // {success:true} — cadence is owned by DB state + the cross-read, not the
  // cap. buyer_pulse_check_in: once EVER per referral ('Buyer Pulse Sent
  // At'); buyer_chase_followup: max 3 per referral ('Chase Count'), 5-day
  // spacing ('Last Chased At').
  'buyer_pulse_check_in',
  'buyer_chase_followup',
  // Waitlist promise-keeper (Wave 2 buyer-comms, 2026-08-01): the "your area
  // opened" email the waitlist capture promised. Once EVER per buyer — the
  // state-coverage-notify cron holds a Redis claimOnce per consumer before
  // sending and is env-gated (STATE_COVERAGE_NOTIFY_ENABLED) + capped
  // 50/run. This is the single email these buyers signed up to receive;
  // cap-eating it breaks the only promise we made them.
  'state_coverage_opened',
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
  'buyer_refund_notice',
  // Rancher twin of buyer_refund_notice (Wave A 2026-07-14): the STOP-SHIP
  // notice when a product order is refunded/charged back. Money-critical —
  // suppressing it means the rancher ships a box whose funds were already
  // pulled from their Connect account. One-shot per PI (reconcile's
  // Refunded early-return), so whitelisting cannot cause volume.
  'sendRancherStopShip',
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
  // Deposit-paid's sibling (2026-07-14): rancher "final balance paid — deal
  // fully paid" alert from settleFinalInvoice. One-shot per deal (Closed-Won
  // early-return + claimOnce upstream), and a rancher mid-deal trivially
  // exceeds 3 emails/week — capping would swallow their payday confirmation.
  'sendRancherFinalPaid',
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
  // Wave C (2026-07-14) — no-silent-lifecycle notices. Each fires at most
  // once per real lifecycle event (admin action / Stripe webhook), so the
  // 3/week cap can only ever suppress a legitimate, rancher-critical notice:
  // Admin paused new-lead routing — the pause also mutes the other email
  // rails (followup/reactivation exclude Paused), so THIS mail is the only
  // way a non-logging-in rancher learns their lead flow stopped.
  'sendRancherPauseNotice',
  // Full deposit refund reverted a deal — funds were pulled back from the
  // rancher's Connect balance and the deal left every dashboard bucket;
  // suppressing this means they keep working a dead deal.
  'deposit_refunded_rancher',
  // Chargeback on the rancher's OWN connected account — the evidence window
  // is ticking and the winning evidence (tracking/photos/texts) lives with
  // the rancher. One send per dispute lifecycle event (created/closed).
  'sendRancherDispute',
  // Tier subscription terminally cancelled — routing + deposits shut off
  // instantly; the dunning mails promised the plan 'keeps from lapsing',
  // so the lapse itself must not land silently.
  'sendRancherSubscriptionEnded',
  // Pickup-order completion note to the buyer (sibling of the whitelisted
  // product_shipped) — 1:1, customer-expected, fires once per order.
  'product_picked_up',
  // Post-signature confirmations from /api/ranchers/sign-agreement (audit
  // 2026-07-21): the "You're LIVE" / "Agreement Signed — You're Almost Live"
  // emails previously rode the generic capped 'sendEmail' template — a
  // self-submit rancher signing after welcome + Day-2 + Day-5 drips had the
  // confirmation (and its 14-day dashboard login link) silently eaten at the
  // finish line. One-shot per signing event — the route 400s a second sign
  // (Agreement Signed already true) — so whitelisting cannot create volume.
  'sendRancherSignedLive',
  'sendRancherSignedAlmostLive',
  // Waiting-activation rail (2026-07-22 audit): both nudges stamp CLAIM-
  // BEFORE-SEND on Consumers (Waiting/Ready Nudge Last Sent At + Count:
  // 14d cooldown, 3 lifetime), so a cap-suppress burned one of the buyer's
  // 3 lifetime touches with nothing delivered — three collisions with the
  // live nurture-drip and the buyer permanently exited the reactivation
  // pool having received ZERO nudges. The cron's DB-state throttle is
  // stronger than the generic 3/week cap (same argument as the whitelisted
  // reserveRecoveryEmail / sendRancherFulfillmentNudge stamp-before-send
  // rails), so the campaign engine — not the frequency guard — owns cadence.
  'sendWaitingActivationNudge',
  'sendReadyChaseNudge',
  // BROKER RAIL settlement pair (2026-07-31, docs/BUSINESS-MODEL.md model 3).
  // Both are ONE-SHOT PER ORDER by construction, not by a best-effort stamp:
  // lib/brokerSettlement sends them strictly AFTER the markDepositSucceeded
  // idempotency anchor, which no-ops once the Payments row is 'succeeded'. A
  // Stripe redelivery therefore returns before either send is reached, so
  // whitelisting cannot create volume no matter how many times Stripe retries.
  //
  // Why they must not be capped: on this rail the rancher is OFF-PLATFORM —
  // no login, no dashboard, no app. `broker_rancher_order` is the ONLY place
  // the order exists for him (buyer contact details, the cut, and the exact
  // balance to collect). Suppressing it means a paid buyer is never contacted
  // and the rancher never collects. `broker_buyer_receipt` is the buyer's only
  // proof of payment and the only statement of what they still owe the ranch —
  // the "did my payment go through?" email, on a charge with no other paper.
  'broker_rancher_order',
  'broker_buyer_receipt',
  // Signup confirmation restating the commission agreement the rancher just
  // accepted on /partner/represent. One per signup (the route dedupes by
  // email), and it is the rancher's only written copy of the money terms.
  'broker_represent_confirmation',
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

// Per-template pause-check memo (2026-07-22 audit): the Cron Pauses read ran
// on EVERY send — a 50-buyer cron run (or 400-recipient broadcast tick) paid
// N identical uncached Airtable round-trips against the shared base's 5 req/s
// ceiling. 60s TTL: an operator's /pausemail still bites within a minute
// (the emergency stop stays fast), while a batch run reads once per template.
const _pauseCache: Map<string, { paused: boolean; ts: number }> = new Map();

async function isTemplatePaused(templateName: string): Promise<boolean> {
  const cached = _pauseCache.get(templateName);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.paused;
  try {
    const pauses = await getAllRecords(
      TABLES.CRON_PAUSES,
      `AND({Name}="${escapeAirtableValue(templateName)}", {Paused}=TRUE())`,
    ) as any[];
    const paused = pauses.length > 0;
    _pauseCache.set(templateName, { paused, ts: Date.now() });
    return paused;
  } catch (e: any) {
    // Don't let pause-table read error block a send. Log + proceed.
    console.warn(`[freqGuard] pause check failed for ${templateName}:`, e?.message);
    return false;
  }
}

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
  // `/pausemail <template>` can halt even a transactional template when it's
  // misbehaving. Emergency stop must always win; the 60s memo keeps it to one
  // read per template per minute under batch load.
  if (await isTemplatePaused(templateName)) {
    return { ok: false, reason: 'paused', weekCount: 0, cap };
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
 * Pure: count Email Sends rows per lowercased recipient email. Exported for
 * unit tests; used by primeFrequencyCapCache.
 */
export function countSendsByEmail(
  records: Array<Record<string, unknown>>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of records) {
    const email = String(r['Recipient Email'] || '').trim().toLowerCase();
    if (!email) continue;
    counts.set(email, (counts.get(email) || 0) + 1);
  }
  return counts;
}

/**
 * Batch-prime the frequency-cap cache for a whole recipient set with ONE
 * Email Sends read. Scale audit 2026-07-22: a campaign of unique recipients
 * never hits the per-recipient 60s cache, so each send paid its own Airtable
 * count read (~1 req/email against the 5 req/s base cap). Call this once per
 * cron run before the send loop; per-recipient checkFrequencyCap calls then
 * hit the primed cache. Best-effort: on read failure the per-recipient path
 * (with its own fail-open) still runs.
 */
export async function primeFrequencyCapCache(recipientEmails: string[]): Promise<boolean> {
  if (recipientEmails.length === 0) return true;
  try {
    const sinceISO = new Date(Date.now() - SEVEN_DAYS_MS).toISOString();
    const records = await getAllRecords(
      TABLES.EMAIL_SENDS,
      `AND({Sent At} > "${sinceISO}", {Status}="sent")`,
    ) as any[];
    const counts = countSendsByEmail(records);
    const ts = Date.now();
    for (const email of recipientEmails) {
      const e = email.trim().toLowerCase();
      if (!e) continue;
      _countCache.set(e, { count: counts.get(e) || 0, ts });
    }
    return true;
  } catch (e: any) {
    console.warn(`[freqGuard] batch cap prime failed (falling back to per-recipient reads):`, e?.message);
    return false;
  }
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
  // 'failed' (2026-07-14): the Resend SDK resolves API errors as { error }
  // instead of throwing — a dead key used to be logged as 'sent', poisoning
  // the audit log while every email died. Failed sends must log as failed.
  status: 'sent' | 'suppressed' | 'bounced' | 'complained' | 'failed';
  suppressionReason?: string;
  /**
   * Optional campaign name. When present, written to the Email Sends
   * `Campaign` field so the campaign console can tie engagement
   * (delivered/opened/clicked) back to the originating Campaigns row.
   * Left unset for transactional/one-off sends — backward-compatible.
   */
  campaign?: string;
  /**
   * The Resend send id (result.data.id) — ADAPTIVE-MARKETING-DESIGN PR 1.
   * Written to `Resend Id` so the engagement webhook can attribute
   * delivered/opened/clicked events to the EXACT row instead of the
   * latest-row-within-7d heuristic. Only guardedSend's sent path has one.
   */
  resendId?: string;
  /**
   * Subject-variant letter actually sent ('A' | 'B') — written to `Variant`
   * so the gated learning report can join sends → outcomes. Campaign rail
   * only; unset everywhere else.
   */
  variant?: string;
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
    // Both fields may not exist on the table yet — createRecord auto-strips
    // unknown fields (with a deduped operator alert naming the field), so a
    // missing column can never fail the audit-log write, let alone the send.
    if (input.resendId) {
      fields['Resend Id'] = input.resendId;
    }
    if (input.variant) {
      fields['Variant'] = input.variant;
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
    // Scale audit 2026-07-22: during a 429 storm this write fails silently
    // and every unlogged send undercounts the rolling 7-day cap denominator
    // for a week. Deduped operator signal (same pattern as the unknown-field
    // strip alert in lib/airtable.ts) so the operator SEES the truth log rot.
    try {
      const { sendOperatorSignal } = await import('./operatorSignal');
      await sendOperatorSignal({
        urgency: 'normal',
        kind: 'system-error',
        summary: 'Email Sends log write FAILED — send-truth log rotting',
        detail:
          `logEmailSend for ${input.templateName} → ${input.recipientEmail} failed: ` +
          `${e?.message || e}. Sends are going out UNLOGGED — frequency-cap counts ` +
          `and campaign dedupe undercount until this clears (likely Airtable 429 storm).`,
        dedupeKey: 'email-sends-log-write-failure',
        dedupeWindowMs: 30 * 60 * 1000,
      });
    } catch {}
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
