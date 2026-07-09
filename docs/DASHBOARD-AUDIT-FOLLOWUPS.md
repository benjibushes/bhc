# Rancher Dashboard SaaS Audit — remaining follow-ups

*2026-07-08. The full 4-lens audit found 15 confirmed defects (0 refuted).
The 2 CRITICALs (money truth) + 1 recovered guard fix shipped in PR #356.
The 11 verified IMPORTANTs below are documented for a follow-up pass —
none is bleeding money; they're UX seams, honesty copy, and notification
gaps. Each has exact file:line evidence + a fix. Say "do the dashboard
followups" (or pick a number) to build them.*

---

## Two live records to reconcile (Ben ops decision — from the #4 leak)
Under the old logic these off-rail tier_v2 closes ate the commission BHC
was owed. The rail is now correct going forward; these two are NOT
retro-touched by the code fix:
- Foodstead off-rail close `recdPCQIUHOY2QSA1` — ~$34.50 commission.
- Plus the $156.91 aggregate cited in the audit. Retro-invoice or write
  off — your call. (After PR #356 deploys, these now correctly show as
  "Unpaid / Invoice pending" in the dashboard.)

---

## The 11 importants (ranked cheapest-highest-value first)

1. **settleFinalInvoice never notifies the rancher a deal fully paid.**
   lib/stripeSettlement.ts:408-546 fires admin Telegram only. Add
   sendRancherPush + email after recordClose (mirror notifyRancherDepositPaid).
   *Cheap, high value — the rancher misses their payday ping.*

2. **/rancher/inbox false-empty on 401.** app/rancher/inbox/page.tsx:37-45
   swallows an expired-session 401 into "No messages yet." Check res.status
   → push('/rancher/login') on 401, error+retry otherwise. *Cheap.*

3. **Two contradictory "active" counts on Home.** page.tsx:5602 (5 held
   statuses via mirror) vs :5613 "Buyers working" (3). Derive both from
   HELD_REFERRAL_STATUSES or relabel ("in conversation" vs "slots held"). *Cheap.*

4. **"We ship nationwide" checkbox pretends to be self-serve.** Routing needs
   the admin-only `Admin Approved Multi-State` flag (matching/suggest:843).
   Add the "pending review" caveat (like Preferred States) + fire an admin
   Telegram when it flips on unapproved. *Cheap copy + 1 alert.*

5. **Absorption copy overstates on floor-bound cheap products.**
   ProductsTab:644-649 claims full "card processing on us" but absorbStripeFee
   floors at max($1, 2%) (feeMath.ts:50-53) — partial/zero on thin margins.
   Make the preview honest below break-even (compute real absorption). *Medium.*

6. **Final-invoice rail has no absorption but claims "100% to you."**
   createFinalInvoiceCheckout omits application_fee (stripeConnect.ts ~605),
   so the balance charge's Stripe fee comes off the rancher — "100% of your
   price" overstates. Either absorb on the balance or soften the copy to
   "minus card processing on the balance." *Medium — money-honesty.*

7. **Subscription payment failure invisible to the rancher.**
   webhooks/stripe.ts:1289-1379 (alertInvoicePaymentFailed) has admin +
   brand branches but no RANCHER branch — no dunning email/push. And
   /rancher/billing hides the Stripe-portal button in past_due. Add the
   rancher branch + show the portal button when past_due/unpaid. *Medium —
   silent churn risk once ranchers are on paid tiers.*

8. **Tier change is a dead-end.** /api/rancher/tier/change exists, zero UI
   callers; tier/select 409s subscribed ranchers toward it. Add an
   upgrade/downgrade control on /rancher/billing (confirm + POST). *Medium.*

9. **Email change orphans the Supabase password login.** account editor
   (page.tsx:6220-6230) → landing-page route writes Airtable only, no
   Supabase Auth email sync; password login then breaks and "Set password"
   binds the stale email. Sync admin.auth.updateUserById on email patch +
   re-mint session, OR (minimum) warn in the account section + tell them to
   use magic-link then re-set password. *Medium — auth correctness.*

10. **Slug rename has no safety.** page.tsx:3631-3641 freely editable; only
    uniqueness checked; no redirect — every shared link 404s. Add a
    "Previous Slugs" field + 301, or a confirm dialog on a live page. *Medium.*

11. **No self-serve account closure.** /api/rancher/remove only accepts the
    wizard `rancher-setup` JWT, not the dashboard session. Add a "remove my
    ranch" action under requireRancher + confirm. *Lowest urgency.*

12. **Preferred States save never updates States Served.** The client always
    re-sends the stale `States Served` (page.tsx:571 seeds it, :1362 spreads
    it), so the server mirror (landing-page/route.ts:728-730,
    `if (!('States Served' in fields))`) never fires — a rancher edits the
    states they serve, sees the saved banner, but the public page + eligibility
    fallback keep the OLD states forever (worse: an empty stored value gets
    actively nulled). Fix: drop `States Served` from the client save body (it
    has no editor), OR let an incoming `Preferred States` change win the mirror
    server-side. *Medium — routing/coverage correctness.*

---

## Already fixed (this session, PR #356)
- **#3** earnings + CSV rail-per-referral (Silverline +$440 overstatement).
- **#4** off-rail tier_v2 commission leak (Foodstead +$156.91) — now invoiced.
- **#2** silent-wipe guard re-arm (parityHydratedRef reset before re-seed) —
  recovered from the credit-interrupted agent run.
