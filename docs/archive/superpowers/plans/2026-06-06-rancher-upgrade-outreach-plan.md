# Rancher Upgrade Outreach Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive a 5-rancher pilot onto tier_v2 (Stripe Connect direct deposits + Ben handles every buyer sales call + $500/mo retainer subscription), via a coordinated SMS + Email + Cal.com outreach sequence with full Airtable funnel tracking, an explanatory video demo, and a post-invite routing pause so the pilot 5 don't keep receiving "old model" leads while they migrate. Bulk rollout to the remaining 9 active legacy ranchers is gated on pilot success (at least 3 of 5 complete Stripe Connect + 1 closed sale through the new flow).

**Pilot 5 (exact rec ids):**

| # | Rancher | State | Airtable rec id | Notes |
|---|---|---|---|---|
| 1 | Beckie Elway / Foodstead | MT | `recYCVL85vofeqXAd` | Anchors MT coverage |
| 2 | Joseph & Jamie Hewitson / All Natural Homestead Beef | CO | `recawSbn7dhszHQl5` | Verbal yes already on $500/mo retainer |
| 3 | Jesse Gajewski / Renick Valley Meats | WV | `recsUxUMrEY4fNtp4` | WV anchor (Karie + Caleb's matched rancher) |
| 4 | Katie Hunter / Silverline Cattle Co | MO | `recy4vT2788bxLTkD` | MO anchor |
| 5 | Russell Gift | OK | `rec2yADvi1fODSrfj` | Admin-approved multi-state (OK/TX/KS/NM/CO) — pilots nationwide-style routing under tier_v2 |

**Retainer + subscription pricing:** Pilot 5 are sold the **$500/month retainer tier** during the upgrade call. Plan assumes a Stripe Price object exists for this tier — if it doesn't, Task 0 below creates it before any invite goes out.

**Architecture:**
1. Extend the existing `/api/admin/ranchers/[id]/send-v2-upgrade` endpoint (already mints a 60-day wizard JWT + drafts an email) to also fire a parallel SMS to the rancher's phone via a new `sendSMSToRancher()` helper. Both messages carry Ben's Cal.com link. The email moves from inline HTML to a dedicated `sendRancherUpgradeCallInvite` template in `lib/email.ts`.
2. Add three datetime fields on Ranchers (`Call Booked At`, `Call Completed At`, `Connect Active At`) — populated by Cal.com webhook + Stripe Connect webhook + admin manual stamp. Surface them on `/admin/migration`.
3. Add a `Routing Paused For Migration` boolean on Ranchers + honor it in `isRancherOperationalForBuyers()` so the same rancher pauses for new buyer routing the moment the invite goes out (resumes automatically when `Pricing Model` flips to `tier_v2`).
4. Ship a `docs/RANCHER-UPGRADE-DEMO-STORYBOARD.md` doc with a 5-scene 90-second Loom script for the operator to record.
5. Bulk-send via the existing `/admin/migration` "Bulk Invite" button (already wired) — no new UI plumbing needed, just the underlying SMS + tracking landing first.

**Tech Stack:** Next.js 16 App Router · TypeScript · Airtable REST (via `lib/airtable.ts`) · Twilio (via `lib/twilio.ts`) · Resend (via `lib/email.ts`) · Telegram Bot API (via `lib/telegram.ts`) · Cal.com webhook (existing handler in `app/api/webhooks/cal/route.ts`) · Stripe Connect webhook (existing handler in `app/api/webhooks/stripe-connect/route.ts`) · Vercel deploy.

---

## File Structure

### Files to create

- `lib/email/sendRancherUpgradeCallInvite.ts` *(new)* — single-purpose email template. Lives in its own file because `lib/email.ts` is 4300+ lines and any new template should be split out per the codebase's mid-2026 direction (no enforcement yet — convention only).
- `docs/RANCHER-UPGRADE-DEMO-STORYBOARD.md` *(new)* — 5-scene Loom script for the 90-second demo.

### Files to modify

- `lib/twilio.ts` — add `sendSMSToRancher()` helper paralleling `sendSMSToConsumer()`. Gates on rancher phone + Active Status, never sends to Inactive/Disabled ranchers.
- `lib/email.ts` — re-export `sendRancherUpgradeCallInvite` from the new file so existing import sites continue to work.
- `lib/rancherEligibility.ts` — honor a new `Routing Paused For Migration` boolean inside `isRancherOperationalForBuyers()`. When true, the rancher is treated as paused even if `Active Status='Active'`.
- `app/api/admin/ranchers/[id]/send-v2-upgrade/route.ts` — switch to the new email template, fire the SMS, stamp `Routing Paused For Migration=true`, surface SMS-status in the response, and emit a single Telegram alert (vs the two it sends today).
- `app/api/webhooks/cal/route.ts` — when the booking host is Ben's migration Cal slug, stamp `Call Booked At` + `Migration Status='call_scheduled'` on the matching rancher (look up by attendee email).
- `app/api/webhooks/stripe-connect/route.ts` — when a Connect account becomes `active` for a rancher whose previous `Pricing Model` was `legacy`, additionally stamp `Connect Active At` (the existing handler already flips Pricing Model + Migration Status to completed; new field is parallel).
- `app/api/admin/migration/route.ts` — surface the three new timestamps in the response so the UI can render them.
- `app/admin/migration/page.tsx` — render Call Booked / Completed / Connect Active columns in the per-rancher table.
- `lib/emailFrequencyGuard.ts` — whitelist `sendRancherUpgradeCallInvite` so the upgrade invite never gets silently capped.

### Airtable schema (via MCP)

- `Ranchers.Call Booked At` (dateTime, ISO, UTC) — stamped by Cal webhook.
- `Ranchers.Call Completed At` (dateTime, ISO, UTC) — stamped by Cal webhook on booking event `ended` OR operator manual flip.
- `Ranchers.Connect Active At` (dateTime, ISO, UTC) — stamped by stripe-connect webhook when Connect status flips to active for a previously-legacy rancher.
- `Ranchers.Routing Paused For Migration` (checkbox, default false) — flipped true at invite-send time. `isRancherOperationalForBuyers()` reads it. Flipped back to false by stripe-connect webhook on `Pricing Model='tier_v2'` flip.

---

## Task 0: Verify / create the $500/mo retainer Stripe Price

**Files:**
- No repo files unless a new Price is created — manual Stripe Dashboard work + env var.

- [ ] **Step 1: Check Stripe Dashboard for an existing $500/month recurring Price**

In the Stripe Dashboard (live mode), navigate to Products → search "Retainer" / "$500" / "Operator". Expected: existing recurring Price at $500.00/month USD. If found, copy its `price_id` (starts with `price_`).

- [ ] **Step 2: If missing, create the Price**

Stripe Dashboard → Products → New product:
- Name: `BuyHalfCow Operator Retainer`
- Description: `Monthly platform retainer — Ben handles every qualification call + deposit logistics + NRD enforcement. Includes Stripe Connect routing + final-invoice tooling.`
- Pricing: `Standard pricing` · `Recurring` · `$500.00` USD · `Monthly`
- Save. Copy the new `price_id`.

- [ ] **Step 3: Set the env var on Vercel**

```bash
vercel env add STRIPE_OPERATOR_RETAINER_PRICE_ID production
# When prompted: price_xxxxxxxxxxxx
vercel env add STRIPE_OPERATOR_RETAINER_PRICE_ID preview
vercel env add STRIPE_OPERATOR_RETAINER_PRICE_ID development
```

Verify:

```bash
vercel env ls | grep STRIPE_OPERATOR_RETAINER_PRICE_ID
```

Expected: three rows.

- [ ] **Step 4: Commit (allow-empty for audit)**

```bash
git commit --allow-empty -m "chore(stripe): provision $500/mo Operator Retainer price + STRIPE_OPERATOR_RETAINER_PRICE_ID env"
```

---

## Task 1: Add three Migration tracking datetime fields on Ranchers (Airtable schema)

**Files:**
- Schema mutation only (no repo files modified)

- [ ] **Step 1: Use Airtable MCP to add `Call Booked At` field**

Run via the `mcp__d5aec254-622f-48e6-9468-0b36405e9a80__create_field` tool with this payload (baseId from `.vercel/project.json` orgId is unrelated — use Airtable base from `lib/airtable.ts` `AIRTABLE_BASE_ID` env: `appgLT4z009iwAfhs`):

```json
{
  "baseId": "appgLT4z009iwAfhs",
  "tableId": "tbl08y9Be45zNG0OG",
  "field": {
    "name": "Call Booked At",
    "type": "dateTime",
    "description": "Stamped by Cal.com webhook when rancher books Ben's migration call. Part of Migration funnel tracking.",
    "options": {
      "dateFormat": { "name": "iso" },
      "timeFormat": { "name": "24hour" },
      "timeZone": "client"
    }
  }
}
```

Expected: `{ "id": "fld...", "name": "Call Booked At", ... }`

- [ ] **Step 2: Add `Call Completed At` field**

```json
{
  "baseId": "appgLT4z009iwAfhs",
  "tableId": "tbl08y9Be45zNG0OG",
  "field": {
    "name": "Call Completed At",
    "type": "dateTime",
    "description": "Stamped when Ben marks the migration call as done. Part of Migration funnel tracking.",
    "options": {
      "dateFormat": { "name": "iso" },
      "timeFormat": { "name": "24hour" },
      "timeZone": "client"
    }
  }
}
```

- [ ] **Step 3: Add `Connect Active At` field**

```json
{
  "baseId": "appgLT4z009iwAfhs",
  "tableId": "tbl08y9Be45zNG0OG",
  "field": {
    "name": "Connect Active At",
    "type": "dateTime",
    "description": "Stamped by stripe-connect webhook when a previously-legacy rancher's Stripe Connect account becomes active.",
    "options": {
      "dateFormat": { "name": "iso" },
      "timeFormat": { "name": "24hour" },
      "timeZone": "client"
    }
  }
}
```

- [ ] **Step 4: Add `Routing Paused For Migration` checkbox**

```json
{
  "baseId": "appgLT4z009iwAfhs",
  "tableId": "tbl08y9Be45zNG0OG",
  "field": {
    "name": "Routing Paused For Migration",
    "type": "checkbox",
    "description": "True when an upgrade invite is in flight. isRancherOperationalForBuyers() treats this as paused. Flipped back to false by stripe-connect webhook on Pricing Model flip to tier_v2.",
    "options": { "icon": "check", "color": "yellowBright" }
  }
}
```

- [ ] **Step 5: Verify all four fields exist**

Run from project root:

```bash
PAT="<airtable-pat>"; BASE="appgLT4z009iwAfhs"; \
/usr/bin/curl -sS -G "https://api.airtable.com/v0/$BASE/Ranchers" \
  -H "Authorization: Bearer $PAT" \
  --data-urlencode "fields[]=Call Booked At" \
  --data-urlencode "fields[]=Call Completed At" \
  --data-urlencode "fields[]=Connect Active At" \
  --data-urlencode "fields[]=Routing Paused For Migration" \
  --data-urlencode "maxRecords=1" | head -3
```

Expected: HTTP 200 JSON, no `UNKNOWN_FIELD_NAME` error.

- [ ] **Step 6: Commit (schema-only — no repo changes, just stamp the timing)**

```bash
git commit --allow-empty -m "chore(airtable): add Call Booked At / Call Completed At / Connect Active At / Routing Paused For Migration on Ranchers"
```

---

## Task 2: Create `sendSMSToRancher()` helper

**Files:**
- Modify: `lib/twilio.ts` (add new exported function near `sendSMSToConsumer`)

- [ ] **Step 1: Add the helper to `lib/twilio.ts`**

Append this function below the existing `sendSMSToConsumer()` definition (currently at line 82). Mirror the consumer helper's gate-then-delegate pattern.

```typescript
/**
 * Rancher-facing SMS top-half. Mirrors sendSMSToConsumer's gate pattern but
 * targets the Operator Phone field on the Ranchers table. Use this from
 * every cron, admin endpoint, and webhook that sends a rancher SMS — never
 * call sendSMS() directly with a rancher record.
 *
 * Gates:
 *   - No phone on record → log + return false
 *   - rancher['Active Status'] === 'Disabled' → suppression (still SMSes
 *     'Paused' ranchers because pause is operational-only, not a hard stop)
 *   - rancher['SMS Opt-In'] === false (explicit) → suppression
 *
 * Default for Opt-In: ranchers opted in at signup via the wizard checkbox
 * (TCPA). Field is `SMS Opt-In` on the Ranchers table.
 */
export async function sendSMSToRancher(input: {
  rancher: Record<string, any> | null | undefined;
  body: string;
  phone?: string;
  reason?: string;
}): Promise<boolean> {
  const { rancher, body, phone, reason } = input;
  if (!rancher) {
    console.warn('[twilio] sendSMSToRancher: no rancher record', { reason });
    return false;
  }
  const activeStatus = String(rancher['Active Status'] || '').toLowerCase();
  if (activeStatus === 'disabled') {
    console.log('[twilio] gated: rancher Active Status=Disabled', { reason });
    return false;
  }
  if (rancher['SMS Opt-In'] === false) {
    console.log('[twilio] gated: rancher SMS Opt-In=false', { reason });
    return false;
  }
  const to = (phone || rancher['Operator Phone'] || rancher['Phone'] || '')
    .toString()
    .trim();
  if (!to) {
    console.log('[twilio] gated: no rancher phone on record', { reason });
    return false;
  }
  return sendSMS({ to, body });
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors related to `lib/twilio.ts`.

- [ ] **Step 3: Commit**

```bash
git add lib/twilio.ts
git commit -m "feat(twilio): add sendSMSToRancher helper paralleling sendSMSToConsumer"
```

---

## Task 3: Create `sendRancherUpgradeCallInvite` email template

**Files:**
- Create: `lib/email/sendRancherUpgradeCallInvite.ts`
- Modify: `lib/email.ts` (add re-export at top of file)
- Modify: `lib/emailFrequencyGuard.ts` (whitelist the template name)

- [ ] **Step 1: Create the template file**

Create `lib/email/sendRancherUpgradeCallInvite.ts`:

```typescript
// lib/email/sendRancherUpgradeCallInvite.ts
//
// Rancher-facing tier_v2 upgrade invite. Sent by
// /api/admin/ranchers/[id]/send-v2-upgrade (and the /admin/migration bulk
// button). Pitches the shift to platform-collected deposits + Ben taking
// every buyer sales call. Cal.com link is the primary CTA. The 60-day
// wizard JWT link is the fallback for ranchers who'd rather self-serve.
//
// Whitelisted in lib/emailFrequencyGuard.ts so the 3/week rolling cap
// never silently drops it.

import { sendEmail } from '../email';

function esc(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function sendRancherUpgradeCallInvite(args: {
  email: string;
  rancherName: string;
  wizardUrl: string;
  benCalUrl: string;
  deadlineLabel: string; // e.g. "June 20, 2026"
}) {
  const first = (args.rancherName || '').split(' ')[0] || 'there';
  const subject = `${first} — let's get you set up to take deposits direct (15 min w/ Ben)`;
  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px;">
<div style="max-width:600px;margin:0 auto;background:white;padding:40px;border:1px solid #A7A29A;">
  <p style="font-family:Georgia,serif;font-size:24px;margin:0 0 14px;">Hey ${esc(first)} —</p>
  <p>Quick heads-up on a platform change rolling out now. Two things shift for you:</p>

  <p style="font-weight:600;margin-top:24px;">1. Deposits land in your Stripe direct.</p>
  <p>Buyers pay a deposit on BuyHalfCow before they ever talk to you. Stripe Connect routes it straight to your bank — no invoice chasing, no 30-day net. BHC takes its commission off the top.</p>

  <p style="font-weight:600;margin-top:24px;">2. I run every sales call from here.</p>
  <p>Every qualified buyer books a call with me first. I run the qualification (size, timing, storage, commitment), handle deposit logistics, enforce the non-refundable lock once you accept, and step in on any dispute. You only ever talk to buyers who paid + locked.</p>

  <p style="font-weight:600;margin-top:24px;">What stays the same:</p>
  <p>Your fulfillment, your processor, your pricing, your timing. You still set Quarter / Half / Whole prices + deposit amounts + processing fees. Everything you control today, you still control.</p>

  <p style="font-weight:600;margin-top:24px;">Why now:</p>
  <p>Paid ad spend is ramping. More qualified leads coming. The new flow holds up at volume — the old invoice-after-the-fact model doesn't. Locking everyone in before the firehose opens.</p>

  <div style="background:#F4F1EC;border-left:4px solid #0E0E0E;padding:18px 22px;margin:28px 0;">
    <p style="margin:0 0 12px 0;font-family:Georgia,serif;font-size:18px;font-weight:600;">Book 15 minutes with me to walk through it:</p>
    <p style="margin:0 0 6px 0;text-align:center;">
      <a href="${esc(args.benCalUrl)}" style="display:inline-block;padding:14px 28px;background:#0E0E0E;color:#FFFFFF!important;text-decoration:none;font-weight:600;text-transform:uppercase;letter-spacing:1px;font-size:13px;">Book my upgrade call &rarr;</a>
    </p>
    <p style="margin:14px 0 0;font-size:13px;color:#6B4F3F;text-align:center;">Prefer to self-serve? <a href="${esc(args.wizardUrl)}" style="color:#0E0E0E;">Open the 5-min wizard</a>.</p>
  </div>

  <p style="font-size:13px;color:#6B4F3F;">Deadline: <strong>${esc(args.deadlineLabel)}</strong>. After that, new buyers stop routing to your ranch until you've upgraded. Plenty of runway — book the call or open the wizard whenever fits.</p>
  <p style="font-size:13px;color:#6B4F3F;margin-top:16px;">— Benjamin, BuyHalfCow</p>
</div>
</body></html>`;
  return sendEmail({
    to: args.email,
    subject,
    html,
    templateName: 'sendRancherUpgradeCallInvite',
  });
}
```

- [ ] **Step 2: Re-export from `lib/email.ts`**

Add this line near the bottom of `lib/email.ts` (just before EOF) so existing import paths keep working:

```typescript
export { sendRancherUpgradeCallInvite } from './email/sendRancherUpgradeCallInvite';
```

- [ ] **Step 3: Whitelist in `lib/emailFrequencyGuard.ts`**

Open `lib/emailFrequencyGuard.ts`. Find the `TRANSACTIONAL_WHITELIST` set (currently ends with the `sendQualifiedNoActionNudge` + `sendBuyerSlotLocked` entries from earlier commits). Append:

```typescript
  // Rancher-facing tier_v2 upgrade invite (NRD + brokered-call model).
  // 14-day soft cutover; max 1 send per rancher unless operator manually
  // re-fires from /admin/migration. Capping = silent loss of the cutover
  // notice = rancher gets paused with no signal.
  'sendRancherUpgradeCallInvite',
```

(Place inside the existing `TRANSACTIONAL_WHITELIST = new Set([...])`.)

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add lib/email/sendRancherUpgradeCallInvite.ts lib/email.ts lib/emailFrequencyGuard.ts
git commit -m "feat(email): sendRancherUpgradeCallInvite template + whitelist + re-export"
```

---

## Task 4: Honor `Routing Paused For Migration` in `isRancherOperationalForBuyers()`

**Files:**
- Modify: `lib/rancherEligibility.ts` (function `isRancherOperationalForBuyers` at line 73)

- [ ] **Step 1: Open the function**

Current shape (in `lib/rancherEligibility.ts:73-92`):

```typescript
export function isRancherOperationalForBuyers(rancher: RancherFields): boolean {
  const active = readEnumOrString(rancher['Active Status']);
  if (active !== 'Active') return false;

  const onboarding = readEnumOrString(rancher['Onboarding Status']);
  if (onboarding && onboarding !== 'Live') return false;

  if (!rancher['Agreement Signed']) return false;

  const subStatus = String(rancher['Subscription Status'] || '').toLowerCase();
  if (subStatus === 'past_due' || subStatus === 'unpaid' || subStatus === 'canceled') {
    return false;
  }

  return true;
}
```

- [ ] **Step 2: Insert the LOCK check just before `return true`**

Replace the function body with:

```typescript
export function isRancherOperationalForBuyers(rancher: RancherFields): boolean {
  const active = readEnumOrString(rancher['Active Status']);
  if (active !== 'Active') return false;

  const onboarding = readEnumOrString(rancher['Onboarding Status']);
  if (onboarding && onboarding !== 'Live') return false;

  if (!rancher['Agreement Signed']) return false;

  const subStatus = String(rancher['Subscription Status'] || '').toLowerCase();
  if (subStatus === 'past_due' || subStatus === 'unpaid' || subStatus === 'canceled') {
    return false;
  }

  // Migration-pause gate (2026-06-06): when a v2 upgrade invite is in
  // flight, treat the rancher as not-operational so new buyer routing
  // halts. Auto-resumes when stripe-connect webhook flips Pricing Model
  // to tier_v2 (which also clears this flag). Operator can also clear
  // manually from /admin/migration if a rancher pushes back on the
  // upgrade and they want to keep receiving legacy leads.
  if (rancher['Routing Paused For Migration'] === true) {
    return false;
  }

  return true;
}
```

- [ ] **Step 3: Verify the RancherFields type allows the new field**

Find the `RancherFields` type at top of `lib/rancherEligibility.ts`. It's likely an indexed type like `[k: string]: unknown` — if so, no change needed. If it's a strict interface, add:

```typescript
'Routing Paused For Migration'?: boolean;
```

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add lib/rancherEligibility.ts
git commit -m "feat(routing): honor Routing Paused For Migration in isRancherOperationalForBuyers"
```

---

## Task 5: Update `send-v2-upgrade` endpoint to fire SMS + new email + stamp pause flag

**Files:**
- Modify: `app/api/admin/ranchers/[id]/send-v2-upgrade/route.ts`

- [ ] **Step 1: Update imports**

Replace the imports block at the top of the file with:

```typescript
import { NextResponse, NextRequest } from 'next/server';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { sendRancherUpgradeCallInvite } from '@/lib/email';
import { sendSMSToRancher } from '@/lib/twilio';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '@/lib/secrets';
import { requireAdmin } from '@/lib/adminAuth';
```

- [ ] **Step 2: Add the SMS body builder near the top of the file**

Below the `BEN_MIGRATION_CAL_URL` const, add:

```typescript
// 160-char SMS. Twilio segments above 160. Keep it tight.
function buildUpgradeSmsBody(rancherFirstName: string, calUrl: string): string {
  const first = (rancherFirstName || '').split(' ')[0] || 'there';
  // Truncate Cal URL by stripping protocol — Twilio counts it as the same
  // tappable link either way.
  const shortUrl = calUrl.replace(/^https?:\/\//, '');
  // Keep tight: name + reason + link. Aim ~140 chars to leave room for
  // STOP-out boilerplate Twilio appends.
  return `Hi ${first} — Ben @ BuyHalfCow. 15-min call to upgrade you to take deposits direct + I'll handle every sales call from here: ${shortUrl}`;
}
```

- [ ] **Step 3: Replace the email + Telegram block inside the POST handler**

Find the existing block in the POST handler that calls `sendEmail({...})` with inline HTML and a Telegram message. Replace from the start of the rancher lookup through the response with this:

```typescript
    const rancher: any = await getRecordById(TABLES.RANCHERS, id);
    if (!rancher) {
      return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });
    }

    const pricingModel = String(rancher['Pricing Model'] || 'legacy').toLowerCase();
    if (pricingModel === 'tier_v2') {
      return NextResponse.json(
        { error: 'Rancher is already on tier_v2 — nothing to upgrade' },
        { status: 409 },
      );
    }

    const rancherEmail = String(rancher['Email'] || '').trim();
    if (!rancherEmail) {
      return NextResponse.json({ error: 'Rancher has no Email on record' }, { status: 400 });
    }

    const rancherName = String(rancher['Operator Name'] || rancher['Ranch Name'] || 'Rancher');

    // Mint 60-day wizard token. Same shape used elsewhere.
    const wizardToken = jwt.sign(
      { type: 'rancher-wizard', rancherId: id, email: rancherEmail.toLowerCase() },
      JWT_SECRET,
      { expiresIn: '60d' },
    );
    const wizardUrl = `${SITE_URL}/rancher/setup?token=${encodeURIComponent(wizardToken)}`;

    // 14-day soft-cutover deadline for the dashboard countdown banner.
    const deadline = new Date(Date.now() + MIGRATION_DEADLINE_DAYS * 24 * 60 * 60 * 1000);
    const deadlineLabel = deadline.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });

    // Send email + SMS in parallel. Either failing is non-fatal — we still
    // flip Migration Status so the cron picks the rancher up for nudges,
    // and the operator gets a Telegram with the failure mode.
    const [emailResult, smsResult] = await Promise.allSettled([
      sendRancherUpgradeCallInvite({
        email: rancherEmail,
        rancherName,
        wizardUrl,
        benCalUrl: BEN_MIGRATION_CAL_URL,
        deadlineLabel,
      }),
      sendSMSToRancher({
        rancher,
        body: buildUpgradeSmsBody(rancherName, BEN_MIGRATION_CAL_URL),
        reason: 'v2-upgrade-invite',
      }),
    ]);

    const emailOk = emailResult.status === 'fulfilled';
    const smsOk = smsResult.status === 'fulfilled' && smsResult.value === true;

    // Stamp Airtable: invite-sent timestamp, Migration Status, deadline,
    // and the new routing-pause flag. Existing migration-deadline cron
    // (daily 15:00 UTC) handles Day 7/4/2/1 nudges + Day-14 auto-pause
    // of Active Status.
    await updateRecord(TABLES.RANCHERS, id, {
      'V2 Upgrade Invite Sent At': new Date().toISOString(),
      'Migration Status': 'invited',
      'Migration Deadline': deadline.toISOString(),
      'Routing Paused For Migration': true,
    });

    // Single Telegram, both channels rolled up.
    try {
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `📨 <b>V2 UPGRADE INVITE SENT</b>\n\n` +
          `Rancher: ${rancherName}\n` +
          `Email: ${emailOk ? '✅ sent' : '❌ failed'}\n` +
          `SMS:   ${smsOk ? '✅ sent' : '⏭️ skipped/failed'}\n` +
          `Cal:   ${BEN_MIGRATION_CAL_URL}\n` +
          `Wizard: ${wizardUrl}\n\n` +
          `<i>Routing Paused For Migration set true. Deadline: ${deadlineLabel}.</i>`,
      );
    } catch {}

    return NextResponse.json({
      ok: true,
      emailSent: emailOk,
      smsSent: smsOk,
      deadline: deadline.toISOString(),
      wizardUrl,
      calUrl: BEN_MIGRATION_CAL_URL,
    });
