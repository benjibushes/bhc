# Launch Week Runbook — State Ads Go Live

**Status:** DRAFT plan. Every flip below is Ben's hand on the switch.
**Unit economics anchor:** avg deal $1,619 (internal, 2026-07-28) × 10% buyer-side
service fee ≈ **$162 of BHC revenue per close**. That number decides everything
below. Deposit checkout converts ~1-for-1 once opened, so the funnel we're buying
is: ad click → page → reserve form → deposit page opened.

## Order of operations

1. **Env flips (Vercel prod, Ben only).** `NEXT_PUBLIC_META_PIXEL_ID` (browser
   pixel), `META_PIXEL_ID` + `META_CAPI_ACCESS_TOKEN` (server CAPI). Then flip
   `META_DEPOSIT_PURCHASE_ENABLED` + `NEXT_PUBLIC_META_DEPOSIT_PURCHASE_ENABLED`
   so deposit-paid fires Purchase, and `META_CLOSE_PURCHASE_ENABLED` for
   Closed-Won attribution. (All fail-silent if missing — ads would run blind.
   Reminder: Sensitive vars pull blank but ARE set at runtime; verify by event,
   not by `vercel env pull`.)
2. **Meta Business Manager.** Verify the `buyhalfcow.com` domain; confirm pixel +
   CAPI events in Test Events (`META_CAPI_TEST_CODE` during QA, unset after).
3. **Day-of re-verification.** Re-pull `/api/stats/public`, each rancher page's
   prices and share counts, and the Foodstead processing date. Fix the stale
   Silverline "July 6" processing date before MO spends a dollar.
4. **Launch order:** MT first (6 closes, real Aug 1 processing date, 19 shares —
   most proof, most true urgency), then NE + the CO ad set (85 waiting CO buyers,
   Champion Valley ships there), then WV (+VA), OR, MO. TX quiz campaign last, as
   a trickle.

## Budget

**$10/day per state ad set, ~$60/day total (~$420/week).** Logic: runway is thin,
and at $162 revenue per close a state has to prove it can buy a close for less
than that before it earns more spend. $10/day is enough for ~150–300 impressions'
worth of learning per day per state without betting the month on an untested
creative. MT may start at $15/day — it has the shortest honest window (Aug 1).

## Scale / kill rules (check daily, act weekly)

- **Scale-up trigger:** spend per close < **$162** (profitable on BHC fee alone,
  before any repeat purchase) → double that state's budget. Leading indicator
  while closes are sparse: spend per deposit-page-opened < ~$80 — at 1-for-1
  checkout conversion that IS a close for half the breakeven.
- **Creative kill:** CTR < 1% after $50 spend on an ad → swap in the next variant.
- **State pause:** $250 spend with zero reserve-form submits → pause the state,
  keep the page, investigate copy/audience before respending.

## TX switch

TX runs quiz-only (`/access`) until Lazy Bar 3's page passes the same three
checks the live five passed: prices set, reserve CTA live, page renders. The week
that happens: retire the quiz campaign, launch the standard state template at the
Lazy Bar 3 page, and give TX the largest budget of any state — 266 waiting buyers
(live 2026-07-28) is more than NE, WV, MO, OR, MT combined.
