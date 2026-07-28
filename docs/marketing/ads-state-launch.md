# Meta State-Launch Campaigns — 5 Ready Pages + TX Quiz Holding Pattern

**Status:** DRAFT — nothing here is live. Ben launches by hand in Meta Ads Manager.
**Written:** 2026-07-28. All stats verified against `GET /api/stats/public` and the
live rancher pages on this date. Re-pull share counts and prices the day ads go live —
they move.

**Money-model note (locked):** every price below is the rancher's price. The rancher
keeps 100% of it. BHC's 10% service fee is added for the buyer at checkout. Never
write "all-in" price claims in ad copy — say "from $X" and let the page and checkout
show the rest.

**Honesty rules in force:** real share counts only (they render live on each page),
no countdown timers, no "last chance," no invented processing dates. The refundable
deposit line is the risk-reversal, not manufactured urgency.

---

## Campaign structure

- **6 campaigns, one per state** (NE, WV, MO, OR, MT + TX quiz). One ad set each to
  start — geo + interest stack. 3 ads per ad set (the variants below).
- **Objective:** Traffic (Landing Page Views) for week 1 while the pixel gathers
  data → switch to Sales (InitiateCheckout, then Purchase) once
  `NEXT_PUBLIC_META_PIXEL_ID` is live and deposit Purchase events are flipped on
  (see `launch-runbook.md`).
- **Placements:** Advantage+ off to start; Facebook Feed + Instagram Feed + Stories
  only. No Audience Network.
- **Creative format:** single image or 15s vertical video of real ranch footage.
  No stock. Ben has said the real gap is food photography — whatever exists from
  each ranch beats a stock steak.

### UTM template (append to every destination URL)

```
?utm_source=meta&utm_medium=paid&utm_campaign=state-launch-{st}&utm_content={variant}
```

`{st}` = ne / wv / mo / or / mt / tx-quiz. `{variant}` = a1 / a2 / a3 per the ads
below. Matches the repo's existing `utm_source/utm_medium/utm_campaign/utm_content`
convention (`lib/email.ts`).

### Shared interest stack (tune per state, start broad-ish)

Grass-fed beef · Homesteading · Regenerative agriculture · Farm-to-table ·
Farmers' markets · Organic food · Hunting (meat-in-the-freezer overlap).
Age 28–65. All genders. Exclude nothing else — the state geo is the real filter.

---

## NE — Champion Valley Farm

- **Destination:** `https://www.buyhalfcow.com/ranchers/champion-valley-farm` + UTM (`{st}=ne`)
- **Geo:** Nebraska statewide, **plus Colorado and Kansas** — the page states
  "Ships to NE, CO, KS." CO alone has 85 waiting buyers (live count 2026-07-28)
  and no CO page; this is the only ad-ready ranch that legitimately serves them.
  Run NE and CO as separate ad sets so spend is readable.
- **Page truth (2026-07-28):** Whole $5,010 · Half $2,535 · Quarter $1,290, prices
  include processing. 47 shares left this round. 2 deals closed on BHC. 5.0 from
  1 verified review. Grass-fed AND grass-finished heritage breeds (Murray Grey,
  American Aberdeen), never grain, no hormones or antibiotics, regenerative
  rotational grazing. Run by Matt & Kelsey.
- **Honest urgency:** "47 shares left this round" is the live page counter. Use it.

**Ad 1 (a1 — heritage breed angle)**
- Primary: `A Nebraska family raises heritage cattle on grass alone. Quarters from $1,290, processing included. 47 shares this round.` *(125 chars)*
  - Continuation: `Murray Grey and American Aberdeen — smaller heritage breeds, cuts sized for real dinner plates. Never grain, no hormones. Your deposit is fully refundable until Matt & Kelsey accept your slot.`
- Headline: `Nebraska beef, quarters from $1,290` *(35)*
- Description: `Refundable deposit holds it.` *(28)*

**Ad 2 (a2 — the review angle)**
- Primary: `"Freezer is full again!" — a verified Nebraska buyer. Grass fed, grass finished, from $1,290 a quarter.` *(103 chars)*
  - Continuation: `Matt & Kelsey met their last buyer halfway — she drove 3 hours. That is what buying from a real family looks like. Prices include processing.`
- Headline: `Grass fed. Grass finished. Nebraska.` *(36)*
- Description: `47 shares left this round.` *(26)*

**Ad 3 (a3 — plain math angle)**
- Primary: `Half a cow, $2,535, processing included. Raised on Nebraska grass by a family you can text. Ships to NE, CO, KS.` *(112 chars)*
- Headline: `Reserve your share` *(18 — CTA library verbatim)*
- Description: `Prices include processing.` *(26)*

---

## WV — Renick Valley Meats

- **Destination:** `https://www.buyhalfcow.com/ranchers/renick-valley-meats` + UTM (`{st}=wv`)
- **Geo:** West Virginia statewide, **plus Virginia** — page states drop points in
  WV and VA, "adding more drop locations as interest grows." Separate ad sets.
