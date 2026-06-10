# Save State — 2026-06-09

## Where we are

**Prod sha:** `dc1dfa8` (latest) / `980ef2c` (last code commit, was prod at save time)

## What's shipped this session

1. **V2 Stripe Connect live + onboarding works** — restricted key rotated w/ V2 perms
2. **Wizard tier_v2 mid-flow gate fixed** — no more "Already Onboarded" dump
3. **Cal.com OAuth + Atoms integration cherry-picked** — 5 endpoints + Provider/Panel UI
4. **Webhook bulletproofing** — Cal+Resend return 200 (no retry storms), Cal idempotency via Stripe Events table
5. **Sales-floor pivot:**
   - `/admin/today/v2` — single login screen, auto-refreshes 30s
   - 4-template minimal email pipeline (`lib/emailMinimal.ts`)
   - `EMAIL_SEQUENCES_ENABLED=false` — drip paused
   - `/partner` + `/founders` — infrastructure positioning copy
6. **Cron silent-fail fixes** — rancher reminders guardedSend, batch-approve match errors surface
7. **Quiz → Cal invite (tier_v2 only)** — Ben handles upgraded ranchers' calls; legacy stays off-platform

## Resume HERE next session

### Pending: mass onboarding batch

14 legacy ranchers ready to invite. Side-effect inventory complete in last response.

**Skip list:**
- `rec3K0LsDGQKONNnb` Jesse Zimmerman — already invited (has URL)
- `recsUxUMrEY4fNtp4` Jesse Gajewski — dupe of Renick Valley
- Possibly skip `recBkfqjMQ2txI8AM` Frank Fitzpatrick / 5 Bar Beef (verify Active Status)
- Possibly skip `recYCVL85vofeqXAd` Beckie Elway (verify state)

**Invite roster (14 if no extra skips):**
```
recYCVL85vofeqXAd  Beckie Elway        MT  Foodstead
rec2yADvi1fODSrfj  Russell Gift        OK  Gift Farms LLC
rec2ni15F7NXtY9Ij  Matt & Kelsey Owens NE  Champion Valley Farm
recCdCcZZdruSfG5E  Jason Flowers       NC  JC's Ranch
recNKfctgHlrWZwdB  Trinity Smith       OK  Rafter S7 Farms
recUpqF6yUAULpbPG  John & Kellie Ashcraft TX  Ashcraft Beef
recVTmaMqVw191TQv  Eli Melton          TN  2M Cattle Co.
recWznuhFgcQQ14R4  Ace Hartsock        CO  The High Lonesome Ranch
recawSbn7dhszHQl5  Joseph & Jamie Hewitson CO All Natural Homestead Beef
recfIOyVL4hEQfSJ6  Matt Hirschi        UT  Brimstone Beef
recnLbRqHQsnepv3j  Kristi Carrier      ME  Rocky Ridge Livestock LLC
rect0t5KrJLaWdEpd  Linda Anspach       OR  DD Ranch
recy4vT2788bxLTkD  Katie Hunter        MO  Silverline Cattle Co
recBkfqjMQ2txI8AM  Frank Fitzpatrick   CA  5 Bar Beef (verify first)
```

### How to fire the batch (when ready)

Endpoint: `POST /api/admin/ranchers/[id]/send-v2-upgrade`

Loop in admin-auth bash:
```bash
for ID in <rancher-ids>; do
  curl -sS -X POST "https://www.buyhalfcow.com/api/admin/ranchers/$ID/send-v2-upgrade" \
    -H "Cookie: bhc-admin-auth=<token>" \
    -H "Content-Type: application/json" -d '{}'
  sleep 6
done
```

Each fires: upgrade-invite email + Telegram alert + Migration Status='invited' + Migration Deadline=+14d.

### Buyer-side polish remaining (B1-B4, low priority)

- **B1** `lib/email.ts:417-445` — gate intro email pricing table on `pricingModel === 'tier_v2'`
- **B2** `app/api/qualify/route.ts:244` — also check `Stripe Connect Status === 'active'` before offering deposit
- **B3** `app/api/matching/suggest/route.ts:157-170` — direct-match path mirror deposit info
- **B4** `app/checkout/[refId]/deposit/page.tsx:267` — add "If rancher declines, full refund within 2 business days" copy

These bite only after first tier_v2 buyer matches, so 24-48h window to ship while ranchers KYC.

### Phase 1.5 — admin deposit-picker modal

`/admin/today/v2` Send Deposit button currently opens `/admin/send-deposit?buyer=...&state=...` in a new tab. That route doesn't exist yet. Build:
- Rancher dropdown (filtered to tier_v2 + Active + state match)
- Cut tier picker (Quarter / Half / Whole)
- Confirm → POST `/api/admin/send-deposit-invoice` w/ {buyerId, rancherId, tier}
- Endpoint exists in plan but not yet built (`app/api/admin/send-deposit-invoice/route.ts`)

## Key env state (Vercel prod)

- `STRIPE_SECRET_KEY` = `rk_live_...RGi9RkXY` (V2 Connect perms)
- `EMAIL_SEQUENCES_ENABLED` = `false` (drip paused)
- `CAL_OAUTH_CLIENT_ID` + `CAL_OAUTH_CLIENT_SECRET` set
- `BHC_OPERATOR_CAL_URL` = `https://cal.com/ben-beauchman-1itnsg/sales` (default fallback)

## Synthetic test rancher

`recBVR538JW2ZfTuX` E2E Test Jesse — in `tier_v2` + `onboarding` Connect state. Reset to baseline w/:
```bash
curl -sS -X PATCH "https://api.airtable.com/v0/appgLT4z009iwAfhs/Ranchers/recBVR538JW2ZfTuX" \
  -H "Authorization: Bearer $AT_KEY" -H "Content-Type: application/json" \
  -d '{"fields":{"Tier":"","Subscription Status":"","Stripe Connect Status":"","Stripe Connect Account Id":"","Stripe Subscription Id":"","Pricing Model":"legacy","Migration Status":"invited"},"typecast":true}'
```

## What WORKS end-to-end (verified live)

- Wizard URL → tier picker (4 cards) → Legacy Connect click → V2 acct creates → Connect bank URL → Stripe Express onboarding
- Quiz → matching/suggest → tier_v2 buyer gets Cal invite, legacy buyer gets normal intro
- `/admin/today/v2` loads, auto-refreshes, shows pipeline cards
- Webhook handlers idempotent + signature-verified
- Commission-invoices cron skips tier_v2 ranchers (no double-charge)

## Risk gaps to know

- Phase 1.5 modal stub → manual Send Deposit Invoice route not built yet (Ben can fire via curl in meantime)
- B1-B4 buyer-side polish unshipped → only matters after first matched tier_v2 buyer
- Rancher dashboard Stripe Connect status section — verify renders cleanly when rancher first lands post-KYC

## Resume command

When picking back up:
```
read SAVE_STATE.md
verify prod sha: curl https://www.buyhalfcow.com/api/version
git pull
proceed w/ mass onboarding batch (skip Jesse Z + dupes)
```
