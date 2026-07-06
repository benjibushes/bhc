# BHC Customer-Journey + UI/UX Overhaul — Fable-5 Execution Plan

> **For the executing agent (Fable 5):** You are implementing this plan task-by-task in the BHC repo. You have ZERO context from the conversation that produced this plan — everything you need is in this file. Read this whole file first, then execute phases **in order**. Steps use checkbox (`- [ ]`) syntax. Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` if available; otherwise execute inline.

**Goal:** Fix BHC's lacking conversion rate by hand-holding every visitor from a content click to the *right* offer tier (whole/half **share** · low-ticket **shop** · affiliate **gear**), and unify the whole journey onto ONE design system so it feels like one seamless company.

**Architecture:** Two workstreams. (A) **Journey** — add a tri-tier self-segmentation *fork* on the homepage + a low-ticket escape inside the share quiz, so lower-ticket/freezer-less traffic stops hitting a $1k+ wall and bouncing. (B) **Design** — the site is ~90% on one Tailwind-v4 brand system; the new low-ticket shop rail opted out into inline styles + invented colors. Migrate it back. No new design language — enforce the one that exists.

**Tech stack:** Next.js 16 App Router · Tailwind v4 (tokens in `app/globals.css` via `@theme inline`, NO tailwind.config.js) · Playfair Display + Inter (next/font, `app/layout.tsx`) · shared primitives in `app/components` (`Button`, `Card`, `Container`, `Divider`) · Stripe Connect (money path — DO NOT TOUCH, see guardrails) · Airtable system-of-record · tests via `tsx --test`.

---

## THE VERDICT (why this plan exists — do not re-litigate)

The conversion problem is **architectural, not cosmetic**. Today:
- `app/components/FullHomepage.tsx` routes **100% of traffic** to one CTA — "Get matched in 90 seconds" → `/access` (the share quiz) — and `StickyMobileCTA` repeats it.
- The quiz's **first question** (`lib/funnelConfig.ts` `SIZE_OPTIONS`) forces "how much beef are you after?" priced **$1,000–5,000** with only a passive "not sure yet" escape — a $1k+ wall in the first mobile viewport, before any trust is built.
- `/shop` ($13 jerky, $95–749 boxes) and `/gear` (affiliate) are **orphaned** — the homepage never links to them.

**Biggest lever:** a tri-tier self-segmentation **fork** on the homepage (share / shop / gear). It instantly unblocks the two orphaned revenue surfaces, lets the visitor declare intent in one tap, and converts the $1k balk into a $13–95 sale instead of a bounce — **without cannibalizing the share** (box stays a rung UP, share stays visually primary). Everything else is downstream of that.

Research backing (do not need to re-verify): self-segmentation lifts conversion + cuts bounce; quizzes convert 2–3× baseline ONLY when every screen earns its place (CrazyBulk +141%, Andie Swim +296%); in food, trust-led + operational risk-reversal beats discounts by 30–40% margin; Hick's Law / single-CTA discipline (jam study: 6 vs 24 options = 10× purchase; Whirlpool single-CTA +42%).

---

## GLOBAL RULES (apply to EVERY task)

1. **PR flow, one PR per phase.** `main` is protected — direct push is blocked. For each phase: `git checkout -B feat/journey-<phase> origin/main`, commit as you go, push, open a PR, and **STOP for Ben to review/merge** before starting the next phase. Never stack a phase branch on an unmerged phase branch (squash-merge no-op trap).
2. **Verify gate — ALL must be green before committing a task that touches a route/page/lib:**
   - `npx tsc --noEmit` → 0 errors
   - `npm test` → all pass (currently **941** passing; must not drop). Tests run via the quoted-glob script; if `npm test` runs suspiciously few tests, run `npx tsx --test "test/**/*.test.ts"` (or the repo's test dir) directly.
   - `npm run boundaries:check` → 0 violations
   - **`rm -rf .next && npm run build`** → succeeds. This is MANDATORY for any route/page/component change — a real `next build` catches route↔page collisions and RSC errors that `tsc` misses. (Do not rely on tsc alone.)
3. **NEVER touch the money path.** Off-limits: `lib/productCheckout.ts`, `lib/productSettlement.ts`, `lib/buyerDeposit*`, `app/api/webhooks/**`, `app/api/checkout/**` logic, `app/api/qualify/route.ts` **scoring logic**, and the Stripe embed wiring inside `app/shop/checkout/[id]/CheckoutMount.tsx` (`loadStripe` / `EmbeddedCheckoutProvider` / `fetchClientSecret`). You may restyle the *wrappers/summary* around these, but do not change any charge, settlement, `application_fee`, `metadata.type`, or client-secret logic. When in doubt, restyle only the presentational shell.
4. **Funnel value-string contract.** In `lib/funnelConfig.ts`, the `value` fields of `SIZE_OPTIONS`, `TIMING_OPTIONS`, `STORAGE_OPTIONS` MUST keep matching `VALID_TIERS` / `VALID_STORAGE` / timing cases in `app/api/qualify/route.ts`. Changing display `label`/`detail`/`icon` is safe; changing `value` breaks scoring. Adding a NEW question requires checking the scorer first (Task 2.3).
5. **Brand voice (non-negotiable — read `docs/BHC.md` if present).** lowercase headlines, honest, **NO fake scarcity** (no countdown timers, no "only N left", no "selling fast" unless literally true), `— Ben` sign-off on conversion surfaces, no NO-words (synergy/seamless/curate/journey/disrupt/ecosystem/holistic/best-in-class/powered-by). Do **not** sell on "saving money" (D2C beef is often more per lb — sell quality + freezer economics). **Never cannibalize the share:** box/jerky is a rung UP; on every low-ticket surface the share-anchor stays present but visually DE-EMPHASIZED (secondary Button).
6. **Design guardrails — avoid AI-generic slop.** No purple/blue SaaS gradients, no glassmorphism, no neon, **no drop-shadow floating cards** (globals.css mandates value-shift surfaces — "Western paper, not Material"). Playfair serif on ALL headings (never let a migrated page fall back to Inter for an `<h1>`). `amber #E8C547` is for map pins ONLY — never a commerce accent.

---

## THE DESIGN SYSTEM (the single source of truth — memorize this)

Tokens live in `app/globals.css` under `@theme inline`. **Use semantic class names, never hex literals.**

| Token (class) | Hex | Use |
|---|---|---|
| `charcoal` (`text-charcoal`, `bg-charcoal`) | `#0E0E0E` | body text, primary CTA bg |
| `bone` (`bg-bone`) | `#F4F1EC` | page background |
| `bone-warm` (`bg-bone-warm`) | `#ECE8E0` | card/surface tint |
| `bone-deep` (`bg-bone-deep`) | `#E5E2DC` | image placeholder / deeper surface |
| `saddle` (`text-saddle`) | `#6B4F3F` | secondary text, links, sub-copy |
| `dust` (`border-dust`) | `#A7A29A` | borders, hairlines |
| `sage` (`text-sage`, `border-sage`) | `#4F7A3F` | verified / "ships free" / positive |
| `weathered` | `#8C2F2F` | errors ONLY |
| `rust` | `#D97757` | rare warm accent |
| `amber` | `#E8C547` | map pins ONLY (never commerce) |

**Type:** Playfair Display = all `h1`–`h6` (auto via globals.css). Inter = body/UI. Hero clamp ~60px → 18px body (line-height 1.7) → 14px caption. **Spacing:** `<Container>` = `max-w-[1100px] px-6`; section rhythm `py-16`/`py-20`; near-zero radius (square-ish cards are correct — do not add `rounded-lg`). **Motion:** `.transition-base` hover-lift, `ease-out cubic-bezier(0.22,1,0.36,1)`, 150/250/400ms, `prefers-reduced-motion` already handled globally.

**Reference implementations to diff against** (these are already correct — copy their patterns): `app/gear/page.tsx` (the browse-surface template `/shop` should match), `app/checkout/[refId]/deposit/page.tsx` + the deposit success page (the checkout template the low-ticket checkout should match).

**Component APIs** (already built — reuse, do not reinvent):
- `<Button href? variant='primary'|'secondary'|'ghost'|'destructive' size='sm'|'md'|'lg' fullWidth? loading? external? onClick? type>` — primary = solid charcoal/bone.
- `<Card variant='default'|'warm'|'inverted'|'outline' padding='none'|'sm'|'md'|'lg' href? as='div'|'article'|'section'>` — elevation via border + tint, hover-lift when `href`.
- `<Container className?>` — the max-width wrapper.
- `<Divider />`.

---

## LOCKED DECISIONS (defaults already chosen — Ben can override via a note to you; otherwise build these)

1. **Fork order + copy:** left→right = **share (primary, largest)** · **shop** · **gear (lightest third rung)**. Copy in Task 1.2.
2. **Low-ticket escape:** appears on the **size step** + the **funnel reveal for non-deposit matches** only — NOT a persistent every-screen link (protect the share).
3. **Funnel first question:** lead with **state** (doubles as a routing signal) — but ONLY if it isn't already captured (Task 2.3 gates this).
4. **Share-anchor on `/shop`:** stays the LAST section, de-emphasized (secondary Button). Keep current behavior.
5. **Emoji category labels:** keep on `/gear` only; `/shop` stays emoji-free (premium/owned).
6. **`app/admin/products`:** migrate it in Phase 3 for consistency (internal, low cost).

**Ben-supplied (NOT your tasks — leave hooks, don't block):**
- **Photography.** You wire the *frame* (aspect ratios, `ProductImage` fallbacks, warm-tone classes); Ben drops in real ranch/family/cut photos later. Do not generate or source stock photos.
- **Vercel deploy auth** (if preview tooling is needed) — Ben handles; you verify via local `next build`.

---

# PHASE 1 — Homepage tri-tier FORK (ship FIRST, own PR)

**Why first:** highest leverage, smallest surface. Unblocks the two orphaned revenue surfaces and stops routing 100% of cold/low-ticket/freezer-less traffic into a $1k+ wall.

**Branch:** `git checkout -B feat/journey-fork origin/main`

### Task 1.1 — Read the current hero and confirm the anchor points

**Files:** `app/components/FullHomepage.tsx`, `app/components/StickyMobileCTA.tsx`

- [ ] Read `FullHomepage.tsx`. Confirm: the hero section (~`:24-67`), then the **BUYER-PRIMARY CTA** `<section className="py-20">` (~`:78-116`) containing an `<h2>` "source beef directly from a real ranch", a two-`<Button>` row (`/access` primary + `/ranchers` secondary), a "Not sure yet? Start here → /start" line, and a partner-links line.
- [ ] **Read the comment at `:71-77` carefully.** It explains a *previous* 4-card grid was killed. **That grid mixed AUDIENCES (buyer / rancher / land / brand).** The fork you are building is DIFFERENT: it is **all-buyer, intent-based** (three ways to buy beef), **share-anchored**. This does not resurrect the killed pattern — do not let the comment stop you. You will update that comment to reflect the new intent fork.
- [ ] Read `StickyMobileCTA.tsx` to see what CTA it renders (it currently mirrors "Get matched").

### Task 1.2 — Replace the two-button CTA row with the tri-tier fork

**File:** `app/components/FullHomepage.tsx` (the `<section className="py-20">` block, ~`:78-116`)

- [ ] Replace the `<div className="flex flex-col sm:flex-row gap-3 justify-center">` two-button row with the three-card fork below. Keep the `<h2>` and lead `<p>` above it (they still work as the section intro). Keep the partner-links line (`Raise cattle?… Partner with us`) below. Move the "Browse the ranchers" (`/ranchers`) link to a quiet text link **under the share card** (it's part of the share/discovery path, not a peer tier).

Use this exact structure (adapt class spacing to match the file's rhythm; all colors via tokens):

```tsx
{/* TRI-TIER INTENT FORK — three ways to buy beef, share-anchored.
    NOT the old audience grid (buyer/rancher/land/brand) that was killed
    above — these are all BUYER paths, self-sorted by intent. The share is
    visually PRIMARY (largest, solid Button); shop + gear are rungs, never
    peers, so we never cannibalize the share. */}
