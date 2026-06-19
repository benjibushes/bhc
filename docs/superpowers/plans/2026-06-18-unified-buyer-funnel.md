# Unified Game-Like Buyer Funnel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Spec: `docs/superpowers/specs/2026-06-18-unified-buyer-funnel-design.md`. Visual spec: the approved v2 mockup `gamified_buyer_quiz_flow_v2_onbrand`.

**Goal:** Replace the `/access` form + `/qualify` quiz with ONE game-like wizard that is the single front door for every beef buyer, captures contact mid-flow (lead created at step 3, qualified only on completion), and deletes the two junk-lead generators.

**Architecture:** A client wizard (`BuyerFunnel`) drives 5 steps with two entry modes (fresh → step 1; resume-from-drip → step 4). Lead is created at the contact step via `POST /api/consumers` (Approved, not Qualified); completion finalizes via `POST /api/qualify` (writes `Qualified At`, fires matching). Everything — copy, step order, the reveal CTA — is driven from one `funnelConfig` object + runtime operator-config so future changes are config edits. Phone required. `/access` sealed via `ChromeGate`.

**Tech Stack:** Next.js 16 App Router (client components), Tailwind, Airtable (`lib/airtable.ts`), existing helpers (`isQualifiedForRouting`, `getOperationalServedStates`, `getOperatorBookingUrl`, `lib/adminConfig.ts`, `CalInlineBooker`), JWT (`qualify-access`).

**Verification baseline:** in-state flow-completion was 4.8%. After ship, watch it climb. All work via merge-to-main PRs (per repo convention). tsc + `next build` clean + browser E2E before each merge.

---

## File structure

**Create:**
- `lib/funnelConfig.ts` — single source of step order, copy, reveal-CTA mode, social-proof source.
- `app/api/funnel/stats/route.ts` — cached live counts (families matched, ranches in state).
- `app/components/funnel/BuyerFunnel.tsx` — the wizard (state machine, progress, transitions).
- `app/components/funnel/StepSize.tsx`, `StepTiming.tsx`, `StepContact.tsx`, `StepStorage.tsx`, `StepReveal.tsx` — one per step, presentational.
- `app/components/funnel/funnelScore.ts` — pure scoring helper (unit-testable).
- `lib/__funnel_tests__/funnelScore.test.mjs` — node test harness (repo has no jest; mirror existing `node --experimental-strip-types` pattern).

**Modify:**
- `lib/adminConfig.ts` + `lib/adminConfigTypes.ts` — add `funnelOfferOperatorCall: boolean`.
- `app/api/consumers/route.ts` — accept a `quizStarted` lead shape (tier+timing+contact+state, Buyer Stage `WAITING`, no `Qualified At`), return `{ consumerId, resumeToken }`.
- `app/api/qualify/route.ts` — accept `storage` answer; finalize a `WAITING` consumer.
- `app/access/page.tsx` — replace the form with `<BuyerFunnel mode="fresh" />`.
- `app/qualify/[consumerId]/page.tsx` — render `<BuyerFunnel mode="resume" consumerId token />` (resume at storage).
- `app/components/ChromeGate.tsx` — add `/access` to `FOCUSED_PREFIXES`.
- Entry points (repoint to `/access`): `app/components/FullHomepage.tsx`, `app/start/page.tsx`, `app/ranchers/[slug]/*`, ManyChat landing.

**Delete:**
- `app/components/ExitIntentModal.tsx` + its mount + `app/api/consumers/quick/route.ts`.
- Email-blur abandoned trigger in the old `/access` (gone with the form rewrite) + retire `app/api/abandoned-app/route.ts`.

---

## Task 1: Funnel config object

**Files:** Create `lib/funnelConfig.ts`

- [ ] **Step 1: Write `funnelConfig`**

```ts
export type StepKey = 'size' | 'timing' | 'contact' | 'storage' | 'reveal';

export interface FunnelStepCopy { title: string; sub: string; }

export const FUNNEL_STEPS: StepKey[] = ['size', 'timing', 'contact', 'storage', 'reveal'];

export const FUNNEL_COPY: Record<StepKey, FunnelStepCopy> = {
  size:    { title: 'How much beef are you after?', sub: 'Pick the closest — your rancher helps you dial it in.' },
  timing:  { title: 'When do you want the freezer full?', sub: 'No wrong answer.' },
  contact: { title: 'Claim your match', sub: 'Private & approval-only. No spam, never resold.' },
  storage: { title: 'How will you store it?', sub: 'Almost there — last one.' },
  reveal:  { title: "You're in.", sub: '' },
};

export const SIZE_OPTIONS = [
  { value: 'Quarter', label: 'Quarter', detail: '~85 lbs · feeds 1–2 · $1,000–1,500' },
  { value: 'Half',    label: 'Half',    detail: '~170 lbs · feeds 3–5 · $2,000–2,500' },
  { value: 'Whole',   label: 'Whole',   detail: '~340 lbs · feeds 6+ · $4,000–5,000' },
  { value: 'Not Sure', label: 'Not sure yet', detail: 'Talk me through it' },
] as const;

export const TIMING_OPTIONS = [
  { value: 'Within 30 days', label: 'Within a month', detail: 'Ready to go' },
  { value: '1-3 months',     label: '1–3 months',     detail: 'Planning ahead' },
  { value: 'Just exploring', label: 'Just browsing',  detail: 'Curious for now' },
] as const;

export const STORAGE_OPTIONS = [
  { value: 'have_freezer',  label: 'I have a freezer',    detail: 'Ready for it' },
  { value: 'need_freezer',  label: 'Need freezer space',  detail: 'Help me sort it' },
  { value: 'rancher_holds', label: 'Rancher holds it',    detail: 'Pick up in batches' },
] as const;
```