- **Page truth (2026-07-28):** Whole $5,600 (~410 lbs) · Half $2,900 (~200 lbs) ·
  Quarter $1,500 (~100 lbs), prices include processing. 45 shares left. Jesse
  Gajewski runs a state-inspected processing facility and sources exclusively from
  small family farms he has personally vetted — "we've seen thousands of beef
  carcasses and we know exactly which farmers consistently raise the best beef."
- **Honest urgency:** 45 shares left (live counter). No processing date shown on
  page — do not invent one.

**Ad 1 (a1 — the butcher-knows angle. Sharpest creative on this whole sheet.)**
- Primary: `Jesse has processed thousands of beef carcasses. He knows exactly which WV farms raise the best. That's whose beef he sells.` *(124 chars)*
  - Continuation: `Renick Valley Meats: a family-run, state-inspected processor sourcing only from small family farms. Quarters from $1,500, processing included, drop points across WV and VA.`
- Headline: `Picked by the butcher himself` *(29)*
- Description: `Drop points across WV & VA.` *(27)*

**Ad 2 (a2 — plain offer)**
- Primary: `Real West Virginia beef, cut and vacuum sealed to your spec. Quarters from $1,500, halves $2,900. Processing included.` *(118 chars)*
- Headline: `WV beef, quarters from $1,500` *(29)*
- Description: `Refundable deposit holds it.` *(28)*

**Ad 3 (a3 — tagline angle)**
- Primary: `"Best Meat in the Virginias." Jesse's words, and he's the one who cuts it. A deposit holds your share; refundable until he accepts.` *(130 — lead sentence is 29 chars, safe truncation)*
- Headline: `Best Meat in the Virginias` *(26)*
- Description: `45 shares left this round.` *(26)*

---

## MO — Silverline Cattle Co

- **Destination:** `https://www.buyhalfcow.com/ranchers/silverline-cattle-co-mo` + UTM (`{st}=mo`)
- **Geo:** Missouri statewide. (Page shows no ship-to list — keep it in-state until
  Katie confirms range.)
- **Page truth (2026-07-28):** Whole $6,800 · Half $3,650 · Quarter $1,950, prices
  include processing. 42 shares left. 2 deals closed on BHC. Third-generation
  family ranch in southwest Missouri, running since 1981. Grass-fed, grain-finished.
  USDA inspected at Clouds Meats. Run by Katie.
- **CAUTION:** the page currently shows "Next processing July 6, 2026" — that date
  is in the past. Do NOT use a processing date in MO ads until the page is updated.
  Flag to Ben.

**Ad 1 (a1 — three generations angle)**
- Primary: `Three generations on the same Missouri ground since 1981. Grass fed, grain finished, USDA inspected. Quarters from $1,950.` *(122 chars)*
- Headline: `Third generation Missouri beef` *(30)*
- Description: `Prices include processing.` *(26)*

**Ad 2 (a2 — marbling angle)**
- Primary: `Grass fed for health, grain finished for marbling. That's the balance Silverline has run since 1981. From $1,950 a quarter.` *(123 chars)*
- Headline: `Missouri quarters from $1,950` *(29)*
- Description: `Refundable deposit holds it.` *(28)*

**Ad 3 (a3 — trust chain angle)**
- Primary: `Know your rancher. Katie's family has raised Missouri beef for three generations. USDA inspected, priced with processing in.` *(124 chars)*
- Headline: `Reserve your share` *(18 — CTA library verbatim)*
- Description: `42 shares left this round.` *(26)*

---

## OR — DD Ranch

- **Destination:** `https://www.buyhalfcow.com/ranchers/dd-ranch-or` + UTM (`{st}=or`)
- **Geo:** Oregon statewide, weighted to Portland, Salem, Eugene metros — Linda
  delivers to those drop areas about once a month (delivery charges apply); local
  buyers pick up at the butcher.
- **Page truth (2026-07-28):** Whole $2,740 (~600 lbs) · Half $1,420 (~300 lbs) ·
  Quarter $740 (~150 lbs) — hanging weight, prices include processing. 45 shares
  left. 1 deal closed on BHC. Grass fed and finished, no chemical sprays on
  pastures or hay. Also raises hog and lamb. Run by Linda in Terrebonne.
- **Angle note:** DD is the lowest-priced entry point of all five pages. The $740
  quarter is the headline number. Weights are hanging weight — mirror the page's
  numbers exactly, never convert to take-home claims.

**Ad 1 (a1 — the entry price angle)**
- Primary: `A quarter beef from a Terrebonne family ranch: $740, processing included. Grass fed and finished, no chemical sprays. Ever.` *(123 chars)*
- Headline: `Oregon beef, quarters from $740` *(31)*
- Description: `Refundable deposit holds it.` *(28)*

**Ad 2 (a2 — the delivery angle)**
- Primary: `Linda delivers to Portland, Salem, and Eugene about once a month. Reserve a share, she confirms cut sheet and timing with you.` *(125 chars)*
- Headline: `Ranch beef, delivered monthly` *(29)*
- Description: `Salem · Eugene · Portland.` *(26)*

**Ad 3 (a3 — clean pasture angle)**
- Primary: `No chemical sprays on the pastures. No shortcuts on the hay. Grass fed and finished in Terrebonne, from $740 a quarter.` *(119 chars)*
- Headline: `Reserve your share` *(18 — CTA library verbatim)*
- Description: `45 shares left this round.` *(26)*