<div className="grid grid-cols-1 md:grid-cols-12 gap-4 mt-10 text-left">
  {/* SHARE — primary, widest */}
  <Card href="/access" as="article" padding="lg" variant="warm" className="md:col-span-6 flex flex-col">
    <p className="text-xs uppercase tracking-widest text-saddle mb-2">stock the freezer</p>
    <h3 className="font-serif text-2xl mb-2 lowercase">a half or whole share</h3>
    <p className="text-saddle text-sm mb-6 flex-1">
      a year of beef, direct from a verified ranch near you. take the 90-second quiz and we match you.
    </p>
    <span className="inline-flex"><Button href="/access" size="md">take the quiz →</Button></span>
    <p className="text-xs text-saddle mt-3">
      or <a href="/ranchers" className="underline hover:text-charcoal transition-colors">browse the ranchers</a>
    </p>
  </Card>

  {/* SHOP — secondary rung */}
  <Card href="/shop" as="article" padding="lg" variant="default" className="md:col-span-3 flex flex-col">
    <p className="text-xs uppercase tracking-widest text-saddle mb-2">try it first</p>
    <h3 className="font-serif text-xl mb-2 lowercase">jerky &amp; boxes, shipped</h3>
    <p className="text-saddle text-sm mb-6 flex-1">
      smaller, shipped nationwide. no freezer needed.
    </p>
    <span className="inline-flex"><Button href="/shop" variant="secondary" size="sm">shop beef →</Button></span>
  </Card>

  {/* GEAR — lightest third rung */}
  <Card href="/gear" as="article" padding="lg" variant="default" className="md:col-span-3 flex flex-col">
    <p className="text-xs uppercase tracking-widest text-saddle mb-2">gear up</p>
    <h3 className="font-serif text-xl mb-2 lowercase">the tools ben uses</h3>
    <p className="text-saddle text-sm mb-6 flex-1">
      freezers, grills, knives — the gear behind the beef.
    </p>
    <span className="inline-flex"><Button href="/gear" variant="ghost" size="sm">see the gear →</Button></span>
  </Card>