```

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add app/api/admin/ranchers/'[id]'/send-v2-upgrade/route.ts
git commit -m "feat(migration): fire SMS + new email template + stamp routing pause on v2 upgrade invite"
```

---

## Task 6: Stamp `Call Booked At` from Cal.com webhook when Ben's migration call is booked

**Files:**
- Modify: `app/api/webhooks/cal/route.ts`

- [ ] **Step 1: Read the existing handler to find the booking-created branch**

Run:

```bash
grep -n "BOOKING_CREATED\|booking.created\|attendee" app/api/webhooks/cal/route.ts | head -10
```

Note the line where the webhook handles a new booking. The handler already parses the payload + does Telegram alerts on existing Cal flows (CONN-5).

- [ ] **Step 2: Add a migration-booking branch**

Inside the booking-created handler, after the existing handling but before `return NextResponse.json(...)`, insert:

```typescript
    // Migration-call detection (2026-06-06): if the booking host slug
    // matches Ben's migration Cal URL, the attendee email belongs to a
    // legacy rancher who just self-scheduled their upgrade walkthrough.
    // Stamp Call Booked At + flip Migration Status='call_scheduled' so
    // the /admin/migration tracker reflects funnel progress and the
    // existing migration-deadline cron skips nudging them mid-week.
    try {
      const hostSlug = (payload?.payload?.organizer?.username || '')
        .toString()
        .toLowerCase();
      const BEN_SLUGS = (process.env.BHC_OPERATOR_CAL_SLUGS || 'ben-beauchman-1itnsg')
        .toLowerCase()
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const isMigrationHost = BEN_SLUGS.includes(hostSlug);
      if (isMigrationHost) {
        const attendees: any[] = payload?.payload?.attendees || [];
        const attendeeEmail = String(attendees[0]?.email || '')
          .toLowerCase()
          .trim();
        if (attendeeEmail) {
          const { getAllRecords, updateRecord, TABLES } = await import('@/lib/airtable');
          const matches = (await getAllRecords(
            TABLES.RANCHERS,
            `LOWER({Email}) = "${attendeeEmail.replace(/"/g, '\\"')}"`,
          )) as any[];
          if (matches.length > 0) {
            await updateRecord(TABLES.RANCHERS, matches[0].id, {
              'Call Booked At': new Date().toISOString(),
              'Migration Status': 'call_scheduled',
            });
            try {
              await sendTelegramMessage(
                TELEGRAM_ADMIN_CHAT_ID,
                `📅 <b>MIGRATION CALL BOOKED</b>\n\nRancher: ${matches[0]['Operator Name'] || attendeeEmail}\nWhen: ${payload?.payload?.startTime || '?'}\n\n<i>Migration Status flipped to call_scheduled. Daily nudge cron will skip until call completes.</i>`,
              );
            } catch {}
          }
        }
      }
    } catch (e: any) {
      console.warn('[cal webhook] migration-booking branch failed:', e?.message);
    }
