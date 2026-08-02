# Pricing + Onboarding Perfection — Design (2026-06-20)

Source: 7-agent research+audit workflow (3 web research + 3 code/data audit + synth). Goal: rancher "sets their whole price → automatically has a deposit price," onboarding so simple a 5-year-old can list + close. Read-only research; build held for Ben's sign-off on the money model.

## Recommended deposit model
**Percent-of-price reserve deposit (25% default), auto-derived per tier, rounded to clean $50, refundable until rancher accepts.**

### Formula
```
// One rancher input: Whole price ($ TOTAL per share)
wholePrice   = rancher input
halfPrice    = roundTo50(wholePrice * 0.55)   // ~10% small-share per-lb premium
quarterPrice = roundTo50(wholePrice * 0.28)   // ~12% premium
eighthPrice  = roundTo50(wholePrice * 0.15)   // only if offered

// Deposit derives from THAT tier's own price
depositForTier = clamp( roundTo50(tierPrice * DEPOSIT_PCT), DEPOSIT_MIN, tierPrice )
DEPOSIT_PCT = 0.25   DEPOSIT_MIN = 100   roundTo50(x)=round(x/50)*50

// Worked (Whole $5,600): prices 5600/3050/1550 → deposits 1400/750/400
```
Deposit always < tier price (buyer never pays 100% upfront). BHC 10% commission unchanged, still on FULL tier price at deposit time (orthogonal).

### Why
- Real beef farms cluster deposits at 25–30% (Field & Cattle; BeefMaps/Marion Acres run $1,000/$500/$250 ladders).
- Flat % auto-rescales the instant price changes = zero extra rancher work (the 5-year-old bar).
- Kills the live silent failure: empty Deposit → buyer charged 100% upfront (route.ts:191-195). Auto-derive means "empty" never happens.
- Multiplier ladder (not naive /2, /4): small shares carry ~10–20% per-lb premium (fixed processing spread over less meat). Naive division under-prices half/quarter (most of $1,200-AOV orders) + bleeds margin. Premium makes "whole = best cost-per-pound" literally true — the brand-legal freezer-economics story.
- Round-to-$50 → clean confident numbers (premium/matte brand; round beats charm for big considered buys).

### Refundability — KEEP VERBATIM
Fully refundable until rancher accepts the slot; non-refundable after. Already the live promise (deposit page ~L260-267) + the cleanest commitment device. Only fix: stop calling a full-price-upfront charge a "deposit" — auto-derive makes the word honest.