</div>
```

- [ ] Delete the now-redundant "Not sure yet? Start here → /start" line (the fork replaces it) OR keep `/start` only if it still resolves to a real page — check first; if `/start` 404s or is stale, remove the link.
- [ ] Update the `:71-77` comment to describe the new intent fork (one honest paragraph; do not leave a comment that contradicts the code).

### Task 1.3 — Keep the StickyMobileCTA share-focused (do not triple it)

**File:** `app/components/StickyMobileCTA.tsx`

- [ ] The sticky mobile bar should stay a SINGLE primary action = "take the quiz" → `/access` (the share is the anchor; a 3-way sticky bar would reintroduce choice paralysis on mobile). Leave it pointing at `/access`. No change unless it points somewhere stale.

### Task 1.4 — Verify + commit Phase 1

- [ ] Run the full verify gate (tsc + `npm test` + boundaries + `rm -rf .next && npm run build`). All green.
- [ ] Manually confirm the fork renders and the three cards link to `/access`, `/shop`, `/gear`.
- [ ] Commit: `feat(home): tri-tier intent fork (share/shop/gear) — unorphan /shop + /gear`. Push, open PR, **STOP for Ben to merge.**

**Acceptance:** Homepage above-the-fold offers three buyer paths; share is visually dominant; `/shop` and `/gear` are now reachable from the homepage; build + tests green.

---

# PHASE 2 — Funnel escape + freezer-objection help (own PR)

**Why:** captures the demand the fork now sends into the quiz. Converts high-ticket balks and the freezer objection into low-ticket sales or reassurance instead of bounces. Low code, high recovery.

**Branch:** `git checkout -B feat/journey-funnel-escape origin/main` (off freshly-merged main after Phase 1).

### Task 2.1 — Add a real low-ticket escape on the size step (SAFE — display only)

**Files:** `app/components/funnel/BuyerFunnel.tsx` (the size-step render), `lib/funnelConfig.ts`

- [ ] Read `BuyerFunnel.tsx` to find where `SIZE_OPTIONS` render on the `size` step.
- [ ] Below the size options, add a de-emphasized escape link (NOT a fifth option card — a text link, so it doesn't compete with the share choice):
  ```tsx
  {/* low-ticket escape — a balk becomes a /shop sale instead of a bounce.
      de-emphasized on purpose: the share is the anchor. */}
  <p className="text-center text-sm text-saddle mt-4">
    not ready for a whole share?{' '}
    <a href="/shop" className="underline hover:text-charcoal transition-colors">try a box or jerky first →</a>
  </p>
  ```
- [ ] Do NOT change any `value` in `SIZE_OPTIONS`. This is display-only. Verify gate. Commit: `feat(funnel): low-ticket /shop escape on the size step`.

### Task 2.2 — Turn the freezer objection into help (SAFE — display only)

**Files:** `app/components/funnel/BuyerFunnel.tsx` (the `storage` step), `lib/funnelConfig.ts` (`STORAGE_OPTIONS`)

- [ ] On the `storage` step, when a buyer picks `need_freezer` (label "Need freezer space"), surface a helpful next step instead of a dead end. Add, near the storage options, contextual help text that appears for/after the `need_freezer` choice:
  ```tsx
  {/* freezer objection → help, not a dead end */}
  <p className="text-center text-sm text-saddle mt-4">
    no freezer? your rancher can hold it in batches — or grab the chest freezer ben uses on{' '}
    <a href="/gear" className="underline hover:text-charcoal transition-colors">the gear page →</a>
  </p>
  ```
  (Implement so it's visible when `need_freezer` is selected, or as always-visible helper sub-copy on the storage step if per-option conditional rendering is awkward — either is fine; do not change `value` strings.)
- [ ] Verify gate. Commit: `feat(funnel): freezer objection → rancher-holds / gear, not a dead end`.

### Task 2.3 — (GUARDED) Reorder to lead with a low-stakes question

**Files:** `app/api/qualify/route.ts` (READ FIRST), `lib/funnelConfig.ts`, `app/components/funnel/BuyerFunnel.tsx`

- [ ] **READ `app/api/qualify/route.ts` and `BuyerFunnel.tsx` FIRST.** Determine how **state** is currently captured (state landing pages `/access/[state]`? the `contact` step? a prefill?). 
- [ ] **Decision gate:**
  - If state is **already captured** before the size question (e.g. via `/access/[state]` prefill or an early field), then the "$-size is the very first ask" problem is already softened for that traffic — **do NOT add a duplicate state question.** Instead, just ensure the size step is not literally screen 1 for cold `/access` traffic by adding a one-line low-stakes intro/reassurance above the size options ("first — where are you? we match you to a ranch that ships to your state" with the existing state capture), and STOP. Note this in the PR.
  - If state is **NOT captured until later**, add it as a new leading step. This requires: (a) a `state` entry in `StepKey`/`FUNNEL_STEPS`/`FUNNEL_COPY`, (b) the scorer in `qualify/route.ts` must still accept the payload (write a test first — Task 2.4), (c) the new step must not break `VALID_TIERS`/`VALID_STORAGE` logic.
- [ ] This task is **optional if the decision gate says "already captured."** Do not force a risky reorder. Protecting the money/scoring path outranks the reorder nicety.

### Task 2.4 — Test the scorer contract if you touched the funnel payload

**File:** `test/` (match the existing test layout)

- [ ] If Task 2.3 added a step or changed the payload, write a test asserting `app/api/qualify/route.ts` still scores a representative payload correctly (tier from size, points from timing/storage) WITH the new field present. Run it red→green.
- [ ] If Task 2.3 was skipped (state already captured), skip this task.
- [ ] Verify gate. Commit any 2.3/2.4 work: `feat(funnel): lead with low-stakes state context before the $-size ask`. Push, open PR, **STOP for Ben.**

**Acceptance:** A share-quiz balk has a visible path to `/shop`; the freezer objection routes to rancher-holds/`/gear`; the quiz no longer opens cold with a bare $1k–5k choice; scorer tests green.

---

# PHASE 3 — Design-system migration (the shop rail → the brand system) (own PR)

**Why:** makes the three tiers feel like one company. Visual continuity is a trust/hand-holding conversion factor — a $20 jerky buy and an $1,800 deposit should look like the same brand.

**Branch:** `git checkout -B feat/journey-design-migration origin/main` (off merged main).

### Task 3.1 — Add the 3 commerce primitives (no page changes yet)

**Files (create):** `app/components/ProductCard.tsx`, `app/components/PriceTag.tsx`, `app/components/TrustStrip.tsx`

- [ ] **`PriceTag.tsx`** — serif price, one `size` prop, identical price typography everywhere:
  ```tsx
  export default function PriceTag({ amount, size = 'md', className = '' }: { amount: number; size?: 'sm' | 'md' | 'lg'; className?: string }) {
    const s = { sm: 'text-lg', md: 'text-2xl', lg: 'text-3xl' }[size];
    return <span className={`font-serif ${s} text-charcoal tabular-nums ${className}`}>${amount.toFixed(2)}</span>;
  }
  ```
- [ ] **`TrustStrip.tsx`** — the one canonical trust line (currently retyped inline with drifting wording on `/shop`, PDP, checkout). Honest copy only:
  ```tsx
  export default function TrustStrip({ className = '' }: { className?: string }) {
    return (
      <p className={`text-sm text-saddle ${className}`}>
        <span className="text-sage">verified ranch</span> · shipping included · secured by stripe · a real person answers your receipt — ben
      </p>
    );
  }
  ```
- [ ] **`ProductCard.tsx`** — one card used by BOTH the `/shop` grid AND the rancher-page product ladder. Image `aspect-[4/3] bg-bone-deep` (so uneven rancher uploads still grid cleanly), serif name, saddle rancher/state line, `<PriceTag>`, sage ships-note, `<Button fullWidth>`. Reuse the existing `app/shop/ProductImage.tsx` (keep its `onError` fallback) for the image. Props: `{ id, name, price, rancherName?, state?, imageUrl?, shipsNote? }`. Link the buy button to the existing checkout route (`/shop/checkout/[id]` — confirm the exact current route by reading `app/shop/BuyButton.tsx`).
- [ ] These use ONLY tokens + existing primitives. No inline hex. Verify gate (tsc + build). Commit: `feat(ui): ProductCard, PriceTag, TrustStrip commerce primitives`.

### Task 3.2 — Inventory the drift, then migrate the shop rail

**Find the exact file set** (don't trust a stale list — grep):
```bash
grep -rl "style={{" app/shop app/order app/admin/products
```
Expected set (~7): `app/shop/page.tsx`, `app/shop/[id]/page.tsx`, `app/shop/BuyButton.tsx`, `app/shop/checkout/[id]/page.tsx`, `app/shop/checkout/[id]/CheckoutMount.tsx`, `app/order/success/page.tsx`, `app/order/cancelled/page.tsx`, `app/admin/products/page.tsx`.

**Token drift map — replace every inline hex with a token class:**

| Inline hex (DROP) | Replace with |
|---|---|
| `#17130E` (brown-black, ~12×) | `charcoal` / `text-charcoal` (the single most visible mismatch — wrong black on every shop heading) |
| `#6B4F3F` (hardcoded) | `saddle` / `text-saddle` |
| `#A7A29A` (hardcoded) | `dust` / `border-dust` |
| `#F4F1EC` (hardcoded) | `bone` / `bg-bone` |
| `#55603F` (~8×) | `sage` / `text-sage` (verified / ships-free) |
| `#3D362D` (~7×) | `text-saddle` or `text-charcoal` body |
| `#EAE6DE`, `#E6E9DC` | `bg-bone-deep` / `bg-bone-warm` |
| `#D8D0C2` | `border-dust` |
| `#8C3A2B` | `weathered` (errors only) |

