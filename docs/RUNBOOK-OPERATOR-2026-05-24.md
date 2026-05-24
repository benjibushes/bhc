# Operator Runbook — 2026-05-24 Ship

Single-page action list for the operator (Ben) to unlock the code that
shipped in this session. Each item is non-code: env vars in Vercel,
links in Stripe, IDs from Meta/Google, deletes in Airtable.

Order matters: items higher up unlock items lower down. Top to bottom,
~30 min total.

---

## 1. Stripe Payment Links — brand partners ($99 + $499)

**Why:** `/brand-partners` Spotlight + Featured CTAs currently fall back
to `#contact` anchor. Self-serve checkout is dead until links exist.

**Steps:**
1. Open Stripe Dashboard → Products → "+ Add product"
2. Create product: `Brand Spotlight`, price `$99 / month`, recurring
3. Click "Create payment link", check "Allow customers to add coupons" off
4. Copy the URL (looks like `https://buy.stripe.com/xxx`)
5. Repeat for `Brand Featured`, price `$499 / month`, recurring
6. Copy that URL too

**Then in Vercel → bhc project → Settings → Environment Variables → Add:**

| Name | Value | Environment |
|------|-------|-------------|
| `NEXT_PUBLIC_BRAND_SPOTLIGHT_LINK` | `<stripe url for $99>` | Production |
| `NEXT_PUBLIC_BRAND_FEATURED_LINK` | `<stripe url for $499>` | Production |

7. Redeploy production (any deploy reads new env at build time)

**Verify:** open `https://www.buyhalfcow.com/brand-partners` → tap
"Get Spotlight" → should jump to Stripe checkout (not page anchor).

---

## 2. Calendly link — brand founding tier ($1,500)

**Why:** Founding tier is intentional friction (high-ticket qualification
call). Currently falls back to `/call` if env var not set.

**Steps:**
1. Open Calendly → create event type "Brand Partner Founding Call",
   30 min, manual confirmation
2. Copy URL (e.g. `https://calendly.com/benibeauchman/brand-founding-call`)

**Vercel env var:**

| Name | Value | Environment |
|------|-------|-------------|
| `NEXT_PUBLIC_BRAND_FOUNDING_CALENDLY` | `<calendly url>` | Production |

3. Redeploy. Verify: `/brand-partners` → "Book founding call" → opens Calendly.

---

## 3. Analytics IDs — Meta Pixel + GA4 + Google Ads

**Why:** `lib/analytics.ts` + `PixelTracker.tsx` are wired but inert
until env vars exist. Without these, the $10k+ paid ad spend coming
next will be blind to conversion attribution. **HARD BLOCKER for ads.**

**Steps:**

### Meta Pixel
1. Meta Business Suite → Events Manager → "+ Connect data source"
2. Web → Meta Pixel → Create → name it `BuyHalfCow Pixel`
3. Copy Pixel ID (15-16 digit number)

### GA4
1. analytics.google.com → Admin → Create property → "BuyHalfCow"
2. Web data stream → URL = `https://www.buyhalfcow.com`
3. Copy Measurement ID (starts with `G-`)

### Google Ads
1. ads.google.com → Conversions → "+ New conversion action"
2. Website → BuyHalfCow → category "Lead", value "Use the same value"
3. Copy the Conversion ID (starts with `AW-`)

**Vercel env vars:**

| Name | Value | Environment |
|------|-------|-------------|
| `NEXT_PUBLIC_META_PIXEL_ID` | `<pixel id, e.g. 123456789012345>` | Production |
| `NEXT_PUBLIC_GA4_ID` | `<G-XXXXXXXXXX>` | Production |
| `NEXT_PUBLIC_GOOGLE_ADS_ID` | `<AW-XXXXXXXXXX>` | Production |

4. Redeploy production.

**Verify:** open `https://www.buyhalfcow.com` in private browser →
DevTools Network tab → search "fbevents", "googletagmanager", "google-analytics"
→ should see 200s. Meta Events Manager should show "Active" within 30 min.

---

## 4. Bio links — IG / X / TikTok / LinkedIn

**Why:** `/start` is the new single-router bio-link page. Without bio
updates, audience traffic still lands on old destinations.

**Update each social profile bio link to:**

```
https://www.buyhalfcow.com/start
```

Done.

---

## 5. Airtable smoke row cleanup

**Why:** 2 test Consumer rows exist from this session's verification:
- `recg7FFONMsPGowqv` — `freqguard-smoke2-2026-05-24@buyhalfcow.com`
- `recvmENC7IguPwjOs` — `freqguard-smoke-2026-05-24@buyhalfcow.com`

Both are R2B=true + Status=Approved. Reclassify-buyers will try to
route them. Fake email → bounce → muddy metrics.

**Steps:**
1. Open Airtable → Consumers table
2. Search "freqguard-smoke" in Email column
3. Delete both rows

---

## 6. Tighten frequency cap (after 24h)

**Why:** `EMAIL_FREQUENCY_CAP_PER_WEEK` ships at 10 (permissive). Once
the spam-audit cron has 24h of data, tighten to 3 to prevent any single
buyer from getting more than 3 BHC emails/week.

**Steps (24h after today's deploy):**
1. Telegram → tap `/freqcap` → confirms current cap from env
2. Telegram → tap `/templatestats` → review per-recipient volume
3. If max recipient count < 5, tighten safely:
   - Vercel → env → add `EMAIL_FREQUENCY_CAP_PER_WEEK=3` Production
   - Redeploy

---

## 7. Real testimonials (operator action)

**Why:** `lib/testimonials.ts` pulls from `Referrals.Testimonial` field
(or `Referrals.Quote`) when populated. Field doesn't exist yet → pages
show clearly-labeled placeholders.

**Steps:**
1. Airtable → Referrals table → "+ Add field" → name `Testimonial`,
   type `Long text`
2. For each Closed Won row, email the buyer:
   > "We're sharing real wins on the site. Mind sending a 1-sentence
   > quote about your beef experience? First name + state will be the
   > only attribution."
3. Paste responses verbatim into the new Testimonial column
4. `/start` + `/access` pick them up on next 5-min cache refresh

---

## 8. Onboarding video (operator action)

**Why:** Wizard step 0 video slot reads `NEXT_PUBLIC_RANCHER_ONBOARDING_VIDEO_ID`.
Currently unset → text-only intro.

**Steps:**
1. Shoot 90-sec phone video (three beats: what this is / how it works / why it matters — see `docs/BHC.md`)
2. Upload to YouTube, unlisted
3. Copy 11-char video ID from URL (after `v=`)
4. Vercel env: `NEXT_PUBLIC_RANCHER_ONBOARDING_VIDEO_ID=<id>`
5. Redeploy

---

## Verification dashboard (post-runbook)

After all 8 items done:

```
□ /brand-partners $99 + $499 CTAs route to Stripe checkout (not anchor)
□ /brand-partners $1,500 CTA opens Calendly
□ Meta Pixel + GA4 + Google Ads active (DevTools Network)
□ Bio links updated on IG, X, TikTok, LinkedIn → /start
□ 2 smoke Consumer rows deleted
□ /freqcap tightened to 3
□ Referrals.Testimonial field exists, ≥3 rows populated
□ Onboarding video shows on rancher setup step 0
```

When all 8 check → ready for $10k paid ad launch.
