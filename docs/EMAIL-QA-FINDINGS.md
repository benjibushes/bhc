# BHC Email QA — spam-safety · links · functions · copy

_2026-06-23. Read-only audit of all 93 emails across 4 dimensions. Findings consolidated below; full per-dimension reports follow._

## VERDICT — are we spamming?

**Your automated app + cron emails are NOT spamming.** The central `lib/email.ts` wrapper enforces suppression (Unsub/Bounce/Complained), unsubscribe link, physical address, frequency cap, and List-Unsubscribe on **every** route + cron send. `_bypassSuppression` is used exactly once (justified admin forward). That foundation is solid.

**BUT there are real risks + false claims that ship to customers today.** Six P0s:

## P0 — fix before any more sending (spam-risk / false-claims / double-send / 404)

1. **Manual `scripts/*.mjs` bypass the wrapper entirely** — they `new Resend()` + send direct, so **no suppression, no unsubscribe, no physical address, off-domain personal-Gmail reply-to**. One run can email people who unsubscribed = spam complaints + CAN-SPAM violation. Worst: `segment-backfill-and-au-beef-route.mjs:204` (buyer-facing, *and* no dry-run gate). **Fix: route every script through `sendEmail()`.** (~8 scripts, one structural change.)
2. **Double-send crons.** `migration-deadline` has **no dedup stamp** — a Vercel retry or manual `?secret=` replay re-fires the same nudge. Plus 4 crons send-THEN-stamp inside a `try`, so a thrown Airtable write drops the stamp and the next run re-sends — worst is `rancher-onboarding-drip` (re-sends every daily run on a stage-flip failure); also 3 blocks in `referral-chasup`. **Fix: stamp-first / add a dedup read.**
3. **`rancher-launch-warmup` fires on buyer *stage alone*** — zero qualification logic on all 3 paths → it warms any Waitlisted/WAITING/READY buyer regardless of funnel+quiz. This is the exact mass-spam anti-pattern the guardrails forbid. **Fix: add the qualification gate.**
4. **False money claims in live buyer + rancher emails.** `sendMatchNowRescue` (`lib/email.ts:4282`) + `sendNudgeToEngage` (`:4322`) tell buyers "we take 10% only when the deal closes, the rancher keeps 90" — **false on tier_v2** (deposit closes upfront, rate is 10/7/3/0%). `sendRancherGoLiveEmail` ("You're Live", `:1666`) tells **every** newly-live rancher to "close the deal / mark Closed Won" — the legacy flow, **not tier-gated** (ships to tier_v2 via `batch-approve:314` + `admin/ranchers/[id]:200`). **Fix: tier-gate / rewrite.**
5. **Two broken 404 links.** `/update-profile` (backfill survey emails, `backfill/*:39-40` — route doesn't exist) and `/shop` (CLOSED-cuts nurture + founder letter, `lib/email.ts:1032,2237` — no route, not in the vanity-redirect map). **Fix: create the routes or repoint.**
6. **Empty merge in 3 rancher-intro subjects** — `buyerState` raw → "Introduction: Buyer in " (trailing blank). **Fix: guard the subject.**

## P1 — should fix

- **Token expiry too short for days-later clicks** (same class as the prior 24h-vs-30d bug): `qualify-access` 24h, emailed `member-login`/`rancher-login` 7d. (Token *types* all verify correctly — only expiry.)
- **`rancher-reactivation` + `rancher-followup` (Monday branch) reach Paused/Non-Compliant ranchers** (status guard exists elsewhere in the file, not on these paths).
- **Buyer AI chase has no LLM-failure fallback** (`draft.split('\n')` throws on undefined → silent miss) **and no prohibition on hallucinated prices/promises.** (`autoRespond.ts` is properly guarded — copy its pattern.)
- **tier_v2 buyer missing `buyerId`/`buyerEmail`** in `sendBuyerIntroNotification` → falls to legacy copy with **no deposit CTA at all**.
- **4 emails hand-roll "reply to this email" CTAs but carry no reply tag** → replies are captured by the catch-all but **unattributed** (no record-linked stamp). (Correction to the content audit: replies are NOT lost — the wrapper defaults to `inbox@replies`.)
- **Marketing broadcasts carry 0 UTM** → the highest-volume promo sends are unattributable (ties to the dead email-attribution finding).
- **Spam-trigger subjects:** ALL-CAPS + 🔥 + "save 30-50%" in a few scripts/crons.
- **Legacy `?email=` unsubscribe URL** still used by the AI re-engagement email — **deprecation-dated 2026-06-26 (3 days out).**

## P2 — polish
- **~40 templates ship a double footer** (wrapper appends address+unsubscribe, template hand-rolls its own).
- **Voice/signature drift** (`— Ben` / `— Benjamin, Founder` / lowercase `ben`).
- **Dead code:** day-14 `onboarding-stuck` body unreachable.
- **email-sequences engine dormant** (~22 dark sends behind `EMAIL_SEQUENCES_ENABLED`) — decide revive/kill.

## What's CLEAN (verified, don't touch)
Token type↔verify (zero mismatches). Unsubscribe route works. Merge-field null-guarding (no raw `{firstName}`/`$undefined`/`NaN`). The central wrapper. `autoRespond.ts` guardrails. The V2-upgrade tier table (matches `lib/tiers.ts`). `sendBuyerIntroNotification` tier-awareness (the most-sent buyer email).

---
# BHC Email — SPAM · DELIVERABILITY · COMPLIANCE audit (read-only)

_Audited 2026-06-23. Repo: `/Users/benji.bushes/BHC/untitled folder/bhc`. Source of truth = code. Inventory = `docs/EMAIL-AUDIT.md`._

## TL;DR

The **centralized wrapper is solid**. Every app/cron send funnels through `lib/email.ts`'s internal `resend.emails.send` object (or the exported `sendEmail`/`sendMagicLink`), which auto-applies: suppression check (Unsub/Bounce/Complaint), CAN-SPAM footer (address + unsubscribe), List-Unsubscribe header, frequency cap, and tagged Reply-To. **No `app/` route or cron bypasses it** — `_skipFooter` is never set, `_bypassSuppression` is used in exactly ONE justified place.

**The entire risk lives in the `scripts/*.mjs` bulk senders**, which each `new Resend()` and call `resend.emails.send(...)` DIRECTLY — bypassing the wrapper entirely (no auto-footer, no frequency cap, no suppression cache, no List-Unsubscribe header). Most check suppression manually; several do NOT. These are hand-run (`--execute`-gated), so they're armed operator weapons, not always-on leaks — but a single run can email unsubscribers / omit CAN-SPAM elements.

**Worst finding:** `scripts/segment-backfill-and-au-beef-route.mjs:204` — sends a buyer-facing intro with **NO suppression check + NO unsubscribe link + NO physical address + off-domain Gmail Reply-To + no `--execute` gate** (runs + mutates Airtable on a plain `node` invocation). It fails all three CAN-SPAM/suppression gates at once.

---

## P0 — spam / legal risk (suppression bypass + CAN-SPAM gaps)

| # | Issue | file:line | Fix |
|---|-------|-----------|-----|
| P0-1 | **Buyer send, NO suppression + NO unsubscribe + NO address + Gmail Reply-To, NO --execute gate.** Sends "…is your match — introduction inside" to GA waitlist buyers filtered only by engagement (`{Warmup Engaged At}`), never checks Unsub/Bounce/Complained; body HTML has neither an unsubscribe link nor a physical address; `replyTo: ADMIN_EMAIL` (defaults to personal Gmail). Script runs backfill + creates referrals + sends on a plain `node` run (no dry-run). | `scripts/segment-backfill-and-au-beef-route.mjs:204` (send), suppression-absent at `:98`, replyTo `:207`, no gate ~`:246` | Route through `lib/email.ts` (`sendEmail`), or at minimum add the 3-field suppression guard + footer + a `--execute` flag; set Reply-To on-domain. |
| P0-2 | **Rancher send fully off-wrapper (raw `fetch` to api.resend.com), NO suppression + NO unsubscribe + NO address.** Onboarding-resend body (`emailHtml`) has no footer at all; loops rancher IDs and posts straight to Resend. (Has `--execute` + `if(!to)` only.) | `scripts/_resend-onboarding.mjs:82` (fetch send), body `:39-58` | Add suppression check + CAN-SPAM footer (address + unsub link) to the body, or call the `sendRancherSelfSubmitWelcome`-style wrapper helper. |
| P0-3 | **Buyer send, NO suppression check** (filters Referrals by `{Status}` only, never checks the linked Consumer's Unsub/Bounce/Complained). Moves CO Quarter buyers HL→Homestead and emails them. Footer present (full address + unsub link) so only the suppression gate is missing. | `scripts/homestead-move-quarters-from-hl.mjs:167` (send), filter `:60-62` | Add per-buyer suppression check against each linked Consumer before sending. |
| P0-4 | **Bulk rancher "digest" sends with NO suppression** (only skip Paused/Removed) **and NO unsubscribe link.** Despite "digest" names these mail real ranchers, not the operator. | `scripts/_send-bulletproof-recovery-digest.mjs:165`; `scripts/_send-rancher-review-digest.mjs:178` | Add 3-field suppression guard + an unsubscribe link/List-Unsubscribe header. |
| P0-5 | **Single-rancher sends with NO suppression + NO unsubscribe.** Hand-run apology/follow-up blasts. Address present, opt-out missing. | `scripts/brimstone-course-correct.mjs:156`; `scripts/_send-lilyhill-followup.mjs:113` | Add suppression check + unsubscribe link (low volume but still CAN-SPAM). |
| P0-6 | **Per-action rancher sends with NO suppression + NO unsubscribe + NO --execute gate.** GET + PATCH + send all fire immediately on `node scripts/_triage-rancher.mjs <id> <action>` — mutates + emails with no dry-run. | `scripts/_triage-rancher.mjs:118,184,208,252`; no gate (`process.argv` parsed, no `--execute`) `:35` | Gate behind `--execute`; add suppression + unsubscribe. |
| P0-7 | **Bulk rancher pitch — unsubscribe is an in-body JWT "decline" button only** (no standard unsubscribe link, no List-Unsubscribe header). Suppression IS checked (good). Bulk volume raises the CAN-SPAM stakes vs the single-rancher cases. | `scripts/rancher-pilot-pitch.mjs:189` (send), opt-out `:105` | Add a real unsubscribe link / List-Unsubscribe header alongside the decline button. |
| P0-8 | **Misleading subject — fake `Re:` on a COLD drip.** `Re: {ranchName} on the map` is a first-touch nurture step, not a reply — CAN-SPAM deceptive-subject territory, not just deliverability. | `app/api/cron/rancher-onboarding-drip/route.ts:109` → `lib/email.ts:4117` | Drop the `Re:` prefix; use an honest subject. |
| P0-9 | **Misleading/fake-scarcity subjects** on a quiz the buyer never finished (no real reserved "spot"/"file"): `Your rancher spot in {state} is still open — for now` and `Last call, {firstName} — should I close your file?`. Manufactured stakes. (This cron is LIVE.) | `app/api/cron/abandoned-quiz-nudge/route.ts:78` and `:83` | Reword to honest "still open to finish your quiz"; drop "close your file" threat framing. |

---

## P1 — deliverability

| # | Issue | file:line | Fix |
|---|-------|-----------|-----|
| P1-1 | **Systemic 🔥 fire-emoji + ALL-CAPS "READY TO BUY" subject lines.** Money-emoji + shouting in subject = top spam signal. Recurs: rancher intro `🔥 READY TO BUY · …`, `🔥 {firstName} is ready to buy — call this week`, buyer-intro `🔥`-prefix variant, brimstone hot-lead. Mostly B2B/rancher (lower blast radius) but #2 + the buyer-intro prefix reach buyers. | `app/api/matching/suggest/route.ts:1060`; `app/api/member/ready-to-buy/route.ts:191`; `lib/email.ts:1132`; `scripts/brimstone-launch.mjs` | Strip 🔥 from subjects; move the "ready to buy" signal into a header/preheader, not the Subject. |
| P1-2 | **Systemic ALL-CAPS shouting blocks in bodies.** `RESERVE YOUR SHARE NOW`, `LOCK IN YOUR SHARE — 15 MIN WITH BEN`, `SCHEDULE A 15-MIN INTRO CALL`, `PUSH ME LIVE` (×3-4/email), `READY TO BUY in 1–2 months`. Weighted by spam filters; appears in the highest-volume buyer-intro template. | `lib/email.ts:1132`; `app/api/matching/suggest/route.ts:1196`; `app/api/admin/referrals/[id]/resend-intro/route.ts:112`; `scripts/rancher-pilot-pitch.mjs`; `scripts/brimstone-*.mjs` | Downcase to Title Case. |
| P1-3 | **Off-domain (personal Gmail) Reply-To on buyer/rancher-facing mail** in scripts — replies leave the authenticated domain (alignment/reputation risk + replies escape the inbound/Conversations pipeline). Default/fallback to `benibeauchman@gmail.com` when `ADMIN_EMAIL` unset. | `scripts/segment-backfill-and-au-beef-route.mjs:207`; `scripts/brimstone-launch.mjs:341,409`; `scripts/brimstone-course-correct.mjs:161`; `scripts/rancher-pilot-pitch.mjs:192`; `scripts/chase-high-lonesome-stalled.mjs:116`; `scripts/reengage-covered-state-waitlist.mjs:134` | Use an on-domain Reply-To (`ben@buyhalfcow.com` or a `replies.buyhalfcow.com` tag). |
| P1-4 | **"save 30-50%" discount claim** in body — the only big-percentage savings phrase in the set; high spam-word weight. | `lib/email.ts:3769` (Abandoned App Recovery Email 3) | Soften ("members typically save vs grocery" without the % range). |
| P1-5 | **Two in-app templates omit the `List-Unsubscribe` header** (`sendAdminAlert`, `sendInquiryAlertToAdmin`). Recipient is the internal admin address → low real risk, but inconsistent with every other template. | `lib/email.ts:2447`; `lib/email.ts:2596` | Pass `getUnsubscribeHeaders(...)` for consistency (or accept as admin-only). |
| P1-6 | **Two templates override Reply-To to the buyer's address** (`sendInquiryToRancher` → `replyTo: data.consumerEmail`; `sendTrackedContactEmail` → `replyTo: data.buyerEmail`). By design (direct rancher↔buyer thread) but their replies bypass the inbound/Conversations capture — a tracking blind spot, not a spam issue. | `lib/email.ts:2514`; `lib/email.ts:3336` | Accept as intentional, or add BCC/tag to capture. |
| P1-7 | **Latent multi-recipient suppression gap.** The wrapper checks suppression + footer only on `params.to[0]` (`lib/email.ts:291,325`). No current caller passes a `to:` array, so it's dormant — but any future array send would skip suppression on recipients 2..N. | `lib/email.ts:291`, `:325` | Iterate all recipients, or assert single-recipient. |

---

## P2 — polish

| # | Issue | file:line | Fix |
|---|-------|-----------|-----|
| P2-1 | **DOUBLE FOOTER — ~40 templates render address + unsubscribe TWICE.** The wrapper auto-appends `emailFooter()`, but these also hand-roll a footer in-body: 15 literally call `emailFooter()` again (byte-identical duplicate), 25 hand-roll their own inline `getUnsubscribeUrl(...)` / hardcoded "1001 S. Main St… Kalispell, MT 59901". Class-A `emailFooter()` calls: `lib/email.ts:3527,4064,4106,4155,4200,4241,4285,4328,4369,4417,4471,4567,4678,4738`. Class-B inline (sample): `sendConsumerConfirmation:549`, `sendWelcomeAndReadyToBuy:724-725`, `sendQuizInvite:776-777`, `sendBuyerIntroNotification:1392`, `sendBroadcastEmail:2713,2716`, … (full list in agent notes). | `lib/email.ts` (40 sites) | Delete the in-body footers and rely on the auto-footer (or set `_skipFooter:true` on the few that intentionally style their own). |
| P2-2 | **`sendBroadcastEmail` body unsubscribe uses legacy `?email=` plaintext URL** (exposes raw email / PII in URL) instead of the token-based `getUnsubscribeUrl()` used everywhere else. | `lib/email.ts:2716` | Switch to `getUnsubscribeUrl()`. |
| P2-3 | **Partial physical address in several broadcast scripts** — body shows `BuyHalfCow · Kalispell, MT 59901`, missing the street line `1001 S. Main St. Ste 600` that the wrapper version includes. Arguably non-compliant on the largest sends. | `scripts/launch-broadcast.mjs:69,93`; `scripts/reengage-unsigned-ranchers.mjs:69,90`; `scripts/_reengage-closed-lost.mjs:64`; `scripts/_revert-stale-pushes.mjs:66` | Use the full street address. |
| P2-4 | **`free` / dollar-amount / ellipsis-threat subjects** — `softer pilot deal — first 4 sales free in {state}` ("free" token), `beef's not in the budget? back the mission for $100` ($ in subject), `closing your listing unless…` (open-loop ellipsis), `[Resend]`/`(resent)` system-tag prefixes. Legit content, minor spam tells. | `scripts/rancher-pilot-pitch.mjs`; `app/api/cron/email-sequences/route.ts:518`; `app/api/cron/rancher-reactivation/route.ts:88`; `app/api/admin/referrals/[id]/resend-intro/route.ts:58` | Reword where cheap. |

---

## What's GOOD (so it isn't re-flagged)

- **Suppression gate** lives at `lib/email.ts:286-302` (`getSuppressionList()` 5-min cache over Consumers+Ranchers Unsub/Bounce/Complaint). Every `app/`+cron send inherits it. `_bypassSuppression` used once (`app/api/webhooks/resend-inbound/route.ts:619`) — justified (internal admin forward).
- **Frequency cap** (`lib/emailFrequencyGuard.ts`, 3/week rolling, env-tunable) is applied to every wrapper send via `guardedSend`/`checkFrequencyCap`; transactional templates are whitelisted deliberately. The in-memory `_countCache` increments before Airtable visibility to prevent burst over-sends (PA5 fix). **Realistic over-send caveat:** a fresh buyer legitimately gets welcome + RTB + intro (+quiz/cal) in one week — all whitelisted, so they bypass the cap by design; that's intentional, but it's the one path where a buyer gets 3-5 emails in a short window.
- **Bulk pacing** is healthy: `send-scheduled` cron batches 10 + 1s delay + 400/run budget + resume cursor (`app/api/cron/send-scheduled/route.ts:172-206`); `backfill/send-campaign` paces ~1/s; every multi-recipient `.mjs` loop sleeps 80-800ms; live crons (`abandoned-quiz-nudge`, `buyer-pulse`, `qualified-no-action`) all `setTimeout`-pace and cap per run. No unpaced bulk loops found.
- **From** is 100% `getFromEmail()` → `BuyHalfCow <ben@{domain}>` rotating `SEND_DOMAINS` (default buyhalfcow.com). No hardcoded/wrong From in code. (Config caveat: if `SEND_DOMAINS` env lists a non-buyhalfcow domain, verify it's authenticated in Resend.)
- There's even a `spam-audit` cron (`app/api/cron/spam-audit/route.ts`) digesting top recipients/templates — good hygiene.
- No hardcore spam vocabulary anywhere: no "$$$", "cash", "act now", "urgent", "guaranteed", "risk-free", "final notice". Subjects are clean of `!`.

## Context that changes priority
- The **whole email-sequences engine is OFF** (`EMAIL_SEQUENCES_ENABLED` gate) — so several P0-9-adjacent §1/§2 nurture offenders aren't actively sending. But `abandoned-quiz-nudge` (P0-9), `buyer-pulse`, `qualified-no-action`, and all §3-§5 rancher mail + every `.mjs` script ARE live/runnable.
- The `.mjs` P0s are hand-run with `--execute` (except P0-1 and P0-6 which have NO gate) — risk is "operator fires a non-compliant blast", not "always-on leak". P0-1 and P0-6 are the two that can fire on a bare `node` run.
# BHC Email LINK + TOKEN Audit — Findings (Audit B)

_Read-only audit, 2026-06-23. Repo: `/Users/benji.bushes/BHC/untitled folder/bhc`. Inventory: `docs/EMAIL-AUDIT.md` (93 emails). Every clickable link / CTA / token-URL audited against actual routes, env, and JWT verify logic._

## Environment baseline (so the domain findings make sense)
- **Canonical domain = `https://www.buyhalfcow.com`** — `NEXT_PUBLIC_SITE_URL` in `.env.local:26`. Almost every link is built from `process.env.NEXT_PUBLIC_SITE_URL`, so in prod they correctly emit `www`.
- **Code fallback is bare apex `https://buyhalfcow.com`** (in `lib/email.ts:357` + ~30 route files). Only fires if the env var is ever unset. **There is NO apex→www redirect** in `proxy.ts` (only vanity merch redirects at `:110-122`), so an unset env would silently ship bare-apex links everywhere. Live risk today is limited to the two *hardcoded* apex links below (P1) that ignore the env var entirely.
- UTM helper exists (`lib/email.ts:490`) and is used in 23 spots in `lib/email.ts`; the manual broadcast scripts in `scripts/` do NOT use it at all (P2 below).

---

## Prioritized findings

| Sev | Issue | file:line | Fix |
|-----|-------|-----------|-----|
| **P0** | **Backfill survey emails link to `/update-profile?token=` — page does NOT exist → hard 404 for every recipient.** Only `app/api/backfill/update-profile/` (API) + `/validate-token/` exist; there is no `app/update-profile/page.tsx` and no rewrite. JWT type (`backfill`) is correct and verified correctly, but the recipient lands on a 404. | `app/api/backfill/generate-links/route.ts:39` ; `app/api/backfill/send-campaign/route.ts:40` (both build `${siteUrl}/update-profile?token=`) | Create `app/update-profile/page.tsx` that reads `?token`, calls `/api/backfill/validate-token` + `/api/backfill/update-profile`. (Or repoint the link to an existing page.) Both are admin/manual sends — confirm they're still run before prioritizing. |
| **P0** | **Merch CTA links to `/shop` — no route, NOT in the vanity-redirect map → 404 risk.** `proxy.ts` only redirects `/hat`,`/hats`,`/merch`,`/trucker` → `merch.buyhalfcow.com/collections/hats`. `/shop` is absent. Appears in the CLOSED-cuts nurture email + founder-letter p.s. + member page. | `lib/email.ts:1032` and `lib/email.ts:2237` (`${SITE_URL}/shop`); also `app/member/page.tsx:265` (`https://buyhalfcow.com/shop`) | Add `/shop` to `VANITY_REDIRECTS` in `proxy.ts` (point at the Shopify store, like `/merch`), or create `app/shop/page.tsx`. Verify whether `buyhalfcow.com/shop` resolves at the domain level today — if not, every merch link 404s. |
| **P1** | **Payout-failed email hardcodes bare-apex domain** `https://buyhalfcow.com/rancher/billing` (ignores `NEXT_PUBLIC_SITE_URL`, so it's apex even though canonical is `www`; relies on a non-existent apex→www redirect). Route itself exists. | `app/api/webhooks/stripe-connect/route.ts:676` | Change to `${SITE_URL}/rancher/billing` using the env-derived SITE_URL like the rest of the codebase. |
| **P1** | **`member-login` magic-link tokens expire in 7d** but are emailed in slow-moving flows where the recipient may click later — incl. the deposit deep-links (`…/verify?next=/checkout/<id>/deposit`). After 7d the buyer hits `/member/login?reason=expired-link` and can't reach the wrapped deposit/checkout. Type matches verifier (no mismatch) — pure expiry risk. (This is the same class as the prior 24h-vs-30d bug.) | mint sites: `lib/bulkRoute.ts:318` ; `app/api/matching/suggest/route.ts:1157` (+deposit `:1179`) ; `app/api/cron/email-sequences/route.ts:43` ; `app/api/cron/batch-approve/route.ts:176` ; `app/api/admin/consumers/[id]/route.ts:105` ; `app/api/admin/referrals/[id]/resend-intro/route.ts:92` ; `app/api/rancher/referrals/[id]/route.ts:240` ; token helper `lib/secrets.ts:170` (`generateMemberLoginToken`, 7d) | Raise emailed member-login expiry to 30d (matches the `member-session` cookie lifetime). Verify route only checks `type==='member-login'`, so widening expiry is safe. |
| **P1** | **Emailed `qualify-access` (quiz) links expire in 24h** — including the "send me a fresh link" recovery and the backup quiz-invite send. A buyer who opens the quiz email the next evening is back in the expired-link loop the resend flow exists to fix. Type matches verifier; pure expiry risk. | `app/api/qualify/resend-link/route.ts:67` (24h, emailed) ; `app/api/consumers/route.ts:717` (24h, emailed via `sendQuizInvite`) | Raise emailed qualify-access tokens to 7–14d. (In-session redirect handoffs at `warmup/engage:289` and `member/ready-to-buy:48` can stay 24h — clicked immediately.) |
| **P1** | **`rancher-login` dashboard link emailed at 7d** after agreement signing ("set up your ranch page"). Rancher who opens it >7d later can't auto-login. Type matches verifier. | `app/api/ranchers/sign-agreement/route.ts:202` (7d, emailed) — the body says "Valid for 7 days" (`docs/EMAIL-AUDIT.md` §3 "Agreement Signed"). The sibling `:44` 24h token is fine (returned in JSON, clicked immediately). | Raise the emailed post-sign rancher-login token to 30d, or have the email link to `/rancher/login` (request-fresh-link) instead of a one-shot magic link. |
| **P2** | **Manual marketing broadcasts carry NO UTM/tracking on any link → zero email-click attribution.** The launch/relaunch/merch/reengagement blasts link to `/access`, `/map`, `/wins`, `/founders`, `/map/add-a-rancher` (and the Sackett merch URL) with no `utm_*`. Grep confirms **0 `utm_` occurrences** in these scripts. Business wants email-click attribution; these are the highest-volume promotional sends. | `scripts/launch-broadcast.mjs` (13 link refs, 0 utm) ; `scripts/relaunch-broadcast.mjs` ; `scripts/merch-mission-series-broadcast.mjs` ; `scripts/reengage-covered-state-waitlist.mjs` (also `reengage-*`, `brimstone-*`, `homestead-*`) | Wrap every link in these scripts with `?utm_source=email&utm_medium=broadcast&utm_campaign=<name>` (mirror `lib/email.ts:utm()`), so Shopify/GA attribute the clicks. |
| **P2** | **Cron-engine nurture emails partially miss UTMs.** `lib/email.ts` uses `utm()` in 23 places, but several routing-segment / founder-letter / abandoned-quiz / buyer-pulse CTAs interpolate raw `${SITE_URL}/…` or `engageUrl`/`/member` without UTM (e.g. qualified-no-action `${SITE_URL}/member`, abandoned-quiz `/qualify/{id}?token=`). Token API links can't carry campaign attribution today. | `app/api/cron/qualified-no-action/route.ts:50` ; `app/api/cron/abandoned-quiz-nudge/route.ts` (quiz CTA) ; warmup `engageUrl` builders | Add UTM params to the user-facing nurture CTAs (token routes can ignore unknown query params). Lower priority than the broadcast scripts. |
| **P2** | **`/account` fallback in renewal-reminder is a 404** (no `app/account/`). Only hit when Stripe `manageUrl` is absent. Low frequency. | `lib/email.ts:1938` (fallback `${SITE_URL}/account`) | Change fallback to `/member` (exists) or create `app/account/`. |
| **P2** | **`cal-reminder-1h` "Join link" never renders** — `calLink` is hardcoded `''`, so the conditional drops it. Not a broken href (guarded), just a permanently-missing link in a transactional reminder. (Confirms the content-audit finding.) | `app/api/cron/cal-reminder-1h/route.ts:119` (`const calLink = ''`), guard at `:54` | Resolve the Cal join URL from the booking (store it on the Referral or fetch from Cal) so the reminder actually carries the join link. |
| **P3** | **Legacy `?email=` unsubscribe still in use, deprecation dated 2026-06-26 (3 days out).** The AI buyer re-engagement email uses `${SITE_URL}/unsubscribe?email=…` (PII-in-URL legacy form). Route + page still accept it, but `app/api/unsubscribe/route.ts:11` flags it deprecated ~2026-06-26. After that date this link could break. | `app/api/cron/referral-chasup/route.ts:684` | Switch to token-based unsub (use `getUnsubscribeUrl(email)` / the standard footer) before the 2026-06-26 deprecation, or extend the deprecation window. |

---

## Things checked and CONFIRMED OK (no issue)

- **Token TYPE vs VERIFY — all match.** Every emailed JWT's `type` matches what its verify route checks: `warmup-engage`→`/api/warmup/engage` ✓; `rancher-quick-action` (30d)→`/api/rancher/quick-action` ✓ (rancher "Closed Won" weeks-later case is intentionally 30d, documented in-route); `rancher-setup` (60d)→`/api/rancher/setup` ✓; `agreement-signing` (30d)→`/api/ranchers/sign-agreement` ✓; `buyer-pulse` (14d, sent at intro+5d → valid days 5–19)→`/api/buyer-pulse` ✓; `unsubscribe` (365d) ✓; `review-submit` (120d)→`/api/reviews/submit` ✓; `rancher-login`→`/api/auth/rancher/verify` ✓; `member-login`→`/api/auth/member/verify` ✓. **No type mismatches found** — the only token issues are expiry (P1 above).
- **Route existence — all other email targets resolve:** `/access`, `/qualify/[consumerId]` (folder matches `{consumerId}` exactly), `/member`,`/member/login`,`/member/verify`, `/rancher`,`/rancher/setup`,`/rancher/login`,`/rancher/verify`,`/rancher/sign-agreement`,`/rancher/billing`, `/ranchers/[slug]`,`/ranchers/[slug]/contact`, `/book`,`/book/[refId]`, `/checkout/[refId]/deposit`, `/founders`, `/privacy`, `/unsubscribe`+`/api/unsubscribe`, `/brand-partners`, `/map`,`/wins`,`/map/add-a-rancher`, `/reviews/submit`, `/contact`, `/go/[code]`, `/r/[code]`, `/api/rancher/activate`+`/decline` (manual pitch CTAs). All exist.
- **Onboarding doc links exist:** `BHC_Commission_Agreement.docx`, `BHC_Media_Agreement.docx`, `BHC_Rancher_Info_Packet.pdf` all present in `public/docs/`.
- **No `/undefined`, `/null`, or empty-slug `/ranchers/` links.** The contact-block (`lib/email.ts:1252`), reroute view-ranch (`:3915`), pricing view-ranch (`:1203`), and deposit/book links are all guarded by `slug ? … : ''` / `referralId ? … : /book` fallbacks. `cal-reminder` empty-link is guarded (degraded, not broken — see P2).
- **`{referralId}` vs `[refId]` / `{consumerId}` naming** is internal-only; URLs resolve correctly. Not a bug.
- **Unsubscribe carries the right identifier** — token encodes `{email,type:'unsubscribe'}`; the page decodes it and POSTs `/api/unsubscribe` to suppress. Works (check #5 PASS).
# BHC Email QA — FUNCTION + TRIGGER audit (read-only)

Scope: every automated/cron/lifecycle email in `/Users/benji.bushes/BHC/untitled folder/bhc`. Cross-referenced against `docs/EMAIL-AUDIT.md`. Verified against source. No files edited.

Severity key: **P0** = double-send / wrong-recipient (spam / trust) · **P1** = reply-lost-or-wrong-branch · **P2** = dead-code / dormant.

---

## Counts
- **P0: 6** (1 no-stamp cron + 4 send-then-stamp re-send vectors + 1 nurture-on-unqualified-buyers)
- **P1: 11** (2 rancher-status gate leaks + 8 missing reply-tags + 1 AI-body no-fallback/no-guardrail)
- **P2: 3** (sequences engine dark + day-14 onboarding-stuck dead body + Telegram-only "no-email" crons noted)
- **Total flagged: 20**

> **Worst finding (P0):** `app/api/cron/migration-deadline/route.ts` writes **no dedup stamp at all** — its only guard against re-sending a nudge to the same rancher is "the cron runs once per calendar day." `withCronRun` (`lib/cronRun.ts`) provides no lock, so any Vercel retry or manual `?secret=` replay in the same UTC day recomputes the identical `daysLeft` (7/4/2/1), passes `NUDGE_DAYS.has(daysLeft)`, and **re-fires the same deadline email to the same rancher**. Nothing is read or written to stop it.

---

## 1 · Idempotency / double-send

Architecture: no cron takes a distributed lock; each cron's own field/stamp is the sole guard. The **safe** pattern is stamp-BEFORE-send (with rollback on send failure); the **risky** pattern is send-THEN-stamp inside a `try` — a successful send followed by a thrown Airtable `updateRecord` (rate-limit / field drift) drops the stamp, and the next run re-sends.

| Severity | Cron | Stamp/field relied on | Issue | file:line | Fix |
|---|---|---|---|---|---|
| **P0** | migration-deadline | **none** | No dedup field whatsoever; only guard is exact `daysLeft ∈ {7,4,2,1}` + once-a-day assumption. Double-invoke (retry/replay) re-sends. | check `migration-deadline/route.ts:162`; send `:178`; no write | Stamp `[mig-nudge dN]` in Notes (or `Last Migration Nudge At` + day) and skip if already sent for that dN. |
| **P0** | rancher-onboarding-drip | `Self-Submit Drip Stage` | Send-then-stamp in same `try`; if stage-flip `updateRecord` throws after a good send, stage stays `welcome-sent`/`day2-sent`/`day5-sent` → **same drip re-sends EVERY daily run** until the write lands (no date sub-guard, purely stage+elapsed-days). Highest single-record blast radius. | send `route.ts:109/113/117`; stamp `:110/114/118`; catch `:148` | Stamp stage BEFORE send, roll back on send failure (mirror rancher-launch-warmup Phase 1). |
| **P0** | referral-chasup (rancher Day-2) | `Rancher Reminded At` (4d throttle) | Send `:293` then stamp `:306-308` in same try. Stamp-write failure → re-send next run. (Blocks 4b/5a/5b in these same files were deliberately reordered to stamp-first with "MISMATCH FIX" comments; this block was left send-first.) | send `:293`; stamp `:306-308` | Reorder: stamp before send. |
| **P0** | referral-chasup (buyer AI chase) | `Chase Count`+`Last Chased At` | Send `:675` then stamp `:689-693`; stamp failure re-sends the AI email next run. | send `:675`; stamp `:689-693` | Reorder: stamp before send. |
| **P0** | referral-chasup (repeat-purchase) | `Repeat Outreach Sent` (bool) | Send `:748` then set flag `:749`; flag-write failure re-sends. | send `:748`; stamp `:749` | Reorder: set flag before send. |
| P1 | cal-reminder-1h | Notes `[cal-reminder-1h]` | Every-10-min cron with a 15-min-wide window → a booking is in-window ~2 consecutive runs. Stamp written AFTER send `:153-156` in a try that only `console.warn`s `:158`. If stamp fails on run A, run B (≤10 min later, still in-window) re-sends. | check `:98-101`; send `:123`; stamp `:153-156` | Stamp before send; or narrow window to < run interval. |
| P1 | rancher-launch-warmup (Day-7 nudge) | `Warmup Stage='nudged'` | Phase 1 is exemplary (stamp-before-send + rollback). Phase 2 Day-7 nudge reverts to send-then-stamp `:454-455`, catch logs only `:457` → re-nudge on stamp failure. | send `:454`; stamp `:455` | Reorder to match Phase 1. |
| P1 | buyer-pulse | `Buyer Pulse Sent At` | Send `:137` then stamp `:160-163`; code comment `:165-167` literally documents "pulses re-fire each run" on stamp failure. One pulse/intro intended. | check `:69`; send `:137`; stamp `:160-163` | Stamp before send. |
| P1 | abandoned-quiz-nudge | Notes `[quiz-nudge YYYY-MM-DD tN]` | Send-then-stamp `:184-186`; mitigated by same-day + spacing sub-guards (caps damage to 1 extra touch), but still re-touches on stamp failure. | check `:151-164`; send `:183`; stamp `:184-186` | Stamp before send. |
| P1 | qualified-no-action | Notes `[no-action-nudge YYYY-MM-DD]` | Send `:134` then stamp `:162-167`; re-sends on stamp failure (1/day mitigated by 30-min rerun + same-day stamp). | check `:90`; send `:134`; stamp `:162-167` | Stamp before send. |
| P1 | rancher-reactivation (first-touch + +5d) | `Campaign Touch Count`/`Last Campaign Email Sent At` | Send-then-stamp (`rancherReactivation.ts:221`, `route.ts:170`). Re-send on stamp failure. **Gated OFF by default** (`RANCHER_REACTIVATION_ENABLED`), so low live risk. | send `:212`/`:159`; stamp `:221`/`:170` | Stamp before send before enabling. |

**SAFE (stamp-before-send, verified):** referral-chasup stale-prompt (`:543-546` before send `:547`); rancher-followup new-applicant (`:212-214`) + stale-lead (`:335-343`); rancher-launch-warmup Phase 1 (`:203-206`/`:331-336`, with rollback); compliance-reminders (`:82-86`); close-detector (`:164-166`, aborts post if stamp fails); commission-invoices (filter `NOT({Commission Paid})` + same-month Email-Sends dup-check). testimonial-collection is fail-open by design (lifetime Email-Sends query, documented). rancher-trust-promotion sends no email.

---

## 2 · Correct trigger gate

BHC rule (per MEMORY): a buyer is qualified ONLY after funnel + quiz (`Qualified At` set) — **never warm/route on Intent Score / stage alone.**

| Severity | Email/cron | Issue | file:line | Fix |
|---|---|---|---|---|
| **P0** | rancher-launch-warmup (all 3 send paths) | **Nurture fires on UNQUALIFIED buyers.** `grep -niE "qualif|quiz"` → zero qualification logic in the file. Trust-Mode branch selects `{Referral Status}="Waitlisted"` only; throttled branch gates `Buyer Stage IN (WAITING,READY)`+`Status=Approved`; Day-7 nudge gates Waitlisted+stage. None check `Qualified At`/quiz score. Any Waitlisted/WAITING/READY lead is warmed regardless of funnel+quiz. Violates "never send on stage alone." | Trust-Mode select `route.ts:161`, filter `:165-175`, send `:215`; throttled formula `~:285-294`, send `:345`; Day-7 `~:403-455` | Add `Qualified At` (and/or quiz-score) predicate to all 3 gates. |
| P1 | rancher-reactivation | **Reaches PAUSED & NON-COMPLIANT ranchers.** `rancherReactivationSegment.ts` excludes test/tier_v2/no-email/Unsubscribed only. `Active Status` read `:236` but used solely for tier assignment `:243-244` — no `if(active==='Paused') continue`; no compliance-status read at all. A Paused/Non-Compliant legacy rancher (not in hardcoded `EXCLUDE_RANCHER_IDS`) gets the email. | `rancherReactivationSegment.ts:203-244` | Add field-level Paused + Non-Compliant exclusions to the segment filter. |
| P1 | rancher-followup (stale-lead / Monday branch) | **Stale-lead nudge reaches Paused/Non-Compliant ranchers.** Prospect-nudge branch correctly excludes them (`:67`). The Monday stale-lead branch starts a fresh REFERRALS query `:271`, resolves rancher via `find()` `:326`, gates only `if(!rancher)`/`if(!rancherEmail)` `:327-329` — the `:67` guard never runs for this path. Paused rancher w/ stale Intro-Sent referral gets nudged. | gate gap `:326-346`; send `:346` | Re-apply Paused/Non-Compliant exclusion to resolved `rancher` before `:346`. |

**GATE OK (confirmed):** abandoned-quiz-nudge (pre-qual by design; served-state + not MATCHED/CLOSED `:123-124` + suppression); qualified-no-action (`NOT({Qualified At}=BLANK())` + active Intro-Sent referral); buyer-pulse (Intro-Sent + explicit buyer suppression `:92`); migration-deadline (excludes Paused `:108`, restricts Migration Status `:109`); compliance-reminders (Active+Agreement Signed, skips tier_v2/mid-migration/unsub); rancher-onboarding-drip (stops on Verified/opted-out/Paused/Non-Compliant `:70-76`).

**No raw-resend suppression bypass exists.** Every audited cron sends via `sendEmail`/`lib/email.ts` template helpers, all of which route through the wrapped `resend.emails.send` (`lib/email.ts:282`) that runs the Unsubscribed/Bounced/Complained suppression check before delivery. (The content audit's premise that the self-submit drips use raw `_resend` is **incorrect** — they use guarded `sendRancherOnboardingDripDay2/5/14`. Unsubscribe/bounce is safe platform-wide.)

---

## 3 · Reply-To threading

**Important correction to the content audit's framing.** The `resend.emails.send` wrapper (`lib/email.ts:312-319`) defaults Reply-To to the catch-all `inbox@replies.buyhalfcow.com` when no `_replyContext` is passed (it no longer falls back to Ben's raw `ben@` inbox). So untagged replies are **captured by `/api/webhooks/resend-inbound`** — they are NOT lost. BUT `parseReplyAddress` explicitly returns `null` for `inbox@` (`lib/replyAddressing.ts:73`), so these replies are **UNATTRIBUTED**: not threaded to the specific record, no record-linked activity stamp, surfaced only as a generic catch-all (Telegram + Conversations) — unless the inbound From-email fallback (`resend-inbound:~290-316`) happens to match the sender to a Referral by *buyer* email (never matches rancher-side senders).

**Net:** finding is **"reply not auto-classified / no record-linked activity stamp,"** not "reply lost." All 8 confirmed missing a tag (P1). The 4 that hand-roll a "reply to this email" CTA are the highest-value fixes — they actively invite replies that then can't be threaded.

| Severity | Email | send call file:line | Tag? | Hand-rolls "reply…"? | Fix |
|---|---|---|---|---|---|
| P1 | Rancher Onboarding Package | `ranchers/[id]/send-onboarding/route.ts:179` | missing | **Yes** ("Reply to this email or text me") | pass `_replyContext:{type:'rnc',recordId:rancher.id}` |
| P1 | Agreement Signed "set up your page" | `ranchers/sign-agreement/route.ts:213` | missing | no | `'rnc'` tag |
| P1 | Admin reassign → new rancher intro | `admin/referrals/[id]/reassign/route.ts:166` | missing | no | `'ref'` tag (referral id in scope) |
| P1 | Resend-intro → rancher copy | `admin/referrals/[id]/resend-intro/route.ts:58` | missing | no | `'ref'` tag (buyer copy `:112` already tags `ref`; only rancher copy untagged) |
| P1 | Land-inquiry → seller | `land/[id]/inquire/route.ts:84` | missing | **Yes** ("Reply to them directly") | `'inq'` tag (type exists in replyAddressing, unused) |
| P1 | Land-inquiry → inquirer confirm | `land/[id]/inquire/route.ts:110` | missing | no | `'inq'` tag |
| P1 | Self-submit drip Day 2 | def `lib/email.ts:4141`; cron `rancher-onboarding-drip/route.ts:109` | missing | **Yes** ("Reply with a phone number…") | `'rnc'` tag |
| P1 | Self-submit drip Day 5 | def `lib/email.ts:4182`; cron `:113` | missing | no | `'rnc'` tag |
| P1 | Self-submit drip Day 14 | def `lib/email.ts:4227`; cron `:117` | missing | **Yes** ('reply "remove"') | `'rnc'` tag |

(Note: the buyer-intro template `sendBuyerIntroNotification` DOES tag `ref` correctly at `lib/email.ts:~1362` when `referralId` present — its reply path is fine.)

---

## 4 · Conditional branches — `sendBuyerIntroNotification` (`lib/email.ts:1132-1398`)

No branch renders a *broken* (empty-href) button or a blank email; the two real exposures are **silent omissions** of the conversion CTA, not wrong variants.

| Severity | Branch | Decider | Verdict | file:line |
|---|---|---|---|---|
| P1 | tier_v2 reserve block falls through to legacy | `hasMagicLink = !!data.depositMagicLinkUrl` — **caller**-built, only when `pricingModel==='tier_v2' && buyerId && buyerEmail` | **FLAG.** A tier_v2 rancher whose buyer is missing `buyerId`/`buyerEmail` (reassign path `:106` requires only buyerId; suggest `:1178` requires both) builds no magic link → `hasMagicLink=false` → renders legacy "tap any tier above" copy that has **no deposit button at all** (template carries no per-tier pay-link href). The intended tier_v2 deposit CTA silently disappears. | decider `:1220`; legacy block `:1239` |
| P1 | Reserve CTA entirely omitted | `reserveBlock=''` when neither `hasMagicLink` nor `hasAnyPayLink` (`pricingRows.length>0 && rancherSlug`) | **FLAG.** tier_v2 (or legacy) rancher with no tier prices set OR no slug + no magic link → the whole "RESERVE YOUR SHARE" CTA vanishes, no fallback. Primary conversion ask gone. | `:1224-1246` |
| PASS | Cal-CTA variants (Operator / rancher-slug / none) | `isOperatorTier` `:1284` → else-if `normalizedCalSlug` `:1305` → else `''` | Mutually exclusive `if/else if`; can't co-render. Operator href via `resolveBookUrlGuarded` always returns a real URL (live Cal slot or `/contact` fallback); slug href always `/book/{referralId}` or `/book`. | `:1283-1320` |
| PASS | `skipBuyerIntro` suppression | `suppressBuyerIntro = !!body?.skipBuyerIntro && matchedRancherPm==='tier_v2'` | **Confirmed exact** — suppresses only when caller passes flag AND matched rancher is tier_v2; legacy always gets intro. Lives only in matching/suggest (resend-intro/reassign always send, correct for operator-initiated). | `matching/suggest/route.ts:1193-1195` |
| PASS | Pricing table empty header | `pricingBlock = pricingRows.length>0 ? … : ''` | Guarded — no orphan header; whole block drops when no tier priced. | `:1196` |
| PASS | `$undefined`/`NaN`/"undefined lbs" | each row guarded `if(data.X && data.X>0)`, lbs `${lbs||''}${lbs?' lbs':''}` | No `$undefined`/`$NaN`. Minor: malformed `Next Processing Date` would render "Invalid Date" via `toLocaleDateString()` (ISO field, low risk). | rows `:1178-1193` |

Migration/upgrade tier table (`sendV2UpgradeInvite`, `admin/ranchers/[id]/send-v2-upgrade/route.ts:167`): static 4-row markdown table, no per-rancher conditional rows — no blank-section risk.

---

## 5 · Dead / unreachable sends + dormant engine

| Severity | Item | Issue | file:line |
|---|---|---|---|
| P2 | onboarding-stuck Day-14 "final automated nudge" body | **Unreachable.** `bucket==='day14'` short-circuits to admin Telegram + `continue` (`:148-166`) BEFORE the email send block (`:168-189`). The `day14` urgency string in `emailHtml()` (`:58-61`) can never render. | dead branch `route.ts:58-61`; escalation `:148-166` |
| P2 | **email-sequences engine — FULLY DORMANT** | `route.ts:849` hard-returns `{ok:true, skipped:'EMAIL_SEQUENCES_ENABLED=false …'}` unless `EMAIL_SEQUENCES_ENABLED==='true'` (paused 2026-06-09). Confirmed the ONLY `EMAIL_SEQUENCES_ENABLED` references are `:846/:849/:852`. Cron stays scheduled (`vercel.json` `0 16 * * *`) but every send below is dark. | gate `route.ts:849` |

**Dark sequences (all built, never fire while the flag is off):** 3× Abandoned Application Recovery (`route.ts:112`); MATCH_NOW rescue fallback (`:475`) + MATCH_NOW promote-PA buyer intro (`:338`) + rancher intro (`:356`); routing-segment nudges NUDGE_TO_ENGAGE (`:498`), WARM_LEAD (`:509`), NO_BUDGET_FOUNDER_PITCH (`:518`), STATE_WAITLIST (`:527`), INCOMPLETE_PROFILE (`:547`); 3× WAITING founder letters (`:567/:576/:588`); READY Day-7 nudge (`:607`); MATCHED Day-4 (`:630`); CLOSED cuts Day-14 (`:653`); CLOSED monthly M2/M3/M4 (`:662/:670/:678`); CLOSED repeat-ask (`:687`); 3× rancher agreement reminders D3/D7/D14 (`:784`). → decide per-sequence: revive (optimized) or delete.

**Confirmed Telegram-only "no-email" crons** (correct, noted so they aren't mistaken for broken sends): stuck-buyer-recovery, re-warm-cohort, reclassify-buyers, awaiting-payment-nudge (operator card only — **the documented "biggest missing money-moment touch": a buyer who pays a deposit gets no email**; settlement is Telegram-only in `stripe-connect` webhook + `lib/stripeSettlement.ts`), rancher-trust-promotion, close-detector.

---

## 6 · AI-generated bodies — guardrails

| Severity | Body | Guardrails present | Guardrails MISSING | file:line | Fix |
|---|---|---|---|---|---|
| P1 | Buyer chase (referral-chasup, Claude-drafted) | `maxTokens:500`; prompt says "2-3 paragraphs, warm, not pushy"; rancher name pulled from linked record (avoids "did Jose reach out at High Lonesome" bug). | **No LLM-failure fallback** — `callClaude` (`:664`) is NOT wrapped; the surrounding try is only for the rancher-name lookup. On throw, the outer per-referral catch (`:716`) just `errors++` and continues — **no email at all, no fallback copy.** **`draft.split('\n')` (`:684`) throws if `draft` is undefined/empty** → silently counted as an error. **No output length cap** (only token cap). **No hallucination guard** — nothing stops invented prices/promises/delivery dates; prompt never says "do not state prices or make commitments." | prompt `:655`; call `:664`; `.split` `:684`; send `:675` | Wrap call in try with a static fallback body; guard `if(!draft||draft.length<20) continue`; add "Do not state prices, dates, or make commitments" to system prompt; cap length. |
| P2 | `lib/autoRespond.ts` (inbound auto-reply, Claude-drafted) | **Has guardrails** — try/catch on `callClaude` returns `{sent:false,'classify-failed'}` (`:31-33`); empty/short-draft guard `if(!draft||draft.length<20)` (`:34`); try/catch on send (`:42`); subject capped `.slice(0,200)`; tight system prompt (one paragraph, no bullets). | Minor: **no max-length cap** on the body (only `maxTokens:300`); **no explicit "do not invent prices/promises"** — though the prompt's only sanctioned statements are "rancher reaches out within 48h" / "routing you to a backup," which bounds it. Lower risk than the buyer chase. | `lib/autoRespond.ts:24-44` | Optional: add price/promise prohibition + length cap to match. |

> The buyer chase is the gap: an LLM failure or empty draft produces a **silent miss** (no email + no fallback), and there is **no prohibition on hallucinated prices/promises**. `autoRespond.ts` is the model to copy (fail-closed + length/empty guards).

---

## Top fixes, ranked
1. **migration-deadline** — add a per-rancher per-day dedup stamp (P0, the only zero-guard cron).
2. **rancher-onboarding-drip** — stamp stage BEFORE send (P0, re-sends every run on stamp failure).
3. **rancher-launch-warmup** — add `Qualified At` gate to all 3 paths (P0, warms unqualified buyers).
4. **referral-chasup** ×3 + **buyer-pulse** / **cal-reminder-1h** / **warmup Day-7** — reorder to stamp-before-send (P0/P1).
5. **rancher-reactivation** + **rancher-followup stale-lead** — exclude Paused/Non-Compliant (P1).
6. **Buyer chase AI** — fail-closed fallback + no-price/promise guard (P1).
7. **8 reply-tags** — pass `_replyContext` (P1; replies are captured-but-unattributed, not lost).
8. **tier_v2 buyer-intro** — ensure caller always supplies buyerId+buyerEmail, or render a deposit fallback (P1 silent-omission).
# BHC Email — Copy Correctness Audit (Track D)

Read-only audit of every BHC email body (source = the code that builds it, not the inventory prose). Scope: interpolation/merge-field safety, stale tier_v2 money claims, system-vs-copy mismatches, subject↔body, brand consistency, signature drift.

**Method:** Read `docs/BHC.md` (tier_v2 rules) + `lib/tiers.ts` rates, then traced every template in `lib/email.ts` and every inline-route / cron / broadcast body. Verified null-guarding in source and checked tier-gating at each 10% template's CALL SITE (not just the body text).

**Headline:** The merge-field layer is much safer than feared — `lib/email.ts` helpers uniformly guard (`first = data.firstName || 'there'`, prices gated by `if (price > 0)`, `lbs || ''`). **No buyer will ever see a literal `{firstName}`, `$undefined`, or `NaN`.** The real damage is two **buyer-facing** emails still asserting the legacy "10% on close" model, and one **rancher go-live** email selling the legacy close-then-invoice flow to tier_v2 ranchers. One genuine broken-subject bug (empty state) in 3 rancher intro routes.

---

## Counts
- **P0 (broken merge / false claim that reaches users): 4**
- **P1 (stale money / model claim, tier_v2 contradiction): 4**
- **P2 (voice / signature / footer drift): 6**
- **Total: 14** · Plus: explicitly CLEARED the cal-reminder "Join link" concern and the "no middleman/no markup" lines (not bugs — see bottom).

---

## P0 — broken merge OR false claim that reaches the recipient

### P0-1 · Buyer-facing email asserts legacy "10% on close" — directly contradicts tier_v2
`lib/email.ts:4282` — `sendMatchNowRescue` ("your rancher is lined up", buyer-facing, MATCH_NOW rescue).
> "From there it's between you and the ranch — pickup date, cut sheet, payment method. **We take 10% only when the deal closes. The rancher keeps 90.**"
This is the legacy model verbatim. Per `docs/BHC.md`, on tier_v2 the **deposit closes the buyer up front**, the rate is tier-based (10/7/3/0%), and **Ben runs the sales call** — it is NOT "between you and the ranch, we invoice 10% after." A buyer who then pays a deposit on a Pasture/Ranch/Operator rancher was told the wrong economics.
**Fix:** Drop the "we take 10% / rancher keeps 90" sentence. Replace with deposit-reserve language consistent with `sendBuyerIntroNotification` ("a deposit puts you on the books… refundable until the rancher accepts"). Counted P0 (false claim, buyer-facing) rather than P1 because it misstates the transaction to the paying party.

### P0-2 · Second buyer-facing "10% only when the deal closes"
`lib/email.ts:4322` — `sendNudgeToEngage` ("quick question on your {state} beef timing", buyer-facing).
> "They reach out to you direct. No middleman, no markup — **we take 10% only when the deal closes.**"
Same stale claim, same contradiction with tier_v2. **Fix:** delete "— we take 10% only when the deal closes"; the "no middleman, no markup" half is fine to keep.

### P0-3 · Rancher GO-LIVE email sells the legacy close-then-invoice flow to tier_v2 ranchers
`lib/email.ts:1666-1673` — `sendRancherGoLiveEmail` ("You're Live").
> "2. Reach out directly to discuss their order and **close the deal**
> 3. Mark the referral as **'Closed Won'** in your dashboard and enter the sale amount — **we'll handle the rest**"
**Confirmed NOT tier-gated at either call site:** fires for ANY rancher flipping live —
`app/api/cron/batch-approve/route.ts:314` (auto-go-live) and `app/api/admin/ranchers/[id]/route.ts:200` (manual). For a **tier_v2** rancher this is wrong: Ben runs the call, the buyer's **deposit** closes the deal, and commission is taken upfront via Connect — the rancher does NOT "close the deal" or self-report a sale amount to trigger an invoice. A freshly-migrated rancher's first system email tells them the legacy workflow.
**Fix:** branch on `Pricing Model === 'tier_v2'` and send a deposit-flow "how it works" (deposit lands in your Stripe same-day, Ben runs the call, you fulfill) for v2; keep the close-then-invoice copy for legacy only.

### P0-4 · Three rancher-intro SUBJECTS render "…Introduction: Buyer in " when Buyer State is blank
- `app/api/referrals/[id]/approve/route.ts:89,98` — `buyerState = referral['Buyer State'] || ''` → `subject: \`BuyHalfCow Introduction: ${buyerName} in ${buyerState}\``
- `app/api/admin/referrals/[id]/reassign/route.ts:159,168` — same pattern
- `app/api/admin/referrals/[id]/resend-intro/route.ts:48,60` — same (`[Resend] BuyHalfCow Introduction: {buyerName} in `)
When `Buyer State` is empty the subject ends "…Introduction: Buyer in " with a dangling "in " + trailing space (and the greeting/body also lose the state). Note `buyerName` is guarded (`|| 'Buyer'`); only `buyerState` is the offender. Rancher-facing, so lower blast-radius than a buyer email, but it is a real broken subject line that ships.
**Fix:** guard the subject — e.g. ``in ${buyerState || 'your area'}`` or drop "in {state}" from the subject when empty. (Same `Buyer State` field is the merge source across all three.)

---

## P1 — stale money / model claims (legacy 10% surfacing where tier_v2 now applies)

> Context check performed: the monthly **commission invoice** (`sendMonthlyCommissionInvoice`, body says "Commission (10%)" `lib/email.ts:3499`) and the **compliance "report your sales"** email DO tier-gate — `app/api/cron/commission-invoices/route.ts:88` and `app/api/cron/compliance-reminders/route.ts:60` both `continue` for `tier_v2`. So those 10% references are correctly legacy-only and are NOT flagged. The V2 Upgrade Invite tier table (`send-v2-upgrade/route.ts`) is correct and matches `lib/tiers.ts` exactly (Legacy Connect 10%/$0, Pasture $150/7%, Ranch $350/3%, Operator $500/0%). The items below are 10% claims with NO tier gate or that assert "buyers pay you directly" in a tier_v2-reachable context.

### P1-1 · `sendRancherCheckIn` recap lists "10% commission … buyers pay you directly" — no tier gate
`lib/email.ts:3202` and `:3219` (two status branches):
> "1. Sign the Commission Agreement — **10% on referred sales**, no upfront fees, **buyers pay you directly**"
> "**10% commission on referred sales only** … Buyers pay you directly — you control your pricing"
Triggered manually via Telegram (`/checkin`) `app/api/webhooks/telegram/route.ts:2083` with no tier check. "Buyers pay you directly" is the legacy flow; on tier_v2 the buyer pays a **deposit through BHC/Connect**. If used on a migrated rancher it contradicts the deposit model. **Fix:** gate on tier, or soften to "commission per your plan."

### P1-2 · `sendInquiryToRancher` footer hard-codes 10%
`lib/email.ts:2565`:
> "Remember: **10% commission applies to sales made through the platform.**"
Fires from `/api/inquiries/[id]` with no tier gate. Wrong flat rate for Pasture/Ranch/Operator. **Fix:** drop the flat-rate line or make it tier-aware.

### P1-3 · Manual rancher-intro emails assert flat 10% in the sign-off
- `app/api/referrals/[id]/approve/route.ts` body tail: "Remember: 10% commission applies to sales made through BuyHalfCow referrals." (inventory line; same file as P0-4)
- `app/api/admin/referrals/[id]/reassign/route.ts:~196` "— Benjamin, BuyHalfCow · 10% commission applies to sales made through referrals."
Admin-approve / reassign can target a tier_v2 rancher; the flat-10% reminder is stale for non-Legacy tiers. **Fix:** remove the flat-rate reminder from these transactional intros (the rate lives in their agreement/dashboard, not every lead email).

### P1-4 · Manual broadcast `reengage-unsigned-ranchers.mjs` (Group A) pitches "Same 10% commission on closed deals"
`scripts/reengage-unsigned-ranchers.mjs` Group-A body: "Five minutes, one signature… **Same 10% commission on closed deals.** Non-exclusive." This is a hand-run script, but it re-onboards ranchers onto the *legacy* 10%-on-close framing rather than the current tier ladder + deposit flow. Lower urgency (manual, `--execute`-gated) → P1 not P0. **Fix:** if re-run, point to `/rancher/setup` tier picker instead of asserting a flat 10%-on-close.

*(Not flagged: `lib/tiers.ts:56,71` "when you close a deal" — that's perk-description copy for Legacy/lower tiers, internally consistent.)*

---

## P2 — voice / signature / footer drift (normalization pass)

### P2-1 · Sign-off is inconsistent across the set
Within `lib/email.ts` alone there are **49** sign-off occurrences spanning at least five forms:
`— Ben` · `— Benjamin` · `— Benjamin, Founder` · `— Benjamin, Founder<br>BuyHalfCow` · lowercase `— ben` (e.g. `sendBackerMonthlyLetter` `:1826`, payout-failed) · `— Ben @ BuyHalfCow`.
`docs/BHC.md` voice spec says sign every email `— Ben` or `— Benjamin`, never a team sig. **Fix:** pick one canonical per audience (buyer-warm = `— Ben`; rancher-formal = `— Benjamin, Founder`) and normalize.

### P2-2 · Subject-line casing is split
Lowercase founder-voice (`your rancher is lined up…`, `welcome to buyhalfcow`) vs Title Case (`BuyHalfCow Introduction:`, `Your BuyHalfCow Login Link`, `Monthly Sales Report`). `docs/BHC.md` mandates lowercase sentence-fragment subjects. The transactional/rancher set is the main offender. **Fix:** lowercase the founder-voice ones; the legal/transactional ones can stay Title Case if intentional, but decide and document.

### P2-3 · Double footer (address + unsubscribe twice)
The `resend.emails.send` wrapper auto-appends the CAN-SPAM block (`lib/email.ts:474-485`), yet several templates hand-roll their own address/unsubscribe inside the body (e.g. `buyer-pulse` body ends with `BuyHalfCow · 1001 S. Main St…`, `sendBackerMonthlyLetter` prints `{BUSINESS_ADDRESS}` + `[unsubscribe]` then the wrapper adds it again, the merch broadcasts hand-roll `[Unsubscribe]`). Result: physical address + unsubscribe rendered twice. **Fix:** pass `_skipFooter` where the template hand-rolls, or strip the inline footer and rely on the wrapper.

### P2-4 · Founder name swings between "Ben" and "Benjamin" *within the same audience*
Buyer nurture mixes `— Ben` (warmup, pulse) and `— Benjamin, Founder` (abandoned-app recovery, member-login). Same person, same buyer, different name in consecutive touches. Cosmetic but noticeable. **Fix:** lock per-sequence.

### P2-5 · Tagline / closer inconsistent
Some emails close with `Connecting every household to a ranch they trust.` (quiz-nudge, cal-reminder, resend-quiz), most don't; founder letters use `we're gonna take back american ranching…`. Not wrong, just unstandardized. **Fix:** decide which tagline is the buyer-side default.

### P2-6 · "BuyHalfCow" vs "bhc" capitalization mixed in body copy
`sendBackerMonthlyLetter` + `CLOSED cuts` p.s. use lowercase `bhc` / `bhc patches`; everywhere else it's `BuyHalfCow`. Intentional in the lowercase founder-letter voice, but flag for a consistency decision. **Fix:** allow lowercase only in the explicitly-lowercase founder-letter template; normalize elsewhere.

---

## Explicitly CLEARED (checked, NOT bugs) — so they aren't re-flagged later

- **cal-reminder "Join link" empty-line concern (inventory P3):** NOT a bug. `app/api/cron/cal-reminder-1h/route.ts:54` gates the whole line behind `${calLink ? \`<p>Join link: …\` : ''}`; `calLink` is intentionally `''` (line 119), so the block is fully suppressed — no orphan "Join link: ". Safe.
- **"No middleman, no markup" / "rancher keeps 90%":** brand-correct post-pivot for the *buyer*-side (the buyer still pays no markup on the meat and the rancher still keeps their price). Only flagged where it's bundled with the stale "we take 10% on close" (P0-1/P0-2). The standalone "no middleman" lines (`lib/email.ts:578,719,3001`) are fine.
- **`sendBuyerIntroNotification` (lib/email.ts:1132, the most-sent buyer email):** clean. Properly tier-aware — magic-link deposit block for tier_v2, pay-link for legacy, dedicated Operator-tier "15 min with Ben" block. Prices all gated `if (price > 0)`, `firstName || 'there'`, slug-conditional contact block. No stale 10%.
- **Inline-route + cron merge fields generally:** `firstName`/`first` uniformly fall back to `'there'`; `rancherName`→`'your rancher'`/`'Partner'`/`'Rancher'`; land-inquiry fields all `||`-guarded; threads/message guarded. The ONLY raw-empty merge that ships is `buyerState` (P0-4). `member/ready-to-buy/route.ts:198` renders `<strong></strong>` + "in " if Full Name/State are blank — same `|| ''` pattern; lower-stakes (rancher-facing alert, name usually present) so folded into the P0-4 theme rather than listed separately.

---

## One-line recommendation
Fix the **two buyer-facing "10% on close" lines** (`lib/email.ts:4282`, `4322`) and the **tier-gating of `sendRancherGoLiveEmail`** first — those are live, automated, and tell the wrong money story to the exact people who are about to transact under tier_v2. Then guard `buyerState` in the three intro subjects. Voice/footer drift is a single normalization pass afterward.