- [ ] Migrate **one file at a time**, in this order (least→most risk): `app/order/cancelled/page.tsx` → `app/order/success/page.tsx` → `app/shop/BuyButton.tsx` → `app/shop/page.tsx` → `app/shop/[id]/page.tsx` → `app/shop/checkout/[id]/page.tsx` → `app/shop/checkout/[id]/CheckoutMount.tsx` → `app/admin/products/page.tsx`. **Run the verify gate after each file** so a break is isolated.
- [ ] For each file: wrap page bodies in `<main className="min-h-screen py-16 bg-bone text-charcoal"><Container>…`, replace inline-styled `div` "cards" with `<Card>`, replace the inline buy button with `<Button variant='primary' fullWidth>`, replace prices with `<PriceTag>`, replace the retyped trust line with `<TrustStrip>`, and delete every hex per the map. **Diff your result against `app/gear/page.tsx` (browse pages) and the deposit success page (checkout pages)** — they are the correct reference look.
- [ ] `app/shop/page.tsx` specifics: keep the conversion-first order (headline → `<TrustStrip>` → PRODUCTS in first viewport → share-anchor LAST). Swap the local `Card()` fn for `<ProductCard>`. Category `<h2>` serif + saddle sub — same rhythm as `/gear`. Share-anchor panel → `<Card variant="warm">` with `border-l-2 border-sage` and a `<Button variant="secondary">` ("find a ranch →") so it stays quieter than the buy buttons.
- [ ] `app/shop/[id]/page.tsx` (PDP): keep the 2-col photo/story grid, use `<Container>`, `<PriceTag>`, `<TrustStrip>`, `<Button fullWidth>`. **Keep the Product JSON-LD with free-shipping `shippingDetails`** (SEO — do not lose it). Image placeholder `bg-bone-deep`.
- [ ] `CheckoutMount.tsx`: restyle ONLY the summary/skeleton wrapper. **Do not touch** `loadStripe` / `EmbeddedCheckoutProvider` / `fetchClientSecret` (money path).
- [ ] **CRITICAL money-path sanity:** after migrating the checkout + order files, confirm you changed **zero** logic — only className/markup. Re-read your diff. If any Stripe/settlement/price-computation line changed, revert it.

