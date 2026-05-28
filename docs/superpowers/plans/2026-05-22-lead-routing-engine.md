# Lead Routing Engine — 1533-Buyer Reactivation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop letting 1533 buyers sit in `WAITING`/`READY` stages indefinitely. Route every buyer to one of five outcomes: matched-now, nudged-to-engage, recruited-as-Founder, recruited-as-affiliate, or honestly-disqualified. No buyer goes silent.

**Architecture:** A nightly classifier cron writes a `Routing Segment` field on every Consumer based on (a) state + rancher availability, (b) intent signals, (c) budget posture, (d) prior engagement. The existing `email-sequences` cron reads that segment and sends segment-specific copy. Telegram `/routingstatus` command surfaces the funnel in real time.

**Tech Stack:** Next.js 16 cron routes · Airtable (existing) · Resend (existing) · Telegram bot (existing). No new infra.

---

## Current State (snapshot 2026-05-22)

**Ranchers — 16 active, 17 states routed:**

| State | Coverage | Slots Open |
|---|---|---|
| TX | Ashcraft (68) + Matula (over) + Gift | **68+** |
| CA | 5 Bar Beef | **36** |
| TN | ZK (33) + 2M | **33+** |
| NC | JC's | **15** |
| CO | High Lonesome (19) + Champion + Gift + Homestead (over) | **19+** |
| OR | DD Ranch | **11** |
| ME | Rocky Ridge | **5** |
| OK | Gift (3) + Rafter (cap) | **3** |
| NE | Champion Valley | many |
| KS | Champion + Gift | shared |
| NM | Gift | shared |
| ID, WA, MT | Foodstead (5) | **5 across 3** |
| WY | All Natural Homestead (over) | 0 |
| WV | Renick Valley | many |
| MO | Silverline | many |

**Buyers — 1533 total:**

| Stage | Count | What it means |
|---|---|---|
| WAITING | 734 | Approved, no rancher in state, waiting on supply |
| READY | 550 | Approved + rancher exists in state, never clicked YES |
| MATCHED | 150 | Has live referral |
| CLOSED | 33 | Terminal (purchased OR ghosted) |
| NO_STAGE | 66 | Legacy, needs backfill |

**Intent crosscut:**
- 178 buyers w/ `Ready to Buy` checked
- 173 w/ `Warmup Engaged At` set
- 88 of those R2B already in MATCHED stage ✅
- **74 R2B stuck in WAITING** ⚠️ — should be routing but aren't (likely state w/ no rancher)
- 11 R2B in READY ⚠️ — clicked YES but didn't get an intro
- 0 founder tier set across whole list (Founding 100 untouched)

**Top uncovered buyer states (no rancher routing):**

| State | Buyers | Lever |
|---|---|---|
| FL | 81 | recruit FL rancher · Founder pitch · land-deals |
| AZ | 65 | recruit AZ rancher · Founder pitch |
| GA | 41 | recruit GA · Founder |
| VA | 41 | recruit VA · Founder |
| OH | 39 | recruit OH · Founder |
| IL | 37 | recruit IL · Founder |
| PA | 32 | recruit PA · Founder |
| IN | 31 | recruit IN · Founder |
| MI | 30 | recruit MI · Founder |
| SC | 27 | recruit SC · Founder |
| UT | 27 | recruit UT · Founder |
| AL | 26 | recruit AL · Founder |
| NV | 26 | recruit NV · Founder |
| MN | 25 | recruit MN · Founder |
| NJ | 25 | recruit NJ · Founder |
| NY | 22 | recruit NY · Founder |
| MA | 21 | recruit MA · Founder |
| **TOTAL uncovered** | **~700 buyers** | |

**`batch-approve` skip reasons (1124/day blocked):**
- 412 "order type unsure" — AI classifier too strict
- 283 "no explicit consent click yet" — got warmup, never clicked
- 182 "no order type" — form variant missed it
- 94 "budget unsure"
- 59 "no budget"
- 52 "just exploring"
- 24 "not a beef buyer"
- 18 "unsubscribed"

---

## File Structure