```

If `sendTelegramMessage` and `TELEGRAM_ADMIN_CHAT_ID` aren't already imported at the top of the file, add:

```typescript
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
```

- [ ] **Step 3: Stamp `Call Completed At` on booking-ended event**

Find the booking-ended/completed branch (or add one if Cal sends `BOOKING_ENDED`). Inside it, mirror the same lookup + write:

```typescript
    if (eventType === 'BOOKING_ENDED' || eventType === 'BOOKING_COMPLETED') {
      try {
        const hostSlug = (payload?.payload?.organizer?.username || '')
          .toString()
          .toLowerCase();
        const BEN_SLUGS = (process.env.BHC_OPERATOR_CAL_SLUGS || 'ben-beauchman-1itnsg')
          .toLowerCase()
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (BEN_SLUGS.includes(hostSlug)) {
          const attendees: any[] = payload?.payload?.attendees || [];
          const attendeeEmail = String(attendees[0]?.email || '').toLowerCase().trim();
          if (attendeeEmail) {
            const { getAllRecords, updateRecord, TABLES } = await import('@/lib/airtable');
            const matches = (await getAllRecords(
              TABLES.RANCHERS,
              `LOWER({Email}) = "${attendeeEmail.replace(/"/g, '\\"')}"`,
            )) as any[];
            if (matches.length > 0) {
              await updateRecord(TABLES.RANCHERS, matches[0].id, {
                'Call Completed At': new Date().toISOString(),
                'Migration Status': 'upgrading',
              });
            }
          }
        }
      } catch (e: any) {
        console.warn('[cal webhook] migration-call-ended branch failed:', e?.message);
      }
    }
