# GO-LIVE SETUP — the complete "make the machine work" list

Every switch, where it lives, and what it turns on. Work top to bottom.
Last updated: 2026-07-08. (Code is DONE — everything here is config, data
entry, or phone calls. Nothing below requires a deploy.)

---

## 1 · Vercel → **bhc** project → Settings → Environment Variables

| Env var | Value | Turns on |
|---|---|---|
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | your `pk_live_…` | brand-owned Payment Element checkout + Apple Pay |
| `NEXT_PUBLIC_PRODUCT_PAYMENT_ELEMENT` | `true` | ^ same (rollback switch — set `false` to revert to Stripe iframe) |
| `RESEND_INBOUND_WEBHOOK_SECRET` | from Resend → Webhooks | **buyer/rancher email replies — DROPPING until set** |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | from vapid-keys (regen: `npx web-push generate-vapid-keys`) | rancher app push notifications |
| `VAPID_PRIVATE_KEY` | ^ pair | ^ |
| `LOG_RETENTION_ENABLED` | `dry-run` → `true` next day | Airtable log pruning (50k-record wall) |
| `PRODUCT_RECOVERY_ENABLED` | `dry-run` → `true` | abandoned-checkout nudge emails |
| `PRODUCT_STOCK_CHECKIN_ENABLED` | `dry-run` → `true` | monthly rancher stock check-in email |
| `PRODUCT_REVIEW_ASK_ENABLED` | `dry-run` → `true` | post-ship review-ask email |
| `AFFILIATE_COMMISSION_RATE` | `0.10` | collaborator payout rate (default is 5% — too thin for creators) |
| Meta Purchase envs (2) | per docs/AD-ENDPOINTS.md | conversion events — **only after test buy + supply gate** |

`dry-run` = cron runs + reports to Telegram, sends nothing. Eyeball one
report, then flip to `true`.

## 2 · Vercel → **bhc-prospects** project → Environment Variables
*(the outreach machine — all dark until these exist)*

| Env var | Value | Note |
|---|---|---|
| `CRON_SECRET` | fresh random string | Vercel auto-sends it to the crons; they 401 without it |
| `PROSPECT_OUTREACH_ENABLED` | `dry-run` first | 9am MT Telegram sample — judge the voice, then `true` |
| `ANTHROPIC_API_KEY` (or `GROQ_API_KEY`) | copy from bhc project | powers the draft engine |
| `RESEND_API_KEY` | copy from bhc project | send rail |
| `OUTREACH_FROM` | `Ben <ben@buyhalfcow.co>` | **must be on the outreach domain — see §5** |
| `OUTREACH_PHONE` | the new cell | worked into every draft naturally |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ADMIN_CHAT_ID` | copy from bhc project | digests |

## 3 · Stripe Dashboard (5 min, eyeball only)

- [ ] Webhooks: two endpoints — `/api/webhooks/stripe` and `/api/webhooks/stripe-connect` with **"listen to events on connected accounts"** checked
- [ ] Legacy payment links (HERD / OUTLAW / STEWARD / TITLE_FOUNDER): price still right, or deactivate
- [ ] *(later, optional)* set ToS URL → flip `STRIPE_CONSENT_COLLECTION=true` (chargeback armor on deposits)

## 4 · Resend Dashboard

- [ ] Webhooks → copy the inbound webhook signing secret → §1's `RESEND_INBOUND_WEBHOOK_SECRET`
- [ ] *(with §5)* Domains → add + verify the outreach domain (DKIM records)

## 5 · The outreach domain + managed inbox (~$10 + $7/mo, ~30 min)

**Why: cold outreach NEVER rides buyhalfcow.com — one spam complaint must
not be able to touch buyer receipts and deposit links.**

1. Buy **buyhalfcow.co** (or similar sibling domain)
2. Verify it in Resend (DKIM records from §4)
3. **Google Workspace Business Starter** ($7/mo) → one user: `ben@buyhalfcow.co` — this is THE managed inbox
4. Redirect the domain's web root → buyhalfcow.com (a rancher who checks it finds the real thing)
5. Set `OUTREACH_FROM="Ben <ben@buyhalfcow.co>"` (§2)
6. Inbox person: Gmail **delegation** (Settings → Accounts → grant access) — no password sharing
7. Keep the 10/day cap for 2+ weeks — that IS the domain warm-up

### Inbox manager SOP (the whole job)
- 9am — Telegram: "N drafts ready" → open bhc-prospects.vercel.app → read/edit → flip good ones to **Approved**
- 11am — machine sends (weekdays only, capped 10/day)
- All day — answer replies in `ben@buyhalfcow.co`, same casual voice; saved templates for "how's it work / what's it cost / call me"
- Every reply → flip that row to **Replied** (keeps the machine honest); "no thanks" → **Do Not Contact**
- Hot ones → send Cal link (`buyhalfcow.com/book?purpose=rancher`) or text Ben the ranch + number. **The machine opens, the inbox qualifies, Ben closes.**

## 6 · Airtable data entry (15 min)

- [ ] `Ships In Days` on all 10 Rancher Products (the "ships within ~N days" checkout trust line)
- [ ] Pepper Beef Jerky: photo + Active, or delete the row
- [ ] `Weight / Size` ×6, `Feeds` ×4 (nice-to-have)
- [ ] Affiliates: delete duplicate Jasmine Turner row; confirm Jaelynn `.con` → `.com`
- [ ] Gear rows: replace placeholder art with real photos as they're shot (paste URL into `Image URL` — page updates itself)

## 7 · Phone + social plumbing

- [ ] IG bio → `buyhalfcow.com/links`
- [ ] ManyChat keywords: **COST** → buyhalfcow.com/guide · **JERKY** → the jerky PDP · **SHARE** → buyhalfcow.com/access
- [ ] New outreach cell number → §2's `OUTREACH_PHONE`

## 8 · The proof + the sequence (order is the strategy)

1. **Test buy** — $13.59 snack sticks on /shop + one self-minted deposit link from /admin/sell. Tell Claude; the settle chain gets verified live. **Gate for everything.**
2. **The twelve calls** — docs/RANCHER-CALL-SCRIPTS.md. Ashcraft (TX 253) → 5 Bar (CA 202) → Colorado trio (86, race) → rest. Operator-tier pitch + descriptor ask + "app on your phone" on every call. 🔄 Resync after each.
3. **Shop Drop** — /admin/sell → campaigns → dry-run → Telegram → live ×100 batches (1,981 waiting buyers learn the shop exists)
4. **Ads** — ONLY after (1) settled AND ≥3 active ranchers in one state → Meta envs → $30–50/day geo-fenced to that state

## 9 · Standing rhythm

- Monday 8am MT — scorecard lands in Telegram (deposits · orders · ranchers activated · outreach). The number decides the week.
- Content: 4–5 shop-first reels/wk (COST/JERKY keywords), daily Stories; share content per activated state; SHARE keyword = warm only
- $13k: ~$10k runway · $2k ads (gated) · $500 legal · $500 misc

---
*Everything above is reversible except the phone calls. Make the calls.*