```
lib/
  routingSegment.ts          ← NEW: classifier function + segment enum
app/api/
  cron/
    reclassify-buyers/route.ts  ← NEW: nightly cron, writes Routing Segment
    state-recruit-nudge/route.ts ← NEW: weekly cron for uncovered states
  webhooks/telegram/route.ts    ← MODIFY: /routingstatus command
lib/email.ts                   ← MODIFY: 4 new templates (segment-specific)
app/api/cron/email-sequences/route.ts ← MODIFY: branch on Routing Segment
vercel.json                    ← MODIFY: add 2 crons
```

Airtable schema (1 new field on Consumers):
- `Routing Segment` (singleSelect): `MATCH_NOW` · `NUDGE_TO_ENGAGE` · `OUT_OF_STATE_FOUNDER_PITCH` · `OUT_OF_STATE_BRAND_PITCH` · `NO_BEEF_BUDGET_BRAND` · `INCOMPLETE_PROFILE` · `UNQUALIFIED_NURTURE` · `TERMINAL`

---

## The Six Segments + Their Plays

### Segment A — `MATCH_NOW` (~85 buyers immediately, target ~250)

**Who:** R2B=true OR Warmup Engaged + rancher with capacity in their state + Order Type set.

**Why stuck:** Already-in-MATCHED group is fine (88 buyers). The 74 R2B-but-WAITING + 11 R2B-but-READY = **85 buyers who clicked YES but never got an intro**. That's revenue on the floor.

**Play:** Reclassify-cron forces them into `matching/suggest` pipeline. If state has rancher → stage Pending Approval → Telegram alert → you tap approve. If state empty → bump to Segment C.

### Segment B — `NUDGE_TO_ENGAGE` (~550 buyers in READY)

**Who:** Buyer Stage = READY (approved + has rancher in state) + Warmup Engaged At is null.

**Why stuck:** Got the warmup email, didn't click. Either email landed in spam, or buyer is passive.

**Play:** Single re-warmup email at Day 7 of being in READY. Sharper subject + social proof from `/wins` + Q/H/W inline buttons. Max 2 nudges/buyer (use existing `Re-Warm Attempts` field). Caps at 50/day to protect deliverability.

### Segment C — `OUT_OF_STATE_FOUNDER_PITCH` (~500 buyers, FL/AZ/GA/etc.)

**Who:** Buyer in uncovered state (FL, AZ, GA, VA, OH, IL, PA, IN, MI, SC, UT, AL, NV, MN, NJ, NY, MA, WI) + signed up with beef intent + budget ≥ Quarter price.

**Why stuck:** No rancher in their state. They could wait months for supply.

**Play:** Honest pitch — "we don't have a rancher in FL yet. Two options: (1) get on the founder list, we'll scout your state first, $100 deposit holds your spot + numbered patch. (2) sit on the waitlist." Drives Founding Herd revenue while we recruit.

### Segment D — `OUT_OF_STATE_BRAND_PITCH` (~200 buyers)

**Who:** Uncovered state + budget signals weak OR Order Type unsure.

**Why stuck:** Same as C but lower-intent. Don't push a $1k Founder pitch.

**Play:** Brand partner offer. Cooler / knife / supplement brands we'd want to feature offer discount codes. Buyer gets a deal on regen-aligned goods, BHC earns brand-partner commission, brand gets distribution. Lower-friction monetization.

### Segment E — `INCOMPLETE_PROFILE` (~335 buyers)

**Who:** Missing Order Type OR Budget OR both. Could be in any state.

**Why stuck:** Form variant didn't ask, or buyer skipped.

**Play:** One-tap profile-completion email. Q / H / W buttons + budget range buttons. Set Buyer Stage based on response. Max 1 send/buyer.

### Segment F — `UNQUALIFIED_NURTURE` (~150 buyers)

**Who:** "Just exploring" + "Not a beef buyer" + unsubscribed + closed.

**Play:** Monthly founder letter only. No CTAs. Build community.

---

## Tasks

### Task 1: Airtable schema — add Routing Segment field

**Files:**
- Airtable Consumers table (via MCP)

- [ ] **Step 1: Add singleSelect field via MCP**

```
field name: Routing Segment
type: singleSelect
choices: MATCH_NOW, NUDGE_TO_ENGAGE, OUT_OF_STATE_FOUNDER_PITCH, OUT_OF_STATE_BRAND_PITCH, INCOMPLETE_PROFILE, UNQUALIFIED_NURTURE, TERMINAL
description: Set nightly by reclassify-buyers cron. Drives email-sequences branching.
```

