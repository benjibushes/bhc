# Meta CAPI — Attributed Closed-Won Purchase (Go-Live Runbook)

**What this is:** When a deal is marked **Closed Won** (any path — rancher dashboard,
quick-action/Telegram button, admin, or Stripe final-invoice), BHC fires **one**
server-side Meta Conversions API `Purchase` event carrying the buyer's reconstructed
`_fbc` click-id, so Meta can attribute the close back to the original ad click — even
though the close happens days later, off-session. This is what makes the ad spend
optimize toward **real revenue** instead of just Leads/InitiateCheckout.

**Status:** shipped **OFF by default**. No new data leaves for Meta until you flip the
flag. With the flag off, behavior is identical to before (the old unattributed
final-invoice Purchase still fires).

---

## The single switch

```
META_CLOSE_PURCHASE_ENABLED = true      # in Vercel env (Production + Preview)
```

- **Unset / not `true`** → OFF. `recordClose()` fires nothing new; `settleFinalInvoice`
  keeps firing its legacy (unattributed) Purchase for final-invoice closes only.
- **`true`** → ON. `recordClose()` fires the attributed Purchase for **all** close paths;
  the legacy `settleFinalInvoice` fire is suppressed (so exactly one Purchase per close).

`fireCapi` already fails open: if `META_PIXEL_ID` or `META_CAPI_ACCESS_TOKEN` is missing,
nothing fires and **a close is never blocked**.

---

## Pre-flight (do these BEFORE flipping to production)

1. **Privacy policy** — confirm the policy discloses that BHC shares measurement data
   (hashed email/phone/name/state + Meta click-id) with Meta for advertising. The
   `/access` funnel should surface data-use language. This is a compliance gate, not a
   code gate — but do not run live without it.
2. **Env present** — confirm `META_PIXEL_ID` + `META_CAPI_ACCESS_TOKEN` are set in Vercel
   (the existing Pixel/CAPI already uses them).

## Test-first (verify fbc actually lands, in Test Events — no live data)

3. Set **`META_CAPI_TEST_CODE`** in Vercel to the code from
   Events Manager → Data Sources → your dataset → **Test Events**. While this is set,
   **all** CAPI events route to the Test Events panel, not the live dataset.
4. Set **`META_CLOSE_PURCHASE_ENABLED = true`** and redeploy.
5. Generate a click with a test `fbclid`: visit
   `https://www.buyhalfcow.com/access?fbclid=TEST123&utm_source=test` and complete a
   signup. Confirm in Airtable that the new Consumer row has **`fbclid`** and
   **`fbclid_ts`** populated. (If they are empty, capture is the problem — stop and check
   `UtmCapture` → `BuyerFunnel` → `/api/consumers`.)
6. Take that buyer through to a **Closed Won** (any path; the rancher tapping "Closed Won"
   with a sale amount is enough). Then open Events Manager → **Test Events** and confirm:
   - a **`Purchase`** event arrived **and was accepted** (not discarded),
   - **`fbc`** is present on it (format `fb.1.<ms>.TEST123`),
   - `value` matches the sale amount, `action_source` = `system_generated`,
   - Event Match Quality reflects the email + click-id.

   Test it from a **dashboard "Closed Won"** (the most common path) — not just a
   Stripe final-invoice — to confirm all close paths fire.

## Go live

7. Once the test Purchase looks right, **unset `META_CAPI_TEST_CODE`** and redeploy.
   `META_CLOSE_PURCHASE_ENABLED` stays `true`. Real closes now report attributed
   Purchases to the live dataset.

## Rollback

- Set `META_CLOSE_PURCHASE_ENABLED` back to unset/`false` and redeploy. Instantly reverts
  to the prior (legacy, unattributed) behavior. No data migration, no code change.

---

## Notes / limits

- **Historical closes can't be back-attributed.** The 16 existing Closed-Won deals have no
  stored click-id (they predate capture). Only closes from buyers who landed with an
  `fbclid` **after** this ships will carry `fbc`. That's expected — offline attribution is
  forward-looking.
- **7-day window.** Meta rejects a `website` event whose `event_time` is older than 7 days.
  We use the **close time** (not the click time), so normal closes are always in-window. A
  backfill of old closes would be rejected — another reason history is out of scope.
- **One event per close.** `event_id = referralId`, server-only (no client Purchase pair at
  close), so there's nothing to double-count against.
- **Click timestamp is mandatory for matching.** `_fbc` needs the *click* ms timestamp
  (`fbclid_ts`), captured at landing. If it's missing, we send the Purchase **without** fbc
  rather than a malformed one (a bad timestamp matches nothing).
