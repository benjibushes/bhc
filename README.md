# BuyHalfCow (BHC)

Private network connecting serious beef buyers with verified American ranchers. Not a marketplace — a curated, relationship-based sourcing platform with intent-based segmentation and on-platform commission capture.

> 📍 **Start here for the top-down picture:** [`docs/BHC-PLATFORM-MAP.md`](docs/BHC-PLATFORM-MAP.md) — the single source of truth for service offerings, the money model, the rancher onboarding funnel, the customer funnel, and every cron/webhook/email that executes. Kept current with the code.
>
> 💰 **Money model + every funnel:** [`docs/MONEY-FUNNELS.md`](docs/MONEY-FUNNELS.md) — paths to money + marketing funnels, end to end.
>
> **2026-06-15:** the **tier_v2** model is LIVE — ranchers run on Stripe Connect and BHC's commission is collected **upfront** as an `application_fee` on the buyer's deposit (tiers in `lib/tiers.ts`: Legacy Connect $0/10% · Pasture $150/7% · Ranch $350/3% · Operator $500/0%). The legacy 10% post-close invoice flow still runs for un-migrated ranchers. Much of the section-by-section detail below predates tier_v2 — `BHC-PLATFORM-MAP.md` is authoritative where they disagree.

## Tech Stack

- **Framework:** Next.js 16 (App Router) + TypeScript
- **Database:** Airtable
- **Email:** Resend (transactional + broadcast)
- **Auth:** JWT magic links (members + ranchers)
- **Admin Notifications:** Telegram Bot API
- **Hosting:** Vercel (with cron jobs)
- **Styling:** Tailwind CSS 4

## Quick Start

```bash
cd bhc
npm install
cp .env.local.example .env.local   # fill in your keys
npm run dev                        # http://localhost:3000
```

## Environment Variables

All required env vars for `.env.local` and Vercel:

| Variable | Description |
|---|---|
| `AIRTABLE_API_KEY` | Airtable personal access token |
| `AIRTABLE_BASE_ID` | Airtable base ID |
| `RESEND_API_KEY` | Resend API key |
| `EMAIL_FROM` | Sender address (e.g. `noreply@buyhalfcow.com`) |
| `ADMIN_EMAIL` | Admin notification email |
| `ADMIN_PASSWORD` | Admin dashboard login password |
| `JWT_SECRET` | Secret for signing all JWT tokens |
| `CRON_SECRET` | Bearer token for cron job endpoints |
| `NEXT_PUBLIC_SITE_URL` | Production URL (`https://www.buyhalfcow.com`) |
| `NEXT_PUBLIC_COMMISSION_RATE` | Legacy commission-rate fallback (`0.10`). tier_v2 rates come from `lib/tiers.ts`; per-rancher locked rate wins over this env. |
| `CAL_API_KEY` | Cal.com API key. **Primary** booking-link mechanism: `lib/calBooking.ts` `getOperatorBookingUrl(purpose)` resolves Ben's live Cal event by purpose (`'rancher'` → Rancher Onboarding, `'sales'` → Sales Calls) — no hardcoded slugs. Falls back to `/contact` if unresolvable. |
| `CAL_RANCHER_BOOKING_URL` / `CAL_SALES_BOOKING_URL` / `CAL_BOOKING_URL` | Optional manual booking-URL overrides (per-purpose, then shared). Win over the API lookup. |
| `NEXT_PUBLIC_CALENDLY_LINK` / `CALENDLY_LINK` | Legacy fallback Cal links still read by some older surfaces (e.g. `lib/email.ts`, `/apply`, `/partner`). New code should use `getOperatorBookingUrl` instead. |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token (optional) |
| `TELEGRAM_ADMIN_CHAT_ID` | Telegram chat ID for admin alerts (optional) |
| `TELEGRAM_WEBHOOK_SECRET` | Secret for Telegram webhook auth |

## Architecture

### User Flows

**Consumer Signup:**
Signup (`/access`) → Intent scoring + segmentation → Auto-approve (Beef Buyer + medium/high intent) or Pending (manual review) → Segment-specific welcome email → Member dashboard (`/member`)

**Rancher Onboarding (tier_v2, current):**
Apply (`/apply` or `/partner`) → magic link → **self-serve `/rancher/setup` wizard**: pick tier (Legacy Connect / Pasture / Ranch / Operator) → connect bank (Stripe Connect) → products + per-cut Price/Deposit/Fee → landing page → sign agreement → **go live**. Alternative door: book the "Rancher Onboarding" Cal and Ben walks them through it. Once Stripe Connect status is `active`, the rancher can take buyer deposits. (The older admin-review → Calendly-call → approval path is superseded — see `docs/BHC-PLATFORM-MAP.md` §2.)