Use `mcp__d5aec254-622f-48e6-9468-0b36405e9a80__create_field` against base `appgLT4z009iwAfhs` table `tblAbjQDnLrOtjpoE`.

- [ ] **Step 2: Verify by listing schema**

Confirm field appears.

- [ ] **Step 3: Commit**

```
chore(airtable): add Consumers.Routing Segment via MCP — schema-only
```

---

### Task 2: lib/routingSegment.ts — classifier function

**Files:**
- Create: `lib/routingSegment.ts`
- Test: `lib/__tests__/routingSegment.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { classifyBuyer } from '../routingSegment';

describe('classifyBuyer', () => {
  const ranchers = [
    { State: 'TX', 'Routing States': 'TX', 'Active Status': 'Active', 'Current Active Referrals': 30, 'Max Active Referalls': 100 },
    { State: 'CO', 'Routing States': 'CO', 'Active Status': 'Active', 'Current Active Referrals': 1, 'Max Active Referalls': 20 },
  ];

  it('returns MATCH_NOW for R2B buyer in covered state', () => {
    const buyer = { State: 'TX', 'Ready to Buy': true, 'Order Type': 'Half', 'Budget': '$1000-$2000' };
    expect(classifyBuyer(buyer, ranchers)).toBe('MATCH_NOW');
  });

  it('returns NUDGE_TO_ENGAGE for unengaged buyer in covered state', () => {
    const buyer = { State: 'TX', 'Order Type': 'Half', 'Budget': '$1000-$2000', 'Buyer Stage': 'READY' };
    expect(classifyBuyer(buyer, ranchers)).toBe('NUDGE_TO_ENGAGE');
  });

  it('returns OUT_OF_STATE_FOUNDER_PITCH for high-intent uncovered-state buyer', () => {
    const buyer = { State: 'FL', 'Order Type': 'Whole', 'Budget': '$2000+' };
    expect(classifyBuyer(buyer, ranchers)).toBe('OUT_OF_STATE_FOUNDER_PITCH');
  });

  it('returns INCOMPLETE_PROFILE when no order type', () => {
    const buyer = { State: 'TX', 'Order Type': '', 'Budget': '$1000-$2000' };
    expect(classifyBuyer(buyer, ranchers)).toBe('INCOMPLETE_PROFILE');
  });

  it('returns UNQUALIFIED_NURTURE when unsubscribed', () => {
    const buyer = { State: 'TX', Unsubscribed: true };
    expect(classifyBuyer(buyer, ranchers)).toBe('UNQUALIFIED_NURTURE');
  });

  it('returns TERMINAL for closed buyers', () => {
    const buyer = { 'Buyer Stage': 'CLOSED' };
    expect(classifyBuyer(buyer, ranchers)).toBe('TERMINAL');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npx jest lib/__tests__/routingSegment.test.ts
```
Expected: all 6 fail with module-not-found.

- [ ] **Step 3: Write implementation**

```typescript
// lib/routingSegment.ts
import { isRancherOperationalForBuyers, getOperationalServedStates } from './rancherEligibility';

export type RoutingSegment =
  | 'MATCH_NOW'
  | 'NUDGE_TO_ENGAGE'
  | 'OUT_OF_STATE_FOUNDER_PITCH'
  | 'OUT_OF_STATE_BRAND_PITCH'
  | 'INCOMPLETE_PROFILE'
  | 'UNQUALIFIED_NURTURE'
  | 'TERMINAL';

const COVERED_STATES_CACHE = { ts: 0, set: new Set<string>() };

function getCoveredStates(ranchers: any[]): Set<string> {
  const set = new Set<string>();
  for (const r of ranchers) {
    if (!isRancherOperationalForBuyers(r)) continue;
    if ((r['Current Active Referrals'] || 0) >= (r['Max Active Referalls'] || 0)) continue;
    for (const s of getOperationalServedStates(r)) set.add(s);
  }
  return set;
}

export function classifyBuyer(buyer: any, ranchers: any[]): RoutingSegment {
  if (buyer['Buyer Stage'] === 'CLOSED') return 'TERMINAL';
  if (buyer['Unsubscribed']) return 'UNQUALIFIED_NURTURE';
  if (buyer['Buyer Health'] === 'Non-Responsive') return 'UNQUALIFIED_NURTURE';

  const state = (buyer['State'] || '').toUpperCase().slice(0, 2);
  const orderType = buyer['Order Type'];
  const budget = buyer['Budget'];
  const readyToBuy = !!buyer['Ready to Buy'];
  const engaged = !!buyer['Warmup Engaged At'];

  if (!orderType || !budget) return 'INCOMPLETE_PROFILE';

  const covered = getCoveredStates(ranchers);
  const inCoveredState = state && covered.has(state);

  if (inCoveredState && (readyToBuy || engaged)) return 'MATCH_NOW';
  if (inCoveredState) return 'NUDGE_TO_ENGAGE';

  // Uncovered state — branch on intent strength
  const highIntent = readyToBuy || engaged || /\$1[0-9]{3}|\$2[0-9]{3}|\$[5-9][0-9]{3}/.test(String(budget));
  return highIntent ? 'OUT_OF_STATE_FOUNDER_PITCH' : 'OUT_OF_STATE_BRAND_PITCH';
}
```