```

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add app/api/webhooks/cal/route.ts
git commit -m "feat(cal-webhook): stamp Call Booked At + Call Completed At for Ben's migration calls"
```

---

## Task 7: Stamp `Connect Active At` from stripe-connect webhook + clear pause flag

**Files:**
- Modify: `app/api/webhooks/stripe-connect/route.ts`

- [ ] **Step 1: Find where Pricing Model gets flipped to tier_v2**

Run:

```bash
grep -n "tier_v2\|Pricing Model" app/api/webhooks/stripe-connect/route.ts | head -10
```

Note the line. Per `FIX-P0-3`, this already happens in `syncRancherConnectStatus`.

- [ ] **Step 2: Add `Connect Active At` + clear `Routing Paused For Migration` in the same write**

Find the update payload that sets `'Pricing Model': 'tier_v2'`. Replace that updateRecord call with:

```typescript
        await updateRecord(TABLES.RANCHERS, rancherId, {
          'Pricing Model': 'tier_v2',
          'Migration Status': 'completed',
          // 2026-06-06: stamp the activation moment for the migration
          // funnel tracker. Pairs with Call Booked At / Call Completed At.
          'Connect Active At': new Date().toISOString(),
          // Routing pause flipped at invite-send time — clear it now that
          // the rancher is fully on tier_v2 so new buyer routing resumes
          // automatically. No operator action needed for the happy path.
          'Routing Paused For Migration': false,
        });
```