### Task 3.3 — Verify + commit Phase 3

- [ ] Full verify gate green (esp. `rm -rf .next && npm run build`).
- [ ] Grep to confirm the drift is gone: `grep -rn "#17130E\|#55603F\|#3D362D\|#EAE6DE\|#E6E9DC\|#D8D0C2\|#8C3A2B" app/shop app/order app/admin/products` → **zero results**.
- [ ] Commit per file or as a tight series. Push, open PR, **STOP for Ben.**

**Acceptance:** No inline `style={{}}` colors remain in the shop rail; every shop/order/checkout surface uses tokens + shared primitives; the shop visually matches `/gear` and the deposit checkout; money path byte-identical in behavior; build + 941 tests green.

---

# PHASE 4 — Trust, risk-reversal & photography frame (own PR)

**Why:** in food, trust-led + operational risk-reversal beats discounts by 30–40% margin. Photography is the #1 visual lever and the current gap — you build the frame; Ben supplies photos.

**Branch:** `git checkout -B feat/journey-trust-polish origin/main`.

### Task 4.1 — Elevate risk-reversal above the fold

**Files:** `app/shop/page.tsx`, `app/shop/[id]/page.tsx`, funnel reveal in `app/components/funnel/BuyerFunnel.tsx`

- [ ] Surface the guarantee as **operational certainty**, not customer-service uncertainty, ABOVE the fold on `/shop` and the PDP (and the funnel reveal). Exact copy: **"if a cut ever shows up wrong or freezer-burned, we make it right — no forms, no runaround. — ben"** Use `<TrustStrip>` for the standing trust line and add this guarantee as a short line near the buy button. Pull from `lib/refundPolicy.ts` (`REFUND_POLICY_SHORT`) if it already says this — reuse, don't duplicate.
- [ ] Verify gate. Commit: `feat(shop): operational risk-reversal above the fold on /shop + PDP`.