**Matching:**
Approved Beef Buyer → Matching engine finds ranchers by state/preferences → Referral created → Rancher reviews → Direct connection

**Community → Beef Buyer Upgrade:**
Community member → "Get Matched" card on dashboard → Fills order type + budget → Re-scored → Enters matching pipeline

### Intent Segmentation

Consumers are scored at signup based on interests, order type, budget, and contact info:

- **Beef Buyer** (interested in beef or all) — auto-approved if Medium/High intent
- **Community** (merch/brand only) — auto-approved with community email
- **Low intent / incomplete** — stays Pending for manual admin review

### Pages (28 routes)

| Route | Description |
|---|---|
| `/` | Landing page — 4-path user selection |
| `/access` | Consumer signup with intent scoring |
| `/partner` | Rancher/brand/land application |
| `/member` | Member dashboard (auth required) |
| `/member/login` | Magic link login |
| `/rancher` | Rancher dashboard (auth required) |
| `/rancher/login` | Rancher magic link login |
| `/rancher/sign-agreement` | Digital agreement signing |
| `/admin` | Admin CRM dashboard |
| `/admin/broadcast` | Email broadcast tool with segment targeting |
| `/admin/analytics` | Analytics dashboard |
| `/admin/referrals` | Referral management |
| `/admin/commissions` | Commission tracking |
| `/admin/compliance` | Compliance monitoring |
| `/admin/inquiries` | Inquiry gatekeeping |
| `/admin/heatmap` | Geographic heatmap |
| `/admin/backfill` | Existing user backfill tools |
| `/admin/consumers/[id]` | Individual consumer detail |
| `/about`, `/faq`, `/news`, `/privacy`, `/terms` | Public content pages |

### API Routes (44 endpoints)

**Public:**
- `POST /api/consumers` — Consumer signup (intent scoring, auto-approval)
- `POST /api/partners` — Rancher/brand/land application
- `POST /api/inquiries` — Consumer inquiry submission
- `GET /api/stats/public` — Public platform stats
- `GET /api/news` — News articles

**Auth:**
- `POST /api/auth/member/login` — Send magic link
- `GET /api/auth/member/verify` — Verify magic link token
- `GET /api/auth/member/session` — Check session
- `POST /api/auth/rancher/login` — Rancher magic link
- `GET /api/auth/rancher/verify` — Verify rancher token
- `GET /api/auth/rancher/session` — Check rancher session

**Member (JWT auth):**
- `GET /api/member/content` — Dashboard data + segment
- `POST /api/member/upgrade-intent` — Community → Beef Buyer upgrade

**Rancher (JWT auth):**
- `GET /api/rancher/dashboard` — Rancher dashboard data
- `PATCH /api/rancher/referrals/[id]` — Update referral status

**Admin (cookie auth):**
- `POST /api/admin/auth` — Admin login/logout
- `GET/PATCH /api/admin/consumers`, `/api/admin/consumers/[id]` — Consumer management
- `GET/PATCH /api/admin/ranchers`, `/api/admin/ranchers/[id]` — Rancher management
- `GET/PATCH /api/admin/brands`, `/api/admin/brands/[id]` — Brand management
- `GET/PATCH /api/admin/landDeals`, `/api/admin/landDeals/[id]` — Land deal management
- `POST /api/admin/broadcast` — Send/schedule broadcast emails
- `GET /api/admin/broadcast/stats` — Audience counts by segment
- `GET /api/admin/analytics` — Analytics data
- `GET /api/admin/referrals/stats` — Referral statistics

**Matching & Referrals:**
- `POST /api/matching/suggest` — Matching engine
- `POST /api/referrals` — Create referral
- `GET/PATCH /api/referrals/[id]` — Referral detail
- `POST /api/referrals/[id]/approve` — Approve referral

**Cron (CRON_SECRET auth):**
- `POST /api/cron/compliance-reminders` — Monthly compliance reminders
- `POST /api/cron/send-scheduled` — Send scheduled broadcasts (every 5 min)
- `POST /api/ranchers/capacity-check` — Update rancher capacity status

**Other:**
- `POST /api/ranchers/[id]/send-onboarding` — Send onboarding docs to rancher
- `POST /api/ranchers/sign-agreement` — Process digital agreement signature
- `POST /api/backfill/*` — Backfill tools for existing users
- `POST /api/webhooks/telegram` — Telegram bot webhook (interactive buttons)