(Preserve any other fields the existing call sets — adapt this snippet so the additions land alongside the current keys.)

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/api/webhooks/stripe-connect/route.ts
git commit -m "feat(stripe-connect): stamp Connect Active At + clear migration routing pause on tier_v2 flip"
```

---

## Task 8: Surface the three new timestamps in `/api/admin/migration` response

**Files:**
- Modify: `app/api/admin/migration/route.ts`

- [ ] **Step 1: Update the response shape**

Find the per-rancher mapping block (currently sets `migrationStatus`, `migrationDeadline`, etc — around line 50-70). Add three keys:

```typescript
    .map((r: any) => ({
      id: r.id,
      name: r['Operator Name'] || r['Ranch Name'] || 'Unknown',
      email: r['Email'] || '',
      state: r['State'] || '',
      pricingModel: String(r['Pricing Model'] || 'legacy'),
      migrationStatus: String(r['Migration Status'] || 'not_invited'),
      migrationDeadline: r['Migration Deadline'] || null,
      v2InviteSentAt: r['V2 Upgrade Invite Sent At'] || null,
      // 2026-06-06: per-rancher migration funnel timestamps
      callBookedAt: r['Call Booked At'] || null,
      callCompletedAt: r['Call Completed At'] || null,
      connectActiveAt: r['Connect Active At'] || null,
      routingPausedForMigration: r['Routing Paused For Migration'] === true,
    }));