- [ ] **Step 2: tsc** — `npx tsc --noEmit` → 0 errors. **Commit:** `git add lib/funnelConfig.ts && git commit -m "feat(funnel): config object for steps/copy/options"`

---

## Task 2: Scoring helper + tests

**Files:** Create `app/components/funnel/funnelScore.ts`, `lib/__funnel_tests__/funnelScore.test.mjs`

- [ ] **Step 1: Write the failing test** (`funnelScore.test.mjs`)

```js
import { scoreFunnel } from '/Users/benji.bushes/BHC/untitled folder/bhc/app/components/funnel/funnelScore.ts';
const cases = [
  [{tier:'Half',timing:'Within 30 days',storage:'have_freezer',completed:true}, 100, 'full serious buyer'],
  [{tier:'Quarter',timing:'1-3 months',storage:'need_freezer',completed:true}, 100, 'quarter still passes'],
  [{tier:'Not Sure',timing:'Just exploring',storage:'have_freezer',completed:true}, 55, 'low-intent under 75'],
  [{tier:'Half',timing:'Within 30 days',storage:'have_freezer',completed:false}, 75, 'not completed loses ack'],
];
let pass=0; for (const [a,exp,d] of cases){const s=scoreFunnel(a); const ok=s===exp; console.log((ok?'✓':'✗')+` ${s} (exp ${exp}) ${d}`); if(ok)pass++;}
console.log(`${pass}/${cases.length}`); if(pass!==cases.length) process.exit(1);
```

- [ ] **Step 2: Run, verify fail** — `node --experimental-strip-types lib/__funnel_tests__/funnelScore.test.mjs` → fails (module missing).

- [ ] **Step 3: Implement** (`funnelScore.ts`) — mirror `app/api/qualify/route.ts` scorer exactly (tier 25 / Not Sure 5; timing ASAP|30d 25, 60d 15, 90d 10, exploring 0; 1-3 months → treat as 60d-ish = 15; storage concrete 25; completed ack 25).

```ts
export interface FunnelAnswers { tier: string; timing: string; storage: string; completed: boolean; }
export function scoreFunnel(a: FunnelAnswers): number {
  let s = 0;
  s += a.tier && a.tier !== 'Not Sure' ? 25 : 5;
  const t = (a.timing || '').toLowerCase();
  s += t.includes('30') || t.includes('asap') ? 25 : t.includes('1-3') || t.includes('60') ? 15 : t.includes('90') ? 10 : 0;
  s += a.storage ? 25 : 0;
  s += a.completed ? 25 : 0;
  return s;
}
```

- [ ] **Step 4: Run, verify pass.** **Step 5: Commit** `funnelScore.ts` + test.

> NOTE for implementer: confirm the exact point values against `app/api/qualify/route.ts` lines 53-69 and match them — the server is the source of truth; this helper is for client preview only. If they differ, the server wins; adjust the test.

---

## Task 3: operator-config flag

**Files:** Modify `lib/adminConfigTypes.ts`, `lib/adminConfig.ts`

- [ ] **Step 1:** add `funnelOfferOperatorCall: boolean` to the config type + default `false` in `getAdminConfig()`'s defaults. Follow the existing field pattern in those files exactly.
- [ ] **Step 2:** tsc clean. **Commit.**

---

## Task 4: Live stats endpoint

**Files:** Create `app/api/funnel/stats/route.ts`

