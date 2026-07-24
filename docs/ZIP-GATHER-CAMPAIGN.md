# ZIP-Gathering Campaign — DARK until Ben approves

*2026-07-23. Built alongside the exclusive-ZIP gate (PR #462). **Nothing sends
until Ben sets the env flags below.** This doc is the approval sheet: audience,
copy, and the exact go-live steps.*

---

## Why

The exclusive supplier gate (Thomas Cattle & Catering, Houston "77") can only
place a buyer whose **ZIP** is known. ~248 legacy **TX WAITING** buyers have **no
ZIP** — a Houston buyer who is Thomas's exact customer is invisible to routing.
This campaign asks those buyers to confirm a delivery ZIP; the confirmed ZIP
then flows through the **same** exclusive-ZIP gate as everyone else. **The
campaign never routes anyone** — it only fills in the missing ZIP.

## Audience (selection is code, in `lib/zipGatherCampaign.ts`, unit-tested)

A buyer is shortlisted only if **all** hold:

| Filter | Rule |
|---|---|
| State | normalizes to **TX** |
| Buyer Stage | **WAITING** (not matched/closed) |
| ZIP | **none on file** (nothing to gather otherwise) |
| Phone area code | in the target metro set (the relevance pre-filter) |
| Email | present |
| Suppression | **not** Unsubscribed / Bounced / Complained (CAN-SPAM) |

**Area-code → metro pre-filter** (`lib/areaCodeMetro.ts`):
- **Houston:** 713 · 281 · 832 · 346 · 409 · 979
- **Austin / Central:** 512 · 737 · 830

**Audience count:** the founder pool is ~248 TX WAITING no-ZIP buyers; the
area-code pre-filter narrows that to the Houston/Austin subset. The **exact
number (and the Houston vs Austin split)** is emitted by the dry-run cron —
run it and read `audienceCount` + `byMetro` **before** flipping send:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://www.buyhalfcow.com/api/cron/zip-gather
```

With `ZIP_GATHER_ENABLED=true` and `ZIP_GATHER_SEND` unset, that returns the
audience + the exact copy and **sends nothing**.

## Message copy (`buildZipConfirmMessage`, TCPA / CAN-SPAM-safe)

**Email — subject:** `Confirm your delivery ZIP so Thomas Cattle & Catering can serve you`

> Hi {firstName},
>
> Thomas Cattle & Catering is now serving buyers near you — I just need your
> delivery ZIP to confirm you're in their area and get you matched.
>
> **[ confirm your ZIP → ]**  (one-tap signed link → `/api/zip-confirm`)
>
> One tap — it takes a few seconds and puts you in line for a local delivery
> slot. If the timing's wrong, just ignore this.
>
> — Ben, BuyHalfCow

List-Unsubscribe header is attached by the send layer (`sendEmail → guardedSend`);
sends respect suppression **and** the 3/week frequency cap.

**SMS (copy ready; no live A2P sender wired — dry-reports until one is):**

> BuyHalfCow: {firstName}, Thomas Cattle & Catering can now deliver near you.
> Confirm your delivery ZIP so we can match you: {link} Reply STOP to opt out.

## One-tap capture (`/api/zip-confirm`)

Signed link → a minimal ZIP form → writes **only** `Consumers.Zip`. The JWT
binds the consumerId, so a buyer can only set **their own** ZIP, and only to a
valid US 5-digit ZIP. The confirmed ZIP is then subject to the exclusive-ZIP
gate exactly like a funnel-captured one.

## Go-live (Ben, per-flag — everything defaults OFF)

1. **Confirm Thomas is ready:** `Active Status=Active` + `Service ZIP Prefixes`
   set (`77`, add `78` only if Austin is confirmed). Until then he is
   non-routable regardless of this campaign.
2. **Dry-run** the cron (command above) → review `audienceCount` + `byMetro`.
3. `ZIP_GATHER_ENABLED=true` — arms the cron (still dry-run without step 4).
4. `ZIP_GATHER_SEND=true` — begins sending (email), capped by
   `ZIP_GATHER_DAILY_CAP` (default 50/run) to warm up.

### Env flags
| Flag | Default | Effect |
|---|---|---|
| `ZIP_GATHER_ENABLED` | unset | must be `true` to run at all |
| `ZIP_GATHER_SEND` | unset | must be `true` to send; else dry-run |
| `ZIP_GATHER_SUPPLIER` | `Thomas Cattle & Catering` | name in the copy |
| `ZIP_GATHER_METROS` | `houston,austin` | which metros to include |
| `ZIP_GATHER_CHANNEL` | `email` | `email` (live) or `sms` (dry only) |
| `ZIP_GATHER_DAILY_CAP` | `50` | max sends per run |

No cron schedule is registered — invoke manually (curl above) or add a
`vercel.json` cron entry once approved.