## Pricing UX (wizard Step 3 rebuild)
One primary input, system derives everything, full ladder shown as **editable** overrides.
1. **Unit toggle FIRST** — "$/whole cow" (default) vs "$/lb hanging." Kills the per-lb trap at the source (how DD Ranch entered 7.40/7.10/6.85).
2. **One field** — "$[__] / whole", persistent `$`+`/whole` affixes (not placeholders).
3. **Live inverse helper** — "≈ $X/lb · half ≈ $Y · quarter ≈ $Z · deposits $a/$b/$c". 7.40 as a total renders "≈ $0.02/lb" → mistake obvious.
4. **Derive via multiplier table** (0.55 / 0.28), deposits 25%.
5. **4 stacked guards** vs per-lb mistake: unit toggle + inverse helper + soft sanity warning ($3–$15/lb hanging band) + server plausibility floor (sub-$300 whole can't publish).
6. **Override path** — derived ladder rendered as pre-filled EDITABLE inputs, "auto" chip, per-field "reset to suggested"; hand-edit sticks.
7. **Confirmation echo** before save.
8. **Buyer display** — round numbers, Whole-first anchor (currently Quarter-first), "Reserve your share — $X today, applied to total" (never "deposit fee").

## Gaps found (severity)
| # | Area | Gap | Sev |
|---|---|---|---|
| 1 | pricing | Per-lb-vs-total trap fully open end-to-end; DD Ranch LIVE at $7.40 whole | **critical** |
| 2 | pricing | Deposit defaults to full price when empty → 100% upfront; 27/28 ranchers affected | **critical** |
| 3 | pricing | `Quarter/Half/Whole lbs` in MONEY_FIELDS → `parseFloat('~150 lbs')`=NaN → 400s whole Step-3 save (same class as the Step-8 bug) | **critical** |
| 4 | pricing | No derivation/auto-fill anywhere; 12–15 hand-typed fields | high |
| 5 | data | 19/28 missing ≥1 tier price; 9/12 tier_v2 have ZERO pricing; Silverline missing Whole | high |
| 6 | products | Gallery photos absent from wizard UI entirely; 25/28 have none; deposit page shows letter avatar only | high |
| 7 | products | Next Processing Date absent from wizard; 23/28 none; 3 dates already past; raw ISO on deposit page | high |
| 8 | checkout | Deposit-page copy says commission "off the top" but code ADDS 10% on top → buyer charged more than shown | high |
| 9 | checkout | tier_v2 can go live with Connect inactive → every deposit 409s; "all set" confetti overstates readiness | high |
| 10 | data | Pricing/deposit fields NOT auto-saved → close tab = lose it | medium |
| 11 | wizard | Header step numbers inconsistent (bar shows 5, machine has 10; headers mislabeled) | medium |
| 12 | wizard | Client allows decimals, server requires integer (Delivery Radius / Lead Time) | medium |
| 13 | wizard | Processing Fee label ambiguous | low |
| 14 | landing | Buyer tiers Quarter-first (anchoring says Whole-first lifts spend) | low |
| 15 | products | Whitelisted trust fields (facility, certs, socials, website) never collected | low |

## Implementation plan
- **Phase 0 — stop the bleeding (same-day, no UI):** remove `*lbs` from MONEY_FIELDS; server price plausibility floor (reject positive whole < $300 w/ clear msg); charge-time guard in deposit route; backfill DD Ranch + Silverline.
- **Phase 1 — derivation engine:** new `lib/pricing.ts` (roundTo50, deriveLadder, deriveDeposit, impliedPerLb, plausibilityCheck) + constants (DEPOSIT_PCT, DEPOSIT_MIN, HALF_MULT, QUARTER_MULT, MIN_WHOLE_PRICE) + unit tests. Shared by wizard + deposit route.
- **Phase 2 — one-input pricing UX:** rebuild wizard Step 3 (1496-1589) per UX above; auto-save the ladder.
- **Phase 3 — complete the listing:** photos step, processing-date input + formatting, trust/links, readiness checklist replacing confetti, louder Connect-skip.
- **Phase 4 — buyer-facing truth + psychology:** itemized charge breakdown on deposit page, fix "off the top" copy, "reserve" relabel, Whole-first cards, round display.
- **Phase 5 — polish:** step-number single source of truth, client/server validator parity, processing-fee clarity.

## Data migration
- **Pass A (manual, urgent — blocks transactions):** DD Ranch (per-lb mis-entry — needs Ben/rancher's intended whole price), Silverline (missing whole, back-derive ~$6,600 from half or confirm). Phase-0 charge floor blocks transactions meanwhile.
- **Pass B (scripted, idempotent):** for each tier with a plausible price (≥$300) + empty deposit, write `deriveDeposit(price)`. ~9–10 ranchers w/ real pricing. Dry-run → eyeball 27-row diff → commit under bhc-mutation-guardrails.
- Stale past processing dates (5 Bar, 2M, High Lonesome) need real new dates from ranchers.

## LOCKED decisions (Ben, 2026-06-20)
1. **Deposit % = 25%** of each tier price (DEPOSIT_PCT=0.25). ✅
2. **Floor $100, round-$50** (DEPOSIT_MIN=100, roundTo50). ✅ default
3. **Ladder = premium multipliers Half 0.55× / Quarter 0.28×** (Ben: "not up to me" → use research-backed premium; ranchers can override their own ladder). ✅
4. **Refundability unchanged** — fully refundable until rancher accepts. ✅
5. **Plausibility floor = $100/tier** (MIN_TIER_PRICE), soft whole warning < $300. ✅ default
6. **Photos = REAL FILE UPLOAD** → use **Vercel Blob** (Next-on-Vercel native, no extra account). ✅
7. **Go-live gate = WARN, not block** (Ben overrode the rec) — rancher can publish incomplete; we nudge. The Phase-0 charge-time floor + the deposit 409 still prevent transacting on broken/no pricing, so "warn" is safe. ✅
8. ⏳ **DD Ranch intended whole price** — still needed from Ben (per-lb mis-entry; floor blocks transactions meanwhile).
9. ⏳ **Silverline whole price** — still needed (Quarter $1,950 / Half $3,650 set; back-derive ≈ $6,600 or confirm).

## Status
- **Phase 0 (safety) + Phase 1 (engine) SHIPPED** on PR #87 (`442fd38`): `lib/pricing.ts` + `lbs`-out-of-MONEY_FIELDS + per-lb price floor (save + charge). Math verified via tsx.
- Phases 2–5 pending. Wizard-touching phases (2 pricing UX, 3 photos/date, 5 polish) are SEQUENTIAL (one 3,000-line file = serialization point — not a parallel blast). Phase 4 (buyer-facing) is independent.

Sources: fieldandcattle.com/blog/beef-share-pricing-guide · beefmaps.com/buy/quarter-cow · marionacres.com beef-half-deposit · learningloop.io commitment-devices · strategy-business.com round-numbers.