### Task 4.2 — Photography frame + homepage hero warmth (Ben supplies the images)

**Files:** `app/components/ProductCard.tsx` (done in 3.1), `app/shop/[id]/page.tsx`, `app/components/FullHomepage.tsx`

- [ ] Enforce aspect ratios so uneven uploads grid cleanly: ProductCard `aspect-[4/3]`, PDP hero `aspect-square` (`aspect-[1/1]`), both `bg-bone-deep` placeholder, keep `ProductImage` fallback. Warm tone: apply a subtle consistent treatment class (e.g. slight `saturate`/brightness via a shared `img` className) — do NOT hardcode per-image.
- [ ] Homepage hero: add a single editorial hero image slot (currently logo-only) — an `<Image>` with a `/hero-ranch.jpg` src and a graceful fallback if the file is absent (so it doesn't 404 before Ben uploads). Warm, bone-toned framing.
- [ ] Verify gate. Commit: `feat(ui): photography frame (aspect ratios + hero slot) — awaiting Ben's photos`.

### Task 4.3 — aggregateRating JSON-LD on PDPs (if review data exists)

- [ ] Check whether review/rating data is available (memory says review JSON-LD is used elsewhere — find the helper). If a rating source exists for products, add `aggregateRating` to the PDP Product JSON-LD. If no real rating data exists, **skip** — never fabricate ratings (fake scarcity/trust violation). Verify gate. Commit if applicable. Push, open PR, **STOP for Ben.**

**Acceptance:** Guarantee is above the fold on shop surfaces; image frames are consistent and don't break on missing images; hero has a photo slot; no fabricated trust signals.

---

# PHASE 5 — Cohesion QA (own PR or a checklist for Ben)

**Why:** catches any remaining seam or dead-end before ad spend scales.

**Branch:** `git checkout -B chore/journey-cohesion-qa origin/main`.

### Task 5.1 — Walk the full journey

- [ ] Walk: homepage fork → `/access` → (balk) → `/shop` → PDP → `/shop/checkout/[id]` → `/order/success`; and homepage fork → `/gear`. Confirm ONE visual identity end-to-end and ONE clear CTA per screen. Note any surface still on the wrong black, any dead-end, any competing CTA.
- [ ] If a `/design-review` skill exists, run it against the live site (after Ben deploys the earlier phases). Otherwise produce a short findings list.
- [ ] Fix any small seams found (each behind the verify gate). Commit: `chore(journey): cohesion QA — fixes`. Push, open PR, **STOP for Ben.**

**Acceptance:** The journey is continuous — three tiers, one company, no dead-ends, no `#17130E` survivors.

---

## SELF-REVIEW (the executing agent runs this before declaring done)

- [ ] **Coverage:** every phase shipped as its own merged PR; the fork exists; `/shop` + `/gear` reachable from the homepage; the funnel has a `/shop` escape + freezer help; the 7 shop-rail files carry no inline hex; 3 primitives exist and are used.
- [ ] **Money path untouched:** `git diff` across all PRs shows zero changes to charge/settlement/webhook/qualify-scoring/Stripe-embed logic — only markup/className/copy.
- [ ] **Brand voice:** every new string is lowercase, honest, no NO-words, no fake scarcity, `— Ben` where a signature belongs; the share is never cannibalized (de-emphasized on low-ticket surfaces).
- [ ] **Green everywhere:** final `main` after all merges → `tsc` 0, `npm test` ≥941 pass, boundaries 0, `next build` ✓.

## BEN'S PARALLEL TASKS (not the agent's — do while Fable builds)
- Confirm Foodstead's 4 product prices ($95/$199/$375/$749) actually cover cold-pack frozen shipping (else "shipping included" is false + Foodstead eats it).
- Supply the hero + product photography (real ranch/family/cut photos).
- Flip Meta env vars so the fork's new `/shop` + `/gear` traffic is tracked/retargeted.
- Merge each phase PR in order after review.