### Airtable Tables

- **Consumers** — Applications, status, segment, intent score, matching data
- **Ranchers** — Ranch details, certification, capacity, agreement status
- **Brands** — Brand partner applications
- **Land Deals** — Property listings
- **Inquiries** — Consumer→rancher requests, sale tracking, commissions
- **Referrals** — Matching engine referrals with status tracking
- **Campaigns** — Broadcast email campaigns and scheduling
- **News** — Blog/news articles

### Cron Jobs (vercel.json)

| Schedule | Endpoint | Purpose |
|---|---|---|
| `0 9 1 * *` | `/api/cron/compliance-reminders` | Monthly compliance emails |
| `*/5 * * * *` | `/api/cron/send-scheduled` | Process scheduled broadcasts |

## Deployment

```bash
npm run build          # verify clean build
git add -A && git commit
vercel --prod          # deploy to production
```

After deploying, set **all** env vars in the Vercel dashboard under Settings → Environment Variables.

### Telegram webhook (for bot commands)

For slash commands (`/today`, `/help`, etc.) to work, Telegram must send updates to your app with the same secret you use in `TELEGRAM_WEBHOOK_SECRET`. Set the webhook **after** deploy:

```bash
# Replace YOUR_BOT_TOKEN and YOUR_WEBHOOK_SECRET with your real values.
# URL must be your production URL, e.g. https://www.buyhalfcow.com
curl -X POST "https://api.telegram.org/botYOUR_BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://YOUR_DOMAIN/api/webhooks/telegram","secret_token":"YOUR_WEBHOOK_SECRET"}'
```

- Use the **exact** same value for `secret_token` as in Vercel env `TELEGRAM_WEBHOOK_SECRET`.
- Check that it’s set: `curl "https://api.telegram.org/botYOUR_BOT_TOKEN/getWebhookInfo"`.
- If commands still do nothing, confirm `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ADMIN_CHAT_ID` are set in Vercel (same env as production).

### Post-Deploy Smoke Test

- `/access` — submit test signup as Beef Buyer, verify auto-approval email
- `/access` — submit test signup as Community (merch only), verify community email
- `/admin/login` — log in, verify consumer list shows with segment badges
- `/admin/broadcast` — verify segment filters (Beef Buyers, Community)
- `/member/login` — request login link, verify email arrives and login works
- Telegram — verify admin notification arrives (if configured)

## Operational Guides

Detailed operational docs are in the project root:

| Guide | What it covers |
|---|---|
| `AIRTABLE_SETUP.md` | Full Airtable table/field setup |
| `CALENDLY_SETUP_GUIDE.md` | Cal.com scheduling configuration |
| `BUSINESS_EMAIL_SETUP.md` | Resend/Google Workspace email setup |
| `PAYMENT_TRACKING_GUIDE.md` | Commission tracking, invoicing workflow |
| `RANCHER_ONBOARDING_CALLS_GUIDE.md` | Call scripts, tips, follow-up process |
| `DEPLOY_NOW.md` | Deployment commands and troubleshooting |
| `EMAIL_ATTRIBUTION_SYSTEM.md` | Campaign tracking and attribution |
| `BRAND_COMPLIANCE.md` | Brand colors, typography, design standards |
| `LIVE_TEST_CHECKLIST.md` | Full end-to-end test procedure |

## Project Structure

```
bhc/
├── app/
│   ├── page.tsx                    # Landing page
│   ├── layout.tsx                  # Root layout + metadata
│   ├── access/                     # Consumer signup
│   ├── partner/                    # Rancher/brand application
│   ├── member/                     # Member dashboard + auth
│   ├── rancher/                    # Rancher dashboard + auth + signing
│   ├── admin/                      # Admin CRM (13 sub-pages)
│   ├── api/                        # 44 API routes
│   └── (about|faq|news|privacy|terms)/  # Public pages
├── lib/
│   ├── airtable.ts                 # Airtable client + helpers
│   ├── email.ts                    # All email templates (Resend)
│   └── telegram.ts                 # Telegram bot notifications
├── proxy.ts                    # Auth + security headers
├── public/
│   ├── docs/                       # Legal documents (TOS, agreements)
│   ├── favicon.ico
│   ├── bhc-logo.png
│   ├── og-image.png
│   └── apple-touch-icon.png
└── vercel.json                     # Cron job configuration
```
