# ENV REGISTRY — every environment variable, what it does, how it fails

> Auto-generated from a full code sweep 2026-07-14. THE reference for "what env vars do I need."
> ⚠️ = load-bearing: silent absence breaks money or comms. The email-canary/watchdog rails monitor these.

**176 variables · 26 load-bearing** (+8 prod-set orphans documented in the last section — set in Vercel but read by no code). Owner legend: **ben-flips** = a business switch you toggle deliberately · **set-once** = key/secret, set correctly and forget (watchdog guards it) · **code-default** = safe fallback exists.


## 💰 Money-critical

| Var | Purpose | Fails | Owner |
|---|---|---|---|
| `AFFILIATE_COMMISSION_RATE` | Affiliate payout rate, default 0.05 | fail-open | code-default |
| ⚠️ `AIRTABLE_API_KEY` | The database. Unset → console.warn at import then every table read/write throws — site-wide breakage of money records and routing | fail-loud | set-once |
| ⚠️ `AIRTABLE_BASE_ID` | Which Airtable base; same warn-then-throw-everywhere as the API key | fail-loud | set-once |
| `COMMISSION_RATE_DEFAULT` | Fallback commission when rancher has no tier, default 0.10 | fail-open | code-default |
| ⚠️ `CRON_SECRET` | Bearer auth for all ~20 crons (batch-approve, nurture, dunning, recovery); missing → secrets.ts throws (loud 500), but a Vercel-side mismatch → 401s and every automated rail silently stops | fail-loud | set-once |
| `FOUNDING_100_CAP` | Founding 100 spot cap, default 100 | fail-open | code-default |
| `FOUNDING_100_EARLY_BIRD_END` | ISO date when price flips $1,000→$1,500; empty = early-bird forever | fail-open | ben-flips |
| `FOUNDING_100_PRICE_CENTS` | Founding 100 price, default $1,000 | fail-open | code-default |
| ⚠️ `INTERNAL_API_SECRET` | Service-to-service auth header (qualify→suggest, consumers→suggest, member routes); unset in prod → callers omit header, suggest falls to admin auth, every internal routing call 401s — routing chain dead with only a console.error | fail-silent | set-once |
| `JWT_SECRET` | Signs every emailed magic link, member/rancher session, activate/decline token; missing → lib/secrets throws at import (most routes 500 loudly) BUT app/api/backfill/* still fall back to grep-able 'bhc-backfill-secret-change-me' | fail-loud | set-once |
| `MAX_SALE_AMOUNT_FOR_INVOICE` | Ceiling sanity-check, default $25,000 | fail-open | code-default |
| `MIN_SALE_AMOUNT_FOR_INVOICE` | Floor sanity-check on commission invoices, default $50 | fail-open | code-default |
| `NEXT_PUBLIC_COMMISSION_RATE` | Commission rate override normalized by getCommissionRate (handles 10 vs 0.10) | fail-open | code-default |
| ⚠️ `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Client-side Payment Element mount for on-domain deposit/product checkout; unset → embedded checkout UI can't initialize, buyer sees broken payment form | fail-silent | set-once |
| `RESERVATION_HOLD_PRICE_CENTS` | Reservation-hold price; hold rail no-ops if its enable check fails | fail-open | code-default |
| `STRIPE_BRAND_PRICE_FEATURED` | Brand $595 tier price id | fail-loud | set-once |
| `STRIPE_BRAND_PRICE_FOUNDING` | Brand $1500 tier price id | fail-loud | set-once |
| `STRIPE_BRAND_PRICE_SPOTLIGHT` | Brand-partner $295 tier price id; unset → checkout 4xx + webhook maps to '__unset__' sentinel | fail-loud | set-once |
| ⚠️ `STRIPE_CONNECT_ENABLED` | Master switch for the entire deposit/Connect money rail; unset ≠ 'true' → deposit checkout, tier select, payouts, resync all 403 (bit Ben 2026-07-08: blank value 403'd admin) | fail-loud | ben-flips |
| ⚠️ `STRIPE_CONNECT_WEBHOOK_SECRET` | Connect webhook signature (deposit-paid, account.updated); '' → all Connect events 400 → deposits paid but never stamped, ranchers stuck on 'Connect bank' | fail-silent | set-once |
| `STRIPE_OPERATOR_PRICE_ID` | Operator ($500/mo) subscription price id — the lead offer | fail-loud | set-once |
| `STRIPE_PASTURE_PRICE_ID` | SaaS Pasture-tier subscription price; unset → that tier checkout fails | fail-loud | set-once |
| `STRIPE_PAYMENT_LINK_HERD_ANNUAL` | Founders Herd annual link | fail-silent | set-once |
| `STRIPE_PAYMENT_LINK_HERD_MONTHLY` | Founders Herd monthly Payment Link; '' → tier button missing from /founders | fail-silent | set-once |
| `STRIPE_PAYMENT_LINK_OUTLAW_ANNUAL` | Founders Outlaw annual link | fail-silent | set-once |
| `STRIPE_PAYMENT_LINK_OUTLAW_MONTHLY` | Founders Outlaw monthly link | fail-silent | set-once |
| `STRIPE_PAYMENT_LINK_STEWARD_ANNUAL` | Founders Steward annual link | fail-silent | set-once |
| `STRIPE_PAYMENT_LINK_STEWARD_MONTHLY` | Founders Steward monthly link | fail-silent | set-once |
| `STRIPE_PAYMENT_LINK_TITLE_FOUNDER` | Title Founder Payment Link | fail-silent | set-once |
| `STRIPE_RANCH_PRICE_ID` | Ranch-tier subscription price id | fail-loud | set-once |
| ⚠️ `STRIPE_SECRET_KEY` | Every Stripe operation (deposits, Connect, settlement, subscriptions); checkout paths throw 500, but reservationHold/whiteGlove warn+return null (those two rails silently vanish) | fail-loud | set-once |
| ⚠️ `STRIPE_WEBHOOK_SECRET` | Platform webhook signature (founders/tier/brand purchases); '' → constructEvent fails, every event 400s, paid money never recorded internally — only visible in Stripe dashboard | fail-silent | set-once |
| `TITLE_FOUNDER_CAP` | Title Founder cap, default 10 | fail-open | code-default |
| `WHITE_GLOVE_PRICE_CENTS` | White-glove service price; same guarded-null pattern | fail-open | code-default |

## 🔌 Integration keys

| Var | Purpose | Fails | Owner |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Claude calls: Telegram bot brain, inbound-reply classification, AI scraper; lib/ai falls back Groq→Ollama, aiSearch throws if no provider at all | fail-open | set-once |
| `BANDWIDTH_ACCOUNT_ID` | SMS adapter (only when `SMS_PROVIDER=bandwidth`) — {accountId} path segment; any Bandwidth var missing → adapter warns + returns ok:false, send skipped | fail-silent | set-once |
| `BANDWIDTH_API_SECRET` | Bandwidth Basic-auth password (legacy scheme — see docs/SMS-PROVIDER-SETUP.md OAuth caveat) | fail-silent | set-once |
| `BANDWIDTH_API_TOKEN` | Bandwidth Basic-auth username | fail-silent | set-once |
| `BANDWIDTH_APPLICATION_ID` | Bandwidth messaging application bound to the from number; required in every send body | fail-silent | set-once |
| `BANDWIDTH_FROM` | Bandwidth sending number (E.164) | fail-silent | set-once |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob token for rancher photo uploads; unset → upload route 500s with clear detail | fail-loud | set-once |
| `CAL_API_KEY` | Cal.com booking resolution + event-type setup; unset → booking falls back to /contact page (degraded but not broken) | fail-open | set-once |
| `CAL_OAUTH_CLIENT_ID` | Cal managed-user OAuth (rancher calendars) | unknown | set-once |
| `CAL_OAUTH_CLIENT_SECRET` | Cal OAuth pair | unknown | set-once |
| `CAL_WEBHOOK_SECRET` | Signature for Cal booking webhooks; unset → webhook registered without secret (dev pattern) | fail-open | set-once |
| `DEPLOY_DRIFT_GITHUB_TOKEN` | Alternate name for the drift-check token | fail-silent | set-once |
| `GITHUB_TOKEN` | Deploy-drift cron GitHub API auth (falls back to DEPLOY_DRIFT_GITHUB_TOKEN); unset → drift check can't compare main vs deployed | fail-silent | set-once |
| `GROQ_API_KEY` | Free-tier LLM path + Whisper call-recording transcription; unset → falls to Anthropic (cost) or transcription skipped | fail-open | set-once |
| ⚠️ `MANYCHAT_WEBHOOK_SECRET` | IG DM funnel webhook auth; unset in prod → fail-CLOSED, all ManyChat requests refused with only a console.error — IG funnel dead silently | fail-silent | set-once |
| ⚠️ `META_CAPI_ACCESS_TOKEN` | Meta CAPI auth; same silent skip | fail-silent | set-once |
| ⚠️ `META_PIXEL_ID` | Server-side Meta CAPI events (Purchase attribution); missing → fireCapi warns+returns, ad attribution silently dead while ad spend runs | fail-silent | set-once |
| `PLIVO_AUTH_ID` | SMS adapter (only when `SMS_PROVIDER=plivo`) — Basic-auth username AND the {auth_id} URL segment; missing → adapter warns + returns ok:false | fail-silent | set-once |
| `PLIVO_AUTH_TOKEN` | Plivo Basic-auth password | fail-silent | set-once |
| `PLIVO_FROM` | Plivo sending number (E.164), sent as `src` | fail-silent | set-once |
| ⚠️ `RESEND_API_KEY` | All outbound email; unset → placeholder key, SDK returns error object, guardedSend still logs status='sent' — every email silently dropped while audit log shows success | fail-silent | set-once |
| ⚠️ `RESEND_INBOUND_WEBHOOK_SECRET` | Inbound reply webhook (Svix) auth; unset in prod → replies refused (fail-closed) but fires a deduped operator alarm every 6h — alarm itself depends on Telegram/Twilio being alive | fail-loud | set-once |
| `RESEND_WEBHOOK_SECRET` | Email event tracking (opens/clicks/bounces); unset → events webhook off, admin surfaces show null metrics (gated on presence, so honest) | fail-open | set-once |
| ⚠️ `SMS_INBOUND_SECRET` | Shared-secret query token on the provider-neutral inbound SMS webhook (`/api/webhooks/sms?token=…`), constant-time compared; **unset in prod → 503, ALL non-Twilio inbound refused** (fail-closed: this endpoint flips Unsubscribed / SMS Opt-In). Twilio's own route is unaffected (it uses X-Twilio-Signature) | fail-loud | set-once |
| ⚠️ `SUPABASE_ANON_KEY` | Supabase client key for rancher login; the historical landmine was this var EXISTING but blank — login silently broken | fail-silent | set-once |
| `SUPABASE_SERVICE_ROLE_KEY` | Admin-side Supabase user management (create/reset rancher logins); unset → those admin ops fail | fail-loud | set-once |
| ⚠️ `SUPABASE_URL` | Rancher password auth backend (falls back to NEXT_PUBLIC_SUPABASE_URL); both empty → rancher login dead | fail-silent | set-once |
| `TAVILY_API_KEY` | Primary search provider for discover-ranchers scraper; unset → falls back to Anthropic web_search (slower) | fail-open | set-once |
| ⚠️ `TELEGRAM_ADMIN_CHAT_ID` | Destination chat for every ops alert; unset → same silent early-return as missing token | fail-silent | set-once |
| ⚠️ `TELEGRAM_BOT_TOKEN` | THE ops alert channel (cron alarms, operator signals, deposit pings, Telegram command bot); unset → alertTelegram/sendTelegram return early, all alerting goes dark | fail-silent | set-once |
| `TELEGRAM_WEBHOOK_SECRET` | Auth for inbound Telegram bot webhook; unset → bot command handling refused/unverified | unknown | set-once |
| `TELNYX_API_KEY` | SMS adapter (only when `SMS_PROVIDER=telnyx`) — Bearer key; missing → adapter warns + returns ok:false, send skipped | fail-silent | set-once |
| `TELNYX_FROM` | Telnyx sending number (E.164) | fail-silent | set-once |
| ⚠️ `TWILIO_ACCOUNT_SID` | SMS sends (default adapter, `SMS_PROVIDER` unset) + call-recording fetch; missing → adapter warns+returns ok:false so sendSMS returns false — with ENABLE_SMS on, every SMS silently no-ops. Inbound `/api/webhooks/twilio-sms` also fails CLOSED in prod without the auth token | fail-silent | set-once |
| ⚠️ `TWILIO_AUTH_TOKEN` | Twilio auth pair; same silent no-op | fail-silent | set-once |
| ⚠️ `TWILIO_FROM_NUMBER` | Sending number (E.164); missing → sendSMS returns false silently | fail-silent | set-once |
| `UPSTASH_REDIS_REST_TOKEN` | Redis auth pair; same fail-open | fail-open | set-once |
| `UPSTASH_REDIS_REST_URL` | Rate limiting, rancher capacity counters, founder-number allocation; missing → getRedis()=null, rate-limit passes everyone, capacity falls back to Airtable truth | fail-open | set-once |
| `VAPID_PRIVATE_KEY` | Web Push signing for rancher PWA notifications; missing → isPushConfigured()=false, push silently skipped (email/SMS still fire) | fail-open | set-once |

## 🚩 Feature flags (Ben switches)

| Var | Purpose | Fails | Owner |
|---|---|---|---|
| `CAL_NATIVE_BOOKER` | 'true' → /book/[refId] renders native Cal embed instead of link-out | fail-open | ben-flips |
| `CAMPAIGN_LIVE` | 'true' → campaign sends real emails/SMS (vs dry-run) | fail-silent | ben-flips |
| `CAMPAIGN_ROUTER_ENABLED` | 'true' → demand-router campaign cron active | fail-silent | ben-flips |
| `EMAIL_SEQUENCES_ALLOW` | Allowlist scoping which sequences may send when the cron is on | fail-silent | ben-flips |
| ⚠️ `EMAIL_SEQUENCES_ENABLED` | Master gate for the email-sequences cron; ≠'true' → cron returns before withCronRun (invisible even to cron introspection) | fail-silent | ben-flips |
| ⚠️ `ENABLE_SMS` | Platform-wide SMS master gate ('1' or 'true' via smsEnabled()); unset → whole SMS channel off by design. Sits ABOVE `SMS_PROVIDER` — swapping vendors cannot light the channel | fail-silent | ben-flips |
| `SMS_PROVIDER` | Which vendor the SMS transport sends through: `twilio` (default) \| `telnyx` \| `plivo` \| `bandwidth`. **Unset ⇒ twilio ⇒ byte-identical to pre-2026-07-30 behavior.** An UNKNOWN value warns and falls back to twilio rather than silently dropping every send. Runbook: docs/SMS-PROVIDER-SETUP.md | fail-open | ben-flips |
| `LOG_RETENTION_ENABLED` | Tri-state log-purge cron; unset → logs accumulate (Airtable row bloat) | fail-silent | ben-flips |
| `MAINTENANCE_MODE` | 'true' → platform-wide pause (crons skip, go-live blocked); unset=normal | fail-open | ben-flips |
| ⚠️ `MATCHING_ENABLED` | Routing kill switch with INVERTED semantics — default ON, only explicit 'false' pauses matching/intros platform-wide | fail-open | ben-flips |
| `LOSS_RECOVERY_ENABLED` | Loss-recovery cron off Referrals 'Loss Reason' (re-engage / downsell / nurture-stamp); anything but 'true' = DRY-RUN (selection runs + logs would-send list, zero sends/stamps — the WAITING_ACTIVATION precedent). ⚠️ BEFORE any bulk 'Loss Reason' backfill on historical rows: pre-stamp 'Recovery Sent At' — the 14d freshness window rides LAST_MODIFIED_TIME(), so a mass edit makes months-old losses look fresh (live runs also self-halt >200 eligible/day as a backstop) | fail-silent | ben-flips |
| `META_CLOSE_PURCHASE_ENABLED` | Fire attributed CAPI Purchase on Closed-Won; unset=off | fail-silent | ben-flips |
| `META_DEPOSIT_PURCHASE_ENABLED` | Fire CAPI Purchase on deposit-paid; unset=off by design | fail-silent | ben-flips |
| `META_PRODUCT_PURCHASE_ENABLED` | Fire CAPI Purchase on low-ticket product sales; unset=off | fail-silent | ben-flips |
| `NATIONWIDE_ROUTING_ENABLED` | 'true' → multi-state routing honored; unset=state-only routing | fail-silent | ben-flips |
| `NEXT_PUBLIC_PRODUCT_PAYMENT_ELEMENT` | 'true' → product checkout uses on-domain Payment Element vs hosted Checkout | fail-open | ben-flips |
| ⚠️ `NURTURE_ENABLED` | Tri-state nurture-drip cron gate ('true'/'dry-run'/off); unset → nurture emails silently stop, cron reports healthy skip | fail-silent | ben-flips |
| `ORPHAN_REAPER_REWARM_ENABLED` | 'true' → reaper re-warms orphaned checkouts with an email; unset=flip-only | fail-silent | ben-flips |
| `PRODUCT_RECOVERY_ENABLED` | Tri-state abandoned product-checkout recovery emails; unset=off | fail-silent | ben-flips |
| `PRODUCT_REVIEW_ASK_ENABLED` | Tri-state post-purchase review-ask emails; unset=off | fail-silent | ben-flips |
| `PRODUCT_STOCK_CHECKIN_ENABLED` | Tri-state rancher stock check-in nudges; unset=off | fail-silent | ben-flips |
| `RANCHER_REACTIVATION_ENABLED` | 'true' only → dormant-rancher reactivation cron; unset=off | fail-silent | ben-flips |
| `REPLENISHMENT_ENABLED` | Tri-state replenishment (reorder) email cron; unset=off | fail-silent | ben-flips |
| `REQUIRE_PRODUCT_APPROVAL` | 'true' → rancher-created products need admin approval before listing; unset → auto-list | fail-open | ben-flips |
| `ROUTING_ADJACENCY_ENFORCE` | Enforce state-adjacency in nationwide routing | fail-open | ben-flips |
| ⚠️ `STALE_HOLD_EXPIRY_ENABLED` | Tri-state stale referral-hold expiry (frees rancher capacity); unset → holds never expire, capacity silently starves | fail-silent | ben-flips |
| `STRIPE_CONSENT_COLLECTION` | 'true' → Connect checkout collects ToS consent | fail-open | ben-flips |
| `WAITING_ACTIVATION_ENABLED` | Tri-state WAITING-lead activation rail (currently dry-run); unset=off | fail-silent | ben-flips |

## ⚙️ Config

| Var | Purpose | Fails | Owner |
|---|---|---|---|
| `ADMIN_EMAIL` | Default operator email for internal notifications; defaults admin@buyhalfcow.com | fail-open | set-once |
| `ADMIN_EMAIL_FOR_FORWARD` | Where unclassifiable inbound replies forward; falls back to ADMIN_EMAIL, both '' → forwards silently skipped | fail-silent | set-once |
| `ADMIN_PASSWORD` | Operator admin UI gate; missing → secrets.ts throws, admin routes 500 | fail-loud | set-once |
| `ADS_PARTNER_PASSWORD` | Optional ads-partner login role; unset → role disabled | fail-open | set-once |
| `AIRTABLE_TIMEOUT_MS` | Per-request Airtable timeout knob | fail-open | code-default |
| `BACKFILL_LINK_EXPIRY_DAYS` | Expiry for backfill campaign magic links | fail-open | code-default |
| `BHC_OPERATOR_EMAIL` | Pre-call brief recipient for Cal bookings; falls back to ADMIN_EMAIL | fail-open | set-once |
| `BUSINESS_ADDRESS` | CAN-SPAM physical address in every email footer; has real default | fail-open | code-default |
| `CAL_BOOKING_URL` | Fallback operator booking URL | fail-open | set-once |
| `CAL_OPERATOR_SALES_EVENT_SLUG` | Which Cal event slug is the sales call | fail-open | set-once |
| `CAL_OPERATOR_USERNAME` | Cal username for operator event lookup | fail-open | set-once |
| `CAL_RANCHER_BOOKING_URL` | Rancher-onboarding call booking URL | fail-open | set-once |
| `CAL_SALES_BOOKING_URL` | Sales-call booking URL | fail-open | set-once |
| `CAMPAIGN_CONVERSION_BUFFER` | Slots held back for in-flight conversions, default 3 | fail-open | code-default |
| `CAMPAIGN_DAILY_CAP` | Max campaign sends/day, default 25 | fail-open | code-default |
| `CAMPAIGN_SMS_RECOVERY_HOURS` | Hours before campaign SMS recovery fires | fail-open | code-default |
| `CAMPAIGN_START_DATE` | Campaign anchor date for reactivation cadence | fail-open | ben-flips |
| `COMMISSION_PAYMENT_URL` | 'Pay Now' button in commission invoice email; unset → button silently omitted, rancher must be chased manually | fail-silent | set-once |
| `COMMIT_SHA` | Manual commit-sha fallback for drift/health | fail-open | code-default |
| `DEPLOY_DRIFT_REPO_NAME` | Repo name for drift check | fail-open | code-default |
| `DEPLOY_DRIFT_REPO_OWNER` | Repo owner for drift check | fail-open | code-default |
| `DEPOSIT_ACCEPT_SLA_HOURS` | Rancher deposit-accept SLA before safety-net cron escalates | fail-open | code-default |
| `EMAIL_FREQUENCY_CAP_PER_WEEK` | Rolling weekly cap on non-transactional email per recipient, default 3 | fail-open | code-default |
| `FINAL_INVOICE_DUNNING_ESCALATE_AFTER` | Reminders before operator escalation | fail-open | code-default |
| `FINAL_INVOICE_DUNNING_INTERVAL_DAYS` | Days between dunning reminders | fail-open | code-default |
| `FINAL_INVOICE_DUNNING_MAX_PER_RUN` | Dunning batch cap | fail-open | code-default |
| `FINAL_INVOICE_DUNNING_STUCK_DAYS` | Age threshold for dunning eligibility | fail-open | code-default |
| `FULFILLMENT_CHASE_FALLBACK_DAYS` | Days before fulfillment-chase fallback fires | fail-open | code-default |
| `JWT_SECRET_LEGACY` | Comma-separated old secrets honored during rotation so in-flight emailed links keep verifying; unset → old links 401 after a rotation | fail-open | set-once |
| `LOSS_RECOVERY_MAX_PER_RUN` | Loss-recovery batch cap, default 20 | fail-open | code-default |
| `MERCH_URL` | Merch link in emails; defaults to sackett-ranch page | fail-open | code-default |
| `NEXT_PUBLIC_SITE_URL` | Canonical base URL in 130 call sites (email links, redirects, webhooks); defaults to https://www.buyhalfcow.com so unset is safe in prod, wrong in preview | fail-open | set-once |
| `NODE_ENV` | Runtime environment; gates prod-only fail-closed behaviors (webhook auth, secrets throwing) | fail-open | code-default |
| `NOMINATIM_USER_AGENT` | Required UA for OSM geocoding in scraper; has compliant default with contact email | fail-open | code-default |
| `ONBOARDING_PARTNER_PASSWORD` | Optional partner login role; unset → that role simply disabled (401 as wrong password) | fail-open | set-once |
| `OPERATOR_ALERT_EMAIL` | Email fallback channel for loud operator signals; falls back to ADMIN_EMAIL | fail-open | set-once |
| `OPERATOR_ALERT_PHONE` | SMS fallback for loud operator signals; '' → SMS leg of alerting silently off | fail-silent | set-once |
| `OPERATOR_SIGNAL_TELEGRAM_FLOOR` | Min urgency mirrored to Telegram, default 'normal' | fail-open | code-default |
| `ORPHAN_REAPER_MAX_PER_RUN` | Reaper batch cap | fail-open | code-default |
| `ORPHAN_REAPER_STAMP_LOOKBACK_DAYS` | How far back stamp-repair scans | fail-open | code-default |
| `ORPHAN_REAPER_STAMP_MAX_PER_RUN` | Cap on missing-stamp repairs per run | fail-open | code-default |
| `ORPHAN_REAPER_STUCK_HOURS` | Hours before a Pending checkout counts orphaned | fail-open | code-default |
| `PRODUCT_RECOVERY_MAX_PER_RUN` | Recovery batch cap | fail-open | code-default |
| `PRODUCT_REVIEW_ASK_MAX_PER_RUN` | Review-ask batch cap | fail-open | code-default |
| `QUIZ_NUDGE_MAX_DAYS` | Max age of quiz-abandoners to nudge | fail-open | code-default |
| `QUIZ_NUDGE_MAX_PER_RUN` | Quiz-abandon nudge batch cap | fail-open | code-default |
| `REPLENISH_MAX_PER_RUN` | Replenishment batch cap | fail-open | code-default |
| `REPLIES_DOMAIN` | Tagged Reply-To domain for inbound routing; defaults replies.buyhalfcow.com | fail-open | code-default |
| `RESERVE_RECOVERY_HOURS` | Hours before abandoned-reserve recovery email | fail-open | code-default |
| `RESERVE_RECOVERY_MAX_AGE_DAYS` | Oldest reserve eligible for recovery | fail-open | code-default |
| `RESERVE_RECOVERY_SMS_HOURS` | Hours before recovery SMS leg | fail-open | code-default |
| `ROUTING_MAX_HOPS` | Max re-route hops before giving up on a lead | fail-open | code-default |
| `SEND_DOMAINS` | Rotating From-domains for email; defaults buyhalfcow.com | fail-open | set-once |
| `STALE_HOLD_DAYS` | Days before a hold is stale | fail-open | code-default |
| `STUCK_REFERRAL_MAX_PER_RUN` | Stuck-referral recovery batch cap | fail-open | code-default |
| `STUCK_REFERRAL_NORMALIZE_PER_RUN` | Status-normalization cap per run | fail-open | code-default |
| `STUCK_REFERRAL_STUCK_DAYS` | Days before a referral counts stuck | fail-open | code-default |
| `VERCEL_DEPLOYMENT_ID` | Deployment id for diagnostics | fail-open | code-default |
| `VERCEL_ENV` | Vercel-provided production/preview/development marker | fail-open | code-default |
| `VERCEL_GIT_COMMIT_REF` | Deployed branch name | fail-open | code-default |
| `VERCEL_GIT_COMMIT_SHA` | Deployed commit for drift check / health | fail-open | code-default |
| `VERCEL_GIT_REPO_SLUG` | Repo slug for diagnostics | fail-open | code-default |
| `VERCEL_REGION` | Diagnostics: serving region | fail-open | code-default |
| `WAITING_NUDGE_COOLDOWN_DAYS` | Days between nudges to same buyer | fail-open | code-default |
| `WAITING_NUDGE_MAX_PER_RUN` | WAITING-nudge batch cap | fail-open | code-default |

## 🌐 Public client (NEXT_PUBLIC_*)

| Var | Purpose | Fails | Owner |
|---|---|---|---|
| `NEXT_PUBLIC_BHC_OPERATOR_CAL_URL` | Public operator Cal link rendered in UI | fail-silent | set-once |
| `NEXT_PUBLIC_BRAND_FOUNDING_CALENDLY` | Brand-partner founding-tier call link | fail-silent | set-once |
| `NEXT_PUBLIC_CALENDLY_DISCOVERY_LINK` | Discovery-call Calendly link | fail-silent | set-once |
| `NEXT_PUBLIC_CALENDLY_LINK` | Legacy Calendly link in buyer flow | fail-silent | set-once |
| `NEXT_PUBLIC_CAL_OAUTH_CLIENT_ID` | Client-side Cal OAuth id for embedded booker | fail-silent | set-once |
| `NEXT_PUBLIC_GA4_ID` | GA4 tag; unset → analytics silently off | fail-silent | set-once |
| `NEXT_PUBLIC_GOOGLE_ADS_ID` | Google Ads conversion tag; unset → value-bidding data lost silently | fail-silent | set-once |
| `NEXT_PUBLIC_META_DEPOSIT_PURCHASE_ENABLED` | Client-side twin of the deposit Purchase flag (browser pixel event) | fail-silent | ben-flips |
| `NEXT_PUBLIC_META_PIXEL_ID` | Browser-side Meta pixel tag; unset → no pixel, browser-side attribution off | fail-silent | set-once |
| `NEXT_PUBLIC_RANCHER_ONBOARDING_VIDEO_ID` | Rancher onboarding tutorial video id | fail-silent | set-once |
| `NEXT_PUBLIC_START_VIDEO_ID` | Homepage/start video embed id; unset → video block hidden | fail-silent | set-once |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Fallback name for SUPABASE_ANON_KEY | fail-open | set-once |
| `NEXT_PUBLIC_SUPABASE_URL` | Fallback name for SUPABASE_URL | fail-open | set-once |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | Public half of Web Push pair; missing → subscription UI can't register | fail-open | set-once |
| `NEXT_PUBLIC_VERCEL_ENV` | Client-visible Vercel env marker | fail-open | code-default |

## 🧪 Dev-only

| Var | Purpose | Fails | Owner |
|---|---|---|---|
| `DEMO_MODE` | Server-side fake-data mode for tutorial videos; NEVER set in Vercel | fail-open | ben-flips |
| `FOUNDERS_TEST_MODE` | 'true' → hidden $1 founders tier for E2E card test | fail-open | ben-flips |
| `META_CAPI_TEST_CODE` | Routes CAPI events to Test Events panel during QA; leave unset in prod | fail-open | set-once |
| `NEXT_PUBLIC_DEMO_MODE` | Client-side twin of DEMO_MODE; NEVER set in Vercel | fail-open | ben-flips |
| `OLLAMA_BASE_URL` | Local-dev LLM fallback endpoint | fail-open | code-default |
| `OLLAMA_MODEL` | Local LLM model name, defaults llama3.2 | fail-open | code-default |

## Sweep notes

~176 distinct vars (grep also matched a comment 'process.env.X' in lib/secrets.ts:4 — not a real var). Watchdog design notes: (1) RESEND_API_KEY is the archetype fail-silent — lib/email.ts:127 placeholder key + guardedSend (lib/email.ts:453-472) never inspects result.error, so a dead key logs status='sent' for every email; a watchdog should assert result.data.id looks like a real Resend id, or poll Resend /emails daily. (2) The watchdog itself must not depend on Telegram+Resend alone — TELEGRAM_BOT_TOKEN/CHAT_ID absence silently kills the alert channel that everything else alerts through (lib/cronRun.ts:35 early-return). (3) INTERNAL_API_SECRET unset in prod = qualify/consumers→matching/suggest 401s silently (callers omit header, route falls to admin auth) — routing chain dead with only a console.error at cold start. (4) Watchdog should check flag VALUES not just presence: MATCHING_ENABLED has inverted semantics (only 'false' pauses; all other flags need 'true'/'dry-run'), ENABLE_SMS accepts '1' or 'true' via lib/smsFlag.ts, tri-state crons ('true'/'dry-run'/unset) silently revert to off if the var is deleted, and STRIPE_CONNECT_ENABLED set-but-blank already bit once (2026-07-08). (5) Leftover security hole worth fixing: app/api/backfill/{send-campaign,validate-token,generate-links,update-profile}/route.ts still fall back to hardcoded JWT secret 'bhc-backfill-secret-change-me' — the exact pattern lib/secrets.ts was created to eliminate. (6) Fail-loud vars (JWT_SECRET, ADMIN_PASSWORD, CRON_SECRET via requireEnv; STRIPE_SECRET_KEY; AIRTABLE_*) break loudly in Vercel logs but nothing pages Ben — /api/admin/health and /api/health already expose presence booleans for most loadBearing vars, so the cheapest watchdog is a cron that hits /api/admin/health + sends a real test email and alerts on any regression via BOTH Telegram and SMS.

## Fulfillment connector (2026-07-21)
| Var | Where | Purpose |
|---|---|---|
| `INTEGRATION_TOKEN_KEY` | Vercel prod (Sensitive) + .env.local + test env | AES-256-GCM key for per-rancher store credentials (32 bytes base64). Unset → crypto throws; connector cannot save/read configs. |
| `SHOPIFY_APP_CLIENT_ID` | Vercel prod (Sensitive) | Public BuyHalfCow app client id. Unset → one-click connect disabled; card falls back to token form (silent, by design). |
| `SHOPIFY_APP_CLIENT_SECRET` | Vercel prod (Sensitive) | Public app secret: OAuth token exchange + compliance-webhook HMAC. Unset → same fallback as above; compliance topics 401. |
| `SHOPIFY_PUBLIC_APP_LIVE` | Vercel prod — **flip to `1` on Shopify's approval email** | Gate for OFFERING the one-click public-app flow (`publicAppLive()`, lib/shopifyOauth.ts). Unset/false → dashboard card shows the token form + install route 503s, even with creds set. Creds stay set during review (compliance-webhook HMAC needs them) but Shopify refuses merchant installs of an in-review app — offering the flow early dead-ends ranchers on a Shopify error page with no callback and no alert (audit 2026-07-21). |

## Prod-set orphans (runtime audit sweep 2026-07-28)

These 8 vars exist in the Vercel prod env but a full repo grep (`process.env.<name>` across app/lib/scripts/middleware/instrumentation) finds ZERO readers — they are historical leftovers, documented so the next sweep doesn't re-flag them as "undocumented". Purpose below is reconstructed from code comments + naming convention, never from values. Safe to delete from Vercel once Ben confirms nothing external (Vercel integrations, other repos on the same project) consumes them.

| Var | Purpose (historical) | Status |
|---|---|---|
| `ADMIN_EMAILS` | Plural predecessor of `ADMIN_EMAIL` (admin alert/notification targets); code reads `ADMIN_EMAIL` only (lib/email.ts, lib/operatorSignal.ts) | orphan |
| `BLOB_STORE_ID` | Vercel Blob store id, auto-added by the Vercel Blob integration; code only uses `BLOB_READ_WRITE_TOKEN` | integration-managed |
| `BLOB_WEBHOOK_PUBLIC_KEY` | Vercel Blob webhook signature key, auto-added by the integration; no Blob-webhook consumer exists in code | integration-managed |
| `CALENDLY_LINK` | Legacy fixed Calendly booking URL; superseded by live Cal.com resolution (`getOperatorBookingUrl`) — flagged stale in app/api/book/link/route.ts + app/api/rancher/checkin-response/route.ts comments | orphan |
| `CAL_RANCHER_EVENT_TYPE_ID` | Old fixed Cal.com event-type id for rancher calls; event types are now resolved at runtime via `CAL_API_KEY` | orphan |
| `STRIPE_BRAND_LINK_COMARKETED` | Legacy brand-partner Stripe Payment Link (co-marketed tier); replaced by dynamic checkout — app/api/checkout/brand/route.ts explicitly notes `STRIPE_BRAND_LINK_*` is "intentionally no longer consulted" | orphan |
| `STRIPE_BRAND_LINK_FEATURED` | Legacy brand-partner Payment Link ($595 Featured tier); same replacement as above | orphan |
| `STRIPE_BRAND_LINK_SPOTLIGHT` | Legacy brand-partner Payment Link ($295 Spotlight tier); same replacement as above | orphan |
