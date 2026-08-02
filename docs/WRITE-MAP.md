# WRITE-MAP — who writes (and gates on) every critical Airtable field

**Generated 2026-07-28** from a full-repo audit of `main`. Tables covered: Referrals,
Ranchers, Consumers, Payments, Stripe Events, Rancher Orders, Rancher Products.

> **Update 2026-08-01:** all `lib/capacityLiberator.ts` reader references were
> removed from this map — the capacity-liberator cron and its lib were deleted
> in #506 and no longer exist in the repo.

> **RULE ZERO: verify against code before trusting — this doc can drift.**
> It is a map, not the territory. Before diagnosing off any entry here, re-run the
> grep for that field and read the writer. A blank field usually means NOTHING WRITES
> IT, not that the event didn't happen (repo rule #1 — this doc exists because guessing
> writers caused 5 wrong diagnoses in one night).

**Regeneration hint** — per field `F` on table `T`:

```bash
grep -rn "'F'" lib app scripts tools --include='*.ts' --include='*.tsx' --include='*.mjs'
# writers = hits inside createRecord/updateRecord payloads; readers = everything else.
# Table names: lib/airtable.ts TABLES const (line 26). Schema truth:
curl -s -H "Authorization: Bearer $AIRTABLE_API_KEY" \
  "https://api.airtable.com/v0/meta/bases/appgLT4z009iwAfhs/tables"
```

Block format: `W:` = writers (file:line — when it fires). `R:` = readers that make
DECISIONS on the value (gates/crons/routing — display readers omitted). `Sem:` =
semantics + landmines. Paths relative to repo root.

---

## Referrals (`tblBfimb4Gt8C0fu4`) — the deal system-of-record

**Canonical read projection**: `REFERRAL_DASHBOARD_FIELDS` (lib/referralReads.ts:35-58),
used by `readReferrals()` (:65) and `fetchReferralRowsForRancher()` (:88 — every rancher
surface: dashboard, customers, earnings CSV, quick-action, referral-detail). Fields
MISSING from the projection (readers through it see blank): Commission Paid At, Approval
Status, Close Class, Loss Reason, Match Type, Rancher/Suggested Rancher Record Id, State
Allocation, Deposit Checkout URL, **Final Paid Amount**, **Payment Confirmed At**, Last
Chased At, Stalled Alert Sent At.
Deal state machine stamp map: lib/deal/states.ts:47-52 (INTRO_SENT→Intro Sent At,
SLOT_LOCKED→Rancher Accepted At, CLOSED_WON→Closed At); generic writer
lib/deal/transitionLive.ts:67. The refund path (lib/refundLifecycle.ts:30-47, applied
lib/contracts/payments.ts:780) is the ONLY path that NULLS money fields: Closed At, Sale
Amount, Commission Due, Deposit Paid At, Rancher Accepted At — it does NOT clear Deposit
Requested At / Total Sale Amount / Final Invoice fields.
Typecast landmine: several written values are NOT in the schema's singleSelect choices
(created via typecast): Status 'Refunded'/'Lost', Approval Status 'admin-approved',
Match Type 'Direct (Rancher Page) — Deposit'/'Manual'.

### Status (singleSelect)
W (by value): create 'Pending Approval' — app/api/matching/suggest/route.ts:1285, app/api/warmup/engage/route.ts:106; create 'Pending' — app/api/orders/request/route.ts:265, lib/reserveDeposit.ts:213; 'Intro Sent' — app/api/referrals/[id]/approve/route.ts:57, suggest :1425 (auto-approve, rollback :1618), lib/bulkRoute.ts:238,267, reassign :129, telegram :819-838,976,1250-1257,5740-5743, email-sequences :471; 'Rancher Contacted' — contact route :112; **'Awaiting Payment'** — request-deposit :215 (PRE-payment), send-deposit-invoice :140,155 (PRE-payment), send-final-invoice :362 (PRE-final), lib/stripeSettlement.ts:145 (POST-deposit-payment), lib/contracts/rancher.ts:63, telegram :3549; 'Slot Locked' — accept :141-153; 'Closed Won' — lib/contracts/rancher.ts:61 recordClose, rancher PATCH, telegram :3621; 'Closed Lost' — close paths + crons referral-chasup :200,618, stuck-referral-reaper :207, telegram :1102,1722,3056,3421-3425; 'Dormant' — referral-stale-expiry :139; 'Refunded' — lib/refundLifecycle.ts:36 (typecast).
R: lib/capacityCount.ts:14-19 HELD_REFERRAL_STATUSES {Intro Sent, Rancher Contacted, Negotiation, Awaiting Payment, Slot Locked} — capacity counting :56 + isActiveDealReferral :36-45; lib/cronReadFilters.ts:32,45-48 — cron formula builders; lib/depositPaidState.ts:46-51; lib/refundLifecycle.ts:86 canSendFinalInvoice; final-invoice-dunning :130-132 (only 'Awaiting Payment' dunnable); close-detector :71-73; suggest :350 (Closed Lost + loss reason blocks re-pair).
Sem: LANDMINE — 'Awaiting Payment' is OVERLOADED: written both pre-payment (request/invoice) and post-payment (settlement). Disambiguator = {Deposit Requested At set, Deposit Paid At empty} = payable (lib/depositPaidState.ts:5-31 — the 2026-07-14 bricked-buyer bug). Pre-payment writers MUST stamp Deposit Requested At.
Sem (NO-DEAD-ENDS, 2026-07-30): 'Dormant' is now written by THREE tiers of referral-stale-expiry, all sharing one FLIP→RESTORE-buyer→RESYNC-counters loop. Tier 1 stale capacity holds (lib/staleHolds CAPACITY_HOLD_EXPIRABLE_STATUSES, unchanged). Tier 2 'Pending Approval' silent >⅓×base (7d) — frees NO capacity slot (pre-INCR) but frees the BUYER, who isActiveDealReferral had frozen out of the marketplace indefinitely. Tier 3 unpaid deposit release (lib/depositRelease) — the ONLY rail permitted to end an 'Awaiting Payment' row, and only after proving no payment exists. Tiers 2+3 are gated by `DEAL_RELEASE_ENABLED` (default DRY: selected + reported, zero writes). Every tier honors `Hold Until` (new — lib/referralHold; the ⏸️ Hold button targets exactly the Pending Approval cohort) and the 'rancher-added' My-Leads carve-out.

### Sale Amount (currency)
W: lib/contracts/rancher.ts:72 buildRecordCloseUpdates on 'won' (recordClose :89 — settleFinalInvoice, quick-action, confirm-payment); app/api/rancher/referrals/[id]/route.ts:702 — dashboard close; quick-action :262; confirm-payment :148 (fallback); admin PATCH app/api/referrals/[id]/route.ts:75 (:142 undo); telegram :3624 (operator replies $ to close prompt); lib/refundLifecycle.ts:38 — NULLED on full refund; inquiries :98 + wholesale signup :197 (created 0).
R: lib/replenishment.ts:75; lib/salesMetrics.ts:49; lib/testimonials.ts:77 + stats/public :134 (social proof >0); commission-invoices :117.
Sem: the REALIZED close amount, stamped at close. Guard: rancher PATCH :690-700 rejects edits on already-Closed-Won rows.

### Total Sale Amount (currency)
W: request-deposit :218; send-deposit-invoice :143,160; send-final-invoice :359 (refreshed).
R: lib/stripeSettlement.ts:485 — settleFinalInvoice computes closeSaleAmount = Total Sale Amount || (deposit + final) → becomes Sale Amount at Closed Won; final-invoice-dunning :307; deposit-link-refresh :76; app/api/member/content — projected as total_sale_amount for the buyer's "Your money" summary (Wave 3, display only).
Sem: LANDMINE vs Sale Amount — this is the QUOTED full price stamped at deposit-request time; Sale Amount is the realized close amount. They differ when price changes mid-deal, and Total Sale Amount exists on never-closed rows.

### Deposit Amount (currency)
W: request-deposit :217; send-deposit-invoice :142,159; lib/stripeSettlement.ts:146 — re-stamped with actual paid deposit at settle; orphan-checkout-reaper :581 — heal from ledger.
R: checkout/deposit :268 (durable pay page quote); lib/staleHolds.ts:109 (>0 blocks release); send-final-invoice :165 (balance math); app/api/member/content — deposit_amount; Wave 3 renders it AFTER payment too (it used to appear only on the pre-pay CTA).

### Deposit Paid At (dateTime) — THE rail discriminator
W: lib/stripeSettlement.ts:147 — settleBuyerDeposit on payment_intent.succeeded (both webhooks); **lib/brokerSettlement.ts settleBrokerDeposit — BROKER rail, platform webhook only**; orphan-checkout-reaper :580 — daily auto-restamp from Payments ledger; lib/refundLifecycle.ts:44 — nulled on full refund.
Sem (BROKER, 2026-07-31): `referralRail()` reads a stamped value as 'tier_v2' (Connect). A broker row is stamped too, so it is ALSO classified tier_v2 — which is the CORRECT outcome for the two things that classification drives: `partitionUnpaidByRail` must NOT raise a legacy commission invoice against a represented rancher (BHC already holds 100% of its fee), and `netEarningsFor` must not deduct a commission from him. Do not "fix" this into a third branch without re-reading both call sites.
R: lib/commission.ts:191-195 referralRail() — stamped ⇒ Connect, blank ⇒ legacy; lib/depositPaidState.ts:43; lib/confirmPaymentGuard.ts:31 (blocks manual confirm while pending); lib/refundLifecycle.ts:86 canSendFinalInvoice (gates send-final-invoice :158 + /r/f :79); accept :111 (accept requires it); lib/staleHolds.ts:108; lib/reserveRecovery.ts:111; lib/depositWatchdog.ts:84; lib/depositRequestNudge.ts:71,141; lib/noActionNudge.ts:62; lib/fulfillmentChase.ts:112; resend-inbound :783 (NRD-6 auto-accept).
Sem: money-truth stamp; blank genuinely = no Stripe deposit ever settled (reaper is the belt). A failed write fires a LOUD operator signal (stripeSettlement.ts:151-190).

### BHC Fee Cents (number) + Fee Captured At (dateTime) — referral-level fee truth
W: lib/stripeSettlement.ts:191-192 — settleBuyerDeposit stamps the Connect `application_fee` captured at deposit (the ONLY Connect writer; the final invoice takes 0 fee by design). **lib/brokerSettlement.ts — BROKER rail stamps the ENTIRE deposit here.**
R: revenue/scorecard reporting.
Sem: **THE broker-rail money marker.** On Connect these are a slice of the charge (10% on top of the deposit). On the BROKER rail BHC keeps 100% of the charge, so `BHC Fee Cents === Deposit Amount × 100` — that equality IS the persisted signal that the money is BHC's and that NOTHING is owed onward to the rancher. 0 is a valid Connect value (missing metadata / legacy sessions); on a broker row it would be a bug.

### Deposit Requested At (dateTime) — LOAD-BEARING
W: request-deposit :220; send-deposit-invoice :144,161. NOT nulled on refund.
R: lib/confirmPaymentGuard.ts:30-33 — flips depositPaidState to PAYABLE + blocks manual confirm; lib/depositWatchdog.ts:64-68 — watchdog age anchor; lib/depositRequestNudge.ts:69,103,138; lib/staleHolds.ts:108; app/api/member/content — projected as deposit_requested_at so lib/buyerDealStage can run the SAME isDepositAlreadyPaid disambiguator on the buyer's own ladder (Wave 3).
Sem: a Status='Awaiting Payment' row WITHOUT it reads as already-paid to the deposit page — a pre-payment writer that skips it bricks the buyer (send-deposit-invoice :127-133).

### Deposit Checkout URL (url)
W: request-deposit :219 — durable /r/p link; deposit-link-refresh cron :95 — replaces raw checkout.stripe.com URLs with durable mints.
R: request-deposit :140 — idempotent resend; deposit-link-refresh :10 — selects rows still pointing at checkout.stripe.com.
Sem: must NEVER stay a raw Stripe URL (24h expiry); the cron is the self-heal. NOT in the dashboard projection.

### Final Invoice Amount / Final Invoice Sent At / Final Invoice URL
W: send-final-invoice :353/:352 (+ URL alongside). Only writer.
R: app/r/f/[token]/route.ts:83 — durable link re-mints checkout at this amount, :72 blocks re-pay when Final Paid At set; final-invoice-dunning :125-135 isDunningEligible (Sent At = age origin, live URL + Status='Awaiting Payment' required), :306,486; app/api/member/content — all three projected (final_invoice_amount / final_invoice_sent_at / final_invoice_url) for the buyer's priced Pay-final-balance CTA (Wave 3).
Sem (Wave 3): send-final-invoice ALSO flips Status back to 'Awaiting Payment' (:362). /member used to gate its Pay-final-invoice button on `Status === 'Slot Locked'`, which that flip makes false for every billed row — the button was unreachable for exactly the buyers who needed it. Gate on the invoice fields, never on Status.

### Final Paid At / Final Paid Amount
W: lib/stripeSettlement.ts:495/:496 — settleFinalInvoice (webhooks stripe :335, stripe-connect :496). Only writers.
R: Final Paid At — /r/f :72 (re-pay block); lib/buyerDealStage.ts (balance step done) via app/api/member/content final_paid_at. Final Paid Amount — NO production reader (audit trail only; also missing from the dashboard projection).

