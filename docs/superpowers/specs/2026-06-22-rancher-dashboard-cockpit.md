# Rancher Dashboard → Business Cockpit (2026-06-22)

Source: 5-agent research (current-dashboard audit + competitive seller dashboards [Barn2Door/GrazeCart/Local Line/Shopify/Square/Stripe Express] + rancher day-to-day needs + BHC data/capability map). Goal: make the rancher dashboard each rancher's intuitive business hub — simple, non-breaking, scalable to 150 ranchers in 90 days. Constraint: DON'T overbuild.

## Verdict
**Not a rebuild — a re-organization + re-voicing.** The current dashboard (`app/rancher/page.tsx`, ~4,502 lines, 6 peer tabs) has the data to be a cockpit; it fails on hierarchy, navigation, and tone. A rancher logs in to a wall of 5 alarm banners + 6 tabs and does NOT instantly know what to do. The proven bones (onboarding, one-input pricing, matched-buyer deposit, Collect Balance) are solid + live — just buried.

## Ben's 3 questions, answered
- **Other products (jerky/boxes):** PARTIAL. The live "Additional Products" editor captures name/price/link but renders as a *static brochure* — not purchasable. The truly-sellable catalog is build-dark (parked behind Supabase). → For the push: keep ONE honest "Other products (shown on your page)" brochure list; unlock real selling later.
- **Add images to their page:** YES — gallery + logo upload work + save — but buried halfway down a 590-line form with no preview/cover-pick. → Fix = surface + live preview, not new plumbing.
- **Intuitive:** NO, not yet — no home, no nav spine, alarms-first, dev jargon, three pricing editors. But CHEAP to fix because the data's already there.

## The right dashboard (simple, phone-first, plain ranch language)
**HOME (new default — replaces Overview + the banner wall):** answers "what needs me / my money / how I'm doing."
1. **Action cards** — tap-to-act stack, shown only when there's something to do: "Jane S. paid her deposit — collect the rest ($312) →", "2 new buyers — say hi →", "1 unread message →", "Finish setup: add a photo (3/5) →". No cards = "You're all caught up." (Absorbs today's alarm banners.)
2. **Money strip** — "You've been paid $X · Next payout [date]" (Stripe login link) + "$Y deposits collected · $Z still to collect" + "Sales this month: $___".
3. **Vitals** — accepting-deposits toggle / spots left, recent buyers, "View my page →".

**TOP NAV (one persistent bar, 5 items, the spine it lacks today):**
`Home · Deals · My Page · Messages · Money`
- **Deals** (rename "My Buyers"): the matched-buyer pipeline + closed deals + mark-delivered. The single customers/sales home.
- **My Page**: ONE storefront editor w/ live preview. Photos+story at TOP → the one-input cow-share price ladder (the ONLY pricing editor) → "Other products" brochure → availability.
- **Messages**: the (currently orphaned) inbox + unread badge.
- **Money**: thin wrapper — Stripe payouts via login link + BHC's deposit/commission/tier context. Stripe owns the heavy lifting.

**Onboarding spine:** a Shopify-style "X of Y steps" checklist as the top action card until done — the mechanism to onboard 150 without 150 calls.

## MVP for the 150-push (mostly surfacing existing data — cheap + safe)
1. **Home triage screen** — action cards + "all caught up" empty state. Inputs already computed in `dashboard/route.ts` + `inbox/route.ts` — composition, not new data.
2. **5-item top nav spine** — de-orphan inbox + billing. Pure routing/IA.
3. **Stripe payouts for free** — `stripe.accounts.createLoginLink` + "You've been paid $X / Next payout [date]" + "View my payouts" button. Ranchers already have `dashboard:'full'`. ~½ day; the single biggest free-data gap.
4. **Collapse 3 pricing editors → 1** — keep the one-input ladder; HIDE the parked CommerceCatalogEditor/Orders (not "rolling out" placeholders) until Supabase lands; relabel "Additional Products" as an honest brochure + drop its payment-link field.
5. **Photos to the top of My Page + live preview** — existing ImageUploader, just surfaced.
6. **Re-voice + de-popup** — plain language ("Collect the rest of the money", "Sold out", "You got paid"); replace the 3 `window.prompt/confirm` with branded modals; remove legacy Payment-Link fields for Connected ranchers + the hardcoded Cal Gmail.
7. **Two zero-cost wins** — render `stats.leadQuality` (close rate, computed but never shown) + the inbox unread badge on Home.

## Lean on Stripe (don't rebuild)
Ranchers are connected accounts with `dashboard:'full'` → they already have a free, compliant money dashboard. LET STRIPE handle balance / payouts / next-payout / bank / history. BUILD IN BHC only the deal-context money (deposit collected / balance to collect / commission / tier). Rule: account-level money → Stripe; specific-deal or platform money → BHC. The one must-fix: never make a rancher "go check Stripe" to learn IF they got paid — surface that one fact in-app, deep-link for detail.

## Consolidations (reduce what can break — Ben's constraint)
- 3 stacked product/pricing editors → 1 (+ hide parked commerce). A Half price enterable in two non-reconciling places today.
- "Additional Products" relabeled honest brochure (not a fake store).
- Photos surfaced to top w/ preview.
- Messages + Money onto the nav (inbox fully orphaned, billing hidden behind an upsell).
- Remove legacy Payment-Link fields for Connected ranchers (public page silently ignores them anyway).
- Plain language; kill `window.prompt/confirm`; one shared referral-card component (two near-duplicates today); remove hardcoded Cal Gmail.

## Explicitly OUT (competitor churn-drivers for non-technical ranchers)
Self-serve cart/storefront checkout (parked), analytics dashboards, discounts/coupons, CSA/subscriptions, delivery routing, wholesale, custom domains, bulk import, tax exports. Refuse for the push.