- [ ] **Step 4: Run tests until green**

```bash
npx jest lib/__tests__/routingSegment.test.ts
```
Expected: 6 pass.

- [ ] **Step 5: Commit**

```
feat(routing): buyer classifier — 7-segment routing function

Maps every Consumer to a single segment based on state, rancher
availability, intent signals, profile completeness. Drives the
email-sequences cron via new Consumers.Routing Segment field.
```

---

### Task 3: Cron — reclassify-buyers (nightly)

**Files:**
- Create: `app/api/cron/reclassify-buyers/route.ts`
- Modify: `vercel.json` (add cron schedule)

- [ ] **Step 1: Write cron route**

```typescript
import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { classifyBuyer } from '@/lib/routingSegment';
import { withCronRun } from '@/lib/cronRun';

export const maxDuration = 300;

export async function GET(request: Request) {
  return withCronRun({
    name: 'reclassify-buyers',
    request,
    requireCronSecret: true,
    body: async (ctx) => {
      const [consumers, ranchers] = await Promise.all([
        getAllRecords(TABLES.CONSUMERS) as Promise<any[]>,
        getAllRecords(TABLES.RANCHERS) as Promise<any[]>,
      ]);

      const counts: Record<string, number> = {};
      const updates: Array<{ id: string; segment: string }> = [];

      for (const buyer of consumers) {
        const segment = classifyBuyer(buyer, ranchers);
        counts[segment] = (counts[segment] || 0) + 1;
        if (buyer['Routing Segment'] !== segment) {
          updates.push({ id: buyer.id, segment });
        }
      }

      let updated = 0;
      for (const u of updates) {
        try {
          await updateRecord(TABLES.CONSUMERS, u.id, { 'Routing Segment': u.segment });
          updated++;
        } catch (e: any) {
          console.warn(`reclassify failed for ${u.id}:`, e?.message);
        }
      }

      ctx.recordsTouched = updated;
      ctx.notes = `total=${consumers.length} updated=${updated} ` +
        Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ');
      return { ok: true, counts, updated };
    },
  });
}
```

- [ ] **Step 2: Add to vercel.json**

```json
{
  "path": "/api/cron/reclassify-buyers",
  "schedule": "0 4 * * *"
}
```
4am UTC = 10pm MT — runs after every other email cron has finished its day, so tomorrow morning starts with fresh segments.

- [ ] **Step 3: Manually trigger first run + verify**

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://www.buyhalfcow.com/api/cron/reclassify-buyers
```

Check Cron Runs table — confirm `total=1533 updated=N MATCH_NOW=X NUDGE_TO_ENGAGE=Y OUT_OF_STATE_FOUNDER_PITCH=Z ...`

- [ ] **Step 4: Commit**

```
feat(cron): reclassify-buyers — nightly routing segment writer