### Commission Due (currency) — legacy-rail-only (mostly)
W: admin close app/api/referrals/[id]/route.ts:101 — RAIL-GATED by shouldWriteLegacyCommissionDue (:100; lib/commission.ts:247-249); rancher dashboard close :709,711 — NOT rail-gated (writes even on tier_v2; neutralized by the cron stamp; invoice fire skips tier_v2 :844); quick-action :263; confirm-payment :134,149; telegram :3625; adjust-commission :40; lib/refundLifecycle.ts:39 — nulled on refund.
R: commission-invoices :118,123 — monthly invoices; lib/commissionStats.ts:61,73 (legacy-rail-filtered :49).
Sem: LANDMINE — Connect settlement paths NEVER write it (fee was skimmed at deposit), but rancher close paths still do on deposit-rail rows; partitionUnpaidByRail (lib/commission.ts:219) makes the cron stamp those Paid instead of invoicing. Never treat Commission Due on a Connect row as receivable.

### Commission Paid (checkbox) + Commission Paid At (dateTime)
W: commission-invoices cron :60-61 — auto-true on deposit-rail rows; app/api/webhooks/stripe/route.ts:1481-1482 — invoice.paid; telegram :1507-1508 — "mark paid" button (guard :1502); admin PATCH :112.
R: commission-invoices unpaid filter; lib/commissionStats.ts:60; admin referrals/stats :86; rancher dashboard :35.
Sem: Paid At always rides with Paid; Paid At has no decision reader and is NOT in the projection.

