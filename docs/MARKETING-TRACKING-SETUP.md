# Marketing tracking setup — operator runbook

Tracking infrastructure that **can't** be deployed from the BHC codebase
because it lives on external systems (Shopify, third-party Pixels). Each
section is an operator action with concrete steps.

Audit 6 P0: Merch sales currently invisible to BHC Meta Pixel because
`merch.buyhalfcow.com` is a Shopify-hosted subdomain that does not load
BHC's `PixelTracker` component. Without this setup, the merch funnel is
attribution-dark and paid Meta ads driving traffic to merch products can't
be optimized for purchase ROAS.

---

## 1. Shopify Pixel install on merch.buyhalfcow.com

Two install paths — pick **one** based on Shopify plan:

### Path A — Built-in Facebook Pixel field (works on every Shopify plan)

1. Log into Shopify admin: <https://admin.shopify.com/store/buyhalfcow-merch>
   (or whatever the merch store handle is)
2. Navigate: **Online Store → Preferences**
3. Scroll to **Facebook Pixel** section
4. Paste pixel ID: `1004845022102184`
5. Save

Validates: Shopify will fire `PageView`, `ViewContent`, `AddToCart`,
`InitiateCheckout`, `Purchase` events automatically from the storefront +
checkout flow.

### Path B — Meta Pixel app (Shopify Plus + recommended for CAPI)

1. Shopify admin → **Settings → Apps and sales channels**
2. Search **Facebook & Instagram** app, install
3. Connect to BHC's Meta Business account (same one that owns pixel
   `1004845022102184`)
4. In the app's setup wizard, enable **Conversions API** (this is the
   server-side companion to the client-side Pixel — same dedup model as
   `/api/checkout/deposit` uses on the main BHC site)
5. Connect Domain: `merch.buyhalfcow.com` and verify via DNS TXT or
   meta-tag (Shopify auto-handles this if you use Shopify-managed DNS)

Validates: Both client Pixel + CAPI fire deduplicated events, restoring
~30-50% of iOS 14.5+ ATT-blocked client events.

---

## 2. Test the install

After install, **always** verify with Meta's Test Events panel before
running paid traffic:

1. Open Meta Events Manager: <https://business.facebook.com/events_manager2/list/pixel/1004845022102184>
2. Click **Test Events** tab
3. Get the test event code (8-character string)
4. (Path A only) Append `?fbclid=test` to a merch URL and visit
5. (Path B) Paste the test event code into the Meta Pixel app setup
6. Browse a product → add to cart → start checkout — confirm each event
   appears in the Test Events panel in real time

Pass criteria:
- `PageView` fires on every page
- `ViewContent` fires on product detail pages w/ `content_ids` populated
- `AddToCart` fires on cart-add w/ `value` + `currency` populated
- `Purchase` fires on order confirmation w/ correct `value`

If any of these don't fire, re-check the pixel ID in Shopify and confirm
the storefront domain (`merch.buyhalfcow.com`) is added to your Meta
Business assets under Domain Verification.

---

## 3. Optional — Stape.io CAPI Gateway (advanced)

Use when:
- iOS attribution loss is still high after Path B install
- You want server-side enrichment of event payloads (e.g. customer
  lifetime value, custom audience segmentation by purchase history)
- You want to fire CAPI events to Pixel **and** a second destination
  (TikTok, Google Ads) from one server-side tag

Steps:
1. Sign up at <https://stape.io>
2. Create a **server container** for `merch.buyhalfcow.com`
3. Add a subdomain (e.g. `gtm.buyhalfcow.com`) pointing to Stape's
   gateway via CNAME (Cloudflare API change required)
4. Install Stape's Shopify app from the Shopify app store
5. Wire the Meta Pixel CAPI tag inside the Stape server container w/
   access token from <https://business.facebook.com/events_manager2/list/pixel/1004845022102184/access_token>

Stape is **not required** for paid-ad attribution to work — Path B alone
gets you to ~95% attribution coverage. Stape adds enrichment + multi-
destination fanout.

---

## 4. Reconcile w/ BHC main-site Pixel

The main BHC site (`buyhalfcow.com`, `www.buyhalfcow.com`) loads the
Pixel via `components/PixelTracker.tsx` + fires CAPI from server routes
(see `/api/checkout/deposit`, `/api/consumers`, `/api/partners`,
`/api/wholesale/signup`, `/api/founders/checkout`).

The Shopify merch install fires the **same** pixel ID
(`1004845022102184`) so all events land in **one** Events Manager
dashboard. Conversions across the BHC main site + merch store roll up
to one ROAS view.

Audiences created from the Pixel (e.g. "all merch buyers", "viewed
ranchers but didn't purchase") can be retargeted across **both**
surfaces because they share the same pixel.

---

## 5. Per-event status — Last verified 2026-05-27

| Surface | Event | Client Pixel | Server CAPI | Notes |
|---|---|---|---|---|
| `/access` quiz | Lead | Y | Y | `/api/consumers` |
| `/partner` (rancher/brand/land) | Lead | Y | Y | T1 — `/api/partners`, dedup via record.id |
| `/wholesale` | Lead | Y | Y | T2 — server mirror added |
| `/ranchers/[slug]` | ViewContent | Y | n/a | T3 — per-rancher segment |
| `/ranchers/[slug]` pricing CTA | AddToCart | Y | n/a | T3 — intent signal |
| `/access/[state]` | ViewContent | Y | n/a | T4 — state segment |
| `/checkout/[refId]/deposit` | InitiateCheckout | Y | Y | F5 — dedup'd |
| `/checkout/[refId]/success` | Purchase | Y | Y | F5 — dedup'd |
| `/founders` checkout | InitiateCheckout / Purchase | Y | Y | Stripe webhook |
| `/brand-partners` checkout | Purchase | Y | Y | Stripe webhook |
| **`merch.buyhalfcow.com`** | All standard events | **OPERATOR ACTION** | **OPERATOR ACTION** | This doc |

The merch row is the only remaining attribution gap — fix it via the
steps above. Everything else is wired in BHC code and live in production.

---

## Contact

If install fails or Test Events panel doesn't see traffic:
- Ben (operator): @ben on Telegram or `ben@buyhalfcow.com`
- Meta support: <https://business.facebook.com/help> (Business account
  ID required — pull from Events Manager URL bar)