Reads all Consumers + all Ranchers, classifies each buyer into one of
7 routing segments, persists to new Routing Segment field. Drives
downstream email-sequences branching. Runs at 04:00 UTC (10pm MT).
```

---

### Task 4: Email templates — 4 new + 1 modified

**Files:**
- Modify: `lib/email.ts` (add 4 templates)

- [ ] **Step 1: Add sendMatchNowRescue**

For Segment A buyers — 85 R2B-but-not-matched buyers. Subject: "your rancher is waiting." Body: "you clicked YES — here's [ranch], they have capacity for you this season. Reply if you're in."

- [ ] **Step 2: Add sendNudgeToEngage**

For Segment B (550 READY-no-click). Subject: "[rancher state] beef for [your family size]." Body: rancher photo + 3-bullet pitch + Q/H/W buttons inline.

- [ ] **Step 3: Add sendOutOfStateFounderPitch**

For Segment C (~500 high-intent uncovered). Subject: "we don't have a rancher in [state] yet — but we will." Body: honest framing + Founding 100 pitch ($100-$1000 tiers) + waitlist option.

- [ ] **Step 4: Add sendOutOfStateBrandPitch**

For Segment D (~200 low-intent uncovered). Subject: "while you wait — gear from ranchers we trust." Body: featured brand partner discount + newsletter signup.

- [ ] **Step 5: Add sendIncompleteProfile**

For Segment E (~335). Subject: "two questions, one click." Body: Q/H/W + budget range buttons. Sets Buyer Stage on response.

- [ ] **Step 6: Commit**

```
feat(email): 5 routing-segment-specific templates

Each segment from the new routing engine gets one email template.
Headers, body, and CTAs are tuned per JTBD per segment.
```

---

### Task 5: email-sequences cron — branch on Routing Segment

**Files:**
- Modify: `app/api/cron/email-sequences/route.ts`

- [ ] **Step 1: Add segment-routing block before existing stage logic**

After the buyer is loaded, but before existing stage-based send, switch on `buyer['Routing Segment']`:
- `MATCH_NOW` → if no active referral exists, stage Pending Approval w/ best rancher + sendMatchNowRescue (max 1)
- `NUDGE_TO_ENGAGE` → sendNudgeToEngage at day 7 of READY (max 2, throttle 14d)
- `OUT_OF_STATE_FOUNDER_PITCH` → sendOutOfStateFounderPitch (max 1, then drop to monthly nurture)
- `OUT_OF_STATE_BRAND_PITCH` → sendOutOfStateBrandPitch (max 1, then monthly nurture)
- `INCOMPLETE_PROFILE` → sendIncompleteProfile (max 1)
- `UNQUALIFIED_NURTURE` → monthly founder letter only
- `TERMINAL` → skip

Use existing per-stage idempotency markers (e.g. `Routing Segment Email Sent At`).

- [ ] **Step 2: Add new Airtable field `Routing Segment Email Sent At` (dateTime) on Consumers**

Idempotency for these new emails. Don't bury existing per-stage markers.

- [ ] **Step 3: Run cron locally against staging or limit to 5 buyers**

Smoke test before opening the floodgates.

- [ ] **Step 4: Commit**

```
feat(cron): email-sequences branches on Routing Segment

Adds segment-specific email branch before existing Buyer Stage logic.
Idempotency via new Routing Segment Email Sent At field. Throttles per
segment per docs/superpowers/plans/2026-05-22-lead-routing-engine.md.
```

---

### Task 6: Telegram /routingstatus command

**Files:**
- Modify: `app/api/webhooks/telegram/route.ts`

- [ ] **Step 1: Add command handler**

```typescript
if (text === '/routingstatus') {
  const consumers = await getAllRecords(TABLES.CONSUMERS) as any[];
  const counts: Record<string, number> = {};
  for (const c of consumers) {
    const s = c['Routing Segment'] || 'UNCLASSIFIED';
    counts[s] = (counts[s] || 0) + 1;
  }
  const total = consumers.length;
  const msg = `📊 Routing Status (${total} buyers)\n\n` +
    Object.entries(counts).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}: ${v} (${Math.round(v / total * 100)}%)`).join('\n');
  await sendTelegramReply(chatId, msg);
  return;
}
```

- [ ] **Step 2: Manual test from Telegram**

Send `/routingstatus` → confirm response.

- [ ] **Step 3: Commit**

```
feat(telegram): /routingstatus shows buyer segment breakdown
```

---

### Task 7: state-recruit-nudge — uncovered state recruiter

**Files:**
- Create: `app/api/cron/state-recruit-nudge/route.ts`

- [ ] **Step 1: Write cron**