### Approved At (singleLineText — NOT dateTime)
W: approve route :59; suggest :1427 (auto-approve); lib/bulkRoute.ts:245,284; reassign :134; manual-create :56; telegram :827,979,1256 (approve buttons); **telegram :3410 — THE OVERLOAD: 'hold' button writes now+7d (a FUTURE timestamp) into it as a hold-until pointer, alongside Approval Status='held' (comment :3408-3409)**.
R (as age origin): close-detector :79 (`Intro Sent At || Approved At`; sort :94-95; :114,135); referral-chasup :117,164,288,375,489,695 — staleness chain `Last Chased At || Intro Sent At || Approved At`; lib/airtable.ts:512 — recency tiebreak in findReferralByBuyerEmail (:485) picking which referral an inbound buyer reply attaches to; buyer-pulse :67,77-78.
Sem: LANDMINE — the future stamp makes every ager compute negative age (row invisible to chasers for 7 days — intended) but silently corrupts approval analytics AND the reply-attach recency sort. (Note: batch-approve :213 writes CONSUMERS' Approved At, a different field.)

### Intro Sent At (singleLineText)
W: approve :60; suggest :1428; lib/bulkRoute.ts:246,285; reassign :133; resend-intro :145; telegram :828,980,1257,5743; email-sequences :474.
R: primary age origin wherever Approved At is fallback (close-detector :79, chasup :110,117, buyer-pulse :67, first-touch-sla :105, nightly-rancher-audit :121,373); lib/staleHolds.ts:87; lib/deal/states.ts:47.

### Closed At (singleLineText)
W: lib/contracts/rancher.ts:67 recordClose (all outcomes); rancher PATCH :137,147,435; quick-action :264,274,309; confirm-payment :137,152; admin PATCH :39 (:139 reverse); telegram :1104,1724,3057,3424,3551,3623; stuck-referral-reaper :210; referral-chasup :201,619; lib/bulkRoute.ts:256; CLEARED by lib/refundLifecycle.ts:37 + revive :79. Dormant flip does NOT stamp it.
R: lib/replenishment.ts:82,115; lib/lossRecovery.ts:196 (comment :181 — "often unstamped"); lib/socialProof.ts:158; month-window revenue math.
Sem: singleLineText — unparseable values possible; not every closer stamps it.

### Rancher Accepted At (dateTime)
W: accept :145 (deal transition to SLOT_LOCKED; fallback :152); resend-inbound :784 (NRD-6 auto-accept when rancher replies after deposit); nulled on refund (refundLifecycle :45).
R: lib/depositSla.ts:112 — stops accept-SLA chase; lib/fulfillmentChase.ts:112,127; admin refund route :102 — post-accept = non-refundable window; accept :123 idempotency.
Sem: the non-refundable-deposit commitment moment.

### Payment Confirmed At (dateTime) + Payment Confirmation Method
W: confirm-payment :135 (recordClose extraFields) + :150 (fallback) — manual off-platform confirmation only.
R: app/api/rancher/fulfillment/confirm/route.ts:112 — legacy-rail fulfillment confirm 409s without a settled payment OR this stamp.
Sem: NOT in the dashboard projection — dashboards blind to it.

### Approval Status (singleSelect)
W: warmup/engage :107 ('pending-approval'); orders/request :266 + contact :167 ('Pending Rancher Response'); telegram :826,3358,5742 ('approved'), :3407 ('held'), :3422 ('skipped'); email-sequences :473; stuck-referral-reaper :209 ('rancher-no-response'); send-deposit-invoice :157 ('admin-approved' — typecast).
R: stuck-referral-reaper :97 — only 'Pending Rancher Response' reaped; telegram :3329 — button state.
Sem: operator-approval sub-state, orthogonal to Status. Reserve-rail referrals deliberately OMIT it (lib/reserveDeposit.ts:196-198).

### Close Class (singleSelect: real-loss|auto-hygiene|never-a-lead|unknown)
W: NO production writer — only scripts/cleanup-airtable-phase1.mjs:376 (2026-07-25 one-off backfill).
R: none in production.
Sem: forensic classification of the 1,405 Closed Lost rows (lead-quality audit). Blank on new Closed Lost rows = nothing writes it.

### Loss Reason (singleSelect)
W: rancher Mark Lost modal :139,149,442; quick-action :345 (map :132) — all on **Closed Lost** rows. PLUS (2026-07-30) referral-stale-expiry tier 3, which writes `DEPOSIT_RELEASE_LOSS_REASON` = "Couldn't reach buyer" (lib/depositRelease.ts, pinned to LOSS_REASON_CHOICES by a `satisfies` + a test) on a row it flips to **Dormant**.
R: suggest :350 — blocks re-pairing buyer↔rancher; lib/lossRecovery.ts:81 — reason → recovery action (stamps Recovery Sent At :228,243); weekly-scorecard :158,174.
Sem: presence **on a Closed Lost row** = genuine rancher-initiated loss — and that invariant still holds, because all three readers are scoped to `{Status}="Closed Lost"`. That scoping is exactly WHY the deposit release uses Dormant: a Closed Lost + "Couldn't reach buyer" auto-release would (a) blame ranchers in the weekly loss table for buyer silence, (b) hand loss-recovery a 'reengage' action against a buyer who just ignored three emails, and (c) risk tripping that cron's mass-edit guard. Any future change that widens a Loss Reason reader beyond Closed Lost MUST re-check lib/depositRelease. Bulk-backfilling it would poison the loss-recovery cron's day-window guard (loss-recovery :86).

### Match Type (singleSelect)
W: suggest :1301 (Local/Nationwide/Direct); orders/request :267 + contact :168 ('Direct (Rancher Page)'); lib/reserveDeposit.ts:214 ('Direct (Rancher Page) — Deposit' — typecast); lib/bulkRoute.ts:244,283; telegram :838; warmup :117; manual-create :54 ('Manual' — typecast); send-deposit-invoice :158; **lib/brokerReferral.ts (create) + lib/brokerSettlement.ts (re-stamped at settle) — 'Broker — Deposit' (typecast, `BROKER_MATCH_TYPE`)**.
R: lib/campaignReferral.ts:160 — reuse only deposit-intent referrals (substring 'Deposit'); lib/reserveRecovery.ts:61-62 isDepositIntent; lib/brokerReferral.ts — broker reuse requires an EXACT 'Broker — Deposit' match (never recycles a Connect deposit referral, so the rails can't cross).
Sem: the deposit-intent discriminator is a SUBSTRING match on 'Deposit' — which is exactly why the broker value CONTAINS 'Deposit'. It is a REPORTING label only: the authoritative rail signal is the rancher's `Broker Rail` checkbox at mint time and `metadata.rail==='broker'` (Stripe-held) at settle, so a typecast strip costs a label, never money.

### Rancher Record Id / Suggested Rancher Record Id (singleLineText denorms)
W: lib/airtable.ts:238 createReferral via stampRancherRecordIds (lib/referralRecordId.ts:40-47) on EVERY create; referral-record-id-backfill cron :56 (repair + clear, lib/referralRecordId.ts:58-70). Reassign/approve/telegram link changes do NOT restamp — the cron is the belt.
R: lib/airtable.ts:77-80 referralsByRancherFormula — the server-side ownership filter for every rancher-scoped read (lib/referralReads.ts:91).
Sem: stale between a reassign and the next cron run — callers must keep the JS ownership re-filter.

### State Allocation (singleLineText)
W: suggest :1307 at create. R: suggest :484 — per-state sub-cap bucket math.

### Last Chased At (dateTime)
W: referral-chasup :756 (chase send, stamp-first) + :580 (stale-prompt claim); telegram :1949 (chase button), :1968 ('chaskip' — stamped purely to suppress tomorrow's cron); cleared by reassign :137, revive :81, resend-intro :147.
R: referral-chasup :117,164,695 (head of staleness chain), :520 (re-chase throttle).
Sem: OVERLOADED — "chased" and "operator dismissed the prompt" look identical.

### Stalled Alert Sent At (dateTime)
W: first-touch-sla :240; referral-chasup :417; cleared by revive :82.
R: referral-chasup :380 — throttle; lib/firstTouchSla.ts:16,42 — deliberately SHARED throttle between both crons (either alert suppresses the other).

### Fulfillment Status (singleSelect) + fulfillment tracker fields
W: app/api/rancher/referrals/[id]/fulfillment/route.ts via FULFILLMENT_FIELDS (lib/fulfillmentTracking.ts). Only writer. Wave 2 (2026-07-29): a transition TO 'fulfilled' also rides the shared confirm rail (lib/fulfillmentConfirm.ts) — see Fulfillment Confirmed At below. Empty-string dates are NO-OPS server-side (data-wipe fix); deliberate clears require the explicit clearProcessingDate/clearHandoffDate body flags.
R: lib/fulfillmentChase.ts — 'fulfilled' suppresses the chase cron (with Fulfillment Confirmed At); lib/buyerDealStage.ts (scheduled/ready/delivered step truth) + app/member "Fulfillment" line via FULFILLMENT_STATUS_LABELS.
Sem (Wave 3): the buyer's view of this ladder used to render INSIDE the `tracking_number` branch, so a pickup buyer — who never gets a tracking number — could not see 'ready for pickup/ship' at all. Status is now ungated; only the carrier/tracking card stays gated on a tracking number.

### Handoff Date (date — fldZpGyngRdeBq5y0) — buyer-facing pickup/delivery date
W: app/api/rancher/referrals/[id]/fulfillment/route.ts (tracker save, via FULFILLMENT_FIELDS.handoffDate; validated not-past w/ 1-day UTC grace in lib/fulfillmentTracking.ts). Only writer. Set/changed (persisted-value compare) → sendBuyerHandoffScheduled email to the buyer; re-save of the same date never re-sends.
R: lib/fulfillmentChase.ts — PREFERRED due-date source for the chase cron (Handoff Date > Processing Date > accept+14d); its absence (with no Processing Date) triggers the 'schedule' ("pick a date") chase kind. Projected to rancher dashboard as handoff_date, and (Wave 3) to app/api/member/content as handoff_date — the buyer's "Pickup/Delivery scheduled: {date}" line + the `scheduled` ladder step. Pickup-vs-delivery wording comes from lib/buyerDealStage resolveHandoffMode/handoffWord, the SAME helper sendBuyerHandoffScheduled now imports (lib/email.ts) — one rule, two surfaces.
Sem: distinct from Processing Date (the abattoir date). This is WHEN THE BUYER GETS THEIR BEEF.

### Fulfillment Confirmed At (dateTime)
W: lib/fulfillmentConfirm.ts confirmFulfillmentForReferral — THE single stamp+side-effects rail (payment gate rail-per-referral, funnel event, buyer "beef received" email, Telegram). Two entry points: app/api/rancher/fulfillment/confirm/route.ts (binary confirm row, all rails — the tier_v2 UI gate was removed Wave 2) and app/api/rancher/referrals/[id]/fulfillment/route.ts (tracker transition to 'fulfilled', best-effort — a payment-gate 409 doesn't fail the tracker save).
R: lib/fulfillmentChase.ts — suppresses every chase kind; rancher dashboard green pill; confirm rail idempotency (skip if set); lib/buyerDealStage.ts — closes the buyer's `delivered` step (app/api/member/content fulfillment_confirmed_at).

### Fulfillment Chase Last Sent At (dateTime) + Fulfillment Chase Count (number)
W: app/api/cron/fulfillment-chase/route.ts — claim-stamp BEFORE send, all kinds.
R: lib/fulfillmentChase.ts — 48h cooldown + 3-lifetime cap + Count-as-ladder: confirm tiers fire only when tier > Count; 'schedule' kind only at Count 0; 'invoice' kind only while Count < 2 (its cap). Wave 2: the new kinds ('schedule' at accept+3d w/ no dates, 'invoice' at accept+7d w/ no Final Invoice Sent At/Final Paid At/Payment Confirmed At) share these stamps, skip 'rancher-added' rows (#511), and never email the buyer.

### Buyer Fulfillment Pref / Buyer Window Pref / Buyer Cut Notes / Buyer Preferences Set At
W: app/api/checkout/[refId]/preferences/route.ts via preferencesToReferralFields (lib/preferences.ts). Only writer. First submit posts the cut sheet to the buyer↔rancher thread + emails the rancher (sendRancherBuyerPreferences); Wave 2 (2026-07-29): a repeat submit whose VALUES CHANGED re-posts (marked UPDATED) + re-notifies; an identical re-submit stays silent.
R: same route's GET (prefill + alreadyCaptured idempotency anchor); fulfillment route — Buyer Fulfillment Pref words the handoff email pickup-vs-delivery when Fulfillment Method is unset; rancher dashboard "Buyer's cut sheet" block (projected Wave 2 — previously stripped from every rancher projection); app/api/member/content (Wave 3) — all four projected for the buyer's own "Your cut sheet" block, plus Buyer Fulfillment Pref feeding lib/buyerDealStage resolveHandoffMode.
Sem (Wave 3): these were WRITE-ONLY from the buyer's point of view — they answered the three questions once at /checkout/[refId]/preferences and never saw the answers again. /member now renders them read-only and links back to that same page to edit (no new buyer write surface; /api/member/preferences stays the one deliberate boolean).

### Referral Source (singleLineText — fldC5pUi90WDpBTsa) — My Leads provenance
W: app/api/rancher/referrals/route.ts (POST create) via buildLeadReferralFields (lib/rancherLeads.ts) — the ONLY writer; value always 'rancher-added' (constant REFERRAL_SOURCE_RANCHER_ADDED).
R (every reader is an EXCLUSION — 'rancher-added' rows are invisible to automation built for routed leads): lib/capacityCount.ts isCapacityCountedReferral — countHeldReferrals + heldCountsByRancher skip them (Redis seed lib/rancherCapacity.ts:47, capacity-drift-check, batch-approve self-heal, referral-stale-expiry resync, admin/health); lib/staleHolds.ts isStaleHold — never auto-expire to Dormant; app/api/cron/referral-chasup (top filter — chase emails, digests, stalled nudges, ghost close); app/api/cron/close-detector candidates filter; lib/lossRecovery.ts selectLossRecovery (skip 'rancher-added-crm'); lib/replenishment.ts isReplenishEligible; lib/contracts/rancher.ts recordCloseBehavior — close skips capacity DECR + affiliate/CAPI, lost flips buyer CLOSED (never READY-restore); app/api/rancher/referrals/[id] PATCH — {stage} rail requires it, legacy status/_action writes 400 on it; app/api/rancher/dashboard — activeReferrals stat excludes, referral_source projected (lib/referralReads.ts REFERRAL_DASHBOARD_FIELDS).
Sem: 'rancher-added' = the rancher typed this lead in themselves (My Leads CRM). It STILL counts as an active deal for routing (lib/capacityCount isActiveDealReferral — deliberate: never double-deal the buyer). NO emails fire on create. Deposit rail works unchanged (request-deposit stamps its own fields).

---

## Ranchers (`tbl08y9Be45zNG0OG`)

Shared infra: all writes ride `updateRecord`/`createRecord` (lib/airtable.ts:548/147).
THE routing gate is `isRancherOperationalForBuyers` (lib/rancherEligibility.ts:80):
Verification Status ≠ 'Removed' AND Active Status = 'Active' AND Onboarding Status ∈
{'', 'Live'} AND Agreement Signed AND Subscription Status ∉ {past_due, unpaid, canceled}
AND (tier_v2 only) Stripe Connect Status = 'active'. Canonical go-live write =
`GO_LIVE_FIELDS` (lib/goLiveGates.ts:38-43). Widest single write surface = admin PATCH
app/api/admin/ranchers/[id]/route.ts:28-93 (~30 fields). The two rancher self-serve
surfaces are allowlist-fenced: app/api/rancher/setup/route.ts (~:104) and
app/api/rancher/landing-page/route.ts (:105-160).

### Broker Rail (checkbox) + Broker Balance Note (multilineText) — added 2026-07-31
W: app/api/partner/represent/route.ts — the ONLY writer. Sets `Broker Rail`=true at notify-only signup and leaves `Active Status`, `Onboarding Status`, `Slug`, `Page Live`, `Agreement Signed`, `Self-Submitted At`, `Latitude`/`Longitude` ALL UNSET (each omission is deliberate — see the route header).
R (the rail): lib/brokerRail.ts `isBrokerRancher` — read by assertBrokerEligible (the checkout gates), referralRailForRancher (fail-closed rail choice), lib/brokerReferral (link redemption), lib/brokerSettlement. `Broker Balance Note` → brokerBalanceNote(), rendered on BOTH settlement emails.
R (the guardrails — a broker rancher is INVISIBLE to the platform): lib/rancherEligibility.ts `isRancherOperationalForBuyers` (FIRST gate, covers ~25 routing call sites) + `getOperationalServedStates` (returns [] — it does NOT call the predicate, so it needs its own check); the four public-lookup formulas in lib/airtable.ts (`getActiveRancherPages`, `getRancherBySlug`, `getRancherOrProspectBySlug`, `getRancherByPreviousSlug` — these cover sitemap, generateStaticParams, /ranchers, /api/public/ranchers, /start, /wholesale); app/map/page.tsx formula; app/access/[state] + app/half-a-cow/[state]; lib/stateSupply.ts; lib/marketplaceProducts.ts; lib/rancherReactivationSegment.ts; crons rancher-followup, onboarding-stuck, rancher-onboarding-drip, rancher-go-live-sync, batch-approve (auto-go-live), stripe-reconcile, send-scheduled, weekly-scorecard (payable count); app/api/admin/stuck-ranchers.
Sem: THE third-money-model flag (docs/BUSINESS-MODEL.md ⭐ MONEY MODEL 3). A represented rancher is sold BY Ben, is never routed, listed, mapped, chased, or counted as payable supply, and has NO Stripe Connect — the broker checkout REFUSES any rancher with a Connect footprint (double-billing risk). Airtable formula fragment: `NOT({Broker Rail} = 1)` (`BROKER_RAIL_EXCLUSION_FORMULA`); JS helper: `excludeBrokerRanchers(rows)`. `Active Status` empty already blocks routing, but the explicit flag check is what survives a future Active flip.

### Active Status (singleSelect: Active|At Capacity|Paused|Pending Onboarding|Non-Compliant)
W(go-live via GO_LIVE_FIELDS lib/goLiveGates.ts:40): app/api/ranchers/sign-agreement/route.ts:159,207 — signing w/ content-ready page; app/api/cron/batch-approve/route.ts:357 — 2-hourly flip of Verification Complete; app/api/webhooks/stripe-connect/route.ts:863 — Connect goes active; app/api/rancher/activate/route.ts:341 — legacy activation link.
W(pause): app/api/admin/ranchers/[id]/pause/route.ts:39; app/api/rancher/remove/route.ts:99; app/api/rancher/checkin-response/route.ts:99; app/api/rancher/decline/route.ts:195; app/api/referrals/[id]/route.ts:342 + app/api/rancher/referrals/[id]/route.ts:970 — pilot-goal pause; app/api/webhooks/stripe-connect/route.ts:1301 — Connect DEAUTHORIZE; app/api/cron/nightly-rancher-audit/route.ts:229; app/api/cron/migration-deadline/route.ts:152 — deadline auto-pause; app/api/cron/compliance-reminders/route.ts:136 ('Non-Compliant'); app/api/webhooks/telegram/route.ts:3261,5494,5520 — admin one-tap.
W(capacity): app/api/ranchers/capacity-check/route.ts:31,40 — Active↔At Capacity off the mirror count; app/api/rancher/landing-page/route.ts:215,217,446; app/api/admin/ranchers/[id]/resume/route.ts:29; lib/pauseReversal.ts:115; lib/connectResync.ts:248 (paused_overdue auto-resume). Generic: app/api/admin/ranchers/[id]/route.ts:45.
R: lib/rancherEligibility.ts:88-89 — hard ='Active' routing gate; lib/goLiveGates.ts:74; app/api/cron/migration-deadline/route.ts:116 (skips Paused); app/api/ranchers/capacity-check/route.ts:27; lib/connectResync.ts:157,223.
Sem: THE routing kill-switch. Many paths pause; ONLY the migration-deadline `paused_overdue` pause ever auto-resumes (lib/connectResync.ts:162-203). Every other Paused needs a human. NEVER batch-flip without Ben's per-rancher OK.

### Pickup Address (singleLineText — fldGTVzd7zCZIkKJf) + Pickup Instructions (long text — fldVwKoWIlPqC69GC)
W: app/api/rancher/landing-page/route.ts:655-663 — rancher self-serve, allowlisted + trimmed/clamped (address 200, instructions 1000, empty → null); admin PATCH app/api/admin/ranchers/[id]/route.ts.
R: lib/productSettlement.ts:276-277 — the pickup block on the product receipt (Wave 1 "pickup truth": a pickup buyer never learned WHERE to go); app/order/success/page.tsx:47; app/api/checkout/deposit/route.ts:727; app/api/member/content (Wave 3) — projected onto the buyer's referral as rancher_pickup_address / rancher_pickup_instructions and rendered on /member for a PICKUP deal after the deposit lands (the share-buyer half of the same fix).
Sem: rendered ONLY when the deal is pickup (resolveHandoffMode → 'pickup'); blank stays honest ("the ranch will reach out to set up your pickup") rather than showing an empty box.

### Onboarding Status (singleSelect)
W: app/api/ranchers/sign-agreement/route.ts:183 ('Agreement Signed') / :212 ('Verification Complete', pre-vetted tier_v2); app/api/rancher/setup/request-agreement/route.ts:76 + app/api/ranchers/[id]/send-onboarding/route.ts:201 ('Docs Sent'); app/api/webhooks/cal/route.ts:258,270,626,711,756,799 — Cal book/cancel; app/api/webhooks/telegram/route.ts:2634,2694 — one-tap verify; app/api/cron/auto-verify-stale/route.ts:44; app/api/rancher/activate/route.ts:280,342; GO_LIVE_FIELDS writers set 'Live'; admin PATCH :44.
R: lib/rancherEligibility.ts:91-92 — must be 'Live' or empty; lib/goLiveGates.ts:128; app/api/cron/batch-approve/route.ts:325; app/api/cron/rancher-go-live-sync/route.ts:114; app/api/cron/rancher-followup/route.ts:89.
Sem: onboarding stage machine. Empty PASSES the routing gate (legacy rows); 'Live' terminal; anything else blocks routing.

### Agreement Signed (checkbox) + Agreement Signed At (date)
W: app/api/ranchers/sign-agreement/route.ts:180-181 — e-sign POST; app/api/rancher/activate/route.ts:278-279,339-340 — activation link implies signature; scripts/_triage-rancher.mjs:225-226.
R: lib/rancherEligibility.ts:94 — routing hard-requires it; lib/goLiveGates.ts:102; app/api/cron/onboarding-stuck/route.ts:132,144 (stuck-bucket clock).
Sem: legal gate. Unsigned + Live = silently zero buyers.

### Signature IP / Signature User Agent / Agreement Version
W: **NOTHING — zero code references.** Schema-only fields.
R: none.
Sem: e-sign audit trail is UNWRITTEN. The signature POST is app/api/ranchers/sign-agreement/route.ts:73-97 (payload built :179-186, written :216) — the writer belongs there (headers `x-forwarded-for` / `user-agent` are on the Request). Secondary sign path app/api/rancher/activate/route.ts:278/339 needs parity.

### Verification Status (singleSelect)
W: app/api/prospects/self-submit/route.ts:406 ('Prospect'); app/api/rancher/remove/route.ts:97 + app/api/prospects/remove/route.ts:69 ('Removed'); app/api/webhooks/telegram/route.ts:2695 ('Verified', rollback :2662); app/api/cron/auto-verify-stale/route.ts:45; app/api/ranchers/sign-agreement/route.ts:213; admin PATCH :51.
R: lib/rancherEligibility.ts:86 — 'Removed' is an absolute kill even if Active Status flips back.
Sem: 'Removed' outranks everything; Resume can never re-open a closed account.

### Subscription Status (singleSelect)
W: app/api/webhooks/stripe/route.ts:503,1267,1324,1371,1436,1586,1703,2027,2038,2213 — billing lifecycle (NOTE :1267 writes 'cancelled' double-L vs schema choice 'canceled'); app/api/rancher/tier/select/route.ts:154; app/api/admin/founders/comp/route.ts:137.
R: lib/rancherEligibility.ts:100-103 — past_due/unpaid/canceled unroutable; app/api/checkout/deposit/route.ts (~:210) 409 gate; app/api/webhooks/stripe-connect/route.ts:622-624 — subPaying gate for tier_v2 auto-flip; lib/connectResync.ts:117-120 — reconcile is observe-only unless ?apply=1.
Sem: Stripe collections gate; empty passes (legacy rows).

### Pricing Model (singleSelect: legacy|tier_v2)
W: app/api/apply/route.ts:324 + app/api/prospects/self-submit/route.ts:418 + app/api/partners/route.ts:247 ('legacy' at create); app/api/rancher/tier/select/route.ts:99,124,150; app/api/rancher/legacy-upgrade/route.ts:100 (rollback :116); app/api/webhooks/stripe-connect/route.ts:627 — AUTO-FLIP to tier_v2 when Connect active + sub paying; app/api/admin/ranchers/[id]/mark-legacy-connect/route.ts:108.
R: lib/rancherEligibility.ts:117-121 — tier_v2 adds the Connect='active' gate, legacy exempt; :163-165 isRancherOnConnect; lib/goLiveGates.ts:114-116; app/api/checkout/deposit/route.ts:140-151 — legacy → 409 redirect to own checkout; lib/connectResync.ts:96-98,224-227; app/api/cron/migration-deadline/route.ts:108,117.
Sem: the money-rail fork. LANDMINE: flipping tier_v2→legacy WITHOUT Migration Status='completed' re-arms the migration-deadline auto-pause cron (Gift Farms rule: flip BOTH).

### Migration Status (singleSelect)
W: app/api/admin/ranchers/[id]/send-v2-upgrade/route.ts:210 ('invited'); app/api/webhooks/cal/route.ts:255 ('call_scheduled'); app/api/rancher/tier/select/route.ts:158 ('upgrading'); app/api/cron/migration-deadline/route.ts:153 — SOLE writer of 'paused_overdue' (machine-pause provenance); 'completed' by app/api/webhooks/stripe-connect/route.ts:630,653, app/api/admin/ranchers/[id]/resync-connect/route.ts:136, lib/connectResync.ts:100,249.
R: app/api/cron/migration-deadline/route.ts:107-118 — THE auto-pause pool = `Pricing Model !== 'tier_v2' AND Migration Status ∈ {invited,call_scheduled,upgrading}`, pauses at :149-154; lib/connectResync.ts:66-73,85,220-228 — auto-resume provenance.
Sem: migration funnel tracker doubling as pause provenance; 'paused_overdue' is single-use proof the machine (not a human) paused.

### Stripe Connect Account Id (singleLineText — NOT "Stripe Account Id")
W: app/api/rancher/connect/start/route.ts:217; app/api/rancher/tier/select/route.ts:97; app/api/admin/ranchers/[id]/mark-legacy-connect/route.ts:109. Never written by webhooks.
R: app/api/checkout/deposit/route.ts:179-182 — 409 if missing (money gate); lib/depositRequest.ts:91; lib/storefrontGates.ts:28; lib/productBuyGates.ts:117; app/api/checkout/product/route.ts:89; app/api/rancher/referrals/[id]/send-final-invoice/route.ts:232; app/r/f/[token]/route.ts:100; app/api/admin/payments/refund/[paymentId]/route.ts:73; lib/connectLooksLive.ts:81; app/api/rancher/connect/status/route.ts:30,135.
Sem: destination account for every Connect charge/transfer/refund. Exact field name matters — dead gauges have read wrong-name variants.

### Stripe Connect Status (singleSelect: not_connected|onboarding|active|restricted [+typecast 'detached'])
W: app/api/webhooks/stripe-connect/route.ts:606,657 — account.updated (primary); :1300 'detached' on deauthorize; app/api/rancher/connect/start/route.ts:218; app/api/rancher/tier/select/route.ts:98; lib/connectResync.ts:91 (via connect/status poll :154 + app/api/cron/stripe-reconcile/route.ts:294 nightly heal); app/api/admin/ranchers/[id]/resync-connect/route.ts:119 (🔄 Resync); app/api/checkout/deposit/route.ts:202 — self-heal on stale 'active'; app/api/cron/rancher-go-live-sync/route.ts:81,168.
R: app/api/checkout/deposit/route.ts:177 — 409 unless 'active'; lib/rancherEligibility.ts:119-120,164; lib/goLiveGates.ts:116; app/api/ranchers/sign-agreement/route.ts:144-148.
Sem: cached mirror of Stripe truth with 5 independent heal paths; 'detached' is typecast-created, not in schema choices.

### Stripe Connect Connected At (dateTime)
W: app/api/webhooks/stripe-connect/route.ts:608; resync-connect :121; lib/connectResync.ts:93; rancher-go-live-sync :83 — first activation only.
R: app/api/webhooks/stripe-connect/route.ts:597 — `alreadyCelebrated` dedupe (blocks double celebration/warmup).
Sem: write-once stamp doubling as webhook dedupe key.

### Connect Started At (dateTime)
W: app/api/rancher/connect/start/route.ts:219,270 (guarded not-already-set :267); app/api/rancher/tier/select/route.ts:105.
R: app/api/cron/onboarding-stuck/route.ts:128-144 — stuck-bucket clock.
Sem: funnel-visibility stamp (was 0/87 before #481). Write-once.

### Lead Digest Sent At (dateTime) — fldPYqaAYFreEdbln
W: app/api/cron/referral-chasup/route.ts (L2a digest block) — stamped BEFORE the send.
R: same block via lib/rancherLeadDigest.ts `shouldSendLeadDigest` — 24h DB-state throttle.
Sem: per-RANCHER throttle for the daily lead digest (audit 2026-07-28). Because the throttle is recipient-level DB state, `sendRancherLeadDigest` is frequency-cap-whitelisted; a failed stamp write suppresses a digest, never multiplies one. The digest also stamps each included referral's `Rancher Reminded At`, which keeps Intro-Sent rows out of rancher-followup's Monday stale-nudge bundle (its 7-day per-referral throttle).

### Max Active Referalls (number — SINGLE-L TYPO is the real schema field)
W: app/api/admin/ranchers/[id]/route.ts:49 + app/api/rancher/landing-page/route.ts:206 — both via `MAX_ACTIVE_REFERRALS_FIELD` (lib/rancherCapacity.ts:79 = typo spelling); app/api/rancher/activate/route.ts:347 — default 5; scripts/brimstone-launch.mjs:195.
R: lib/rancherCapacity.ts:55-63 `getMaxActiveReferrals` — reads correct spelling FIRST then typo, default 5 — from app/api/matching/suggest/route.ts:592,755,1206,1364; app/api/ranchers/capacity-check/route.ts:26; app/api/referrals/[id]/approve/route.ts:41; app/api/admin/referrals/[id]/reassign/route.ts:96; lib/campaignReferral.ts:183; lib/demandRouter.ts:706.
Sem: LANDMINE (lib/rancherCapacity.ts:70-77): the correctly-spelled field does NOT exist in Airtable (422s). Reader/writer/schema are a three-legged stool — fix all three or none, else every cap silently falls to 5.

### Current Active Referrals (number — Airtable MIRROR of Redis truth)
W: lib/rancherCapacity.ts:200,284,389,405; app/api/matching/suggest/route.ts:1359 — post-claim mirror; app/api/rancher/referrals/[id]/route.ts:176; app/api/admin/referrals/manual-create/route.ts:65; lib/bulkRoute.ts:482.
R: app/api/ranchers/capacity-check/route.ts:25 — At-Capacity flip; app/api/matching/suggest/route.ts:57,61 — retainer tiebreak.
Sem: display/cron mirror, eventually-consistent. Claim authority = Redis `incrementCapacity` (lib/rancherCapacity.ts:109) seeded from referral-truth `liveHeldCountForRancher` :47-53, NEVER from this mirror (mirror-seeding was the drift root cause).

### Service ZIP Prefixes (singleLineText)
W: **NOTHING in code** — admin hand-sets in Airtable.
R: lib/exclusiveZip.ts:45-48 `hasServiceZipGate`, :60-66 `buyerZipServedBy` — FAILS CLOSED (gated rancher + missing/malformed buyer ZIP ⇒ excluded). Call sites: app/api/matching/suggest/route.ts:589 (pool), :763 (direct-pin); app/api/checkout/deposit/route.ts:160-170 — 409 out_of_area; app/api/checkout/reserve/route.ts:154; app/api/admin/send-deposit-invoice/route.ts:63; lib/productBuyGates.ts:139.
Sem: exclusive-territory hard gate (Thomas "77"). Empty = no gate.

### Delivery Radius Miles (number)
W: app/rancher/setup/RancherSetupWizard.tsx:4181 → app/api/rancher/setup/route.ts:100 (sanitize :315-326); app/rancher/page.tsx:4624 → app/api/rancher/landing-page/route.ts:155 (:646).
R: lib/geoDistance.ts:161-171,180-192 — gates ONLY when `isDeliveryOnly` (:113-124): EVERY Fulfillment Types entry = 'Local Delivery' (fail-open otherwise); app/api/matching/suggest/route.ts:814.
Sem: LANDMINE — a Local-Delivery sub-field, NOT a service area. Gating mixed-fulfillment ranchers on it strands buyers (Champion Valley/Denver incident).

### State / Routing States / States Served / Admin Approved Multi-State / Ships Nationwide
W: State — app/api/apply/route.ts:~316-327 create; app/api/prospects/self-submit/route.ts:401; admin PATCH :38. Routing States — admin PATCH :93 ONLY (rancher self-serve deliberately cannot write it). States Served — admin PATCH :48. Admin Approved Multi-State — no code writer (manual). Ships Nationwide (product-level) — lib/rancherProductInput.ts:259.
R: lib/rancherEligibility.ts:139-146 — home state = service area; Routing States/States Served IGNORED unless Admin Approved Multi-State=true; app/api/matching/suggest/route.ts:394,886,1054 — nationwide pool requires Multi-State AND Ships Nationwide; hasOperationalRancherForState :176-183.
Sem: multi-state is a two-key system (boolean + list); a populated list without the boolean does nothing.

### Slug (singleLineText) + Previous Slugs
W: app/api/apply/route.ts:327 (minted at application); app/api/prospects/self-submit/route.ts:405; admin PATCH :57; app/api/rancher/landing-page/route.ts:519-540 — rename w/ collision check, Previous Slugs appended :895-896 (lib/slugHistory.ts).
R: lib/airtable.ts:726 getRancherBySlug / :759 getRancherByPreviousSlug; app/api/matching/suggest/route.ts:731 — direct-pin; app/api/ranchers/sign-agreement/route.ts:119 — go-live content gate; app/api/admin/sell-options/route.ts:50.
Sem: public identity + pin-routing key. Renames must ride the landing-page route or old links die.

### Commission Rate (percent) + Commission Rate Locked At
W: app/api/ranchers/sign-agreement/route.ts:184-185 — LOCKED at signing (pre-set rate wins; locked 0 valid = Operator tier); app/api/webhooks/stripe/route.ts:1615-1617 — default only when truly empty.
R: lib/commission.ts:107 getRancherCommissionRate — all close paths (confirm-payment :110, telegram :3618, dashboard :255, billing :221); :134 hasLockedCommissionRate — refuses Closed Won without a rate; lib/tiers.ts:217 depositCommissionRate.
Sem: money-truth anchor (Ashcraft scar). 0 ≠ empty: locked 0 ⇒ $0 fee, never the 10% default; percent-typed "4" normalizes to 0.04.

### Routing Weight Override (number)
W: **NOTHING** — Airtable manual only.
R: app/api/matching/suggest/route.ts:59,62 → lib/routingPriority.ts:59-70 — an override wins ABSOLUTELY over the tier ladder (no starvation floor); empty/garbage/≤0 → normal ladder (operator/ranch 3, pasture 2, legacy 1).
Sem: operator pin ("Ashcraft gets every TX lead" = 100). Eligibility + capacity still gate upstream.

### Tier (singleSelect)
W: app/api/webhooks/stripe/route.ts:922,1584,1704; lib/contracts/payments.ts:252,323; tier/select :149; mark-legacy-connect :107 ('Legacy Connect').
R: lib/tiers.ts:172 tierFor → deposit 409 when unset (app/api/checkout/deposit/route.ts:173-176); routing weight (lib/routingPriority.ts:30); tier commission fallback (lib/tiers.ts:218-220).
Sem: drives both deposit pricing and match priority.

### Custom Notes vs Ops Notes (Internal)
W Custom Notes: rancher-editable (setup :86, landing-page :132, admin PATCH :62); append audit lines: decline :196, activate :281,390, telegram :280,300. Ops Notes (Internal): **no code writer/reader** — pure Airtable-manual.
R Custom Notes: **PUBLIC** — app/api/public/ranchers/[slug]/route.ts:47 + app/ranchers/[slug]/page.tsx:216-223, with defensive regex suppressing internal-looking text (commission|retainer|payout|$N/mo).
Sem: the Ashcraft-leak scar. Internal deal terms go ONLY in Ops Notes (Internal); anything in Custom Notes must be assumed buyer-visible.

---

## Consumers (`tblAbjQDnLrOtjpoE`) — buyers

**13 distinct creation paths** (the duplicate-pair factory — every email-keyed upsert
looks up `LOWER({Email})` in a try/catch that FAILS OPEN to create): 1. funnel wizard
app/api/consumers/route.ts:315 (lookup :201); 2. legacy signup :769 (409s on dup :551);
3. waitlist stub app/api/waitlist/route.ts:108 (near-blank by design — no Status/Stage);
4. guide magnet app/api/guide/signup/route.ts:91; 5. operator sell-link
app/api/admin/sell-links/route.ts:96; 6. founder comp app/api/admin/founders/comp/route.ts:163;
7. rancher-page contact app/api/public/ranchers/[slug]/contact/route.ts:142; 8. store order
app/api/orders/request/route.ts:231; 9. reserve rail app/api/checkout/reserve/route.ts:257
via lib/reserveDeposit.ts:141-168; 10. ManyChat IG-DM app/api/webhooks/manychat/route.ts:690;
11. Stripe founder checkout app/api/webhooks/stripe/route.ts:1158; 12. product settlement
lib/productSettlement.ts:475; 13. lib/contracts/buyer.ts:29 createBuyer (ZERO callers — dead).
Only paths 1-2 stamp `Created`.

### Buyer Stage (singleSelect NEW|WAITING|READY|MATCHED|CLOSED|NURTURE|PRODUCT_BUYER)
W (~18 writers): create — consumers :243 (funnel→WAITING), :672 (legacy→NEW); guide :108; productSettlement.ts:469,478 (PRODUCT_BUYER, never demotes share-funnel buyers). Transitions — lib/contracts/buyer.ts:50; matching/suggest :1456 (→MATCHED), :1628 (→READY); referrals/[id] :177 + rancher/referrals/[id] :466 + telegram :3085,3664 (→CLOSED); telegram :841,3346 (→MATCHED), :3430 (→WAITING); contracts/rancher.ts:465 + contracts/payments.ts:879 (→READY restore); cron/batch-approve :214; cron/rancher-launch-warmup :366,394; cron/email-sequences :493,548; cron/referral-stale-expiry :169-170 (MATCHED→READY); cron/stuck-buyer-recovery :93; admin resend-warmup :110.
R: lib/routingSegment.ts:80-87 (MATCHED/CLOSED → TERMINAL, exits marketing); lib/waitingActivation.ts:113,211; email-sequences :310; lib/demandRouter.ts:236 (MATCHED = in-deal, campaign hands-off); nurture-drip :81.
Sem: the most-contended field on the table. contracts/buyer.ts's "all writes go through me" header is ASPIRATIONAL — most writers bypass it. matching/suggest deliberately does NOT gate on stage (suggest:172-179) — Qualified At is the gate.

### Buyer Stage Updated At (dateTime)
W: paired with every stage write above.
R: email-sequences :312-318 — missing stamp ⇒ buyer silently skipped ("not migrated"); lib/demandRouter.ts:432.
Sem: a stage write without the stamp drops the buyer from the sequences cron.

### Status (Pending|Approved|Rejected|Waitlisted) + Approved At
W: consumers :245-246 (funnel: instant Approved), :667,671; lib/reserveDeposit.ts:149-150,189 (Pending→Approved promote, never un-Rejects); guide signup; founders comp; stripe wh :1165; cron/batch-approve :213; telegram approve buttons :827,979,1256,1405.
R: lib/qualification.ts:91-92 — routing requires 'Approved'; lib/lossRecovery.ts:159; email-sequences pool.
Sem: operator-vetting flag. Blank Status (waitlist/manychat/sell-link rows) = cron-invisible BY DESIGN.

### Qualified At (dateTime) — THE routing key
W: ONLY app/api/qualify/route.ts:275 via lib/qualifyUpdates.ts:91 (stamped only when NOT explicitly-not-ready) and app/api/buyer/reconfirm/route.ts:47 (re-stamp).
R: app/api/matching/suggest/route.ts:182-198 — GUARD-2: no Qualified At ⇒ 412 (no score floor; Intent Score is log-only); :208 — GUARD-2b: stamp >28d (lib/qualification.ts:189) ⇒ 412 + reconfirm email; lib/qualification.ts:151 isQualifiedForRouting; lib/demandRouter.ts:307,431; checkout/reserve :204,308; stuck-buyer-recovery :141-146; nurture-drip :82; lib/waitingActivation.ts:221; consumers :303 (freezes funnel overwrites of quiz truth).
Sem: the single "may be routed" bit — buyer qualified ONLY after funnel + quiz, never on Intent Score alone. ORDERING LANDMINE: qualify must persist it BEFORE calling matching/suggest (qualify :262-267) — historical silent-412 bug. ~234 legacy rows carry a hold-branch mis-stamp (lib/qualifyUpdates.ts:12-17), defended by "just exploring" re-checks (qualification.ts:126,151).

### Funnel Completed At (dateTime)
W: qualify :276 via qualifyUpdates.ts:86 — stamped on every completion INCLUDING holds.
R: lib/waitingActivation.ts:126 (completers exempt from "you never finished" nudge), :221; nurture-drip :83; abandoned-quiz drip selects blank.
Sem: "finished the funnel" ≠ "routable" — hold branch stamps this WITHOUT Qualified At.

### Intent Score (number) + Intent Classification
W: consumers :239,695; contact :150 (80); orders :~247 (90); lib/reserveDeposit.ts:160,218 (90); member/upgrade-intent :49; consumers :304 DELETES it from funnel re-entry once Qualified At set.
R: lib/qualification.ts:65 (signup-time ≥60 floor — nurture vs route, signup only); lib/demandRouter.ts:323 (warm tier for re-warm emails), :1009,1326 (sort only). NOT read by the matching gate.
Sem: prioritization/telemetry. Never a routing pass by itself.

### Order Type (singleSelect — the buyer's cut)
W: funnel consumers :237 (`tierQ`) + :685, :1016 ('Not specified'); lib/qualifyUpdates.ts:102 (quiz tier, mirrored to the early write qualify :279); lib/reserveDeposit.ts:152 (reserve rail, CUT_LABELS shape).
R: app/api/qualify/route.ts:181,341 (tier resume when the quiz answer is absent); **lib/requalifyCampaign.ts:orderTypeToCut → decideRequalifyCta** — the campaign 1-tap gate: this field is what pre-selects the cut on a /r/d deposit link (app/api/campaign/requalify-send).
Sem: TWO value shapes in the wild — quiz writes 'Quarter'|'Half'|'Whole'|'Not Sure', the reserve rail writes CUT_LABELS ('Half Cow'). Anything that doesn't start quarter/half/whole (incl. 'Not Sure', 'Not specified', blank) maps to NO cut and the campaign falls back to the quiz link. Never infer a cut from Budget/Intent Score — a wrong cut is a wrong charge.

### Referral Status (singleSelect — denormalized mirror of Referrals)
W: consumers :697 ('Unmatched' at create); lib/bulkRoute.ts:298,400; suggest :1118,1266 ('Waitlisted'), :1455,1627; referrals/[id] :173,227; rancher/referrals/[id] :202,462,606; telegram :1066,1341,3660; contracts/rancher.ts:468; resend-warmup :112; maintenance-resurrect-orphans :91.
R: lib/routingSegment.ts:88-90 (Awaiting Payment/Slot Locked/Closed Won → TERMINAL); lib/demandRouter.ts:233; lib/goLiveRancher.ts:166; lib/bulkRoute.ts:160; batch-approve :493.
Sem: a belt, can go stale — canonical in-deal predicate is `isActiveDealReferral` on Referrals rows (demandRouter :246-251).

### Ready to Buy (checkbox)
W: consumers :710 (create heuristic), :912; lib/contracts/buyer.ts:60 (warmup YES click); contracts/rancher.ts:467; contracts/payments.ts:883; member/ready-to-buy :90.
R: lib/routingSegment.ts:122 (→MATCH_NOW); lib/demandRouter.ts:316,586 ('hot'); stuck-buyer-recovery :132-146; lib/lossRecovery.ts:173; re-warm-cohort :68.
Sem: documented-unreliable intent proxy; never routes on its own (qualification.ts:140-143).

### Email (identity/dedupe key)
W: creation paths only; funnel + contact lowercase, others as-typed.
R: dedupe = per-path `LOWER({Email})` lookups (consumers :201,543; guide :75; sell-links :89; orders :208; contact :121; manychat :646; stripe wh :1142; productSettlement :462; reserve :204). Suppression list keyed on lowercased email (lib/email.ts:161,171 → every send :343-346). BATCHED (chunks of 20, never N+1): campaign/requalify-send `readByEmail` resolves the recipient batch against Consumers.Email AND Referrals.'Buyer Email' to pick each recipient's CTA.
Sem: NO unique constraint — dedupe fails OPEN to create. The 33 duplicate pairs came from lookup failures/races, not casing. CONSEQUENCE for money links: an email can resolve to SEVERAL rows, so lib/requalifyCampaign.ts:pickCanonicalConsumer takes the most-recently-active row (the `_pickCanonical` doctrine from lib/airtable.ts) and treats a TIE as ambiguous → quiz fallback. Never guess an identity into a payment link.

### Zip (singleLineText)
W: consumers :236,683; orders create; fill-if-blank `buyerZipPatch` backfills: orders :226, contact :137, waitlist :91, reserve :214,290, lib/stripeSettlement.ts:264, lib/productSettlement.ts:471.
R: matching/suggest :589 buyerZipServedBy (FAILS CLOSED), :763 (direct-pin), :795 (offline centroid ranking — NEVER live-geocode); checkout/deposit :163. (zipGatherCampaign deleted 2026-08-02 #529 with the whole zip-gather rail.)
Sem: exclusivity + real-miles key.

### Unsubscribed / Bounced / Complained (+ Unsubscribed At)
W: unsubscribe route :85-96; resubscribe :64-104; app/api/webhooks/resend/route.ts:110-117 (bounce/complaint ⇒ Unsubscribed:true + flag + cache invalidate); **lib/smsInboundHandler.ts:70,76 applyInboundKeyword (STOP/START)** — 2026-07-30 the SMS consent writer MOVED out of the twilio-sms route so both inbound webhooks share it; called from app/api/webhooks/twilio-sms (Twilio, signature-verified) AND app/api/webhooks/sms (telnyx/plivo/bandwidth, SMS_INBOUND_SECRET token).
R: lib/email.ts:161,171 — suppression formula `OR({Unsubscribed},{Bounced},{Complained})` short-circuits EVERY send (:343-346; guardedSend returns {success,suppressed}); lib/twilio.ts (sendSMSToConsumer suppression mirror); lib/qualification.ts:95-97 — suppressed = unroutable; lib/routingSegment.ts:92-97; lib/demandRouter.ts:454-456; per-cron trio checks.
Sem: Unsubscribed = soft/reversible; Bounced/Complained = hard. LANDMINE: suppression cache is in-memory TTL (email.ts:139) — webhook invalidates it, scripts don't.

### SMS Opt-In (checkbox) + SMS Opt-In At
W: consumers :284-287 (true+stamp on tick; seed false; never silently revokes), :663; guide :82,109; contact :133,154; orders :220,250; reserve :225,283; inquiries :139; **lib/smsInboundHandler.ts:70,76 applyInboundKeyword** (authoritative STOP/START — 2026-07-30 moved out of the twilio-sms route; both app/api/webhooks/twilio-sms and the provider-neutral app/api/webhooks/sms call it, so keyword handling is identical on twilio/telnyx/plivo/bandwidth).
R: lib/twilio.ts sendSMSToConsumer — THE TCPA gate on every SMS (unchanged by the 2026-07-30 transport swap: the provider adapter sits BELOW it); lib/waitingActivation.ts:349; qualified-no-action :242; deposit-request-nudge :229; lib/demandRouter.ts:995,1312,1787.
Sem: forms only flip false→true; only an inbound STOP turns it off. Opt-In At = TCPA evidence.

### Sequence Stage (+ Sequence Sent At)
W: cron/email-sequences :169, :492-797 (stage machine, each paired w/ Sent At); batch-approve :289,297; reroute writers referrals/[id] :228, rancher/referrals :203,607, referral-chasup :233; clears at consumers :764, referrals/[id] :174, contracts/payments.ts:882.
R: email-sequences :142, :311, :321-324 (Sent At = 24h frequency cap); lib/demandRouter.ts:428.
Sem: cursor for the sequences cron; Sent At doubles as its 1-email/day cap.

### Routing Segment (singleSelect, derived)
W: ONLY cron/reclassify-buyers :72 (nightly `classifyBuyer` lib/routingSegment.ts:70-146, write-on-change).
R: email-sequences :334-345 — segment picks which email + cadence caps.
Sem: derived nightly — don't hand-write.

### Nurture Touch (+ Nurture Touched At)
W: cron/nurture-drip :138-139 only (stamped even on suppressed sends so the drip advances).
R: nurture-drip :85 (d2/d6/d12/d21 off Qualified/Funnel-Completed At, lib/nurtureDrip.ts:49-55); lib/waitingActivation.ts:229-234 (cross-rail sequencing).

### Stripe Customer ID (singleLineText)
W: app/api/webhooks/stripe/route.ts:1120 only (founder checkout).
R: none on Consumers (same-named RANCHERS field is a different thing — do not conflate).
Sem: LANDMINE — Consumers uses `...ID`, Ranchers uses `...Id`; Airtable silently strips wrong-cased writes (stripe wh :1121-1127).

### Lead Source (singleLineText) — My Leads provenance ('rancher-crm')
W: app/api/rancher/referrals/route.ts (POST) via buildLeadConsumerFields (lib/rancherLeads.ts) — ONLY on CREATE of a new consumer; an EXISTING consumer found by email keeps their organic provenance (never overwritten). Value always 'rancher-crm' (constant CONSUMER_LEAD_SOURCE_CRM). Rows are created with Buyer Stage='MATCHED' (+ paired Buyer Stage Updated At) and NO Status / Qualified At / Segment / Intent Score — cron-invisible by design.
R (all exclusions — this buyer opted into the RANCHER, never into BHC marketing): lib/nurtureDrip.ts dueNurtureTouch (leadSource gate); lib/waitingActivation.ts isWaitingNudgeEligible + isReadyChaseEligible; app/api/cron/email-sequences (approved-pool filter — belt over the blank-Status gate, covers the CLOSED post-purchase track after a won close); app/api/cron/send-scheduled isMailable (broadcast audiences 'consumers'/'consumers-community' would otherwise sweep blank-Segment rows).
Sem: zero BHC marketing to these buyers. Transactional deposit-request emails (rancher-initiated) are fine. If this field is missing from the Airtable schema, createRecord strips it silently — verify it exists before relying on the exclusions (the blank-Status / no-Qualified-At belts still hold).

### Callback Requested At (dateTime) / Callback Note (multilineText) / Callback Handled At (dateTime) — the INBOUND rail
W (Requested At + Note): ONLY app/api/callback-request/route.ts (POST) — the buyer taps "have ben call me" on the deposit checkout page or the member dashboard. Written together, always: Note is stamped even when blank so a NEW request can never inherit the note from a previous, already-handled one. Requested At is NEVER overwritten while a request is open (see Sem).
W (Handled At): ONLY app/api/admin/callbacks/[id]/handled/route.ts (POST, admin) — Ben marks the row handled from the desk. One-way: it never clears Requested At, which is what preserves "this buyer has asked before".
W (Phone, same route): FIRST-TIME only — app/api/callback-request stamps `Phone` when the consumer has none and supplied one, normalized through lib/phoneE164. An existing phone is NEVER overwritten.
R: **lib/callbackQueue.hasOpenCallbackRequest is the single definition of "open"** — consulted by the endpoint's duplicate guard AND app/api/admin/desk (the "📞 Asked for a call" section + the cross-source dial queue, where an open request is the top tier above every other signal). Desk pre-filters in Airtable with the mirrored formula `AND(NOT({Callback Requested At}=''),OR({Callback Handled At}='',IS_BEFORE({Callback Handled At},{Callback Requested At})))`, then re-checks in JS so the two can never drift.
Sem: OPEN means asked AND not called SINCE — `Handled At < Requested At` is open, not closed. Both are single-value dateTime fields, so a buyer who asks a SECOND time overwrites Requested At while Handled At still holds the first call; a naive `!handledAt` test reads that re-ask as handled and silently drops the hottest row in the business. An unparseable Handled At fails toward SHOWING the request. The desk sorts these OLDEST FIRST (a callback request is a debt with a clock on it), which is also why the endpoint refuses to re-stamp Requested At while one is open — doing so would reset the buyer's place in the queue and punish whoever has waited longest.
Gating: the BUYER-facing surfaces are dark behind `CALLBACK_RAIL_ENABLED` (default off; POST/GET 404 while off) and the call/text links additionally require `CALLBACK_PHONE` (unset by default — with no number configured NOTHING renders, there is no fallback and no number anywhere in this repo). Two independent switches; flag-on-with-no-phone is a supported state. The DESK side is deliberately NOT gated on either, so it works the instant the flag flips. See lib/callbackRail.ts and docs/ENV-REGISTRY.md.

### Next Follow Up At (**date**, fldLpCco9KGJf1LxN) — the promised-callback rail
W: app/api/admin/follow-ups/[id]/route.ts (POST, admin) — the two buttons on the desk's "⏰ Follow up today" row. `action:'done'` writes **null** (promise kept, stops coming due) AND stamps `Last Contacted`; `action:'snooze'` writes today+N where N ∈ lib/followUpQueue.FOLLOW_UP_SNOOZE_DAYS (3, 7). Snooze advances from TODAY, never from the missed date — +3d on a three-week-old promise would write a date still in the past and the row would visibly ignore the button.
W: app/api/admin/consumers/[id]/route.ts (PATCH, admin) — `next_follow_up_at` in the body. An explicit blank/null clears it; anything else must pass validateFollowUpDate or the PATCH 400s.
R: **lib/followUpQueue.selectDueFollowUps is the single definition of "due"** — consulted by app/api/admin/desk (the "⏰ Follow up today" section, ranked directly BELOW the callback bucket and ABOVE every cold bucket) AND app/api/cron/daily-health-digest (the morning Telegram block — absorbed from the deleted daily-digest 2026-08-02 #532). Desk pre-filters in Airtable with `NOT({Next Follow Up At}='')` — "is it set", nothing more; the digest reuses the digest's existing unfiltered Consumers read and adds ZERO Airtable calls.
Sem: **DATE field, not dateTime** — Airtable stores/returns a bare `YYYY-MM-DD`. Every comparison in lib/followUpQueue is calendar-STRING comparison, and day arithmetic is anchored at UTC noon. Do NOT "simplify" this to `Date.parse(due) <= Date.now()`: (1) `Date.parse('2026-08-02')` is midnight UTC, which is 6pm the previous day in Denver, so every follow-up reads as due six hours early; (2) differencing two local midnights across a DST boundary yields 22.96 days and floors to 22, so "days overdue" is off by one for part of every year. This is also why the due/not-due call is NOT pushed into an Airtable formula — Airtable compares in UTC and would disagree with the JS side about what "today" is. "Today" means BEN's day: lib/followUpQueue.operatorToday() (America/Denver, the repo's operator timezone — see lib/aiTools.ts, lib/email.ts pre-call brief). DUE = date set AND <= today AND not Unsubscribed/Bounced/Complained AND `Buyer Stage` != CLOSED. Fails toward SILENCE (an unresolvable "today" selects nothing) — the opposite of the callback rail next door, because the wrong-way default here is blasting every promise ever recorded into a digest, and a digest that cries wolf gets muted. The digest section renders as the empty string when nothing is due, adding not one line of noise.
Landmine: **this rail never contacts the buyer.** It is an OPERATOR reminder — Ben's follow-ups are phone calls. No email, no SMS, ever.
Landmine: two similarly-named neighbors — `Last Contacted` (fldRT9Tu9E96NbzYp, **dateTime**, what the done action stamps) vs `Last Contacted At` (fldPIn36SShCdEQB2, **date**, the demand-router's). lib/demandRouter reads BOTH for cooldown (max wins), so stamping the wrong one still suppresses marketing but writes a shape the field can't hold.

### Link fields: Referalls / Payments / Affiliates / Preferred Rancher
Referalls (single-L typo IS the schema name): **zero code references** — auto-maintained reverse of Referrals.`Buyer` (written at lib/reserveDeposit.ts:222, lib/bulkRoute.ts:268, every referral create). Payments: reverse of Payments.`Buyer` (lib/contracts/payments.ts:250). Affiliates: reverse of Affiliates.`Linked Consumer` (lib/affiliates.ts:220); companion scalars Affiliate Code/Created At written at contracts/rancher.ts:398-403; attribution INTO the system is scalar `Referred By` (consumers :712, reserve :230-231; read at contracts/rancher.ts:370). Preferred Rancher: consumers :734 only.
Sem: never write reverse-link fields directly; decision readers operate on the OTHER table's side (`ref['Buyer']`).

---

## Payments (`tblPfESJ4lxwtGThy`) — money ledger

**The live row-creators are TWO** (2026-07-31), one per charge rail:
1. `recordDeposit` (lib/contracts/payments.ts:241-378; create :344, reuse-update :337), called
from exactly ONE place: app/api/checkout/deposit/route.ts — the buyer's pay-click POST, after
the Stripe session is minted, before redirect. CONNECT rail.
2. `recordBrokerDeposit` (same file), called from exactly ONE place:
app/api/checkout/broker/route.ts. **BROKER rail** — writes `Platform Fee Cents` ===
`Amount Cents` (BHC keeps 100% of the charge; recording a 0 fee would under-count broker
revenue by its entire value), `Type`='broker_deposit', **no `Tier`** (a represented rancher
has no subscription tier and the singleSelect has no truthful choice — writing one would
corrupt tier-sliced reporting), and **no `Stripe Connect Account Id`** (there is no connected
account; the charge is on BHC's own platform account). Its dedup query is SCOPED TO THE
REFERRAL when the PI id is empty, deliberately avoiding the table-wide empty-PI match
documented under `Stripe Payment Intent Id` below.
Webhooks never create Payments rows; they only mutate them. Both rails settle through the
same `markDepositSucceeded` anchor.
**Historical second writer (REMOVED 2026-07-14, #369 commit 3c2fcd3)**: request-TIME
creators in app/api/rancher/referrals/[id]/request-deposit (added #154) and
app/api/admin/send-deposit-invoice (added desk-v3) wrote a different shape —
Type='buyer_deposit', Buyer Email, Stripe Connect Account Id, NO Created At / Platform
Fee Cents / Buyer link / Referral Id Text. Any row with Type='buyer_deposit' today is a
pre-2026-07-14 fossil. The dup mechanism: the fossil row's PI never matches the pay-click
session's PI, and it lacks Referral Id Text, so recordDeposit's reuse gate can't see it
→ a second Type-blank row is always created; only that one settles; the fossil sits
pending until the reaper flips it 'abandoned'.

### Stripe Payment Intent Id (singleLineText)
W: payments.ts:255 (create — EMPTY under Clover, PI minted at pay-time), :326 (reuse re-stamp), :468 (settle-time backfill via referral fallback); orphan-checkout-reaper :248 (backfill from checkout.sessions.retrieve).
R: the universal lookup key — payments.ts:426 (settle), :521 (abandon), :563 (replay), :596 (refund), :955 (dispute); webhooks/stripe :423 (requires_action); stripe-connect :1423 (fraud warning); recordDeposit dedup :300.
Sem: LANDMINE — assumed unique, NOT enforced; every lookup takes `[0]` with NO Status filter. Clover bonus landmine: at create PI='' and the dedup formula `{Stripe Payment Intent Id}=""` (:300) matches EVERY empty-PI pending row table-wide; reuseFields (:322-336) re-stamps Referral Id Text but NOT the Referral link → link and denorm can point at different referrals.

### Referral (link) + Referral Id Text (singleLineText)
W: link — payments.ts:243 (create only; reuse never relinks). text — :249 (create), :330 (reuse backfill), :482 (settle-time backfill).
R: text is the by-referral rail — paymentsByReferralFormula :95 → findPaymentsByReferral :123: settlement fallback :446 (Clover), fulfillment gate app/api/rancher/fulfillment/confirm/route.ts:82, deposit-accept-sla :80, deposit-request-nudge :169, demandRouter :865, checkout/deposit :609, reaper cross-check :560-563. link — restoreReferralAfterRefund :710; reaper rewarm :439.
Sem: the LINK field is dead for formulas (Referrals' primary field is empty ⇒ ARRAYJOIN never matches) — the text denorm is load-bearing.

### Amount Cents (number)
W: payments.ts:253/:324 — the rancher-portion DEPOSIT only, never the charged total.
R: refund-cap math admin/payments/refund/[paymentId]/route.ts:152-160 + payments.ts:615-623 (full-refund detection); fulfillment confirm :88; reaper stamp-heal :578; weekly-scorecard :69; command-center :134-139.
Sem: see also `Total Charged Cents` (payments.ts:485 — deposit + platform fee), which refund caps prefer; if that field is missing from the base every settle silently strips it and refund caps degrade.

### Platform Fee Cents (number)
W: payments.ts:254/:325 ONLY — computed app-side at checkout/deposit :315-320 as `absorbStripeFee(round(fullSaleCents × feeRate))`, mirroring the application_fee_amount sent to Stripe (lib/stripeConnect.ts:501; final invoice deliberately omits a fee :742). Never read back from Stripe objects.
R: lib/commissionStats.ts:99,106 (succeeded-only fee revenue) → admin health :147, command-center :148, referrals/stats :103, analytics :203; refund math (above); admin/payments/data :95.
Sem: LANDMINE — **the ONLY persistence of the buyer-paid Connect fee anywhere in the system**. The Referral never records it (app/api/referrals/[id]/route.ts:94). settleBuyerDeposit reads pi.metadata.platformFeeCents (lib/stripeSettlement.ts:103) but only for Telegram/audit.

### Status (singleSelect: pending|succeeded|refunded|failed|abandoned)
W: 'pending' payments.ts:256/:327; 'succeeded' :461/:492 (markDepositSucceeded); 'abandoned' :398/:531 (+:407/:544) via orphan-checkout-reaper (reasons: clover_session_expired_no_pi :262, stripe_status=<canceled|requires_payment_method> :403, webhook_missed_succeeded :358); 'requires_webhook_replay' :572/:578 (typecast — not a schema choice); 'refunded' :634/:647 (FULL refunds only — partial keeps 'succeeded'); 'awaiting_auth' webhooks/stripe :429 (typecast). 'failed' has NO writer (dead choice — payment_intent.payment_failed only Telegrams, stripe :383-398).
R (filter on Status): reaper pending-scan :143-146 + succeeded cross-check :558-561; weekly-scorecard :64-66; fulfillment confirm :83; checkout/deposit :609; commissionStats :98,106 (feeds all money tiles); command-center :129-130; refund route :48-56 (422 unless succeeded); recordDeposit dedup :300/:313 + selectReusablePaymentRow :205-216 (pending only); idempotency guards :395,:453,:528,:568,:626.
R (do NOT filter — a hypothetical 'duplicate' status row would still flow through): admin/payments/data :26 (raw list); command-center :77; analytics :50,:61,:148-155; referrals/stats :102; health :40; and the three findPaymentsByReferral callers with no status clause — demandRouter :865, deposit-request-nudge :169, deposit-accept-sla :80 — which pick `find(refunded/disputed) || payments[0]`.
Sem: any dedupe scheme that marks rows 'duplicate' must first fix the unfiltered readers above, especially the PI-keyed `[0]` lookups.

### Created At / Captured At / Refunded At (dateTime)
W: Created At — payments.ts:257 create only (legacy rows blank → readers fall back to _createdTime). Captured At — :463/:494 at settle. Refunded At — :632/:646 (partial AND full).
R: reaper 48h cutoff :159-171 + heal window :560,:576; weekly-scorecard :65; analytics :61; refund/dispute exclusion predicates lib/depositSla.ts:68-73, lib/reserveRecovery.ts:115.

### Refund Reason / Refunded Amount Cents
W: payments.ts:635/:636-638 — webhooks pass charge.amount_refunded (CUMULATIVE — stripe :629-633, stripe-connect :347-366, no reason); admin refund route :227-234 passes reason + accumulated total.
R: refund route net-refundable cap :159; command-center net-collected :134; admin/payments/data :98.

### Dispute Status / Amount / Reason / Updated At
W: markDepositDisputed payments.ts:964-969 — LANDMINE: Dispute Amount written in DOLLARS (/100), unlike every other cents field. Triggers: webhooks/stripe :1814 + stripe-connect :987 (charge.dispute.*; product PIs short-circuit :279).
R: same SLA/nudge/demandRouter exclusion predicates as Refunded At — non-empty Dispute Status ⇒ excluded forever, INCLUDING won disputes.

### Type (singleLineText)
W: NOBODY today (removed 2026-07-14 — see header). R: nobody.
Sem: fossil discriminator. Type='buyer_deposit' ⇒ pre-#369 request-time row.

### Buyer Email / Stripe Connect Account Id (Payments fields)
W/R: none today — historical request-time creator only. Fossil fields (the reaper re-derives the Connect acct from the Rancher link :203-217).

### Stripe Checkout Session Id
W: payments.ts:264/:335 (from checkout/deposit :409).
R: reaper Clover heal :190/:229 — session → PI when PI empty.

### Abandoned At / Abandoned Reason
W: payments.ts:398-401, :531-534, :573-574 (reasons above). R: none.

### Fraud Warning At / Type
W: stripe-connect :1464-1467 on radar.early_fraud_warning.created (visibility-only). R: none.

### Payouts (link)
Dead — only feeder is zero-caller `releasePayout` (payments.ts:991-1009); billing UI reads live Stripe payouts (app/api/rancher/billing/data/route.ts:120-128).

---

## Stripe Events (`tblPiw7jB7Mm7OxeN`) — webhook idempotency log

Shared idempotency table for FOUR webhook routes (not just Stripe): platform stripe,
stripe-connect, shopify (key = shop-scoped order id, lib/shopifyOrderIngest.ts:39), and
cal (key `cal:<trigger>:<bookingId>`). Cross-webhook it gives ZERO protection (event ids
differ per endpoint) — dual-delivery safety lives in claimOnce + the Payments.Status
anchor (stripe-connect :423-442).

### Event Id (singleLineText)
W: create-'received' at top of each route — webhooks/stripe :102, stripe-connect :199, shopify :262, cal :147.
R: the dedupe gates — stripe :96-98, stripe-connect :194-196, shopify :257-259, cal :137-144.

### Status (received|processed|failed|skipped_duplicate)
W: 'received' at create; 'processed' at end-of-handler — stripe :842-845, stripe-connect :544-547, cal :93-96; **shopify flips Status only, never Processed At (:308)**; 'failed' via flipStripeEventFailed — stripe :2469-2482, stripe-connect :1563-1576 (inlined copy) on handler failure before 5xx-retry/200-permanent. 'skipped_duplicate' has NO writer — duplicate deliveries return early without touching the row.
R: the four dedupe gates — ONLY Status='processed' short-circuits; 'received'/'failed' rows deliberately re-process on redelivery (the retry rail). Shopify extra: dedupe-store unavailable ⇒ skip decrement entirely (fails closed, :274-277).

### Event Type / Account Id / Received At / Processed At / Error
W: Event Type — stripe :104, connect :200, shopify :265, cal :149. Account Id — stripe :105, connect :201, shopify :266 (shop domain), cal none. Received At — all four create sites. Processed At — end-of-handler (not shopify). Error — flipStripeEventFailed (500-char cap).
R: Received At — 60-day TTL purge only (log-retention cron :37). Others: ops/forensics only.

---

## Rancher Orders (`tblcr5HVycBm2b2ld`) — low-ticket product rail

> **BUYER-FACING READER (new 2026-08-01)**: `app/order/[id]/page.tsx` — until then the
> ONLY non-admin/non-rancher/non-cron reader of this table was the reviews query, i.e.
> the buyer had no order surface at all. The `[id]` segment is a SIGNED token
> (lib/orderStatusLink.ts, `purpose:'order-status'`, 180d, read-only, order-scoped) —
> a raw record id in that slot fails verification. The view model is pure +
> tested in lib/orderStatusView.ts. Minted into: the product receipt
> (lib/productSettlement.ts), the shipped/picked-up mail (app/api/rancher/orders),
> `buyer_refund_notice` and `buyer_order_delay` (lib/emailMinimal.ts).

Single row-creator for the whole table: lib/productSettlement.ts:175 (`settleProductPurchase`,
fired from the stripe-connect webhook on `payment_intent.succeeded` w/ metadata.type=
'product_purchase'; re-driven by app/api/cron/product-settlement-net/route.ts:110 which
re-derives missing rows from Stripe truth via `{Stripe Payment Intent}` lookup :98).

### Order Ref (singleLineText)
W: lib/productSettlement.ts:178 — settlement; template `${DEPOSIT — }${PICKUP — }${qty× }name — buyer`.
R: lib/fulfillmentPush.ts:19-20 — DEPOSIT/PICKUP prefix blocks external push; lib/productFulfillmentSla.ts:36-40 orderKind() — deposit/pickup get slow SLA windows (7/14d vs 3/6d); app/api/rancher/orders/route.ts:55,60,142.
Sem: LANDMINE — **NOT unique** (repeat buyer + same product ⇒ identical refs; lib/fulfillmentConnector.ts:31-33). Dedup NEVER keys on it: the Shopify tag `BHC-oid:<rowid>` is minted at lib/shopifyConnector.ts:35 (dedupToken = Rancher Orders record id, lib/fulfillmentPush.ts:35), checked pre-create :52-64 + :140-149, backstopped by Idempotency-Key = sha256(rowid) (:44-45).

### Stripe Payment Intent (singleLineText)
W: lib/productSettlement.ts:192.
R: lib/productSettlement.ts:142-149 — redelivery dedup (THROWS on lookup error ⇒ webhook 5xx, never silent dup) + post-create race guard :205-211 (lowest record id wins); :502-510 refund reconcile lookup; app/api/cron/product-settlement-net/route.ts:98 (lib/productSettlementNet.ts:33-44).
Sem: THE idempotency key of the product rail.

### Status (singleSelect New|Shipped|Delivered|Refunded|**Cancelled** ⚠️ NEW OPTION)
W: lib/productSettlement.ts ('New' at settle); app/api/rancher/orders/route.ts ('Shipped', rancher POST); app/api/webhooks/shopify/route.ts:366 via lib/shopifyWebhookGuards.ts:94-96 ('Shipped' on fulfillment webhook when current='New'); lib/productSettlement.ts `reconcileProductOrderRefund` (terminal status on full refund/dispute — ALL rows for the PI; `opts.terminalStatus` selects 'Refunded' or 'Cancelled', default 'Refunded'); **app/api/rancher/orders/refund/route.ts (NEW 2026-08-01) — flips the terminal status BEFORE the Stripe refund as its fail-closed gate, and reverts to 'New' if the refund fails.**
R: app/api/rancher/orders/route.ts — 409 on Refunded **and Cancelled** ("refund never ships") / already-Shipped; lib/productOrderTermination.ts `decideTermination` (TERMINAL_STATUSES / SHIPPED_STATUSES); lib/fulfillmentPush.ts:21 — push requires 'New'; app/api/cron/fulfillment-push-net/route.ts:88; lib/fulfillmentPushRunner.ts:81 (Refunded/Cancelled after push ⇒ cancel external), :150; lib/shopifyCatalogSync.ts:139,157-158 (terminal drops M4 obligation); lib/fulfillmentWebhookHealth.ts:25 (RESOLVED_STATUSES); app/api/cron/product-review-ask/route.ts:58; lib/orderStatusView.ts `orderStateFromStatus` (buyer page).
Sem: the rail's state machine. "Refund never ships" enforced FOUR-deep: `decideTermination` refusal, dashboard 409 (now covering Cancelled), push gate, post-push re-read cancel.
⚠️ **BEN: 'Cancelled' must be added to the single-select.** Until then the refund route's step-1 write 422s → it refuses BEFORE moving any money and rings Telegram (fail closed, correct). The webhook path degrades differently on purpose: `reconcileProductOrderRefund` falls back to 'Refunded' rather than leave a refunded order in 'New'. 'Canceled' (one L) is tolerated on READ only — imported data.

### Buyer Paid / Rancher Payout / BHC Margin (currency trio)
W: lib/productSettlement.ts:188-190 — settlement only; `computeSettlementMoney` :63-82: paid = display×qty + shipping; payout = base×qty + shipping; margin = metadata.marginCents (whole-order application fee) else legacy (display−base)×qty. Upstream: metadata minted lib/productCheckout.ts:181 (applicationFeeCents = gross margin − absorbed Stripe fee, `absorbStripeFee` :89-95); charged as application_fee_amount at lib/productCheckout.ts:290 + lib/productPaymentIntent.ts:73 (shipping never skimmed).
R: app/api/admin/command-center/route.ts:179-180 (P&L); app/api/cron/weekly-scorecard/route.ts:80; app/api/rancher/earnings/export/route.ts:105-106.
Sem: invariant Buyer Paid − Rancher Payout === BHC Margin (when no Stripe fee absorbed); marginCents must NEVER be re-multiplied by qty (old multi-unit inflation bug). Settlement refuses base>display (:127-131).

### Ordered At (dateTime)
W: lib/productSettlement.ts:194 — always at settle.
R: lib/fulfillmentPushSelect.ts:116-117,143-147 — oldest-first + 3-day sweep window + aged backstop; :156-159 stale-'pushing' fallback clock; product-fulfillment-sla :107; weekly-scorecard :79.
Sem: the rail's monotonic clock.

### Shipped At / Refunded At / Cancelled At (⚠️ Cancelled At is NEW)
W: Shipped At — orders route + shopify webhook flip (:366 via guards :96). Refunded At — `reconcileProductOrderRefund` (written for BOTH terminal statuses). Cancelled At — `reconcileProductOrderRefund` (cancel branch) + app/api/rancher/orders/refund/route.ts, each in its OWN best-effort patch.
R: product-review-ask :58,67-71 — 3-45d review window off Shipped At; lib/productOrderTermination.ts — a 'Shipped At' stamp ALONE refuses a cancel even if Status still says New; lib/orderStatusView.ts — Cancelled At wins over Refunded At on the buyer page.
Sem: Cancelled At is never folded into the Status patch — an unknown field name 422s a whole Airtable patch, and that patch is the ship-rail gate.

### Tracking Number / Shipping Carrier (⚠️ Shipping Carrier is NEW)
W: Tracking Number — app/api/rancher/orders/route.ts POST (skipped on pickup orders); shopify fulfillment webhook. Shipping Carrier — the SAME POST, in a SEPARATE best-effort patch (never folded into the mark-shipped write: a 422 there would take the whole ship rail down until the field exists).
R: lib/trackingLink.ts `carrierTrackingUrl` — buyer shipped email, the rancher order card, and lib/orderStatusView.ts. Unknown/blank carrier ⇒ a Google search URL (always useful); an unusable number ⇒ null ⇒ render NOTHING.
Sem: before 2026-08-01 the product rail had no carrier at all and emailed a bare number in bold — the SHARE rail has had clickable tracking since D3.

### Buyer Delay Notified At (⚠️ NEW)
W: app/api/cron/product-fulfillment-sla/route.ts — CLAIM-BEFORE-SEND WITH READ-BACK: stamp, re-read the row, and only send `buyer_order_delay` if the stamp actually persisted.
R: lib/productFulfillmentSla.ts `slaDecisions` — non-blank ⇒ `notifyBuyer:false` forever.
Sem: this is the throttle that lets `buyer_order_delay` sit on the TRANSACTIONAL_WHITELIST (lib/emailFrequencyGuard.ts). A failed write — or the field not existing yet — yields ZERO mails, not one per cron run. That fail-closed direction is the whole argument; do not "simplify" it to a fire-and-forget stamp.

### Quantity (number)
W: lib/productSettlement.ts:191 (clamped ≥1).
R: :575 refund restores ALL units; lib/fulfillmentPush.ts:41; lib/shopifyCatalogSync.ts:168,187 — M4 obligation counts UNITS not rows.

### External Order Id (singleLineText)
W: lib/fulfillmentPushRunner.ts:195 (verify-failed: id stamped, status stays 'pushing'), :227 (post-push cancel), :254 (success).
R: lib/fulfillmentPushRunner.ts:42 — presence ⇒ skip 'already-pushed' (hard anti-double-ship); lib/fulfillmentPush.ts:22; lib/fulfillmentPushSelect.ts:56,121-124; lib/productSettlement.ts:601-612 — refund cancel target (blank ⇒ belt-stamp 'cancelled'); shopify webhook :342 matches rows by it (rancher-scoped, lib/shopifyWebhookGuards.ts:26-30).
Sem: Shopify GID. Presence alone blocks re-push regardless of status.

### External Push Status (singleLineText state machine)
W (lib/fulfillmentPushRunner.ts): :141 'pushing' pre-stamp BEFORE network call; :151 revert '' on transient fail (only if Status still 'New'); :108 `skipped:<reason>` (but 'no-integration' left BLANK so later Shopify connect gets swept :102-110); :196 'pushing' kept on verify-failed; :228 'cancelled'/`cancel-failed:*`; :255 'pushed'; :260 `pushed-unstamped:<id>`; :279 `failed:<error>`; :309 'failed:config'; lib/productSettlement.ts:610,623 refund-path 'cancelled'.
R: **M4 obligation predicate = `push ∉ {pushed, cancelled}`** — lib/shopifyCatalogSync.ts:156-161 `isUnpushedObligation` ('pushing', 'skipped:*', '', 'failed:*' ALL count as obligations); lib/fulfillmentPushSelect.ts:115,137-166 — cron routing ('' within 3d or aged; stale-'pushing' >30min re-sweep; failed:* only via retry flag); lib/fulfillmentPushRunner.ts:43-46,82-84; orders route :156 — 'pushed' suppresses BHC tracking email; product-fulfillment-sla :39,96.
Sem: **post-push guard FAILS CLOSED** — `decidePostPushAction` lib/fulfillmentPushRunner.ts:73-85: readOk=false ⇒ 'verify-failed' (never 'keep'); a live Shopify order with unconfirmable BHC row stays 'pushing' + alerts loud rather than silently 'pushed'.

### External Pushed At (dateTime)
W: runner :197,229,256.
R: lib/fulfillmentPushSelect.ts:48-51,157-158 — staleness clock (falls back to Ordered At); product-fulfillment-sla :45.

### Stock Restored At (dateTime)
W: lib/productSettlement.ts:647-649 — once, after the refund restore+cancel pass (best-effort).
R: :550 `stockAlreadyRestored` — skips re-restore (:569)/re-cancel (:599) on redelivery/concurrent reconcile.
Sem: durable idempotency under `claimOnce('reconcile-refund:<pi>')` (:543, fails OPEN without Redis). Inventory loop: settle decrements product Orders Left (:385-386, oversell alarm :374-384), refund restores (:571-576), this marker = exactly-once restore.

### Push Retry Requested At (dateTime)
W: operator-set BY HAND (every failure alert instructs it — runner :126,289,321); CLEARED by cron app/api/cron/fulfillment-push-net/route.ts:128.
R: lib/fulfillmentPushSelect.ts:120-134 — window-independent top-priority retry; the ONLY path that recovers `failed:*` rows.

### SLA Nudged At (dateTime)
W: app/api/cron/product-fulfillment-sla/route.ts:76 (webhook-health alert stamp), :179 (day-3 rancher nudge).
R: :46,108 — blank required to fire; lib/fulfillmentWebhookHealth.ts:12-17,32,46 — deliberately OVERLOADED as the health-alert marker (safe: SLA loop filters out pushed orders :96).
Sem: one nudge per order EVER.

### Review Asked At / Buyer Rating / Buyer Review / Review Submitted At
W: ask — product-review-ask :97-98 CLAIM-BEFORE-SEND w/ read-back verify (:100-104 aborts run if stamp doesn't persist). Review trio — app/api/reviews/submit/route.ts:116-120 (JWT-linked).
R: reviews/submit :106-112 — Submitted At set ⇒ 409; product-review-ask :67; app/shop/[id]/page.tsx:190-193.

### Product Record ID / Rancher Record ID / Buyer Email (denorm keys)
W: lib/productSettlement.ts:181,184,185 (buyer email fallback chain :91-95,159-169 — may legitimately be blank).
R: Product Record ID — refund stock-restore :568; push SKU gate lib/fulfillmentPushRunner.ts:97-98; M4 index lib/shopifyCatalogSync.ts:185. Rancher Record ID — ownership filter orders route :26,83,93,119; scoped fulfillment webhook lib/shopifyWebhookGuards.ts:26-30; integration load :615,673. Buyer Email — product-review-ask :58 (non-blank required); orders route :156-157 (tracking email suppressed when pushed).

---

## Rancher Products (`tblLg8t1BztZpWKV2`) — catalog

Writer set: lib/shopifyCatalogSync.ts (sync engine), app/api/rancher/products/route.ts
(self-serve), lib/productSettlement.ts (stock), app/api/webhooks/shopify/route.ts:292
(direct-store decrement), app/api/webhooks/telegram/route.ts:5064 (approve),
app/go/store/[id]/route.ts:51 (click counter), app/api/checkout/product{,/buy}/route.ts:110/:94
(Stripe-id self-heal).

### Display Price (currency)
W: app/api/rancher/products/route.ts:162 via lib/rancherProductInput.ts:254 (rancher enters RETAIL); lib/shopifyCatalogSync.ts:71 — sync writes ONLY when markupPercent set (`computeDisplayPrice` :18-21), :346-348 first-create default = Rancher Base; hand-set prices survive updates.
R: lib/marketplaceProducts.ts:107-115 `isSellableRow` — price>0 && base≤price (negative-margin fence); lib/productBuyGates.ts:86-90 — charge-time cents; products route :258-263 sync fence blocks self-serve edits on synced rows.
Sem: buyer pays this; margin = Display − Base becomes the Connect application fee.

### Rancher Base (currency)
W: products route :164/:358 — DERIVED from category margin (`deriveProductPricing` :156-159; every price edit re-derives); lib/shopifyCatalogSync.ts:70 — sync mode: base = store's own price.
R: lib/productBuyGates.ts:87; isSellableRow base≤price.
Sem: rancher's per-unit net. Deposit-style rows: HAND-SET by ops — content-edit fence products route :282-287 protects it.

### Orders Left (number, blank = unlimited)
W: lib/productSettlement.ts:386 — settle decrement (clamped ≥0, oversell alarm :374-384); :576 — refund restore (guarded by Stock Restored At); shopify webhook :292 via lib/shopifyOrderIngest.ts:62-78 — real-time decrement on the rancher's OWN store sales (BHC-origin skipped :235-238; durable Stripe-Events idempotency :252-279; flips Active off at 0, never on); lib/shopifyCatalogSync.ts:72 — 6h sync writes `max(0, shopifyQty − outstandingObligation)` (M4 guard :59-64 — never re-shelve a settlement-decremented unit; untracked stock ⇒ 999); products route :294-304 stock-only PATCH.
R: lib/marketplaceProducts.ts:123-127 `hasStock` — blank=unlimited, else >0, gates listing AND charge (lib/productBuyGates.ts:105, qty≤Orders Left); telegram approve :5064-5067 (Active only when in-stock); product-stock-checkin :84 (monthly human check-in).
Sem: no atomic decrement in Airtable — off-by-ones tolerated, self-correct at monthly check-in.

### Active (checkbox)
W: products route :167 (create, auto-live unless REQUIRE_PRODUCT_APPROVAL :45,161), :324 (hide/show; re-show requires Connect-active :314-321); lib/shopifyCatalogSync.ts:73 — COMPUTED for synced rows (approved && store ACTIVE && qty>0); :215/:321/:421 — false on uninstall / guard-delist (share-fence/$5 floor :123-126) / SKU-gone (only after COMPLETE pagination :415); telegram approve :5066; lib/shopifyOrderIngest.ts:62,78 (false at zero stock).
R: lib/marketplaceProducts.ts:110/:138 — listing gates; lib/productBuyGates.ts:73 — charge-time 404/409; sync delists only rows `Sync Managed && Active` (:124,:418).
Sem: on sync-managed rows it is DERIVED — manual flips revert within 6h.

### Sync Managed (checkbox)
W: lib/shopifyCatalogSync.ts:74 (true on every sync write); never unset by code.
R: :360 — sync only overwrites rows it owns; products route :258-263 PATCH 409 fence + :427-431 DELETE 409 (cron would resurrect by SKU); telegram approve :5051.
Sem: engine-owned vs hand-created marker (lib/syncManagedProductFence.ts:4-28).

### Marketplace Approved (checkbox)
W: telegram approve :5065 (only code writer; Ben can also tick in Airtable).
R: lib/shopifyCatalogSync.ts:338 → feeds Active computation (:73); new imports unapproved ⇒ never on /shop unseen.
Sem: the one-time human curation gate for synced catalogs.

### External SKU (singleLineText)
W: lib/shopifyCatalogSync.ts:68 (variants without SKU are skipped — SKU is the join key).
R: lib/fulfillmentPush.ts:24,40 — no SKU ⇒ push gate 'no-sku'; sync dedupe key (rancher, SKU) :258-262,329; shopify webhook decrement lookup :286-288 (scoped rancher+SKU — SKUs collide across stores); telegram approve :5054.
Sem: the store↔BHC join. Rancher Orders has no SKU — order→product goes through Product Record ID.

### Stripe Product Id / Stripe Price Id / Stripe Price Cents
W: products route :183-187 (pre-mint, best-effort); checkout/product :110-114 + /buy :94-98 (lazy self-heal).
R: lib/productStripeSync.ts:14 — Price Cents is the reuse guard (price unchanged ⇒ reuse Price object).
Sem: cache of connected-account Stripe objects; a failed sync never blocks a sale (inline price_data fallback).

### Shipping Cost (currency) — ⚠️ 0 ≠ blank as of 2026-08-01
W: lib/rancherProductInput.ts `resolveShippingChoice` via validateProductInput ($0-200); products route explicitly preserves + threads it on content edits (old bug silently cleared it).
R: lib/productBuyGates.ts:99 — added to the charge (pickup ⇒ 0); lib/productCheckout.ts:200,246; lib/storefrontGates.ts `chargedShippingDollars`; products route `toClientProduct` → `shippingChoice`.
Sem: passes 100% to the rancher (payout math lib/productSettlement.ts); NEVER part of the application fee. **Tri-state now: `>0` = buyer pays it · `0` = the rancher answered "my price already includes shipping" · BLANK = this listing predates the question and the form must ask.** Every consumer coerces `Number(x || 0)` so 0 and blank charge identically — the distinction is a RECORD of the rancher's answer, not a money change.

### Shipping Included (checkbox) — ⚠️ NEW
W: app/api/rancher/products/route.ts `stampShippingIncluded` — ALWAYS its own best-effort patch, never inside the create/update payload (an unknown field name 422s the whole write and would take the listing rail down until the field exists). Not written for local-pickup rows (question not asked).
R: products route `toClientProduct` → `shippingChoice`, and the PATCH merge (so an already-answered listing is never re-asked).
Sem: the human-readable twin of `Shipping Cost === 0`. The answer survives without it; this field is what makes it legible in Airtable.

### Ships In Days (number) — REQUIRED for shippable rows as of 2026-08-01
W: lib/rancherProductInput.ts via validateProductInput — 1-60, and now REQUIRED when Ships Nationwide (optional on local-pickup rows). Sync-managed rows are written by the catalog cron and never pass through the validator.
R: app/shop/checkout/[id]/page.tsx:172 + app/shop/[id]/page.tsx — the promise the buyer is quoted; **app/api/cron/product-fulfillment-sla/route.ts `loadShipPromises` → lib/productFulfillmentSla.ts `slaWindowFor`** — the SLA windows now ride it (nudge @ promise+1, escalate @ promise+4; flat 3/6 only when absent); lib/orderStatusView.ts `promisedShipByIso` (buyer page "expected to ship by" + runningLate).
Sem: was quoted to buyers and compared against nothing — a 1-day promise wasn't chased until day 3, a 14-day promise was nudged on day 3. Non-breaking: existing rows keep selling and are asked on their next edit.

### Deposit Style (checkbox)
W: no code writer — ops-set in Airtable only.
R: products route :282-287 content-edit 409 fence, :418-423 DELETE fence; lib/productBuyGates.ts:92 — qty forced 1; checkout stamps metadata.depositStyle → `DEPOSIT — ` Order Ref prefix (lib/productSettlement.ts:112,178) → no push, slow SLA.

### Ships Nationwide (checkbox)
W: lib/rancherProductInput.ts:259 (default true; explicit false = local pickup).
R: lib/marketplaceProducts.ts:111 (`!== false` lists on /shop) vs :137 (pickup rows, ranch page only); lib/productBuyGates.ts:81.

### External Checkout URL / External Clicks / Last External Click At (BYOC Tier-2)
W: URL — lib/rancherProductInput.ts:260 (validated). Clicks — app/go/store/[id]/route.ts:49-54 (best-effort increment per redirect).
R: app/go/store/[id]/route.ts:38-46 — valid URL ⇒ 302 to rancher's own store, else PDP fallback.
Sem: attribution only; no settlement rides this rail.

---

## Cross-table invariants (pin these before touching any writer)

1. **No-double-ship**: unique `BHC-oid:<rowid>` tag (lib/shopifyConnector.ts:35) + Idempotency-Key (:44-45) + decidePushDisposition (lib/fulfillmentPushRunner.ts:41-47) + durable 'pushing' pre-stamp (:140-142).
2. **Refund-never-ships**: `decideTermination` refusal (lib/productOrderTermination.ts) + orders route 409 on Refunded AND Cancelled + push gate Status='New' (lib/fulfillmentPush.ts:21) + fail-CLOSED post-push verify (runner :73-85) + belt-stamp 'cancelled' on blank-id refunds (lib/productSettlement.ts). The rancher/admin-initiated path flips Status BEFORE calling Stripe, so the ship rail closes before the money moves — and reverts to 'New' if Stripe refuses.
3. **Inventory coherence**: settle-decrement (:386) ↔ refund-restore (:576) guarded by Stock Restored At; M4 obligation `push ∉ {pushed,cancelled}` (lib/shopifyCatalogSync.ts:156-161) keeps the 6h sync from re-shelving sold units.
4. **No-silent-fail**: every terminal push failure stamps a status AND alerts with recovery instructions (runner :120-130,285-293,316-325); product-settlement-net re-derives lost rows from Stripe truth (lib/productSettlementNet.ts:7-14).
5. **Money-truth gets persisted, not logged** (repo rule #2): every send/open/paid outcome stamps the record; pre-payment writers of Status='Awaiting Payment' MUST stamp Deposit Requested At.