```

(Match exact existing shape — don't drop existing keys.)

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/api/admin/migration/route.ts
git commit -m "feat(admin-migration): surface Call Booked / Completed / Connect Active timestamps"
```

---

## Task 9: Render the funnel columns on `/admin/migration` page

**Files:**
- Modify: `app/admin/migration/page.tsx`

- [ ] **Step 1: Update the `Rancher` interface**

Find the `interface Rancher { ... }` declaration near the top. Add the three timestamp fields + pause flag:

```typescript
interface Rancher {
  id: string;
  name: string;
  email: string;
  state: string;
  pricingModel: string;
  migrationStatus: string;
  migrationDeadline: string | null;
  v2InviteSentAt: string | null;
  callBookedAt: string | null;
  callCompletedAt: string | null;
  connectActiveAt: string | null;
  routingPausedForMigration: boolean;
}
```

- [ ] **Step 2: Add a funnel-progress badge helper**

Below the imports, add:

```typescript
function funnelStep(r: Rancher): { label: string; color: string } {
  if (r.connectActiveAt) return { label: '✅ Active', color: 'bg-green-100 text-green-800' };
  if (r.callCompletedAt) return { label: '🛠 Setting up Connect', color: 'bg-blue-100 text-blue-800' };
  if (r.callBookedAt) return { label: '📅 Call scheduled', color: 'bg-purple-100 text-purple-800' };
  if (r.v2InviteSentAt) return { label: '📨 Invited', color: 'bg-yellow-100 text-yellow-800' };
  return { label: '⏳ Not invited', color: 'bg-gray-100 text-gray-700' };
}
```

- [ ] **Step 3: Render the funnel-step badge + timestamps in the per-rancher table row**

Find the `<tr>` rendering for each rancher (search for `data.ranchers.map`). Inside it, add a new `<td>` for the funnel badge + timestamps. Replace the row template with:

```tsx
{data.ranchers.map((r) => {
  const step = funnelStep(r);
  return (
    <tr key={r.id} className="border-b border-[#A7A29A]">
      <td className="p-2">
        <div className="font-medium">{r.name}</div>
        <div className="text-xs text-[#6B4F3F]">{r.email}</div>
        <div className="text-xs text-[#6B4F3F]">{r.state}</div>
      </td>
      <td className="p-2">
        <span className={`px-2 py-0.5 text-xs ${step.color}`}>{step.label}</span>
        {r.routingPausedForMigration && (
          <span className="ml-2 px-2 py-0.5 text-xs bg-orange-100 text-orange-800" title="New buyer routing halted until tier_v2 flip">
            🛑 routing paused
          </span>
        )}
      </td>
      <td className="p-2 text-xs">
        <div>Invited: {r.v2InviteSentAt ? new Date(r.v2InviteSentAt).toLocaleDateString() : '—'}</div>
        <div>Booked: {r.callBookedAt ? new Date(r.callBookedAt).toLocaleDateString() : '—'}</div>
        <div>Done:   {r.callCompletedAt ? new Date(r.callCompletedAt).toLocaleDateString() : '—'}</div>
        <div>Connect: {r.connectActiveAt ? new Date(r.connectActiveAt).toLocaleDateString() : '—'}</div>
      </td>
      <td className="p-2 text-xs">
        Deadline: {r.migrationDeadline ? new Date(r.migrationDeadline).toLocaleDateString() : '—'}
      </td>
    </tr>
  );
})}
```

Update the surrounding `<thead>` to match the four columns (Rancher / Funnel Step / Timestamps / Deadline).

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add app/admin/migration/page.tsx
git commit -m "feat(admin-migration-ui): per-rancher funnel-step badge + 4-column timestamp table"
```

---

## Task 10: Write the demo storyboard

**Files:**
- Create: `docs/RANCHER-UPGRADE-DEMO-STORYBOARD.md`

- [ ] **Step 1: Create the storyboard doc**

Create `docs/RANCHER-UPGRADE-DEMO-STORYBOARD.md`:

```markdown
# Rancher Upgrade Demo — 90-Second Loom Storyboard

**Audience:** Pilot 5 legacy BuyHalfCow ranchers (Beckie / Joseph+Jamie / Jesse / Katie / Russell) considering the tier_v2 upgrade + $500/mo retainer
**Goal:** Show the full lifecycle of one buyer in the new model so the rancher sees what they get + what changes for them
**Length:** 90 seconds (Loom)
**Recording:** Screen share (browser) + face-on-cam (top-right corner)

---

## Scene 1 — Buyer hits /qualify (0:00–0:15)

**Screen:** `https://www.buyhalfcow.com/qualify/<demo-id>?token=<demo-token>` (use a synthetic-e2e referral)
**Voiceover (~3 sentences):**
> "Here's what happens when a buyer matched to your ranch lands on BuyHalfCow today. They take a 30-second qualifier — size, timing, storage, commitment. If they score below 75 they stay in nurture. Above 75, they reach the next screen."

**Actions:**
- Click through Q1 (Half) → Q2 (Within 30 days) → Q3 (have freezer) → Q4 (ack)
- Hit Submit
- Land on result page

---

## Scene 2 — Ben gets Telegram alert + buyer books call (0:15–0:30)

**Screen:** Split — Telegram (left), `/checkout/<refId>/deposit` page (right)
**Voiceover:**
> "I get a Telegram alert the second a qualified buyer lands. The buyer sees your ranch info, your pricing, your processing date — but the primary CTA is 'Book a 15-min call with Ben.' I take that call. Not you."

**Actions:**
- Show Telegram alert with buyer name + score
- Switch to result page, hover over "Book a 15-min intro with Ben" button

---

## Scene 3 — Buyer deposit + rancher accepts (0:30–0:55)

**Screen:** `/checkout/<refId>/deposit` deposit flow → switch to rancher dashboard
**Voiceover:**
> "After our call, the buyer pays a deposit through Stripe Connect — that lands directly in your bank, not BHC's. BHC takes its commission off the top. You get a Telegram + email the moment the deposit lands. One tap, 'Accept Slot' — that locks the deposit non-refundable per our policy. Now you know the buyer is committed."

**Actions:**
- Show deposit page → simulate paid (or use Stripe test mode)
- Cut to rancher dashboard `/rancher` showing the referral with "🔒 Slot locked" badge
- Click "Accept Slot" button

---

## Scene 4 — Rancher fulfills, sends final invoice (0:55–1:15)

**Screen:** Rancher dashboard with "Send Final Invoice" modal
**Voiceover:**
> "You raise + process the beef on your schedule. When it's ready to deliver, you tap 'Send Final Invoice' here. Enter the total sale + processing fee. The buyer gets an invoice for the balance. They pay through Stripe Connect — that also lands in your bank, same day. BHC commission was already taken at deposit time, so this final invoice is 100% yours."

