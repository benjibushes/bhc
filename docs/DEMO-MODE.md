# Demo Mode — local-only fake-data sandbox for tutorial videos

Demo mode lets you run the **entire** BuyHalfCow platform locally against
realistic **fake** data, so you can screen-record rancher-onboarding tutorials
without ever touching production. When it's on, the app makes **zero** external
calls — no Airtable, Stripe, Resend, Twilio, or Telegram.

> ⚠️ **The flag is never set in Vercel.** It is a local runtime flag you type on
> the command line. With the flag off, every code path is byte-identical to
> production — the demo branches are inert early-returns that never execute.

---

## How to run it

```bash
NEXT_PUBLIC_DEMO_MODE=true npm run dev
```

Then open **http://localhost:3000/demo** — the launcher lists every surface to
record with deep links and a one-line "what to show" for each.

You'll see a loud red banner in the terminal and an amber
`DEMO MODE · sample data · not live` ribbon in the bottom-left of every page,
so a recording can never be mistaken for the live site.

`NEXT_PUBLIC_DEMO_MODE` is enough (it's readable both server- and client-side).
`DEMO_MODE=true` is also honored for server-only contexts. Either being exactly
the string `'true'` turns demo mode on; anything else leaves it off.

No credentials are required — no `AIRTABLE_API_KEY`, no Stripe keys, nothing.
The rancher dashboard auto-logs-in as the demo rancher with no cookie.

---

## What data it shows

Everything is deterministic (computed from a fixed base date in
`lib/demo/demoStore.ts`), so every run looks identical.

**One flagship rancher — "Demo Creek Cattle Co"** (`/ranchers/demo-creek-cattle`)
- Bozeman, MT · Black Angus grass-fed · tier_v2 · Stripe Connect `active` · Page Live
- Full pricing: Quarter $1,050 / Half $1,950 / Whole $3,700
- Tagline, about, gallery photos (picsum.photos placeholders), testimonials
- 6% commission rate, 12 max active referrals

**~14 referrals across every pipeline stage** so the pipeline looks alive:
- Intro Sent (2), Rancher Contacted (1), Negotiation (1)
- Awaiting Payment (1, deposit requested), Slot Locked (1, deposit paid)
- **Closed Won (6)** — total revenue **$18,050**, 6% commission **$1,083**,
  a mix of paid/unpaid commission and fulfilled/processing orders with tracking
- Closed Lost (2)

**Supporting data**: a demo Consumer (buyer) per referral, a Payment row per
paid deposit, and 2 Threads with messages (including unread buyer replies) so
the inbox has something to show.

---

## The safety guarantee

- **`lib/demo/demoMode.ts`** is the single gate. `isDemoMode()` returns true
  **only** when `NEXT_PUBLIC_DEMO_MODE === 'true'` or `DEMO_MODE === 'true'`.
  Nothing else — no cookie, header, or DB row — can flip it. A red-first test
  (`lib/demo/demoMode.test.ts`) pins the production default to `false`.
- The flag is **not** present in `vercel.json`, `.env`, or any committed config.
  It's a local CLI flag only.
- Every demo branch in production code is an `if (isDemoMode()) return …`
  early-return at the top of a function. With the flag off it never runs, so
  production behaves exactly as before.
- Real auth and money logic are untouched — the demo branch is additive and
  gated; the non-demo path is unchanged.

### Where the demo branches live

| File | Function(s) | Demo behavior |
| --- | --- | --- |
| `lib/airtable.ts` | `getAllRecords`, `getRecordById`, `getRecord`, `getFirstRecord`, `getRecordsByIds`, `getRancherBySlug`, `getRancherOrProspectBySlug`, `getActiveRancherPages` | Return in-memory fixtures |
| `lib/airtable.ts` | `createRecord` (→ `createReferral`), `updateRecord` | No-op; return a fake/merged record, never touch Airtable |
| `lib/rancherAuth.ts` | `resolveRancherSession` (→ `requireRancher`) | Auto-return the demo rancher session (no cookie) |
| `lib/stripeConnect.ts` | `createDepositCheckout` | Return a fake `{ url:'/checkout/DEMO/deposit', … }`, no charge |
| `lib/email.ts` | `guardedSend` (chokepoint for all senders) | Return `{ success: true }`, no send |
| `lib/twilio.ts` | `sendSMS` | Return `true`, no SMS |
| `lib/telegram.ts` | `sendTelegramMessage` (chokepoint) | No-op, no ping |

---

## How to extend the fixtures

All fixtures live in **`lib/demo/demoStore.ts`** and are keyed by the real
Airtable table names (from `lib/airtable` `TABLES`).

- **Add a referral**: push a new `ref({ … })` into `DEMO_REFERRALS`. It links
  the demo rancher automatically. Give it a unique `id` in the
  `recDEMOreferralNN` style and a matching Buyer in `DEMO_CONSUMERS` (the
  consumers array is derived from the referrals, so add the `Buyer` id there if
  you want a distinct buyer record).
- **Change earnings**: edit `Sale Amount` / `Commission Due` on the Closed Won
  rows. The sanity test (`lib/demo/demoStore.test.ts`) asserts the totals — bump
  the expected numbers there too, or relax those assertions.
- **Add another rancher**: add a record to the `TABLES.RANCHERS` fixtures array
  and (optionally) teach `demoRancherForSlug` to route specific slugs to it.
  Today every slug resolves to the single flagship rancher.
- **Keep it deterministic**: never use `Date.now()` when building fixtures — use
  the `daysAgo()` / `hoursAgo()` helpers so runs stay byte-identical.

After editing fixtures, run the sanity test:

```bash
npx tsx --test 'lib/demo/demoStore.test.ts'
```

---

## v2 / not-yet-covered

- The **buyer funnel** (`/access` quiz) submits succeed (create/update are
  no-ops) but the quiz-scoring / matching side may still read live-shaped data
  in places — good enough to *show* the flow, not to complete a full match.
- **`/admin`** is not auto-authenticated in demo mode (only the rancher auth is
  bypassed). Add an identical `isDemoMode()` gate to the admin-auth helper if
  you want to record admin surfaces too.