---

## MT — Foodstead

- **Destination:** `https://www.buyhalfcow.com/ranchers/foodstead` + UTM (`{st}=mt`)
- **Geo:** Montana statewide, **plus Idaho and Washington** — page hero states
  "Ships to MT, ID, WA." Separate ad sets per state.
- **Page truth (2026-07-28):** Whole $6,500 · Half $3,299 · Quarter $1,650, prices
  include processing. **19 shares left** (lowest of the five — real). **6 deals
  closed on BHC** (most of the five). **Next processing August 1, 2026** — a real,
  page-stated date, 4 days out at time of writing. 100% grass-fed and
  grass-finished, regenerative (rotational grazing, cover crops, bale grazing),
  never confined, no hormones or antibiotics. Run by Beckie.
- **Honest urgency:** this is the one page where date urgency is TRUE. Use the
  Aug 1 processing date while it holds, then re-verify — pull the page before
  launch and swap in whatever date it shows. If no date shows, drop the date ads.
- **Priority:** highest-proof page (6 closes, real date, real low share count).
  Recommend MT gets the first dollar — see `launch-runbook.md`.

**Ad 1 (a1 — the real-date angle)**
- Primary: `Foodstead processes August 1. 19 shares left this round. 100% grass fed and finished on regenerative Montana pasture.` *(117 chars)*
  - Continuation: `Reserve with a deposit — fully refundable until Beckie accepts your slot. Ships to MT, ID, WA.`
- Headline: `Processing Aug 1. 19 shares left.` *(33)*
- Description: `Refundable deposit holds it.` *(28)*

**Ad 2 (a2 — the proof angle)**
- Primary: `6 families have bought Foodstead beef through BuyHalfCow. Quarters from $1,650, processing included, shipped MT, ID, WA.` *(120 chars)*
- Headline: `Montana quarters from $1,650` *(28)*
- Description: `6 deals closed on BHC.` *(22)*

**Ad 3 (a3 — the soil angle)**
- Primary: `Better soil grows better forage. Better forage raises better beef. That's the whole Foodstead model, on Montana pasture.` *(120 chars)*
- Headline: `Regenerative Montana beef` *(25)*
- Description: `19 shares left this round.` *(26)*

---

## TX — Quiz Holding Pattern (until Lazy Bar 3 is ad-ready)

- **Destination:** `https://www.buyhalfcow.com/access` + UTM (`{st}=tx-quiz`)
- **Why quiz, not page:** no TX rancher page is ad-ready — Lazy Bar 3 has no prices
  set. TX has the deepest waiting pool of any state (266 waiting buyers, live count
  2026-07-28), so we bank demand at /access until supply is ready.
- **Geo:** Texas statewide; optionally weight Houston + Austin metros (Thomas is
  the exclusive Houston/Austin supplier once routable — see the Thomas ZIP-gate
  notes; do NOT promise routing there in ad copy).
- **Budget:** keep this a trickle. Quiz signups here wait for supply — spending
  hard against a waitlist buys impatience.
- **SWITCH CONDITION (write it down, check it weekly):** when Lazy Bar 3's page has
  prices set, the reserve CTA live, and the page renders — the same three checks
  the five pages above passed — retire this campaign and clone the state template:
  destination `/ranchers/<lazy-bar-3-slug>` + UTM `{st}=tx`, ads rewritten from the
  page's real prices, share count, and story. TX inherits the biggest waiting pool
  and should immediately out-rank the other five for budget.

**Ad 1 (a1 — the honest waitlist angle)**
- Primary: `2,587 families are in the network. Texas is our deepest waitlist. Take the 90-second quiz and get in line for a TX ranch.` *(121 chars)*
- Headline: `Get Access to the Network` *(25 — CTA library verbatim)*
- Description: `90 seconds. No spam.` *(20)*

**Ad 2 (a2 — the direct-beef education angle)**
- Primary: `Buying beef direct from a Texas ranch is how families filled freezers for generations. We're bringing it back. Start here.` *(121 chars)*
- Headline: `Take the 90-second quiz` *(23 — CTA library verbatim)*
- Description: `Join 2,587 families.` *(20)*

**Ad 3 (a3 — the anti-mystery-meat angle)**
- Primary: `You know your mechanic and your dentist. You should know your rancher. Take the quiz — we match Texas families to real ranches.` *(126 — lead sentence 44 chars, safe truncation)*
- Headline: `Know your rancher` *(17)*
- Description: `Real ranches. Real cuts.` *(24)*

---

## Copy fences (checked before commit)

- No "deduct" / "keep 90" / "we take" anywhere. Rancher keeps 100%; the 10% is a
  buyer-side service fee at checkout.
- No NO-words (seamless, curate, journey, disrupt, etc. — `docs/BHC.md`).
- Every number above verified on-page or via the stats API on 2026-07-28.
  **Re-verify share counts, prices, and the Foodstead processing date on launch day.**
- No buyer names. The one review quote is anonymous and verbatim from the public page.