**Actions:**
- Click "Send Final Invoice"
- Fill modal: Total Sale = $3500, Processing Fee = $400
- Show calculated balance
- Hit Send

---

## Scene 5 — Stripe Connect distribution + recap (1:15–1:30)

**Screen:** Stripe Connect dashboard showing both transactions landed
**Voiceover:**
> "Everything you fulfill, you get paid for — same-day via Stripe Connect. You set your prices, your processing dates, your capacity. I handle every buyer call, every deposit, every refund request. You handle what you're best at: raising the beef. Book your 15-min upgrade call with me at cal.com/[your-slug] and I'll have you switched over in one session."

**Actions:**
- Show Stripe Connect Express dashboard
- Two transactions visible: deposit + final
- End on Cal.com booking link card

---

## Production Notes

- **Use a real test rancher record** — create or reuse the `recYCVL85vofeqXAd` (Beckie Elway) Connect account in Stripe **test mode**. Never use a live rancher.
- **Demo buyer**: synthetic-e2e auto-deletes after run — pick a test buyer with full quiz answers, OR use the LEAK-3 backfill recovery script in dry-run mode.
- **Pause** music/notifications during recording.
- **Caption every CTA** on screen so muted-autoplay viewers still get the message.
- **Upload as unlisted** to Loom first; share via the bulk-invite email once approved.
```

- [ ] **Step 2: Commit**

```bash
git add docs/RANCHER-UPGRADE-DEMO-STORYBOARD.md
git commit -m "docs: 5-scene rancher upgrade demo storyboard (90-sec Loom)"
```

---

## Task 11: Set the `BHC_OPERATOR_CAL_SLUGS` env var on Vercel

**Files:**
- No repo files — Vercel env var only

- [ ] **Step 1: Set the env var via Vercel CLI**

Run (your operator slug — use the same slug your Cal.com profile resolves to; the migration handler in the existing send-v2-upgrade endpoint already uses `ben-beauchman-1itnsg`, so default to that unless changed):

```bash
vercel env add BHC_OPERATOR_CAL_SLUGS production
# When prompted for value: ben-beauchman-1itnsg
# Then add to preview + development too:
vercel env add BHC_OPERATOR_CAL_SLUGS preview
vercel env add BHC_OPERATOR_CAL_SLUGS development
```

Expected: each command prompts for the value, then writes the env var. Re-deploys are required for the new env to take effect (next push triggers it automatically).

- [ ] **Step 2: Verify the var is set**

```bash
vercel env ls | grep BHC_OPERATOR_CAL_SLUGS
```

Expected: three lines (production / preview / development).

- [ ] **Step 3: Commit (allow-empty, just for the timestamp)**

```bash
git commit --allow-empty -m "chore(env): add BHC_OPERATOR_CAL_SLUGS for Cal.com migration-host detection"
```

---

## Task 12: Reset Migration Status baseline on the 5 pilot ranchers

**Files:**
- No repo files — Airtable data heal only

- [ ] **Step 1: Confirm the pilot 5 targets**

Pilot rec ids (locked):
- `recYCVL85vofeqXAd` — Beckie Elway / Foodstead (MT)
- `recawSbn7dhszHQl5` — Joseph & Jamie Hewitson / All Natural Homestead Beef (CO)
- `recsUxUMrEY4fNtp4` — Jesse Gajewski / Renick Valley Meats (WV)
- `recy4vT2788bxLTkD` — Katie Hunter / Silverline Cattle Co (MO)
- `rec2yADvi1fODSrfj` — Russell Gift (OK, multi-state OK/TX/KS/NM/CO)

Sanity-query each (verify each rec exists + is NOT Paused + still on `Pricing Model='legacy'`):

```bash
PAT="<airtable-pat>"; BASE="appgLT4z009iwAfhs"; \
for RID in recYCVL85vofeqXAd recawSbn7dhszHQl5 recsUxUMrEY4fNtp4 recy4vT2788bxLTkD rec2yADvi1fODSrfj; do
  /usr/bin/curl -sS "https://api.airtable.com/v0/$BASE/Ranchers/$RID" \
    -H "Authorization: Bearer $PAT" | \
    python3 -c "import json,sys; r=json.load(sys.stdin); f=r.get('fields',{}); print(f\"{r.get('id','?')} | {f.get('Operator Name','?')} | {f.get('Active Status','?')} | {f.get('Pricing Model','?')} | mig={f.get('Migration Status','?')}\")"
done
```

Expected: 5 records, each `Active Status='Active'`, `Pricing Model='legacy'`. If any are Paused or already tier_v2 — halt and reconcile before proceeding.

- [ ] **Step 2: Reset Migration Status + clear stale invite timestamps on the 5**

```bash
PAT="<airtable-pat>"; BASE="appgLT4z009iwAfhs"; \
for RID in recYCVL85vofeqXAd recawSbn7dhszHQl5 recsUxUMrEY4fNtp4 recy4vT2788bxLTkD rec2yADvi1fODSrfj; do
  /usr/bin/curl -sS -X PATCH "https://api.airtable.com/v0/$BASE/Ranchers/$RID" \
    -H "Authorization: Bearer $PAT" -H "Content-Type: application/json" \
    -d '{"fields":{"Migration Status":"not_invited","V2 Upgrade Invite Sent At":null,"Migration Deadline":null,"Routing Paused For Migration":false}}' | head -1
  echo " reset $RID"
  sleep 0.25
done
```

Expected: 5 `{ "id": "rec...", ... }` responses.

- [ ] **Step 3: Verify baseline**

Re-run the query from Step 1. All 5 should now show `Migration Status='not_invited'` and a blank `V2 Upgrade Invite Sent At`.

- [ ] **Step 4: Commit (allow-empty for audit trail)**

```bash
git commit --allow-empty -m "chore(airtable): reset 5 pilot ranchers (Beckie/Joseph+Jamie/Jesse/Katie/Russell) to Migration Status=not_invited baseline"
```

---

## Task 13: Final typecheck + push + Vercel promote

**Files:**
- All previous task commits get pushed together.

- [ ] **Step 1: Typecheck the full repo**

```bash
npx tsc --noEmit
```

Expected: no errors. If any surface, fix before pushing.

- [ ] **Step 2: Push**

```bash
git push origin main
```

Expected: `main -> main` with the chain of commits from Tasks 1–12.

- [ ] **Step 3: Wait for Vercel build to land READY**

Use the Vercel MCP `list_deployments` tool with `projectId=prj_UiTlxTHcMl277z0QyrAVz82nclVA` + `teamId=team_LtooF0XS8M8oDBUwxphrC1RJ`. Grab the topmost deployment id (it will be `BUILDING`); poll until `state=READY`.

```bash
# Manual fallback (no MCP):
until vercel inspect <dpl-id> 2>&1 | grep -q "● Ready"; do sleep 20; done
```

- [ ] **Step 4: Promote to prod alias**

```bash
vercel promote <dpl-id> --yes
```

Expected: `Success! bhc was promoted to <dpl-url>`

- [ ] **Step 5: Verify prod SHA**

```bash
/usr/bin/curl -s https://www.buyhalfcow.com/api/version | grep -oE '"shortSha":"[^"]+"'
```

Expected: matches the SHA of the head commit (`git rev-parse --short HEAD`).

- [ ] **Step 6: Smoke `/admin/migration`**

Open `https://www.buyhalfcow.com/admin/migration` in a logged-in admin browser session. Filter / spot-check the 5 pilot rec ids: all should show `⏳ Not invited`, no `🛑 routing paused` flag yet. (The 9 non-pilot legacy ranchers will also appear on the page — DO NOT touch their rows; leave them alone until pilot proves out.)