- [ ] **Step 1: Implement** — `GET /api/funnel/stats?state=XX`. Returns `{ familiesMatched, verifiedRanches, ranchesInState }`. `familiesMatched` = count of Consumers with Buyer Stage `CLOSED` (or a floor like 1900 if you want a marketing floor — operator can tune). `verifiedRanches` = count operational ranchers. `ranchesInState` = operational ranchers serving `state` (reuse `getOperationalServedStates`). Cache 5 min (module-level timestamp). Public GET (no admin gate — it's marketing data, no PII).

```ts
import { NextResponse } from 'next/server';
import { getAllRecords, TABLES } from '@/lib/airtable';
import { isRancherOperationalForBuyers, getOperationalServedStates } from '@/lib/rancherEligibility';
import { normalizeState } from '@/lib/states';

let cache: { at: number; data: any } | null = null;
export async function GET(req: Request) {
  const state = normalizeState(new URL(req.url).searchParams.get('state'));
  if (!cache || Date.now() - cache.at > 300_000) {
    const [cons, rans] = await Promise.all([
      getAllRecords(TABLES.CONSUMERS).catch(() => []) as Promise<any[]>,
      getAllRecords(TABLES.RANCHERS).catch(() => []) as Promise<any[]>,
    ]);
    const op = rans.filter(isRancherOperationalForBuyers);
    cache = { at: Date.now(), data: {
      familiesMatched: cons.filter((c) => String(c['Buyer Stage'] || '').toUpperCase() === 'CLOSED').length,
      verifiedRanches: op.length,
      byState: op.reduce((m: Record<string, number>, r) => { for (const s of getOperationalServedStates(r)) m[s] = (m[s] || 0) + 1; return m; }, {}),
    }};
  }
  const d = cache.data;
  return NextResponse.json({ familiesMatched: d.familiesMatched, verifiedRanches: d.verifiedRanches, ranchesInState: state ? (d.byState[state] || 0) : 0 });
}
```

- [ ] **Step 2:** tsc + `curl localhost` smoke (or verify in build). **Commit.**

---

## Task 5: `/api/consumers` — create the mid-flow lead

**Files:** Modify `app/api/consumers/route.ts`

- [ ] **Step 1:** Accept the funnel lead shape. The handler already creates Consumers; add a path where `body.quizStarted === true`: require fullName, email, **phone** (400 if missing — phone is required), state, tier, timing. Set `Order Type` (tier), `Timing`, `Buyer Stage='WAITING'`, `Status='Approved'`, **do NOT set `Qualified At`**, Source/UTMs as today. **Upsert on email** (reuse the existing duplicate-handling at ~line 395). Return `{ consumerId: record.id, resumeToken }` where `resumeToken = jwt.sign({type:'qualify-access', consumerId, email}, JWT_SECRET, {expiresIn:'14d'})`.
- [ ] **Step 2:** Do NOT issue the old `qualifyUrl`/redirect for this path (the wizard stays on-page and calls `/api/qualify` next). Keep the legacy form path working until Task 11 deletes it.
- [ ] **Step 3:** tsc + build. **Commit.**

> The lead is Approved + WAITING + no `Qualified At` → GUARD-2 keeps it unroutable, and the quiz-drip (targets Approved + empty `Qualified At`) will nudge a step-4 bailer. Verified-consistent with the routing gates.

---

## Task 6: `/api/qualify` — accept storage + finalize a WAITING lead

**Files:** Modify `app/api/qualify/route.ts`

- [ ] **Step 1:** Accept `answers.storage`. The route already writes `Qualification Score`, `Qualified At`, fires matching. Ensure it works when the consumer is `Buyer Stage='WAITING'` (created at contact) — it should already, since it fetches by consumerId + token. Persist `storage` into `Qualification Answers`. Confirm the storage answer doesn't change the pass gate beyond the existing scorer.
- [ ] **Step 2:** tsc + build. **Commit.**

---

## Task 7: Step components (presentational)

**Files:** Create `StepSize.tsx`, `StepTiming.tsx`, `StepContact.tsx`, `StepStorage.tsx`, `StepReveal.tsx` under `app/components/funnel/`

- [ ] **Step 1:** Build each as a small client component matching the approved v2 mockup `gamified_buyer_quiz_flow_v2_onbrand` 1:1 — saddle accent `#92632F`, serif titles, big tap cards with `onSelect(value)` auto-advance, the trust line + testimonial on Contact, goal-gradient hint on Storage. `StepContact` has first name / email / **phone (required)** / state (geo-detect via a `/api/geo` or browser, fallback dropdown) + the social-proof line fed from `/api/funnel/stats`. `StepReveal` takes a `mode: 'rancher' | 'operatorCall'` prop (driven by `funnelOfferOperatorCall`): rancher → named match + "they'll text you today"; operatorCall → render existing `CalInlineBooker` with `getOperatorBookingUrl('sales')`. Props are typed; no data fetching inside steps except the stats display.
- [ ] **Step 2:** tsc. **Commit** per 1-2 components.

> Use the mockup's exact markup/classes as the implementation reference. Brand tokens via CSS where the app allows; match the mockup's saddle/serif/founder-voice.

---

## Task 8: `BuyerFunnel` wizard

**Files:** Create `app/components/funnel/BuyerFunnel.tsx`

- [ ] **Step 1:** Client component. Props: `{ mode: 'fresh' | 'resume'; consumerId?: string; token?: string; rancherSlug?: string }`. State machine over `FUNNEL_STEPS`. `fresh` starts at `size`; `resume` starts at `storage` (and pre-loads consumerId/token). Progress bar + step counter. On Contact submit → `POST /api/consumers` (quizStarted) → store `{consumerId, resumeToken}` → advance to storage. On Storage select → `POST /api/qualify` with `{token, consumerId, answers:{tier,timing,storage}, eventId}` → advance to reveal with the returned match (or waitlist). Reveal mode from a `funnelOfferOperatorCall` value passed via a server wrapper or fetched from a tiny public `/api/funnel/config`. Allow Back (preserve answers). Phone required — block Contact submit without valid phone.
- [ ] **Step 2:** tsc + build. **Commit.**

---

## Task 9: Wire `/access` (fresh) + `/qualify/[id]` (resume) + seal

**Files:** Modify `app/access/page.tsx`, `app/qualify/[consumerId]/page.tsx`, `app/components/ChromeGate.tsx`

- [ ] **Step 1:** `/access` renders `<BuyerFunnel mode="fresh" rancherSlug={searchParam}/>` (keep server metadata). `/qualify/[consumerId]` renders `<BuyerFunnel mode="resume" consumerId token/>`. Add `'/access'` to `FOCUSED_PREFIXES` in `ChromeGate.tsx` so the new entry is sealed too.
- [ ] **Step 2:** tsc + build. **Browser E2E (mobile viewport):** load `/access` → tap size, timing → enter contact (verify a Consumer is created Approved + WAITING + no Qualified At) → storage → reveal (verify `Qualified At` set + matching fired). Load `/qualify/[id]?token` → resumes at storage → finishes. **Commit.**

---

## Task 10: Repoint every entry point

**Files:** Modify `app/components/FullHomepage.tsx`, `app/start/page.tsx`, `app/ranchers/[slug]/*`, ManyChat landing handler

- [ ] **Step 1:** Grep for links to `/access`, `/qualify`, homepage CTAs; ensure every buyer CTA points to `/access` (rancher pages keep `?rancher=<slug>`). No buyer path bypasses the flow.
- [ ] **Step 2:** Browser-spot-check homepage CTA + a rancher page CTA → land in the flow. **Commit.**

---

## Task 11: Delete the junk-lead generators

**Files:** Delete `app/components/ExitIntentModal.tsx` + its mount (grep), `app/api/consumers/quick/route.ts`; retire `app/api/abandoned-app/route.ts` + remove its trigger.

- [ ] **Step 1:** Remove the `ExitIntentModal` import/mount (likely in a layout or homepage). Delete the route files. Grep to confirm no references remain. tsc + build clean.
- [ ] **Step 2:** **Commit.**

---

## Task 12: Final review + reveal-config flip test

- [ ] **Step 1:** Flip `funnelOfferOperatorCall=true` in `/admin/settings` (or temporarily in code) → verify the reveal renders `CalInlineBooker` with Ben's sales Cal; flip back to `false` → rancher reveal. Confirms the "easy to update" requirement.
- [ ] **Step 2:** Dispatch a `superpowers:code-reviewer` over the whole branch — focus: lead created only at step 3, phone required, `Qualified At` only on completion (GUARD-2 intact), matching fires once, no PII in the stats endpoint, all entries repointed, junk routes gone.
- [ ] **Step 3:** Full browser E2E once more (fresh + resume + operator-call mode). Merge to main. Watch completion-rate vs 4.8%.

---

## Self-review (plan vs spec)

- Phone required → Task 5 (400 on missing) + Task 7/8 (block submit). ✓
- Lead at step 3, qualified on completion → Tasks 5, 6, 8. ✓
- `/access` flow + `/qualify` resume → Task 9. ✓
- Kill exit-modal + abandoned-grab → Task 11. ✓
- Universal entry → Task 10. ✓
- No-rancher honest waitlist → Task 7 `StepReveal` (rancher vs waitlist) + Task 8 (reveal from matching result). ✓
- Operator-call flip → Tasks 3, 7 (`StepReveal` operatorCall mode), 12. ✓
- Live social proof → Task 4 + Task 7. ✓
- Sealed `/access` → Task 9. ✓
- Conversion psychology + brand → Task 7 (mockup 1:1). ✓
- Testing → browser E2E in Tasks 9, 12; unit in Task 2. ✓

Gap noted for implementer: `/api/geo` (state autodetect) isn't a separate task — fold a minimal IP/locale detect into `StepContact` with a state dropdown fallback (dropdown is the floor; never block on geo).
