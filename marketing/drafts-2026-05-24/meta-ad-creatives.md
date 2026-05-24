# meta-ad-creatives

**Channel:** Meta Ads (Facebook + Instagram feed + Reels)
**Conversion event:** `/access` quiz submit
**Goal:** route cold buyers into the network
**Voice:** founder-led, lowercase, plain. No hype.

5 variants, 5 audiences. Run as separate ad sets, 1 creative per audience for clean attribution.

---

## VARIANT 1 — regen-ag follower lookalike

**Headline (≤40):** know your rancher. eat real beef.

*Char count: 35*

**Primary text (≤125):** 7 verified ranches across 5 states. quarter, half, whole. direct from the family that raised the cattle. take the 90-second quiz.

*Char count: 142* — TRIM: `7 verified ranches, 5 states. quarter, half, or whole — direct from the family that raised the cattle. 90-sec quiz.`

*Trimmed char count: 117*

**Description (≤30):** real beef, no middleman.

*Char count: 24*

**CTA button:** Sign Up

**Visual direction:** slow pan over pasture at golden hour, single black angus crossing frame, text overlay appears at the 2-second mark.

---

## VARIANT 2 — grass-fed grocery shopper

**Headline (≤40):** the grass-fed aisle is lying to you.

*Char count: 36*

**Primary text (≤125):** most "grass-fed" grocery beef is finished on grain in a feedlot. ours isn't. meet the rancher. see the pasture. 90-sec quiz.

*Char count: 124*

**Description (≤30):** verified ranches. real cuts.

*Char count: 27*

**CTA button:** Learn More

**Visual direction:** split-screen — grocery cooler beef left, open pasture with cattle right, cream serif headline center divider.

---

## VARIANT 3 — freezer-owner 80k+ HHI

**Headline (≤40):** fill your freezer for the year.

*Char count: 31*

**Primary text (≤125):** quarter, half, or whole beef direct from a ranch in your state. one delivery, one freezer, real cuts. take the 90-second quiz.

*Char count: 124*

**Description (≤30):** one buy. twelve months of beef.

*Char count: 30*

**CTA button:** Get Offer

**Visual direction:** overhead shot of a chest freezer being stocked with butcher-paper-wrapped cuts, hands of family member loading it. natural light.

---

## VARIANT 4 — ranch family

**Headline (≤40):** the way you grew up eating.

*Char count: 27*

**Primary text (≤125):** beef raised on pasture by a real family, processed at a real USDA plant, picked up or shipped to your door. no middleman.

*Char count: 122*

**Description (≤30):** family to family. no broker.

*Char count: 26*

**CTA button:** Learn More

**Visual direction:** three-generation ranch family at a wooden kitchen table, plated beef in the foreground, no faces in focus.

---

## VARIANT 5 — homesteader

**Headline (≤40):** raise a garden. buy the beef.

*Char count: 30*

**Primary text (≤125):** you grow the vegetables. let the rancher down the road raise the cattle. quarter, half, whole — direct, verified, in-state.

*Char count: 124*

**Description (≤30):** direct from the ranch.

*Char count: 22*

**CTA button:** Sign Up

**Visual direction:** still life — garden harvest basket on one side of a wooden table, butcher-paper-wrapped beef cuts on the other, single window light.

---

## NOTES FOR ADS MANAGER

- All 5 variants share landing page: `https://www.buyhalfcow.com/access`
- Conversion event: `Lead` (quiz submit POST to `/api/consumers`)
- UTM tagging: `utm_source=meta&utm_medium=cpc&utm_campaign=launch-2026-05&utm_content=variant-{1-5}`
- Start with $25/day per ad set for 5 days, then concentrate budget on the variant with cheapest CPL.
- Pause any variant above $25 CPL after 100 impressions.