---

## Task 14: Operator bulk-fire invites + monitor funnel

**Files:**
- No repo files — operator action.

- [ ] **Step 1: Confirm the demo Loom is recorded + shared**

The storyboard exists at `docs/RANCHER-UPGRADE-DEMO-STORYBOARD.md`. Record it. Upload to Loom (unlisted). Edit the `sendRancherUpgradeCallInvite` email template at `lib/email/sendRancherUpgradeCallInvite.ts` and add the Loom URL inline (just under the "Book my upgrade call" CTA) before the bulk send. Re-typecheck + re-deploy if you edit.

```diff
   <div style="background:#F4F1EC;border-left:4px solid #0E0E0E;padding:18px 22px;margin:28px 0;">
     <p style="margin:0 0 12px 0;font-family:Georgia,serif;font-size:18px;font-weight:600;">Book 15 minutes with me to walk through it:</p>
     <p style="margin:0 0 6px 0;text-align:center;">
       <a href="${esc(args.benCalUrl)}" style="display:inline-block;padding:14px 28px;background:#0E0E0E;color:#FFFFFF!important;text-decoration:none;font-weight:600;text-transform:uppercase;letter-spacing:1px;font-size:13px;">Book my upgrade call &rarr;</a>
     </p>
+    <p style="margin:14px 0 0;text-align:center;font-size:13px;"><a href="<LOOM-URL>" style="color:#0E0E0E;">▶ 90-sec demo: how the new flow works</a></p>
     <p style="margin:14px 0 0;font-size:13px;color:#6B4F3F;text-align:center;">Prefer to self-serve? <a href="${esc(args.wizardUrl)}" style="color:#0E0E0E;">Open the 5-min wizard</a>.</p>
   </div>
```

- [ ] **Step 2: Fire pilot invites — ONE PER ROW, NOT BULK**

**Critical:** the existing Bulk Invite button fires for ALL Not-Invited rows on the page. For the pilot, we want ONLY the 5 — so DO NOT use bulk. Instead, on `https://www.buyhalfcow.com/admin/migration`, click the per-row `📨 Send invite` button for each of these 5 (in order, watching Telegram between clicks):

1. Beckie Elway (`recYCVL85vofeqXAd`)
2. Joseph & Jamie Hewitson (`recawSbn7dhszHQl5`)
3. Jesse Gajewski / Renick Valley (`recsUxUMrEY4fNtp4`)
4. Katie Hunter (`recy4vT2788bxLTkD`)
5. Russell Gift (`rec2yADvi1fODSrfj`)

Watch the operator-facing Telegram for exactly 5 `📨 V2 UPGRADE INVITE SENT` alerts — one per click. If you see a 6th, you accidentally invited a non-pilot rancher — revert immediately via Airtable PATCH (Migration Status → `not_invited`, clear `V2 Upgrade Invite Sent At` + `Routing Paused For Migration`).

Expected per pilot rancher:
- Email arrives in their inbox (verify via Resend dashboard or log)
- SMS arrives on their Operator Phone (verify via Twilio log)
- Airtable: Migration Status flips to `invited`, V2 Upgrade Invite Sent At stamped, Migration Deadline = +14d, Routing Paused For Migration = true
- /admin/migration row updates to `📨 Invited` + `🛑 routing paused`

- [ ] **Step 3: Watch the funnel for first booking**

Refresh `/admin/migration` over the next 24h. When the first rancher books the call, their row should flip to `📅 Call scheduled` + show the `Call Booked At` date. If no bookings within 48h, send a manual nudge via the existing migration-deadline cron (Day 7/4/2/1) — already running.

- [ ] **Step 4: Operator unblock path for ranchers who push back**

If any rancher emails/replies saying "I don't want to upgrade yet, but please don't pause my leads" — flip their `Routing Paused For Migration` back to false manually via the Airtable UI. Routing resumes immediately. Document the decision on the rancher's record.

- [ ] **Step 5: Verify post-upgrade auto-resume**

When the first rancher completes Stripe Connect onboarding:
- stripe-connect webhook fires → `Pricing Model` flips to `tier_v2`, `Connect Active At` stamped, `Routing Paused For Migration` cleared
- Their /admin/migration row shows `✅ Active`
- New buyer routing resumes automatically — verify by checking the next batch-approve cron run (15:00 UTC) finds them eligible again

- [ ] **Step 6: Wrap-up commit (allow-empty for audit)**

```bash
git commit --allow-empty -m "chore(ops): pilot v2-upgrade invites sent to 5 ranchers (Beckie/Joseph+Jamie/Jesse/Katie/Russell) + $500/mo retainer"
```

---

## Self-Review Checklist (done before handoff)

- **Spec coverage**:
  - ✅ Migration Status baseline → Task 12
  - ✅ SMS + Email outreach copy → Tasks 2, 3, 5
  - ✅ Video demo storyboard → Task 10
  - ✅ Send sequence (bulk-fire + Telegram) → Task 5, 14
  - ✅ Track + measure (Call Booked / Completed / Connect Active timestamps + UI surface) → Tasks 1, 6, 7, 8, 9
  - ✅ Post-invite routing pause → Tasks 1 (schema), 4 (eligibility), 5 (set on send), 7 (clear on tier_v2 flip)
- **Placeholder scan**: no TBD/TODO/"add appropriate error handling" — every step shows code or commands.
- **Type consistency**: `Routing Paused For Migration` boolean, `Call Booked At` / `Call Completed At` / `Connect Active At` dateTime — consistent across schema, response shape (Task 8), UI interface (Task 9), and write sites (Tasks 5, 6, 7).
- **Env var name**: `BHC_OPERATOR_CAL_SLUGS` (plural — comma-separated list to support multiple Cal hosts later) used consistently in Tasks 6 + 11.
- **One target tableId**: `tbl08y9Be45zNG0OG` (Ranchers) used in every Airtable mutation.
- **Cron compatibility**: existing migration-deadline cron (Day 7/4/2/1 nudges + Day-14 auto-pause) keeps working — no schedule changes. The new `Migration Status='call_scheduled'` state is intentionally NOT in the cron's nudge filter (verify in `app/api/cron/migration-deadline/route.ts` if making any further changes).