Once per week (Fri 9am MT), for each uncovered state w/ >20 buyers, send a Telegram alert to Ben: "FL has 81 buyers waiting. Cold-outreach to 5 FL ranchers this week?" Include CSV of suggested rancher names scraped from existing rancher-discovery cron output (or just nudge).

This isn't an automated outreach — it's a recruiter prompt for Ben.

- [ ] **Step 2: Add to vercel.json**

```json
{ "path": "/api/cron/state-recruit-nudge", "schedule": "0 15 * * 5" }
```

- [ ] **Step 3: Commit**

```
feat(cron): state-recruit-nudge weekly prompt for uncovered states
```

---

### Task 8: Loosen "order type unsure" classifier threshold

**Files:**
- Modify: `lib/qualification.ts` (or wherever Intent Classification gets set)

- [ ] **Step 1: Find threshold logic**

Grep for `order type unsure` skip reason. Likely in `isQualifiedForRancherMatch` or similar.

- [ ] **Step 2: Lower confidence threshold**

If AI confidence ≥ 0.4 AND any plausible Order Type match → set to most-likely. Don't drop to "unsure" unless confidence < 0.4 AND no signal at all. Backfill `Notes` field with `[auto-classified as Half — verify if you want different]`.

- [ ] **Step 3: Backfill existing 412 stuck buyers**

One-shot script: for each Consumer w/ Intent Classification = "order type unsure", re-run classifier w/ loosened threshold. Update Order Type. They'll get picked up by reclassify-buyers next run.

- [ ] **Step 4: Commit**

```
fix(qualification): loosen order-type confidence threshold

Was filtering 412 buyers as "order type unsure" — too strict. Now
defaults to most-likely match when confidence ≥ 0.4; flags Notes for
manual verification. Backfill script regenerates Order Type for the
412 stuck buyers in one pass.
```

---

## Rollout Order

```
Task 1 (schema) → Task 2 (classifier) → Task 3 (cron) → manually trigger Task 3 →
Task 6 (telegram /routingstatus, gives visibility) → Task 4 (email templates) →
Task 5 (email-sequences branching) → Task 8 (loosen threshold + backfill) → Task 7 (recruit nudge)
```

Ship Tasks 1–6 in one PR. Tasks 7–8 separately so backfill blast doesn't tangle with deployment.

---

## Verification

After rollout, the day-1 `/routingstatus` should show:

```
MATCH_NOW: ~85
NUDGE_TO_ENGAGE: ~550
OUT_OF_STATE_FOUNDER_PITCH: ~500
OUT_OF_STATE_BRAND_PITCH: ~200
INCOMPLETE_PROFILE: ~335 (drops as profile-completion replies land)
UNQUALIFIED_NURTURE: ~150
TERMINAL: ~33
```

Day-7 success criteria:
- MATCH_NOW segment drops to <20 (most have been intro'd or moved to MATCHED)
- 30+ NUDGE_TO_ENGAGE buyers convert to MATCHED via re-warmup
- 10+ OUT_OF_STATE_FOUNDER_PITCH buyers click Founding Herd CTA
- Closed Won jumps from ~5-10/month → 25+/month per marketing plan target

Day-30 success criteria:
- All 1533 buyers in a known segment (zero UNCLASSIFIED)
- Founding Herd backers up by 25 from out-of-state pitch
- 5+ new rancher recruits from uncovered-state nudge
- Closed Won momentum sustained

---

## Inversion — what kills this plan

1. **Treating all buyers as one funnel.** They're not. Without segment routing, 700 uncovered-state buyers will sit in WAITING forever while we burn $$ on Meta ads for more.
2. **Over-emailing.** Per-segment caps must hold. One re-warmup email is signal; three is spam.
3. **Pushing Founder pitch at low-intent buyers.** Segment D exists for a reason. Don't $1000-tier a buyer with no Order Type set.
4. **Skipping Task 6.** Without `/routingstatus`, you can't see the funnel work. Visibility = retention of the plan.
5. **Loosening Task 8 too aggressively.** If we default everyone to "Half" we'll get false matches + lost trust. Threshold 0.4 is the floor.

---

## North Star

When the platform has a verified rancher in every state with >20 buyers, the OUT_OF_STATE segments collapse to zero. Until then, this engine is how 1533 buyers convert into either closed deals, Founder backers, or honest no-thanks. No buyer goes silent.
